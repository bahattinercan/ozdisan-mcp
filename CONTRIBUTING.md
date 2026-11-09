# Katkı Rehberi

Katkılar memnuniyetle karşılanır. Bu depo, `ozdisan-mcp` projesinin bir çatalıdır; özgün proje:
<https://github.com/mert-ozkul/ozdisan-mcp>.

## Hızlı başlangıç

```bash
npm install        # bağımlılıklar + derleme (prepare)
npm test           # birim testleri (ağ gerekmez)
npm run e2e        # canlı ozdisan.com'a karşı uçtan uca testler
npm run doctor     # canlı uç noktaların hâlâ beklenen yapıda olduğunu doğrular
```

Node.js **22 veya üstü** gerekir. TypeScript strict + `noUncheckedIndexedAccess` ile derlenir.

## Göndermeden önce

```bash
npm run typecheck && npm test
```

Ağa çıkan değişikliklerde ayrıca `npm run test:e2e` (canlı site, ~20 sn) çalıştırın. Site davranışı değiştiyse
önce `npm run doctor` çıktısını issue'ya ekleyin — hangi uç noktanın bozulduğunu tek bakışta gösterir.

## Kurallar

- **Küçük, tek amaçlı PR.** Refactor ile davranış değişikliğini aynı PR'a koymayın.
- **Hata yutma yok.** Boş `catch`, sessiz `return undefined`, `as any`, `@ts-ignore` yerine tipi düzeltin.
  Özdisan yanıtı beklenen yapıda değilse **boş sonuç döndürmeyin**: `SiteContractError` fırlatın
  (`src/api.ts` içindeki `siteContractError` yardımcısı).
- **Kullanıcı hatası ile site hatasını ayırın.**
  - Kullanıcı girdisi hatalı / ürün gerçekten yok → `UserInputError` (mesaj kullanıcıya gösterilir).
  - Ağ, zaman aşımı, HTTP hatası → `OzdisanError`.
  - Site yapısı değişmiş → `SiteContractError` (`npm run doctor` yönlendirmesi otomatik eklenir).
- **Yeni araç eklerken:** `registerTool` şemasına açıklama + `readOnlyAnnotations` ekleyin, sonucu
  `ok()`/`handle()` ile döndürün, `test/unit/server.test.ts` içindeki `EXPECTED_TOOLS` listesini güncelleyin.
- **Yeni uç nokta kullanıyorsanız** `scripts/doctor.mjs` içine bir denetim ekleyin; böylece site değiştiğinde
  sessizce bozulmak yerine FAIL görünür.
- **Test:** hata düzeltiyorsanız önce hatayı gösteren testi yazın (kırmızı), sonra düzeltin (yeşil).
  Testi zayıflatmayın.
- **Kullanıcıya görünen metinler Türkçe** (araç açıklamaları hariç: MCP araç açıklamaları İngilizcedir, çünkü
  model tarafından okunur; mevcut deseni izleyin).
- Yeni bağımlılık eklemeden önce issue'da gerekçesini konuşun; bağımlılık yüzeyini küçük tutmak bu projenin
  tasarım tercihidir (şu an: `@modelcontextprotocol/sdk`, `zod`, `unpdf`).

## Hata bildirimi

Issue şablonunu kullanın ve şunları ekleyin: `node --version`, `ozdisan-mcp --version`, `npm run doctor --json`
çıktısı, hatalı araç çağrısı ve dönen sonuç (fiyat/stok değerlerini maskeleyebilirsiniz).
