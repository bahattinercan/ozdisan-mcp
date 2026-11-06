import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../helpers.js";
import { SERVER_ENTRY, startServer, type E2EClient } from "./mcp-client.js";

/**
 * MCP protokol seviyesi uçtan uca testler: gerçek süreç, gerçek stdio, gerçek ağ.
 */
describe("MCP protokolü (stdio)", () => {
  let s: E2EClient;

  beforeAll(async () => {
    s = await startServer();
  });

  afterAll(async () => {
    await s?.close();
  });

  it("sunucu kimliğini ve yeteneklerini bildirir", () => {
    const info = s.client.getServerVersion();
    expect(info?.name).toBe("ozdisan-mcp");
    expect(info?.version).toMatch(/^\d+\.\d+\.\d+/);
    const caps = s.client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.prompts).toBeDefined();
    expect(s.client.getInstructions()).toMatch(/Özdisan/);
  });

  it("11 aracın tamamını salt-okunur ipuçlarıyla listeler", async () => {
    const { tools } = await s.client.listTools();
    expect(tools).toHaveLength(11);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint);
    // download_datasheet diske yazdığı için readOnly değildir.
    expect(readOnly.map((t) => t.name)).not.toContain("download_datasheet");
    expect(readOnly).toHaveLength(10);
  });

  it("geçersiz argümanları doğrulama hatasıyla reddeder", async () => {
    const res = await s.client.callTool({ name: "filter_products", arguments: { page_size: 5 } });
    expect(res.isError).toBe(true);
  });
});

describe("stdout temizliği", () => {
  it("stdout'a yalnızca geçerli JSON-RPC mesajları yazılır (PDF okuma dahil)", async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, OZDISAN_CACHE_DIR: tempDir(), OZDISAN_DOWNLOAD_DIR: tempDir() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const waitFor = (id: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`yanıt ${id} gelmedi`)), 90_000);
        const check = () => {
          if (stdout.split("\n").some((l) => l.includes(`"id":${id}`))) {
            clearTimeout(timer);
            child.stdout.off("data", check);
            resolve();
          }
        };
        child.stdout.on("data", check);
        check();
      });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_datasheet", arguments: { product: "NE555P", pages: "1-3", max_chars: 2000 } },
    });
    await waitFor(2);
    child.kill();

    const lines = stdout.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const msg = JSON.parse(line);
      expect(msg.jsonrpc).toBe("2.0");
    }
  });

  it("--version ve --help bayrakları çalışır", async () => {
    const run = (arg: string) =>
      new Promise<string>((resolve) => {
        const c = spawn(process.execPath, [SERVER_ENTRY, arg]);
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("close", () => resolve(out));
      });
    expect((await run("--version")).trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await run("--help")).toContain("OZDISAN_LANG");
  });
});
