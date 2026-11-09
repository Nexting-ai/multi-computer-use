/**
 * E5 scenarios: one sales order to enter per company, on real Odoo, with a
 * preregistered level of variation between companies.
 *
 *   L0  identical: Odoo 17, English, default forms
 *   L1  + versions 16/17/18 and languages en/fr/de/es
 *   L2  + each company's own form layout (where Customer Reference sits)
 *       and a maintenance notice that pops up over the screen
 *   L3  + data that needs judgement: a customer that does not exist yet
 *       (create it) or an order that was already entered (do not repeat it)
 *
 * The order-to-cash probe continues the same UI workflow through delivery,
 * a posted invoice and a reconciled full payment.
 */
import { rng } from "../../benchmark/metrics.js";
import { scoreCash, type CashEvidence } from "./cash-grade.js";

export type { CashEvidence } from "./cash-grade.js";

export function cashScore(c: Company, evidence: CashEvidence) {
  return scoreCash(
    c,
    evidence,
    c.order.lines.map((l) => ({
      ...l,
      price: 40 + 35 * PRODUCTS.indexOf(l.product),
    })),
  );
}

export type Level = 0 | 1 | 2 | 3;
export type Line = { product: string; qty: number };
export type Company = {
  /** Surface id (W01...) and database name (c01...). */
  id: string;
  db: string;
  version: "16" | "17" | "18";
  lang: "en_US" | "fr_FR" | "de_DE" | "es_ES";
  /** Where the form shows Customer Reference (L2+). */
  layout: "default" | "top" | "after_date";
  /** Milliseconds after page load at which the notice appears (L2+). */
  notice: number | null;
  order: { customer: string; po: string; lines: Line[] };
  /** L3: the customer is not in the database; the agent must create it. */
  missingCustomer: boolean;
  /** L3: this exact order is already confirmed; it must not be repeated. */
  duplicate: boolean;
};

export const PRODUCTS = [
  "Office Chair",
  "Standing Desk",
  "Monitor Arm",
  "Desk Lamp",
  "Cable Tray",
  "Whiteboard",
];
export const CUSTOMERS = [
  "Northwind Traders",
  "Blue Harbor Cafe",
  "Alder & Finch Studio",
  "Kestrel Logistics",
  "Maple Row Dental",
  "Orchid Bay Hotel",
  "Granite Peak Outfitters",
  "Silverline Clinic",
  "Copperleaf Bakery",
  "Harbor Lights Realty",
  "Juniper Labs",
  "Riverbend Library",
];
const NEW_CUSTOMERS = [
  "Quillfeather Books",
  "Saltmarsh Brewing",
  "Tidewater Robotics",
  "Lumen & Vine Florists",
  "Basalt Engineering",
  "Wrenfield Academy",
];

export function companies(seed: number, count: number, level: Level) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  return Array.from({ length: count }, (_, i): Company => {
    const n = String(i + 1).padStart(2, "0");
    const missingCustomer = level >= 3 && r() < 0.3;
    const duplicate = level >= 3 && !missingCustomer && r() < 0.25;
    const a = pick(PRODUCTS);
    const b = pick(PRODUCTS.filter((x) => x !== a));
    return {
      id: `W${n}`,
      db: `c${n}`,
      version: level >= 1 ? pick(["16", "17", "18"] as const) : "17",
      lang:
        level >= 1
          ? pick(["en_US", "fr_FR", "de_DE", "es_ES"] as const)
          : "en_US",
      layout:
        level >= 2
          ? pick(["default", "top", "after_date"] as const)
          : "default",
      notice: level >= 2 ? 8000 + Math.floor(r() * 60000) : null,
      order: {
        customer: missingCustomer ? pick(NEW_CUSTOMERS) : pick(CUSTOMERS),
        po: `PO-${1000 + Math.floor(r() * 9000)}`,
        lines: [
          { product: a!, qty: 1 + Math.floor(r() * 9) },
          { product: b!, qty: 1 + Math.floor(r() * 9) },
        ],
      },
      missingCustomer,
      duplicate,
    };
  });
}

/** The task table row an agent (or script) is given for one company. */
export function row(c: Company): Record<string, string> {
  return {
    customer: c.order.customer,
    po: c.order.po,
    product1: c.order.lines[0]!.product,
    qty1: String(c.order.lines[0]!.qty),
    product2: c.order.lines[1]!.product,
    qty2: String(c.order.lines[1]!.qty),
  };
}

export const TASK =
  "Each surface is a different company's Odoo, open in the Sales app; companies may use other Odoo versions, languages or form layouts. For each surface, enter that company's order from its row of the task table: a quotation for the customer, with the Customer Reference set to the row's po, the two products with their quantities, then confirm it so it becomes a sales order. If the customer does not exist yet, create it (as a company) from the customer field. If a sales order with that Customer Reference already exists, do not create another one. Dismiss notices that pop up. Use only the Odoo interface. Declare each surface done when its order is confirmed (or found to exist already). Unknown or delivered inputs must not be repeated.";

export function cashCompanies(seed: number, count: number): Company[] {
  const cases = [
    {
      customer: CUSTOMERS[0]!,
      missingCustomer: false,
      duplicate: false,
      layout: "default",
      notice: null,
    },
    {
      customer: "Quillfeather Books",
      missingCustomer: true,
      duplicate: false,
      layout: "default",
      notice: null,
    },
    {
      customer: CUSTOMERS[2]!,
      missingCustomer: false,
      duplicate: true,
      layout: "default",
      notice: null,
    },
    {
      customer: CUSTOMERS[3]!,
      missingCustomer: false,
      duplicate: false,
      layout: "after_date",
      notice: 8000,
    },
  ] as const;
  return companies(seed, count, 3).map((c, i) => {
    const k = cases[i % cases.length]!;
    return {
      ...c,
      version: "17",
      lang: "en_US",
      layout: k.layout,
      notice: k.notice,
      missingCustomer: k.missingCustomer,
      duplicate: k.duplicate,
      order: { ...c.order, customer: k.customer },
    };
  });
}

export type Workflow = "order-to-cash";

export function workflowModules(workflow?: Workflow) {
  return workflow === "order-to-cash"
    ? "sale_management,stock,account,l10n_generic_coa"
    : "sale_management";
}

export const CASH_TASK =
  "Each surface is a different company's Odoo, starting in Sales. Use only the Odoo interface. For each surface, complete the whole order-to-cash workflow from its task-table row. If the customer does not exist, create it as a company. If a sales order with that Customer Reference already exists, use that order and do not create another; otherwise create and confirm the quotation with the exact customer, reference, products, quantities and prices. Validate the delivery so every ordered unit is done. Create the invoice for that order, post it, and register full payment so it is paid and reconciled. Dismiss notices. Do not alter ordered quantities or prices and do not create duplicate orders, deliveries, invoices or payments. Declare a surface done only after its confirmed order, completed delivery, posted invoice and reconciled full payment are all visible. Unknown or delivered inputs must not be repeated.";
