#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, VERSION } from "./config.js";
import { createServer } from "./server.js";

const HELP = `ozdisan-mcp ${VERSION}
Özdisan Elektronik (ozdisan.com) için yerel MCP sunucusu.

Kullanım:
  npx -y ozdisan-mcp            MCP sunucusunu stdio üzerinden başlatır
  ozdisan-mcp --version         Sürümü yazdırır
  ozdisan-mcp --help            Bu yardımı gösterir

Ortam değişkenleri:
  OZDISAN_LANG              tr | en           (varsayılan: tr)
  OZDISAN_CURRENCY          TRY | USD | EUR   (varsayılan: TRY)
  OZDISAN_DOWNLOAD_DIR      Datasheet indirme klasörü (varsayılan: ~/Downloads/ozdisan-datasheets)
  OZDISAN_CACHE_DIR         Disk önbelleği klasörü (varsayılan: ~/.cache/ozdisan-mcp)
  OZDISAN_DISK_CACHE        0 ise disk önbelleği kapatılır
  OZDISAN_TIMEOUT_MS        İstek zaman aşımı (varsayılan: 30000)
  OZDISAN_MIN_INTERVAL_MS   İstekler arası en kısa süre (varsayılan: 250)
  OZDISAN_MAX_CONCURRENCY   Eşzamanlı istek sayısı (varsayılan: 2)
  OZDISAN_MAX_DOWNLOAD_MB   İndirme boyutu sınırı (varsayılan: 50)

Bu program bir MCP istemcisi (Claude Desktop, Claude Code, Cursor, VS Code...) tarafından başlatılmak içindir.`;

/**
 * stdout yalnızca MCP JSON-RPC mesajlarına ayrılmıştır. Bağımlılıkların console.log/info/debug
 * çıktıları protokolü bozmasın diye stderr'e yönlendirilir.
 */
function protectStdout(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  protectStdout();
  const config = loadConfig();
  const { server } = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout MCP protokolüne ayrılmıştır; bilgi mesajları stderr'e yazılır.
  process.stderr.write(`ozdisan-mcp ${VERSION} hazır (dil: ${config.language}, para birimi: ${config.currency})\n`);

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`ozdisan-mcp başlatılamadı: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
