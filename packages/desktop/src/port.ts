import type {
  Action,
  Delivery,
  Frame,
  Rect,
  SurfacePort,
  TextNode,
} from "@cu/virtual-screen";

/**
 * A fleet of desktop containers seen through their agents (see agent.ts).
 * Text comes from OCR of the captured frame, so it is bound to that frame by
 * construction; the agent rejects input when the screen has changed since.
 */
export class DesktopPort implements SurfacePort {
  readonly textChannel = "ocr" as const;
  constructor(
    /** surface id -> agent base URL */
    private readonly agents: ReadonlyMap<string, string>,
    private readonly timeoutMs = 60_000,
    /** surface id -> the desktop's identity, sent with every request */
    private readonly ids: ReadonlyMap<string, string> = new Map(),
  ) {}
  private url(surface: string, path: string) {
    const base = this.agents.get(surface);
    if (!base) throw Error("unknown_surface");
    return base + path;
  }
  /** Requests retry while the path is down (a tunnel reconnecting, a stale
   * connection reset). /execute too: the agent runs each operation_id at
   * most once and answers a repeat with its outcome. */
  private async call<T>(
    surface: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++)
      try {
        return await this.once<T>(surface, path, body);
      } catch (e) {
        const unreachable = /fetch failed|ECONNREFUSED|ECONNRESET/.test(
          String((e as any)?.cause ?? e),
        );
        if (!unreachable || attempt >= 6) throw e;
        await new Promise((r) => setTimeout(r, 2500 * attempt));
      }
  }
  private async once<T>(
    surface: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const r = await fetch(this.url(surface, path), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(this.ids.has(surface)
          ? { "x-desktop-id": this.ids.get(surface)! }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const v = (await r.json()) as T & { error?: string };
    if (!r.ok) throw Error(v.error ?? `agent_${r.status}`);
    return v;
  }
  async capture(surface: string): Promise<Frame> {
    const f = await this.call<{
      epoch: string;
      revision: string;
      width: number;
      height: number;
      png: string;
    }>(surface, "/frame");
    return {
      surface_id: surface,
      route_id: surface,
      // The agent's boot id: a restarted desktop is a different epoch.
      epoch: hash32(f.epoch),
      revision: f.revision,
      width: f.width,
      height: f.height,
      png: Buffer.from(f.png, "base64"),
    };
  }
  async readText(frame: Frame): Promise<TextNode[]> {
    const r = await this.call<{ nodes: TextNode[] }>(
      frame.surface_id,
      "/text",
      {
        revision: frame.revision,
      },
    );
    return r.nodes;
  }
  /** OCR of a fresh frame; with a region, only that part is recognised. */
  async probeText(surface: string, region?: Rect): Promise<TextNode[]> {
    return (
      await this.call<{ nodes: TextNode[] }>(surface, "/probe", { region })
    ).nodes;
  }
  async execute(
    frame: Frame,
    actions: Action[],
    operation_id: string,
  ): Promise<Delivery> {
    try {
      return await this.call<Delivery>(frame.surface_id, "/execute", {
        revision: frame.revision,
        actions,
        operation_id,
      });
    } catch (e) {
      // The request may have reached the agent: the effect is uncertain.
      return { status: "unknown", reason: String(e).slice(0, 120) };
    }
  }
}

function hash32(s: string) {
  let h = 0;
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return h >>> 0;
}
