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
function getCountWindow(election) {
  const FIVE_MIN = 5 * 60 * 1000;
  let startMs = Number.isFinite(Date.parse(election.count_start)) ? Date.parse(election.count_start) : NaN;
  let endMs = Number.isFinite(Date.parse(election.count_end))   ? Date.parse(election.count_end)   : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    const now = Date.now();
    startMs = now;
    endMs   = now + FIVE_MIN;
  }
  return { startMs, endMs };
}

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
  // Load the manifest.  We assume there is at least one universe
  // and at least one election.  If the manifest structure changes,
  // adjust this logic accordingly.
  const manifest = await j('manifest.json');
  const universe  = manifest.universes[0];
  const election  = universe.elections[0];
  // Fetch the geoJSON and CSV in parallel
  const [gj, csvText] = await Promise.all([j(universe.geojson), t(election.csv)]);
  const rowsFinal = parseCSV(csvText);
  // Detect parties from the header of the CSV (looking for *_votes or *_share)
  const parties = rowsFinal.length ? detectParties(rowsFinal[0]) : [];
  // Determine count window and initial progress
  const { startMs, endMs } = getCountWindow(election);
  let progress = computeProgress(startMs, endMs);
  // Prepare initial scaled rows
  let rowsLive = scaleRowsByProgress(rowsFinal, parties, progress);
  // Attach the current rows to each feature by district_id
  const byId = new Map(rowsLive.map(r => [String(r.district_id), r]));
  gj.features.forEach(f => {
    f.properties._row = byId.get(String(f.properties.district_id)) || null;
  });
  // Persist state for use in other functions
  STATE = { parties, rowsFinal, gj, election, startMs, endMs };
  // Compute bounds for the features.  We do this before creating
  // the map so we can pass maxBounds when constructing it.  The
  // geoJSON layer created here is temporary; it is not added to
  // the map.
  const featureLayer = L.geoJSON(gj);
  const featureBounds = featureLayer.getBounds();
  // Create the map with a maximum bounding box and viscosity so
  // panning outside the peninsula is resisted.  We'll set the
  // minimum zoom after fitting the bounds.
  MAP = L.map('map', {
    preferCanvas: true,
    maxBounds: featureBounds.pad(0.1),
    maxBoundsViscosity: 1.0
  });
  // Create and add a legend control
  LEGEND = L.control({ position: 'bottomleft' });
  LEGEND.onAdd = function () {
    this._div = L.DomUtil.create('div', 'legend');
    return this._div;
  };
  LEGEND.addTo(MAP);
  // Create the GeoJSON layer with basic styling and tooltips
  LAYER = L.geoJSON(gj, {
    style: () => ({
      color: '#666',
      weight: 0.6,
      fillColor: '#eee',
      fillOpacity: 0.9
    }),
    onEachFeature: (feature, layer) => {
      layer.on('mousemove', e => {
        layer.bindTooltip(makeTip(feature), { sticky: true }).openTooltip(e.latlng);
      });
      layer.on('mouseout', () => {
        layer.closeTooltip();
      });
    }
  }).addTo(MAP);
  // Fit the map to the feature bounds and then lock the minimum zoom
  MAP.fitBounds(featureBounds, { padding: [10, 10] });
  MAP.setMinZoom(MAP.getZoom());
  // Wire up the mode selector and inject party share options
  const modeSelect = document.getElementById('mode');
  modeSelect.addEventListener('change', () => updateMapStyling(modeSelect.value));
  injectPartyOptions(parties);
  // Draw initial progress bar and styling
  updateProgressUI(progress);
  renderDesk(progress, rowsLive, STATE.parties);
  updateMapStyling(modeSelect.value);
  // Periodically update progress and repaint.  The interval
  // automatically stops once the count is complete.
  const TICK_MS = 2000;
  const timer = setInterval(() => {
    progress = computeProgress(STATE.startMs, STATE.endMs);
    updateProgressUI(progress);
  renderDesk(progress, rowsLive, STATE.parties);
    // Recompute live rows
    rowsLive = scaleRowsByProgress(STATE.rowsFinal, STATE.parties, progress);
    const byId2 = new Map(rowsLive.map(r => [String(r.district_id), r]));
    STATE.gj.features.forEach(f => {
      f.properties._row = byId2.get(String(f.properties.district_id)) || null;
    });
    updateMapStyling(modeSelect.value);
    if (progress >= 100) clearInterval(timer);
  }, TICK_MS);
}

// Kick off the app when the script is loaded
init();


function fmtPct(x){ return Number.isFinite(x) ? x.toFixed(1) + '%' : '—'; }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
function fmtCountdown(ms){
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60);
  const r = s % 60;
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
    if (eEl) {
      const left = Math.max(0, window.STATE.endMs - Date.now());
      eEl.textContent = fmtCountdown(left);
    }
  }

  const agg = computeNational(rowsLive, parties);
  const list = document.getElementById('raceList');
  const totLine = document.getElementById('raceTotals');
  const turnEl = document.getElementById('turnoutNational');
  if (list){
    list.innerHTML='';
    for (const p of agg.ordered){
      const pct = agg.natPct[p] || 0;
      const votes = agg.totals[p] || 0;
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
  if (totLine){ totLine.textContent = `Total votes: ${agg.ballots.toLocaleString()}`; }
  if (turnEl){ turnEl.textContent = fmtPct(agg.natTurnout); }

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
