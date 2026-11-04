/** The blind judge: Claude through the operator's launcher (which applies
 * the required Anthropic egress), with only the Read tool. */
import { spawn } from "node:child_process";

export function claude(cwd: string, prompt: string): Promise<string> {
  return new Promise((resolveOut, reject) => {
    const args = [
      "-p",
      prompt,
      "--tools",
      "Read",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--setting-sources",
      "project",
      "--disable-slash-commands",
      "--model",
      "sonnet",
    ];
    // The operator's launcher applies the required Anthropic egress.
    const p = spawn("zsh", ["-ic", 'claude "$@"', "zsh", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !/proxy/i.test(k) && k !== "NODE_USE_ENV_PROXY",
        ),
      ),
    });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolveOut(stdout) : reject(Error(`claude ${code}`)),
    );
  });
}

/** The model's answer from the launcher's output (status lines may precede
 * claude's JSON result). */
export function resultText(raw: string): string {
  const line = raw
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{") && l.includes('"result"'));
  if (!line) throw Error("judge_no_result:" + raw.slice(0, 200));
  return JSON.parse(line).result as string;
}
