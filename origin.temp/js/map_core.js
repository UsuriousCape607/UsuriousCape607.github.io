async function j(u){ return await (await fetch(u)).json(); }
async function t(u){ return await (await fetch(u)).text(); }
function parseCSV(txt){ const rows=txt.trim().split(/\r?\n/).map(r=>r.split(',')); const h=rows.shift(); return rows.map(r=>Object.fromEntries(r.map((v,i)=>[h[i],v]))); }
function detectParties(row){ const s=new Set(); for (const k of Object.keys(row)){ const m=k.match(/^(.*)_(votes|share)$/i); if (m) s.add(m[1].trim()); } return [...s].sort(); }
function buildPartyStats(rows, parties){
  for (const r of rows){
    const stats={}; let total=0;
    for (const p of parties){ const v=Number(r[`${p}_votes`]); if (Number.isFinite(v)) total+=v; }
    for (const p of parties){
      const v=Number(r[`${p}_votes`]);
      let s=Number(r[`${p}_share`]);
      if (!Number.isFinite(s)) s = Number.isFinite(v)&&total>0 ? (v/total)*100 : null;
      stats[p]={votes:Number.isFinite(v)?v:null, share:Number.isFinite(s)?s:null};
    }
    r._party=stats; r._totalVotes=total;
  }
}
function partyColor(name){ let h=5381; for (let i=0;i<name.length;i++) h=((h<<5)+h)+name.charCodeAt(i); const hue=(Math.abs(h)%360+137.508)%360; return `hsl(${hue.toFixed(0)},65%,55%)`; }
function winnerForRow(row, parties){ let best=null,bv=-Infinity; for (const p of parties){ const s=row._party?.[p]?.share ?? -Infinity; if (s>bv){bv=s;best=p;} } return best?{party:best,share:bv}:null; }
function percentIdx(v,steps=6){ if(v==null) return -1; const t=Math.max(0,Math.min(1,v/100)); return Math.floor(t*steps); }
function percentColor(i){ const c=['#deebf7','#c6dbef','#9ecae1','#6baed6','#3182bd','#08519c']; return i<0?'#bbb':c[Math.max(0,Math.min(c.length-1,i))]; }
