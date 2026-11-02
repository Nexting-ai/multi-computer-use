import { createHash } from "node:crypto";
export type Saved = {
  id: string;
  text: string;
  choice: string;
  round?: number;
};
export function scene(seed: number, index: number) {
  const digest = createHash("sha256")
    .update(`virtual/${seed}/${index}`)
    .digest("hex");
  return {
    id: `W${String(index).padStart(2, "0")}`,
    code: `${digest.slice(0, 6).toUpperCase()}-${String(index).padStart(2, "0")}`,
    urgent: parseInt(digest[6]!, 16) % 2 === 0,
    offset: ((index - 1) % 2) * 30,
  };
}
export function gradeScene(s: ReturnType<typeof scene>, records: Saved[]) {
  const own = records.filter((r) => r.id === s.id);
  const correct =
    own.length === 1 &&
    own[0]!.text === s.code &&
    own[0]!.choice === (s.urgent ? "Urgent" : "Standard");
  return {
    surface_id: s.id,
    success: correct,
    wrong: own.length > 0 && !correct,
    commits: own.length,
  };
}
export function html(s: ReturnType<typeof scene>) {
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#e9eef4;font:20px Arial;color:#172333}header{background:#172333;color:white;padding:14px}main{position:absolute;left:${20 + s.offset}px;top:74px;width:540px;background:white;padding:14px;height:325px;border:1px solid #bac6d6}p{margin:8px 0}input{position:fixed;left:${40 + s.offset}px;top:200px;width:350px;height:36px;font:22px Arial;caret-color:transparent}button{font:20px Arial;padding:10px 18px;border:1px solid #64748b;border-radius:4px;background:white}button.selected{background:#165fc9;color:white}.options{position:fixed;left:${40 + s.offset}px;top:270px}#save{position:fixed;left:${40 + s.offset}px;top:330px}#result{position:fixed;left:${40 + s.offset}px;top:390px;font-size:18px}</style>
<header>Window ${s.id}</header><main><p>Copy code: <b>${s.code}</b></p><p>Priority: <b>${s.urgent ? "HIGH" : "NORMAL"}</b></p><p>Enter code below, choose service, then save.</p><input id="value" autocomplete="off"><div class="options"><button onclick="choose(this,'Standard')">Standard</button> <button onclick="choose(this,'Urgent')">Urgent</button></div><button id="save" onclick="save()">Save</button><div id="result"></div></main>
<script>let choice='',busy=false;function choose(el,c){choice=c;for(const b of document.querySelectorAll('.options button'))b.className='';el.className='selected'}
document.addEventListener('pointerdown',e=>fetch('/event/${s.id}',{method:'POST',body:JSON.stringify({kind:'pointer',x:e.clientX,y:e.clientY})}));
document.getElementById('value').addEventListener('input',e=>fetch('/event/${s.id}',{method:'POST',body:JSON.stringify({kind:'text',text:e.target.value})}));
async function save(){if(busy)return;busy=true;try{const text=document.getElementById('value').value;if(!choice||!text){document.getElementById('result').textContent='Code and service required';return}const r=await fetch('/save/${s.id}',{method:'POST',body:JSON.stringify({text,choice})});if(!r.ok)throw Error('save');document.getElementById('result').textContent='Saved: '+text+' / '+choice;document.getElementById('save').disabled=true}catch{document.getElementById('result').textContent='Save uncertain; inspect before retry'}finally{busy=false}}</script>`;
}
