import { expect, test } from "vitest";
import * as scenario from "./scenario.js";

test("cash probe covers normal, new-customer, duplicate and interrupted companies", () => {
  expect(typeof scenario.cashCompanies).toBe("function");
  const companies = scenario.cashCompanies(42, 4);

  expect(
    companies.map((c) => ({
      customer: c.order.customer,
      missingCustomer: c.missingCustomer,
      duplicate: c.duplicate,
      layout: c.layout,
      notice: c.notice,
      version: c.version,
      lang: c.lang,
    })),
  ).toEqual([
    {
      customer: "Northwind Traders",
      missingCustomer: false,
      duplicate: false,
      layout: "default",
      notice: null,
      version: "17",
      lang: "en_US",
    },
    {
      customer: "Quillfeather Books",
      missingCustomer: true,
      duplicate: false,
      layout: "default",
      notice: null,
      version: "17",
      lang: "en_US",
    },
    {
      customer: "Alder & Finch Studio",
      missingCustomer: false,
      duplicate: true,
      layout: "default",
      notice: null,
      version: "17",
      lang: "en_US",
    },
    {
      customer: "Kestrel Logistics",
      missingCustomer: false,
      duplicate: false,
      layout: "after_date",
      notice: 8000,
      version: "17",
      lang: "en_US",
    },
  ]);
});

const company = {
  ...scenario.cashCompanies(42, 1)[0]!,
  order: {
    customer: "Northwind Traders",
    po: "PO-1000",
    lines: [{ product: "Office Chair", qty: 2 }],
  },
};

function fullEvidence(overrides: Partial<scenario.CashEvidence> = {}) {
  return {
    all_orders: 1,
    all_pickings: 1,
    all_invoices: 1,
    all_payments: 1,
    orders: [
      {
        id: 1,
        name: "S00001",
        partner_id: [1, "Northwind Traders"],
        state: "sale",
        amount_total: 92,
        picking_ids: [11],
        invoice_ids: [21],
      },
    ],
    lines: [
      {
        order_id: [1, "S00001"],
        product_id: [1, "Office Chair"],
        product_uom_qty: 2,
        price_unit: 40,
        display_type: false as const,
      },
    ],
    partners: [{ is_company: true }],
    pickings: [{ id: 11, state: "done", origin: "S00001", move_ids: [101] }],
    moves: [
      {
        product_id: [1, "Office Chair"],
        product_uom_qty: 2,
        quantity: 2,
        state: "done",
      },
    ],
    invoices: [
      {
        id: 21,
        state: "posted",
        payment_state: "paid",
        move_type: "out_invoice",
        invoice_origin: "S00001",
        amount_total: 92,
        invoice_line_ids: [201],
      },
    ],
    invoice_lines: [
      {
        product_id: [1, "Office Chair"],
        quantity: 2,
        price_unit: 40,
        display_type: "product",
      },
    ],
    payments: [
      {
        state: "posted",
        amount: 92,
        reconciled_invoice_ids: [21],
      },
    ],
    ...overrides,
  };
}

test("cash score requires the complete order-to-cash chain", () => {
  expect(typeof scenario.cashScore).toBe("function");
  const result = scenario.cashScore(company, fullEvidence());

  expect(result.success).toBe(true);
  expect(result.wrong).toBe(false);
  expect(result.correct_items).toBe(1);
});

test.each([
  ["delivery", { pickings: [], all_pickings: 0 }],
  ["invoice", { invoices: [], all_invoices: 0, payments: [], all_payments: 0 }],
  ["payment", { payments: [], all_payments: 0 }],
])("cash score rejects a missing %s", (_step, evidence) => {
  const result = scenario.cashScore(company, fullEvidence(evidence));

  expect(result.success).toBe(false);
  expect(result.wrong).toBe(false);
  expect(result.correct_items).toBe(0);
});

test("cash score distinguishes duplicate orders as wrong records", () => {
  const result = scenario.cashScore(company, fullEvidence({ all_orders: 2 }));

  expect(result.success).toBe(false);
  expect(result.wrong).toBe(true);
});

test("cash score allows finishing an already existing order without recreating it", () => {
  const result = scenario.cashScore(
    { ...company, duplicate: true },
    fullEvidence(),
  );

  expect(result.success).toBe(true);
  expect(result.wrong).toBe(false);
});

test("cash provisioning adds inventory and accounting without changing E5", () => {
  expect(typeof scenario.workflowModules).toBe("function");
  expect(scenario.workflowModules()).toBe("sale_management");
  expect(scenario.workflowModules("order-to-cash")).toBe(
    "sale_management,stock,account,l10n_generic_coa",
  );
});

test("cash score treats an unfinished delivery as incomplete rather than wrong", () => {
  const evidence = fullEvidence();
  evidence.pickings[0]!.state = "assigned";
  evidence.moves[0]!.state = "assigned";
  evidence.moves[0]!.quantity = 0;
  const result = scenario.cashScore(company, evidence);

  expect(result.success).toBe(false);
  expect(result.wrong).toBe(false);
});

test.each(["all_pickings", "all_invoices", "all_payments"])(
  "cash score detects an unlinked duplicate via %s",
  (field) => {
    const result = scenario.cashScore(company, fullEvidence({ [field]: 2 }));

    expect(result.success).toBe(false);
    expect(result.wrong).toBe(true);
  },
);

test("cash score treats a posted but unpaid invoice as incomplete", () => {
  const evidence = fullEvidence({ payments: [], all_payments: 0 });
  evidence.invoices[0]!.payment_state = "not_paid";
  const result = scenario.cashScore(company, evidence);

  expect(result.success).toBe(false);
  expect(result.wrong).toBe(false);
});

test("cash score treats an unconfirmed quotation as incomplete", () => {
  const evidence = fullEvidence({
    pickings: [],
    all_pickings: 0,
    invoices: [],
    all_invoices: 0,
    payments: [],
    all_payments: 0,
  });
  evidence.orders[0]!.state = "draft";
  const result = scenario.cashScore(company, evidence);

  expect(result.success).toBe(false);
  expect(result.wrong).toBe(false);
});
