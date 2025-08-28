let MAP, LAYER, LEGEND, STATE;

function progressFromWindow(startStr, endStr){
  const start = +new Date(startStr), end = +new Date(endStr), now = Date.now();
  if (now<=start) return 0;
  if (now>=end) return 100;
  return ((now-start)/(end-start))*100;
}

function scaleRowsByProgress(rows, parties, progress){
  return rows.map(r=>{
    const out = {...r, _party:{}};
    let total=0;
    for (const p of parties){
      const v = Number(r[`${p}_votes`]);
      const live = Number.isFinite(v) ? Math.round(v*progress/100) : null;
      out[`${p}_votes_live`] = live;
      if (Number.isFinite(live)) total += live;
    }
    for (const p of parties){
      const v = out[`${p}_votes_live`];
      out._party[p] = { votes: v, share: (Number.isFinite(v)&&total>0) ? (v/total*100) : null };
    }
    out._totalVotes = total;
    return out;
  });
}

(async function init(){
  const m = await j('manifest.json');
  const U = m.universes[0];        // start with Korea; expand UI later
  const E = U.elections[0];

  const [gj, csvText] = await Promise.all([ j(U.geojson), t(E.csv) ]);
  const rowsFinal = parseCSV(csvText);
  const parties = rowsFinal.length ? detectParties(rowsFinal[0]) : [];

  // live scaling
  const prog = progressFromWindow(E.count_start, E.count_end);
  const rowsLive = scaleRowsByProgress(rowsFinal, parties, prog);

  // join
  const byId = new Map(rowsLive.map(r=>[String(r.district_id), r]));
  gj.features.forEach(f => f.properties._row = byId.get(String(f.properties.district_id)) || null);

  STATE = { parties, rowsFinal, rowsLive, gj, E };

  // map
  MAP = L.map('map', { preferCanvas:true });
  LEGEND = L.control({position:'bottomleft'}); LEGEND.onAdd = function(){ this._div = L.DomUtil.create('div','legend'); return this._div; }; LEGEND.addTo(MAP);
  LAYER = L.geoJSON(gj, {
    style:()=>({ color:'#666', weight:0.6, fillColor:'#eee', fillOpacity:0.9 }),
    onEachFeature: (f, lyr) => {
      lyr.on('mousemove', e => { lyr.bindTooltip(makeTip(f), {sticky:true}).openTooltip(e.latlng); });
      lyr.on('mouseout', () => lyr.closeTooltip());
    }
  }).addTo(MAP);
  MAP.fitBounds(LAYER.getBounds(), { padding:[10,10] });

  // wire mode select & initial paint
  document.getElementById('mode').addEventListener('change', restyle);
  injectPartyOptions(parties);
  updateProgressUI(prog);
  restyle();

  // optional: update every 30s to follow system time
  setInterval(async ()=>{
    const p = progressFromWindow(E.count_start, E.count_end);
    updateProgressUI(p);
    // rescale in place
    const live = scaleRowsByProgress(STATE.rowsFinal, STATE.parties, p);
    const byId2 = new Map(live.map(r=>[String(r.district_id), r]));
    LAYER.eachLayer(lyr => { lyr.feature.properties._row = byId2.get(String(lyr.feature.properties.district_id)) || null; });
    restyle();
  }, 30000);
})();

function injectPartyOptions(parties){
  const sel = document.getElementById('mode');
  const old = sel.querySelector('optgroup'); if (old) old.remove();
  if (!parties.length) return;
  const og = document.createElement('optgroup'); og.label='Party share (%)';
  for (const p of parties){ const o=document.createElement('option'); o.value='share:'+p; o.textContent=`${p} share (%)`; og.appendChild(o); }
  sel.appendChild(og);
}

function makeTip(f){
  const name = f.properties.name_rr || f.properties.name || f.properties.district_id;
  const mode = document.getElementById('mode').value;
  if (mode==='winner'){
    const w = winnerForRow(f.properties._row || {}, STATE.parties);
    return w ? `${name}<br>Winner: <b>${w.party}</b> (${w.share?.toFixed(1)}%)` : `${name}<br>Winner: —`;
  }
  if (mode==='turnout'){
    const s = Number((f.properties._row||{}).turnout);
    return `${name}<br>Turnout: ${Number.isFinite(s)? s.toFixed(1)+'%' : '—'}`;
  }
  if (mode.startsWith('share:')){
    const p=mode.slice(6); const s=f.properties._row?._party?.[p]?.share;
    return `${name}<br>${p} share: ${s==null?'—':s.toFixed(1)+'%'}`;
  }
  return name;
}

function restyle(){
  const mode = document.getElementById('mode').value;
  if (mode==='winner'){
    LAYER.setStyle(f => {
      const w = winnerForRow(f.properties._row || {}, STATE.parties);
      return { color:'#666', weight:0.6, fillColor: w ? partyColor(w.party) : '#bbb', fillOpacity:0.9 };
    });
    const N = Math.min(STATE.parties.length, 10);
    const items = STATE.parties.slice(0,N).map(p=>`<div><span class="swatch" style="background:${partyColor(p)}"></span>${p}</div>`).join('');
    LEGEND._div.innerHTML = `<strong>Winner</strong><br>${items}${STATE.parties.length>N?'<div>…</div>':''}`;
  } else {
    LAYER.setStyle(f => {
      let s=null; 
      if (mode==='turnout') s = Number((f.properties._row||{}).turnout);
      else if (mode.startsWith('share:')){ const p=mode.slice(6); s=f.properties._row?._party?.[p]?.share; }
      return { color:'#666', weight:0.6, fillColor: percentColor(percentIdx(s,6)), fillOpacity:0.9 };
    });
    const steps=6, labels=[]; for (let i=0;i<steps;i++){ const lo=(i)*(100/steps), hi=(i+1)*(100/steps); labels.push(`<div><span class="swatch" style="background:${percentColor(i)}"></span>${lo.toFixed(0)}–${hi.toFixed(0)}%</div>`); }
    LEGEND._div.innerHTML = `<strong>${mode==='turnout'?'Turnout (%)': mode.slice(6)+' share (%)'}</strong><br>${labels.join('')}`;
  }
}

function updateProgressUI(pct){
  let el = document.getElementById('progress'); if (!el){
    const bar = document.createElement('div'); bar.id='progress'; bar.style.cssText='position:fixed;left:0;top:0;height:4px;width:100%;background:rgba(0,0,0,.08);z-index:9999';
    const fill = document.createElement('div'); fill.id='progressFill'; fill.style.cssText='height:100%;width:0%';
    bar.appendChild(fill); document.body.appendChild(bar);
  }
  document.getElementById('progressFill').style.background = '#2b8cbe';
  document.getElementById('progressFill').style.width = pct.toFixed(1)+'%';
}

function getCountWindow(election){
    const FIVE_MIN = 5*60*1000;
    let start = election.count_start ? Date.parse(election.count_start) : NaN;
    let end = election.count_end ? Date.parse(election.count_end) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end<=start) {
        const now = Date.now();
        start = now
        end = now + FIVE_MIN;
    }
    return {start, end}
}

function progressFromWindow(startMs, endMs){
    const now = Date.now();
    if (now<=startMs) return 0;
    if (now>=endMs) return 100;
    return ((now-startMs)/(endMs-startMs))*100;
}

const {start, end} = getCountWindow(STATE.E);
let prog = progressFromWindow(start, end);
/// Initial Scale + Render
/// (scaleRowsByProgress and restyle() same as before)
/// auto-advance every 2s until 100%
const TICK_MS = 2000;
const timer = setInterval(() => {
    prog = progressFromWindow(start, end);
    updateProgressUI(prog);
    const live = scaleRowsByProgress(STATE.rowsFinal, STATE.parties, prog);
    const byId2 = new Map(live.map(r=>[String(r.district_id), r]));
    LAYER.eachLayer(lyr => { lyr.feature.properties._row = byId2.get(String(lyr.feature.properties.district_id)) || null; });
    restyle();
    if (prog>=100) clearInterval(timer);
}, TICK_MS);

function showCountWindowBanner(startMs, endMs) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:4px;left:50%;transform:translateX(-50%);background:#2b8cbe;color:#fff;padding:6px 12px;border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,.2);z-index:10000;font-family:sans-serif;font-size:14px;';
    const startDate = new Date(startMs);
    const endDate = new Date(endMs);
    banner.innerHTML = `Counting from <strong>${startDate.toLocaleString()}</strong> to <strong>${endDate.toLocaleString()}</strong>`;
    document.body.appendChild(banner);
    setTimeout(() => {
        banner.remove();
    }, 10000);
}