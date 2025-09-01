// js/ui/ui.js
// UI: progress/desk, candidate docs viewer, tabs, and media dock controls.

function fmtPct(x){ return Number.isFinite(x) ? x.toFixed(1) + '%' : '?'; }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
function fmtCountdown(ms){ if (!Number.isFinite(ms) || ms <= 0) return '00:00'; const s = Math.floor(ms/1000), m = Math.floor(s/60), r = s % 60; return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0'); }

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
  (function applyThemeFromLeader(){
    try {
      const leaderKey = agg.ordered && agg.ordered[0];
      const root = document.documentElement;
      if (leaderKey) {
        const c = partyColor(leaderKey);
        const weak = typeof partySoftColor === 'function' ? partySoftColor(leaderKey) : c;
        root.style.setProperty('--accent', c);
        root.style.setProperty('--accent-weak', weak);
      }
    } catch (_) {}
  })();
  const list = document.getElementById('raceList');
  const totLine = document.getElementById('raceTotals');
  const turnEl = document.getElementById('turnoutNational');
  if (list){
    const frag = document.createDocumentFragment();
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
      frag.appendChild(row);
    }
    list.innerHTML = '';
    list.appendChild(frag);
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

// Candidate doc opener based on partyMeta or fallback path
window.openCandidateDoc = function(key){
  const meta = (window.STATE && window.STATE.partyMeta && window.STATE.partyMeta[key]) || null;
  const url = (meta && meta.doc) || `docs/candidates/${key}.md`;
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

// Doc reader: simple Markdown fetch + render (BBCode safe, link/image handling)
(function setupDocReader(){
  const sel = document.getElementById('docSelect');
  const pane = document.getElementById('docPane');
  if (!sel || !pane) return;
  const md = (txt, baseUrl)=>{
    const escape = (s)=> s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const resolveUrl = (p, forImage=false)=>{
      try {
        if (/^https?:/i.test(p)) return p;
        if (forImage) return null;
        if (/^data:/i.test(p)) return p;
        const baseAbs = new URL(baseUrl, window.location.href);
        const baseDir = baseAbs.href.slice(0, baseAbs.href.lastIndexOf('/')+1);
        return new URL(p, baseDir).href;
      } catch(_) { return p; }
    };
    const toLink = (s)=> s.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g,(m,txt,url)=>`<a href="${resolveUrl(url,false)}" target="_blank" rel="noopener">${txt}</a>`);
    const toStrong = (s)=> s.replace(/\*\*(.*?)\*\*/g,'<b>$1</b>');
    const out = [];
    let inList = false;
    let para = [];
    function flushPara(){ if (!para.length) return; const joined = para.join(' ').replace(/\s+/g,' ').trim(); const body = DocViewer.bbcode( toStrong(toLink(escape(joined))) ); out.push(`<p>${body}</p>`); para.length=0; }
    String(txt).split(/\r?\n/).forEach(line => {
      if (/^\s*$/.test(line)) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(''); return; }
      if (/^\s*<(img|a)\s/i.test(line)) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(line); return; }
      let m;
      if ((m = line.match(/^###\s+(.*)/))) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<h4>${escape(m[1])}</h4>`); return; }
      if ((m = line.match(/^##\s+(.*)/)))  { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<h3>${escape(m[1])}</h3>`); return; }
      if ((m = line.match(/^#\s+(.*)/)))   { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<h2>${escape(m[1])}</h2>`); return; }
      if ((m = line.match(/^\-\s+(.*)/))) {
        flushPara();
        if (!inList){ out.push('<ul>'); inList=true; }
        let bodyRaw = m[1].trim();
        let body = DocViewer.bbcode( toStrong(toLink(escape(bodyRaw))) );
        out.push(`<li>${body}</li>`);
        return;
      }
      const imgMD  = /^!\[([^\]]*)\]\(([^\s)]+)\)\s*$/;
      const imgURL = /^([^\s]+\.(?:png|jpe?g|gif|webp))\s*$/i;
      if ((m = line.match(imgMD))) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<p><img src="${resolveUrl(m[2], true)}" alt="${escape(m[1])}" loading="lazy" style="max-width:100%;height:auto;"></p>`); return; }
      if ((m = line.match(imgURL))) { if (inList){ out.push('</ul>'); inList=false; } flushPara(); out.push(`<p><img src="${resolveUrl(m[1], true)}" loading="lazy" style="max-width:100%;height:auto;"></p>`); return; }
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
      pane.innerHTML = '<span class="muted">Loading.</span>';
      const r = await fetch(u);
      const t = await r.text();
      pane.innerHTML = renderCard(t, u);
    } catch(e){ pane.innerHTML = '<span class="muted">Failed to load</span>'; }
  }
  window.loadDocMarkdown = load;
  sel.addEventListener('change', ()=> load(sel.value));
  load(sel.value);
})();

// Tabs + map/media visibility management
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
    const dock = document.getElementById('mediaDock');
    const yt = document.getElementById('ytContainer');
    const sp = document.getElementById('spotifyContainer');
    if (!isMap && dock) {
      if (yt) { yt.innerHTML = '<div id="ytPlayer"></div>'; yt.style.display = 'none'; }
      if (sp) { sp.innerHTML = ''; sp.style.display = 'none'; }
      dock.style.display = 'none';
    }
    if (isMap && window.MAP && typeof MAP.invalidateSize === 'function') {
      setTimeout(() => MAP.invalidateSize(), 0);
    }
  }
  btnMap.addEventListener('click', ()=>select('map'));
  btnRes.addEventListener('click', ()=>select('results'));
  btnAbt.addEventListener('click', ()=>select('about'));
  select('map');
})();

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
  const vol = document.getElementById('musicVol') || { value: '40', disabled: true, addEventListener: () => {} };
  if (!srcSelH || !inputH || !playH || !pauseH || !defBtnH || !dock || !ytWrap || !spWrap) return;
  function showDock(show){ dock.style.display = show ? '' : 'none'; }
  function showYT(show){ ytWrap.style.display = show ? '' : 'none'; }
  function showSP(show){ spWrap.style.display = show ? '' : 'none'; }
  const getVol = () => Number((vol && vol.value) || 40);
  function ensureYT(){
    return new Promise(resolve => {
      if (window.YT && typeof YT.Player === 'function') return resolve();
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
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
  function parseYouTube(u){ const s = String(u||'').trim(); const m = s.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/); if ((/^[a-zA-Z0-9_-]{11}$/).test(s)) return s; return m && m[1]; }
  function clearDock(){ showYT(false); showSP(false); ytWrap.innerHTML = '<div id="ytPlayer"></div>'; spWrap.innerHTML = ''; }
  let ytPlayer = null, ytReady = false;
  playH.addEventListener('click', function(){
    clearDock();
    const src = srcSelH.value; const val = inputH.value.trim();
    if (src === 'spotify') {
      const info = parseSpotify(val); if (!info) { showDock(false); return; }
      showSP(true); showDock(true);
      const ifr = document.createElement('iframe');
      ifr.width = '100%'; ifr.height = (info.type === 'track') ? '80' : '152';
      ifr.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture'; ifr.loading = 'lazy'; ifr.src = info.url;
      spWrap.appendChild(ifr); return;
    }
    if (src === 'youtube') {
      const id = parseYouTube(val); if (!id) { showDock(false); return; }
      showYT(true); showDock(true);
      ensureYT().then(() => {
        ytPlayer = new YT.Player('ytPlayer', { videoId: id, playerVars: {autoplay:1,controls:1,playsinline:1,rel:0,modestbranding:1}, events: { onReady: () => { ytReady = true; ytPlayer.setVolume(getVol()); ytPlayer.playVideo(); } } });
      });
      return;
    }
    showDock(false);
  });
  pauseH.addEventListener('click', function(){ if (ytPlayer && ytReady) ytPlayer.pauseVideo(); clearDock(); showDock(false); });
  defBtnH.addEventListener('click', function(){ clearDock(); srcSelH.value = 'spotify'; inputH.value = ''; showSP(true); showDock(true); spWrap.innerHTML =
      '<iframe data-testid="embed-iframe" style="border-radius:12px" ' +
      'src="https://open.spotify.com/embed/album/4QCryC4DF1smBc8LCGCRlF?utm_source=generator&theme=0" ' +
      'width="100%" height="152" frameBorder="0" allowfullscreen ' +
      'allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>';
  });
  showDock(false);
})();

// Media dock chrome (minimize, drag, close)
(function setupMediaDockChrome(){
  const dock      = document.getElementById('mediaDock');
  const dockMin   = document.getElementById('mediaDockMin');
  const dockClose = document.getElementById('mediaDockClose');
  const ytWrap    = document.getElementById('ytContainer');
  const spWrap    = document.getElementById('spotifyContainer');
  if (!dock || !dockMin || !dockClose || !ytWrap || !spWrap) return;
  const showDock = (show)=> { dock.style.display = show ? '' : 'none'; };
  const clearEmbeds = ()=> { ytWrap.innerHTML = '<div id="ytPlayer"></div>'; spWrap.innerHTML = ''; ytWrap.style.display = 'none'; spWrap.style.display = 'none'; };
  const onMin = ()=> dock.classList.toggle('collapsed');
  dockMin.addEventListener('click', onMin);
  dockMin.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMin(); } });
  const onClose = ()=> { clearEmbeds(); showDock(false); };
  dockClose.addEventListener('click', onClose);
  dockClose.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose(); } });
  (function makeDockDraggable(){
    const bar = dock.querySelector('.title-bar'); if (!bar) return;
    const loadPos = () => { try { return JSON.parse(localStorage.getItem('mediaDockPos') || 'null'); } catch(_) { return null; } };
    const savePos = (x,y) => { try { localStorage.setItem('mediaDockPos', JSON.stringify({x,y})); } catch(_){} };
    const applyPos = (pos) => { if (!pos) return; const vw = window.innerWidth, vh = window.innerHeight; const x = Math.max(0, Math.min(vw - 40, pos.x)); const y = Math.max(40, Math.min(vh - 40, pos.y)); Object.assign(dock.style, { left: x + 'px', top: y + 'px', right: 'auto' }); };
    applyPos(loadPos()); window.addEventListener('resize', () => applyPos(loadPos()));
    let dragging = false, offX = 0, offY = 0, shield = null;
    const onDown = (e) => {
      if (e && e.target && e.target.closest && e.target.closest('.title-bar-controls')) return;
      dragging = true; const r = dock.getBoundingClientRect(); offX = (e.clientX || 0) - r.left; offY = (e.clientY || 0) - r.top; dock.style.left = r.left + 'px'; dock.style.top  = r.top  + 'px'; dock.style.right = 'auto';
      shield = document.createElement('div'); Object.assign(shield.style, { position:'fixed', left:0, top:0, right:0, bottom:0, zIndex:2000, background:'transparent' }); document.body.appendChild(shield); e.preventDefault();
    };
    const onMove = (e) => { if (!dragging) return; const vw = window.innerWidth, vh = window.innerHeight; let nx = (e.clientX || 0) - offX; let ny = (e.clientY || 0) - offY; nx = Math.max(0, Math.min(vw - dock.offsetWidth, nx)); ny = Math.max(40, Math.min(vh - 40, ny)); dock.style.left = nx + 'px'; dock.style.top  = ny + 'px'; };
    const onUp = () => { if (!dragging) return; dragging = false; if (shield){ try { shield.remove(); } catch(_){} shield = null; } const r = dock.getBoundingClientRect(); savePos(r.left, r.top); };
    bar.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    bar.addEventListener('touchstart', (e) => onDown(e.touches[0]), { passive:false });
    window.addEventListener('touchmove',  (e) => { onMove(e.touches[0]); e.preventDefault(); }, { passive:false });
    window.addEventListener('touchend', onUp);
  })();
})();

// Debounced resize utility and exact map panel height
function debounce(fn, delay) { let timer = null; return function(...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); }; }
(function exactRowHeight(){
  const head = document.getElementById('appHeader');
  const panel = document.getElementById('panelMap');
  if (!head || !panel) return;
  function apply(){ const h = head.getBoundingClientRect().height + 16; panel.style.height = `calc(100vh - ${Math.round(h)}px)`; }
  window.addEventListener('resize', debounce(apply, 100));
  apply();
})();

