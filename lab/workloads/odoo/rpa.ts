/**
 * Baseline "RPA": a conventional automation script, recorded once on the
 * reference company (L0: Odoo 17, English, default form) and replayed on every
 * company, as a selector-based RPA tool (UiPath, Power Automate) would.
 *
 * It is written the way a careful RPA developer writes one: stable element
 * attributes (field names, button names) rather than labels or coordinates,
 * waits for every element, real mouse and keyboard input, and the first
 * suggestion whose text is the row's value, as recorded. It has no judgement and no
 * knowledge beyond the reference company: no handling of notices, missing
 * customers or orders that already exist. No model is involved; it costs no
 * tokens.
 *
 *   node --import tsx lab/workloads/odoo/rpa.ts <env.json> <out-dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cdp } from "../../../packages/virtual-screen/src/cdp.js";
import { OdooEnv } from "./env.js";
import { row } from "./scenario.js";

const WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Robot {
  constructor(private readonly page: Cdp) {}

  private async eval<T>(expression: string): Promise<T> {
    const r = await this.page.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
    return r.result?.value as T;
  }

  /** Centre of the first visible element matching `selector` (and, if given,
   * whose text is exactly `text`), scrolled into view. */
  private async locate(selector: string, text?: string) {
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) {
      const at = await this.eval<{ x: number; y: number } | null>(
        `(() => {
        const text = ${JSON.stringify(text ?? null)};
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden"
            && (text === null || e.textContent.trim() === text));
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      ).catch(() => null);
      if (at) return at;
      await sleep(250);
    }
    throw Error(`element_not_found:${selector}${text ? ` "${text}"` : ""}`);
  }

  async click(selector: string, text?: string) {
    const { x, y } = await this.locate(selector, text);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await this.page.call("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    await sleep(400);
  }

  async key(key: string, code: string, keyCode: number, commands?: string[]) {
    for (const type of ["keyDown", "keyUp"])
      await this.page.call("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        ...(type === "keyDown" && commands ? { commands } : {}),
      });
  }

  /** Clicks a field, replaces its content and types `text`; checks the field
   * holds it, retrying while the form is still re-rendering. */
  async fill(selector: string, text: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.click(selector);
      await this.key("a", "KeyA", 65, ["selectAll"]);
      await this.key("Backspace", "Backspace", 8);
      await this.page.call("Input.insertText", { text });
      await sleep(300);
      const held = await this.eval<boolean>(
        `document.activeElement?.matches(${JSON.stringify(selector)}) && document.activeElement.value === ${JSON.stringify(text)}`,
      ).catch(() => false);
      if (held) return;
      await sleep(500);
    }
    throw Error(`text_not_held:${selector}`);
  }

  async wait(selector: string) {
    await this.locate(selector);
  }

  /** Clicks `selector` until `done` (a page expression) holds: for a click
   * that the page may swallow while it is still busy with the last edit. */
  async clickUntil(selector: string, done: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.click(selector);
      const end = Date.now() + 5_000;
      while (Date.now() < end) {
        if (await this.eval<boolean>(done).catch(() => false)) return;
        await sleep(200);
      }
    }
    throw Error(`no_effect:${selector}`);
  }

  async count(selector: string) {
    return this.eval<number>(
      `document.querySelectorAll(${JSON.stringify(selector)}).length`,
    );
  }

  /** Picks `text` from the autocomplete under `field`, then waits until the
   * field shows it and the list has closed. */
  async choose(field: string, text: string) {
    await this.click(".o-autocomplete--dropdown-menu .dropdown-item", text);
    const end = Date.now() + WAIT_MS;
    const check = `(() => {
      const f = document.querySelector(${JSON.stringify(field)});
      return !!f && f.value === ${JSON.stringify(text)}
        && !document.querySelector(".o-autocomplete--dropdown-menu");
    })()`;
    while (Date.now() < end) {
      if (await this.eval<boolean>(check).catch(() => false)) return;
      await sleep(200);
    }
    throw Error(`choice_not_held:${field} "${text}"`);
  }

  async shot(path: string) {
    const s = await this.page.call("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(s.data, "base64"));
  }
}

/** The recorded steps: a new quotation, customer, Customer Reference, two
 * product lines with quantities, Confirm. */
async function replay(r: Robot, v: Record<string, string>) {
  await r.click(".o_list_button_add");
  const customer = ".o_form_view div[name='partner_id'] input";
  await r.fill(customer, v.customer!);
  await r.choose(customer, v.customer!);
  await r.click(".o_notebook a[name='other_information']");
  await r.fill(".o_form_view div[name='client_order_ref'] input", v.po!);
  await r.click(".o_notebook a[name='order_lines']");
  const lines: [string, string][] = [
    [v.product1!, v.qty1!],
    [v.product2!, v.qty2!],
  ];
  for (const [product, qty] of lines) {
    // A new, empty line: one more row than before, selected.
    const rows = "div[name='order_line'] tr.o_data_row";
    const before = await r.count(rows);
    await r.clickUntil(
      "div[name='order_line'] .o_field_x2many_list_row_add a:first-child",
      `document.querySelectorAll(${JSON.stringify(rows)}).length > ${before} && document.querySelector("div[name='order_line'] tr.o_selected_row td[name='product_template_id'] input")?.value === ""`,
    );
    const field =
      "div[name='order_line'] .o_selected_row td[name='product_template_id'] input";
    await r.fill(field, product);
    await r.choose(field, product);
    await r.fill(
      "div[name='order_line'] .o_selected_row td[name='product_uom_qty'] input",
      qty,
    );
  }
  await r.click(".o_form_view button[name='action_confirm']");
  await r.wait(
    ".o_form_view .o_statusbar_status button.o_arrow_button_current[data-value='sale']",
  );
}

if (process.argv[1]?.endsWith("rpa.ts")) {
  const [envPath, out] = process.argv.slice(2) as [string, string];
  await mkdir(out, { recursive: true });
  const env = await OdooEnv.attach(envPath);
  const started = Date.now();
  try {
    await env.reset();
    const routes = await env.pages(out);
    const runs = await Promise.all(
      env.file.companies.map(async (c, i) => {
        const page = await Cdp.connect(routes[i]!.websocket_url);
        const r = new Robot(page);
        const t0 = Date.now();
        let error: string | null = null;
        try {
          await replay(r, row(c));
        } catch (e) {
          error = String((e as Error).message ?? e);
        }
        await r.shot(join(out, `${c.id}-end.png`)).catch(() => {});
        page.close();
        return { surface_id: c.id, error, ms: Date.now() - t0 };
      }),
    );
    const elapsed_ms = Date.now() - started;
    await sleep(5_000);
    const scores = await env.grade();
    const result = { arm: "RPA", elapsed_ms, tokens: 0, runs, scores };
    await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
    for (const s of scores) {
      const run = runs.find((x) => x.surface_id === s.surface_id)!;
      console.log(s.surface_id, s.success, s.wrong, run.error ?? "");
    }
  } finally {
    env.close();
  }
  process.exit(0);
}
