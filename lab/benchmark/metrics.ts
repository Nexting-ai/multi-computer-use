import { createHash } from "node:crypto";
export type Arm = "baseline" | "infra";
export function rng(seed: number) {
  let n = seed >>> 0;
  return () => {
    n += 0x6d2b79f5;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function schedule(pairs: number, seed: number) {
  if (!Number.isInteger(pairs) || pairs < 4 || pairs % 2)
    throw new Error("even_pairs_at_least_four");
  const random = rng(seed),
    first: Arm[] = Array.from({ length: pairs }, (_, i) =>
      i < pairs / 2 ? "baseline" : "infra",
    );
  for (let i = first.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [first[i], first[j]] = [first[j]!, first[i]!];
  }
  return first.map((arm, pair) => ({
    pair,
    seed: Math.floor(random() * 0x7fffffff),
    order: [arm, arm === "baseline" ? "infra" : "baseline"] as Arm[],
    sessions: [0, 1].map((i) =>
      createHash("sha256")
        .update(`${seed}/${pair}/${i}`)
        .digest("hex")
        .slice(0, 24),
    ),
  }));
}
export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cacheWriteInputTokens?: number;
};
export class UsageLedger {
  value: Usage | null = null;
  constructor(readonly thread: string) {}
  record(event: { threadId: string; tokenUsage: { total: Usage } }) {
    if (event.threadId !== this.thread) return;
    const u = event.tokenUsage.total;
    if (
      !u ||
      ![
        u.inputTokens,
        u.cachedInputTokens,
        u.outputTokens,
        u.reasoningOutputTokens,
        u.totalTokens,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      u.cachedInputTokens > u.inputTokens ||
      u.reasoningOutputTokens > u.outputTokens ||
      u.totalTokens !== u.inputTokens + u.outputTokens
    )
      throw new Error("invalid_usage");
    if (this.value && u.totalTokens < this.value.totalTokens)
      throw new Error("usage_regression");
    this.value = { ...u };
  }
}
export type RunRow = {
  pair: number;
  arm: Arm;
  session: string;
  elapsed_ms: number | null;
  successes: number;
  wrong: number;
  total: number;
  tokens: number | null;
  status: string;
};
function interval(values: number[], seed = 9001) {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = rng(seed),
    samples = Array.from({ length: 10000 }, () =>
      mean(values.map(() => values[Math.floor(r() * values.length)]!)),
    ).sort((a, b) => a - b);
  return {
    estimate: mean(values),
    low: samples[249]!,
    high: samples[9749]!,
    method:
      "paired-run percentile bootstrap (10000 draws); exploratory with few pairs",
  };
}
export function summarize(rows: RunRow[], fullSubmissionPairs?: number[]) {
  if (new Set(rows.map((r) => r.session)).size !== rows.length)
    throw new Error("session_reused");
  const ids = [...new Set(rows.map((r) => r.pair))];
  const pairs = ids.map((id) => {
    const rs = rows.filter((r) => r.pair === id),
      a = rs.find((r) => r.arm === "baseline"),
      b = rs.find((r) => r.arm === "infra");
    if (rs.length !== 2 || !a || !b) throw new Error("incomplete_pair");
    return { a, b };
  });
  if (pairs.length < 4) throw new Error("insufficient_pairs");
  for (const { a, b } of pairs)
    for (const r of [a, b])
      if (
        r.total < 1 ||
        r.successes < 0 ||
        r.successes > r.total ||
        (r.elapsed_ms !== null &&
          (!Number.isFinite(r.elapsed_ms) || r.elapsed_ms <= 0)) ||
        (r.tokens !== null && r.tokens < 0)
      )
        throw new Error("invalid_measurement");
  const eligible = pairs.filter(
    ({ a }) => !fullSubmissionPairs || fullSubmissionPairs.includes(a.pair),
  );
  const timed = eligible.filter(
    ({ a, b }) => a.elapsed_ms !== null && b.elapsed_ms !== null,
  );
  const tokened = eligible.filter(
    ({ a, b }) => a.tokens !== null && a.tokens > 0 && b.tokens !== null,
  );
  return {
    pairs: pairs.length,
    runs: rows.length,
    full_submission_pairs: eligible.map(({ a }) => a.pair),
    missing_elapsed_pairs: eligible
      .filter(({ a, b }) => a.elapsed_ms === null || b.elapsed_ms === null)
      .map(({ a }) => a.pair),
    observed_elapsed_pairs: timed.map(({ a, b }) => ({
      pair: a.pair,
      ratio: b.elapsed_ms! / a.elapsed_ms!,
    })),
    observed_token_pairs: tokened.map(({ a, b }) => ({
      pair: a.pair,
      ratio: b.tokens! / a.tokens!,
    })),
    elapsed_ratio:
      timed.length >= 4
        ? interval(timed.map(({ a, b }) => b.elapsed_ms! / a.elapsed_ms!))
        : null,
    token_ratio:
      tokened.length >= 4
        ? interval(tokened.map(({ a, b }) => b.tokens! / a.tokens!))
        : null,
    success_difference: interval(
      pairs.map(({ a, b }) => b.successes / b.total - a.successes / a.total),
    ),
    wrong_difference: interval(
      pairs.map(({ a, b }) => b.wrong / b.total - a.wrong / a.total),
    ),
    verdict: pairs.some(
      ({ a, b }) =>
        b.wrong > a.wrong || b.successes / b.total < a.successes / a.total,
    )
      ? "quality_regression"
      : "exploratory_only",
    failures_included: true,
    unit: "paired run, not desktop",
  };
}
