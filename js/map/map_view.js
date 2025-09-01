// js/map/map_view.js
// Map view + styling: Leaflet map setup, legend, XP controls, tooltips, and toss-up striping (plugin + fallback).

let MAP, LAYER, LEGEND, HOVER;
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
    const st = raceCallStatus(row, parties, STATE.callRules);
    if (!(t2 && t2.leader && t2.runnerUp) || st.called) { if (layer._path) layer._path.style.fill = ''; return; }
    if (st.label === 'tossup' && layer._path) {
      const c1 = partyColor(t2.leader.key);
      const c2 = partyColor(t2.runnerUp.key);
      const id = __ensureStripeDef(c1, c2, `${t2.leader.key}_${t2.runnerUp.key}`);
      if (id) {
        layer._path.style.fill = `url(#${id})`;
        layer._path.style.fillOpacity = 0.9;
      }
    } else if (layer._path) { layer._path.style.fill = ''; }
  });
}

function makeTip(feature) {
  const p = feature.properties;
  const name = p.name_rr || p.NAME_1 || p.name || p.district_id;
  const mode = document.getElementById('mode').value;
  const row  = p._row || {};
  if (mode === 'winner') {
    const w = winnerForRow(row, STATE.parties);
    return w ? `${name}<br>Winner: <b>${displayPartyName(w.party)}</b> (${w.share?.toFixed(1)}%)` : `${name}<br>Winner: ?`;
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

function makeTipEnhanced(feature){
  const p = feature.properties;
  const name = p.name_rr || p.NAME_1 || p.name || p.district_id;
  const mode = document.getElementById('mode').value;
  const row  = p._row || {};
  const parties = STATE?.parties || [];
  const hasReported = (row._totalVotes||0) > 0;
  const status = hasReported ? raceCallStatus(row, parties, STATE.callRules) : { called:false, lead:0, phase:0, label:'unreported', leader:{}, runnerUp:{} };
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
    return `\n      <div style="margin:2px 0;">\n        <div class="field-row" style="justify-content:space-between; gap:8px;">\n          <div><span class="swatch" style="background:${partyColor(key)}"></span>${displayPartyName(key)}</div>\n          <div>${share == null ? '-' : share.toFixed(1) + '%'}</div>\n        </div>\n        <div style="height:6px;background:#eee;border:1px solid #aaa;width:140px;margin-top:2px;">\n          <div style="height:100%;width:${Math.max(0, Math.min(100, (share||0))).toFixed(1)}%;background:${partyColor(key)}"></div>\n        </div>\n      </div>`;
  }).join('');

  if (mode === 'winner'){ return `${name}<br>Reporting: ${reportPct}%<br>${headLine}<br>${items}`; }
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

function injectPartyOptions(parties) {
  const sel = document.getElementById('mode');
  if (!sel) return;
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

function updateMapStyling(mode) {
  if (!LAYER || !STATE) return;
  const parties = STATE.parties;
  if (mode === 'winner') {
    LAYER.setStyle(f => {
      const row = f.properties._row || {};
      const hasReported = (row._totalVotes||0) > 0;
      if (!hasReported) return { color:'#666', weight:0.6, fillColor:'#bbb', fillOpacity:0.9, fillPattern:null };
      const t2 = topTwo(row, parties);
      if (!(t2 && t2.leader && t2.leader.key)) {
        return { color:'#666', weight:0.6, fillColor:'#bbb', fillOpacity:0.9, fillPattern:null };
      }
      const status = raceCallStatus(row, parties, STATE.callRules);
      if (row._call && row._call.winner) {
        return { color:'#666', weight:0.6, fillColor: partyColor(row._call.winner), fillOpacity:0.9, fillPattern:null };
      }
      if (status.called) {
        return { color:'#666', weight:0.6, fillColor: partyColor(t2.leader.key), fillOpacity:0.9, fillPattern:null };
      }
      if (status.label === 'tossup' && t2.runnerUp && t2.runnerUp.key) {
        const patt = getStripePattern(t2.leader.key, t2.runnerUp.key);
        if (patt) {
          return { color:'#666', weight:0.6, fill:true, fillOpacity:0.9, fillColor: 'transparent', fillPattern: patt };
        }
        if (!(window.L && L.StripePattern)) __applyStripeFallback();
      }
      return { color:'#666', weight:0.6, fillColor: partySoftColor(t2.leader.key), fillOpacity:0.9, fillPattern:null };
    });
    const N = Math.min(parties.length, 10);
    const items = parties.slice(0, N)
      .map(p => `<div><span class="swatch" style="background:${partyColor(p)}"></span>${displayPartyName(p)}</div>`)
      .join('');
    let toss = '';
    if (parties.length >= 2){
      const c1 = partyColor(parties[0]);
      const c2 = partyColor(parties[1]);
      toss = `<div style="margin-top:6px;">\n        <span class="swatch" style="background: repeating-linear-gradient(45deg, ${c1} 0 6px, ${c2} 6px 12px);"></span>\n        <span class="muted">Stripes = too close to call</span>\n      </div>`;
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
        const row = f.properties._row || {};
        s = row._party?.[partyKey]?.share;
      }
      const idx = percentIdx(s, 6);
      const sw = (mode === 'turnout') ? percentColor(idx) : percentColorByParty((mode.startsWith('share:') ? mode.slice(6) : ''), idx, 6);
      return { color:'#666', weight:0.6, fillColor: sw, fillOpacity: 0.9 };
    });
    const bins = [0, 16.7, 33.3, 50.0, 66.7, 83.3, 100.0];
    const labels = [];
    for (let i=0;i<bins.length-1;i++){
      const lo=bins[i], hi=bins[i+1];
      const sw = (mode === 'turnout') ? percentColor(i) : percentColorByParty((mode.startsWith('share:') ? mode.slice(6) : ''), i, 6);
      labels.push(`<div><span class="swatch" style="background:${sw}"></span>${lo.toFixed(0)}-${hi.toFixed(0)}%</div>`);
    }
    const title = (mode === 'turnout') ? 'Turnout (%)' : `${displayPartyName(mode.slice(6))} share (%)`;
    LEGEND._div.innerHTML = `<strong>${title}</strong><br>${labels.join('')}`;
  }
}

function initMapAndControls(geojson, parties){
  const featureLayer = L.geoJSON(geojson);
  const featureBounds = featureLayer.getBounds();
  MAP = L.map('map', {
    preferCanvas: false,
    zoomControl: false,
    attributionControl: false,
    keyboard: false,
    maxBounds: featureBounds.pad(0.1),
    maxBoundsViscosity: 1.0
  });
  LEGEND = L.control({ position: 'bottomleft' });
  LEGEND.onAdd = function(){
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
      const bounds = featureBounds;
      if (zi) zi.addEventListener('click', () => MAP.zoomIn());
      if (zo) zo.addEventListener('click', () => MAP.zoomOut());
      if (hm) hm.addEventListener('click', () => MAP.fitBounds(bounds, { padding:[10,10] }));
    }, 0);
    setTimeout(() => {
      const modeSelect = el.querySelector('#mode');
      if (modeSelect) {
        modeSelect.addEventListener('change', () => updateMapStyling(modeSelect.value));
        injectPartyOptions(parties);
      }
    }, 0);
    return el;
  };
  XPZoom.addTo(MAP);

  LAYER = L.geoJSON(geojson, {
    style: () => ({ color:'#666', weight:0.6, fillColor:'#eee', fillOpacity:0.9, fill:true }),
    onEachFeature: (feature, layer) => {
      layer.on('mousemove', e => {
        HOVER = { layer, feature, latlng: e.latlng };
        try { window.HOVER = HOVER; } catch(_){}
        layer.bindTooltip(makeTipEnhanced(feature), { sticky:true }).openTooltip(e.latlng);
      });
      layer.on('mouseout', () => { HOVER=null; try { window.HOVER = HOVER; } catch(_){} layer.closeTooltip(); });
    }
  }).addTo(MAP);

  MAP.fitBounds(featureBounds, { padding: [10, 10] });
  MAP.setMinZoom(MAP.getZoom());

  // Initial legend/style
  updateMapStyling('winner');

  // Expose globals for other modules
  try { window.MAP = MAP; window.LAYER = LAYER; window.LEGEND = LEGEND; window.HOVER = HOVER; } catch(_){}
}

// Exports are via globals (non-module build)
