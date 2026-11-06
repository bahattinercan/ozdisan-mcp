import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers.js";

export const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

export interface E2EClient {
  client: Client;
  downloadDir: string;
  call: <T = any>(name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: T }>;
  close: () => Promise<void>;
}

/** Derlenmiş sunucuyu (dist/index.js) gerçek bir MCP istemcisiyle stdio üzerinden başlatır. */
export async function startServer(env: Record<string, string> = {}): Promise<E2EClient> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error("dist/index.js bulunamadı. Önce `npm run build` çalıştırın (npm run test:e2e bunu otomatik yapar).");
  }
  const downloadDir = tempDir("ozdisan-e2e-dl-");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      OZDISAN_DOWNLOAD_DIR: downloadDir,
      OZDISAN_CACHE_DIR: tempDir("ozdisan-e2e-cache-"),
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "ozdisan-mcp-e2e", version: "1.0.0" });
  await client.connect(transport);

  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new Error(`${name} JSON olmayan yanıt döndürdü: ${text.slice(0, 300)}`);
    }
    return { isError: !!res.isError, data };
  };

  return { client, downloadDir, call, close: () => client.close() };
}
