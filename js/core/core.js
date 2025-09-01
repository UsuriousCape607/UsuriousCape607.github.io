// js/core/core.js
// Core utilities: fetch helpers, CSV parsing, color + stats, calling rules, and simulation helpers.

// --- Fetch helpers ---
async function j(u){ return await (await fetch(u)).json(); }
async function t(u){ return await (await fetch(u)).text(); }

// --- CSV parsing ---
function parseCSV(txt){
  const rows = String(txt || '').trim().split(/\r?\n/);
  if (!rows.length) return [];
  const header = rows.shift().split(',');
  return rows.map(line => {
    const cells = line.split(',');
    const obj = {};
    for (let i=0;i<header.length;i++) obj[header[i]] = cells[i];
    return obj;
  });
}

// --- Party detection from columns ---
function detectParties(row){
  const s=new Set();
  for (const k of Object.keys(row || {})){
    const m = k.match(/^(.*)_(votes|share)$/i);
    if (m) s.add(m[1].trim());
  }
  return [...s].sort();
}

// --- Colors and hues ---
function hexToHsl(hex){
  const m = String(hex).replace('#','');
  const r = parseInt(m.substring(0,2),16)/255;
  const g = parseInt(m.substring(2,4),16)/255;
  const b = parseInt(m.substring(4,6),16)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h,s,l=(max+min)/2;
  if (max===min){ h=s=0; }
  else {
    const d=max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h=(g-b)/d+(g<b?6:0); break;
      case g: h=(b-r)/d+2; break;
      case b: h=(r-g)/d+4; break;
    }
    h*=60;
  }
  return { h, s:s*100, l:l*100 };
}

// Determine a stable hue for each party, with optional overrides from STATE.partyMeta[color].
function partyHue(name){
  const key = String(name).trim().toLowerCase();
  if (key === 'wpk' || key === 'park heonyeong') {
    return hexToHsl('#d62728').h; // red
  }
  // Prefer explicit color override from STATE.partyMeta if provided
  try {
    const meta = (window.STATE && window.STATE.partyMeta && window.STATE.partyMeta[name]) || null;
    if (meta && meta.color){ return hexToHsl(meta.color).h; }
  } catch(_){}
  // Minimal explicit default override example (can be removed when meta used):
  const overrides = { };
  if (overrides[name]) return hexToHsl(overrides[name]).h;
  // Fallback deterministic hue from name hash
  let h=5381; for (let i=0;i<name.length;i++) h=((h<<5)+h)+name.charCodeAt(i);
  const hue=(Math.abs(h)%360+137.508)%360;
  return hue;
}

function partyColor(name){
  const key = String(name).trim().toLowerCase();
  if (key === 'wpk' || key === 'park heonyeong') {
    return '#d62728'; // solid red
  }
  const hue = partyHue(name); return `hsl(${hue.toFixed(0)},65%,55%)`; 
}
function partySoftColor(name){ const hue = partyHue(name); return `hsl(${hue.toFixed(0)},45%,80%)`; }

// --- Percent bin palettes ---
function percentIdx(v,steps=6){ if(v==null) return -1; const t=Math.max(0,Math.min(1,v/100)); return Math.floor(t*steps); }
function percentColor(i){ const c=['#deebf7','#c6dbef','#9ecae1','#6baed6','#3182bd','#08519c']; return i<0?'#bbb':c[Math.max(0,Math.min(c.length-1,i))]; }
function percentColorByParty(partyName, i, steps=6){
  if (i < 0) return '#bbb';
  const hue = partyHue(partyName);
  const clamped = Math.max(0, Math.min(steps-1, i));
  const l0 = 90, l1 = 40;
  const L = l0 - (l0 - l1) * (clamped / Math.max(1, steps-1));
  const S = 65;
  return `hsl(${hue.toFixed(0)},${S}%,${L.toFixed(0)}%)`;
}

// --- Row stats helpers ---
function winnerForRow(row, parties){ let best=null,bv=-Infinity; for (const p of parties){ const s=row?._party?.[p]?.share ?? -Infinity; if (s>bv){bv=s;best=p;} } return best?{party:best,share:bv}:null; }
function topTwo(row, parties){
  let leader = { key:null, share:-Infinity };
  let runnerUp = { key:null, share:-Infinity };
  for (const p of parties){
    const s = row?._party?.[p]?.share;
    if (!Number.isFinite(s)) continue;
    if (s > leader.share){ runnerUp = leader; leader = { key:p, share:s }; }
    else if (s > runnerUp.share){ runnerUp = { key:p, share:s }; }
  }
  return { leader, runnerUp };
}

function mixPartyColors(p1, p2){
  const h1 = partyHue(p1), h2 = partyHue(p2);
  let dh = ((h2 - h1 + 540) % 360) - 180; // shortest arc
  const h = (h1 + dh/2 + 360) % 360;
  const s = 55, l = 70;
  return `hsl(${h.toFixed(0)},${s}%,${l}%)`;
}

// --- Race calling rules ---
// Default thresholds if none provided by data: array of {phase, lead} conditions.
const DEFAULT_CALL_RULES = [
  { phase: 0.99, lead: 0.5 },
  { phase: 0.92, lead: 12 },
  { phase: 0.85, lead: 18 },
  { phase: 0.75, lead: 25 }
];

function raceCallStatus(row, parties, rules){
  const phase = typeof row._phase === 'number' ? row._phase : ((row?._totalVotes||0) > 0 ? 1 : 0);
  const t2 = topTwo(row, parties);
  const lead = (Number.isFinite(t2.leader.share) && Number.isFinite(t2.runnerUp.share)) ? (t2.leader.share - t2.runnerUp.share) : 0;
  // At full reporting, definitively call for leader if any lead exists
  if (phase >= 0.999) {
    const called = Number.isFinite(lead) && lead > 0;
    return { called, lead, phase, label: called ? 'called' : 'tossup', leader: t2.leader, runnerUp: t2.runnerUp };
  }
  const rr = Array.isArray(rules) && rules.length ? rules : DEFAULT_CALL_RULES;
  const called = rr.some(r => phase >= (r.phase||0) && lead >= (r.lead||0));
  let label = 'tossup';
  if (called) label = 'called';
  else if (lead >= 4) label = 'lean';
  return { called, lead, phase, label, leader: t2.leader, runnerUp: t2.runnerUp };
}

// ===== Early/Late Reporting Simulation Helpers =====
function _hash32(str){ let h=2166136261>>>0; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
function _rand01(key){ const h=_hash32(key); return (h/4294967296); }
// Produce a zero-mean bias vector for parties in a district; amp in [0..1]
function biasVectorFor(districtKey, parties, amp=0.2){
  const raw = parties.map(p => _rand01(String(districtKey)+'|'+p) - 0.5);
  const mean = raw.reduce((a,b)=>a+b,0) / (raw.length || 1);
  const vec = raw.map(v => v - mean);
  const maxAbs = Math.max(1e-9, Math.max(...vec.map(v=>Math.abs(v))));
  return Object.fromEntries(parties.map((p,i)=>[p, (vec[i]/maxAbs)*amp]));
}
// Bias fade with reporting phase (1.0 -> no bias)
function earlyWeight(bias, phase, alpha=1.2){
  const influence = Math.pow(1 - Math.max(0, Math.min(1, phase)), alpha);
  const w = 1 + bias * influence;
  return Math.max(0.2, w);
}
// Apportion 'total' integer ballots proportionally to weights array
function apportion(total, weights){
  const sum = weights.reduce((a,b)=>a+b,0);
  if (!(sum>0) || !(total>0)) return weights.map(_=>0);
  const prelim = weights.map(w => (total * w / sum));
  const floors = prelim.map(x=>Math.floor(x));
  let left = total - floors.reduce((a,b)=>a+b,0);
  const fracs = prelim.map((x,i)=>({i, frac: x - floors[i]})).sort((a,b)=>b.frac - a.frac);
  for (let k=0; k<fracs.length && left>0; k++, left--){ floors[fracs[k].i]++; }
  return floors;
}
