import { describe, expect, it } from "vitest";
import { OzdisanClient } from "../../src/api.js";
import {
  buildProductDetail,
  clean,
  isMeaningful,
  orderableQuantity,
  priceBreaksFrom,
  propertyNameMap,
  summarizeListVariant,
  unitPriceAt,
} from "../../src/normalize.js";
import type { RawListResponse, RawProductPage } from "../../src/types.js";
import { fixture, testConfig } from "../helpers.js";

const client = new OzdisanClient(testConfig());

describe("fiyat hesapları", () => {
  const breaks = [
    { qty: 1, unit_price: 10 },
    { qty: 100, unit_price: 8 },
    { qty: 1000, unit_price: 6 },
  ];

  it("adet için doğru fiyat kırılımını seçer", () => {
    expect(unitPriceAt(breaks, 1)?.unit_price).toBe(10);
    expect(unitPriceAt(breaks, 99)?.unit_price).toBe(10);
    expect(unitPriceAt(breaks, 100)?.unit_price).toBe(8);
    expect(unitPriceAt(breaks, 5000)?.unit_price).toBe(6);
    expect(unitPriceAt([{ qty: 50, unit_price: 1 }], 10)).toBeUndefined();
  });

  it("MOQ ve sipariş katını uygular", () => {
    expect(orderableQuantity(7)).toBe(7);
    expect(orderableQuantity(7, 10)).toBe(10);
    expect(orderableQuantity(23, 1, 5)).toBe(25);
    expect(orderableQuantity(3, 10, 4)).toBe(12);
  });
});

describe("clean / isMeaningful", () => {
  it("boş alanları temizler", () => {
    expect(clean({ a: 1, b: undefined, c: null, d: [], e: {}, f: { g: undefined }, h: [{ i: undefined, j: 2 }] })).toEqual({
      a: 1,
      h: [{ j: 2 }],
    });
  });

  it("anlamsız değerleri ayıklar", () => {
    expect(isMeaningful("None")).toBe(false);
    expect(isMeaningful("N/A")).toBe(false);
    expect(isMeaningful(" - ")).toBe(false);
    expect(isMeaningful("3.3 V")).toBe(true);
  });
});

describe("liste ürünü özeti", () => {
  const list = fixture<RawListResponse>("list-279.json");
  const names = propertyNameMap(list);

  it("özellik adlarını istenen dile eşler ve URL üretir", () => {
    const v = list.variantList.data[0]!;
    const s = summarizeListVariant(v, { client, lang: "tr", currency: "TRY", names, quantity: 10 });
    expect(s.product).toBe(v.erpRefId);
    expect(s.part_number).toBe(v.sku);
    expect(s.url).toBe(`https://www.ozdisan.com/p/${v.fullPath}`);
    expect(s.stock).toBe(v.availability?.totalStock ?? 0);
    // İngilizce anahtarlar yerine Türkçe adlar
    expect(Object.keys(s.specs ?? {}).some((k) => /Kılıf|Montaj|Çıkış/.test(k))).toBe(true);
    expect(Object.values(s.specs ?? {}).every((val) => isMeaningful(val))).toBe(true);
  });

  it("include_specs=false iken özellikleri çıkarmaz", () => {
    const s = summarizeListVariant(list.variantList.data[0]!, { client, lang: "en", currency: "TRY", names, includeSpecs: false });
    expect(s.specs).toBeUndefined();
    expect(s.url.startsWith("https://www.ozdisan.com/en/p/")).toBe(true);
  });

  it("fiyatı gösterilmeyen ürünü teklif gerekli olarak işaretler", () => {
    const v = { ...list.variantList.data[0]!, prices: [], availability: { ...list.variantList.data[0]!.availability, isShowPrice: false } };
    const s = summarizeListVariant(v, { client, lang: "tr", currency: "TRY", names });
    expect(s.price_on_request).toBe(true);
    expect(s.price_breaks).toBeUndefined();
  });
});

describe("ürün detayı", () => {
  const page = { ...fixture<RawProductPage>("product-368374.json"), url: "https://www.ozdisan.com/p/mikroislemciler-218/stm-stm32f103c8t6-368374" };

  it("fiyat kırılımlarını para birimine göre çıkarır", () => {
    const tr = priceBreaksFrom(page.initialPrice?.response, "TRY");
    const usd = priceBreaksFrom(page.initialPrice?.response, "USD");
    expect(tr?.breaks.length).toBeGreaterThan(1);
    expect(usd?.breaks.length).toBe(tr?.breaks.length);
    expect(tr!.breaks[0]!.unit_price).toBeGreaterThan(usd!.breaks[0]!.unit_price);
    expect(priceBreaksFrom(page.initialPrice?.response, "EUR")).toBeUndefined();
  });

  it("ham sayfa verisini ayrıntılı ürün nesnesine dönüştürür", () => {
    const d = buildProductDetail(page, {
      client,
      lang: "tr",
      currency: "TRY",
      datasheet: { url: "https://cdn.ozdisan.com/public/product/assets/x.pdf", fileName: "x.pdf" },
    });
    expect(d.product).toBe("368374");
    expect(d.part_number).toBe("STM32F103C8T6");
    expect(d.manufacturer).toBe("STM");
    expect(d.category?.path.at(-1)).toBe(d.category?.name);
    expect(d.specs["Kılıf / Kasa"]).toMatch(/LQFP48/);
    expect(d.pricing.currency).toBe("TRY");
    expect((d.pricing.price_breaks as unknown[]).length).toBeGreaterThan(1);
    expect(d.datasheet_url).toContain("x.pdf");
    expect(d.url).toContain("368374");
  });
});
