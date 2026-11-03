import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** An SSH host from a workload's `hosts` entry ({destination, options}). */
export type SshHost = { destination: string; options: string[] };

/** Retry only when SSH never opened a session (nothing ran twice). */
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++)
    try {
      return await f();
    } catch (e: any) {
      const unreached =
        /Connection (closed|reset|refused|timed out)|kex_exchange|banner exchange/i.test(
          String(e?.stderr ?? e),
        );
      if (!unreached || attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
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
          if (from) createReadStream(from).pipe(p.stdin!);
          if (to) p.stdout!.pipe(createWriteStream(to));
          p.on("error", reject);
          p.on("close", (code) =>
            code === 0
              ? resolve()
              : reject(Object.assign(Error(`ssh ${code}`), { stderr })),
          );
        }),
    );
  return {
    sh: (cmd: string) =>
      retry(() =>
        run("ssh", [...h.options, h.destination, cmd], { maxBuffer: 1 << 28 }),
      ).then((r) => r.stdout),
    put: (local: string, remote: string) => pipe(`cat > '${remote}'`, local),
    get: (remote: string, local: string) =>
      pipe(`cat '${remote}'`, undefined, local),
  };
}
