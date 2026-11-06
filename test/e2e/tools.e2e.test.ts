import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type E2EClient } from "./mcp-client.js";

/**
 * Canlı ozdisan.com verisiyle uçtan uca araç testleri.
 * Fiyat/stok gibi değişken değerler yerine yapı ve iş kuralları doğrulanır.
 * Uzun süredir katalogda olan ürünler kullanılır: STM32F103C8T6 (368374), NE555P, LM317.
 */

let s: E2EClient;

beforeAll(async () => {
  s = await startServer();
});

afterAll(async () => {
  await s?.close();
});

const sorted = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! <= x);

describe("search_products", () => {
  it("parça numarasıyla arar, kategori dağılımı ve ürün detayları döner", async () => {
    const { isError, data } = await s.call("search_products", { query: "STM32F103C8T6", page_size: 5 });
    expect(isError).toBe(false);
    expect(data.total_matches).toBeGreaterThan(0);
    expect(data.categories.map((c: any) => c.category)).toContain("mikroislemciler-218");
    const hit = data.products.find((p: any) => p.part_number === "STM32F103C8T6");
    expect(hit).toBeDefined();
    expect(hit.product).toBe("368374");
    expect(hit.manufacturer).toBe("STM");
    expect(hit.url).toMatch(/^https:\/\/www\.ozdisan\.com\/p\/.+-368374$/);
    expect(typeof hit.stock).toBe("number");
    expect(hit.specs["Kılıf / Kasa"]).toMatch(/LQFP48/);
  });

  it("kategori içinde ve stok filtresiyle arar", async () => {
    const { data } = await s.call("search_products", {
      query: "LM317",
      category: "lineer-voltaj-regulatorleri-279",
      in_stock: true,
      page_size: 5,
      include_specs: false,
    });
    expect(data.category.category).toBe("lineer-voltaj-regulatorleri-279");
    expect(data.products.length).toBeGreaterThan(0);
    for (const p of data.products) {
      expect(p.stock).toBeGreaterThan(0);
      expect(p.part_number.toUpperCase()).toContain("317");
      expect(p.specs).toBeUndefined();
    }
  });

  it("sonuç olmayan aramada yol gösterir", async () => {
    const { isError, data } = await s.call("search_products", { query: "qqzzxxyy-yok-boyle-parca-918273" });
    expect(isError).toBe(false);
    expect(data.total_matches).toBe(0);
    expect(data.message).toBeTruthy();
  });
});

describe("get_product", () => {
  it("parça numarası, ürün kodu ve URL ile aynı ürünü bulur", async () => {
    const byPart = await s.call("get_product", { product: "stm32f103c8t6" });
    const byCode = await s.call("get_product", { product: "368374" });
    const byUrl = await s.call("get_product", { product: "https://www.ozdisan.com/p/mikroislemciler-218/stm-stm32f103c8t6-368374" });
    for (const r of [byPart, byCode, byUrl]) {
      expect(r.isError).toBe(false);
      expect(r.data.product).toBe("368374");
    }
  });

  it("teknik özellik, fiyat kırılımı, stok, datasheet ve kategori yolu içerir", async () => {
    const { data } = await s.call("get_product", { product: "368374" });
    expect(data.part_number).toBe("STM32F103C8T6");
    expect(data.manufacturer).toBe("STM");
    expect(data.category.category).toBe("mikroislemciler-218");
    expect(data.category.path[0]).toBe("Elektronik Komponentler");
    expect(Object.keys(data.specs).length).toBeGreaterThan(5);
    expect(data.specs["İşlemci Çekirdek Tipi"]).toMatch(/Cortex-M3/);
    expect(data.datasheet_url).toMatch(/^https:\/\/.+\.pdf/i);
    expect(data.moq).toBeGreaterThanOrEqual(1);
    if (data.pricing.price_breaks) {
      const qtys = data.pricing.price_breaks.map((b: any) => b.qty);
      const prices = data.pricing.price_breaks.map((b: any) => b.unit_price);
      expect(sorted(qtys)).toBe(true);
      // Fiyat kırılımlarında adet arttıkça birim fiyat artmamalı
      expect(sorted([...prices].reverse())).toBe(true);
      expect(data.pricing.currency).toBe("TRY");
      expect(data.pricing.vat_included).toBe(false);
    } else {
      expect(data.pricing.price_on_request).toBe(true);
    }
  });

  it("USD/EUR para birimini ve İngilizce dili destekler", async () => {
    const usd = await s.call("get_product", { product: "368374", currency: "USD", language: "en" });
    expect(usd.data.category.name).toBe("Microcontrollers");
    expect(usd.data.url).toContain("/en/p/");
    if (usd.data.pricing.price_breaks) expect(usd.data.pricing.currency).toBe("USD");
    const eur = await s.call("get_product", { product: "368374", currency: "EUR" });
    if (eur.data.pricing.price_breaks) {
      expect(eur.data.pricing.currency).toBe("EUR");
      expect(eur.data.pricing.price_breaks[0].unit_price).toBeLessThan(usd.data.pricing.price_breaks[0].unit_price * 1.5);
    }
  });

  it("muadilleri isteğe bağlı olarak ekler", async () => {
    const { data } = await s.call("get_product", { product: "368374", include_alternatives: true });
    expect(data.product).toBe("368374");
    // Muadil listesi siteye bağlıdır; varsa yapısı doğrulanır.
    for (const group of Object.values(data.alternatives ?? {}) as any[][]) {
      for (const p of group) expect(p.product).toMatch(/^\d+$/);
    }
  });

  it("olmayan ürün için anlaşılır hata döner", async () => {
    const missingCode = await s.call("get_product", { product: "999999999" });
    expect(missingCode.isError).toBe(true);
    const missingPart = await s.call("get_product", { product: "YOKBOYLEPARCA-XYZ-123" });
    expect(missingPart.isError).toBe(true);
    expect(missingPart.data.error).toMatch(/bulunamadı/);
  });
});

describe("kategoriler", () => {
  it("browse_categories ana grupları ve alt kategorileri listeler", async () => {
    const root = await s.call("browse_categories");
    expect(root.data.total_products).toBeGreaterThan(500_000);
    expect(root.data.categories.map((c: any) => c.category)).toContain("elektronik-komponentler-1");

    const ic = await s.call("browse_categories", { category: "entegre-devreler-icler-9", depth: 2 });
    expect(ic.data.category.name).toMatch(/Entegre/);
    const embedded = ic.data.subcategories.find((c: any) => c.category === "embedded-entegreler-52");
    expect(embedded.subcategories.map((c: any) => c.category)).toContain("mikroislemciler-218");
  });

  it("search_categories Türkçe ve İngilizce adlarla bulur", async () => {
    const tr = await s.call("search_categories", { query: "mikroişlemci" });
    expect(tr.data.categories_by_name[0].category).toBe("mikroislemciler-218");
    const en = await s.call("search_categories", { query: "linear voltage regulators" });
    const all = [...en.data.categories_by_name, ...en.data.categories_with_matching_products].map((c: any) => c.category);
    expect(all).toContain("lineer-voltaj-regulatorleri-279");
  });

  it("get_category_filters özellik, birim ve seçenekleri döndürür", async () => {
    const { data } = await s.call("get_category_filters", { category: "279", max_values: 10 });
    expect(data.total_products).toBeGreaterThan(100);
    const pkg = data.properties.find((p: any) => p.name === "Kılıf / Kasa");
    expect(pkg.type).toBe("text");
    expect(pkg.options.length).toBeGreaterThan(0);
    const current = data.properties.find((p: any) => p.name === "Çıkış Akımı");
    expect(current.type).toBe("numeric");
    expect(current.units).toEqual(expect.arrayContaining(["mA", "A"]));
    expect(data.sort_by).toEqual(expect.arrayContaining(["price", "stock"]));
  });

  it("get_category_filters tek özelliği arar ve mevcut filtreye göre daraltır", async () => {
    const one = await s.call("get_category_filters", { category: "279", property: "Kılıf / Kasa", value_query: "SOT23" });
    expect(one.data.property.options.length).toBeGreaterThan(0);
    expect(one.data.property.options.every((o: string) => o.toUpperCase().replace(/[^A-Z0-9]/g, "").includes("SOT23"))).toBe(true);

    const narrowed = await s.call("get_category_filters", { category: "279", manufacturers: ["TEXAS"] });
    expect(narrowed.data.matching_products).toBeGreaterThan(0);
    expect(narrowed.data.matching_products).toBeLessThan(narrowed.data.total_products);
  });
});

describe("filter_products (parametrik seçim)", () => {
  it("3.3V, ≥500mA, SOT23 kılıflı, stokta LDO'ları fiyata göre sıralar", async () => {
    const { isError, data } = await s.call("filter_products", {
      category: "lineer-voltaj-regulatorleri-279",
      filters: [{ property: "Kılıf / Kasa", values: ["SOT23"], match: "contains" }],
      ranges: [
        { property: "Çıkış Akımı", min: 500, unit: "mA" },
        { property: "Çıkış Voltajı", min: 3.3, max: 3.3, unit: "V" },
      ],
      in_stock: true,
      sort: { by: "price", order: "asc" },
      quantity: 100,
      page_size: 10,
    });
    expect(isError).toBe(false);
    expect(data.applied_filters.length).toBe(4);
    expect(data.total_matches).toBeGreaterThan(0);
    for (const p of data.products) {
      expect(p.stock).toBeGreaterThan(0);
      expect(p.specs["Kılıf / Kasa"].toUpperCase()).toContain("SOT23");
      // Ayarlanabilir regülatörler değer aralığı olarak gelir ("1.2 to 37 V"); aralık 3.3 V'u kapsamalı.
      const nums = (p.specs["Çıkış Voltajı"].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      expect(Math.min(...nums)).toBeLessThanOrEqual(3.3);
      expect(Math.max(...nums)).toBeGreaterThanOrEqual(3.3);
    }
    const prices = data.products.map((p: any) => p.unit_price_for_quantity).filter((x: unknown) => typeof x === "number");
    expect(sorted(prices)).toBe(true);
  });

  it("İngilizce özellik adlarını Türkçe modda da kabul eder; üretici ve sayfalama çalışır", async () => {
    const page1 = await s.call("filter_products", {
      category: "218",
      manufacturers: ["STM"],
      filters: [{ property: "Processor Core Type", values: ["ARM Cortex-M0"] }],
      page_size: 3,
      include_specs: false,
    });
    expect(page1.isError).toBe(false);
    expect(page1.data.products.every((p: any) => p.manufacturer === "STM")).toBe(true);
    if (page1.data.total_pages > 1) {
      const page2 = await s.call("filter_products", {
        category: "218",
        manufacturers: ["STM"],
        filters: [{ property: "Processor Core Type", values: ["ARM Cortex-M0"] }],
        page_size: 3,
        page: 2,
        include_specs: false,
      });
      const ids1 = page1.data.products.map((p: any) => p.product);
      expect(page2.data.products.some((p: any) => ids1.includes(p.product))).toBe(false);
    }
  });

  it("stok ve özelliğe göre sıralar", async () => {
    const { data } = await s.call("filter_products", { category: "279", sort: { by: "stock" }, page_size: 5, include_specs: false });
    const stocks = data.products.map((p: any) => p.stock);
    expect(sorted([...stocks].reverse())).toBe(true);
  });

  it("hatalı özellik ve değerlerde düzeltme önerir", async () => {
    const badProp = await s.call("filter_products", { category: "279", filters: [{ property: "Renk", values: ["Mavi"] }] });
    expect(badProp.isError).toBe(true);
    expect(badProp.data.available_properties).toContain("Kılıf / Kasa");

    const badValue = await s.call("filter_products", { category: "279", filters: [{ property: "Kılıf / Kasa", values: ["SOT23"] }] });
    expect(badValue.isError).toBe(true);
    expect(badValue.data.suggestions.some((v: string) => v.includes("SOT23"))).toBe(true);

    const badUnit = await s.call("filter_products", { category: "279", ranges: [{ property: "Çıkış Akımı", min: 1, unit: "parsek" }] });
    expect(badUnit.isError).toBe(true);
    expect(badUnit.data.units).toContain("mA");
  });
});

describe("get_alternatives / compare_products", () => {
  it("muadil türlerini gruplar", async () => {
    const { isError, data } = await s.call("get_alternatives", { product: "368374", limit: 3 });
    expect(isError).toBe(false);
    expect(data.part_number).toBe("STM32F103C8T6");
    const groups = ["substitutes", "similar", "accessories", "parametric_matches"].filter((g) => data[g]);
    for (const g of groups) {
      expect(data[g].length).toBeLessThanOrEqual(3);
      expect(data[g][0].product).toMatch(/^\d+$/);
    }
    expect(groups.length > 0 || typeof data.note === "string").toBe(true);
  });

  it("ürünleri özellik bazında karşılaştırır", async () => {
    const { isError, data } = await s.call("compare_products", { products: ["NE555P", "368374"], quantity: 10 });
    expect(isError).toBe(false);
    expect(data.columns).toHaveLength(2);
    expect(data.columns.map((c: any) => c.part_number)).toEqual(["NE555P", "STM32F103C8T6"]);
    for (const row of Object.values(data.specs) as unknown[][]) expect(row).toHaveLength(2);
    expect(data.differing_specs.length).toBeGreaterThan(0);
  });
});

describe("check_bom", () => {
  it("BOM satırlarını fiyat, stok ve MOQ kurallarıyla değerlendirir", async () => {
    const { isError, data } = await s.call("check_bom", {
      items: [
        { part: "368374", quantity: 2, reference: "U1" },
        { part: "NE555P", quantity: 1, reference: "U2" },
        { part: "BOYLE-BIR-PARCA-YOK-42", quantity: 1, reference: "X1" },
      ],
      boards: 10,
    });
    expect(isError).toBe(false);
    expect(data.lines).toHaveLength(3);
    const [u1, u2, x1] = data.lines;
    expect(u1.required_qty).toBe(20);
    expect(u1.order_qty).toBeGreaterThanOrEqual(20);
    expect(u2.part_number).toBe("NE555P");
    expect(x1.status).toBe("not_found");
    expect(data.summary.not_found).toBe(1);
    const sum = data.lines.reduce((acc: number, l: any) => acc + (l.line_total ?? 0), 0);
    expect(Math.abs(sum - data.total_excl_vat)).toBeLessThan(0.05);
  });
});

describe("datasheet", () => {
  it("download_datasheet PDF'i diske indirir ve tekrar indirmez", async () => {
    const first = await s.call("download_datasheet", { product: "NE555P" });
    expect(first.isError).toBe(false);
    expect(first.data.file_path.startsWith(s.downloadDir)).toBe(true);
    expect(existsSync(first.data.file_path)).toBe(true);
    expect(readFileSync(first.data.file_path).subarray(0, 5).toString()).toBe("%PDF-");
    expect(first.data.size_kb).toBeGreaterThan(10);

    const second = await s.call("download_datasheet", { product: "NE555P" });
    expect(second.data.already_downloaded).toBe(true);
    expect(second.data.file_path).toBe(first.data.file_path);
  });

  it("read_datasheet anahtar kelimeyle ilgili sayfaları bulur", async () => {
    const { isError, data } = await s.call("read_datasheet", { product: "NE555P", search: "absolute maximum", max_chars: 8000 });
    expect(isError).toBe(false);
    expect(data.total_pages).toBeGreaterThan(5);
    expect(data.search_results.length).toBeGreaterThan(0);
    expect(data.pages[0].text.toLowerCase()).toContain("absolute maximum");
    expect(JSON.stringify(data.pages).length).toBeLessThan(12_000);
  });

  it("read_datasheet sayfa aralığı ve karakter sınırına uyar", async () => {
    const { data } = await s.call("read_datasheet", { product: "368374", pages: "1-2", max_chars: 3000 });
    expect(data.pages.length).toBeGreaterThanOrEqual(1);
    expect(data.pages.every((p: any) => p.page <= 2)).toBe(true);
    expect(data.pages.reduce((n: number, p: any) => n + p.text.length, 0)).toBeLessThanOrEqual(3000);
  });

  it("datasheet'i olmayan girdi için hata döner", async () => {
    const { isError } = await s.call("read_datasheet", { url: "https://www.ozdisan.com/" });
    expect(isError).toBe(true);
  });
});
