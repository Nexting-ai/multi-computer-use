/**
 * Tunable workload: a 12-page purchase-request wizard on every surface, where
 * each page is either the same on every surface ("shared") or differs in one
 * controlled way. The share of shared pages and the kinds of difference are
 * the experiment's knobs.
 *
 *   look       same meaning, different look: layout and language per surface
 *   timing     a notice covers the page after a delay that differs per surface
 *   judgement  the page shows a fact that differs per surface, and the right
 *              choice depends on it (a rule in the task text)
 *   path       about half the surfaces need two extra pages here
 */
import { rng } from "../../benchmark/metrics.js";

export const DIVERGENCE = ["look", "timing", "judgement", "path"] as const;
export type Divergence = (typeof DIVERGENCE)[number];
export type Lang = "en" | "fr" | "de" | "es";

/** The wizard's twelve pages, in order. */
export const PAGES = [
  { key: "requester", kind: "text", label: "Requester" },
  { key: "department", kind: "choice", label: "Department" },
  { key: "vendor", kind: "text", label: "Vendor" },
  { key: "currency", kind: "choice", label: "Currency" },
  { key: "item1", kind: "text", label: "First item" },
  { key: "qty1", kind: "text", label: "First item quantity" },
  { key: "item2", kind: "text", label: "Second item" },
  { key: "qty2", kind: "text", label: "Second item quantity" },
  { key: "delivery", kind: "choice", label: "Delivery" },
  { key: "payment", kind: "choice", label: "Payment terms" },
  { key: "reference", kind: "text", label: "Reference" },
  { key: "approval", kind: "choice", label: "Approval route" },
] as const;
export type PageKey = (typeof PAGES)[number]["key"];

/** Choice pages: options, the constant answer on shared pages, and the fact
 * and rule a judgement page uses instead. */
export const CHOICES: Record<
  string,
  {
    options: string[];
    answer: string;
    fact: string;
    facts: [string, string];
    rule: string;
    /** Answer when the page shows facts[0] / facts[1]. */
    answers: [string, string];
  }
> = {
  department: {
    options: ["Operations", "Marketing", "Research", "Finance"],
    answer: "Operations",
    fact: "Budget owner",
    facts: ["Operations", "Research"],
    rule: "Department: the budget owner shown on the page.",
    answers: ["Operations", "Research"],
  },
  currency: {
    options: ["EUR", "USD", "GBP", "CHF"],
    answer: "EUR",
    fact: "Vendor country",
    facts: ["Germany", "United States"],
    rule: "Currency: EUR for a vendor in Germany, USD for one in the United States.",
    answers: ["EUR", "USD"],
  },
  delivery: {
    options: ["Standard", "Express", "Backorder", "Pickup"],
    answer: "Standard",
    fact: "Stock",
    facts: ["120 units", "0 units"],
    rule: "Delivery: Standard when stock is available, Backorder when stock is 0 units.",
    answers: ["Standard", "Backorder"],
  },
  payment: {
    options: ["Net 30", "Net 60", "Prepaid", "On delivery"],
    answer: "Net 30",
    fact: "Vendor rating",
    facts: ["Trusted", "New vendor"],
    rule: "Payment terms: Net 30 for a trusted vendor, Prepaid for a new vendor.",
    answers: ["Net 30", "Prepaid"],
  },
  approval: {
    options: ["Team lead", "Director", "CFO", "None"],
    answer: "Team lead",
    fact: "Order total",
    facts: ["EUR 840", "EUR 12,400"],
    rule: "Approval route: Team lead up to EUR 5,000, CFO above it.",
    answers: ["Team lead", "CFO"],
  },
};

/** Text pages that can need judgement: the page shows a pre-filled value that
 * is right on some surfaces and stale on others (keep it, or replace it). */
export const PREFILL_RULE =
  "A text page may already hold a value: keep it if it matches the task table, otherwise replace it.";

const NAMES = [
  "Ava Chen",
  "Liam Novak",
  "Mia Rossi",
  "Noah Weber",
  "Zoe Martin",
  "Kai Ito",
  "Lena Berg",
  "Omar Haddad",
  "Iris Kim",
  "Theo Laurent",
  "Nora Silva",
  "Felix Wong",
];
const VENDORS = [
  "Northwind Supply",
  "Bluebird Office",
  "Atlas Components",
  "Cedar & Pine",
  "Helix Labs",
  "Orbit Parts",
  "Juniper Goods",
  "Summit Tools",
];
const ITEMS = [
  "Standing desk",
  "Monitor arm",
  "Office chair",
  "Desk lamp",
  "Cable tray",
  "Whiteboard",
  "Laptop stand",
  "Headset",
];
const COST_CENTERS = [
  "CC-1042",
  "CC-2210",
  "CC-3307",
  "CC-4815",
  "CC-5120",
  "CC-6604",
];

export type Page = {
  key: PageKey;
  divergence: Divergence | null;
  /** look: layout variant 0..5 and language. */
  layout: number;
  lang: Lang;
  /** timing: ms after the page appears when the notice covers it. */
  notice: number | null;
  /** judgement on a choice page: which fact is shown (0 or 1). */
  fact: 0 | 1 | null;
  /** judgement on a text page: pre-filled value (right or stale). */
  prefill: string | null;
  /** path: this surface needs the two cost-center pages after this page. */
  extra: boolean;
};

export type Surface = {
  id: string;
  /** The task table row (what the agent is given). */
  row: Record<string, string>;
  pages: Page[];
  /** What the grader expects in the submission. */
  expected: Record<string, string>;
};

export type Config = {
  seed: number;
  count: number;
  /** Fraction of the 12 pages that are the same on every surface. */
  share: number;
  /** Kinds of difference used on the other pages (cycled). */
  types: Divergence[];
};

export function scenario(c: Config): {
  pages: (Divergence | null)[];
  surfaces: Surface[];
} {
  const r = rng(c.seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const shared = Math.round(PAGES.length * c.share);
  // Which pages differ (a seeded shuffle), and how (types cycled in order).
  const order = PAGES.map((_, i) => i).sort(() => r() - 0.5);
  const kinds: (Divergence | null)[] = PAGES.map(() => null);
  order.slice(shared).forEach((p, k) => {
    kinds[p] = c.types[k % c.types.length]!;
  });
  const surfaces = Array.from({ length: c.count }, (_, i): Surface => {
    const id = `W${String(i + 1).padStart(2, "0")}`;
    const row: Record<string, string> = {
      requester: pick(NAMES),
      vendor: pick(VENDORS),
      item1: pick(ITEMS),
      qty1: String(1 + Math.floor(r() * 9)),
      item2: pick(ITEMS),
      qty2: String(1 + Math.floor(r() * 9)),
      reference: `PR-${1000 + Math.floor(r() * 9000)}`,
      cost_center: pick(COST_CENTERS),
    };
    const expected: Record<string, string> = {};
    const pages = PAGES.map((p, pi): Page => {
      const d = kinds[pi] ?? null;
      const page: Page = {
        key: p.key,
        divergence: d,
        layout: 0,
        lang: "en",
        notice: null,
        fact: null,
        prefill: null,
        extra: false,
      };
      if (d === "look") {
        page.layout = 1 + Math.floor(r() * 5);
        page.lang = pick(["en", "fr", "de", "es"] as const);
      } else if (d === "timing") page.notice = 400 + Math.floor(r() * 5600);
      else if (d === "path") page.extra = r() < 0.5;
      const choice = CHOICES[p.key];
      if (choice) {
        if (d === "judgement") {
          page.fact = r() < 0.5 ? 0 : 1;
          expected[p.key] = choice.answers[page.fact];
        } else expected[p.key] = choice.answer;
      } else {
        expected[p.key] = row[p.key]!;
        if (d === "judgement")
          page.prefill =
            r() < 0.5 ? row[p.key]! : stale(p.key, row[p.key]!, pick);
      }
      if (page.extra) {
        expected.cost_center = row.cost_center!;
        expected.cost_center_confirm = "Confirmed";
      }
      return page;
    });
    return { id, row, pages, expected };
  });
  return { pages: kinds, surfaces };
}

function stale(key: string, right: string, pick: <T>(xs: readonly T[]) => T) {
  const pool =
    key === "requester"
      ? NAMES
      : key === "vendor"
        ? VENDORS
        : key.startsWith("item")
          ? ITEMS
          : null;
  if (pool) return pick(pool.filter((x) => x !== right));
  if (key.startsWith("qty")) return String(((Number(right) + 3) % 9) + 1);
  return `PR-${((Number(right.slice(3)) + 17) % 9000) + 1000}`;
}

/** Task text every arm reads (rules included; values come from the table). */
export function task(c: Config) {
  const rules = [
    "Each surface is a different company's purchase-request wizard (12 pages, one field each, then Submit). Fill every page from that surface's row of the task table and click Next; submit once on the final page.",
    `Choice pages: ${Object.entries(CHOICES)
      .map(([k, v]) => `${k} = ${v.answer}`)
      .join(", ")}, unless a rule below applies.`,
  ];
  if (c.types.includes("judgement") && c.share < 1)
    rules.push(
      "Some pages show a fact that decides the answer: " +
        Object.values(CHOICES)
          .map((v) => v.rule)
          .join(" ") +
        " " +
        PREFILL_RULE,
    );
  if (c.types.includes("timing") && c.share < 1)
    rules.push(
      "A notice may cover a page after a few seconds: dismiss it with OK.",
    );
  if (c.types.includes("path") && c.share < 1)
    rules.push(
      "Some companies ask for a cost center on extra pages: enter the row's cost_center, then confirm it.",
    );
  if (c.types.includes("look") && c.share < 1)
    rules.push(
      "Pages may be laid out differently or in French, German or Spanish; the fields mean the same.",
    );
  rules.push(
    "Use only the wizard. Declare each surface done once its request is submitted. Unknown or delivered inputs must not be repeated.",
  );
  return rules.join(" ");
}
