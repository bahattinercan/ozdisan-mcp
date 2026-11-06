// Derleme sonrası CLI giriş dosyasını çalıştırılabilir yapar (macOS/Linux).
import { chmodSync, existsSync } from "node:fs";

const bin = new URL("../dist/index.js", import.meta.url);
if (existsSync(bin) && process.platform !== "win32") {
  chmodSync(bin, 0o755);
}
