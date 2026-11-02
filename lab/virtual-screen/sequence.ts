import { createHash } from "node:crypto";
import type { Saved } from "./scene.js";
export type SequenceScene = {
  id: string;
  /** a: reference layout; b: different layout; c: reference layout behind a notice. */
  kind?: "a" | "b" | "c";
  /** K-variant layout index (variant "k<N>"); same task semantics. */
  layout?: number;
  variantSeed?: number;
  x: number;
  y: number;
  move: boolean;
  cases: { code: string; urgent: boolean }[];
};
export function sequenceScene(
  seed: number,
  index: number,
  mix: boolean | string = false,
): SequenceScene {
  // Variants: false/"uniform"; true/"mixed"; "k<N>" = N deterministic layouts.
  const kv = typeof mix === "string" ? /^k(\d{1,3})$/.exec(mix) : null;
  const K = kv ? Number(kv[1]) : 0;
  if (kv && (K < 1 || K > 100)) throw Error("invalid_k");
  const mixed = mix === true || mix === "mixed";
  const b = createHash("sha256").update(`layout/${seed}/${index}`).digest();
  // Kind uses a separate hash so codes/priorities (and grading) are unchanged.
  const k =
    createHash("sha256").update(`kind/${seed}/${index}`).digest()[0]! % 10;
  return {
    id: `W${String(index).padStart(2, "0")}`,
    ...(mixed ? { kind: k < 6 ? "a" : k < 9 ? "b" : "c" } : {}),
    // Layout index uses its own hash; codes, priorities and grading are unchanged.
    ...(K
      ? {
          // Balanced: every one of the K layouts occurs (N/K surfaces each).
          layout:
            (index -
              1 +
              createHash("sha256").update(`koffset/${seed}`).digest()[0]!) %
            K,
          variantSeed: seed,
        }
      : {}),
    x: 200 + (b[0]! % 240),
    y: 100 + (b[1]! % 90),
    move: index === 3,
    cases: Array.from({ length: 3 }, (_, r) => {
      const h = createHash("sha256")
        .update(`task/${seed}/${index}/${r}`)
        .digest("hex");
      return {
        code: `${h.slice(0, 6).toUpperCase()}-${index}-${r + 1}`,
        urgent: parseInt(h[7]!, 16) % 2 === 0,
      };
    }),
  };
}
export function gradeSequence(s: SequenceScene, records: Saved[]) {
  const own = records.filter((r) => r.id === s.id),
    valid = own.map(
      (r, i) =>
        r.round === i + 1 &&
        r.text === s.cases[i]?.code &&
        r.choice === (s.cases[i]?.urgent ? "Urgent" : "Standard"),
    );
  return {
    surface_id: s.id,
    success: own.length === s.cases.length && valid.every(Boolean),
    wrong: own.length > s.cases.length || valid.some((v) => !v),
    commits: own.length,
    correct_items: valid.filter(Boolean).length,
  };
}
export function nextSequence(s: SequenceScene, completed: number) {
  return {
    done: completed >= s.cases.length,
    round: completed + 1,
    code: s.cases[completed]?.code ?? "",
    urgent: s.cases[completed]?.urgent ?? false,
    x: s.x + (s.move && completed > 0 ? 45 : 0),
    y: s.y + (s.move && completed > 0 ? 30 : 0),
  };
}
export function sequenceHtml(s: SequenceScene) {
  if (s.layout !== undefined) return sequenceHtmlK(s);
  if (s.kind === "b") return sequenceHtmlB(s);
  const html = sequenceHtmlA(s);
  return s.kind === "c"
    ? html +
        `<div id="notice" style="position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9"><div style="position:absolute;left:${s.x + 60}px;top:${s.y + 90}px;width:420px;background:#fff;border-radius:10px;padding:24px;box-shadow:0 8px 30px #0006"><h3 style="margin:0 0 10px;font-size:21px">Session notice</h3><p style="margin:0 0 18px;font-size:16px">Your workspace was refreshed. Continue to resume dispatch.</p><button onclick="document.getElementById('notice').remove()" style="background:#165fc9;color:#fff;border:0">Continue</button></div></div>`
    : html;
}
function sequenceHtmlA(s: SequenceScene) {
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#edf1f6;font:18px Arial;color:#192b42}header{height:60px;background:#182d45;color:white;padding:18px 24px}aside{position:absolute;left:0;top:60px;width:165px;height:700px;padding:26px 16px;background:white;line-height:2.7}aside small{font-size:14px;color:#64748b}main{position:absolute;left:${s.x}px;top:${s.y}px;width:540px;height:440px;background:white;border:1px solid #aebccc;border-radius:8px;padding:20px}h2{margin:0;font-size:23px}#facts{position:absolute;top:62px;line-height:1.55}input{position:absolute;left:20px;top:160px;width:360px;height:42px;font:21px Arial;caret-color:transparent}button{padding:10px 20px;border:1px solid #73859a;border-radius:4px;font:20px Arial;background:white}.selected{color:white;background:#165fc9}.options{position:absolute;left:20px;top:228px}#save{position:absolute;left:20px;top:292px}#result{position:absolute;left:20px;top:355px;right:16px;font-size:17px}footer{position:absolute;top:690px;left:190px;color:#56667a;font-size:15px}.activity{position:absolute;right:24px;top:635px;color:#56667a;font-size:14px}</style>
<header>Operations / Dispatch workspace <span style="float:right">Window ${s.id}</span></header><aside>Workspace<br>Orders<br>Dispatch<br>Inventory<br>Reports<br>Team<br><small>Workspace status<br>All services online<br>Recent activity<br>Reports available</small></aside>
<main id="panel"><h2>Process item <span id="round">1</span> of 3</h2><div id="facts">Copy code: <b id="code">${s.cases[0]!.code}</b><br>Priority: <b id="priority">${s.cases[0]!.urgent ? "HIGH" : "NORMAL"}</b><br>Enter this item's code and choose service.</div><input id="value" autocomplete="off"><div class="options"><button onclick="choose(this,'Standard')">Standard</button> <button onclick="choose(this,'Urgent')">Urgent</button></div><button id="save" onclick="save()">Save item</button><div id="result">Last saved: —</div></main>
<div class="activity">Workspace activity · No pending exports</div><footer>Help center · Keyboard shortcuts · Workspace preferences</footer>
<script>let choice='',busy=false;function choose(el,c){choice=c;for(const b of document.querySelectorAll('.options button'))b.className='';el.className='selected'}
document.addEventListener('pointerdown',e=>fetch('/event/${s.id}',{method:'POST',body:JSON.stringify({kind:'pointer',x:e.clientX,y:e.clientY})}));document.getElementById('value').addEventListener('input',e=>fetch('/event/${s.id}',{method:'POST',body:JSON.stringify({kind:'text',text:e.target.value})}));
async function save(){if(busy)return;busy=true;try{const text=document.getElementById('value').value;if(!choice||!text)return;const response=await fetch('/save/${s.id}',{method:'POST',body:JSON.stringify({text,choice})});if(!response.ok)throw Error('save');const next=await response.json();document.getElementById('result').textContent='Last saved: '+text+' / '+choice;
if(next.done){document.querySelector('h2').textContent='All 3 items saved';document.getElementById('save').disabled=true}else{document.getElementById('round').textContent=next.round;document.getElementById('code').textContent=next.code;document.getElementById('priority').textContent=next.urgent?'HIGH':'NORMAL';document.getElementById('value').value='';choice='';for(const b of document.querySelectorAll('.options button'))b.className='';document.getElementById('panel').style.left=next.x+'px';document.getElementById('panel').style.top=next.y+'px';}}
catch{document.getElementById('result').textContent='Save uncertain; inspect before retry'}finally{busy=false}}</script>`;
}

/** A second, visually different layout with the same task semantics. */
function sequenceHtmlB(s: SequenceScene) {
  const x = 120 + (s.x % 160),
    y = 90 + (s.y % 70);
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#f6f3ee;font:17px Georgia,serif;color:#2b2118}header{height:52px;background:#7c2d12;color:#fff;padding:14px 24px;font:16px Arial}main{position:absolute;left:${x}px;top:${y}px;width:640px;height:400px;background:#fffdf8;border:2px solid #d6c7b0;padding:18px 22px}h2{margin:0;font:22px Georgia}#facts{position:absolute;left:22px;top:58px;line-height:1.7}input{position:absolute;left:22px;top:150px;width:300px;height:40px;font:20px Arial;caret-color:transparent;border:2px solid #b45309}button{padding:9px 18px;border:2px solid #92400e;border-radius:18px;font:18px Arial;background:#fff7ed}.selected{color:#fff;background:#b45309}.options{position:absolute;left:350px;top:150px}#save{position:absolute;left:22px;top:225px;border-radius:4px;background:#14532d;color:#fff;border-color:#14532d}#result{position:absolute;left:22px;top:300px;right:20px;font-size:16px}</style>
<header>Fulfilment console <span style="float:right">Station ${s.id}</span></header>
<main id="panel"><h2>Ticket <span id="round">1</span> / 3</h2><div id="facts">Priority: <b id="priority">${s.cases[0]!.urgent ? "HIGH" : "NORMAL"}</b><br>Copy code: <b id="code">${s.cases[0]!.code}</b></div><input id="value" autocomplete="off"><div class="options"><button onclick="choose(this,'Urgent')">Urgent</button> <button onclick="choose(this,'Standard')">Standard</button></div><button id="save" onclick="save()">Save item</button><div id="result">Last saved: —</div></main>
<script>let choice='',busy=false;function choose(el,c){choice=c;for(const b of document.querySelectorAll('.options button'))b.className='';el.className='selected'}
document.addEventListener('pointerdown',e=>fetch('/event/${s.id}',{method:'POST',body:JSON.stringify({kind:'pointer',x:e.clientX,y:e.clientY})}));document.getElementById('value').addEventListener('input',e=>fetch('/event/${s.id}',{method:'POST',body:JSON.stringify({kind:'text',text:e.target.value})}));
async function save(){if(busy)return;busy=true;try{const text=document.getElementById('value').value;if(!choice||!text)return;const response=await fetch('/save/${s.id}',{method:'POST',body:JSON.stringify({text,choice})});if(!response.ok)throw Error('save');const next=await response.json();document.getElementById('result').textContent='Last saved: '+text+' / '+choice;
if(next.done){document.querySelector('h2').textContent='All 3 tickets saved';document.getElementById('save').disabled=true}else{document.getElementById('round').textContent=next.round;document.getElementById('code').textContent=next.code;document.getElementById('priority').textContent=next.urgent?'HIGH':'NORMAL';document.getElementById('value').value='';choice='';for(const b of document.querySelectorAll('.options button'))b.className=''}}
catch{document.getElementById('result').textContent='Save uncertain; inspect before retry'}finally{busy=false}}</script>`;
}

/** One of K deterministic layouts: field order, label side, fonts, colours,
 * sizes, button order and save placement vary; the task does not. */
function sequenceHtmlK(s: SequenceScene) {
  const h = createHash("sha256")
    .update(`kstyle/${s.variantSeed}/${s.layout}`)
    .digest();
  const pick = <T>(i: number, xs: T[]) => xs[h[i]! % xs.length]!;
  const font = pick(0, [
    "Arial",
    "Georgia",
    "Verdana",
    "Tahoma",
    "Trebuchet MS",
    "Courier New",
  ]);
  const size = 15 + (h[1]! % 6);
  const bg = pick(2, [
    "#ffffff",
    "#fdf6e3",
    "#eef6ff",
    "#f3fff1",
    "#fff4f4",
    "#f5f0ff",
  ]);
  const accent = pick(3, [
    "#165fc9",
    "#b45309",
    "#15803d",
    "#7c3aed",
    "#be123c",
    "#0f766e",
  ]);
  const page = pick(4, [
    "#edf1f6",
    "#f6f3ee",
    "#e8eef3",
    "#f1f1f1",
    "#eaf2ea",
    "#f3eef6",
  ]);
  const codeFirst = h[5]! % 2 === 0;
  const urgentFirst = h[6]! % 2 === 0;
  const saveRight = h[7]! % 2 === 0;
  const w = 500 + (h[8]! % 160),
    pad = 12 + (h[9]! % 16),
    gap = 6 + (h[10]! % 18),
    radius = h[11]! % 14;
  const title = pick(12, [
    "Process item",
    "Dispatch item",
    "Item",
    "Work item",
    "Task",
  ]);
  const header = pick(13, [
    "Operations",
    "Fulfilment",
    "Back office",
    "Dispatch desk",
    "Queue",
  ]);
  const x = 160 + (s.x % 220),
    y = 80 + (s.y % 90);
  const facts = [
    `Copy code: <b id="code">${s.cases[0]!.code}</b>`,
    `Priority: <b id="priority">${s.cases[0]!.urgent ? "HIGH" : "NORMAL"}</b>`,
  ];
  if (!codeFirst) facts.reverse();
  const buttons = [
    `<button onclick="choose(this,'Standard')">Standard</button>`,
    `<button onclick="choose(this,'Urgent')">Urgent</button>`,
  ];
  if (urgentFirst) buttons.reverse();
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:${page};font:${size}px ${font};color:#1f2937}header{height:54px;background:${accent};color:#fff;padding:16px 22px}
main{position:absolute;left:${x}px;top:${y}px;width:${w}px;background:${bg};border:1px solid #9ca3af;border-radius:${radius}px;padding:${pad}px}
h2{margin:0 0 ${gap}px;font-size:${size + 4}px}#facts{line-height:1.6;margin-bottom:${gap}px}input{display:block;width:300px;height:38px;font:${size + 2}px ${font};caret-color:transparent;margin-bottom:${gap}px}
.row{display:flex;gap:${gap}px;align-items:center;margin-bottom:${gap}px}button{padding:8px 16px;border:1px solid #6b7280;border-radius:${radius / 2}px;font:${size}px ${font};background:#fff}.selected{color:#fff;background:${accent}}#result{min-height:24px;font-size:${size - 1}px}</style>
<header>${header} <span style="float:right">Window ${s.id}</span></header>
<main id="panel"><h2>${title} <span id="round">1</span> of 3</h2><div id="facts">${facts.join("<br>")}</div><input id="value" autocomplete="off">
<div class="row"><span class="options">${buttons.join(" ")}</span>${saveRight ? '<button id="save" onclick="save()">Save item</button>' : ""}</div>${saveRight ? "" : '<div class="row"><button id="save" onclick="save()">Save item</button></div>'}<div id="result">Last saved: —</div></main>
<script>let choice='',busy=false;function choose(el,c){choice=c;for(const b of document.querySelectorAll('.options button'))b.className='';el.className='selected'}
document.addEventListener('pointerdown',e=>fetch('/event/${s.id}',{method:'POST',body:JSON.stringify({kind:'pointer',x:e.clientX,y:e.clientY})}));document.getElementById('value').addEventListener('input',e=>fetch('/event/${s.id}',{method:'POST',body:JSON.stringify({kind:'text',text:e.target.value})}));
async function save(){if(busy)return;busy=true;try{const text=document.getElementById('value').value;if(!choice||!text)return;const response=await fetch('/save/${s.id}',{method:'POST',body:JSON.stringify({text,choice})});if(!response.ok)throw Error('save');const next=await response.json();document.getElementById('result').textContent='Last saved: '+text+' / '+choice;
if(next.done){document.querySelector('h2').textContent='All 3 items saved';document.getElementById('save').disabled=true}else{document.getElementById('round').textContent=next.round;document.getElementById('code').textContent=next.code;document.getElementById('priority').textContent=next.urgent?'HIGH':'NORMAL';document.getElementById('value').value='';choice='';for(const b of document.querySelectorAll('.options button'))b.className=''}}
catch{document.getElementById('result').textContent='Save uncertain; inspect before retry'}finally{busy=false}}</script>`;
}
