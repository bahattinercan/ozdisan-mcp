import { afterEach, describe, expect, it, vi } from "vitest";
import { extractNextData, leafHits, OzdisanClient, sanitizeFileName, trailingId } from "../../src/api.js";
import { MemoryCache } from "../../src/cache.js";
import { HttpClient, OzdisanError, UserInputError } from "../../src/http.js";
import type { RawCategoryNode } from "../../src/types.js";
import { existsSync, readdirSync } from "node:fs";
import { fixture, html, json, mockFetch, nextDataPage, tempDir, testConfig } from "../helpers.js";
import { makePdf } from "../pdf-helper.js";

const tree = fixture<{ totalCount: number; categories: RawCategoryNode[] }>("category-tree-tr.json");
const quick = fixture("quick-lm317.json");
const product = fixture("product-368374.json");
const list = fixture("list-279.json");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("yardımcı ayrıştırıcılar", () => {
  it("trailingId URL ve sluglardan kimlik çıkarır", () => {
    expect(trailingId("https://www.ozdisan.com/p/mikroislemciler-218/stm-stm32f103c8t6-368374")).toBe("368374");
    expect(trailingId("/ps/lineer-voltaj-regulatorleri-279?f=abc")).toBe("279");
    expect(trailingId("texas-lm317kct-603104/")).toBe("603104");
    expect(trailingId("stm32")).toBeUndefined();
  });

  it("extractNextData pageProps'u okur", () => {
    expect(extractNextData(nextDataPage({ a: 1 }))).toEqual({ a: 1 });
    expect(extractNextData("<html></html>")).toBeUndefined();
  });

  it("leafHits yaprak kategorileri ürün sayısına göre sıralar", () => {
    const leaves = leafHits(tree.categories);
    expect(leaves.length).toBeGreaterThan(5);
    expect(leaves[0]!.count).toBeGreaterThanOrEqual(leaves[1]!.count);
    expect(leaves.every((l) => l.path.length >= 2)).toBe(true);
  });
});

describe("HttpClient", () => {
  it("429 ve 5xx yanıtlarında yeniden dener", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1) return new Response("yavaş", { status: 429, headers: { "retry-after": "0" } });
      if (n === 2) return new Response("hata", { status: 502 });
      return json({ ok: true });
    });
    const http = new HttpClient(testConfig());
    await expect(http.getJson("/x", { lang: "tr" })).resolves.toEqual({ ok: true });
    expect(n).toBe(3);
  }, 15_000);

  it("4xx hatalarında yeniden denemez", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      return new Response("yok", { status: 404 });
    });
    const http = new HttpClient(testConfig());
    await expect(http.getJson("/x", { lang: "tr" })).rejects.toMatchObject({ status: 404 });
    expect(n).toBe(1);
  });

  it("zaman aşımında anlaşılır hata verir", async () => {
    vi.stubGlobal("fetch", (_: unknown, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
      }),
    );
    const http = new HttpClient(testConfig({ timeoutMs: 2_000 }));
    await expect(http.getJson("/x", { lang: "tr" })).rejects.toThrow(/yanıt vermedi/);
  }, 30_000);

  it("kimliğini User-Agent ve dil başlığıyla bildirir", async () => {
    const mock = mockFetch([{ match: () => true, respond: () => json({}) }]);
    vi.stubGlobal("fetch", mock.impl);
    await new HttpClient(testConfig()).getJson("/api/x", { lang: "en", query: { text: "a b" } });
    expect(mock.calls[0]!.url).toBe("https://www.ozdisan.com/api/x?text=a+b");
    expect(mock.calls[0]!.headers["User-Agent"]).toMatch(/^ozdisan-mcp\//);
    expect(mock.calls[0]!.headers["Accept-Language"]).toBe("en");
  });

  it("eşzamanlı istek sayısını sınırlar", async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return json({});
    });
    const http = new HttpClient(testConfig({ maxConcurrency: 2 }));
    await Promise.all(Array.from({ length: 6 }, (_, i) => http.getJson(`/x${i}`, { lang: "tr" })));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

function clientWithMocks() {
  const mock = mockFetch([
    { match: (u) => u.includes("/api/categories/categories"), respond: () => json(tree) },
    { match: (u) => u.includes("/api/layout/header"), respond: () => json(quick) },
    { match: (u, _i, b) => u.endsWith("/api/ps") && b?.type === "GetListData", respond: () => json(list) },
    { match: (u) => u.includes("/p/urun/urun-368374"), respond: () => html(nextDataPage(product)) },
    { match: (u) => u.includes("/p/urun/urun-"), respond: () => new Response("not found", { status: 404 }) },
  ]);
  vi.stubGlobal("fetch", mock.impl);
  return { client: new OzdisanClient(testConfig()), mock };
}

describe("OzdisanClient.resolveCategory", () => {
  it("sıra numarası, slug, URL ve adla çözer", async () => {
    const { client } = clientWithMocks();
    expect((await client.resolveCategory("218")).name).toBe("Mikroişlemciler");
    expect((await client.resolveCategory("mikroislemciler-218")).sequenceId).toBe(218);
    expect((await client.resolveCategory("https://www.ozdisan.com/ps/lineer-voltaj-regulatorleri-279")).sequenceId).toBe(279);
    expect((await client.resolveCategory("mikroişlemciler")).sequenceId).toBe(218);
    expect((await client.resolveCategory("Lineer Voltaj Regülatörleri")).sequenceId).toBe(279);
  });

  it("kategori ağacını önbellekten kullanır", async () => {
    const { client, mock } = clientWithMocks();
    await client.resolveCategory("218");
    await client.resolveCategory("279");
    const treeCalls = mock.calls.filter((c) => c.url.includes("/api/categories/categories"));
    expect(treeCalls).toHaveLength(1);
  });

  it("adın sonundaki sayıyı kategori kimliği sanmaz (TO-220, Cat-6)", async () => {
    const { client } = clientWithMocks();
    for (const text of ["TO-220", "Cat-6"]) {
      const res = await client.resolveCategory(text).catch((e) => e);
      if (res instanceof Error) expect(res).toBeInstanceOf(UserInputError);
      else expect([220, 6]).not.toContain(res.sequenceId);
    }
  });

  it("bulunamayan kategoride öneri listesiyle hata verir", async () => {
    const { client } = clientWithMocks();
    await expect(client.resolveCategory("zzzz qqqq")).rejects.toBeInstanceOf(UserInputError);
  });
});

describe("OzdisanClient.resolveProduct", () => {
  it("ürün kodu ve URL'yi doğrudan kullanır", async () => {
    const { client, mock } = clientWithMocks();
    expect((await client.resolveProduct("368374")).erpRefId).toBe("368374");
    expect((await client.resolveProduct("https://www.ozdisan.com/p/x/stm-stm32f103c8t6-368374")).erpRefId).toBe("368374");
    expect(mock.calls).toHaveLength(0);
  });

  it("parça numarasını hızlı aramayla birebir eşleştirir", async () => {
    const { client } = clientWithMocks();
    const res = await client.resolveProduct("lm317t");
    const lm317t = quick.variants.find((v: { sku: string }) => v.sku === "LM317T");
    expect(res.erpRefId).toBe(trailingId(lm317t.slug));
  });

  it("eşleşme yoksa öneriler döndürür", async () => {
    const { client } = clientWithMocks();
    await expect(client.resolveProduct("LM317XYZ")).rejects.toMatchObject({
      details: { suggestions: expect.any(Array) },
    });
  });
});

describe("OzdisanClient.getProductPage", () => {
  it("ürün sayfasını ayrıştırır", async () => {
    const { client } = clientWithMocks();
    const page = await client.getProductPage("368374");
    expect(page.data.sku).toBe("STM32F103C8T6");
  });

  it("404 için kullanıcı hatası verir", async () => {
    const { client } = clientWithMocks();
    await expect(client.getProductPage("999999999")).rejects.toBeInstanceOf(UserInputError);
  });

  it("ağ hatasını OzdisanError olarak iletir", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const client = new OzdisanClient(testConfig());
    await expect(client.getProductPage("1")).rejects.toBeInstanceOf(OzdisanError);
  }, 15_000);
});

describe("OzdisanClient.resolveDatasheetUrl", () => {
  it("çözülen dosya ürünün dosyası değilse ürünün kendi yolunu kullanır", async () => {
    vi.stubGlobal("fetch", async () =>
      json({ url: "https://cdn.ozdisan.com/public/product/assets/BASKA.pdf", fileName: "BASKA.pdf", isExternal: false }),
    );
    const client = new OzdisanClient(testConfig());
    const res = await client.resolveDatasheetUrl("X1", "Kendi Dosyam.pdf");
    expect(res?.url).toBe("https://cdn.ozdisan.com/public/product/assets/Kendi%20Dosyam.pdf");
  });

  it("tam URL olarak gelen medya yolunu doğrudan kullanır", async () => {
    const client = new OzdisanClient(testConfig());
    const res = await client.resolveDatasheetUrl("X1", "https://cdn.ozdisan.com/public/product/assets/lm317_texas.pdf");
    expect(res).toMatchObject({ fileName: "lm317_texas.pdf", isExternal: false });
  });

  it("çözümleme başarısız olursa CDN yoluna düşer", async () => {
    vi.stubGlobal("fetch", async () => new Response("err", { status: 400 }));
    const client = new OzdisanClient(testConfig());
    const res = await client.resolveDatasheetUrl("X1", "product/assets/a b.pdf");
    expect(res?.url).toBe("https://cdn.ozdisan.com/public/product/assets/a%20b.pdf");
  });
});

describe("indirme ve ikili veri güvenliği", () => {
  const pdf = makePdf(["Hello datasheet"]);
  const pdfResponse = () => new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });

  it("dosya adlarını güvenli hale getirir ve .pdf uzantısını korur", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd.pdf");
    expect(sanitizeFileName("a".repeat(300) + ".pdf").endsWith(".pdf")).toBe(true);
    expect(sanitizeFileName("a".repeat(300) + ".pdf").length).toBeLessThanOrEqual(160);
    expect(sanitizeFileName("NA555, NE555.pdf")).toBe("NA555, NE555.pdf");
    expect(sanitizeFileName("..hidden")).toBe("hidden.pdf");
  });

  it("aynı dosyanın eşzamanlı indirmelerini tek indirmeye indirger", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      await new Promise((r) => setTimeout(r, 30));
      return pdfResponse();
    });
    const client = new OzdisanClient(testConfig());
    const dir = tempDir();
    const [a, b] = await Promise.all([
      client.downloadFile("https://cdn.ozdisan.com/x.pdf", dir, "x.pdf"),
      client.downloadFile("https://cdn.ozdisan.com/x.pdf", dir, "x.pdf"),
    ]);
    expect(n).toBe(1);
    expect(a.path).toBe(b.path);
    expect(readdirSync(dir)).toEqual(["x.pdf"]);
  });

  it("PDF olmayan içeriği kaydetmez", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(2048), { status: 200, headers: { "content-type": "application/octet-stream" } }));
    const client = new OzdisanClient(testConfig());
    const dir = tempDir();
    await expect(client.downloadFile("https://cdn.ozdisan.com/y.pdf", dir, "y.pdf")).rejects.toBeInstanceOf(UserInputError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("boyut sınırını içerik uzunluğu bildirilmese de akış sırasında uygular", async () => {
    const big = new Uint8Array(5000);
    big.set(new TextEncoder().encode("%PDF-1.4"));
    vi.stubGlobal("fetch", async () => new Response(big, { status: 200, headers: { "content-type": "application/pdf" } }));
    const client = new OzdisanClient(testConfig({ maxDownloadBytes: 1000 }));
    await expect(client.fetchBinary("https://cdn.ozdisan.com/big.pdf")).rejects.toThrow(/sınır/);
  });

  it("Özdisan'dan iç ağa yapılan yönlendirmeyi takip etmez", async () => {
    const mock = mockFetch([
      {
        match: (u) => u.startsWith("https://cdn.ozdisan.com/"),
        respond: () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
      },
      { match: () => true, respond: () => pdfResponse() },
    ]);
    vi.stubGlobal("fetch", mock.impl);
    const client = new OzdisanClient(testConfig());
    await expect(client.fetchBinary("https://cdn.ozdisan.com/r.pdf")).rejects.toBeInstanceOf(UserInputError);
    expect(mock.calls.map((c) => c.url)).toEqual(["https://cdn.ozdisan.com/r.pdf"]);
  });
});

describe("MemoryCache", () => {
  it("senkron hata fırlatan yükleyiciyi kalıcı olarak önbelleğe almaz", async () => {
    const cache = new MemoryCache();
    await expect(
      cache.getOrLoad("k", 1000, (() => {
        throw new Error("boom");
      }) as never),
    ).rejects.toThrow("boom");
    await expect(cache.getOrLoad("k", 1000, async () => 42)).resolves.toBe(42);
  });
});

