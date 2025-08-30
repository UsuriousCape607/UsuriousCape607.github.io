/*
 * Election map application script
 *
 * This script drives the interactive election map. It loads the
 * manifest to determine which GeoJSON and CSV files to fetch, parses
 * the CSV to detect parties automatically, then joins the results to
 * each geographic feature. It also controls a progress bar and animates
 * the count over a user‑defined window (with a sensible default if
 * none is provided). Finally, it constrains the map so players
 * cannot zoom or pan far away from the Korean peninsula.
 */

// These globals hold the Leaflet map and layer as well as some state
// about the loaded election.  They are intentionally kept simple
// rather than attaching everything to the window object.

// ===== Helpers: formatting & timing =====
// --- formatting & clock ---// --- global progress over a start/end window ---
function computeProgress(startMs, endMs) {
  const now = Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 100;
  if (now <= startMs) return 0;
  if (now >= endMs) return 100;
  return ((now - startMs) / (endMs - startMs)) * 100;
}

// --- persist a fallback 5-minute window so reloads don't jump to 100% ---
function ensureCountWindow(E) {
  const s = Date.parse(E?.count_start);
  const e = Date.parse(E?.count_end);
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) return { startMs: s, endMs: e };

  try {
    const saved = JSON.parse(localStorage.getItem('countWindow') || 'null');
    if (saved && Number.isFinite(saved.startMs) && Number.isFinite(saved.endMs) && saved.endMs > Date.now()) {
      return saved;
    }
  } catch (_){}

  const now = Date.now();
  const fresh = { startMs: now, endMs: now + 5*60*1000 };
  try { localStorage.setItem('countWindow', JSON.stringify(fresh)); } catch (_){}
  return fresh;
}
// ===== District reporting schedule =====
function assignReportingSchedule(rows, startMs, endMs) {
  const span = Math.max(1, endMs - startMs);
  return rows.map(r => {
    let bias = 0.5;
    const did = String(r.district_id || '');
    if (/Seoul/i.test(did)) bias = 0.25;                // big city, early
    else if (/Jeon|Jeolla/i.test(did)) bias = 0.35;   //activist province, early
    else if (/Hamgyeong/i.test(did)) bias = 0.65;       // remote, later
    else if (/Pyeong/i.test(did)) bias = 0.55;

    const startFrac = Math.min(0.9, Math.max(0.05, bias + (Math.random()-0.5)*0.3));
    const endFrac   = Math.min(1.0, Math.max(startFrac + 0.05, startFrac + 0.25 + Math.random()*0.25));
    return {
      ...r,
      report_start: Math.round(startMs + startFrac*span),
      report_end:   Math.round(startMs + endFrac*span)
    };
  });
}
function scaleRowsBySchedule(rowsWithSched, parties, now = Date.now()) {
  return rowsWithSched.map(row => {
    const rs = row.report_start, re = row.report_end;
    let phase = 0;
    if (now >= re) phase = 1;
    else if (now > rs) phase = (now - rs) / Math.max(1, re - rs);
    const out = { ...row, _party: {} };
    let total = 0;
    for (const p of parties) {
      const v = Number(row[`${p}_votes`]) || 0;
      const live = Math.round(v * phase);
      out[`${p}_votes_live`] = live;
      total += live;
    }
    for (const p of parties) {
      const vLive = out[`${p}_votes_live`];
      out._party[p] = { votes: vLive, share: total ? (vLive/total*100) : null };
    }
    out._totalVotes = total;
    return out;
  });
}

let MAP, LAYER, LEGEND, STATE;

/**
 * Compute a percentage (0–100) representing how far the current time
 * lies between two timestamps (milliseconds).  Returns 0 if the
 * current time is before startMs, 100 if after endMs.
 *
 * @param {number} startMs - beginning of the count window (ms since epoch)
 * @param {number} endMs   - end of the count window (ms since epoch)
 */
function computeProgress(startMs, endMs) {
  // If timestamps are missing or invalid, default to complete
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 100;
  }
  const now = Date.now();
  if (now <= startMs) return 0;
  if (now >= endMs) return 100;
  return ((now - startMs) / (endMs - startMs)) * 100;
}

/**
 * Derive a counting window for an election.  If the manifest
 * specifies count_start and count_end, those are used.  Otherwise
 * fall back to a 5‑minute window starting at the current time.
 *
 * @param {object} election - an election entry from the manifest
 * @returns {{startMs: number, endMs: number}} start and end times
 */

/**
 * Scale vote totals for each row according to the current progress.
 * For each party, a new property `${party}_votes_live` is added and
 * the share (percentage of total votes in the district) is stored in
 * the _party hash.  Null values are preserved for parties with no
 * votes.
 *
 * @param {Array<object>} rows    - final rows parsed from CSV
 * @param {Array<string>} parties - list of party keys
 * @param {number} progress       - percentage of the count completed
 * @returns {Array<object>} a new array of rows with scaled votes
 */
function scaleRowsByProgress(rows, parties, progress) {
  return rows.map(r => {
    const out = { ...r, _party: {} };
    let total = 0;
    // Compute scaled votes for each party and accumulate the total
    for (const p of parties) {
      const v = Number(r[`${p}_votes`]);
      const live = Number.isFinite(v) ? Math.round((v * progress) / 100) : null;
      out[`${p}_votes_live`] = live;
      if (Number.isFinite(live)) total += live;
    }
    // Compute shares once totals are known
    for (const p of parties) {
      const vLive = out[`${p}_votes_live`];
      out._party[p] = {
        votes: vLive,
        share: Number.isFinite(vLive) && total > 0 ? (vLive / total) * 100 : null
      };
    }
    out._totalVotes = total;
    return out;
  });
}

/**
 * Provide a human‑readable party name by inserting a space before
 * internal capital letters (e.g. "KimGu" → "Kim Gu").  Acronyms
 * consisting entirely of capital letters (e.g. "WPK") are left
 * unchanged.
 *
 * @param {string} name
 * @returns {string}
 */
function displayPartyName(name) {
  // Map known party codes to friendly display names.  These keys
  // reflect the column names in the CSV (without the `_votes` suffix).
  const customNames = {
    KimGu: 'Kim Ku (Korea Independence Party)',        // prefer "Kim Ku" spelling
    Cho: 'Cho Man‑sik (Korean Social Democratic Party)',     // full name of Cho Man‑sik
    WPK: 'Park Heonyeong (Workers Party of Korea)',             // leave acronyms as‑is
    Rhee: 'Rhee Syngman (National Alliance for the Rapid Realization of Korean Independence)' // full name of Rhee Syngman
  };
  if (customNames[name]) {
    return customNames[name];
  }
  // Insert spaces before capital letters that follow lowercase letters.
  // For example, "KimGu" becomes "Kim Gu".  Acronyms (all caps)
  // remain unchanged by this replacement.
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Update the legend and apply styles to the GeoJSON layer based on
 * the currently selected mode.  There are three broad modes:
 *   - "winner": colour districts by the winning party.
 *   - "turnout": continuous choropleth of turnout percentage.
 *   - "share:<Party>": continuous choropleth of the vote share for a given party.
 *
 * @param {string} mode the current mode string from the select element
 */
function updateMapStyling(mode) {
  if (!LAYER || !STATE) return;
  const parties = STATE.parties;
  if (mode === 'winner') {
    LAYER.setStyle(f => {
      const w = winnerForRow(f.properties._row || {}, parties);
      return {
        color: '#666',
        weight: 0.6,
        fillColor: w ? partyColor(w.party) : '#bbb',
        fillOpacity: 0.9
      };
    });
    // Build legend for winners: top N parties with swatches
    const N = Math.min(parties.length, 10);
    const items = parties.slice(0, N)
      .map(p => `<div><span class="swatch" style="background:${partyColor(p)}"></span>${displayPartyName(p)}</div>`)
      .join('');
    LEGEND._div.innerHTML = `<strong>Winner</strong><br>${items}${parties.length > N ? '<div>…</div>' : ''}`;
  } else {
    // Prepare a function to compute the share or turnout per feature
    LAYER.setStyle(f => {
      let s = null;
      if (mode === 'turnout') {
        const row = f.properties._row || {};
        // Support both turnout and turnout_est columns
        s = Number(row.turnout ?? row.turnout_est);
      } else if (mode.startsWith('share:')) {
        const partyKey = mode.slice(6);
        s = f.properties._row?._party?.[partyKey]?.share;
      }
      return {
        color: '#666',
        weight: 0.6,
        fillColor: percentColor(percentIdx(s, 6)),
        fillOpacity: 0.9
      };
    });
    // Build legend for continuous choropleth (six bins)
    const steps = 6;
    const labels = [];
    for (let i = 0; i < steps; i++) {
      const lo = (i) * (100 / steps);
      const hi = (i + 1) * (100 / steps);
      labels.push(
        `<div><span class="swatch" style="background:${percentColor(i)}"></span>${lo.toFixed(0)}–${hi.toFixed(0)}%</div>`
      );
    }
    const title = mode === 'turnout'
      ? 'Turnout (%)'
      : `${displayPartyName(mode.slice(6))} share (%)`;
    LEGEND._div.innerHTML = `<strong>${title}</strong><br>${labels.join('')}`;
  }
}

/**
 * Construct tooltip HTML for a feature based on the current mode.  The
 * name displayed falls back through a series of properties on the
 * feature: name_rr → NAME_1 → name → district_id.
 *
 * @param {object} feature a GeoJSON feature
 */
function makeTip(feature) {
  const p = feature.properties;
  const name = p.name_rr || p.NAME_1 || p.name || p.district_id;
  const mode = document.getElementById('mode').value;
  const row  = p._row || {};
  if (mode === 'winner') {
    const w = winnerForRow(row, STATE.parties);
    return w
      ? `${name}<br>Winner: <b>${displayPartyName(w.party)}</b> (${w.share?.toFixed(1)}%)`
      : `${name}<br>Winner: —`;
  }
  if (mode === 'turnout') {
    const turnoutValue = Number(row.turnout ?? row.turnout_est);
    return `${name}<br>Turnout: ${Number.isFinite(turnoutValue) ? turnoutValue.toFixed(1) + '%' : '—'}`;
  }
  if (mode.startsWith('share:')) {
    const partyKey = mode.slice(6);
    const s = row._party?.[partyKey]?.share;
    return `${name}<br>${displayPartyName(partyKey)} share: ${s == null ? '—' : s.toFixed(1) + '%'}`;
  }
  return name;
}
function fmtPct(x){ return Number.isFinite(x) ? x.toFixed(1) + '%' : '—'; }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
function fmtCountdown(ms){
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const s = Math.floor(ms/1000), m = Math.floor(s/60), r = s % 60;
  return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0');
}
function computeNational(rows, parties){
  const totals = Object.fromEntries(parties.map(p => [p, 0]));
  let ballots = 0, eligible = 0, turnoutWeighted = 0;
  for (const r of rows){
    const rowTot = parties.reduce((s,p)=> s + (r[`${p}_votes_live`] || 0), 0);
    ballots += rowTot;
    eligible += Number(r.eligible_voters_est) || 0;
    const to = Number(r.turnout_est ?? r.turnout) || 0;
    const el = Number(r.eligible_voters_est) || 0;
    turnoutWeighted += to * el;
    for (const p of parties){ totals[p] += r[`${p}_votes_live`] || 0; }
  }
  const natPct = Object.fromEntries(parties.map(p => [p, ballots ? (totals[p]/ballots*100) : 0]));
  const natTurnout = eligible ? (turnoutWeighted / eligible) : 0;
  const ordered = [...parties].sort((a,b)=> totals[b]-totals[a]);
  return { totals, natPct, ballots, eligible, natTurnout, ordered };
}
function renderDesk(progress, rowsLive, parties){
  const pEl = document.getElementById('deskProgress');
  const pTx = document.getElementById('deskProgressText');
  if (pEl) pEl.value = progress;
  if (pTx) pTx.textContent = fmtPct(progress);

  if (window.STATE?.startMs && window.STATE?.endMs){
    const sEl = document.getElementById('deskStart');
    const eEl = document.getElementById('deskETA');
    if (sEl) sEl.textContent = fmtTime(window.STATE.startMs);
    if (eEl) eEl.textContent = fmtCountdown(Math.max(0, window.STATE.endMs - Date.now()));
  }

  const agg = computeNational(rowsLive, parties);
  const list = document.getElementById('raceList');
  const totLine = document.getElementById('raceTotals');
  const turnEl = document.getElementById('turnoutNational');

  if (list){
    list.innerHTML = '';
    for (const p of agg.ordered){
      const pct = agg.natPct[p] || 0;
      const row = document.createElement('div');
      row.className = 'race-row';

      const name = document.createElement('div');
      name.className = 'race-name';
      name.innerHTML = `<span class="swatch" style="background:${partyColor(p)}"></span>${displayPartyName(p)}`;

      const pctEl = document.createElement('div');
      pctEl.className = 'race-pct';
      pctEl.textContent = fmtPct(pct);

      const bar = document.createElement('div');
      bar.className = 'race-bar';
      const fill = document.createElement('div');
      fill.className = 'race-fill';
      fill.style.background = partyColor(p);
      fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
      bar.appendChild(fill);

      row.appendChild(name);
      row.appendChild(pctEl);
      row.appendChild(bar);
      list.appendChild(row);
    }
  }
  if (totLine) totLine.textContent = `Total votes: ${agg.ballots.toLocaleString()}`;
  if (turnEl)  turnEl.textContent = fmtPct(agg.natTurnout);

  const repEl = document.getElementById('provincesReporting');
  if (repEl && window.STATE?.gj){
    const totalProv = window.STATE.gj.features.length;
    let reporting = 0;
    for (const r of rowsLive){
      const sum = parties.reduce((s,p)=> s + (r[`${p}_votes_live`]||0), 0);
      if (sum > 0) reporting++;
    }
    repEl.textContent = `${reporting} / ${totalProv}`;
  }
}

/**
 * Draw or update the progress bar at the top of the page.
 * Creates the bar on first call and updates its width thereafter.
 *
 * @param {number} pct - a number between 0 and 100
 */
function updateProgressUI(pct) {
  let bar = document.getElementById('progress');
  let fill = document.getElementById('progressFill');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'progress';
    bar.style.cssText = 'position:fixed;left:0;top:0;height:4px;width:100%;background:rgba(0,0,0,.08);z-index:9999';
    fill = document.createElement('div');
    fill.id = 'progressFill';
    fill.style.cssText = 'height:100%;width:0%';
    bar.appendChild(fill);
    document.body.appendChild(bar);
  }
  fill.style.background = '#2b8cbe';
  fill.style.width = `${pct.toFixed(1)}%`;
}

/**
 * Populate the mode select element with party share options.  The
 * first two options ("Winner" and "Turnout") are assumed to be
 * present in the HTML.  This function removes any existing
 * optgroup and appends a fresh one with the detected parties.
 *
 * @param {Array<string>} parties
 */
function injectPartyOptions(parties) {
  const sel = document.getElementById('mode');
  // Remove any previously injected optgroup
  const existing = sel.querySelector('optgroup');
  if (existing) existing.remove();
  if (!parties.length) return;
  const group = document.createElement('optgroup');
  group.label = 'Party share (%)';
  for (const p of parties) {
    const option = document.createElement('option');
    option.value = `share:${p}`;
    option.textContent = `${displayPartyName(p)} share (%)`;
    group.appendChild(option);
  }
  sel.appendChild(group);
}

/**
 * Main entry point.  Fetches manifest, data files and boots the map.
 */
async function init() {
  const manifest = await j('manifest.json');
  const universe  = manifest.universes[0];
  const election  = universe.elections[0];
  const [gj, csvText] = await Promise.all([j(universe.geojson), t(election.csv)]);
  const rowsFinal = parseCSV(csvText);
  const parties = rowsFinal.length ? detectParties(rowsFinal[0]) : [];
  const win = ensureCountWindow(election);
  STATE = { parties, rowsFinal, gj, election, startMs: win.startMs, endMs: win.endMs };
  STATE.scheduleRows = assignReportingSchedule(rowsFinal, STATE.startMs, STATE.endMs);

  const featureLayer = L.geoJSON(gj);
  const featureBounds = featureLayer.getBounds();
  MAP = L.map('map', { preferCanvas: true, maxBounds: featureBounds.pad(0.1), maxBoundsViscosity: 1.0 });
  LEGEND = L.control({ position: 'bottomleft' });
  LEGEND.onAdd = function () { this._div = L.DomUtil.create('div', 'legend'); return this._div; };
  LEGEND.addTo(MAP);
  LAYER = L.geoJSON(gj, {
    style: () => ({ color:'#666', weight:0.6, fillColor:'#eee', fillOpacity:0.9 }),
    onEachFeature: (feature, layer) => {
      layer.on('mousemove', e => { layer.bindTooltip(makeTip(feature), { sticky:true }).openTooltip(e.latlng); });
      layer.on('mouseout', () => { layer.closeTooltip(); });
    }
  }).addTo(MAP);
  MAP.fitBounds(featureBounds, { padding: [10, 10] });
  MAP.setMinZoom(MAP.getZoom());
  const modeSelect = document.getElementById('mode');
  modeSelect.addEventListener('change', () => updateMapStyling(modeSelect.value));
  injectPartyOptions(parties);

  // First paint
  let progress = computeProgress(STATE.startMs, STATE.endMs);
  let rowsLive = scaleRowsBySchedule(STATE.scheduleRows, STATE.parties, Date.now());
  const byId = new Map(rowsLive.map(r => [String(r.district_id), r]));
  gj.features.forEach(f => { f.properties._row = byId.get(String(f.properties.district_id)) || null; });

  updateProgressUI(progress);
  renderDesk(progress, rowsLive, STATE.parties);
  updateMapStyling(modeSelect.value);

  // Header/Status: blink, clock, CPU wiggle
  (function startStatusBarAnim(){
    const dot = document.getElementById('statusLiveDot');
    const cpu = document.getElementById('statusCpu');
    const hd  = document.getElementById('hdrLiveDot');
    const hc  = document.getElementById('hdrClock');
    let t = 0;
    setInterval(() => {
      t++;
      if (dot) dot.textContent = (t % 2) ? '●' : '○';
      if (hd)  hd.textContent  = (t % 2) ? '●' : '○';
      if (hc)  hc.textContent  = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      if (cpu){
        const base = 12, amp = 6;
        const val = Math.round(base + amp * (0.5 + 0.5*Math.sin(t/2)));
        cpu.textContent = `CPU Usage: ${val}%`;
      }
    }, 1000);
  })();

  const TICK_MS = 2000;
  const timer = setInterval(() => {
    const now = Date.now();
    const progress = computeProgress(STATE.startMs, STATE.endMs);
    const rowsLive = scaleRowsBySchedule(STATE.scheduleRows, STATE.parties, now);
    const byId2 = new Map(rowsLive.map(r => [String(r.district_id), r]));
    STATE.gj.features.forEach(f => { f.properties._row = byId2.get(String(f.properties.district_id)) || null; });
    updateProgressUI(progress);
    renderDesk(progress, rowsLive, STATE.parties);
    updateMapStyling(modeSelect.value);
    const allDone = rowsLive.every(r => now >= r.report_end);
    if (progress >= 100 && allDone) clearInterval(timer);
  }, TICK_MS);
}
// Kick off the app when the script is loaded
try { init(); } catch (e) { console.error(e); }

// Media player header controls wiring (HEADER-ONLY)
(function setupHeaderMediaControls(){
  const srcSelH = document.getElementById('musicSrcHeader');
  const inputH  = document.getElementById('musicInputHeader');
  const playH   = document.getElementById('musicPlayHeader');
  const pauseH  = document.getElementById('musicPauseHeader');
  const defBtnH = document.getElementById('musicDefaultHeader');
  const dock    = document.getElementById('mediaDock');
  const ytWrap  = document.getElementById('ytContainer');      // ← matches HTML
  const spWrap  = document.getElementById('spotifyContainer'); // ← matches HTML
  if (!srcSelH || !inputH || !playH || !pauseH || !defBtnH || !dock || !ytWrap || !spWrap) return;

  function showDock(show){ dock.style.display = show ? '' : 'none'; }
  function showYT(show){ ytWrap.style.display = show ? '' : 'none'; }
  function showSP(show){ spWrap.style.display = show ? '' : 'none'; }

  // (Optional) ensure YT API is present if you want real pause control
  function ensureYT(){
    return new Promise(resolve => {
      if (window.YT && typeof YT.Player === 'function') return resolve();
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(s);
      }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function(){ try{ prev && prev(); }catch(_){} resolve(); };
    });
  }

  function parseYouTubeId(s){
    s = String(s||'').trim();
    const m = s.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    return m && m[1];
  }

  function playYouTube(){
    const id = parseYouTubeId(inputH.value);
    if (!id) { showDock(false); return; }
    showDock(true); showYT(true); showSP(false);
    ytWrap.innerHTML =
      `<iframe id="ytFrame" width="100%" height="100%" `+
      `src="https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0&modestbranding=1&enablejsapi=1" `+
      `frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
  }
  function pauseYouTube(){
    // If API is present, use it; otherwise just hide/clear
    const f = document.getElementById('ytFrame');
    if (!f) return;
    if (window.YT && typeof YT.Player === 'function') {
      try { new YT.Player(f).pauseVideo(); } catch(_) {}
    } else {
      // brute force: clear the iframe (stops playback)
      ytWrap.innerHTML = '<div id="ytPlayer"></div>';
      showYT(false);
    }
  }

  function mountSpotify(u){
    const id = String(u||inputH.value).split('/').pop().split('?')[0];
    if (!id) { showDock(false); return; }
    showDock(true); showSP(true); showYT(false);
    spWrap.innerHTML =
      `<iframe src="https://open.spotify.com/embed/album/${id}?theme=0" `+
      `width="100%" height="100%" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
  }

  // Header events
  srcSelH.addEventListener('change', ()=> {
    if (srcSelH.value === 'youtube') playYouTube();
    else if (srcSelH.value === 'spotify') mountSpotify();
    else showDock(false);
  });
  playH.addEventListener('click', ()=> {
    if (srcSelH.value === 'youtube') playYouTube();
    else if (srcSelH.value === 'spotify') mountSpotify();
  });
  pauseH.addEventListener('click', ()=> { pauseYouTube(); });
  defBtnH.addEventListener('click', ()=> {
    srcSelH.value = 'spotify';
    inputH.value = '';
    mountSpotify('4QCryC4DF1smBc8LCGCRlF'); // album id only
  });

  // Start hidden
  showDock(false);
})();
// Media player controls wiring (DOCK & SIDEBAR)
