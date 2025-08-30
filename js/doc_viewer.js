// js/doc_viewer.js
// Minimal BBCode -> safe HTML for TNO docs viewer.
// We only allow [color=<hex|named>] plus [b], [i], [u], and [br].
(function(){
  const SAFE_NAMED = new Set([
    'black','white','gray','grey','red','maroon','crimson','firebrick',
    'green','darkgreen','seagreen','teal','olive','lime','forestgreen',
    'blue','navy','royalblue','steelblue','dodgerblue','cornflowerblue',
    'purple','indigo','rebeccapurple','magenta','fuchsia',
    'gold','goldenrod','orange','chocolate','sienna','brown','saddlebrown'
  ]);

  function sanitizeColor(c){
    if (!c) return null;
    c = String(c).trim();
    // hex #RGB or #RRGGBB
    if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c)) return c;
    // named (whitelist)
    if (SAFE_NAMED.has(c.toLowerCase())) return c.toLowerCase();
    return null;
  }

  function bbcodeToHtml(s){
    if (!s) return s;

    // [br] -> <br>
    s = s.replace(/\[br\s*\/?\]/gi, '<br>');

    // [b], [i], [u]
    s = s.replace(/\[b\](.*?)\[\/b\]/gis, '<strong>$1</strong>');
    s = s.replace(/\[i\](.*?)\[\/i\]/gis, '<em>$1</em>');
    s = s.replace(/\[u\](.*?)\[\/u\]/gis, '<u>$1</u>');

    // [color=...]...[/color]  (safe only)
    s = s.replace(/\[color=([#a-zA-Z0-9]+)\]([\s\S]*?)\[\/color\]/gi, (m, col, inner) => {
      const safe = sanitizeColor(col);
      if (!safe) return inner; // drop unsafe color, keep text
      return `<span style="color:${safe}">${inner}</span>`;
    });

    return s;
  }

  // Expose globally for app.js to call AFTER it escapes/links/strong-ifies text
  window.DocViewer = {
    bbcode: bbcodeToHtml
  };
})();
