import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OzdisanClient } from "./api.js";
import { loadConfig, VERSION, type Config } from "./config.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerDatasheetTools } from "./tools/datasheet.js";
import { registerProductTools } from "./tools/products.js";

const INSTRUCTIONS = `Özdisan Elektronik (ozdisan.com) — Türkiye'nin en büyük elektronik komponent distribütörü — için salt-okunur katalog erişimi.
~960 bin ürün, 955 kategori, kategoriye özel parametrik filtreler, stok, fiyat kırılımları (KDV hariç) ve datasheet'ler.

Recommended workflows:
- Known part number → get_product (or search_products for partial numbers).
- Component selection by requirements → search_categories → get_category_filters → filter_products (in_stock=true, sort by price) → get_product → read_datasheet.
- Out of stock / EOL part → get_alternatives.
- Choosing between candidates → compare_products.
- Final BOM cost & availability → check_bom.
The 'product' field in results is Özdisan's product code; pass it to other tools. Category and property names are Turkish by default (language='en' for English).`;

export function createServer(config: Config = loadConfig()): { server: McpServer; client: OzdisanClient } {
  const client = new OzdisanClient(config);
  const server = new McpServer({ name: "ozdisan-mcp", title: "Özdisan MCP", version: VERSION }, { instructions: INSTRUCTIONS });
  const ctx = { client };

  registerProductTools(server, ctx);
  registerCategoryTools(server, ctx);
  registerDatasheetTools(server, ctx);

  server.registerPrompt(
    "komponent_sec",
    {
      title: "Devre için komponent seç",
      description: "Bir devre ihtiyacına uygun, Özdisan'da stokta olan komponentleri adım adım seçtirir.",
      argsSchema: {
        ihtiyac: z.string().describe("Aranan komponent ve gereksinimler, ör. '3.3V çıkışlı, en az 500mA, SOT-23 LDO regülatör'"),
        adet: z.string().optional().describe("Planlanan adet (fiyat kırılımı için)"),
      },
    },
    ({ ihtiyac, adet }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Özdisan MCP araçlarını kullanarak şu ihtiyaç için komponent seç: "${ihtiyac}".` +
              (adet ? ` Planlanan adet: ${adet}.` : "") +
              `\n\n1. search_categories ile en uygun (en alt seviye) kategoriyi bul.` +
              `\n2. get_category_filters ile filtreleri ve geçerli seçenek değerlerini incele.` +
              `\n3. filter_products ile gereksinimlere göre filtrele (in_stock=true, gerekirse sort fiyat).` +
              `\n4. En iyi 2-4 adayı compare_products ile karşılaştır.` +
              `\n5. Seçtiğin parçanın kritik değerlerini read_datasheet ile doğrula (absolute maximum, pin yapısı, tipik uygulama).` +
              `\n6. Sonucu: parça numarası, üretici, neden seçildiği, stok, birim fiyat ve ürün linkiyle özetle; uygun bir yedek (alternatif) de öner.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "bom_kontrol",
    {
      title: "BOM stok ve fiyat kontrolü",
      description: "Bir malzeme listesini (parça numarası + adet) Özdisan stok ve fiyatlarına göre kontrol ettirir.",
      argsSchema: {
        bom: z.string().describe("Her satırda 'parça_numarası adet' olacak şekilde malzeme listesi"),
        kart_sayisi: z.string().optional().describe("Üretilecek kart sayısı"),
      },
    },
    ({ bom, kart_sayisi }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Aşağıdaki BOM'u check_bom aracıyla Özdisan'da kontrol et${kart_sayisi ? ` (${kart_sayisi} kart için)` : ""}. ` +
              `Stokta olmayan, EOL veya bulunamayan kalemler için get_alternatives ve search_products ile alternatif öner, ` +
              `sonunda toplam maliyeti ve riskli kalemleri tablo halinde özetle.\n\n${bom}`,
          },
        },
      ],
    }),
  );

  return { server, client };
}
