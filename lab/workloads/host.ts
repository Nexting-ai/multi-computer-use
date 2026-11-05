import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

const run = promisify(execFile);

/** An SSH host from a workload's `hosts` entry ({destination, options}). */
export type SshHost = { destination: string; options: string[] };

/** Retry when SSH never opened a session (nothing ran twice), or, for
 * idempotent transfers, whenever the connection dropped. */
async function retry<T>(f: () => Promise<T>, idempotent = false): Promise<T> {
  const until = Date.now() + 20 * 60_000;
  for (let attempt = 1; ; attempt++)
    try {
      return await f();
    } catch (e: any) {
      const unreached =
        /Connection (to \S+ port \d+ )?(closed|reset|refused|timed out)|Operation timed out|No route to host|kex_exchange|banner exchange/i.test(
          String(e?.stderr ?? e),
        );
      const dropped = idempotent && /ssh 255/.test(String(e?.message));
      // Up to twenty minutes: cross-border paths drop for several minutes.
      if (!(unreached || dropped) || Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, Math.min(60_000, 5000 * attempt)));
    }
}

/** Shell, upload and download on one host (files stream over SSH). */
export function host(h: SshHost) {
  const pipe = (cmd: string, from?: string, to?: string) =>
    retry(
      () =>
        new Promise<void>((resolve, reject) => {
          const p = spawn("ssh", [...h.options, h.destination, cmd], {
            stdio: [from ? "pipe" : "ignore", to ? "pipe" : "ignore", "pipe"],
          });
          let stderr = "";
          p.stderr!.on("data", (c) => (stderr += c));
          // Uploads are gzipped in flight (.blend files shrink ~10x).
          if (from)
            createReadStream(from)
              .pipe(createGzip({ level: 1 }))
              .pipe(p.stdin!);
          if (to) p.stdout!.pipe(createWriteStream(to));
          p.on("error", reject);
          p.on("close", (code) =>
            code === 0
              ? resolve()
              : reject(Object.assign(Error(`ssh ${code}`), { stderr })),
          );
        }),
      true,
    );
  return {
    sh: (cmd: string) =>
      retry(() =>
        run("ssh", [...h.options, h.destination, cmd], { maxBuffer: 1 << 28 }),
      ).then((r) => r.stdout),
    put: (local: string, remote: string) =>
      pipe(`gzip -dc > '${remote}'`, local),
    get: (remote: string, local: string) =>
      pipe(`cat '${remote}'`, undefined, local),
  };
}
