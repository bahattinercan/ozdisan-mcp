// Birim testlerinde kullanılan örnek verileri ozdisan.com'dan yeniden üretir.
// Kullanım: node scripts/update-fixtures.mjs
import { writeFileSync } from "node:fs";

const BASE = "https://www.ozdisan.com";
const UA = "ozdisan-mcp fixture updater";
const out = new URL("../test/fixtures/", import.meta.url);

async function post(path, body, lang = "tr") {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Language": lang, "User-Agent": UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function save(name, data) {
  writeFileSync(new URL(name, out), `${JSON.stringify(data, null, 1)}\n`);
  console.log("yazıldı:", name);
}

// 1) Lineer regülatör kategorisinden 3 ürünlük liste (filtre şemasıyla birlikte)
const list = await post("/api/ps", {
  type: "GetListData",
  catSequenceId: "279",
  pagination: { currentPage: 1, pageSize: 3 },
  sort: { key: "stockQuantity", isProp: false, isDesc: true },
  currencyCode: "TRY",
  search: "",
});
for (const pf of list.propertyFilters ?? []) pf.values = (pf.values ?? pf.options ?? []).slice(0, 60);
delete list.categoryTree;
save("list-279.json", list);

// 2) Ürün detay sayfası (STM32F103C8T6)
const html = await (await fetch(`${BASE}/p/urun/urun-368374`, { headers: { "User-Agent": UA } })).text();
const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
const pp = JSON.parse(m[1]).props.pageProps;
save("product-368374.json", { data: pp.data, breadcrumbData: pp.breadcrumbData, initialPrice: pp.initialPrice });

// 3) Kısaltılmış kategori ağacı: her seviyede ilk birkaç dal + test için gereken dallar
const tree = await post("/api/categories/categories", { filters: {} });
const keep = new Set([1, 9, 52, 55, 218, 279, 3]);
function slim(nodes, depth) {
  return nodes
    .filter((n, i) => keep.has(n.sequenceId) || i < (depth === 1 ? 5 : 2))
    .map((n) => ({
      name: n.name,
      slug: n.slug,
      sequenceId: n.sequenceId,
      level: n.level,
      productCount: n.productCount,
      subCategories: slim(n.subCategories ?? [], depth + 1),
    }));
}
save("category-tree-tr.json", { totalCount: tree.totalCount, categories: slim(tree.categories, 1) });

// 4) Hızlı arama
const quick = await (
  await fetch(`${BASE}/api/layout/header?text=lm317`, { headers: { "User-Agent": UA, "Accept-Language": "tr" } })
).json();
quick.variants = quick.variants.slice(0, 6);
save("quick-lm317.json", quick);
