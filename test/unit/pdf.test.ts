import { describe, expect, it } from "vitest";
import { UserInputError } from "../../src/http.js";
import { extractPdfText, foldWithMap, parsePageRange, searchPages } from "../../src/pdf.js";
import { makePdf } from "../pdf-helper.js";

describe("parsePageRange", () => {
  it("aralıkları ve tek sayfaları ayrıştırır", () => {
    expect(parsePageRange("1-3,7", 10)).toEqual([1, 2, 3, 7]);
    expect(parsePageRange("8-", 10)).toEqual([8, 9, 10]);
    expect(parsePageRange("-2", 10)).toEqual([1, 2]);
    expect(parsePageRange(undefined, 3)).toEqual([1, 2, 3]);
    expect(parsePageRange("3, 3, 1", 5)).toEqual([1, 3]);
  });

  it("geçersiz aralıkta hata verir", () => {
    expect(() => parsePageRange("abc", 5)).toThrow(UserInputError);
    expect(() => parsePageRange("20-30", 5)).toThrow(UserInputError);
  });
});

describe("searchPages", () => {
  const pages = [
    "Table of contents\nAbsolute Maximum Ratings .... 4",
    "Features\nLow dropout",
    "7.1 Absolute   Maximum Ratings\nVCC 18 V\nAbsolute maximum junction temperature 150 °C",
  ];

  it("en çok eşleşen sayfayı öne alır ve alıntı üretir", () => {
    const hits = searchPages(pages, "absolute maximum");
    // Çoklu boşluk ve satır sonu farkları tolere edilir: 3. sayfada iki geçiş var.
    expect(hits[0]!.page).toBe(3);
    expect(hits[0]!.hits).toBe(2);
    expect(hits.map((h) => h.page)).toContain(1);
  });

  it("birden fazla terimi virgülle arar", () => {
    const hits = searchPages(pages, "dropout, VCC");
    expect(hits.map((h) => h.page).sort()).toEqual([2, 3]);
  });

  it("alıntılar orijinal metinden alınır", () => {
    const [hit] = searchPages(["xxxxx İÇİNDEKİLER Şema yyyyy"], "şema");
    expect(hit!.snippets[0]).toContain("Şema");
  });

  it("foldWithMap sadeleştirir ve konum haritası üretir", () => {
    const s = "İstanbul  ÇİĞ\tşeker";
    const { folded, map } = foldWithMap(s);
    expect(folded).toBe("istanbul cig seker");
    expect(map).toHaveLength(folded.length);
    expect(s.charAt(map[folded.indexOf("seker")]!)).toBe("ş");
  });
});

describe("extractPdfText", () => {
  it("PDF'ten sayfa sayfa metin çıkarır", async () => {
    const pdf = makePdf(["Pin Configuration and Functions", "Absolute Maximum Ratings VCC 18 V"]);
    const res = await extractPdfText(pdf);
    expect(res.totalPages).toBe(2);
    expect(res.pages[0]).toContain("Pin Configuration");
    expect(res.pages[1]).toContain("Absolute Maximum Ratings");
  });

  it("PDF olmayan veriyi reddeder", async () => {
    await expect(extractPdfText(new TextEncoder().encode("<html>not a pdf</html>"))).rejects.toThrow(UserInputError);
  });
});

describe("isPrivateHost", () => {
  it("yerel ve özel ağ adreslerini tanır", async () => {
    const { isPrivateHost } = await import("../../src/netguard.js");
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.10", "172.20.0.1", "169.254.169.254", "[::1]", "printer.local"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ["cdn.ozdisan.com", "www.ti.com", "8.8.8.8", "172.32.0.1", "fdic.gov"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});

describe("isPrivateAddress / assertPublicUrl", () => {
  it("IPv4-eşlemeli, NAT64, ULA ve link-local IPv6 adreslerini engeller", async () => {
    const { isPrivateAddress } = await import("../../src/netguard.js");
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "fd00::1", "fe80::1", "::1", "::"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["2001:4860:4860::8888", "::ffff:8.8.8.8", "1.1.1.1", "2606:4700::1111", "2002:808:808::1", "64:ff9b::808:808"]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
    // IPv4-uyumlu, 6to4, Teredo, yerel NAT64 ve dokümantasyon aralıkları
    for (const ip of ["::7f00:1", "::127.0.0.1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2001:0:4136:e378::1", "64:ff9b:1::1", "2001:db8::1", "100::1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("yerel adresleri ve http(s) dışı şemaları reddeder", async () => {
    const { assertPublicUrl } = await import("../../src/netguard.js");
    for (const u of ["http://localhost/a.pdf", "http://[::ffff:7f00:1]/a.pdf", "http://10.0.0.5/x", "file:///etc/passwd", "http://user:pw@example.com/"]) {
      await expect(assertPublicUrl(u)).rejects.toBeInstanceOf(UserInputError);
    }
  });
});

describe("bağlantı anında adres denetimi (DNS rebinding)", () => {
  it("safeLookup yerel adrese çözümlenen adı reddeder", async () => {
    const { safeLookup } = await import("../../src/netguard.js");
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup("localhost", {}, (e) => resolve(e)));
    expect(err?.code).toBe("EPRIVATEADDR");
  });

  it("externalGet, adı yerel IP'ye çözümlenen sunucuya bağlanmaz", async () => {
    const { createServer } = await import("node:http");
    const { externalGet } = await import("../../src/netguard.js");
    let hit = false;
    const server = createServer((_req, res) => {
      hit = true;
      res.end("%PDF-1.4 gizli");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        externalGet(new URL(`http://localhost:${port}/a.pdf`), { headers: {}, timeoutMs: 5000 }),
      ).rejects.toBeInstanceOf(UserInputError);
      expect(hit).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("checkDownloadDirectory", () => {
  it("ev dizini altındaki normal klasörlere izin verir, gizli/sistem klasörlerini reddeder", async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { checkDownloadDirectory } = await import("../../src/tools/datasheet.js");
    const configured = join(homedir(), "Downloads", "ozdisan-datasheets");
    expect(checkDownloadDirectory("~/Projeler/kart/datasheets", configured)).toBe(join(homedir(), "Projeler", "kart", "datasheets"));
    for (const bad of ["~/.ssh", "~/.config/autostart", "~/Library/LaunchAgents", "~/library/LaunchAgents", "~/LIBRARY/x", "~/AppData/Roaming", "/etc", "/tmp/x", "goreli/yol"]) {
      expect(() => checkDownloadDirectory(bad, configured)).toThrow(UserInputError);
    }
  });

  it("yapılandırılmış indirme klasörü ev dizini dışındaysa onun altına izin verir", async () => {
    const { checkDownloadDirectory } = await import("../../src/tools/datasheet.js");
    const { resolve } = await import("node:path");
    expect(checkDownloadDirectory("/srv/ds/alt", "/srv/ds")).toBe(resolve("/srv/ds/alt"));
    expect(() => checkDownloadDirectory("/srv/baska", "/srv/ds")).toThrow(UserInputError);
  });
});

// Windows'ta sembolik bağlantı oluşturmak ek izin gerektirir ve /etc yoktur.
describe.skipIf(process.platform === "win32")("checkDownloadDirectory sembolik bağlantılar", () => {
  it("gizli ya da izin verilen alan dışındaki klasöre giden sembolik bağlantıyı gerçek yola göre reddeder", async () => {
    const { mkdirSync, symlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tempDir } = await import("../helpers.js");
    const { checkDownloadDirectory } = await import("../../src/tools/datasheet.js");
    const base = tempDir("ozdisan-base-");
    mkdirSync(join(base, ".gizli"));
    mkdirSync(join(base, "normal"));
    symlinkSync(join(base, ".gizli"), join(base, "masum"), "dir");
    symlinkSync("/etc", join(base, "disari"), "dir");
    expect(checkDownloadDirectory(join(base, "normal", "yeni"), base)).toContain("normal");
    expect(() => checkDownloadDirectory(join(base, "masum"), base)).toThrow(UserInputError);
    expect(() => checkDownloadDirectory(join(base, "masum", "alt"), base)).toThrow(UserInputError);
    expect(() => checkDownloadDirectory(join(base, "disari"), base)).toThrow(UserInputError);
  });
});

describe("externalGet kötü niyetli yanıtlara dayanıklıdır", () => {
  /** Verilen ham HTTP yanıtını yazan TCP sunucusu. */
  async function rawServer(payload: string, opts: { destroyAfterMs?: number } = {}) {
    const net = await import("node:net");
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        socket.write(payload);
        if (opts.destroyAfterMs !== undefined) setTimeout(() => socket.destroy(), opts.destroyAfterMs);
        else socket.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, port: (server.address() as { port: number }).port };
  }

  async function get(port: number) {
    const dns = await import("node:dns");
    const { externalGet } = await import("../../src/netguard.js");
    // Testte yerel sunucuya bağlanabilmek için adres denetimsiz çözümleyici kullanılır.
    const lookup = ((h: string, o: object, cb: never) => dns.lookup(h, o, cb)) as never;
    return externalGet(new URL(`http://localhost:${port}/a.pdf`), { headers: {}, timeoutMs: 3000, lookup });
  }

  it("geçersiz durum kodunda süreci çökertmeden reddeder", async () => {
    const { server, port } = await rawServer("HTTP/1.1 999 Garip\r\nContent-Length: 0\r\n\r\n");
    try {
      await expect(get(port)).rejects.toThrow(/durum kodu/);
    } finally {
      server.close();
    }
  });

  it("yönlendirme yanıtından sonra kopan bağlantı süreci çökertmez", async () => {
    const { server, port } = await rawServer(
      "HTTP/1.1 302 Found\r\nLocation: https://example.com/x.pdf\r\nContent-Length: 1000\r\n\r\nabc",
      { destroyAfterMs: 20 },
    );
    try {
      const res = await get(port);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://example.com/x.pdf");
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.close();
    }
  });

  it("bozuk yanıtta reddeder", async () => {
    const { server, port } = await rawServer("BU HTTP DEGIL\r\n\r\n");
    try {
      await expect(get(port)).rejects.toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  });
});

