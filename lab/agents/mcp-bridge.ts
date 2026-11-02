/** Minimal MCP stdio server forwarding tool calls to the runner (lab only). */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const url = process.env.CU_TOOL_URL!;
const tools = JSON.parse(readFileSync(process.env.CU_TOOLS!, "utf8")) as {
  name: string;
  description: string;
  inputSchema: unknown;
}[];
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fleet", version: "0.1.0" },
      },
    });
  if (m.method === "tools/list")
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
    });
  if (m.method === "tools/call") {
    try {
      const r = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ name: m.params.name, args: m.params.arguments ?? {} }),
      });
      const v = (await r.json()) as { success: boolean; contentItems: any[] };
      const content = v.contentItems.map((c) =>
        c.type === "inputImage"
          ? { type: "image", mimeType: "image/png", data: String(c.imageUrl).replace(/^data:image\/png;base64,/, "") }
          : { type: "text", text: c.text },
      );
      return send({ jsonrpc: "2.0", id: m.id, result: { content, isError: !v.success } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(e) }], isError: true } });
    }
  }
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
