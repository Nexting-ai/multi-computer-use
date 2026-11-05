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
 */
import { rng } from "../../benchmark/metrics.js";

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
