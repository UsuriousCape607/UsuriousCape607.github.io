// js/app.js
// Boot the elections map: select universe/election via URL (?u=&e=), load, and orchestrate modules.

let STATE;

async function init(){
  // Load manifest and select dataset by URL params
  const manifest = await j('manifest.json');
  const { universe, election } = selectUniverseElection(manifest);
  const [gj, csvText] = await Promise.all([ j(universe.geojson), t(election.csv) ]);
  const rowsFinal = parseCSV(csvText);
  const parties = rowsFinal.length ? detectParties(rowsFinal[0]) : [];
  const win = ensureCountWindow(election);
  // If no universe/election specified, default to Korea
  let defaultKorea = false;
  if (!universe?.name && !election?.name) {
    defaultKorea = true;
  }
  const isKorea = defaultKorea || (universe?.name?.toLowerCase?.() === 'korea' || election?.name?.toLowerCase?.().includes('korea'));
  let partyMeta = resolvePartyMeta(universe, election, parties);
  // Korea-specific gimmick: Park Heonyeong/WPK gets red color
  if (isKorea && partyMeta) {
    Object.keys(partyMeta).forEach(party => {
      const key = party.trim().toLowerCase();
      if ((key === 'park heonyeong' || key === 'wpk') && partyMeta[party]) {
        partyMeta[party].color = '#d00'; // bright red
      }
    });
    // Fallback: directly set by canonical keys if present
    if (partyMeta['WPK']) partyMeta['WPK'].color = '#d00';
    if (partyMeta['Park Heonyeong']) partyMeta['Park Heonyeong'].color = '#d00';
  }
  const callRules = Array.isArray(election?.call_rules) ? election.call_rules : [];
  STATE = { parties, rowsFinal, gj, election, universe, startMs: win.startMs, endMs: win.endMs, partyMeta, callRules, isKorea };
  try { window.STATE = STATE; } catch(_){}
  STATE.scheduleRows = assignReportingSchedule(rowsFinal, STATE.startMs, STATE.endMs);
  STATE.totalDistricts = new Set(rowsFinal.map(r => String(r.district_id))).size;
  const repInit = document.getElementById('provincesReporting');
  if (repInit) repInit.textContent = `0 / ${STATE.totalDistricts}`;

  // Map and controls
  initMapAndControls(gj, parties);

  // About panel: fill once with long names
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
    setInterval(function() {
      t++;
      // Alternate solid/outline dots for a clear live blinker
      const a = '●', b = '○';
      if (dot) dot.textContent = (t % 2) ? a : b;
      if (hd)  hd.textContent  = (t % 2) ? a : b;
      if (hc)  hc.textContent  = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      if (cpu){ const base = 12, amp = 6; const val = Math.round(base + amp * (0.5 + 0.5*Math.sin(t/6))); cpu.textContent = `CPU Usage: ${val}%`; }
    }, 1000);
  })();

  // Live tick
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
    const xpZoomEl = document.querySelector('.xp-zoom');
    const modeSelect = xpZoomEl ? xpZoomEl.querySelector('#mode') : null;
    updateMapStyling(modeSelect ? modeSelect.value : 'winner');
    if (window.HOVER && HOVER.layer && typeof HOVER.layer.getTooltip === 'function'){
      const tt = HOVER.layer.getTooltip && HOVER.layer.getTooltip();
      if (tt){ tt.setContent(makeTipEnhanced(HOVER.feature)); HOVER.layer.openTooltip(HOVER.latlng); }
    }
    const allDone = rowsLive.every(r => now >= r.report_end);
    if (progress >= 100 && allDone) clearInterval(timer);
  }, TICK_MS);

  // Show current project/universe/election in header
  const projHeader = document.getElementById('projectHeader');
  if (projHeader) {
    projHeader.textContent = `Project: ${universe?.name || ''} / ${election?.name || ''}`;
  }
}

init();
