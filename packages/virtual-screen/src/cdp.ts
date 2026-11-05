import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import sharp from "sharp";
import {
  Gate,
  type SurfacePort,
  type Frame,
  type Action,
  type Delivery,
  type TextNode,
  TEXT_ROLES,
} from "./index.js";
/** Named interactive controls exposed alongside text (clickable targets). */
const CONTROL_ROLES = [
  "button",
  "checkbox",
  "radio",
  "tab",
  "link",
  "option",
  "menuitem",
  "combobox",
  "slider",
];

/** Transport for an operator-owned, isolated browser. No page JS; the only read
 * channel besides pixels is the accessibility text layer (see readText). */
export class Cdp {
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  closed = false;
  epoch = 0;
  modal = false;
  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const m = JSON.parse(String(event.data));
      if (m.method === "Page.frameNavigated" && !m.params.frame.parentId)
        this.epoch++;
      if (m.method === "Page.frameResized") this.epoch++;
      if (
        ["Page.javascriptDialogOpening", "Page.interstitialShown"].includes(
          m.method,
        )
      )
        this.modal = true;
      if (
        ["Page.javascriptDialogClosed", "Page.interstitialHidden"].includes(
          m.method,
        )
      )
        this.modal = false;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error("target_closed"));
      }
      this.pending.clear();
    });
  }
  static async connect(url: string) {
    const u = new URL(url);
    if (
      u.protocol !== "ws:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
      throw Error("local_dedicated_cdp_required");
    const socket = new WebSocket(url),
      client = new Cdp(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(Error("cdp_connect_timeout"));
      }, 5000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(Error("cdp_connect_failed"));
        },
        { once: true },
      );
    });
    return client;
  }
  call(method: string, params: unknown = {}): Promise<any> {
    if (this.closed) return Promise.reject(Error("target_closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.seq,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Error("cdp_timeout"));
        }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }
  close() {
    this.socket.close();
  }
}
type Route = {
  surface_id: string;
  route_id: string;
  client: Cdp;
  lock: Gate;
  ax?: boolean;
};
/** Share of pixels that may differ while the screen counts as unchanged: a
 * blinking text caret, never a changed control or value (same tolerance as
 * the desktop agent). */
const SAME_SCREEN = 0.0001;
export async function sameScreen(a: Frame, b: Frame) {
  if (a.revision === b.revision) return true;
  if (a.width !== b.width || a.height !== b.height) return false;
  const [x, y] = await Promise.all(
    [a, b].map((f) => sharp(f.png).removeAlpha().raw().toBuffer()),
  );
  let n = 0;
  for (let i = 0; i < x!.length; i += 3)
    if (
      Math.abs(x![i]! - y![i]!) > 24 ||
      Math.abs(x![i + 1]! - y![i + 1]!) > 24 ||
      Math.abs(x![i + 2]! - y![i + 2]!) > 24
    )
      n++;
  return n / (x!.length / 3) <= SAME_SCREEN;
}
export class CdpSurfacePort implements SurfacePort {
  private routes = new Map<string, Route>();
  private journalQueue = Promise.resolve();
  private constructor(private journal: FileHandle) {}
  static async connect(
    routes: { surface_id: string; websocket_url: string }[],
    journalPath: string,
  ) {
    // Multiple labels for one page would bypass per-surface serialization.
    // Validate the entire operator configuration before opening any connection.
    const identities = new Set<string>();
    const destinations = new Set<string>();
    for (const route of routes) {
      if (identities.has(route.surface_id)) throw Error("duplicate_surface");
      identities.add(route.surface_id);
      const url = new URL(route.websocket_url);
      if (!url.pathname.startsWith("/devtools/page/"))
        throw Error("page_target_required");
      const destination = `${url.port || "80"}${url.pathname}`;
      if (destinations.has(destination)) throw Error("duplicate_input_route");
      destinations.add(destination);
    }
    // A reused process journal is never resumed as permission to replay input.
    const port = new CdpSurfacePort(await open(journalPath, "wx", 0o600));
    try {
      for (const r of routes) {
        if (port.routes.has(r.surface_id)) throw Error("duplicate_surface");
        const u = new URL(r.websocket_url);
        if (!u.pathname.startsWith("/devtools/page/"))
          throw Error("page_target_required");
        const client = await Cdp.connect(r.websocket_url);
        port.routes.set(r.surface_id, {
          surface_id: r.surface_id,
          route_id: u.pathname,
          client,
          lock: new Gate(1),
        });
        await client.call("Page.enable");
        // Every surface behaves as a focused, active page: web apps that
        // render on animation frames stall in background targets of a shared
        // browser. (Its blinking caret is within the same-screen tolerance.)
        await client.call("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });
        await client.call("Page.setWebLifecycleState", { state: "active" });
      }
      return port;
    } catch (e) {
      await port.close();
      throw e;
    }
  }
  private route(id: string) {
    const route = this.routes.get(id);
    if (!route) throw Error("unknown_surface");
    return route;
  }
  private log(record: unknown) {
    this.journalQueue = this.journalQueue.then(async () => {
      await this.journal.write(
        JSON.stringify({
          at: new Date().toISOString(),
          ...(record as object),
        }) + "\n",
      );
      await this.journal.sync();
    });
    return this.journalQueue;
  }
  private async captureRoute(r: Route): Promise<Frame> {
    const epoch = r.client.epoch;
    if (r.client.closed || r.client.modal) throw Error("target_unavailable");
    const shot = await r.client.call("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const png = Buffer.from(shot.data, "base64"),
      { data, info } = await sharp(png, { limitInputPixels: 4_000_000 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const metrics = await r.client.call("Page.getLayoutMetrics"),
      viewport = metrics.cssVisualViewport;
    if (
      epoch !== r.client.epoch ||
      r.client.modal ||
      !viewport ||
      viewport.clientWidth !== info.width ||
      viewport.clientHeight !== info.height ||
      viewport.scale !== 1
    )
      throw Error("capture_context_changed_or_scaled");
    return {
      surface_id: r.surface_id,
      route_id: r.route_id,
      epoch,
      revision: createHash("sha256").update(data).digest("hex"),
      width: info.width,
      height: info.height,
      png,
    };
  }
  capture(id: string) {
    const r = this.route(id);
    return r.lock.run(() => this.captureRoute(r));
  }
  private async axNodes(r: Route): Promise<TextNode[]> {
    if (!r.ax) {
      await r.client.call("DOM.enable");
      await r.client.call("Accessibility.enable");
      r.ax = true;
    }
    const { nodes } = await r.client.call("Accessibility.getFullAXTree");
    const wanted = (nodes as any[]).filter(
      (n) =>
        !n.ignored &&
        n.backendDOMNodeId &&
        [...TEXT_ROLES, ...CONTROL_ROLES].includes(n.role?.value) &&
        (TEXT_ROLES.includes(n.role?.value) ||
          String(n.name?.value ?? "").trim() !== ""),
    );
    const located = await Promise.all(
      wanted.map((n) =>
        r.client
          .call("DOM.getContentQuads", { backendNodeId: n.backendDOMNodeId })
          .then((q) => q.quads as number[][])
          .catch(() => [] as number[][]),
      ),
    );
    const out: TextNode[] = [];
    for (const [i, n] of wanted.entries()) {
      const role = n.role.value as string;
      const text = String(
        (role === "textbox" || role === "slider"
          ? n.value?.value
          : n.name?.value) ?? "",
      );
      const prop = (n.properties ?? []).find((q: any) => q.name === "checked");
      const checked =
        prop === undefined
          ? undefined
          : prop.value?.value === "true" || prop.value?.value === true;
      for (const q of located[i]!) {
        const xs = [q[0]!, q[2]!, q[4]!, q[6]!],
          ys = [q[1]!, q[3]!, q[5]!, q[7]!];
        const x = Math.min(...xs),
          y = Math.min(...ys);
        out.push({
          role,
          text,
          ...(checked === undefined ? {} : { checked }),
          rect: {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(Math.max(...xs) - x),
            height: Math.round(Math.max(...ys) - y),
          },
        });
      }
    }
    return out;
  }
  /** Unbound accessibility text for post-condition polling only. Never used
   * to plan input: no frame identity is proven. Journaled like reads. */
  async probeText(surface_id: string): Promise<TextNode[]> {
    const r = this.route(surface_id);
    return r.lock.run(async () => {
      if (r.client.closed || r.client.modal) throw Error("target_unavailable");
      const out = await this.axNodes(r);
      await this.log({
        kind: "probe_text",
        surface_id,
        route_id: r.route_id,
        nodes: out.length,
      });
      return out;
    });
  }
  /** Accessibility text nodes, bound to an unchanged frame. No page JS, no DOM mutation. */
  async readText(frame: Frame): Promise<TextNode[]> {
    const r = this.route(frame.surface_id);
    return r.lock.run(async () => {
      const same = async (f: Frame) =>
        f.route_id === frame.route_id &&
        f.epoch === frame.epoch &&
        (await sameScreen(f, frame));
      if (!(await same(await this.captureRoute(r))))
        throw Error("source_changed_before_read");
      const out = await this.axNodes(r);
      if (!(await same(await this.captureRoute(r))))
        throw Error("source_changed_during_read");
      await this.log({
        kind: "read_text",
        surface_id: r.surface_id,
        route_id: r.route_id,
        epoch: frame.epoch,
        revision: frame.revision,
        nodes: out.length,
      });
      return out;
    });
  }
  async execute(
    frame: Frame,
    actions: Action[],
    operation_id: string,
  ): Promise<Delivery> {
    const r = this.route(frame.surface_id);
    return r.lock.run(async () => {
      let fresh: Frame;
      try {
        fresh = await this.captureRoute(r);
      } catch {
        return { status: "blocked", reason: "target_unavailable_before_input" };
      }
      if (
        fresh.route_id !== frame.route_id ||
        fresh.epoch !== frame.epoch ||
        !(await sameScreen(fresh, frame))
      )
        return { status: "blocked", reason: "source_changed_before_input" };
      await this.log({
        kind: "intent",
        operation_id,
        surface_id: r.surface_id,
        route_id: r.route_id,
        epoch: frame.epoch,
        revision: frame.revision,
        actions,
      });
      let attempted = false;
      try {
        for (const [index, a] of actions.entries()) {
          if (
            r.client.closed ||
            r.client.modal ||
            r.client.epoch !== frame.epoch
          )
            throw Error("input_context_changed");
          // CDP mouse coordinates are CSS pixels; capture rejects non-1:1 views.
          // The dedicated target route is never selected via the global focus.
          attempted = true;
          if (a.kind === "click") {
            await r.client.call("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: a.x,
              y: a.y,
              button: "left",
              clickCount: 1,
            });
            await r.client.call("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: a.x,
              y: a.y,
              button: "left",
              clickCount: 1,
            });
          } else if (a.kind === "type_text")
            await r.client.call("Input.insertText", { text: a.text });
          else {
            const modifiers = a.keys.reduce(
                (n, k) => n | ({ Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 }[k] ?? 0),
                0,
              ),
              key = a.keys.at(-1)!;
            const code: Record<string, number> = {
              Enter: 13,
              Tab: 9,
              Escape: 27,
              Backspace: 8,
              Space: 32,
              ArrowLeft: 37,
              ArrowUp: 38,
              ArrowRight: 39,
              ArrowDown: 40,
              Delete: 46,
              Home: 36,
              End: 35,
              PageUp: 33,
              PageDown: 34,
              // F1..F12
              ...Object.fromEntries(
                Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i]),
              ),
            };
            const params = {
              key: key === "Space" ? " " : key,
              modifiers,
              windowsVirtualKeyCode:
                code[key] ?? key.toUpperCase().charCodeAt(0),
            };
            await r.client.call("Input.dispatchKeyEvent", {
              type: "keyDown",
              ...params,
              ...(key.toLowerCase() === "a" && modifiers & 6
                ? { commands: ["selectAll"] }
                : {}),
            });
            await r.client.call("Input.dispatchKeyEvent", {
              type: "keyUp",
              ...params,
            });
          }
          await this.log({
            kind: "input_ack",
            operation_id,
            index,
            surface_id: r.surface_id,
            route_id: r.route_id,
            action: a,
          });
        }
        await this.log({
          kind: "receipt",
          operation_id,
          surface_id: r.surface_id,
          status: "delivered",
        });
        return { status: "delivered" };
      } catch (e) {
        const result: Delivery = {
          status: attempted ? "unknown" : "blocked",
          reason: String(e),
        };
        await this.log({
          kind: "receipt",
          operation_id,
          surface_id: r.surface_id,
          ...result,
        }).catch(() => {});
        return result;
      }
    });
  }
  async close() {
    for (const r of this.routes.values()) r.client.close();
    await this.journalQueue.catch(() => {});
    await this.journal.close();
  }
}
