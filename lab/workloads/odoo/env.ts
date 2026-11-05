/**
 * The E5 environment: real Odoo companies on Docker hosts, one database and
 * one Odoo server per company and a shared PostgreSQL per host. A local
 * headless Chrome reaches each company through an SSH forward.
 *
 *   provision  create every company's database, seed it, keep a template
 *   reset      restore every database from its template (before each arm)
 *   surfaces   log a fresh browser context into each company (CDP surfaces)
 *   grade      read the orders back from each database
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  Cdp,
  CdpSurfacePort,
  sameScreen,
} from "../../../packages/virtual-screen/src/cdp.js";
import type { Frame } from "../../../packages/virtual-screen/src/index.js";
import { createHash } from "node:crypto";
import { Tunnel, free } from "../../../packages/desktop/src/fleet.js";
import { host, type SshHost } from "../host.js";
import { Odoo } from "./rpc.js";
import {
  companies,
  CUSTOMERS,
  PRODUCTS,
  type Company,
  type Level,
} from "./scenario.js";

export type EnvFile = {
  level: Level;
  seed: number;
  hosts: SshHost[];
  companies: (Company & { host: number; port: number })[];
  images: Record<string, string>;
  /** First local forward port (one per company); distinct per environment so
   * several can be attached at once. */
  local_port?: number;
};

const LOCAL_ODOO = 21000; // + company index
/** Onboarding tours a fresh Odoo 16/17 database starts for the admin. */
const TOURS = [
  "sale_tour",
  "sale_quote_tour",
  "main_flow_tour",
  "account_tour",
  "sale_product_configurator_tour",
];
const odooArgs = (c: { db: string }) =>
  `-- -d ${c.db} --db-filter=^${c.db}\\$ --without-demo=all`;
const env = "-e HOST=pg -e USER=odoo -e PASSWORD=odoo";

/** Runs async jobs with at most `n` at a time. */
async function limit<T>(n: number, jobs: (() => Promise<T>)[]) {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]!();
      }
    }),
  );
  return out;
}

export class OdooEnv {
  private constructor(
    readonly file: EnvFile,
    private readonly tunnels: Tunnel[],
  ) {}

  /** Forwards for every Odoo server and every host's Chrome. */
  static async attach(path: string) {
    const file = JSON.parse(await readFile(path, "utf8")) as EnvFile;
    const base = file.local_port ?? LOCAL_ODOO;
    for (const [i] of file.companies.entries()) await free(base + i);
    const tunnels = file.hosts.map(
      (h, hi) =>
        new Tunnel([
          ...h.options,
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ControlPath=none",
          ...file.companies.flatMap((c, i) =>
            c.host === hi ? ["-L", `${base + i}:127.0.0.1:${c.port}`] : [],
          ),
          h.destination,
        ]),
    );
    const e = new OdooEnv(file, tunnels);
    await e.ready();
    return e;
  }

  static async provision(
    path: string,
    hosts: SshHost[],
    level: Level,
    seed: number,
    count: number,
  ) {
    const list = companies(seed, count, level).map((c, i) => ({
      ...c,
      host: i % hosts.length,
      port: 8100 + i,
    }));
    await Promise.all(
      hosts.map(async (h, hi) => {
        const sh = host(h).sh;
        await sh(
          `docker network create e5 >/dev/null 2>&1; docker ps -aq --filter label=e5 | xargs -r docker rm -f >/dev/null; ` +
            `docker run -d --name pg --label e5 --network e5 -e POSTGRES_USER=odoo -e POSTGRES_PASSWORD=odoo -e POSTGRES_DB=postgres postgres:16 -c max_connections=600 >/dev/null; ` +
            `for i in $(seq 60); do docker exec pg pg_isready -U odoo >/dev/null 2>&1 && break; sleep 1; done`,
        );
        const mine = list.filter((c) => c.host === hi);
        await limit(
          4,
          mine.map(
            (c) => () =>
              sh(
                `docker run --rm --network e5 ${env} odoo:${c.version} -- -d ${c.db} -i sale_management --without-demo=all --stop-after-init` +
                  (c.lang === "en_US" ? "" : ` --load-language=${c.lang}`) +
                  ` >/tmp/init-${c.db}.log 2>&1`,
              ),
          ),
        );
        for (const c of mine)
          await sh(
            `docker run -d --name o-${c.db} --label e5 --network e5 -p 127.0.0.1:${c.port}:8069 ${env} odoo:${c.version} ${odooArgs(c)} >/dev/null`,
          );
      }),
    );
    const images: Record<string, string> = {};
    for (const v of ["16", "17", "18", "pg"]) {
      const name = v === "pg" ? "postgres:16" : `odoo:${v}`;
      images[name] = (
        await host(hosts[0]!).sh(
          `docker image inspect --format '{{index .RepoDigests 0}}' ${name}`,
        )
      ).trim();
    }
    const file: EnvFile = {
      level,
      seed,
      hosts,
      companies: list,
      images,
      local_port: Number(process.env.E5_LOCAL_PORT ?? LOCAL_ODOO),
    };
    await writeFile(path, JSON.stringify(file, null, 2));
    const e = await OdooEnv.attach(path);
    try {
      await limit(
        8,
        list.map((c, i) => () => e.seed(c, i)),
      );
      await e.snapshot();
    } finally {
      e.close();
    }
  }

  private url(i: number) {
    return `http://127.0.0.1:${(this.file.local_port ?? LOCAL_ODOO) + i}`;
  }

  /** Waits until every Odoo answers through its forward. */
  private async ready(timeoutMs = 900_000) {
    const end = Date.now() + timeoutMs;
    await Promise.all(
      this.file.companies.map(async (c, i) => {
        for (;;) {
          try {
            const r = await fetch(`${this.url(i)}/web/login`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (r.ok) return;
          } catch {}
          if (Date.now() > end) throw Error(`odoo_not_ready:${c.db}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }),
    );
  }

  /** The company's starting data: products, customers, its form layout and
   * (L3) the order that was already entered. */
  private async seed(c: Company, i: number) {
    const o = await Odoo.login(this.url(i), c.db);
    await o.run("res.users", "write", [[o.user], { lang: c.lang }]);
    // Onboarding tours off, as for a user past their first day (their
    // pulsing tips would also keep every screen changing).
    if (c.version === "18")
      await o.run("res.users", "write", [[o.user], { tour_enabled: false }]);
    else
      for (const name of TOURS)
        await o.run("web_tour.tour", "create", [{ name, user_id: o.user }]);
    const products: Record<string, number> = {};
    for (const [k, name] of PRODUCTS.entries())
      products[name] = await o.run("product.product", "create", [
        { name, list_price: 40 + 35 * k, sale_ok: true },
      ]);
    const partners: Record<string, number> = {};
    for (const name of CUSTOMERS)
      partners[name] = await o.run("res.partner", "create", [
        { name, is_company: true },
      ]);
    if (c.layout !== "default") {
      const [form] = await o.run(
        "ir.model.data",
        "search_read",
        [
          [
            ["module", "=", "sale"],
            ["name", "=", "view_order_form"],
          ],
        ],
        { fields: ["res_id"] },
      );
      const anchor = c.layout === "top" ? "partner_id" : "validity_date";
      await o.run("ir.ui.view", "create", [
        {
          name: "e5.company.layout",
          model: "sale.order",
          inherit_id: form.res_id,
          arch: `<data><xpath expr="//field[@name='${anchor}']" position="after"><field name="client_order_ref" position="move"/></xpath></data>`,
        },
      ]);
    }
    if (c.duplicate) {
      const id = await o.run("sale.order", "create", [
        {
          partner_id: partners[c.order.customer],
          client_order_ref: c.order.po,
          order_line: c.order.lines.map((l) => [
            0,
            0,
            { product_id: products[l.product], product_uom_qty: l.qty },
          ]),
        },
      ]);
      await o.run("sale.order", "action_confirm", [[id]]);
    }
  }

  /** Keeps each seeded database as its template. */
  private async snapshot() {
    await Promise.all(
      this.file.hosts.map((h, hi) =>
        host(h).sh(
          this.file.companies
            .filter((c) => c.host === hi)
            .map(
              (c) =>
                `docker stop o-${c.db} >/dev/null && docker exec pg psql -q -U odoo -d postgres -c 'DROP DATABASE IF EXISTS ${c.db}_tpl' -c 'CREATE DATABASE ${c.db}_tpl TEMPLATE ${c.db}' && docker start o-${c.db} >/dev/null`,
            )
            .join(" && "),
        ),
      ),
    );
    await this.ready();
  }

  /** Every company back to its seeded state; a fresh browser. */
  async reset() {
    await Promise.all(
      this.file.hosts.map((h, hi) =>
        host(h).sh(
          this.file.companies
            .filter((c) => c.host === hi)
            .map(
              (c) =>
                `docker stop o-${c.db} >/dev/null && docker exec pg psql -q -U odoo -d postgres -c 'DROP DATABASE IF EXISTS ${c.db} WITH (FORCE)' -c 'CREATE DATABASE ${c.db} TEMPLATE ${c.db}_tpl' && docker start o-${c.db} >/dev/null`,
            )
            .join(" && "),
        ),
      ),
    );
    await this.ready();
  }

  /** Agent surfaces over the pages from `pages`. */
  async surfaces(directory: string, width = 1280, height = 800) {
    return CdpSurfacePort.connect(
      await this.pages(directory, width, height),
      join(directory, "input-journal.jsonl"),
    );
  }

  /** One settled, logged-in Sales page per company: a dedicated local
   * headless Chrome (never a user's profile), one browser context per company,
   * reaching its Odoo through the company's forward. The browser stays local so
   * a dropped path to a host interrupts only that company's requests, never the
   * control connection. */
  async pages(directory: string, width = 1280, height = 800) {
    const profile = join(directory, "chrome-profile");
    this.chrome = spawn(
      process.env.CU_CHROME ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        `--window-size=${width},${height}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let lines: string[] = [];
    for (let i = 0; i < 100 && !lines[1]; i++) {
      lines = await readFile(join(profile, "DevToolsActivePort"), "utf8")
        .then((t) => t.trim().split("\n"))
        .catch(() => []);
      if (!lines[1]) await new Promise((r) => setTimeout(r, 100));
    }
    if (!lines[1]) throw Error("chrome_not_ready");
    const base = `127.0.0.1:${lines[0]}`;
    const browser = await Cdp.connect(`ws://${base}${lines[1]}`);
    const routes = await limit(
      8,
      this.file.companies.map((c, ci) => async () => {
        const origin = this.url(ci);
        // Log in from here; the browser context receives the session cookie.
        const auth = await fetch(`${origin}/web/session/authenticate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            params: { db: c.db, login: "admin", password: "admin" },
          }),
          signal: AbortSignal.timeout(120_000),
        });
        const session = /session_id=([^;]+)/.exec(
          auth.headers.get("set-cookie") ?? "",
        )?.[1];
        if (!session) throw Error(`browser_login_failed:${c.db}`);
        const { browserContextId } = await browser.call(
          "Target.createBrowserContext",
        );
        await browser.call("Storage.setCookies", {
          browserContextId,
          cookies: [
            {
              name: "session_id",
              value: session,
              domain: "127.0.0.1",
              path: "/",
              httpOnly: true,
            },
          ],
        });
        const { targetId } = await browser.call("Target.createTarget", {
          url: "about:blank",
          browserContextId,
        });
        const websocket_url = `ws://${base}/devtools/page/${targetId}`;
        const page = await Cdp.connect(websocket_url);
        await page.call("Page.enable");
        await page.call("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });
        await page.call("Page.setWebLifecycleState", { state: "active" });
        await page.call("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        // A steady (non-blinking) text caret, like the system setting.
        await page.call("Page.addScriptToEvaluateOnNewDocument", {
          source: STEADY_CARET,
        });
        if (c.notice !== null)
          await page.call("Page.addScriptToEvaluateOnNewDocument", {
            source: noticeScript(c),
          });
        await page.call("Page.navigate", {
          url:
            c.version === "18"
              ? `${origin}/odoo/action-sale.action_quotations_with_onboarding`
              : `${origin}/web#action=sale.action_quotations_with_onboarding`,
        });
        await waitFor(
          page,
          "!!document.querySelector('.o_action_manager .o_control_panel')",
          180_000,
        ).catch(async (e) => {
          const s = await page.call("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(
            join(directory, `not-ready-${c.id}.png`),
            Buffer.from(s.data, "base64"),
          );
          throw e;
        });
        // Hand the page over once it has settled (late images, fade-ins):
        // two captures a second apart show the same screen.
        let last: Frame | null = null;
        for (let i = 0; i < 30; i++) {
          const shot = await page.call("Page.captureScreenshot", {
            format: "png",
          });
          const png = Buffer.from(shot.data, "base64");
          const now = {
            revision: createHash("sha256").update(png).digest("hex"),
            width,
            height,
            png,
          } as Frame;
          if (last && (await sameScreen(last, now))) break;
          last = now;
          await new Promise((r) => setTimeout(r, 1000));
        }
        page.close();
        return { surface_id: c.id, websocket_url };
      }),
    );
    browser.close();
    return routes;
  }

  /** Reads each company's orders for its Customer Reference. */
  async grade() {
    return limit(
      8,
      this.file.companies.map((c, i) => async () => {
        const o = await Odoo.login(this.url(i), c.db);
        const orders = await o.run<any[]>(
          "sale.order",
          "search_read",
          [[["client_order_ref", "=", c.order.po]]],
          { fields: ["partner_id", "state", "order_line"] },
        );
        const all = await o.run<number>("sale.order", "search_count", [[]]);
        const lines = orders.length
          ? await o.run<any[]>(
              "sale.order.line",
              "read",
              [orders.flatMap((x) => x.order_line)],
              {
                fields: [
                  "order_id",
                  "product_id",
                  "product_uom_qty",
                  "display_type",
                ],
              },
            )
          : [];
        const one = orders.length === 1 ? orders[0] : null;
        // The customer: one partner of that name, a company (the task asks
        // to create a missing customer as a company, and only once).
        const partners = await o.run<any[]>(
          "res.partner",
          "search_read",
          [[["name", "=", c.order.customer]]],
          { fields: ["is_company"], context: { active_test: false } },
        );
        const got = lines
          .filter((l) => one && l.order_id[0] === one.id && !l.display_type)
          .map((l) => `${l.product_id[1]}×${l.product_uom_qty}`)
          .sort();
        const want = c.order.lines.map((l) => `${l.product}×${l.qty}`).sort();
        const correct =
          !!one &&
          ["sale", "done"].includes(one.state) &&
          one.partner_id?.[1] === c.order.customer &&
          partners.length === 1 &&
          partners[0].is_company === true &&
          JSON.stringify(got) === JSON.stringify(want);
        return {
          surface_id: c.id,
          success: correct && all === 1,
          // A wrong record exists: a duplicate, a wrong order, or an extra one.
          wrong:
            orders.length > 1 || all > 1 || (orders.length === 1 && !correct),
          commits: orders.length,
          correct_items: correct && all === 1 ? 1 : 0,
          detail: {
            expected: c.order,
            orders,
            lines: got,
            all_orders: all,
            partners,
          },
        };
      }),
    );
  }

  private chrome: ChildProcess | null = null;
  close() {
    this.chrome?.kill("SIGTERM");
    for (const t of this.tunnels) t.close();
  }
}

async function evaluate(page: Cdp, expression: string) {
  const r = await page.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r.result?.value;
}
async function waitFor(page: Cdp, condition: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(page, condition).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  const at = await evaluate(
    page,
    "location.href + ' | ' + document.title",
  ).catch(() => "?");
  throw Error(`page_not_ready:${condition}:${at}`);
}

const STEADY_CARET = `(() => {
  const add = () => {
    const s = document.createElement("style");
    s.textContent = "*, *::before, *::after { caret-animation: manual !important; }";
    (document.head || document.documentElement).append(s);
  };
  if (document.documentElement) add();
  else document.addEventListener("DOMContentLoaded", add);
})();`;

const NOTICE: Record<Company["lang"], [string, string]> = {
  en_US: [
    "Scheduled maintenance tonight at 22:00. Please save your work.",
    "Got it",
  ],
  fr_FR: [
    "Maintenance planifiée ce soir à 22h00. Veuillez enregistrer votre travail.",
    "Compris",
  ],
  de_DE: [
    "Geplante Wartung heute um 22:00 Uhr. Bitte speichern Sie Ihre Arbeit.",
    "Verstanden",
  ],
  es_ES: [
    "Mantenimiento programado esta noche a las 22:00. Guarde su trabajo.",
    "Entendido",
  ],
};
/** A notice that covers the screen once per session, after a delay. */
function noticeScript(c: Company) {
  const [text, button] = NOTICE[c.lang];
  return `(() => {
  if (sessionStorage.getItem('e5-notice')) return;
  setTimeout(() => {
    if (sessionStorage.getItem('e5-notice') || !document.body) return;
    sessionStorage.setItem('e5-notice', '1');
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(20,20,30,.55);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;padding:28px 32px;border-radius:8px;max-width:420px;font:16px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)';
    const p = document.createElement('p');
    p.textContent = ${JSON.stringify(text)};
    const b = document.createElement('button');
    b.textContent = ${JSON.stringify(button)};
    b.style.cssText = 'margin-top:12px;padding:8px 18px;font:15px sans-serif';
    b.onclick = () => d.remove();
    box.append(p, b);
    d.append(box);
    document.body.append(d);
  }, ${c.notice});
})();`;
}
