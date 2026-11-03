import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DesktopPort } from "./port.js";

const run = promisify(execFile);

/** A Docker host: this machine, or a server reached over SSH. */
export type DockerHost =
  { kind: "local" } | { kind: "ssh"; destination: string; options: string[] };

export type FleetOptions = {
  hosts: DockerHost[];
  /** Image built from image/Dockerfile for one application. */
  image: string;
  count: number;
  /** Distinguishes containers of concurrent fleets on a shared host. */
  name: string;
  /** First host port; desktop i listens on 127.0.0.1:(port + i). */
  port?: number;
  /** Environment for every desktop (e.g. which starting scene to open). */
  env?: Record<string, string>;
  /** Per-desktop resource limits. */
  cpus?: number;
  memory?: string;
  ready_timeout_ms?: number;
};

/**
 * N desktops of one application, spread round-robin over Docker hosts. Each
 * desktop is its own container (own display, own app process, own files);
 * agent ports bind to the host's loopback and are reached through one SSH
 * tunnel per remote host.
 */
export class DesktopFleet {
  private constructor(
    readonly surfaces: string[],
    readonly port: DesktopPort,
    private readonly placement: Map<
      string,
      { host: DockerHost; container: string }
    >,
    private readonly tunnels: ChildProcess[],
  ) {}

  static async launch(o: FleetOptions): Promise<DesktopFleet> {
    const base = o.port ?? 17000;
    const surfaces = Array.from(
      { length: o.count },
      (_, i) => `W${String(i + 1).padStart(2, "0")}`,
    );
    const placement = new Map<
      string,
      { host: DockerHost; container: string }
    >();
    const agents = new Map<string, string>();
    const forwards = new Map<DockerHost, string[]>();
    await Promise.all(
      surfaces.map(async (id, i) => {
        const host = o.hosts[i % o.hosts.length]!;
        const container = `${o.name}-${id}`;
        const port = base + i;
        await docker(host, ["rm", "-f", container]).catch(() => {});
        await docker(host, [
          "run",
          "-d",
          "--name",
          container,
          "-p",
          `127.0.0.1:${port}:7000`,
          ...(o.cpus
            ? // Software GL renders with as many threads as it has CPUs.
              [
                "--cpus",
                String(o.cpus),
                "-e",
                `LP_NUM_THREADS=${Math.max(1, Math.round(o.cpus))}`,
              ]
            : []),
          ...(o.memory ? ["--memory", o.memory] : []),
          ...Object.entries(o.env ?? {}).flatMap(([k, v]) => [
            "-e",
            `${k}=${v}`,
          ]),
          o.image,
        ]);
        placement.set(id, { host, container });
        agents.set(id, `http://127.0.0.1:${port}`);
        if (host.kind === "ssh")
          forwards.set(host, [
            ...(forwards.get(host) ?? []),
            "-L",
            `${port}:127.0.0.1:${port}`,
          ]);
      }),
    );
    const tunnels = [...forwards].map(([host, args]) => {
      if (host.kind !== "ssh") throw Error("unreachable");
      return spawn(
        "ssh",
        [
          ...host.options,
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          // A tunnel is its own connection: a multiplexed client would hand
          // the forwards to a shared master and exit.
          "-o",
          "ControlMaster=no",
          "-o",
          "ControlPath=none",
          ...args,
          host.destination,
        ],
        { stdio: "ignore" },
      );
    });
    const fleet = new DesktopFleet(
      surfaces,
      new DesktopPort(agents),
      placement,
      tunnels,
    );
    try {
      await fleet.ready(o.ready_timeout_ms ?? 180_000);
    } catch (e) {
      await fleet.close();
      throw e;
    }
    return fleet;
  }

  /** Waits until every agent serves a frame. */
  private async ready(timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    await Promise.all(
      this.surfaces.map(async (id) => {
        for (;;) {
          try {
            await this.port.capture(id);
            return;
          } catch (e) {
            if (Date.now() > end) throw Error(`desktop_not_ready:${id}:${e}`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }),
    );
  }

  /** Runs a command inside a desktop (graders, artifact export). */
  async exec(id: string, argv: string[]): Promise<string> {
    const p = this.placement.get(id);
    if (!p) throw Error("unknown_surface");
    return docker(p.host, ["exec", p.container, ...argv], 600_000);
  }

  /** Copies a desktop's /work directory (task files, input journal). */
  async collect(id: string, dir: string) {
    const p = this.placement.get(id)!;
    await mkdir(dir, { recursive: true });
    const tar = await docker(
      p.host,
      ["exec", p.container, "tar", "-C", "/work", "-cf", "-", "."],
      600_000,
      "buffer",
    );
    await writeFile(join(dir, "work.tar"), tar);
  }

  async close() {
    for (const t of this.tunnels) t.kill();
    await Promise.all(
      [...this.placement.values()].map(({ host, container }) =>
        docker(host, ["rm", "-f", container]).catch(() => {}),
      ),
    );
  }
}

function docker(
  host: DockerHost,
  args: string[],
  timeout?: number,
): Promise<string>;
function docker(
  host: DockerHost,
  args: string[],
  timeout: number,
  encoding: "buffer",
): Promise<Buffer>;
async function docker(
  host: DockerHost,
  args: string[],
  timeout = 120_000,
  encoding: "utf8" | "buffer" = "utf8",
): Promise<string | Buffer> {
  const argv =
    host.kind === "local"
      ? ["docker", ...args]
      : [
          "ssh",
          ...host.options,
          host.destination,
          ["docker", ...args].map(quote).join(" "),
        ];
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await run(argv[0]!, argv.slice(1), {
        timeout,
        maxBuffer: 1 << 30,
        encoding,
      });
      return stdout;
    } catch (e: any) {
      // Retry only when SSH itself failed to connect: the remote command
      // never started, so nothing can have happened twice.
      const unreached =
        host.kind === "ssh" &&
        e.code === 255 &&
        /Connection (closed|reset|refused|timed out)|kex_exchange|banner exchange/i.test(
          String(e.stderr),
        );
      if (!unreached || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const quote = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
