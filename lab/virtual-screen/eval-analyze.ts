/**
 * Applies the preregistered decision rules (2026-10-30-preregistration.md) to
 * recorded evidence only: result.json, environment records and provider usage.
 * Usage: node --import tsx lab/virtual-screen/eval-analyze.ts .local/eval > report.json
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2] ?? ".local/eval";
const lines = async (p: string) =>
  (await readFile(p, "utf8").catch(() => ""))
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l));
async function inferences(dir: string) {
  let n = 0;
  for (const s of await readdir(join(dir, "sessions")).catch(
    () => [] as string[],
  )) {
    const a = join(dir, "sessions", s, "agent");
    const claude = JSON.parse(
      await readFile(join(a, "agent.json"), "utf8").catch(() => "{}"),
    );
    if (claude.agent === "claude") {
      n += claude.inferences ?? 0;
      continue;
    }
    let last = -1;
    for (const r of await lines(join(a, "events.jsonl"))) {
      const e = r.event;
      if (e?.method !== "thread/tokenUsage/updated") continue;
      const t = e.params.tokenUsage.total.totalTokens;
      if (t !== last) n++;
      last = t;
    }
  }
  return n;
}
type Row = {
  experiment: string;
  block: number;
  arm: string;
  elapsed_ms: number;
  tokens: number;
  uncached: number;
  inferences: number;
  surfaces: number;
  surfaces_correct: number;
  items_total: number;
  items_correct: number;
  duplicates: number;
  misrouted: number | null;
  primary_completed_items: number | null;
  /** Surfaces that received a broadcast delivery and were graded wrong. */
  broadcast_errors: number;
  stop_reason: string | null;
};
async function arm(experiment: string, dir: string): Promise<Row | null> {
  const r = JSON.parse(
    await readFile(join(dir, "result.json"), "utf8").catch(() => "null"),
  );
  if (!r) return null;
  const env = JSON.parse(
    await readFile(join(dir, "environment/environment.json"), "utf8"),
  );
  const business = JSON.parse(
    await readFile(join(dir, "environment/business.json"), "utf8").catch(
      () => "[]",
    ),
  );
  const scenes: any[] = env.scenes;
  const sequence = !!scenes[0]?.cases;
  const perSurface = sequence ? 3 : 1;
  let misrouted: number | null = null;
  if (sequence) {
    const owner = new Map(
      scenes.flatMap((s) => s.cases.map((c: any) => [c.code, s.id])),
    );
    misrouted = business.filter(
      (b: any) => owner.has(b.text) && owner.get(b.text) !== b.id,
    ).length;
  }
  const delivered = new Set(
    (await lines(join(dir, "stack-deliveries.jsonl")))
      .filter(
        (d: any) => d.delivery?.status === "delivered" && d.mode !== "prepare",
      )
      .map((d: any) => d.surface_id),
  );
  const broadcast_errors = (r.scores as any[]).filter(
    (g) => delivered.has(g.surface_id) && !g.success,
  ).length;
  const commits = new Map<string, number>();
  for (const b of business) commits.set(b.id, (commits.get(b.id) ?? 0) + 1);
  return {
    experiment,
    block: r.block,
    arm: r.arm,
    elapsed_ms: r.elapsed_ms,
    tokens: r.tokens,
    uncached: (r.usage?.inputTokens ?? 0) - (r.usage?.cachedInputTokens ?? 0),
    inferences: await inferences(dir),
    surfaces: scenes.length,
    surfaces_correct: r.successes,
    items_total: scenes.length * perSurface,
    items_correct: r.correct_items,
    duplicates: [...commits.values()].filter((n) => n > perSurface).length,
    misrouted,
    primary_completed_items:
      r.phases?.primary?.progress?.completed_steps ?? null,
    broadcast_errors,
    stop_reason: r.stop_reason,
  };
}
const rows: Row[] = [];
for (const e of (await readdir(root))
  .filter(
    (d) =>
      /^(e\d|f\d-)/.test(d) &&
      !d.endsWith(".json") &&
      !d.endsWith(".log") &&
      !d.endsWith(".sh"),
  )
  .sort())
  for (const d of (await readdir(join(root, e)))
    .filter((d) => /^\d+-/.test(d))
    .sort()) {
    // Reruns of zero-input interruptions (e.g. e3-k1-r1) belong to their experiment.
    const row = await arm(e.replace(/-r\d+$/, ""), join(root, e, d));
    // A slot completed in the original run is never replaced by a rerun.
    if (
      row &&
      !rows.some(
        (r) =>
          r.experiment === row.experiment &&
          r.block === row.block &&
          r.arm === row.arm,
      )
    )
      rows.push(row);
  }
const sel = (e: string | RegExp, a: string) =>
  rows.filter(
    (r) =>
      (typeof e === "string" ? r.experiment === e : e.test(r.experiment)) &&
      r.arm === a,
  );
const total = (rs: Row[], k: keyof Row) =>
  rs.reduce((n, r) => n + (r[k] as number), 0);
const geo = (xs: number[]) =>
  Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
const ratio = (
  e: string,
  num: string,
  den: string,
  k: "elapsed_ms" | "tokens",
) => {
  const A = sel(e, num),
    B = sel(e, den);
  const pairs = A.map(
    (a) => [a, B.find((b) => b.block === a.block)] as const,
  ).filter(([, b]) => b);
  return pairs.length
    ? geo(pairs.map(([a, b]) => (a[k] as number) / (b![k] as number)))
    : null;
};
const out: any = { rows };
// E1: H1 and H2
if (sel("e1", "B-T").length) {
  const bt = sel("e1", "B-T"),
    pt = sel("e1", "P-T");
  const blocks = bt
    .map((b) => [b, pt.find((p) => p.block === b.block)!] as const)
    .filter(([, p]) => p);
  out.e1 = {
    per_arm: Object.fromEntries(
      ["P-V", "P-T", "B-V", "B-T", "S"].map((a) => [
        a,
        {
          runs: sel("e1", a).length,
          elapsed_s: total(sel("e1", a), "elapsed_ms") / 1000,
          tokens: total(sel("e1", a), "tokens"),
          inferences: total(sel("e1", a), "inferences"),
          items_correct: total(sel("e1", a), "items_correct"),
          items_total: total(sel("e1", a), "items_total"),
          surfaces_correct: total(sel("e1", a), "surfaces_correct"),
          misrouted: total(sel("e1", a), "misrouted"),
          duplicates: total(sel("e1", a), "duplicates"),
        },
      ]),
    ),
    H1: {
      faster_every_block: blocks.every(([b, p]) => b.elapsed_ms < p.elapsed_ms),
      fewer_tokens_every_block: blocks.every(([b, p]) => b.tokens < p.tokens),
      items_noninferior:
        total(bt, "items_correct") >=
        total(pt, "items_correct") - 3 * blocks.length,
      zero_misroute_duplicate:
        total(bt, "misrouted") === 0 && total(bt, "duplicates") === 0,
    },
    // Geometric-mean ratios over blocks; < 1 means the first arm is cheaper.
    H2: {
      broadcast_effect_time: [
        ratio("e1", "B-T", "P-T", "elapsed_ms"),
        ratio("e1", "B-V", "P-V", "elapsed_ms"),
      ],
      broadcast_effect_tokens: [
        ratio("e1", "B-T", "P-T", "tokens"),
        ratio("e1", "B-V", "P-V", "tokens"),
      ],
      text_effect_time: [
        ratio("e1", "P-T", "P-V", "elapsed_ms"),
        ratio("e1", "B-T", "B-V", "elapsed_ms"),
      ],
      text_effect_tokens: [
        ratio("e1", "P-T", "P-V", "tokens"),
        ratio("e1", "B-T", "B-V", "tokens"),
      ],
      text_effect_items: {
        "P-V": total(sel("e1", "P-V"), "items_correct"),
        "P-T": total(sel("e1", "P-T"), "items_correct"),
        "B-V": total(sel("e1", "B-V"), "items_correct"),
        "B-T": total(sel("e1", "B-T"), "items_correct"),
      },
      script_vs_broadcast_time: ratio("e1", "S", "B-T", "elapsed_ms"),
      script_vs_broadcast_tokens: ratio("e1", "S", "B-T", "tokens"),
    },
  };
}
// E2: H3 per task and pooled
function heldOut(names: string[]) {
  const bt = rows.filter(
      (r) => names.includes(r.experiment) && r.arm === "B-T",
    ),
    pt = rows.filter((r) => names.includes(r.experiment) && r.arm === "P-T");
  return {
    per_task: Object.fromEntries(
      names.map((e) => {
        const b = sel(e, "B-T"),
          p = sel(e, "P-T");
        return [
          e.slice(3),
          {
            "P-T": {
              items: `${total(p, "items_correct")}/${total(p, "items_total")}`,
              s: total(p, "elapsed_ms") / 1000,
              tokens: total(p, "tokens"),
            },
            "B-T": {
              items: `${total(b, "items_correct")}/${total(b, "items_total")}`,
              s: total(b, "elapsed_ms") / 1000,
              tokens: total(b, "tokens"),
              broadcast_coverage:
                total(b, "primary_completed_items") /
                Math.max(1, total(b, "items_total")),
              broadcast_errors: total(b, "broadcast_errors"),
            },
            time_ratio: ratio(e, "B-T", "P-T", "elapsed_ms"),
            token_ratio: ratio(e, "B-T", "P-T", "tokens"),
          },
        ];
      }),
    ),
    H3: {
      items_bt: total(bt, "items_correct"),
      items_pt: total(pt, "items_correct"),
      items_total_each: total(bt, "items_total"),
      noninferior_2pct:
        total(bt, "items_correct") >=
        total(pt, "items_correct") - 0.02 * total(pt, "items_total"),
      zero_duplicates: total(bt, "duplicates") === 0,
      broadcast_errors: total(bt, "broadcast_errors"),
      total_time_ratio:
        total(bt, "elapsed_ms") / Math.max(1, total(pt, "elapsed_ms")),
      total_token_ratio: total(bt, "tokens") / Math.max(1, total(pt, "tokens")),
    },
  };
}
const names = (pre: string) => [
  ...new Set(
    rows
      .filter(
        (r) => r.experiment.startsWith(pre) && !/^f\d-d-/.test(r.experiment),
      )
      .map((r) => r.experiment),
  ),
];
if (names("e2-").length) out.e2 = heldOut(names("e2-"));
for (const f of ["f1", "f2", "f3"]) {
  if (names(`${f}-`).length) out[f] = heldOut(names(`${f}-`));
  const fd = rows.filter((r) => r.experiment.startsWith(`${f}-d-`));
  if (fd.length)
    out[`${f}d`] = Object.fromEntries(
      [...new Set(fd.map((r) => r.experiment))].map((e) => [
        e,
        sel(e, "B-T").map((r) => ({
          s: r.elapsed_ms / 1000,
          tokens: r.tokens,
          items: `${r.items_correct}/${r.items_total}`,
          coverage: (r.primary_completed_items ?? 0) / r.items_total,
        })),
      ]),
    );
}
// E3: H4 curve
const e3 = rows.filter((r) => r.experiment.startsWith("e3-"));
if (e3.length)
  out.e3 = Object.fromEntries(
    [...new Set(e3.map((r) => r.experiment))].map((e) => [
      e.slice(3),
      Object.fromEntries(
        ["B-T", "P-T"]
          .filter((a) => sel(e, a).length)
          .map((a) => [
            a,
            {
              runs: sel(e, a).length,
              mean_s: total(sel(e, a), "elapsed_ms") / 1000 / sel(e, a).length,
              mean_tokens: total(sel(e, a), "tokens") / sel(e, a).length,
              mean_inferences:
                total(sel(e, a), "inferences") / sel(e, a).length,
              items: `${total(sel(e, a), "items_correct")}/${total(sel(e, a), "items_total")}`,
              broadcast_coverage:
                a === "B-T"
                  ? total(sel(e, a), "primary_completed_items") /
                    total(sel(e, a), "items_total")
                  : undefined,
              misrouted: total(sel(e, a), "misrouted"),
            },
          ]),
      ),
    ]),
  );
// E4: H5 direction
if (sel("e4", "B-T").length)
  out.e4 = {
    "P-T": {
      s: total(sel("e4", "P-T"), "elapsed_ms") / 1000,
      tokens: total(sel("e4", "P-T"), "tokens"),
      items: `${total(sel("e4", "P-T"), "items_correct")}/${total(sel("e4", "P-T"), "items_total")}`,
    },
    "B-T": {
      s: total(sel("e4", "B-T"), "elapsed_ms") / 1000,
      tokens: total(sel("e4", "B-T"), "tokens"),
      items: `${total(sel("e4", "B-T"), "items_correct")}/${total(sel("e4", "B-T"), "items_total")}`,
    },
    same_direction:
      (ratio("e4", "B-T", "P-T", "elapsed_ms") ?? 2) < 1 &&
      (ratio("e4", "B-T", "P-T", "tokens") ?? 2) < 1,
  };
console.log(JSON.stringify(out, null, 1));
