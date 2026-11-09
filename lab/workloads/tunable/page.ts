/**
 * The wizard page for one surface: twelve pages (plus two cost-center pages
 * where the surface needs them), a review page and Submit. Everything that
 * differs between surfaces comes from the scenario; nothing here is random.
 */
import { CHOICES, PAGES, type Lang, type Surface } from "./scenario.js";

const T: Record<Lang, Record<string, string>> = {
  en: {},
  fr: {
    Requester: "Demandeur",
    Department: "Service",
    Vendor: "Fournisseur",
    Currency: "Devise",
    "First item": "Premier article",
    "First item quantity": "Quantité du premier article",
    "Second item": "Deuxième article",
    "Second item quantity": "Quantité du deuxième article",
    Delivery: "Livraison",
    "Payment terms": "Conditions de paiement",
    Reference: "Référence",
    "Approval route": "Circuit d'approbation",
    Next: "Suivant",
    Step: "Étape",
  },
  de: {
    Requester: "Antragsteller",
    Department: "Abteilung",
    Vendor: "Lieferant",
    Currency: "Währung",
    "First item": "Erster Artikel",
    "First item quantity": "Menge erster Artikel",
    "Second item": "Zweiter Artikel",
    "Second item quantity": "Menge zweiter Artikel",
    Delivery: "Lieferung",
    "Payment terms": "Zahlungsbedingungen",
    Reference: "Referenz",
    "Approval route": "Genehmigungsweg",
    Next: "Weiter",
    Step: "Schritt",
  },
  es: {
    Requester: "Solicitante",
    Department: "Departamento",
    Vendor: "Proveedor",
    Currency: "Moneda",
    "First item": "Primer artículo",
    "First item quantity": "Cantidad del primer artículo",
    "Second item": "Segundo artículo",
    "Second item quantity": "Cantidad del segundo artículo",
    Delivery: "Entrega",
    "Payment terms": "Condiciones de pago",
    Reference: "Referencia",
    "Approval route": "Ruta de aprobación",
    Next: "Siguiente",
    Step: "Paso",
  },
};

const COMPANIES = [
  "Acme Robotics",
  "Bluefin Foods",
  "Cobalt Studio",
  "Delta Clinics",
  "Ember Energy",
  "Fjord Logistics",
  "Granite Bank",
  "Harbor Hotels",
  "Indigo Retail",
  "Juno Health",
  "Kite Media",
  "Lumen Labs",
];

export function companyName(id: string) {
  const n = Number(id.slice(1)) - 1;
  return `${COMPANIES[n % COMPANIES.length]}${n >= COMPANIES.length ? ` ${Math.floor(n / COMPANIES.length) + 1}` : ""}`;
}

export function html(s: Surface) {
  // Flatten into the page sequence the user walks through.
  const steps: unknown[] = [];
  for (const p of s.pages) {
    const def = PAGES.find((d) => d.key === p.key)!;
    const choice = CHOICES[p.key];
    const t = (x: string) => T[p.lang][x] ?? x;
    steps.push({
      key: p.key,
      label: t(def.label),
      next: t("Next"),
      kind: def.kind,
      options: choice?.options ?? null,
      fact:
        choice && p.fact !== null
          ? `${choice.fact}: ${choice.facts[p.fact]}`
          : null,
      prefill: p.prefill,
      layout: p.layout,
      notice: p.notice,
    });
    if (p.extra) {
      steps.push({
        key: "cost_center",
        label: "Cost center",
        next: "Next",
        kind: "text",
        options: null,
        fact: "This company requires a cost center for purchases.",
        prefill: null,
        layout: 0,
        notice: null,
      });
      steps.push({
        key: "cost_center_confirm",
        label: "Confirm cost center",
        next: "Next",
        kind: "choice",
        options: ["Confirmed", "Not needed"],
        fact: null,
        prefill: null,
        layout: 0,
        notice: null,
      });
    }
  }
  const data = JSON.stringify({ id: s.id, company: companyName(s.id), steps });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${companyName(s.id)} · Purchase request</title>
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.4 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;background:#f4f6fb;color:#1d2433}
header{height:56px;display:flex;align-items:center;gap:12px;padding:0 22px;background:#1f2a44;color:#fff}
header .logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#5b8cff,#8e5bff)}
header b{font-size:16px}header span{opacity:.7;font-size:13px}
.bar{display:flex;gap:4px;padding:14px 22px 0}.bar i{flex:1;height:6px;border-radius:3px;background:#dfe4ef}.bar i.done{background:#4f7cff}.bar i.now{background:#9db5ff}
.stepno{padding:8px 22px 0;font-size:12px;color:#6b7590}
main{position:relative;height:520px}
.card{position:absolute;width:520px;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(30,40,70,.10);padding:24px 26px}
.card h2{margin:0 0 6px;font-size:20px}.fact{display:inline-block;margin:6px 0 4px;padding:5px 10px;border-radius:8px;background:#fff4e0;color:#7a4b00;font-size:13px}
input{width:100%;margin-top:14px;padding:11px 12px;font-size:16px;border:1.5px solid #cfd6e6;border-radius:9px;outline:none}input:focus{border-color:#4f7cff}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.opts.v{grid-template-columns:1fr}
.opt{padding:11px 12px;border:1.5px solid #cfd6e6;border-radius:9px;background:#fff;font-size:15px;text-align:left;cursor:pointer}.opt.sel{border-color:#4f7cff;background:#eef3ff;font-weight:600}
.next{position:absolute;padding:11px 26px;border:0;border-radius:9px;background:#4f7cff;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.veil{position:fixed;inset:0;background:rgba(20,26,40,.5);display:flex;align-items:center;justify-content:center;z-index:9}
.veil div{background:#fff;padding:24px 28px;border-radius:12px;max-width:380px}.veil button{margin-top:14px;padding:9px 22px;border:0;border-radius:8px;background:#1f2a44;color:#fff;font-size:15px}
.review td{padding:3px 12px 3px 0;font-size:14px}.done{font-size:22px;color:#18794e}
</style></head><body>
<header><div class="logo"></div><b id="co"></b><span>Purchase request</span></header>
<div class="bar" id="bar"></div><div class="stepno" id="no"></div>
<main id="main"></main>
<script>
const D=${data};
document.getElementById('co').textContent=D.company;
const answers={};let i=0,seen=new Set();
// Card and Next positions per layout variant (0 is the reference layout).
const L=[[60,40,'r'],[260,40,'r'],[60,40,'l'],[160,120,'t'],[360,60,'l'],[60,150,'t']];
// Progress counts the twelve main pages only, so it looks the same on every
// surface; extra cost-center pages stay on their main page's position.
const MAIN=D.steps.map(s=>!s.key.startsWith('cost_center'));
function pos(){let n=0;for(let k=0;k<i&&k<D.steps.length;k++)if(MAIN[k])n++;return n;}
function bar(){const b=document.getElementById('bar');b.innerHTML='';const p=pos();for(let k=0;k<12;k++){const e=document.createElement('i');if(k<p)e.className='done';else if(k===p)e.className='now';b.append(e)}}
function render(){
  bar();const m=document.getElementById('main');m.innerHTML='';
  if(i>=D.steps.length)return review();
  const s=D.steps[i];document.getElementById('no').textContent=(MAIN[i]?pos()+1:pos())+' / 12';
  const [x,y,nx]=L[s.layout];const c=document.createElement('div');c.className='card';c.style.left=x+'px';c.style.top=y+'px';
  c.innerHTML='<h2></h2>'+(s.fact?'<div class="fact"></div>':'');c.querySelector('h2').textContent=s.label;if(s.fact)c.querySelector('.fact').textContent=s.fact;
  let get;
  if(s.kind==='text'){const inp=document.createElement('input');inp.value=answers[s.key]??s.prefill??'';c.append(inp);get=()=>inp.value.trim();}
  else{const o=document.createElement('div');o.className='opts'+(s.layout%2?' v':'');let sel=answers[s.key]??null;
    s.options.forEach(v=>{const b=document.createElement('button');b.className='opt'+(v===sel?' sel':'');b.textContent=v;b.onclick=()=>{sel=v;o.querySelectorAll('.opt').forEach(z=>z.classList.toggle('sel',z===b));};o.append(b)});c.append(o);get=()=>sel;}
  const n=document.createElement('button');n.className='next';n.textContent=s.next;
  const h=s.kind==='text'?150:(s.layout%2?290:190)+(s.fact?30:0)+(s.kind==='text'&&s.fact?30:0);
  if(nx==='r'){n.style.left=(x+520-140)+'px';n.style.top=(y+h+40)+'px';}else if(nx==='l'){n.style.left=x+'px';n.style.top=(y+h+40)+'px';}else{n.style.left=(x+540)+'px';n.style.top=y+'px';}
  n.onclick=()=>{const v=get();if(v===null||v==='')return;answers[s.key]=v;i++;render();};
  m.append(c,n);
  if(s.notice!==null&&!seen.has(i)){const at=i;seen.add(i);setTimeout(()=>{if(i!==at)return;const v=document.createElement('div');v.className='veil';v.innerHTML='<div><b>Notice</b><p>System maintenance tonight at 22:00. Please save your work.</p><button>OK</button></div>';v.querySelector('button').onclick=()=>v.remove();document.body.append(v);},s.notice);}
}
function review(){
  document.getElementById('no').textContent='Review';const m=document.getElementById('main');
  const c=document.createElement('div');c.className='card';c.style.left='60px';c.style.top='20px';
  c.innerHTML='<h2>Review and submit</h2><table class="review"></table>';const t=c.querySelector('table');
  Object.entries(answers).forEach(([k,v])=>{const r=t.insertRow();r.insertCell().textContent=k;r.insertCell().textContent=v;});
  const n=document.createElement('button');n.className='next';n.textContent='Submit';n.style.left='600px';n.style.top='20px';
  n.onclick=async()=>{n.disabled=true;await fetch('/save/'+D.id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(answers)});m.innerHTML='<div class="card" style="left:60px;top:40px"><div class="done">✓ Request submitted</div><p>'+(answers.reference||'')+'</p></div>';bar();document.getElementById('bar').querySelectorAll('i').forEach(e=>e.className='done');};
  m.append(c,n);
}
render();
</script></body></html>`;
}
