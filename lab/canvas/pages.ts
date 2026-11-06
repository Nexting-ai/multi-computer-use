/**
 * Pages of the shared canvas: the client page a cursor works in, and the view
 * page (live, or replay of one or more recorded runs side by side).
 *
 * Client geometry (CSS px, viewport 1180 x 660), also given to the agents:
 *   tools:   Pixel (60, 72), Rectangle (160, 72)
 *   colours: swatch k at (262 + 40k, 72), k = 0..11
 *   cell (col, row) centre: (26 + 12 col, 110 + 12 row), 64 x 40 cells
 */
import { PALETTE, COLS, ROWS, target } from "./target.js";

export const VIEWPORT = { width: 1180, height: 660 };
export const geometry = {
  tool: { pixel: [60, 72], rect: [160, 72] } as Record<
    string,
    [number, number]
  >,
  swatch: (k: number): [number, number] => [262 + 40 * k, 72],
  cell: (c: number, r: number): [number, number] => [26 + 12 * c, 110 + 12 * r],
};

export function clientPage(n: number, color: string) {
  const goal = target();
  return `<!doctype html><html><head><meta charset="utf-8"><title>Shared canvas · cursor ${n}</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;background:#eef1f7;color:#1d2433;overflow:hidden}
header{height:44px;display:flex;align-items:center;gap:10px;padding:0 20px;background:#16203a;color:#fff}
header .tag{margin-left:auto;padding:3px 10px;border-radius:12px;font-weight:600;color:#0b1020}
.tool{position:absolute;top:56px;width:90px;height:32px;border:1.5px solid #c9d1e3;border-radius:8px;background:#fff;font-size:13px}
.tool.sel{border-color:#16203a;background:#16203a;color:#fff}
.sw{position:absolute;top:56px;width:32px;height:32px;border-radius:8px;border:1.5px solid #c9d1e3}
.sw.sel{outline:3px solid #16203a;outline-offset:2px}
.sw b{position:absolute;bottom:-17px;left:0;right:0;text-align:center;font-size:11px;color:#59627a}
canvas{position:absolute}
#board{left:20px;top:104px;box-shadow:0 2px 10px rgba(20,30,60,.12)}
#ref{left:812px;top:124px;border:1px solid #c9d1e3}
.lbl{position:absolute;left:812px;top:102px;font-size:12px;color:#59627a}
#overlay{left:0;top:0;pointer-events:none}
</style></head><body>
<header><b>Shared canvas</b><span style="opacity:.7">one picture, many cursors</span><span class="tag" style="background:${color}">Cursor ${n}</span></header>
<button class="tool" id="t-pixel" style="left:15px">Pixel</button>
<button class="tool" id="t-rect" style="left:115px">Rectangle</button>
${PALETTE.map(([name, hex, letter], k) => `<div class="sw" id="s${k}" title="${name}" style="left:${246 + 40 * k}px;background:${hex}"><b>${letter}</b></div>`).join("")}
<canvas id="board" width="${COLS * 12}" height="${ROWS * 12}"></canvas>
<div class="lbl">Reference</div>
<canvas id="ref" width="${COLS * 5}" height="${ROWS * 5}"></canvas>
<canvas id="overlay" width="1180" height="660"></canvas>
<script>
const N=${n},COLS=${COLS},ROWS=${ROWS},PAL=${JSON.stringify(PALETTE.map((p) => p[1]))},GOAL=${JSON.stringify(goal)};
let grid=Array(COLS*ROWS).fill(0),cur={},colors=[];
const b=document.getElementById('board').getContext('2d'),o=document.getElementById('overlay').getContext('2d');
const rf=document.getElementById('ref').getContext('2d');
GOAL.forEach((v,i)=>{rf.fillStyle=PAL[v];rf.fillRect((i%COLS)*5,Math.floor(i/COLS)*5,5,5)});
function cell(c,r){b.fillStyle=PAL[grid[r*COLS+c]];b.fillRect(c*12,r*12,12,12);b.strokeStyle='rgba(20,30,60,.07)';b.strokeRect(c*12+.5,r*12+.5,11,11)}
function all(){for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++)cell(c,r)}
function marks(){o.clearRect(0,0,1180,660);for(const c of Object.values(cur)){if(!c.x&&!c.y)continue;const col=colors[(c.n-1)%colors.length];
  if(c.corner){o.strokeStyle=col;o.lineWidth=2;o.strokeRect(20+c.corner[0]*12,104+c.corner[1]*12,12,12)}
  o.save();o.translate(c.x,c.y);o.fillStyle=col;o.strokeStyle='#0b1020';o.lineWidth=1;o.beginPath();o.moveTo(0,0);o.lineTo(0,15);o.lineTo(4,11);o.lineTo(8,18);o.lineTo(10,17);o.lineTo(6,10);o.lineTo(11,10);o.closePath();o.fill();o.stroke();
  o.font='bold 10px sans-serif';o.fillText('C'+c.n,12,4);o.restore();}}
function sel(){const c=cur[N];if(!c)return;document.getElementById('t-pixel').classList.toggle('sel',c.tool==='pixel');document.getElementById('t-rect').classList.toggle('sel',c.tool==='rect');PAL.forEach((_,k)=>document.getElementById('s'+k).classList.toggle('sel',k===c.color))}
const es=new EventSource('/events');
es.onmessage=m=>{const e=JSON.parse(m.data);
  if(e.type==='snapshot'){grid=e.grid;colors=e.colors;e.cursors.forEach(c=>cur[c.n]=c);all();}
  else if(e.type==='paint'){grid[e.row*COLS+e.col]=e.color;cell(e.col,e.row)}
  else if(e.type==='rect'){for(let r=e.r0;r<=e.r1;r++)for(let c=e.c0;c<=e.c1;c++){grid[r*COLS+c]=e.color;cell(c,r)}cur[e.cursor].corner=null}
  else if(e.type==='move'){cur[e.cursor].x=e.x;cur[e.cursor].y=e.y}
  else if(e.type==='tool'){cur[e.cursor].tool=e.tool;cur[e.cursor].corner=null}
  else if(e.type==='color'){cur[e.cursor].color=e.color}
  else if(e.type==='corner'){cur[e.cursor].corner=[e.col,e.row]}
  marks();sel();};
// window.__busy counts changes the application is still applying.
window.__busy=0;const post=async v=>{window.__busy++;try{await fetch('/op',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cursor:N,...v})})}finally{window.__busy--}};
document.addEventListener('pointerdown',async ev=>{const x=ev.clientX,y=ev.clientY;await post({type:'move',x,y});
  const t=ev.target;
  if(t.id==='t-pixel')return post({type:'tool',tool:'pixel'});
  if(t.id==='t-rect')return post({type:'tool',tool:'rect'});
  const s=t.closest&&t.closest('.sw');if(s)return post({type:'color',color:Number(s.id.slice(1))});
  if(x>=20&&x<20+COLS*12&&y>=104&&y<104+ROWS*12)return post({type:'cell',col:Math.floor((x-20)/12),row:Math.floor((y-104)/12)});
});
</script></body></html>`;
}

/** Live view (one run) or replay (one or more logs side by side, in sync). */
export function viewPage(replay: boolean) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>多光标画布</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0b0f19;color:#e6e9f2;font:14px -apple-system,"PingFang SC","Segoe UI",sans-serif}
#top{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid #1d2436}
#top h1{font-size:17px;margin:0;font-weight:650}#top .sp{flex:1}
#ctl button{background:#1a2133;color:#e6e9f2;border:1px solid #2a3350;border-radius:8px;padding:6px 12px;margin-left:6px;cursor:pointer}
#ctl input{width:260px;vertical-align:middle}
#clock{font:600 13px ui-monospace,Menlo,monospace;color:#9aa4bd;min-width:70px;text-align:right}
#panels{display:flex;gap:18px;padding:18px 22px;justify-content:center;align-items:flex-start}
.panel{background:#121827;border:1px solid #1f2740;border-radius:16px;padding:16px}
.panel h2{margin:0 0 4px;font-size:18px}.panel .sub{color:#8d97b0;font-size:12.5px;margin-bottom:10px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.stat{background:#0e1422;border:1px solid #1f2740;border-radius:10px;padding:7px 10px}.stat i{display:block;font-style:normal;font-size:11px;color:#7f89a3}.stat b{font:650 19px ui-monospace,Menlo,monospace}
.stage{position:relative}.stage canvas{display:block;border-radius:8px}
.bar{height:6px;border-radius:3px;background:#1d2436;margin-top:10px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,#22d3ee,#a78bfa);width:0}
.legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;font-size:11.5px;color:#aab3c8}.legend span{display:inline-flex;align-items:center;gap:5px;background:#0e1422;border-radius:10px;padding:2px 8px}.legend em{width:9px;height:9px;border-radius:50%;display:inline-block}
.done{color:#4ade80}
</style></head><body>
<div id="top"><h1>多光标画布 · 同一张图，多只手</h1><span class="sp"></span><div id="ctl"></div><div id="clock">0:00</div></div>
<div id="panels"></div>
<script>
const REPLAY=${replay};
const q=new URLSearchParams(location.search);
const COLORS=["#22d3ee","#f472b6","#a3e635","#fb923c","#a78bfa","#34d399","#f87171","#60a5fa","#e879f9","#4ade80","#fbbf24","#2dd4bf"];
function fmt(ms){const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function tok(n){return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?Math.round(n/1e3)+'k':String(n||0)}
class Panel{
  constructor(start,scale){this.s=start;this.scale=scale;this.cols=start.cols;this.rows=start.rows;this.pal=start.palette;this.goal=start.goal;
    this.grid=Array(this.cols*this.rows).fill(0);this.cur={};this.meta={};this.ended=null;
    const el=document.createElement('div');el.className='panel';const W=this.cols*scale,H=this.rows*scale;
    el.innerHTML='<h2></h2><div class="sub"></div><div class="stats"><div class="stat"><i>还原度</i><b class="m">0%</b></div><div class="stat"><i>用时</i><b class="t">0:00</b></div><div class="stat"><i>决策次数</i><b class="d">0</b></div><div class="stat"><i>Token</i><b class="k">0</b></div></div><div class="stage"><canvas class="g" width="'+W+'" height="'+H+'"></canvas><canvas class="o" width="'+W+'" height="'+H+'" style="position:absolute;left:0;top:0"></canvas></div><div class="bar"><i></i></div><div class="legend"></div>';
    el.querySelector('h2').textContent=start.title;el.querySelector('.sub').textContent=start.subtitle||'';
    document.getElementById('panels').append(el);this.el=el;this.g=el.querySelector('.g').getContext('2d');this.o=el.querySelector('.o').getContext('2d');
    for(let n=1;n<=start.cursors;n++)this.cur[n]={n,x:0,y:0,tx:0,ty:0,corner:null,actor:'',flash:0};
    this.drawAll();this.legend();}
  cell(c,r){const s=this.scale;this.g.fillStyle=this.pal[this.grid[r*this.cols+c]];this.g.fillRect(c*s,r*s,s,s)}
  drawAll(){for(let r=0;r<this.rows;r++)for(let c=0;c<this.cols;c++)this.cell(c,r)}
  legend(){const L=this.el.querySelector('.legend');L.innerHTML='';const by={};for(const c of Object.values(this.cur)){const a=c.actor||'Agent';(by[a]=by[a]||[]).push(c.n)}
    for(const [a,ns] of Object.entries(by)){const sp=document.createElement('span');sp.innerHTML=ns.map(n=>'<em style="background:'+COLORS[(n-1)%12]+'"></em>').join('')+' ';sp.append(a+' · '+ns.length+' 个光标');L.append(sp)}}
  apply(e){const C=this.cols;
    if(e.type==='paint'){this.grid[e.row*C+e.col]=e.color;this.cell(e.col,e.row);this.hit(e.cursor)}
    else if(e.type==='rect'){for(let r=e.r0;r<=e.r1;r++)for(let c=e.c0;c<=e.c1;c++){this.grid[r*C+c]=e.color;this.cell(c,r)}this.cur[e.cursor].corner=null;this.hit(e.cursor)}
    else if(e.type==='move'){const c=this.cur[e.cursor];const p=this.toStage(e.x,e.y);c.tx=p[0];c.ty=p[1];if(!c.x&&!c.y){c.x=p[0];c.y=p[1]}}
    else if(e.type==='corner'){this.cur[e.cursor].corner=[e.col,e.row]}
    else if(e.type==='tool'){this.cur[e.cursor].corner=null}
    else if(e.type==='actor'){this.cur[e.cursor].actor=e.actor;this.legend()}
    else if(e.type==='meta'){Object.assign(this.meta,e)}
    else if(e.type==='end'){this.ended=e.t;this.el.querySelector('.t').classList.add('done')}}
  hit(n){this.cur[n].flash=1}
  toStage(x,y){const s=this.scale/12;return[(x-20)*s,(y-104)*s]}
  stats(t){let same=0;for(let i=0;i<this.grid.length;i++)if(this.grid[i]===this.goal[i])same++;const m=same/this.grid.length;
    this.el.querySelector('.m').textContent=(m*100).toFixed(1)+'%';this.el.querySelector('.bar i').style.width=(m*100)+'%';
    this.el.querySelector('.t').textContent=fmt(this.ended??t);this.el.querySelector('.d').textContent=this.meta.decisions||0;this.el.querySelector('.k').textContent=tok(this.meta.tokens)}
  frame(){const o=this.o,s=this.scale;o.clearRect(0,0,o.canvas.width,o.canvas.height);
    for(const c of Object.values(this.cur)){if(!c.tx&&!c.ty)continue;c.x+=(c.tx-c.x)*.35;c.y+=(c.ty-c.y)*.35;const col=COLORS[(c.n-1)%12];
      if(c.corner){o.strokeStyle=col;o.lineWidth=2;o.setLineDash([3,2]);o.strokeRect(c.corner[0]*s,c.corner[1]*s,s,s);o.setLineDash([])}
      if(c.flash>0){o.beginPath();o.arc(c.x,c.y,6+14*(1-c.flash),0,7);o.strokeStyle=col;o.globalAlpha=c.flash;o.lineWidth=2;o.stroke();o.globalAlpha=1;c.flash-=.08}
      o.save();o.translate(c.x,c.y);o.fillStyle=col;o.strokeStyle='#0b1020';o.lineWidth=1.2;o.beginPath();o.moveTo(0,0);o.lineTo(0,17);o.lineTo(4.5,12.5);o.lineTo(9,20);o.lineTo(11.5,19);o.lineTo(7,11.5);o.lineTo(13,11.5);o.closePath();o.fill();o.stroke();
      o.font='bold 11px sans-serif';o.fillStyle=col;o.fillText(String(c.n),13,6);o.restore();}}
}
const panels=[];
function loop(t){for(const p of panels){p.stats(t);p.frame()}}
if(!REPLAY){
  let p=null,t0=0;const es=new EventSource('/events');
  es.onmessage=m=>{const e=JSON.parse(m.data);if(e.type==='snapshot'){if(!p){p=new Panel({...e,cursors:e.cursors.length,subtitle:''},14);panels.push(p);t0=performance.now()-e.t}p.grid=e.grid;p.drawAll();e.cursors.forEach(c=>{Object.assign(p.cur[c.n],{corner:c.corner,actor:c.actor});const s=p.toStage(c.x,c.y);if(c.x||c.y){p.cur[c.n].tx=p.cur[c.n].x=s[0];p.cur[c.n].ty=p.cur[c.n].y=s[1]}});p.legend()}else if(p)p.apply(e)};
  (function tick(){loop(performance.now()-t0);requestAnimationFrame(tick)})();
}else{
  const logs=q.getAll('log');let speed=Number(q.get('speed')||4),playing=true,t=0,last=performance.now(),runs=[];
  const ctl=document.getElementById('ctl');ctl.innerHTML='<button id=pp>暂停</button><button data-s=1>1×</button><button data-s=4>4×</button><button data-s=16>16×</button><input id=sk type=range min=0 max=1000 value=0>';
  Promise.all(logs.map(l=>fetch('/log?path='+encodeURIComponent(l)).then(r=>r.text()))).then(texts=>{
    const scale=logs.length>=3?7:logs.length===2?10:14;
    runs=texts.map(x=>{const ev=x.trim().split('\\n').map(l=>JSON.parse(l));const st=ev[0];const p=new Panel(st,scale);panels.push(p);return{p,ev,i:1,end:ev[ev.length-1].t}});
    const total=Math.max(...runs.map(r=>r.end));
    document.getElementById('pp').onclick=e=>{playing=!playing;e.target.textContent=playing?'暂停':'播放'};
    ctl.querySelectorAll('[data-s]').forEach(b=>b.onclick=()=>speed=Number(b.dataset.s));
    const sk=document.getElementById('sk');sk.oninput=()=>seek(total*sk.value/1000);
    function seek(to){t=to;for(const r of runs){const st=r.ev[0];const np=new Panel(st,scale);r.p.el.replaceWith(np.el);panels[panels.indexOf(r.p)]=np;r.p=np;r.i=1;step(r)}}
    function step(r){while(r.i<r.ev.length&&r.ev[r.i].t<=t){r.p.apply(r.ev[r.i]);r.i++}}
    window.__replay={total,seek:x=>seek(x),setSpeed:s=>speed=s,pause:()=>playing=false,get t(){return t},advance:x=>{playing=false;t=x;for(const r of runs)step(r);loop(t);document.getElementById('clock').textContent=fmt(t)}};
    (function tick(now){const dt=now-last;last=now;if(playing){t=Math.min(total,t+dt*speed);sk.value=Math.round(1000*t/total)}for(const r of runs)step(r);loop(t);document.getElementById('clock').textContent=fmt(t);requestAnimationFrame(tick)})(performance.now());
  });
}
</script></body></html>`;
}
