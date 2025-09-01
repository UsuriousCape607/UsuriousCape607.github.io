// js/domain/domain.js
// Domain logic: dataset selection, count window, scheduling, scaling, national aggregation, calls, and labels.

// --- URL param helpers ---
function getQueryParams(){
  try { return new URLSearchParams(window.location.search); } catch(_) { return new URLSearchParams(''); }
}

function selectUniverseElection(manifest){
  const params = getQueryParams();
  const uKey = params.get('u');
  const eSlug = params.get('e');
  const universes = Array.isArray(manifest?.universes) ? manifest.universes : [];
  let universe = universes[0] || null;
  if (uKey){
    const found = universes.find(u => String(u.key) === String(uKey));
    if (found) universe = found;
  }
  const elections = Array.isArray(universe?.elections) ? universe.elections : [];
  let election = elections[0] || null;
  if (eSlug){
    const foundE = elections.find(e => String(e.slug) === String(eSlug));
    if (foundE) election = foundE;
  }
  return { universe, election };
}

// --- Count window ---
function ensureCountWindow(election) {
  const s = Date.parse(election?.count_start);
  const e = Date.parse(election?.count_end);
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) return { startMs: s, endMs: e };
  try {
    const saved = JSON.parse(localStorage.getItem('countWindow') || 'null');
    if (saved && Number.isFinite(saved.startMs) && Number.isFinite(saved.endMs) && saved.endMs > Date.now()) {
      return saved;
    }
  } catch (_){}
  const now = Date.now();
  const fresh = { startMs: now, endMs: now + 5*60*1000 };
  try { localStorage.setItem('countWindow', JSON.stringify(fresh)); } catch(_){}
  return fresh;
}

// --- Progress percentage (0..100) over count window ---
function computeProgress(startMs, endMs) {
  const now = Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 100;
  if (now <= startMs) return 0;
  if (now >= endMs) return 100;
  return ((now - startMs) / (endMs - startMs)) * 100;
}

// --- District reporting schedule ---
function assignReportingSchedule(rows, startMs, endMs) {
  const span = Math.max(1, endMs - startMs);
  return rows.map(r => {
    let bias = 0.5;
    const did = String(r.district_id || '');
    if (/Seoul/i.test(did)) bias = 0.25;
    else if (/Jeon|Jeolla/i.test(did)) bias = 0.35;
    else if (/Hamgyeong/i.test(did)) bias = 0.65;
    else if (/Pyeong/i.test(did)) bias = 0.55;
    const startFrac = Math.min(0.9, Math.max(0.05, bias + (Math.random()-0.5)*0.3));
    const endFrac   = Math.min(1.0, Math.max(startFrac + 0.05, startFrac + 0.25 + Math.random()*0.25));
    return { ...r, report_start: Math.round(startMs + startFrac*span), report_end: Math.round(startMs + endFrac*span) };
  });
}

// --- Scale live rows based on schedule (phase) and early bias ---
function scaleRowsBySchedule(rowsWithSched, parties, now = Date.now()) {
  return rowsWithSched.map(row => {
    const rs = row.report_start, re = row.report_end;
    let phase = 0;
    if (now >= re) phase = 1; else if (now > rs) phase = (now - rs) / Math.max(1, re - rs);
    const out = { ...row, _party: {} };
    const finals = parties.map(p => Math.max(0, Number(row[`${p}_votes`]) || 0));
    const totalFinal = finals.reduce((a,b)=>a+b,0);
    const reported = Math.max(0, Math.round(totalFinal * phase));
    const biases = (typeof biasVectorFor === 'function')
      ? biasVectorFor(String(row.district_id || ''), parties, 0.2)
      : Object.fromEntries(parties.map(p=>[p,0]));
    const weights = finals.map((v,i)=> {
      const key = parties[i];
      const b = biases[key] || 0;
      const w = (typeof earlyWeight === 'function') ? earlyWeight(b, phase, 1.25) : 1;
      return v * w;
    });
    const alloc = (typeof apportion === 'function') ? apportion(reported, weights) : finals.map(v=>Math.round(v*phase));
    let total = 0;
    for (let i=0; i<parties.length; i++){ const p = parties[i]; const live = alloc[i]; out[`${p}_votes_live`] = live; total += live; }
    for (const p of parties){ const vLive = out[`${p}_votes_live`]; out._party[p] = { votes: vLive, share: total ? (vLive/total*100) : null }; }
    out._totalVotes = total; out._phase = phase;
    return out;
  });
}

// --- Race calling persistence ---
function updateCalls(rowsLive, parties){
  if (!window.STATE) return;
  if (!STATE.calls) STATE.calls = new Map();
  const now = Date.now();
  for (const r of rowsLive){
    const id = String(r.district_id);
    if (STATE.calls.has(id)){ r._call = STATE.calls.get(id); continue; }
    const st = raceCallStatus(r, parties, STATE.callRules);
    const t2 = topTwo(r, parties);
    if (st.called && t2 && t2.leader && t2.leader.key){
      const call = { winner: t2.leader.key, at: now };
      STATE.calls.set(id, call);
      r._call = call;
    } else { r._call = null; }
  }
}

// --- National aggregation ---
function computeNational(rows, parties){
  const totals = Object.fromEntries(parties.map(p => [p, 0]));
  let ballots = 0, eligibleWeighted = 0, turnoutWeighted = 0;
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

// --- Display labels (data-driven) ---
function displayPartyName(key){
  try {
    const meta = (window.STATE && window.STATE.partyMeta && window.STATE.partyMeta[key]) || null;
    if (meta && meta.name) return meta.name;
  } catch(_){}
  // Fallback: insert spaces before capitals
  return String(key).replace(/([a-z])([A-Z])/g, '$1 $2');
}
function displayPartyLong(key){
  try {
    const meta = (window.STATE && window.STATE.partyMeta && window.STATE.partyMeta[key]) || null;
    if (meta && meta.long) return meta.long;
  } catch(_){}
  return displayPartyName(key);
}

// --- Party metadata resolution (names, long names, docs, colors) ---
function resolvePartyMeta(universe, election, keys){
  const meta = {};
  const uni = (universe && (universe.party_meta || universe.parties)) || {};
  const ele = (election && (election.party_meta || election.parties)) || {};
  for (const k of keys){
    const fromE = ele[k] || {};
    const fromU = uni[k] || {};
    meta[k] = {
      name: fromE.name || fromU.name || null,
      long: fromE.long || fromU.long || null,
      doc:  fromE.doc  || fromU.doc  || null,
      color: fromE.color || fromU.color || null
    };
  }
  return meta;
}
