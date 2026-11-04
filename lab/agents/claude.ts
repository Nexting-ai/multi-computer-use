/**
 * Second model: Claude Code headless (`claude -p`) through the user's launcher,
 * so its network preflight and proxy apply. Tools are bridged over a minimal
 * MCP stdio server to the runner's HTTP tool endpoint. No other tools.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Tool, ToolResult } from "../benchmark/astra.js";
import type { Usage } from "../benchmark/metrics.js";

export async function runClaude(o: {
  output: string;
  prompt: string;
  tools: Tool[];
  handle: (name: string, args: unknown) => Promise<ToolResult>;
  deadlineMs: number;
  maxCalls: number;
  model: string;
}) {
  await mkdir(o.output, { recursive: true });
  let calls = 0,
    stop: string | null = null;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    try {
      const { name, args } = JSON.parse(body);
      if (++calls > o.maxCalls) {
        stop = "tool_budget";
        throw Error("run_stopped");
      }
      if (!o.tools.some((t) => t.name === name))
        throw Error("tool_scope_denied");
      const r = await o.handle(name, args);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r));
    } catch (e) {
      res.end(
        JSON.stringify({
          success: false,
          contentItems: [{ type: "inputText", text: String(e) }],
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  const toolsFile = join(o.output, "tools.json");
  await writeFile(toolsFile, JSON.stringify(o.tools));
  const mcp = join(o.output, "mcp.json");
  await writeFile(
    mcp,
    JSON.stringify({
      mcpServers: {
        fleet: {
          command: process.execPath,
          args: [
            "--import",
            "tsx",
            resolve(import.meta.dirname, "mcp-bridge.ts"),
          ],
          env: {
            CU_TOOL_URL: `http://127.0.0.1:${port}/`,
            CU_TOOLS: toolsFile,
            NO_PROXY: "127.0.0.1,localhost",
          },
        },
      },
    }),
  );
  const args = [
    "-p",
    o.prompt,
    "--mcp-config",
    mcp,
    "--strict-mcp-config",
    "--tools",
    "",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    // Isolate from the operator's personal hooks, skills and plugins.
    "--setting-sources",
    "project",
    "--disable-slash-commands",
    "--model",
    o.model,
  ];
  const t0 = performance.now();
  // The user's launcher applies the required Anthropic egress and preflight.
  const proc = spawn("zsh", ["-ic", 'claude "$@"', "zsh", ...args], {
    cwd: o.output,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/proxy/i.test(k) && k !== "NODE_USE_ENV_PROXY",
      ),
    ),
  });
  let transcript = "";
  proc.stdout.on("data", (d) => {
    transcript += d;
    void appendFile(join(o.output, "transcript.jsonl"), d);
  });
  proc.stderr.on(
    "data",
    (d) => void appendFile(join(o.output, "stderr.log"), d),
  );
  const timedOut = await new Promise<boolean>((r) => {
    const timer = setTimeout(() => {
      stop ??= "wall_budget";
      proc.kill("SIGTERM");
      r(true);
    }, o.deadlineMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      r(false);
    });
  });
  server.close();
  const events = transcript
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const result = events.findLast((e: any) => e.type === "result");
  const inferences = events.filter((e: any) => e.type === "assistant").length;
  const u = result?.usage;
  const usage: Usage | null = u
    ? {
        inputTokens:
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0),
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteInputTokens: u.cache_creation_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        reasoningOutputTokens: 0,
        totalTokens:
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.output_tokens ?? 0),
      }
    : null;
  const out = {
    agent: "claude",
    model: o.model,
    status: {
      status: result && !result.is_error && !timedOut ? "completed" : "failed",
      subtype: result?.subtype ?? null,
    },
    stop_reason: stop,
    elapsed_ms: Math.round(performance.now() - t0),
    usage,
    cost_usd: result?.total_cost_usd ?? null,
    inferences,
    tool_calls: calls,
  };
  await writeFile(join(o.output, "agent.json"), JSON.stringify(out, null, 2));
  return out;
}
