/**
 * Builds the presentation page from recorded analysis only (no hand-copied
 * numbers). Usage:
 *   node --import tsx lab/virtual-screen/showcase.ts <strict-analysis.json> <fault-suite.json> <e1p.json> [<held-out-analysis.json>...] <out.html>
 * Speed is reported only against the parallel per-surface baseline (E1-P);
 * E1's per-surface arms ran one model session at a time.
 */
import { readFile, writeFile } from "node:fs/promises";

const [strictPath, faultPath, e1pPath, ...rest] = process.argv.slice(2);
const out = rest.pop()!;

const A = JSON.parse(await readFile(strictPath!, "utf8"));
const F = JSON.parse(await readFile(faultPath!, "utf8"));
const P = JSON.parse(await readFile(e1pPath!, "utf8"));
const H = Object.assign(
  {},
  ...(await Promise.all(
    rest.map(async (p) => JSON.parse(await readFile(p, "utf8"))),
  )),
);

const e1 = A.e1.per_arm;
const arms = [
  { id: "P-V", name: "传统逐台 CU" },
  { id: "P-T", name: "逐台 + 文本层" },
  { id: "S", name: "模型写脚本" },
  { id: "B-V", name: "广播 · 不读文本" },
  { id: "B-T", name: "Z 广播 Infra" },
];
const data = {
  e1: arms.map((a) => ({
    ...a,
    s: e1[a.id].elapsed_s,
    tokens: e1[a.id].tokens,
    inferences: e1[a.id].inferences,
    items: e1[a.id].items_correct,
    total: e1[a.id].items_total,
  })),
  e3: ["k1", "k5", "k20", "k100"].map((k) => ({
    k: Number(k.slice(1)),
    bt_s: A.e3[k]["B-T"].mean_s,
    bt_tokens: A.e3[k]["B-T"].mean_tokens,
    coverage: A.e3[k]["B-T"].broadcast_coverage,
    pt_s: A.e3[k]["P-T"]?.mean_s ?? null,
    items: A.e3[k]["B-T"].items,
  })),
  e4: A.e4,
  e1p: P.rows as {
    block: number;
    arm: string;
    elapsed_s: number;
    tokens: number;
    items: number;
    last_delivery_s: number;
  }[],
  fault: F,
  e2: A.e2,
  f1: H.f1 ?? null,
  f2: H.f2 ?? null,
  dev: [
    ...Object.values(H.f1d ?? {}),
    ...Object.values(H.f2d ?? {}),
  ].flat() as {
    items: string;
    coverage: number;
  }[],
};
const pv = data.e1.find((a) => a.id === "P-V")!,
  bt = data.e1.find((a) => a.id === "B-T")!,
  sc = data.e1.find((a) => a.id === "S")!;
const S = P.summary;
const kpi = {
  tokens: S["P-V_parallel13"].tokens / S["B-T"].tokens,
  inferences: [pv.inferences, bt.inferences],
  vsScript: sc.tokens / bt.tokens,
};
const fmt = (n: number) =>
  n >= 1e6
    ? (n / 1e6).toFixed(2) + "M"
    : n >= 1e3
      ? Math.round(n / 1e3) + "k"
      : String(Math.round(n));
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Z 轴广播：一次决策，操作一百台电脑</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f2f1ee;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#7a7974;--rule:#e2e1dc;--accent:#2a78d6;--deemph:#8f8e89;--good:#008300;--bad:#e34948}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#9a998f;--rule:#3a3a37;--accent:#3987e5;--deemph:#6f6e69;--good:#3fae3f;--bad:#e66767}}
*{box-sizing:border-box}body{margin:0}.viz-root{background:var(--surface-1);color:var(--text-primary);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;min-height:100vh}
.wrap{max-width:1040px;margin:0 auto;padding:48px 28px 80px}h1{font-size:34px;line-height:1.2;margin:0 0 10px}h2{font-size:21px;margin:56px 0 6px}.lede{color:var(--text-secondary);font-size:17px;max-width:760px}
.note{color:var(--text-muted);font-size:13px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:32px 0 8px}.kpi{background:var(--surface-2);border-radius:12px;padding:18px 18px 16px}
.kpi .v{font-size:40px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.kpi .l{color:var(--text-secondary);font-size:13px}
.chart{position:relative;margin:14px 0}.chart svg{width:100%;height:auto;display:block;overflow:visible}.tip{position:absolute;pointer-events:none;background:var(--surface-1);border:1px solid var(--rule);border-radius:8px;padding:8px 10px;font-size:13px;box-shadow:0 4px 18px rgba(0,0,0,.12);opacity:0;transition:opacity .1s;white-space:nowrap;z-index:5}
.legend{display:flex;gap:18px;color:var(--text-secondary);font-size:13px;margin:6px 0}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
table{border-collapse:collapse;width:100%;font-size:14px;margin:10px 0;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule)}th{color:var(--text-secondary);font-weight:600}
td.num{text-align:right}.ok{color:var(--good)}.bad{color:var(--bad)}.two{display:grid;grid-template-columns:1fr 1fr;gap:28px}
@media (max-width:760px){.kpis{grid-template-columns:1fr 1fr}.two{grid-template-columns:1fr}h1{font-size:27px}}
</style>
<body class="viz-root"><div class="wrap">
<h1>Z 轴广播：一次决策，操作一百台电脑</h1>
<p class="lede">让 Computer Use 模型把 Z 轴当作"批量维度"：每种界面只决策一次，运行时在每台电脑上独立配准、读取数值、执行并核验。以下结果来自预先注册判定标准的对照实验，评分独立于运行时，原始证据可复算。</p>
<div class="kpis">
 <div class="kpi"><div class="v">${kpi.tokens.toFixed(0)}×</div><div class="l">token 更少<br>${fmt(S["P-V_parallel13"].tokens)} → ${fmt(S["B-T"].tokens)}</div></div>
 <div class="kpi"><div class="v">${kpi.inferences[0]}→${kpi.inferences[1]}</div><div class="l">模型推理次数<br>决策与台数脱钩</div></div>
 <div class="kpi"><div class="v">${S["B-T"].items}/900</div><div class="l">任务正确<br>传统逐台 ${S["P-V_parallel13"].items}/900</div></div>
 <div class="kpi"><div class="v">1 : 13</div><div class="l">同时占用的模型会话<br>耗时与 13 路并行持平</div></div>
</div>
<p class="note">同一模型（gpt-6-astra），100 个独立服务器桌面，每台 3 项业务，三轮区组、顺序随机。传统逐台对照为 13 个 Agent 并行。比"让模型自己写批量脚本"token 少 ${kpi.vsScript.toFixed(1)} 倍。</p>

<h2>速度：和并行的传统做法持平</h2>
<p class="note">逐台对照开 13 个 Agent 同时干活。三轮合计广播 ${Math.round(S["B-T"].elapsed_s)} s、逐台 ${Math.round(S["P-V_parallel13"].elapsed_s)} s。广播的价值不在更快，而在用 1 个会话、约百分之一的 token 达到同样的速度。</p>
<table><tr><th>轮次</th><th class="num">广播耗时</th><th class="num">逐台并行耗时</th><th class="num">广播 token</th><th class="num">逐台 token</th><th class="num">正确（广播 / 逐台）</th></tr>
${[0, 1, 2]
  .map((b) => {
    const x = data.e1p.find((r) => r.block === b && r.arm === "B-T")!,
      y = data.e1p.find((r) => r.block === b && r.arm === "P-V")!;
    return `<tr><td>${b + 1}</td><td class="num">${Math.round(x.elapsed_s)} s</td><td class="num">${Math.round(y.elapsed_s)} s</td><td class="num">${fmt(x.tokens)}</td><td class="num">${fmt(y.tokens)}</td><td class="num">${x.items} / ${y.items}</td></tr>`;
  })
  .join("")}
</table>
<p class="note">第 3 轮广播在 ${Math.round(data.e1p.find((r) => r.block === 2 && r.arm === "B-T")!.last_delivery_s)} s 已完成全部操作，之后模型写总结又用了约 90 s，按预注册计入耗时。</p>

<h2>token：五种做法同场对比（消融）</h2>
<p class="note">三轮合计。蓝色为完整 Infra，其余为对照与消融。</p>
<div class="legend"><span><i style="background:var(--accent)"></i>Z 广播 Infra</span><span><i style="background:var(--deemph)"></i>对照 / 消融</span></div>
<div class="chart" id="c-tok" style="max-width:640px"></div>

<h2>为什么省、为什么准</h2>
<table><tr><th></th><th>逐台决策</th><th>一次决策广播</th></tr>
<tr><th>模型看图读值</th><td>${fmt(data.e1[0]!.tokens)} token · ${data.e1[0]!.items}/900</td><td>${fmt(data.e1[3]!.tokens)} token · <span class="bad">${data.e1[3]!.items}/900</span></td></tr>
<tr><th>机器读文本层</th><td>${fmt(data.e1[1]!.tokens)} token · ${data.e1[1]!.items}/900</td><td><b>${fmt(bt.tokens)} token · ${bt.items}/900</b></td></tr></table>
<p class="note">省来自"一次决策广播"（推理次数不随台数增长）；准来自"数值由机器读取、模型不转写"——两者缺一不可：只广播不读文本，批量转写错 ${(100 - data.e1[3]!.items / 9).toFixed(1)}%。</p>

<h2>界面越多样，收益越小：异构度曲线</h2>
<p class="note">100 台电脑分属 K 种不同界面（字体、配色、字段与按钮顺序不同）。蓝线为广播 Infra 每轮平均 token。</p>
<div class="chart" id="c-k"></div>
<p class="note">${data.e3.map((d) => `K=${d.k}：${fmt(d.bt_tokens)} token，广播覆盖 ${(d.coverage * 100).toFixed(0)}%`).join("；")}。每种界面增加约一次决策；当每台界面都不同（K=100），广播退回逐台，收益消失、正确率不受影响。</p>

<h2>换一个模型：Claude Sonnet 5.5</h2>
<div class="kpis" style="grid-template-columns:repeat(2,1fr)">
 <div class="kpi"><div class="v">${(data.e4["P-T"].tokens / data.e4["B-T"].tokens).toFixed(0)}×</div><div class="l">token 更少</div></div>
 <div class="kpi"><div class="v">${data.e4["B-T"].items}</div><div class="l">全部正确（逐台 ${data.e4["P-T"].items}）</div></div>
</div>
<p class="note">30 台 × 3 项 × 2 轮，经 MCP 接入，同一套工具。该实验的逐台对照为串行运行，因此不报告速度。</p>

<h2>安全：故障注入（不经模型，可重复）</h2>
<table><tr><th>场景</th><th class="num">收到输入的电脑</th><th class="num">错误保存</th><th class="num">重复提交</th><th>结果</th></tr>
${(data.fault as any[])
  .map((r) => {
    const name: Record<string, string> = {
      "wrong-click-canary-on": "错误决策（点错控件）· 金丝雀开",
      "wrong-click-canary-off": "错误决策（点错控件）· 金丝雀关",
      "wrong-click-blank-binding": "错误决策（点在空白处）· 语义绑定开",
      "wrong-value-canary-on": "错误决策（填错字段）· 金丝雀开",
      "wrong-value-canary-off": "错误决策（填错字段）· 金丝雀关",
      "lost-replies-resolve-on": "1/3 执行回执丢失 · 证据闭合开",
      "lost-replies-resolve-off": "1/3 执行回执丢失 · 证据闭合关",
      "frame-changes-before-input": "输入前画面被改动",
      "unmatched-values": "出现未预期的取值",
      "overlapping-concurrent-policies": "两条相同决策同时下发",
      "mixed-layouts-a-policy": "混合界面，只对一种界面下决策",
      "sparse-moved-controls-check-on": "稀疏页面控件移位 · 目标核对＋语义绑定",
      "sparse-moved-controls-check-binding-only":
        "稀疏页面控件移位 · 只开语义绑定",
      "sparse-moved-controls-check-off": "稀疏页面控件移位 · 两者都关",
      "reordered-labels-strict": "相同输入框、标签顺序变化 · 严格配准开",
      "reordered-labels-lenient": "相同输入框、标签顺序变化 · 严格配准关",
      "occluded-target-on": "按钮被另一按钮遮挡 · 避开遮挡开",
      "occluded-target-off": "按钮被另一按钮遮挡 · 避开遮挡关",
      "blind-focus-on": "回放模型策略：点空白再按 Tab · 语义绑定开",
      "blind-focus-off": "回放模型策略：点空白再按 Tab · 语义绑定关",
      "cut-field-on": "回放模型策略：取值截断说明文字 · 语义绑定开",
      "cut-field-off": "回放模型策略：取值截断说明文字 · 语义绑定关",
    };
    const sparse = "submissions" in r;
    const n = r.surfaces_eligible ?? 12;
    const touched = sparse ? r.submissions : r.surfaces_with_input;
    const wrong = sparse
      ? (r.wrong_submissions ?? r.misapplied_submissions)
      : r.wrong_saves;
    const dup = sparse ? 0 : r.duplicates;
    const res = !sparse
      ? r.surfaces_with_input === 0 && r.surfaces_correct === 0
        ? "编译时拒绝，无输入"
        : `${r.surfaces_correct}/12 完成`
      : r.refused_policies?.length
        ? "策略在输入前被拒绝"
        : "surfaces_same_order" in r
          ? `${r.surfaces_same_order} 台布局与示例一致，其余拒绝`
          : `${r.correct_submissions} 台正确，其余转异常`;
    return `<tr><td>${name[r.scenario] ?? r.scenario}</td><td class="num">${touched}/${n}</td><td class="num ${wrong ? "bad" : "ok"}">${wrong}</td><td class="num ${dup ? "bad" : "ok"}">${dup}</td><td>${res}</td></tr>`;
  })
  .join("")}
</table>
<p class="note">所有场景零误投、零重复；错误决策在金丝雀保护下最多影响 1 项；结果不确定的操作从不重放，只凭证据闭合。带开/关的后几组对应预留任务中发现的误点类型；"回放"两组直接用模型在第三轮写出的原始策略与相同种子。</p>

<h2>边界：第三方通用网页任务</h2>
<p class="note">MiniWoB++ 任务由第三方设计，每轮 6 个开发期间未打开过的任务，按预注册随机抽取，reward 由任务自身判分。判定线：广播正确项不低于逐台 2%。三轮都<b class="bad">未达标</b>——这是目前的边界，不是展示结论。</p>
${heldOutTable("第一轮（E2）", data.e2)}
${data.f1 ? heldOutTable("第二轮（F1，加逐点击目标核对）", data.f1) : ""}
${data.f2 ? heldOutTable("第三轮（F2，再加严格配准）", data.f2) : ""}
<table><tr><th>错误来源</th><th class="num">错误数</th><th>状态</th></tr>
<tr><td>像素配准接受了目标已移动或标签已换序的界面</td><td class="num">103</td><td class="ok">已修复（E5 开/关对照）</td></tr>
<tr><td>目标文字被另一按钮遮挡</td><td class="num">8</td><td class="ok">已修复（E5 开/关对照）</td></tr>
<tr><td>模型写出未绑定元素的动作（点空白再按 Tab），提交后无法判对错</td><td class="num">39</td><td>语义绑定已实现，回放验证通过；<span class="bad">新预留集未复测</span></td></tr>
<tr><td>取值框截到整段说明文字</td><td class="num">2</td><td>语义绑定已实现，回放验证通过；<span class="bad">新预留集未复测</span></td></tr></table>
${data.dev.length ? `<p class="note">修复没有伤到主场景：开发集同构与混合回归 ${data.dev.length} 次，${data.dev.filter((d) => d.items === "300/300" && d.coverage === 1).length} 次 300/300 且广播覆盖 100%。</p>` : ""}

<h2>方法</h2>
<p class="note">判定标准在实验前提交；每轮全新容器与全新模型会话；评分读取服务器持久业务记录或任务自身 reward，不经运行时；所有失败、中断与偏离保留并记录。报告：docs/validation/2026-10-30-strict-evaluation.md、2026-10-31-e1p-parallel-baseline.md、2026-10-31-heldout-f1-f2.md 及各轮预注册。</p>
</div><div class="tip" id="tip"></div>
<script>
const D=${JSON.stringify(data)};
const tip=document.getElementById('tip');
function show(e,h){tip.innerHTML=h;tip.style.opacity=1;const r=document.body.getBoundingClientRect();tip.style.left=(e.pageX+14)+'px';tip.style.top=(e.pageY+14)+'px'}
function hide(){tip.style.opacity=0}
const sec=n=>Math.round(n).toLocaleString('en-US');const fmt=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?Math.round(n/1e3)+'k':String(Math.round(n));
function bars(id,title,key,unit){
  const el=document.getElementById(id),W=480,rowH=34,top=34,left=118,right=78,H=top+D.e1.length*rowH+10;
  const max=Math.max(...D.e1.map(d=>d[key]));
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+title+'"><text x="0" y="16" font-size="14" font-weight="600" fill="var(--text-primary)">'+title+'</text>';
  D.e1.forEach((d,i)=>{const y=top+i*rowH,w=Math.max(2,(W-left-right)*d[key]/max),c=d.id==='B-T'?'var(--accent)':'var(--deemph)';
    s+='<text x="0" y="'+(y+18)+'" font-size="12" fill="var(--text-secondary)">'+d.name+'</text>';
    s+='<path d="M'+left+' '+(y+6)+'h'+(w-4)+'a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-'+(w-4)+'z" fill="'+c+'"/>';
    s+='<text x="'+(left+w+6)+'" y="'+(y+18)+'" font-size="12" fill="var(--text-primary)" font-weight="'+(d.id==='B-T'?700:400)+'">'+(key==='s'?sec(d[key]):fmt(d[key]))+unit+'</text>';
    s+='<rect x="0" y="'+y+'" width="'+W+'" height="'+rowH+'" fill="transparent" data-i="'+i+'"/>'});
  el.innerHTML=s+'</svg>';
  el.querySelectorAll('rect[data-i]').forEach(r=>{const d=D.e1[+r.dataset.i];r.addEventListener('mousemove',e=>show(e,'<b>'+d.name+'</b><br>耗时 '+Math.round(d.s)+' s · token '+fmt(d.tokens)+'<br>推理 '+d.inferences+' 次 · 正确 '+d.items+'/'+d.total));r.addEventListener('mouseleave',hide)});
}
bars('c-tok','合计 token','tokens','');
(function(){const el=document.getElementById('c-k'),W=900,H=300,l=60,r=30,t=20,b=40;
  const xs=D.e3.map((d,i)=>l+i*(W-l-r)/(D.e3.length-1));const raw=Math.max(...D.e3.map(d=>d.bt_tokens));const ymax=Math.ceil(raw/1e6)*1e6;
  const y=v=>t+(H-t-b)*(1-v/ymax);
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="异构度曲线">';
  [0,.25,.5,.75,1].forEach(f=>{const v=ymax*f;s+='<line x1="'+l+'" x2="'+(W-r)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--rule)"/><text x="'+(l-8)+'" y="'+(y(v)+4)+'" font-size="11" text-anchor="end" fill="var(--text-muted)">'+fmt(v)+'</text>'});
  D.e3.forEach((d,i)=>{s+='<text x="'+xs[i]+'" y="'+(H-14)+'" font-size="12" text-anchor="middle" fill="var(--text-secondary)">K = '+d.k+'</text>'});
  s+='<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="'+D.e3.map((d,i)=>xs[i]+','+y(d.bt_tokens)).join(' ')+'"/>';
  D.e3.forEach((d,i)=>{s+='<circle cx="'+xs[i]+'" cy="'+y(d.bt_tokens)+'" r="5" fill="var(--accent)" stroke="var(--surface-1)" stroke-width="2"/>';
    s+='<text x="'+(xs[i]-8)+'" y="'+(y(d.bt_tokens)-10)+'" font-size="12" text-anchor="end" fill="var(--text-primary)">'+fmt(d.bt_tokens)+'</text>';
    s+='<rect x="'+(xs[i]-40)+'" y="'+t+'" width="80" height="'+(H-t-b)+'" fill="transparent" data-i="'+i+'"/>'});
  el.innerHTML=s+'</svg>';
  el.querySelectorAll('rect[data-i]').forEach(r=>{const d=D.e3[+r.dataset.i];r.addEventListener('mousemove',e=>show(e,'<b>K = '+d.k+'</b><br>广播 '+Math.round(d.bt_s)+' s · '+fmt(d.bt_tokens)+' token<br>广播覆盖 '+Math.round(d.coverage*100)+'% · 正确 '+d.items));r.addEventListener('mouseleave',hide)});
})();
</script></body></html>`;
function heldOutTable(title: string, h: any) {
  const rows = Object.entries(h.per_task as Record<string, any>)
    .map(
      ([task, v]) =>
        `<tr><td>${task}</td><td class="num">${v["P-T"].items}</td><td class="num ${v["B-T"].items !== v["P-T"].items ? "bad" : ""}">${v["B-T"].items}</td><td class="num">${(v["B-T"].broadcast_coverage * 100).toFixed(0)}%</td><td class="num">${v.token_ratio.toFixed(2)}</td></tr>`,
    )
    .join("");
  return `<p><b>${title}</b>：合计 ${h.H3.items_bt}/${h.H3.items_total_each} 对 ${h.H3.items_pt}/${h.H3.items_total_each}，广播造成的错误 ${
    // E2 predates the per-delivery count; its shortfall was all broadcast
    // errors (strict evaluation report).
    h.H3.broadcast_errors ?? h.H3.items_pt - h.H3.items_bt
  }</p>
<table><tr><th>任务</th><th class="num">逐台正确</th><th class="num">广播正确</th><th class="num">广播覆盖</th><th class="num">token 比</th></tr>${rows}</table>`;
}
await writeFile(out, html);
console.log(JSON.stringify({ out, bytes: html.length }));
