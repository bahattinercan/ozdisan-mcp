import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/server.js";
import { fail } from "../../src/tools/shared.js";
import { SiteContractError } from "../../src/http.js";
import { fixture, html, json, mockFetch, nextDataPage, testConfig } from "../helpers.js";
import { makePdf } from "../pdf-helper.js";

const tree = fixture("category-tree-tr.json");
const quick = fixture("quick-lm317.json");
const product = fixture("product-368374.json");
const list = fixture("list-279.json");
const pdf = makePdf(["Pin Configuration", "Absolute Maximum Ratings VCC 3.6 V"]);

const EXPECTED_TOOLS = [
  "browse_categories",
  "check_bom",
  "compare_products",
  "download_datasheet",
  "filter_products",
  "get_alternatives",
  "get_category_filters",
  "get_product",
  "read_datasheet",
  "search_categories",
  "search_products",
];

let client: Client;
let calls: ReturnType<typeof mockFetch>["calls"];
const config = testConfig();

beforeEach(async () => {
  const mock = mockFetch([
    {
      match: (u, _i, b) => u.includes("/api/categories/categories") && b?.filters?.search,
      respond: () =>
        json({
          totalCount: 145,
          categories: [
            {
              name: "Elektronik Komponentler",
              slug: "elektronik-komponentler-1",
              sequenceId: 1,
              productCount: 145,
              subCategories: [
                { name: "Lineer Voltaj Regülatörleri", slug: "lineer-voltaj-regulatorleri-279", sequenceId: 279, productCount: 145, subCategories: [] },
              ],
            },
          ],
        }),
    },
    { match: (u) => u.includes("/api/categories/categories"), respond: () => json(tree) },
    { match: (u) => u.includes("/api/layout/header"), respond: () => json(quick) },
    { match: (u, _i, b) => u.endsWith("/api/ps") && b?.type === "GetListData", respond: () => json(list) },
    {
      match: (u, _i, b) => u.endsWith("/api/ps") && b?.type === "GetTopFilterData",
      respond: () => json({ totalCount: 42, propertyFilters: list.propertyFilters }),
    },
    { match: (u) => u.includes("/p/urun/urun-368374"), respond: () => html(nextDataPage(product)) },
    {
      // Hiç anlamlı özelliği olmayan ürün (karşılaştırma çökmemeli)
      match: (u) => u.includes("/p/urun/urun-111111"),
      respond: () =>
        html(
          nextDataPage({
            ...product,
            data: {
              ...product.data,
              erpRefId: "111111",
              sku: "BOS-OZELLIK",
              medias: [],
              properties: product.data.properties.map((p: { value: string }) => ({ ...p, value: "-" })),
            },
          }),
        ),
    },
    { match: (u) => u.includes("/api/products/variantPrice"), respond: () => new Response("hata", { status: 400 }) },
    { match: (u) => u.includes("/p/urun/urun-"), respond: () => new Response("yok", { status: 404 }) },
    { match: (u) => u.includes("/api/products/relation"), respond: () => json({ relations: [], relationCounts: [] }) },
    {
      match: (u) => u.includes("/api/pdf/resolve"),
      respond: () =>
        json({
          url: "https://cdn.ozdisan.com/public/product/assets/STM32F103x8%20STM32F103xB.pdf?resolved=1",
          fileName: "STM32F103x8 STM32F103xB.pdf",
          isExternal: false,
        }),
    },
    {
      match: (u) => u.startsWith("https://cdn.ozdisan.com/"),
      respond: () => new Response(pdf, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) } }),
    },
  ]);
  calls = mock.calls;
  vi.stubGlobal("fetch", mock.impl);
  const { server } = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "unit-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  vi.unstubAllGlobals();
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  return { isError: !!res.isError, data: JSON.parse(content[0]!.text) };
}

describe("MCP sunucusu (sahte ağ ile)", () => {
  it("tüm araçları açıklama ve şemayla listeler", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations?.openWorldHint).toBe(true);
    }
  });

  it("istemlere (prompts) sahiptir", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["bom_kontrol", "komponent_sec"]);
    const p = await client.getPrompt({ name: "komponent_sec", arguments: { ihtiyac: "3.3V LDO" } });
    expect(JSON.stringify(p.messages)).toContain("3.3V LDO");
  });

  it("sunucu talimatlarını iletir", () => {
    expect(client.getInstructions()).toContain("filter_products");
  });

  it("get_product ayrıntıları döndürür", async () => {
    const { isError, data } = await call("get_product", { product: "368374" });
    expect(isError).toBe(false);
    expect(data.part_number).toBe("STM32F103C8T6");
    expect(data.pricing.price_breaks.length).toBeGreaterThan(1);
    expect(data.datasheet_url).toContain("resolved=1");
  });

  it("get_product bilinmeyen üründe isError döner", async () => {
    const { isError, data } = await call("get_product", { product: "999999999" });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/bulunamadı/);
  });

  it("filter_products filtreleri istek gövdesine yansıtır", async () => {
    const { isError, data } = await call("filter_products", {
      category: "279",
      filters: [{ property: "Montaj Tipi", values: ["SMT"] }],
      ranges: [{ property: "Çıkış Akımı", min: 500, unit: "mA" }],
      in_stock: true,
      sort: { by: "price" },
      page_size: 3,
    });
    expect(isError).toBe(false);
    expect(data.products.length).toBe(3);
    const body = calls.filter((c) => c.body?.type === "GetListData").at(-1)!.body;
    expect(body.catSequenceId).toBe("279");
    expect(body.valueFilters[0].values).toEqual(["SMT"]);
    expect(body.numericValueFilters[0].lower).toBe(500);
    expect(body.filterOptions).toEqual([{ code: "stockingOptions", value: "InStock" }]);
    expect(body.sort).toEqual({ key: "price", isProp: false, isDesc: false });
    expect(body.pagination).toEqual({ currentPage: 1, pageSize: 3 });
  });

  it("filter_products geçersiz değerde öneri verir", async () => {
    const { isError, data } = await call("filter_products", {
      category: "279",
      filters: [{ property: "Montaj Tipi", values: ["YÜZEY"] }],
    });
    expect(isError).toBe(true);
    expect(data.property).toBe("Montaj Tipi");
  });

  it("get_category_filters özellikleri ve mevcut filtre sonucunu döndürür", async () => {
    const { data } = await call("get_category_filters", { category: "279", manufacturers: [list.propertyFilters[0].values[0].value] });
    expect(data.properties.some((p: { name: string }) => p.name === "Kılıf / Kasa")).toBe(true);
    expect(data.matching_products).toBe(42);
    const one = await call("get_category_filters", { category: "279", property: "Çıkış Akımı" });
    expect(one.data.property.type).toBe("numeric");
    expect(one.data.property.units).toContain("mA");
  });

  it("search_products kategori dağılımı ve ürünleri döndürür", async () => {
    const { data } = await call("search_products", { query: "lm317" });
    expect(data.categories[0].category).toBe("lineer-voltaj-regulatorleri-279");
    expect(data.products.length).toBeGreaterThan(0);
  });

  it("search_categories ve browse_categories çalışır", async () => {
    const s = await call("search_categories", { query: "mikroişlemci" });
    expect(s.data.categories_by_name[0].category).toBe("mikroislemciler-218");
    const b = await call("browse_categories", {});
    expect(b.data.categories).toHaveLength(5);
    const c = await call("browse_categories", { category: "9" });
    expect(c.data.subcategories.length).toBeGreaterThan(0);
  });

  it("check_bom satır ve toplamları hesaplar", async () => {
    const { data } = await call("check_bom", {
      items: [
        { part: "368374", quantity: 10, reference: "U1" },
        { part: "999999999", quantity: 1 },
      ],
      boards: 2,
    });
    expect(data.lines[0].order_qty).toBe(20);
    expect(data.lines[0].line_total).toBeGreaterThan(0);
    expect(data.lines[1].status).toBe("not_found");
    expect(data.total_excl_vat).toBe(data.lines[0].line_total);
  });

  it("download_datasheet dosyayı kaydeder, read_datasheet metni okur", async () => {
    const dl = await call("download_datasheet", { product: "368374" });
    expect(dl.isError).toBe(false);
    expect(existsSync(dl.data.file_path)).toBe(true);
    expect(readFileSync(dl.data.file_path).subarray(0, 5).toString()).toBe("%PDF-");
    const again = await call("download_datasheet", { product: "368374" });
    expect(again.data.already_downloaded).toBe(true);

    const read = await call("read_datasheet", { product: "368374", search: "absolute maximum" });
    expect(read.data.total_pages).toBe(2);
    expect(read.data.pages[0].page).toBe(2);
    expect(read.data.pages[0].text).toContain("Absolute Maximum");
  });

  it("compare_products özelliksiz ürünle çökmez", async () => {
    const { isError, data } = await call("compare_products", { products: ["368374", "111111"] });
    expect(isError).toBe(false);
    expect(data.columns).toHaveLength(2);
    for (const row of Object.values(data.specs) as unknown[][]) expect(row[1]).toBeNull();
  });

  it("fiyat sorgusu başarısız olunca ürünü 'teklif gerekli' diye göstermez", async () => {
    // EUR fiyatı sayfada yok → fiyat API'si çağrılır ve (sahte) hata döner
    const { data } = await call("get_product", { product: "368374", currency: "EUR" });
    expect(data.pricing.price_unavailable).toBe(true);
    expect(data.pricing.price_on_request).toBeUndefined();
    const bom = await call("check_bom", { items: [{ part: "368374", quantity: 1 }], currency: "EUR" });
    expect(bom.data.lines[0].issues.join(" ")).toMatch(/alınamadı/);
  });

  it("read_datasheet parametre doğrulaması yapar", async () => {
    const { isError } = await call("read_datasheet", {});
    expect(isError).toBe(true);
  });
});

describe("SiteContractError kullanıcıya doğru ipucu verir", () => {
  it("ipucu doctor komutuna ve güncellemeye yönlendirir", () => {
    const res = fail(new SiteContractError("Kategori yanıtı beklenen yapıda değil."));
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(res.isError).toBe(true);
    expect(text).toContain("doctor");
    expect(text).toContain("veri");
  });
});
