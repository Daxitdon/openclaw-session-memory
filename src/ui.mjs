// session-memory dashboard (served at GET /, /memory)
// Single-page, vanilla JS, SVG charts, no external deps. Dark + auto light.
export const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>session-memory · dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark light;--bg:#0b0d11;--panel:#13161c;--panel2:#181c24;--fg:#e6e8ec;--fg2:#aab0bb;--muted:#6c727d;--border:#232832;--accent:#5eb1ff;--accent2:#7dd3fc;--good:#4ade80;--warn:#facc15;--bad:#ff6b6b;--chip:#262b35;--mark:#ffd86b;--mark-fg:#1a1300;--radius:10px}
@media(prefers-color-scheme:light){:root{--bg:#f6f7fa;--panel:#ffffff;--panel2:#fafbfd;--fg:#1a1c22;--fg2:#3b4250;--muted:#6b7280;--border:#e4e7ee;--accent:#0a66c2;--accent2:#0284c7;--chip:#eef1f6;--mark:#fff3a6}}
*{box-sizing:border-box}body{margin:0;font:13.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.nav{display:flex;align-items:center;gap:14px;padding:10px 18px;border-bottom:1px solid var(--border);background:var(--panel);position:sticky;top:0;z-index:5}
.brand{font-weight:700;letter-spacing:.3px}.brand small{font-weight:400;color:var(--muted);margin-left:8px}
.tabs{display:flex;gap:4px;flex:1;flex-wrap:wrap}
.tab{background:transparent;color:var(--fg2);border:1px solid transparent;border-radius:7px;padding:6px 11px;cursor:pointer;font:inherit}
.tab:hover{background:var(--panel2)}.tab.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.statusbar{color:var(--muted);font-size:12px;font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
main{padding:16px 18px;max-width:1400px;margin:0 auto}
.grid{display:grid;gap:12px}
.cards{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
.card.kpi h4{margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600}
.card.kpi b{font-size:24px;display:block;margin-top:4px}.card.kpi .sub{color:var(--muted);font-size:11px;margin-top:2px}
.row2{grid-template-columns:repeat(auto-fit,minmax(360px,1fr))}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
.panel h3{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--fg);display:flex;align-items:center;justify-content:space-between}
.panel h3 .hint{color:var(--muted);font-weight:400;font-size:11px}
.chip{display:inline-flex;align-items:center;gap:4px;background:var(--chip);color:var(--fg);font-size:11px;padding:2px 7px;border-radius:999px;line-height:1.6}
.chip.good{background:rgba(74,222,128,.18);color:#34d399}.chip.warn{background:rgba(250,204,21,.18);color:#fde047}.chip.bad{background:rgba(255,107,107,.18);color:#fca5a5}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
tbody tr:hover{background:var(--panel2);cursor:pointer}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.muted{color:var(--muted)}.right{text-align:right}
input,select,button,textarea{background:var(--panel2);color:var(--fg);border:1px solid var(--border);border-radius:7px;padding:7px 10px;font:inherit}
button{cursor:pointer}.primary{background:var(--accent);border-color:var(--accent);color:#fff}.danger{background:transparent;color:var(--bad);border-color:var(--border)}.danger:hover{background:rgba(255,107,107,.1)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}.row .grow{flex:1 1 280px}
mark{background:var(--mark);color:var(--mark-fg);padding:0 2px;border-radius:2px}
.snippet{white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:var(--fg2)}
section{display:none}section.on{display:block}
.bar{height:8px;background:var(--chip);border-radius:4px;overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent)}
.kind-pill{font-size:10.5px;padding:1px 6px;border-radius:4px;background:var(--chip);color:var(--fg);text-transform:lowercase}
.kind-pill.decision,.kind-pill.preference,.kind-pill.rule{background:rgba(125,211,252,.2);color:var(--accent2)}
.kind-pill.fact,.kind-pill.architecture{background:rgba(94,177,255,.2);color:var(--accent)}
.kind-pill.lesson,.kind-pill.workflow{background:rgba(74,222,128,.18);color:var(--good)}
.kind-pill.bug,.kind-pill.incident{background:rgba(255,107,107,.18);color:var(--bad)}
.status-active{color:var(--good)}.status-archived{color:var(--muted)}.status-superseded{color:var(--warn)}
.drawer{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:50;padding:16px}
.drawer.on{display:flex}.drawer .box{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);max-width:900px;width:100%;max-height:90vh;overflow:auto;padding:16px}
.close{float:right;background:transparent;border:none;color:var(--muted);font-size:18px;cursor:pointer}
.toast{position:fixed;bottom:16px;right:16px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:12px;display:none}.toast.on{display:block}
svg.chart{width:100%;height:160px;display:block}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;font-size:11.5px;color:var(--muted)}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--accent);margin-right:5px;vertical-align:middle}
.search-card{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px}
.search-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:4px;align-items:center}
.scroll{max-height:340px;overflow:auto}
</style></head><body>
<div class="nav">
  <div class="brand">session-memory <small id="sb-uptime">·</small></div>
  <div class="tabs">
    <button class="tab on" data-tab="overview">Overview</button>
    <button class="tab" data-tab="sessions">Sessions</button>
    <button class="tab" data-tab="bookmarks">Bookmarks</button>
    <button class="tab" data-tab="entities">Entities</button>
    <button class="tab" data-tab="relationships">Relationships</button>
    <button class="tab" data-tab="search">Search</button>
    <button class="tab" data-tab="context">Context</button>
  </div>
  <div class="statusbar" id="sb-status">loading…</div>
</div>
<main>
  <section id="overview" class="on">
    <div class="grid cards" id="kpis"></div>
    <div class="grid row2" style="margin-top:12px">
      <div class="panel">
        <h3>Messages per day <span class="hint" id="mpd-hint">last 30d</span></h3>
        <svg class="chart" id="chart-mpd"></svg>
      </div>
      <div class="panel">
        <h3>Bookmarks by kind <span class="hint" id="bbk-hint"></span></h3>
        <div id="bbk-bars"></div>
      </div>
    </div>
    <div class="grid row2" style="margin-top:12px">
      <div class="panel">
        <h3>Entities by type <span class="hint">top 12</span></h3>
        <div id="ebt-bars"></div>
      </div>
      <div class="panel">
        <h3>Relationships by type <span class="hint"></span></h3>
        <div id="rbt-bars"></div>
      </div>
    </div>
    <div class="grid row2" style="margin-top:12px">
      <div class="panel">
        <h3>Recent bookmarks <span class="hint">latest 15</span></h3>
        <div class="scroll"><table id="t-recent-bookmarks"><thead><tr><th>#</th><th>Kind</th><th>Title</th><th>Source</th><th class="right">Conf</th></tr></thead><tbody></tbody></table></div>
      </div>
      <div class="panel">
        <h3>Recent relationships <span class="hint">latest 15</span></h3>
        <div class="scroll"><table id="t-recent-rels"><thead><tr><th>#</th><th>From</th><th>Rel</th><th>To</th><th class="right">Conf</th></tr></thead><tbody></tbody></table></div>
      </div>
    </div>
    <div class="panel" style="margin-top:12px">
      <h3>System status <span class="hint" id="ss-hint"></span></h3>
      <div class="grid cards" id="ss-cards"></div>
    </div>
  </section>

  <section id="sessions">
    <div class="row">
      <input id="sess-q" class="grow" placeholder="filter sessions by key/topic">
      <button class="primary" id="sess-load">Refresh</button>
    </div>
    <div class="panel"><div class="scroll"><table id="t-sessions"><thead><tr><th>Key</th><th>Agent</th><th>Channel</th><th>Topic</th><th class="right">Msgs</th><th>First</th><th>Last</th></tr></thead><tbody></tbody></table></div></div>
  </section>

  <section id="bookmarks">
    <div class="row">
      <input id="bm-q" class="grow" placeholder="search bookmarks (FTS) or leave empty">
      <select id="bm-kind"><option value="">all kinds</option><option>decision</option><option>preference</option><option>fact</option><option>lesson</option><option>rule</option><option>architecture</option><option>workflow</option><option>bug</option><option>incident</option><option>note</option></select>
      <select id="bm-source"><option value="">all sources</option><option>session</option><option>agentmemory_import</option><option>unsourced</option></select>
      <select id="bm-status"><option value="">all statuses</option><option>active</option><option>archived</option><option>superseded</option></select>
      <button class="primary" id="bm-load">Load</button>
    </div>
    <div class="panel"><div class="scroll"><table id="t-bookmarks"><thead><tr><th>#</th><th>Kind</th><th>Title</th><th>Source</th><th>Status</th><th class="right">Conf</th><th></th></tr></thead><tbody></tbody></table></div></div>
  </section>

  <section id="entities">
    <div class="row">
      <input id="e-q" class="grow" placeholder="entity name/type substring">
      <button class="primary" id="e-load">Load</button>
    </div>
    <div class="panel"><div class="scroll"><table id="t-entities"><thead><tr><th>#</th><th>Type</th><th>Name</th><th class="right">Mentions</th><th>Last seen</th></tr></thead><tbody></tbody></table></div></div>
  </section>

  <section id="relationships">
    <div class="row">
      <input id="r-q" class="grow" placeholder="rel type / entity substring">
      <button class="primary" id="r-load">Load</button>
    </div>
    <div class="panel"><div class="scroll"><table id="t-rels"><thead><tr><th>#</th><th>From</th><th>Rel</th><th>To</th><th>Source</th><th>Status</th><th class="right">Conf</th><th></th></tr></thead><tbody></tbody></table></div></div>
  </section>

  <section id="search">
    <form class="row" id="sf">
      <input id="s-q" class="grow" placeholder="raw FTS over session messages… (try: error OR timeout)" autofocus>
      <label class="muted">limit <input id="s-limit" type="number" value="20" min="1" max="200" style="width:70px"></label>
      <label class="muted"><input id="s-grouped" type="checkbox"> grouped</label>
      <button class="primary">Search</button>
    </form>
    <div id="s-results"></div>
  </section>

  <section id="context">
    <div class="row">
      <input id="c-q" class="grow" placeholder="prompt — what context would session-memory inject?">
      <button class="primary" id="c-load">Preview</button>
    </div>
    <div class="panel"><div id="c-out" class="snippet muted">enter a prompt to preview gated context injection.</div></div>
  </section>
</main>

<div class="drawer" id="drawer"><div class="box"><button class="close" id="drawer-close">×</button><div id="drawer-body"></div></div></div>
<div class="toast" id="toast"></div>

<script>
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function hl(s){return esc(s).replace(/\\[([^\\[\\]]+)\\]/g,'<mark>$1</mark>')}
function fmtTs(ms){if(!ms)return '—';try{return new Date(ms).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false,year:'2-digit',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'})}catch{return String(ms)}}
function fmtAgo(ms){if(!ms)return '—';const d=Date.now()-ms,m=Math.floor(d/60000);if(m<1)return 'just now';if(m<60)return m+'m ago';const h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago'}
function bytes(n){if(n==null)return '—';const u=['B','KB','MB','GB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(1)+' '+u[i]}
function num(n){return (n??0).toLocaleString()}
async function jget(u){const r=await fetch(u);const j=await r.json().catch(()=>({error:r.statusText}));if(!r.ok)throw new Error(j.error||r.statusText);return j}
async function jreq(u,m,b){const r=await fetch(u,{method:m,headers:b?{'content-type':'application/json'}:{},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j}
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('on');setTimeout(()=>el.classList.remove('on'),2200)}

$$('.tab').forEach(b=>b.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('on'));b.classList.add('on');$$('main>section').forEach(s=>s.classList.remove('on'));$('#'+b.dataset.tab).classList.add('on');const map={sessions:loadSessions,bookmarks:loadBookmarks,entities:loadEntities,relationships:loadRels};const fn=map[b.dataset.tab];if(fn)fn()});

function svgLine(svg,points,opts={}){const w=svg.clientWidth||600,h=160,pad=18;if(!points.length){svg.innerHTML='<text x="50%" y="50%" text-anchor="middle" fill="#6c727d" font-size="12">no data</text>';return}const xs=points.map(p=>p.x),ys=points.map(p=>p.y);const minY=0,maxY=Math.max(1,...ys);const sx=i=>pad+i*(w-pad*2)/Math.max(1,points.length-1);const sy=v=>h-pad-(v-minY)/(maxY-minY)*(h-pad*2);const d=points.map((p,i)=>(i?'L':'M')+sx(i).toFixed(1)+' '+sy(p.y).toFixed(1)).join(' ');const area=d+' L'+sx(points.length-1).toFixed(1)+' '+(h-pad)+' L'+sx(0).toFixed(1)+' '+(h-pad)+' Z';svg.innerHTML='<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#5eb1ff" stop-opacity=".35"/><stop offset="100%" stop-color="#5eb1ff" stop-opacity="0"/></linearGradient></defs>'+'<path d="'+area+'" fill="url(#g)"/>'+'<path d="'+d+'" fill="none" stroke="#5eb1ff" stroke-width="1.8"/>'+points.map((p,i)=>'<circle cx="'+sx(i).toFixed(1)+'" cy="'+sy(p.y).toFixed(1)+'" r="2" fill="#5eb1ff"><title>'+esc(p.label)+': '+p.y+'</title></circle>').join('')}

function bars(container,rows,key,label){const total=rows.reduce((a,b)=>a+b.n,0)||1;container.innerHTML=rows.map(r=>{const pct=(r.n/total*100).toFixed(1);return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>'+esc(r[key]||'(none)')+'</span><span class="muted">'+r.n+'</span></div><div class="bar"><i style="width:'+pct+'%"></i></div></div>'}).join('')||'<div class="muted">no data</div>'}

function evalChip(e){if(!e)return '<span class="chip bad">no data</span>';const ok=e.pass_rate_pct>=98;return '<span class="chip '+(ok?'good':'warn')+'">'+e.passed+'/'+e.total+' · '+(e.pass_rate_pct||0).toFixed(1)+'%</span>'+(e.mrr?'<span class="chip">MRR '+e.mrr.toFixed(3)+'</span>':'')+'<span class="chip">p95 '+(e.latency_p95_ms||0).toFixed(0)+'ms</span>'}
function diagChip(d){if(!d)return '<span class="chip bad">no data</span>';const c=d.critical||d.criticals||0,w=d.warnings||0;if(c)return '<span class="chip bad">critical '+c+'</span>';if(w)return '<span class="chip warn">warnings '+w+'</span>';return '<span class="chip good">ok</span>'}

async function loadStats(){
  const s=await jget('/stats');
  $('#sb-uptime').textContent='uptime '+s.uptime_s+'s';
  $('#sb-status').innerHTML=num(s.counts.messages)+' msgs · '+num(s.counts.sessions)+' sessions · '+bytes(s.db_size_bytes);
  const c=s.counts;
  const kpis=[
    {h:'Messages',b:num(c.messages),sub:num(s.messages_per_day.reduce((a,b)=>a+b.n,0))+' last 30d'},
    {h:'Sessions',b:num(c.sessions),sub:'top last '+fmtAgo(s.sessions_top[0]?.last_at)},
    {h:'Bookmarks',b:num(c.bookmarks),sub:num(c.bookmarks_active)+' active · '+num(c.bookmarks_unsourced)+' unsourced'},
    {h:'Entities',b:num(c.entities),sub:num(c.mentions)+' mentions'},
    {h:'Relationships',b:num(c.relationships),sub:num(c.relationships_active)+' active'},
    {h:'DB Size',b:bytes(s.db_size_bytes),sub:'WAL · FTS5'},
  ];
  $('#kpis').innerHTML=kpis.map(k=>'<div class="card kpi"><h4>'+k.h+'</h4><b>'+k.b+'</b><div class="sub">'+k.sub+'</div></div>').join('');
  // chart
  const pts=s.messages_per_day.map(d=>({x:d.day,y:d.n,label:d.day}));
  svgLine($('#chart-mpd'),pts);
  $('#mpd-hint').textContent=pts.length+' days';
  // bars
  bars($('#bbk-bars'),s.bookmarks_by_kind,'kind');
  bars($('#ebt-bars'),s.entities_by_type,'type');
  bars($('#rbt-bars'),s.rels_by_type,'rel_type');
  $('#bbk-hint').textContent=num(c.bookmarks)+' total';
  // recent bookmarks
  $('#t-recent-bookmarks tbody').innerHTML=s.recent_bookmarks.map(b=>'<tr data-bm="'+b.id+'"><td class="muted">#'+b.id+'</td><td><span class="kind-pill '+esc(b.kind)+'">'+esc(b.kind)+'</span></td><td>'+esc(b.title)+'<div class="muted" style="font-size:11px">'+fmtAgo(b.created_at)+'</div></td><td class="mono muted">'+esc(b.source_type||'')+'</td><td class="right">'+(b.confidence??0).toFixed(2)+'</td></tr>').join('');
  $('#t-recent-rels tbody').innerHTML=s.recent_relationships.map(r=>'<tr><td class="muted">#'+r.id+'</td><td>'+esc(r.from_name)+'</td><td class="chip">'+esc(r.rel_type)+'</td><td>'+esc(r.to_name)+'</td><td class="right">'+(r.confidence??0).toFixed(2)+'</td></tr>').join('');
  // status
  const ssCards=[
    {h:'Search eval',b:evalChip(s.eval_search)},
    {h:'Context eval',b:evalChip(s.eval_context)},
    {h:'Diagnose',b:diagChip(s.diagnose)},
    {h:'Last backup',b:s.last_backup?'<span class="chip good">'+fmtAgo(s.last_backup.ts)+'</span><div class="muted mono" style="font-size:10.5px;margin-top:4px">'+esc(s.last_backup.file)+'</div>':'<span class="chip bad">none</span>'},
  ];
  $('#ss-cards').innerHTML=ssCards.map(c=>'<div class="card"><h4 style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">'+c.h+'</h4><div style="margin-top:8px">'+c.b+'</div></div>').join('');
  $('#ss-hint').textContent='auto-refresh 15s';
  // wire bookmark drilldown
  $$('#t-recent-bookmarks tbody tr').forEach(tr=>tr.onclick=()=>showBookmark(tr.dataset.bm));
}

async function loadSessions(){
  const s=await jget('/stats');const q=$('#sess-q').value.toLowerCase();
  const rows=s.sessions_top.filter(r=>!q||(r.session_key||'').toLowerCase().includes(q)||String(r.topic_id||'').includes(q));
  $('#t-sessions tbody').innerHTML=rows.map(r=>'<tr data-sk="'+esc(r.session_key)+'"><td class="mono">'+esc((r.session_key||'').slice(0,46))+'</td><td>'+esc(r.agent_id||'')+'</td><td>'+esc(r.channel||'')+'</td><td>'+esc(r.topic_id||'')+'</td><td class="right">'+num(r.msg_count)+'</td><td class="muted">'+fmtAgo(r.first_at)+'</td><td class="muted">'+fmtAgo(r.last_at)+'</td></tr>').join('');
  $$('#t-sessions tbody tr').forEach(tr=>tr.onclick=()=>showSession(tr.dataset.sk));
}
$('#sess-load').onclick=loadSessions;$('#sess-q').oninput=()=>{clearTimeout(window.__sst);window.__sst=setTimeout(loadSessions,200)};

async function loadBookmarks(){
  const p=new URLSearchParams({limit:'200'});const q=$('#bm-q').value;if(q)p.set('q',q);if($('#bm-kind').value)p.set('kind',$('#bm-kind').value);if($('#bm-source').value)p.set('source_type',$('#bm-source').value);
  const rows=await jget('/bookmarks?'+p);const wanted=$('#bm-status').value;const filtered=wanted?rows.filter(r=>r.status===wanted):rows;
  $('#t-bookmarks tbody').innerHTML=filtered.map(b=>'<tr data-bm="'+b.id+'"><td class="muted">#'+b.id+'</td><td><span class="kind-pill '+esc(b.kind)+'">'+esc(b.kind)+'</span></td><td>'+esc(b.title)+'<div class="muted" style="font-size:11px">'+esc((b.summary||'').slice(0,120))+'</div></td><td class="mono muted">'+esc(b.source_type||'')+'</td><td class="status-'+esc(b.status||'active')+'">'+esc(b.status||'active')+'</td><td class="right">'+(b.confidence??0).toFixed(2)+'</td><td><button class="danger" data-del="'+b.id+'">✕</button></td></tr>').join('');
  $$('#t-bookmarks tbody tr').forEach(tr=>tr.onclick=e=>{if(e.target.dataset.del){e.stopPropagation();delBookmark(e.target.dataset.del);return}showBookmark(tr.dataset.bm)});
}
$('#bm-load').onclick=loadBookmarks;$('#bm-q').onkeydown=e=>{if(e.key==='Enter')loadBookmarks()};
async function delBookmark(id){if(!confirm('Delete bookmark #'+id+'?'))return;await jreq('/bookmarks?id='+id,'DELETE');toast('deleted #'+id);loadBookmarks();loadStats()}

async function loadEntities(){
  const p=new URLSearchParams({limit:'200'});if($('#e-q').value)p.set('q',$('#e-q').value);
  const rows=await jget('/entities?'+p);
  $('#t-entities tbody').innerHTML=rows.map(e=>'<tr><td class="muted">#'+e.id+'</td><td class="chip">'+esc(e.type)+'</td><td>'+esc(e.name)+'<div class="mono muted" style="font-size:11px">'+esc(e.normalized||'')+'</div></td><td class="right">'+num(e.mention_count)+'</td><td class="muted">'+fmtAgo(e.last_seen)+'</td></tr>').join('');
}
$('#e-load').onclick=loadEntities;$('#e-q').onkeydown=e=>{if(e.key==='Enter')loadEntities()};

async function loadRels(){
  const p=new URLSearchParams({limit:'200'});if($('#r-q').value)p.set('q',$('#r-q').value);
  const rows=await jget('/relationships?'+p);
  $('#t-rels tbody').innerHTML=rows.map(r=>'<tr><td class="muted">#'+r.id+'</td><td>'+esc(r.from_name)+'<div class="muted" style="font-size:11px">'+esc(r.from_type||'')+'</div></td><td class="chip">'+esc(r.rel_type)+'</td><td>'+esc(r.to_name)+'<div class="muted" style="font-size:11px">'+esc(r.to_type||'')+'</div></td><td class="mono muted">'+esc(r.source_type||'')+'</td><td class="status-'+esc(r.status||'active')+'">'+esc(r.status||'active')+'</td><td class="right">'+(r.confidence??0).toFixed(2)+'</td><td><button class="danger" data-del="'+r.id+'">✕</button></td></tr>').join('');
  $$('#t-rels tbody button[data-del]').forEach(b=>b.onclick=()=>delRel(b.dataset.del));
}
$('#r-load').onclick=loadRels;$('#r-q').onkeydown=e=>{if(e.key==='Enter')loadRels()};
async function delRel(id){if(!confirm('Delete relationship #'+id+'?'))return;await jreq('/relationships?id='+id,'DELETE');toast('deleted rel #'+id);loadRels();loadStats()}

$('#sf').onsubmit=async e=>{e.preventDefault();const p=new URLSearchParams({q:$('#s-q').value,limit:$('#s-limit').value});if($('#s-grouped').checked)p.set('grouped','1');const out=$('#s-results');out.innerHTML='<div class="muted">searching…</div>';try{const rows=await jget('/search?'+p);out.innerHTML=rows.length?rows.map(r=>{const h=r.best_hit||r;return '<div class="search-card"><div class="search-meta"><span class="chip">'+esc(h.role||'group')+'</span><span class="mono">'+esc((h.session_key||'').slice(0,46))+'</span><span>'+fmtTs(h.ts||r.start_ts)+'</span><span>L'+esc(h.line_no||'')+'</span><span class="muted">'+fmtAgo(h.ts||r.start_ts)+'</span></div><div class="snippet">'+hl(h.snippet||'')+'</div></div>'}).join(''):'<div class="muted">no hits</div>'}catch(err){out.innerHTML='<div class="muted">'+esc(err.message)+'</div>'}};

$('#c-load').onclick=async()=>{const out=$('#c-out');out.textContent='loading…';try{const c=await jget('/context?'+new URLSearchParams({q:$('#c-q').value}));out.innerHTML=c.injected?'<div><span class="chip good">inject</span> <span class="muted">'+esc(c.item_count||0)+' items · '+esc(c.reason||'')+'</span></div><pre style="white-space:pre-wrap;margin-top:10px">'+esc(c.prependContext||'')+'</pre>':'<div><span class="chip warn">no inject</span> <span class="muted">'+esc(c.reason||'')+'</span></div>'}catch(err){out.textContent=err.message}};

async function showBookmark(id){const rows=await jget('/bookmarks?limit=1000');const b=rows.find(x=>String(x.id)===String(id));if(!b)return;openDrawer('<h3>Bookmark #'+b.id+' <span class="kind-pill '+esc(b.kind)+'">'+esc(b.kind)+'</span></h3><div class="muted" style="margin-bottom:8px">'+esc(b.source_type||'')+' · conf '+(b.confidence??0).toFixed(2)+' · '+esc(b.status||'')+' · '+fmtTs(b.created_at)+'</div><h2 style="margin:0 0 6px">'+esc(b.title)+'</h2><div class="snippet">'+esc(b.summary)+'</div>'+(b.session_key?'<div class="mono muted" style="margin-top:10px;font-size:11.5px">session: '+esc(b.session_key)+(b.ts?' · ts '+fmtTs(b.ts):'')+(b.line_no?' · L'+b.line_no:'')+'</div>'+(b.session_key&&b.ts?'<button class="primary" style="margin-top:8px" id="d-recall">Recall around ts</button>':''):'')+(b.tags?'<div style="margin-top:8px">'+b.tags.split(',').map(t=>'<span class="chip">'+esc(t.trim())+'</span>').join(' ')+'</div>':''));if(b.session_key&&b.ts){$('#d-recall').onclick=async()=>{const msgs=await jget('/recall?'+new URLSearchParams({session_key:b.session_key,around_ts:b.ts,window:5}));$('#drawer-body').innerHTML+='<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px"><h3 style="margin:0 0 8px">Recall ±5</h3>'+msgs.map(m=>'<div class="search-card"><div class="search-meta"><span class="chip">'+esc(m.role)+'</span><span>'+fmtTs(m.ts)+'</span><span>L'+esc(m.line_no)+'</span></div><div class="snippet">'+esc((m.content||'').slice(0,1200))+'</div></div>').join('')+'</div>'}}}
async function showSession(sk){const rows=await jget('/search?'+new URLSearchParams({q:'*',session_key:sk,limit:'30'}));openDrawer('<h3>Session <span class="mono">'+esc(sk)+'</span></h3>'+rows.map(r=>'<div class="search-card"><div class="search-meta"><span class="chip">'+esc(r.role||'')+'</span><span>'+fmtTs(r.ts)+'</span><span>L'+esc(r.line_no)+'</span></div><div class="snippet">'+hl(r.snippet||'')+'</div></div>').join('')||'<div class="muted">no messages</div>')}

function openDrawer(html){$('#drawer-body').innerHTML=html;$('#drawer').classList.add('on')}
$('#drawer-close').onclick=()=>$('#drawer').classList.remove('on');$('#drawer').onclick=e=>{if(e.target.id==='drawer')$('#drawer').classList.remove('on')};

loadStats().catch(e=>{$('#sb-status').innerHTML='<span class="chip bad">'+esc(e.message)+'</span>'});
setInterval(()=>{if($('#overview').classList.contains('on'))loadStats().catch(()=>{})},15000);
</script></body></html>`;
