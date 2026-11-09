import type { Company, Line } from "./scenario.js";
import type { Score } from "../types.js";

type Ref = (number | string)[];
type ExpectedLine = Line & { price: number };

export type CashEvidence = {
  all_orders: number;
  all_pickings: number;
  all_invoices: number;
  all_payments: number;
  orders: {
    id: number;
    name: string;
    partner_id: Ref;
    state: string;
    amount_total: number;
    picking_ids: number[];
    invoice_ids: number[];
  }[];
  lines: {
    order_id: Ref;
    product_id: Ref;
    product_uom_qty: number;
    price_unit: number;
    display_type: string | false | null;
  }[];
  partners: { is_company: boolean }[];
  pickings: {
    id: number;
    state: string;
    origin: string;
    move_ids: number[];
  }[];
  moves: {
    product_id: Ref;
    product_uom_qty: number;
    quantity: number;
    state: string;
  }[];
  invoices: {
    id: number;
    state: string;
    payment_state: string;
    move_type: string;
    invoice_origin: string;
    amount_total: number;
    invoice_line_ids: number[];
  }[];
  invoice_lines: {
    product_id: Ref;
    quantity: number;
    price_unit: number;
    display_type: string | false | null;
  }[];
  payments: {
    state: string;
    amount: number;
    reconciled_invoice_ids: number[];
  }[];
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const sorted = (values: string[]) => values.sort();

export function scoreCash(
  c: Company,
  e: CashEvidence,
  expectedLines: ExpectedLine[],
): Score {
  const expectedOrderLines = sorted(
    expectedLines.map((l) => `${l.product}×${l.qty}×${l.price}`),
  );
  const expectedMoves = sorted(
    expectedLines.map((l) => `${l.product}×${l.qty}`),
  );
  const one = e.orders.length === 1 ? e.orders[0]! : null;
  const invoice = e.invoices.length === 1 ? e.invoices[0]! : null;
  const payment = e.payments.length === 1 ? e.payments[0]! : null;

  const orderCorrect =
    !!one &&
    e.all_orders === 1 &&
    ["sale", "done"].includes(one.state) &&
    one.partner_id[1] === c.order.customer &&
    e.partners.length === 1 &&
    e.partners[0]!.is_company === true &&
    same(
      sorted(
        e.lines
          .filter((l) => !l.display_type || l.display_type === "product")
          .map(
            (l) => `${l.product_id[1]}×${l.product_uom_qty}×${l.price_unit}`,
          ),
      ),
      expectedOrderLines,
    );

  const deliveryCorrect =
    !!one &&
    e.all_pickings === 1 &&
    one.picking_ids.length === 1 &&
    e.pickings.length === 1 &&
    e.pickings[0]!.id === one.picking_ids[0] &&
    e.pickings[0]!.state === "done" &&
    e.pickings[0]!.origin === one.name &&
    same(
      sorted(
        e.moves.map(
          (m) => `${m.product_id[1]}×${m.quantity}×${m.product_uom_qty}`,
        ),
      ),
      sorted(expectedLines.map((l) => `${l.product}×${l.qty}×${l.qty}`)),
    ) &&
    e.moves.every((m) => m.state === "done") &&
    same(
      sorted(e.moves.map((m) => `${m.product_id[1]}×${m.quantity}`)),
      expectedMoves,
    );

  const invoiceCorrect =
    !!one &&
    !!invoice &&
    e.all_invoices === 1 &&
    one.invoice_ids.length === 1 &&
    one.invoice_ids[0] === invoice.id &&
    invoice.state === "posted" &&
    invoice.move_type === "out_invoice" &&
    invoice.invoice_origin === one.name &&
    invoice.amount_total === one.amount_total &&
    same(
      sorted(
        e.invoice_lines
          .filter((l) => !l.display_type || l.display_type === "product")
          .map((l) => `${l.product_id[1]}×${l.quantity}×${l.price_unit}`),
      ),
      expectedOrderLines,
    );

  const paymentCorrect =
    !!invoice &&
    !!payment &&
    e.all_payments === 1 &&
    invoice.payment_state === "paid" &&
    payment.state === "posted" &&
    payment.amount === invoice.amount_total &&
    payment.reconciled_invoice_ids.includes(invoice.id);

  return {
    surface_id: c.id,
    success:
      orderCorrect && deliveryCorrect && invoiceCorrect && paymentCorrect,
    wrong:
      e.orders.length > 1 ||
      e.all_orders > 1 ||
      (!!one &&
        ["sale", "done", "cancel"].includes(one.state) &&
        !orderCorrect) ||
      e.all_pickings > 1 ||
      e.pickings.length > 1 ||
      (e.pickings.some((p) => p.state === "done") && !deliveryCorrect) ||
      e.all_invoices > 1 ||
      e.invoices.length > 1 ||
      (!!invoice && invoice.state === "posted" && !invoiceCorrect) ||
      e.all_payments > 1 ||
      e.payments.length > 1 ||
      (!!payment && !paymentCorrect),
    commits: e.orders.length,
    correct_items:
      orderCorrect && deliveryCorrect && invoiceCorrect && paymentCorrect
        ? 1
        : 0,
    detail: {
      expected: c.order,
      checks: {
        order: orderCorrect,
        delivery: deliveryCorrect,
        invoice: invoiceCorrect,
        payment: paymentCorrect,
      },
      evidence: e,
    },
  };
}
