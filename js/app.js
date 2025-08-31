/*
 * Election map application script
 *
 * This script drives the interactive election map. It loads the
 * manifest to determine which GeoJSON and CSV files to fetch, parses
 * the CSV to detect parties automatically, then joins the results to
 * each geographic feature. It also controls a progress bar and animates
 * the count over a user-defined window (with a sensible default if
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
  // Simulate early/late reporting biases: earlyWeight fades bias as phase?1
  return rowsWithSched.map(row => {
    const rs = row.report_start, re = row.report_end;
    let phase = 0;
    if (now >= re) phase = 1;
    else if (now > rs) phase = (now - rs) / Math.max(1, re - rs);

    const out = { ...row, _party: {} };

    // Final totals per party (from CSV)
    const finals = parties.map(p => Math.max(0, Number(row[`${p}_votes`]) || 0));
    const totalFinal = finals.reduce((a,b)=>a+b,0);
    // Total ballots reported so far in this district
    const reported = Math.max(0, Math.round(totalFinal * phase));

    // Bias vector per party for this district (zero-mean), scaled by amp
    const biases = (typeof biasVectorFor === 'function')
      ? biasVectorFor(String(row.district_id || ''), parties, 0.2)
      : Object.fromEntries(parties.map(p=>[p,0]));
    // Early weights (fade toward 1.0 as phase increases)
    const weights = finals.map((v,i)=> {
      const key = parties[i];
      const b = biases[key] || 0;
      const w = (typeof earlyWeight === 'function') ? earlyWeight(b, phase, 1.25) : 1;
      return v * w;
    });

    // Apportion integer ballots across parties according to weights
    const alloc = (typeof apportion === 'function') ? apportion(reported, weights) : finals.map(v=>Math.round(v*phase));

    let total = 0;
    for (let i=0; i<parties.length; i++){
      const p = parties[i];
      const live = alloc[i];
      out[`${p}_votes_live`] = live;
      total += live;
    }
    for (const p of parties){
      const vLive = out[`${p}_votes_live`];
      out._party[p] = { votes: vLive, share: total ? (vLive/total*100) : null };
    }
    out._totalVotes = total;
    out._phase = phase;
    return out;
  });
}

let MAP, LAYER, LEGEND, STATE, HOVER;
const PATTERNS = new Map();

function getStripePattern(leaderKey, runnerKey){
  if (!window.L || !L.StripePattern) return null;
  const key = `${leaderKey}|${runnerKey}`;
  if (PATTERNS.has(key)) return PATTERNS.get(key);
  const p = new L.StripePattern({
    weight: 6,
    spaceWeight: 6,
    color: partyColor(leaderKey),
    spaceColor: partyColor(runnerKey),
    opacity: 1,
    spaceOpacity: 1,
    angle: 45
  });
  p.addTo(MAP);
  PATTERNS.set(key, p);
  return p;
}

// --- Plugin-free stripe fallback ---
const __stripeCache = new Map();
function __getMapSvgRoot() {
  const pane = MAP && MAP.getPanes && MAP.getPanes().overlayPane;
  return pane ? pane.querySelector('svg') : null;
}
function __ensureStripeDef(color1, color2, key) {
  const svg = __getMapSvgRoot();
  if (!svg) return null;
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  const id = `stripe_${(key||`${color1}_${color2}`).replace(/[^A-Za-z0-9_-]/g,'_')}`;
  if (__stripeCache.has(id)) return id;

  const NS = 'http://www.w3.org/2000/svg';
  const p = document.createElementNS(NS, 'pattern');
  p.setAttribute('id', id);
  p.setAttribute('patternUnits', 'userSpaceOnUse');
  p.setAttribute('width', '12');
  p.setAttribute('height', '12');

  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width','12'); bg.setAttribute('height','12');
  bg.setAttribute('fill', color2);
  p.appendChild(bg);

  const line = document.createElementNS(NS, 'path');
  line.setAttribute('d', 'M0,0 L12,12');
  line.setAttribute('stroke', color1);
  line.setAttribute('stroke-width', '6');
  line.setAttribute('shape-rendering', 'crispEdges');
  p.appendChild(line);

  defs.appendChild(p);
  __stripeCache.set(id, true);
  return id;
}
function __applyStripeFallback() {
  if (!LAYER || !STATE) return;
  const parties = STATE.parties;
  LAYER.eachLayer(layer => {
    const f = layer && layer.feature; if (!f) return;
    const row = (f.properties && f.properties._row) || {};
    const hasReported = (row._totalVotes||0) > 0;
    if (!hasReported || (row._call && row._call.winner)) { if (layer._path) layer._path.style.fill = ''; return; }

    const t2 = topTwo(row, parties);
    const st = raceCallStatus(row, parties);
    if (!(t2 && t2.leader && t2.runnerUp) || st.called) { if (layer._path) layer._path.style.fill = ''; return; }

    if (st.label === 'tossup' && layer._path) {
      const c1 = partyColor(t2.leader.key);
      const c2 = partyColor(t2.runnerUp.key);
      const id = __ensureStripeDef(c1, c2, `${t2.leader.key}_${t2.runnerUp.key}`);
      if (id) {
        layer._path.style.fill = `url(#${id})`;
        layer._path.style.fillOpacity = 0.9;
      }
    } else if (layer._path) {
      layer._path.style.fill = '';
    }
  });
}


/**
 * Compute a percentage (0?100) representing how far the current time
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
 * fall back to a 5-minute window starting at the current time.
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
 * Provide a human-readable party name by inserting a space before
 * internal capital letters (e.g. "KimGu" ? "Kim Gu").  Acronyms
 * consisting entirely of capital letters (e.g. "WPK") are left
 * unchanged.
 *
 * @param {string} name
 * @returns {string}
 */
function displayPartyName(name) {
  const shortNames = {
    KimGu: 'Kim Ku',
    Cho: 'Cho Man-sik',
    WPK: 'Park Heonyeong',
    Rhee: 'Rhee Syngman'
  };
  if (shortNames[name]) return shortNames[name];
  return String(name).replace(/([a-z])([A-Z])/g, '$1 $2');
}

function displayPartyLong(name){
  const longNames = {
    KimGu: "Kim Ku - Korea Independence Party",
    Cho: "Cho Man-sik - Korean Social Democratic Party",
    WPK: "Park Heonyeong - Workers Party of Korea",
    Rhee: "Rhee Syngman - National Alliance for the Rapid Realization of Korean Independence"
  };
  if (longNames[name]) return longNames[name];
  return displayPartyName(name);
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
    const row = f.properties._row || {};
    const hasReported = (row._totalVotes||0) > 0;
    if (!hasReported) return { color:'#666', weight:0.6, fillColor:'#bbb', fillOpacity:0.9, fillPattern:null };

    const parties = STATE.parties;
    const t2 = topTwo(row, parties);
    if (!(t2 && t2.leader && t2.leader.key)) {
      return { color:'#666', weight:0.6, fillColor:'#bbb', fillOpacity:0.9, fillPattern:null };
    }

    const status = raceCallStatus(row, parties);

    // Persisted calls
    if (row._call && row._call.winner) {
      return { color:'#666', weight:0.6, fillColor: partyColor(row._call.winner), fillOpacity:0.9, fillPattern:null };
    }

    // Called (live)
    if (status.called) {
      return { color:'#666', weight:0.6, fillColor: partyColor(t2.leader.key), fillOpacity:0.9, fillPattern:null };
    }

    // Toss-up → STRIPES  (use your sim's label, not lead < 2)
    if (status.label === 'tossup' && t2.runnerUp && t2.runnerUp.key) {
      const patt = getStripePattern(t2.leader.key, t2.runnerUp.key);
      if (patt) {
        return {
          color:'#666', weight:0.6,
          fill:true, fillOpacity:0.9,
          // Nuke any previously-set solid fill so pattern wins
          fillColor: 'transparent',
          fillPattern: patt
        };
      }
      if (!patt) console.warn('No StripePattern (falling back to blend). Present?', !!(window.L && L.StripePattern));
      // Safety fallback if plugin failed:
      if (!(window.L && L.StripePattern)) __applyStripeFallback();
    }

    // Lean (uncalled, not toss-up)
    return { color:'#666', weight:0.6, fillColor: partySoftColor(t2.leader.key), fillOpacity:0.9, fillPattern:null };
  });
    const N = Math.min(parties.length, 10);
    const items = parties.slice(0, N)
      .map(p => `<div><span class="swatch" style="background:${partyColor(p)}"></span>${displayPartyName(p)}</div>`)
      .join('');
    // Toss-up sample swatch using first two party colors (if present)
    let toss = '';
    if (parties.length >= 2){
      const c1 = partyColor(parties[0]);
      const c2 = partyColor(parties[1]);
      toss = `<div style="margin-top:6px;">
        <span class="swatch" style="background: repeating-linear-gradient(45deg, ${c1} 0 6px, ${c2} 6px 12px);"></span>
        <span class="muted">Stripes = too close to call</span>
      </div>`;
    } else {
      toss = `<div class="muted" style="margin-top:6px;">Stripes = too close to call</div>`;
    }
    const note = `<div class="muted" style="margin-top:2px;">Bold = called; Light = leaning</div>`;
    LEGEND._div.innerHTML = `<strong>Winner</strong><br>${items}${toss}${note}`;
  } else {
    LAYER.setStyle(f => {
      let s = null;
      if (mode === 'turnout') {
        const row = f.properties._row || {};
        s = Number(row.turnout ?? row.turnout_est);
      } else if (mode.startsWith('share:')) {
        const partyKey = mode.slice(6);
        s = f.properties._row?._party?.[partyKey]?.share;
      }
      const idx = percentIdx(s, 6);
      const fill = (mode === 'turnout') ? percentColor(idx) : percentColorByParty(mode.slice(6), idx);
      return { color:'#666', weight:0.6, fillColor: fill, fillOpacity:0.9 };
    });
    const steps = 6; const labels = [];
    for (let i = 0; i < steps; i++){
      const lo = i*(100/steps), hi = (i+1)*(100/steps);
      const sw = (mode === 'turnout') ? percentColor(i) : percentColorByParty(mode.slice(6), i);
      labels.push(`<div><span class="swatch" style="background:${sw}"></span>${lo.toFixed(0)}-${hi.toFixed(0)}%</div>`);
    }
    const title = (mode === 'turnout') ? 'Turnout (%)' : `${displayPartyName(mode.slice(6))} share (%)`;
    LEGEND._div.innerHTML = `<strong>${title}</strong><br>${labels.join('')}`;
  }
}

/**
 * Construct tooltip HTML for a feature based on the current mode.  The
 * name displayed falls back through a series of properties on the
 * feature: name_rr ? NAME_1 ? name ? district_id.
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
      : `${name}<br>Winner: ?`;
  }
  if (mode === 'turnout') {
    const turnoutValue = Number(row.turnout ?? row.turnout_est);
    return `${name}<br>Turnout: ${Number.isFinite(turnoutValue) ? turnoutValue.toFixed(1) + '%' : '?'}`;
  }
  if (mode.startsWith('share:')) {
    const partyKey = mode.slice(6);
    const s = row._party?.[partyKey]?.share;
    return `${name}<br>${displayPartyName(partyKey)} share: ${s == null ? '?' : s.toFixed(1) + '%'}`;
  }
  return name;
}

// Enhanced tooltip: leader/call status and per-party mini-bars
function makeTipEnhanced(feature){
  const p = feature.properties;
  const name = p.name_rr || p.NAME_1 || p.name || p.district_id;
  const mode = document.getElementById('mode').value;
  const row  = p._row || {};
  const parties = STATE?.parties || [];
  const hasReported = (row._totalVotes||0) > 0;
  const status = hasReported ? raceCallStatus(row, parties) : { called:false, lead:0, phase:0, label:'unreported', leader:{}, runnerUp:{} };
  const reportPct = Math.max(0, Math.min(100, Math.round((status.phase || 0) * 100)));
  const leaderName = status.leader?.key ? displayPartyName(status.leader.key) : '';
  const runnerName = status.runnerUp?.key ? displayPartyName(status.runnerUp.key) : '';
  const leadStr = Number.isFinite(status.lead) ? status.lead.toFixed(1) + ' pts' : '';

  let headLine = '';
  if (!hasReported){ headLine = 'No votes reported'; }
  else if (row._call && row._call.winner){ headLine = `Called for <b>${displayPartyName(row._call.winner)}</b>${leadStr ? ' (+'+leadStr+')' : ''}`; }
  else if (status.called){ headLine = `Called for <b>${leaderName}</b> (+${leadStr})`; }
  else if (status.lead < 2 && leaderName && runnerName){ headLine = `Too close: <b>${leaderName}</b> leads ${runnerName} (+${leadStr})`; }
  else if (leaderName){ headLine = `Leader: <b>${leaderName}</b> (+${leadStr})`; }

  const items = parties.map(key => {
    const share = row._party?.[key]?.share;
    return `
      <div style="margin:2px 0;">
        <div class="field-row" style="justify-content:space-between; gap:8px;">
          <div><span class="swatch" style="background:${partyColor(key)}"></span>${displayPartyName(key)}</div>
          <div>${share == null ? '-' : share.toFixed(1) + '%'}</div>
        </div>
        <div style="height:6px;background:#eee;border:1px solid #aaa;width:140px;margin-top:2px;">
          <div style="height:100%;width:${Math.max(0, Math.min(100, (share||0))).toFixed(1)}%;background:${partyColor(key)}"></div>
        </div>
      </div>`;
  }).join('');

  if (mode === 'winner'){
    return `${name}<br>Reporting: ${reportPct}%<br>${headLine}<br>${items}`;
  }
  if (mode === 'turnout'){
    const turnoutValue = Number(row.turnout ?? row.turnout_est);
    const head = `Turnout: ${Number.isFinite(turnoutValue) ? turnoutValue.toFixed(1) + '%' : '-'}`;
    return `${name}<br>Reporting: ${reportPct}%<br>${head}<br>${items}`;
  }
  if (mode.startsWith('share:')){
    const partyKey = mode.slice(6);
    const s = row._party?.[partyKey]?.share;
    const head = `${displayPartyName(partyKey)} share: ${s == null ? '-' : s.toFixed(1) + '%'}`;
    return `${name}<br>Reporting: ${reportPct}%<br>${head}<br>${items}`;
  }
  return `${name}<br>Reporting: ${reportPct}%<br>${items}`;
}
function fmtPct(x){ return Number.isFinite(x) ? x.toFixed(1) + '%' : '?'; }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
function fmtCountdown(ms){
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const s = Math.floor(ms/1000), m = Math.floor(s/60), r = s % 60;
  return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0');
}
function computeNational(rows, parties){
  const totals = Object.fromEntries(parties.map(p => [p, 0]));
  let ballots = 0;
  let eligibleWeighted = 0;
  let turnoutWeighted = 0;
  for (const r of rows){
    const rowTot = parties.reduce((s,p)=> s + (r[`${p}_votes_live`] || 0), 0);
    ballots += rowTot;
    const el = Number(r.eligible_voters_est) || 0;
    const phase = typeof r._phase === 'number' ? r._phase : (rowTot > 0 ? 1 : 0);
    const to = Number(r.turnout_est ?? r.turnout) || 0; // percent
    eligibleWeighted += el * phase;
    turnoutWeighted += to * el * phase;
    for (const p of parties){ totals[p] += r[`${p}_votes_live`] || 0; }
  }
  const natPct = Object.fromEntries(parties.map(p => [p, ballots ? (totals[p]/ballots*100) : 0]));
  const natTurnout = eligibleWeighted ? (turnoutWeighted / eligibleWeighted) : 0;
  const ordered = [...parties].sort((a,b)=> totals[b]-totals[a]);
  return { totals, natPct, ballots, eligible: eligibleWeighted, natTurnout, ordered };
}

// Persist calls once thresholds are met; never un-call automatically
function updateCalls(rowsLive, parties){
  if (!STATE) return;
  if (!STATE.calls) STATE.calls = new Map();
  const now = Date.now();
  for (const r of rowsLive){
    const id = String(r.district_id);
    // Attach previous call if any
    if (STATE.calls.has(id)){
      r._call = STATE.calls.get(id);
      continue;
    }
    const st = raceCallStatus(r, parties);
    const t2 = topTwo(r, parties);
    if (st.called && t2 && t2.leader && t2.leader.key){
      const call = { winner: t2.leader.key, at: now };
      STATE.calls.set(id, call);
      r._call = call;
    } else {
      r._call = null;
    }
  }
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
  // after: const agg = computeNational(rowsLive, parties);
(function applyThemeFromLeader(){
  try {
    const leaderKey = agg.ordered && agg.ordered[0];
    const root = document.documentElement;
    if (leaderKey) {
      const c = partyColor(leaderKey);         // already defined in your codebase
      const weak = typeof partySoftColor === 'function'
        ? partySoftColor(leaderKey)
        : c;
      root.style.setProperty('--accent', c);
      root.style.setProperty('--accent-weak', weak);
    }
  } catch (_) {}
})();
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
      name.innerHTML = `<span class="swatch" style="background:${partyColor(p)}"></span>`+
        `<button class="party-link" data-party="${p}" style="background:transparent;border:0;color:#06c;cursor:pointer;padding:0;text-decoration:underline;">${displayPartyName(p)}</button>`;
      const linkBtn = name.querySelector('.party-link');
      if (linkBtn){ linkBtn.addEventListener('click', () => openCandidateDoc(p)); }

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
  if (repEl && window.STATE){
    const totalProv = window.STATE.totalDistricts || new Set(window.STATE.rowsFinal.map(r=>String(r.district_id))).size;
    const called = (window.STATE.calls && window.STATE.calls.size) ? window.STATE.calls.size : 0;
    repEl.textContent = `${called} / ${totalProv}`;
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
  // Expose STATE on window so UI helpers (renderDesk, etc.) can read it
  try { window.STATE = STATE; } catch (_) { /* no-op for non-browser */ }
  STATE.scheduleRows = assignReportingSchedule(rowsFinal, STATE.startMs, STATE.endMs);
  STATE.totalDistricts = new Set(rowsFinal.map(r => String(r.district_id))).size;
  // Seed provinces reporting placeholder so the UI doesn't show dashes
  const repInit = document.getElementById('provincesReporting');
  if (repInit) repInit.textContent = `0 / ${STATE.totalDistricts}`;

  const featureLayer = L.geoJSON(gj);
  const featureBounds = featureLayer.getBounds();
  // Use SVG renderer (required for Leaflet.pattern) and fully replace default controls
  MAP = L.map('map', {
    preferCanvas: false,
    zoomControl: false,
    attributionControl: false,
    keyboard: false,
    maxBounds: featureBounds.pad(0.1),
    maxBoundsViscosity: 1.0
  });
  LEGEND = L.control({ position: 'bottomleft' });
  LEGEND.onAdd = function () {
    const wrap = L.DomUtil.create('div', 'window legend-window');
    wrap.innerHTML = ''+
      '<div class="title-bar">\n'+
      '  <div class="title-bar-text">Legend</div>\n'+
      '  <div class="title-bar-controls"><button aria-label="Minimize"></button></div>\n'+
      '</div>\n'+
      '<div class="window-body"><div class="legend"></div></div>';
    this._div = wrap.querySelector('.legend');
    return wrap;
  };
  LEGEND.addTo(MAP);

  // XP-styled zoom control
  const XPZoom = L.control({ position: 'topleft' });
  XPZoom.onAdd = () => {
    const el = L.DomUtil.create('div', 'xp-zoom window');
    el.innerHTML = ''+
      '<div class="title-bar">\n'+
      '  <div class="title-bar-text">Map Controls</div>\n'+
      '  <div class="title-bar-controls"></div>\n'+
      '</div>\n'+
      '<div class="window-body">\n'+
      '  <div class="field-row">\n'+
      '    <button id="xpZoomIn" aria-label="Zoom in">+</button>\n'+
      '    <button id="xpZoomOut" aria-label="Zoom out">-</button>\n'+
      '    <button id="xpZoomHome" aria-label="Fit bounds">?</button>\n'+
      '  </div>\n'+
      '  <div class="field-row" style="margin-top:6px; align-items:center; gap:6px;">\n'+
      '    <label for="mode" class="muted">Mode:</label>\n'+
      '    <select id="mode">\n'+
      '      <option value="winner">Winner (by share)</option>\n'+
      '      <option value="turnout">Turnout (%)</option>\n'+
      '    </select>\n'+
      '  </div>\n'+
      '</div>';
    L.DomEvent.disableClickPropagation(el);
    setTimeout(() => {
      const zi = el.querySelector('#xpZoomIn');
      const zo = el.querySelector('#xpZoomOut');
      const hm = el.querySelector('#xpZoomHome');
      if (zi) zi.addEventListener('click', () => MAP.zoomIn());
      if (zo) zo.addEventListener('click', () => MAP.zoomOut());
      if (hm) hm.addEventListener('click', () => MAP.fitBounds(featureBounds, { padding:[10,10] }));
    }, 0);
    // Mode selector event and party options injection
    setTimeout(() => {
      const modeSelect = el.querySelector('#mode');
      if (modeSelect) {
        modeSelect.addEventListener('change', () => updateMapStyling(modeSelect.value));
        injectPartyOptions(STATE.parties);
      }
    }, 0);
    return el;
  };
  XPZoom.addTo(MAP);
  LAYER = L.geoJSON(gj, {
    style: () => ({ color:'#666', weight:0.6, fillColor:'#eee', fillOpacity:0.9, fill:true }),
    onEachFeature: (feature, layer) => {
      layer.on('mousemove', e => {
        HOVER = { layer, feature, latlng: e.latlng };
        layer.bindTooltip(makeTipEnhanced(feature), { sticky:true }).openTooltip(e.latlng);
      });
      layer.on('mouseout', () => { HOVER=null; layer.closeTooltip(); });
    }
  }).addTo(MAP);
  MAP.fitBounds(featureBounds, { padding: [10, 10] });
  MAP.setMinZoom(MAP.getZoom());
  // Remove global modeSelect reference and use the one inside XPZoom
  // const modeSelect = document.getElementById('mode');
  // modeSelect.addEventListener('change', () => updateMapStyling(modeSelect.value));
  // injectPartyOptions(parties);

  // Music embed: YouTube + Spotify (dock)
  (function setupMusic(){
    const srcSel = document.getElementById('musicSrc');
    const input  = document.getElementById('musicInput');
    const play   = document.getElementById('musicPlay');
    const pause  = document.getElementById('musicPause');
    const defBtn = document.getElementById('musicDefault');
    const dock   = document.getElementById('mediaDock');
    const ytWrap = document.getElementById('ytContainer');
    const spWrap = document.getElementById('spotifyContainer');
    const dockMin = document.getElementById('mediaDockMin');
    const dockClose = document.getElementById('mediaDockClose');
    if (!srcSel || !input || !play || !pause || !dock || !ytWrap || !spWrap) return;

    const DEFAULT_SPOTIFY = 'https://open.spotify.com/album/4QCryC4DF1smBc8LCGCRlF';
    const load = k => localStorage.getItem(k);
    const save = (k,v) => localStorage.setItem(k, v);
    const savedPreset = load('musicPreset') || '';
    srcSel.value = load('musicSrc') || 'off';
    input.value  = load('musicInput') || '';
    vol.value    = String(Math.max(0, Math.min(100, Number(load('musicVol') || '40'))));

    let ytPlayer=null, ytReady=false;
    const setVolEnabled = () => { vol.disabled = srcSel.value !== 'youtube'; };
    const showDock = show => { dock.style.display = show ? '' : 'none'; };
    const showYT = show => { ytWrap.style.display = show ? '' : 'none'; };
    const showSP = show => { spWrap.style.display = show ? '' : 'none'; };
    const setPlayingUI = p => { play.disabled = p && srcSel.value==='youtube'; pause.disabled = !p; };
    setVolEnabled(); setPlayingUI(false);

    function parseSpotify(u){
      const s = String(u||'').trim();
      let m = s.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[^\/]+\/)?(track|album|playlist)\/([a-zA-Z0-9]+)(?:\?.*)?$/);
      if (!m) m = s.match(/^https?:\/\/open\.spotify\.com\/embed\/(track|album|playlist)\/([a-zA-Z0-9]+)(?:\?.*)?$/);
      if (!m) m = s.match(/^spotify:(track|album|playlist):([a-zA-Z0-9]+)$/);
      return m ? {type:m[1], id:m[2], url:`https://open.spotify.com/embed/${m[1]}/${m[2]}?theme=0`} : null;
    }
    function ensureYT(){
      return new Promise(resolve => {
        if (window.YT && typeof YT.Player==='function') return resolve();
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = function(){ try{ prev&&prev(); }catch(e){} resolve(); };
      });
    }
    async function playYouTube(){
      const s = String(input.value||'').trim();
      const m = s.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/);
      const id = (/^[a-zA-Z0-9_-]{11}$/).test(s) ? s : (m && m[1]);
      if (!id) return;
      save('musicSrc','youtube'); save('musicInput',input.value);
      await ensureYT(); showDock(true); showYT(true); showSP(false);
      if (!ytPlayer){
        ytPlayer = new YT.Player('ytPlayer',{ videoId:id, playerVars:{autoplay:1,controls:1,playsinline:1,rel:0,modestbranding:1},
          events:{ onReady:()=>{ ytReady=true; ytPlayer.setVolume(Number(vol.value)||40); ytPlayer.playVideo(); setPlayingUI(true); },
                   onStateChange:e=>{ const st=e&&e.data; setPlayingUI(st===1?true:false); }}});
      } else { ytPlayer.loadVideoById(id); ytPlayer.setVolume(Number(vol.value)||40); ytPlayer.playVideo(); setPlayingUI(true); }
    }
    function pauseYouTube(){ if (ytPlayer&&ytReady){ ytPlayer.pauseVideo(); setPlayingUI(false);} }
    function mountSpotify(u){
      const info = parseSpotify(u||input.value); if (!info) return;
      save('musicSrc','spotify'); save('musicInput', u? '' : input.value); save('musicPreset', u? 'default' : '');
      spWrap.innerHTML=''; const ifr=document.createElement('iframe'); ifr.width='100%'; ifr.height=(info.type==='track')?'80':'152';
      ifr.allow='autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture'; ifr.loading='lazy'; ifr.src=info.url;
      spWrap.appendChild(ifr); showDock(true); showSP(true); showYT(false); setPlayingUI(true);
    }
    srcSel.addEventListener('change', ()=>{ save('musicSrc',srcSel.value); setVolEnabled(); if (srcSel.value==='off'){ pauseYouTube(); showDock(false); setPlayingUI(false);} });
    play.addEventListener('click', ()=>{ if (srcSel.value==='youtube') playYouTube(); else if (srcSel.value==='spotify') mountSpotify(); });
    pause.addEventListener('click', ()=>{ if (srcSel.value==='youtube') pauseYouTube(); else showDock(false); });
    vol.addEventListener('input', ()=>{ save('musicVol',String(vol.value)); if (ytPlayer&&ytReady) ytPlayer.setVolume(Number(vol.value)||40); });
    if (defBtn){ defBtn.addEventListener('click', ()=>{ srcSel.value='spotify'; setVolEnabled(); mountSpotify(DEFAULT_SPOTIFY); }); }
    const unmountSpotify = () => { try { spWrap.innerHTML=''; } catch(_){} };
    if (dockMin){
      const act = ()=>{ dock.classList.toggle('collapsed'); };
      dockMin.addEventListener('click', act);
      dockMin.addEventListener('keydown', e=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); act(); } });
    }
    if (dockClose){
      const act = ()=>{ pauseYouTube(); unmountSpotify(); showDock(false); setPlayingUI(false); };
      dockClose.addEventListener('click', act);
      dockClose.addEventListener('keydown', e=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); act(); } });
    }
    // Draggable dock (drag via title bar)
    (function makeDockDraggable(){
      const bar = dock.querySelector('.title-bar');
      if (!bar) return;
      const loadPos = () => {
        try { return JSON.parse(localStorage.getItem('mediaDockPos')||'null'); } catch(_) { return null; }
      };
      const savePos = (x,y) => { try { localStorage.setItem('mediaDockPos', JSON.stringify({x,y})); } catch(_){} };
      const applyPos = (pos) => {
        if (!pos) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        const x = Math.max(0, Math.min(vw-40, pos.x));
        const y = Math.max(40, Math.min(vh-40, pos.y));
        dock.style.left = x + 'px';
        dock.style.top  = y + 'px';
        dock.style.right = 'auto';
      };
      // Apply saved position on load
      applyPos(loadPos());
      window.addEventListener('resize', ()=> applyPos(loadPos()));
      let dragging=false, offX=0, offY=0, shield=null;
      const onDown = (e) => {
        // Don't start dragging when clicking controls (min/close)
        if (e && e.target && e.target.closest && e.target.closest('.title-bar-controls')) return;
        dragging = true;
        const r = dock.getBoundingClientRect();
        offX = (e.clientX || 0) - r.left;
        offY = (e.clientY || 0) - r.top;
        // Switch to left positioning if currently using right
        dock.style.left = r.left + 'px';
        dock.style.top  = r.top + 'px';
        dock.style.right = 'auto';
        // Add transparent shield to avoid iframes eating events
        shield = document.createElement('div');
        Object.assign(shield.style,{position:'fixed',left:0,top:0,right:0,bottom:0,zIndex:2000,background:'transparent'});
        document.body.appendChild(shield);
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        let nx = (e.clientX||0) - offX;
        let ny = (e.clientY||0) - offY;
        nx = Math.max(0, Math.min(vw - dock.offsetWidth, nx));
        ny = Math.max(40, Math.min(vh - 40, ny));
        dock.style.left = nx + 'px';
        dock.style.top  = ny + 'px';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging=false;
        if (shield){ try{ shield.remove(); }catch(_){} shield=null; }
        const r = dock.getBoundingClientRect();
        savePos(r.left, r.top);
      };
      bar.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      // Touch support
      bar.addEventListener('touchstart', (e)=> onDown(e.touches[0]), {passive:false});
      window.addEventListener('touchmove', (e)=> { onMove(e.touches[0]); e.preventDefault(); }, {passive:false});
      window.addEventListener('touchend', onUp);
    })();

    // Do not auto-open on first visit. Only remount explicit saved link.
    if (srcSel.value==='spotify' && input.value){ mountSpotify(); }
  })();

  // First paint
  let progress = computeProgress(STATE.startMs, STATE.endMs);
  let rowsLive = scaleRowsBySchedule(STATE.scheduleRows, STATE.parties, Date.now());
  updateCalls(rowsLive, STATE.parties);
  const byId = new Map(rowsLive.map(r => [String(r.district_id), r]));
  gj.features.forEach(f => { f.properties._row = byId.get(String(f.properties.district_id)) || null; });

  updateProgressUI(progress);
  renderDesk(progress, rowsLive, STATE.parties);
  // Use the mode selector inside XPZoom for initial map styling
  const xpZoomEl = document.querySelector('.xp-zoom');
  const modeSelect = xpZoomEl ? xpZoomEl.querySelector('#mode') : null;
  updateMapStyling(modeSelect ? modeSelect.value : 'winner');
  // Doc reader: simple Markdown fetch + render
  (function setupDocReader(){
    const sel = document.getElementById('docSelect');
    const pane = document.getElementById('docPane');
    if (!sel || !pane) return;
    const md = (txt, baseUrl)=>{
      const escape = (s)=> s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const resolveUrl = (p, forImage=false)=>{
        try {
          // Images must be remote (http/https) if forImage=true
          if (/^https?:/i.test(p)) return p;
          if (forImage) return null; // block internal images when remote-only policy is desired
          if (/^data:/i.test(p)) return p;
          const baseAbs = new URL(baseUrl, window.location.href);
          const baseDir = baseAbs.href.slice(0, baseAbs.href.lastIndexOf('/')+1);
          return new URL(p, baseDir).href;
        } catch(_) { return p; }
      };
      const toLink = (s)=> s.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g,(m,txt,url)=>`<a href="${resolveUrl(url,false)}" target="_blank" rel="noopener">${txt}</a>`);
      const toStrong = (s)=> s.replace(/\*\*(.*?)\*\*/g,'<b>$1</b>');
      const imgMD  = /^!\[([^\]]*)\]\(([^\s)]+)\)\s*$/;
      const imgURL = /^([^\s]+\.(?:png|jpe?g|gif|webp))\s*$/i;
      const out = [];
let inList = false;
let para = [];   // collect lines for a paragraph

function flushPara() {
  if (!para.length) return;
  const joined = para.join(' ').replace(/\s+/g, ' ').trim();
  const body = DocViewer.bbcode( toStrong(toLink(escape(joined))) );
  out.push(`<p>${body}</p>`);
  para.length = 0;
}

String(txt).split(/\r?\n/).forEach(line => {
  // blank line => end list/paragraph
  if (/^\s*$/.test(line)) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(''); return; }

  // pass-through raw HTML images/links
  if (/^\s*<(img|a)\s/i.test(line)) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(line); return; }

  // headings (flush current paragraph first)
  let m;
  if ((m = line.match(/^###\s+(.*)/))) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<h4>${escape(m[1])}</h4>`); return; }
  if ((m = line.match(/^##\s+(.*)/)))  { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<h3>${escape(m[1])}</h3>`); return; }
  if ((m = line.match(/^#\s+(.*)/)))   { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<h2>${escape(m[1])}</h2>`); return; }

  // lists (flush paragraph before list items)
  if ((m = line.match(/^\-\s+(.*)/))) {
    flushPara();
    if (!inList){ out.push('<ul>'); inList=true; }
    let bodyRaw = m[1].trim();
    let body = DocViewer.bbcode( toStrong(toLink(escape(bodyRaw))) );
    out.push(`<li>${body}</li>`);
  }

  // images (Markdown or bare URL) end a paragraph
  const imgMD  = /^!\[([^\]]*)\]\(([^\s)]+)\)\s*$/;
  const imgURL = /^([^\s]+\.(?:png|jpe?g|gif|webp))\s*$/i;
  if ((m = line.match(imgMD))) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<p><img src="${resolveUrl(m[2], true)}" alt="${escape(m[1])}" loading="lazy" style="max-width:100%;height:auto;"></p>`); return; }
  if ((m = line.match(imgURL))) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<p><img src="${resolveUrl(m[1], true)}" loading="lazy" style="max-width:100%;height:auto;"></p>`); return; }

  // otherwise: accumulate into current paragraph
  para.push(line.trim());
});

if (inList) out.push('</ul>');
flushPara();
return out.join('\n');

    };
    function extractMeta(raw){
      const lines = String(raw).split(/\r?\n/);
      let name='', affiliation='', portrait='';
      let consumed = new Array(lines.length).fill(false);
      for (let i=0;i<lines.length;i++){ const m=lines[i].match(/^#\s+(.*)/); if (m){ name=m[1].trim(); consumed[i]=true; break; } }
      for (let i=0;i<lines.length;i++){ const m=lines[i].match(/^\s*(Affiliation|Party)\s*:\s*(.+)\s*$/i); if (m){ affiliation=m[2].trim(); consumed[i]=true; break; } }
      const imgMD=/^!\[[^\]]*\]\(([^\s)]+)\)\s*$/; const imgURL=/^([^\s]+\.(?:png|jpe?g|gif|webp))\s*$/i;
      for (let i=0;i<lines.length;i++){ let m=lines[i].match(imgMD); if (m){ portrait=m[1].trim(); consumed[i]=true; break; } m=lines[i].match(imgURL); if(m){ portrait=m[1].trim(); consumed[i]=true; break; } }
      const body = lines.filter((_,i)=>!consumed[i]).join('\n');
      return {name, affiliation, portrait, body};
    }
    function renderCard(raw, baseUrl){
      const meta = extractMeta(raw);
      const name = meta.name; const tag = meta.affiliation; const pic = (/^https?:/i.test(meta.portrait)? meta.portrait : '');
      const bodyHtml = md(meta.body, baseUrl);
      const banner = `<div class="tno-banner"><div class="tno-name">${name||''}</div>${tag?`<div class="tno-tag">${tag}</div>`:''}</div>`;
      const left = pic? `<div class="tno-portrait"><img src="${pic}" alt="${name||''}" loading="lazy"></div>`:'';
      const body = `<div class="tno-body">${left}<div class="tno-content">${bodyHtml}</div></div>`;
      return `<div class="tno-card">${banner}${body}</div>`;
    }
    async function load(u){
      try {
        pane.innerHTML = '<span class="muted">Loading…</span>';
        const r = await fetch(u);
        const t = await r.text();
        pane.innerHTML = renderCard(t, u);
      } catch(e){ pane.innerHTML = '<span class="muted">Failed to load</span>'; }
    }
    window.loadDocMarkdown = load;
    sel.addEventListener('change', ()=> load(sel.value));
    load(sel.value);
  })();
  // Tabs: Map, Results, About
  (function setupTabs(){
  const btnMap = document.getElementById('tabMap');
  const btnRes = document.getElementById('tabResults');
  const btnAbt = document.getElementById('tabAbout');
  const panelMap = document.getElementById('panelMap');
  const panelRes = document.getElementById('panelResults');
  const panelAbt = document.getElementById('panelAbout');
  if (!btnMap || !btnRes || !btnAbt || !panelMap || !panelRes || !panelAbt) return;

  function select(tab){
    const isMap = tab==='map', isRes = tab==='results', isAbt = tab==='about';
    panelMap.style.display = isMap ? '' : 'none';
    panelRes.style.display = isRes ? '' : 'none';
    panelAbt.style.display = isAbt ? '' : 'none';
    btnMap.setAttribute('aria-selected', String(isMap));
    btnRes.setAttribute('aria-selected', String(isRes));
    btnAbt.setAttribute('aria-selected', String(isAbt));

    // Leaving Map: hide/clear media
    const dock = document.getElementById('mediaDock');
    const yt = document.getElementById('ytContainer');
    const sp = document.getElementById('spotifyContainer');
    if (!isMap && dock) {
      if (yt) { yt.innerHTML = '<div id="ytPlayer"></div>'; yt.style.display = 'none'; }
      if (sp) { sp.innerHTML = ''; sp.style.display = 'none'; }
      dock.style.display = 'none';
    }

    // Returning to Map: reflow Leaflet after becoming visible
    if (isMap && window.MAP && typeof MAP.invalidateSize === 'function') {
      setTimeout(() => MAP.invalidateSize(), 0);
    }
  }

  btnMap.addEventListener('click', ()=>select('map'));
  btnRes.addEventListener('click', ()=>select('results'));
  btnAbt.addEventListener('click', ()=>select('about'));
  select('map');
})();


  // Candidate doc opener mapping and helper
  const CANDIDATE_DOCS = {
    KimGu: 'docs/candidates/KimGu.md',
    Cho:   'docs/candidates/Cho.md',
    WPK:   'docs/candidates/WPK.md',
    Rhee:  'docs/candidates/Rhee.md'
  };
  window.openCandidateDoc = function(key){
    const url = CANDIDATE_DOCS[key] || `docs/candidates/${key}.md`;
    const sel = document.getElementById('docSelect');
    if (sel){
      let opt = Array.from(sel.options).find(o => o.value === url);
      if (!opt){
        opt = document.createElement('option');
        opt.value = url;
        opt.textContent = `${displayPartyName(key)} profile`;
        opt.dataset.dynamic = '1';
        sel.appendChild(opt);
      }
      sel.value = url;
    }
    if (window.loadDocMarkdown) window.loadDocMarkdown(url);
  };
  // Populate About panel with full candidate/party names once
  (function fillAbout(){
    const host = document.getElementById('aboutCandidates');
    if (!host || !Array.isArray(STATE?.parties)) return;
    const items = STATE.parties.map(p => `\u003cli\u003e${displayPartyLong(p)}\u003c/li\u003e`).join('');
    host.innerHTML = `\u003cul style="margin:0 0 0 16px;"\u003e${items}\u003c/ul\u003e`;
  })();

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
    updateCalls(rowsLive, STATE.parties);
    const byId2 = new Map(rowsLive.map(r => [String(r.district_id), r]));
    STATE.gj.features.forEach(f => { f.properties._row = byId2.get(String(f.properties.district_id)) || null; });
    updateProgressUI(progress);
    renderDesk(progress, rowsLive, STATE.parties);
    // Use the mode selector inside XPZoom for map styling updates
    const xpZoomEl = document.querySelector('.xp-zoom');
    const modeSelect = xpZoomEl ? xpZoomEl.querySelector('#mode') : null;
    updateMapStyling(modeSelect ? modeSelect.value : 'winner');
    // Refresh tooltip while hovering
    if (HOVER && HOVER.layer && typeof HOVER.layer.getTooltip === 'function'){
      const tt = HOVER.layer.getTooltip && HOVER.layer.getTooltip();
      if (tt){ tt.setContent(makeTipEnhanced(HOVER.feature)); HOVER.layer.openTooltip(HOVER.latlng); }
    }
    const allDone = rowsLive.every(r => now >= r.report_end);
    if (progress >= 100 && allDone) clearInterval(timer);
  }, TICK_MS);
}
// Kick off the app when the script is loaded
init();

// Media player header controls wiring
(function setupHeaderMediaControls(){
  const srcSelH = document.getElementById('musicSrcHeader');
  const inputH  = document.getElementById('musicInputHeader');
  const playH   = document.getElementById('musicPlayHeader');
  const pauseH  = document.getElementById('musicPauseHeader');
  const defBtnH = document.getElementById('musicDefaultHeader');
  const dock    = document.getElementById('mediaDock');
  const ytWrap  = document.getElementById('ytContainer');
  const spWrap  = document.getElementById('spotifyContainer');
  const vol = document.getElementById('musicVol') || {
  value: '40',
  disabled: true,
  addEventListener: () => {}
  };


  // Only the header controls + dock are required; volume is optional now
  if (!srcSelH || !inputH || !playH || !pauseH || !defBtnH || !dock || !ytWrap || !spWrap) return;

  function showDock(show){ dock.style.display = show ? '' : 'none'; }
  function showYT(show){ ytWrap.style.display = show ? '' : 'none'; }
  function showSP(show){ spWrap.style.display = show ? '' : 'none'; }
  const getVol = () => Number((vol && vol.value) || 40);

  function ensureYT(){
    return new Promise(resolve => {
      if (window.YT && typeof YT.Player === 'function') return resolve();
      // If the API script isn't present, inject it
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(s);
      }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function(){ try{ prev && prev(); }catch(e){} resolve(); };
    });
  }

  function parseSpotify(u){
    const s = String(u||'').trim();
    let m = s.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[^\/]+\/)?(track|album|playlist)\/([a-zA-Z0-9]+)(?:\?.*)?$/);
    if (!m) m = s.match(/^https?:\/\/open\.spotify\.com\/embed\/(track|album|playlist)\/([a-zA-Z0-9]+)(?:\?.*)?$/);
    if (!m) m = s.match(/^spotify:(track|album|playlist):([a-zA-Z0-9]+)$/);
    return m ? {type:m[1], id:m[2], url:`https://open.spotify.com/embed/${m[1]}/${m[2]}?theme=0`} : null;
  }
  function parseYouTube(u){
    const s = String(u||'').trim();
    const m = s.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/);
    if ((/^[a-zA-Z0-9_-]{11}$/).test(s)) return s;
    return m && m[1];
  }
  function clearDock(){
    showYT(false); showSP(false);
    ytWrap.innerHTML = '<div id="ytPlayer"></div>';
    spWrap.innerHTML = '';
  }

  let ytPlayer = null, ytReady = false;

  playH.addEventListener('click', function(){
    clearDock();
    const src = srcSelH.value;
    const val = inputH.value.trim();

    if (src === 'spotify') {
      const info = parseSpotify(val);
      if (!info) { showDock(false); return; }
      showSP(true); showDock(true);
      const ifr = document.createElement('iframe');
      ifr.width = '100%';
      ifr.height = (info.type === 'track') ? '80' : '152';
      ifr.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
      ifr.loading = 'lazy';
      ifr.src = info.url;
      spWrap.appendChild(ifr);
      return;
    }

    if (src === 'youtube') {
      const id = parseYouTube(val);
      if (!id) { showDock(false); return; }
      showYT(true); showDock(true);
      ensureYT().then(() => {
        ytPlayer = new YT.Player('ytPlayer', {
          videoId: id,
          playerVars: {autoplay:1,controls:1,playsinline:1,rel:0,modestbranding:1},
          events: {
            onReady: () => { ytReady = true; ytPlayer.setVolume(getVol()); ytPlayer.playVideo(); }
          }
        });
      });
      return;
    }

    // src === 'off'
    showDock(false);
  });

  pauseH.addEventListener('click', function(){
    if (ytPlayer && ytReady) ytPlayer.pauseVideo();
    clearDock(); showDock(false);
  });

  defBtnH.addEventListener('click', function(){
    clearDock();
    srcSelH.value = 'spotify';
    inputH.value = '';
    showSP(true); showDock(true);
    spWrap.innerHTML =
      '<iframe data-testid="embed-iframe" style="border-radius:12px" ' +
      'src="https://open.spotify.com/embed/album/4QCryC4DF1smBc8LCGCRlF?utm_source=generator&theme=0" ' +
      'width="100%" height="152" frameBorder="0" allowfullscreen ' +
      'allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>';
  });

  // Start hidden
  showDock(false);
})(); // end setupHeaderMediaControls

(function setupMediaDockChrome(){
  const dock      = document.getElementById('mediaDock');
  const dockMin   = document.getElementById('mediaDockMin');
  const dockClose = document.getElementById('mediaDockClose');
  const ytWrap    = document.getElementById('ytContainer');
  const spWrap    = document.getElementById('spotifyContainer');
  if (!dock || !dockMin || !dockClose || !ytWrap || !spWrap) return;

  const showDock = (show)=> { dock.style.display = show ? '' : 'none'; };
  const clearEmbeds = ()=> {
    // Kill YouTube & Spotify by replacing their contents
    ytWrap.innerHTML = '<div id="ytPlayer"></div>';
    spWrap.innerHTML = '';
    ytWrap.style.display = 'none';
    spWrap.style.display = 'none';
  };

  // Minimize toggles .collapsed; your CSS hides .window-body
  const onMin = ()=> dock.classList.toggle('collapsed');
  dockMin.addEventListener('click', onMin);
  dockMin.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMin(); }
  });

  // Close clears embeds and hides dock
  const onClose = ()=> { clearEmbeds(); showDock(false); };
  dockClose.addEventListener('click', onClose);
  dockClose.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose(); }
  });

  // Draggable via title bar (with iframe shield + position persistence)
  (function makeDockDraggable(){
    const bar = dock.querySelector('.title-bar');
    if (!bar) return;

    const loadPos = () => {
      try { return JSON.parse(localStorage.getItem('mediaDockPos') || 'null'); } catch(_) { return null; }
    };
    const savePos = (x,y) => { try { localStorage.setItem('mediaDockPos', JSON.stringify({x,y})); } catch(_){} };
    const applyPos = (pos) => {
      if (!pos) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const x = Math.max(0, Math.min(vw - 40, pos.x));
      const y = Math.max(40, Math.min(vh - 40, pos.y));
      Object.assign(dock.style, { left: x + 'px', top: y + 'px', right: 'auto' });
    };

    applyPos(loadPos());
    window.addEventListener('resize', () => applyPos(loadPos()));

    let dragging = false, offX = 0, offY = 0, shield = null;

    const onDown = (e) => {
      // ignore clicks on the title-bar control buttons
      if (e && e.target && e.target.closest && e.target.closest('.title-bar-controls')) return;
      dragging = true;
      const r = dock.getBoundingClientRect();
      offX = (e.clientX || 0) - r.left;
      offY = (e.clientY || 0) - r.top;
      dock.style.left = r.left + 'px';
      dock.style.top  = r.top  + 'px';
      dock.style.right = 'auto';
      // prevent iframes from eating pointer events while dragging
      shield = document.createElement('div');
      Object.assign(shield.style, { position:'fixed', left:0, top:0, right:0, bottom:0, zIndex:2000, background:'transparent' });
      document.body.appendChild(shield);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      let nx = (e.clientX || 0) - offX;
      let ny = (e.clientY || 0) - offY;
      nx = Math.max(0, Math.min(vw - dock.offsetWidth, nx));
      ny = Math.max(40, Math.min(vh - 40, ny));
      dock.style.left = nx + 'px';
      dock.style.top  = ny + 'px';
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (shield){ try { shield.remove(); } catch(_){} shield = null; }
      const r = dock.getBoundingClientRect();
      savePos(r.left, r.top);
    };

    bar.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    // Touch support
    bar.addEventListener('touchstart', (e) => onDown(e.touches[0]), { passive:false });
    window.addEventListener('touchmove',  (e) => { onMove(e.touches[0]); e.preventDefault(); }, { passive:false });
    window.addEventListener('touchend', onUp);
  })();
})();
// End setupMediaDockChrome




