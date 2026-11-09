// ozdisan-mcp teşhis aracı: sitenin kullandığımız uç noktaları hâlâ beklediğimiz yapıda
// döndürüp döndürmediğini tek tek denetler. Site değiştiğinde araçlar sessizce boş sonuç
// vermek yerine burada FAIL olarak görünür.
// Kullanım:
//   npm run doctor              okunabilir tablo (dist derlemesini de yapar)
//   node scripts/doctor.mjs     derlenmiş dist ile doğrudan
//   node scripts/doctor.mjs --json   makine tarafından okunabilir çıktı
import { existsSync } from "node:fs";

const distApi = new URL("../dist/api.js", import.meta.url);
const distConfig = new URL("../dist/config.js", import.meta.url);
if (!existsSync(distApi) || !existsSync(distConfig)) {
  console.error("dist/ bulunamadı. Önce 'npm run build' çalıştırın (veya 'npm run doctor' kullanın).");
  process.exit(2);
}

const { leafHits, OzdisanClient } = await import(distApi.href);
const { loadConfig, VERSION } = await import(distConfig.href);

const jsonOutput = process.argv.includes("--json");
const config = loadConfig();
const client = new OzdisanClient(config);
const results = [];

/** Bir denetimi çalıştırır; süre ve sonuç ayrıntısını toplar. */
async function check(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - startedAt, detail });
    if (!jsonOutput) console.log(`  PASS  ${name} (${Date.now() - startedAt} ms) — ${detail}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms: Date.now() - startedAt, error: message });
    if (!jsonOutput) console.log(`  FAIL  ${name} (${Date.now() - startedAt} ms) — ${message}`);
  }
}

if (!jsonOutput) {
  console.log(`ozdisan-mcp doctor ${VERSION}`);
  console.log(`hedef: ${config.baseUrl} (dil: ${config.language}, para birimi: ${config.currency})`);
  console.log("");
}

let probeSku;
let probeCategoryId;
let probeDatasheet;

await check("kategori ağacı (/api/categories/categories)", async () => {
  const index = await client.getCategoryIndex();
  if (!index.totalCount) throw new Error("totalCount 0 döndü");
  // Denetimler için ürünü olan bir yaprak kategori seçilir (kök kategoriler boş liste döndürebilir).
  probeCategoryId = index.bySeq.has(279) ? 279 : leafHits(index.roots).find((l) => l.count > 0)?.sequenceId;
  return `${index.bySeq.size} kategori, ${index.totalCount} ürün`;
});

await check("hızlı arama (/api/layout/header)", async () => {
  const res = await client.quickSearch("LM317");
  const variants = res.variants ?? [];
  if (!variants.length) throw new Error("LM317 için hiç eşleşme dönmedi");
  probeSku = variants[0].sku;
  return `${variants.length} eşleşme, ilk: ${probeSku}`;
});

await check("ürün listesi (/api/ps GetListData)", async () => {
  if (!probeCategoryId) throw new Error("ürünü olan yaprak kategori seçilemedi");
  const categoryId = probeCategoryId;
  const res = await client.listProducts(categoryId, { page: 1, pageSize: 1 });
  if (!res.variantList?.totalCount) throw new Error("variantList.totalCount 0 döndü");
  return `${categoryId}: ${res.variantList.totalCount} ürün, ${res.tableProperties?.length ?? 0} tablo sütunu`;
});

await check("kategori filtreleri (/api/ps GetTopFilterData)", async () => {
  if (!probeCategoryId) throw new Error("ürünü olan yaprak kategori seçilemedi");
  const categoryId = probeCategoryId;
  const res = await client.getAvailableFilters(categoryId, {}, undefined);
  if (!res.propertyFilters?.length) throw new Error("propertyFilters boş döndü");
  return `${categoryId}: ${res.propertyFilters.length} özellik, totalCount ${res.totalCount}`;
});

await check("ürün detay sayfası (HTML __NEXT_DATA__)", async () => {
  if (!probeSku) throw new Error("önce hızlı arama başarılı olmalı");
  const resolved = await client.resolveProduct(probeSku);
  const page = await client.getProductPage(resolved.erpRefId);
  if (!page.data?.sku) throw new Error("data.sku yok");
  const media = page.data.medias?.find((m) => m.field === "Datasheet")?.path;
  probeDatasheet = media ? { sku: page.data.sku, media } : undefined;
  return `${page.data.sku} (kod ${page.data.erpRefId}), ${page.data.properties?.length ?? 0} özellik`;
});

await check("fiyat uç noktası (/api/products/variantPrice)", async () => {
  if (!probeCategoryId) throw new Error("ürünü olan yaprak kategori seçilemedi");
  const list = await client.listProducts(probeCategoryId, { page: 1, pageSize: 10 });
  const variant = (list.variantList.data ?? []).find((v) => v.availability?.isShowPrice !== false);
  if (!variant) return "bu kategoride fiyat gösteren ürün yok — atlandı";
  const res = await client.getVariantPrices(variant.id, config.currency);
  const packages = res?.data?.packages ?? [];
  if (!packages.length) throw new Error("fiyat paketi dönmedi");
  const breaks = packages[0]?.priceBreaks ?? [];
  const price = breaks.flatMap((b) => b.prices ?? []).find((p) => p.currency === config.currency);
  if (!price) throw new Error(`${config.currency} fiyatı dönmedi`);
  return `${variant.sku}: ${packages.length} paket, ${breaks.length} kırılım, ${config.currency} ${price.price}`;
});

await check("datasheet çözümleme (/api/pdf/resolve)", async () => {
  if (!probeDatasheet) return "bu ürünün datasheet bağlantısı yok — atlandı";
  const ds = await client.resolveDatasheetUrl(probeDatasheet.sku, probeDatasheet.media);
  if (!ds?.url) throw new Error("datasheet adresi çözümlenemedi");
  return `${new URL(ds.url).host}${ds.isExternal ? " (harici)" : ""}`;
});

const failed = results.filter((r) => !r.ok);
if (jsonOutput) {
  console.log(JSON.stringify({ version: VERSION, baseUrl: config.baseUrl, ok: failed.length === 0, checks: results }, null, 2));
} else {
  console.log("");
  console.log(
    failed.length === 0
      ? `SONUÇ: ${results.length} denetim geçti. Uç noktalar beklenen yapıda.`
      : `SONUÇ: ${failed.length}/${results.length} denetim BAŞARISIZ. Araçlar hatalı sonuç verebilir; ` +
          `sorun sürüyorsa https://github.com/bahattinercan/ozdisan-mcp adresinde issue açın.`,
  );
}
process.exit(failed.length === 0 ? 0 : 1);
