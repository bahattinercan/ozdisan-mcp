<div align="center">

# Özdisan MCP

**Yapay zekâ asistanınıza Türkiye'nin en büyük elektronik komponent kataloğunu bağlayın.**

Claude, Cursor, VS Code Copilot ve diğer MCP uyumlu araçlar için [ozdisan.com](https://www.ozdisan.com) üzerinde
**~960.000 ürün** ve **955 kategoride** arama, parametrik filtreleme, fiyat/stok sorgulama, muadil bulma,
BOM maliyetlendirme ve **datasheet indirme/okuma** yapan, tamamen bilgisayarınızda çalışan bir MCP sunucusu.

[![npm](https://img.shields.io/npm/v/ozdisan-mcp?color=cb3837&label=npm)](https://www.npmjs.com/package/ozdisan-mcp)
[![CI](https://github.com/mert-ozkul/ozdisan-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mert-ozkul/ozdisan-mcp/actions/workflows/ci.yml)
[![Lisans: MIT](https://img.shields.io/badge/lisans-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-uyumlu-8A2BE2)](https://modelcontextprotocol.io)

</div>

---

## İçindekiler

- [Neden?](#neden)
- [Neler yapabilir?](#neler-yapabilir)
- [Hızlı başlangıç](#hızlı-başlangıç)
- [Kurulum (istemciye göre)](#kurulum-istemciye-göre)
- [Örnek kullanım](#örnek-kullanım)
- [Araç referansı](#araç-referansı)
- [Ayarlar (ortam değişkenleri)](#ayarlar-ortam-değişkenleri)
- [Nasıl çalışır?](#nasıl-çalışır)
- [Geliştirme ve testler](#geliştirme-ve-testler)
- [Sık sorulan sorular](#sık-sorulan-sorular)
- [Sorumluluk reddi](#sorumluluk-reddi)

## Neden?

Devre tasarlarken yapay zekâya "3.3 V çıkışlı, en az 500 mA veren, SOT-23 kılıflı, stokta olan en ucuz LDO hangisi?" diye
sorduğunuzda genellikle ezbere, stok durumu bilinmeyen veya artık üretilmeyen parçalar önerir. **Özdisan MCP** ile asistanınız:

- Özdisan'ın **güncel stok ve fiyat** bilgisine erişir,
- kategoriye özel **parametrik filtrelerle** (kılıf, voltaj, akım, kapasitans, tolerans…) gerçekten var olan ürünleri bulur,
- seçtiği parçanın **datasheet'ini okuyarak** pin yapısı, mutlak maksimum değerler ve tipik uygulama devresini doğrular,
- stokta olmayan parçalar için **muadil** önerir ve **BOM** maliyetinizi çıkarır.

API anahtarı, üyelik veya ücret gerekmez. Sunucu sizin bilgisayarınızda çalışır ve yalnızca **okuma** yapar.

## Neler yapabilir?

| Araç | Ne işe yarar? |
|---|---|
| `search_products` | Parça numarası veya anahtar kelimeyle tüm katalogda arama (`STM32F103`, `NE555`, `10uF 0805`…) |
| `get_product` | Tek ürünün tüm detayları: teknik özellikler, stok, tedarik süresi, MOQ, fiyat kırılımları, datasheet bağlantısı |
| `search_categories` | Türkçe/İngilizce kategori arama (`mosfet`, `lineer regülatör`, `linear voltage regulator`) |
| `browse_categories` | Kategori ağacında gezinme (ürün sayılarıyla) |
| `get_category_filters` | Bir kategorinin tüm filtreleri: özellikler, birimler, seçilebilir değerler, üreticiler |
| `filter_products` | Sitedeki filtre paneliyle aynı: değer ve **birimli sayısal aralık** filtreleri, stok/RoHS, sıralama, sayfalama |
| `get_alternatives` | Muadil (substitute), benzer, aksesuar ve parametrik eşdeğer ürünler |
| `compare_products` | 2–10 ürünü özellik özellik karşılaştırma (farklı olanları işaretler) |
| `check_bom` | Malzeme listesini stok, MOQ, sipariş katı, fiyat kırılımı ve EOL durumuna göre kontrol edip maliyetlendirme |
| `download_datasheet` | Datasheet PDF'ini bilgisayarınıza indirme |
| `read_datasheet` | Datasheet içinden metin okuma ve anahtar kelimeyle ilgili sayfayı bulma (`absolute maximum`, `pin configuration`…) |

Ayrıca iki hazır istem (prompt) gelir: **`komponent_sec`** (ihtiyaca göre adım adım parça seçimi) ve
**`bom_kontrol`** (BOM'u kontrol edip riskli kalemlere alternatif önerme).

## Hızlı başlangıç

Tek gereksinim **[Node.js](https://nodejs.org) 22 veya üstü**. Kurulu olup olmadığını kontrol edin:

```bash
node --version
```

Ardından kullandığınız yapay zekâ aracına aşağıdaki MCP sunucu tanımını ekleyin:

```json
{
  "mcpServers": {
    "ozdisan": {
      "command": "npx",
      "args": ["-y", "ozdisan-mcp"]
    }
  }
}
```

İstemcinizi yeniden başlatın ve şunu sorun: *"Özdisan'da stokta olan, 3.3V çıkışlı, en az 500mA veren SOT-23 kılıflı LDO'ları fiyata göre listele."*

> **Bu paket npm'de yayında:** `ozdisan-mcp@0.1.x`. GitHub'dan (fork'unuzdan veya upstream'den) kurmak isterseniz
> `"args": ["-y", "github:mert-ozkul/ozdisan-mcp"]` kullanın (ilk çalıştırmada derleme yaptığı için biraz daha uzun sürer).

## Kurulum (istemciye göre)

<details open>
<summary><b>Claude Desktop</b></summary>

`Ayarlar → Geliştirici → Yapılandırmayı düzenle` menüsünden `claude_desktop_config.json` dosyasını açın:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ozdisan": {
      "command": "npx",
      "args": ["-y", "ozdisan-mcp"]
    }
  }
}
```

Claude Desktop'ı tamamen kapatıp açın. Sohbet kutusundaki araç simgesinde **ozdisan** görünmelidir.
</details>

<details>
<summary><b>Claude Code (terminal)</b></summary>

```bash
claude mcp add ozdisan -- npx -y ozdisan-mcp
```

Tüm projelerinizde kullanmak için `--scope user` ekleyin. Kontrol: `claude mcp list`.
</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json` (tüm projeler) veya projedeki `.cursor/mcp.json` dosyasına ekleyin:

```json
{
  "mcpServers": {
    "ozdisan": {
      "command": "npx",
      "args": ["-y", "ozdisan-mcp"]
    }
  }
}
```
</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b></summary>

Projenizde `.vscode/mcp.json` oluşturun:

```json
{
  "servers": {
    "ozdisan": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ozdisan-mcp"]
    }
  }
}
```

Copilot Chat'i **Agent** modunda kullanın.
</details>

<details>
<summary><b>Windsurf, Cline, Zed ve diğerleri</b></summary>

Stdio destekleyen her MCP istemcisinde komut `npx`, argümanlar `-y ozdisan-mcp` olacak şekilde tanımlayın.
Windsurf için dosya: `~/.codeium/windsurf/mcp_config.json` (biçim Claude Desktop ile aynıdır).
</details>

<details>
<summary><b>Kaynaktan kurulum (npx kullanmadan)</b></summary>

```bash
git clone https://github.com/mert-ozkul/ozdisan-mcp.git
cd ozdisan-mcp
npm install
npm run build
```

İstemci yapılandırmasında `npx` yerine derlenmiş dosyayı gösterin:

```json
{
  "mcpServers": {
    "ozdisan": {
      "command": "node",
      "args": ["/tam/yol/ozdisan-mcp/dist/index.js"]
    }
  }
}
```
</details>

> **Windows ipucu:** İstemciniz `npx` komutunu bulamazsa `"command": "cmd"`, `"args": ["/c", "npx", "-y", "ozdisan-mcp"]` kullanın.

## Örnek kullanım

Asistanınıza doğal dilde sormanız yeterli; hangi aracı ne zaman kullanacağına kendisi karar verir.

**Parça seçimi**
> ESP32 tabanlı bir sensör kartı tasarlıyorum. 5V'tan 3.3V üretecek, en az 500 mA verebilen, SOT-23 kılıflı ve
> Özdisan'da stokta olan LDO'ları 100 adetlik fiyata göre sırala; en uygun ikisini datasheet'lerinden dropout
> voltajını kontrol ederek karşılaştır.

Arka planda yaklaşık olarak şu çağrılar yapılır:
`search_categories("LDO regülatör")` → `get_category_filters("lineer-voltaj-regulatorleri-279")` →
`filter_products(... ranges: Çıkış Voltajı = 3.3 V, Çıkış Akımı ≥ 500 mA, Kılıf contains "SOT23", in_stock, sort: price)` →
`compare_products(...)` → `read_datasheet(..., search: "dropout")`.

**Parça numarasıyla sorgu**
> STM32F103C8T6'nın Özdisan'daki stoğu, 1000 adet fiyatı ve tedarik süresi ne? Pin sayısı ve flash boyutunu da yaz.

**Muadil bulma**
> LM317T stokta yok. Özdisan'da stokta olan TO-220 kılıflı muadillerini bul.

**Datasheet okuma**
> NE555P datasheet'inden mutlak maksimum değerleri ve astable çalışma için frekans formülünü çıkar.

**BOM kontrolü**
> Şu BOM'u 50 kart için Özdisan'da kontrol et, stok sorunu olanlara alternatif öner:
> STM32F103C8T6 1 adet, AMS1117-3.3 1 adet, CL10B104KB8NNNC 12 adet, RC0603FR-0710KL 8 adet

## Araç referansı

Tüm araçlar **salt okunurdur** (yalnızca `download_datasheet` diske dosya yazar). Sonuçlardaki `product` alanı
Özdisan ürün kodudur ve diğer araçlara doğrudan verilebilir. `category` alanı (ör. `mikroislemciler-218`) kategori kimliğidir.

<details>
<summary><b>search_products</b> — anahtar kelime / parça numarası araması</summary>

| Parametre | Tip | Açıklama |
|---|---|---|
| `query` | string | Parça numarası, kısmi parça numarası veya anahtar kelime |
| `category` | string? | Yalnızca bu kategoride ara |
| `in_stock` | boolean? | Yalnızca stoktakiler |
| `page_size` | 1–50 | Ayrıntılı ürün sayısı (varsayılan 10) |
| `include_specs` | boolean? | Teknik özellikleri ekle (varsayılan true) |
| `currency`, `language` | | `TRY`/`USD`/`EUR`, `tr`/`en` |

Dönen veri: eşleşmelerin kategori dağılımı, en çok eşleşen kategorideki ürünler (stok, başlangıç fiyatı, özellikler) ve diğer kategorilerden hızlı eşleşmeler.
</details>

<details>
<summary><b>get_product</b> — ürün detayı</summary>

`product` olarak Özdisan ürün kodu (`368374`), ürün URL'si veya birebir parça numarası (`STM32F103C8T6`) verilebilir.
Dönen veri: üretici, açıklama, yaşam döngüsü durumu, RoHS, kategori yolu, tüm teknik özellikler, stok, gelecek stok,
tedarik süresi, MOQ / sipariş katı / MPQ, **tam fiyat kırılım tablosu** (KDV hariç), datasheet URL'si, görsel ve ürün sayfası.
`include_alternatives: true` ile muadiller de eklenir.
</details>

<details>
<summary><b>search_categories</b> / <b>browse_categories</b> — kategoriler</summary>

- `search_categories(query, limit?)`: Kategori adında (Türkçe ve İngilizce) ve ürün içeriğinde eşleşen kategoriler.
- `browse_categories(category?, depth?)`: Kategori vermezseniz 5 ana grubu, verirseniz alt kategorileri (1–3 seviye) döndürür.
</details>

<details>
<summary><b>get_category_filters</b> — filtre şeması</summary>

| Parametre | Açıklama |
|---|---|
| `category` | Kategori (slug, numara, URL veya ad) |
| `property` | Yalnızca bu özelliğin tüm seçeneklerini göster |
| `value_query` | Seçenekler içinde ara (ör. `SOT23`) |
| `max_values` | Özellik başına listelenecek seçenek sayısı |
| `filters`, `ranges`, `manufacturers`, `query` | Mevcut filtreler: verilirse yalnızca hâlâ seçilebilir seçenekler ve kalan ürün sayısı döner |

Her özellik için `type` (`numeric`/`text`), sayısal özelliklerde kullanılabilir `units` ve `options` listelenir.
</details>

<details>
<summary><b>filter_products</b> — parametrik filtreleme</summary>

```json
{
  "category": "lineer-voltaj-regulatorleri-279",
  "filters": [{ "property": "Kılıf / Kasa", "values": ["SOT23"], "match": "contains" }],
  "ranges": [
    { "property": "Çıkış Akımı", "min": 500, "unit": "mA" },
    { "property": "Çıkış Voltajı", "min": 3.3, "max": 3.3, "unit": "V" }
  ],
  "manufacturers": ["TEXAS", "STM"],
  "in_stock": true,
  "sort": { "by": "price", "order": "asc" },
  "quantity": 100,
  "page_size": 20
}
```

- `filters`: Metin seçenekleri. Aynı özelliğin değerleri **VEYA**, farklı özellikler **VE** ile birleşir. `match: "contains"` ile metni içeren tüm seçenekler seçilir.
- `ranges`: Sayısal aralık. `unit` verilmezse temel SI birimi (V, A, Hz, F, Ω, B) kullanılır. Değer aralığı olan ürünler (ör. ayarlanabilir `1.2 to 37 V`) istenen aralıkla **kesişiyorsa** listelenir.
- Özellik adları Türkçe veya İngilizce yazılabilir (`Çıkış Akımı` = `Output Current`).
- Bayraklar: `in_stock`, `has_upcoming_stock`, `rohs`, `has_datasheet`, `discounted`.
- `sort.by`: `price`, `stock`, `manufacturer`, `moq` veya sıralanabilir bir özellik adı.
- Hatalı özellik/değer/birimde araç, doğru seçenekleri öneri olarak döndürür.
</details>

<details>
<summary><b>get_alternatives</b> — muadil ve benzer ürünler</summary>

`types`: `substitute` (birebir muadil), `similar` (benzer), `accessory` (tamamlayıcı), `parametric` (aynı kategoride aynı ana özelliklere sahip). `limit` tür başına en fazla ürün sayısıdır.
</details>

<details>
<summary><b>compare_products</b> — karşılaştırma</summary>

`products`: 2–10 ürün (kod, URL veya parça numarası), `quantity`: birim fiyatın seçileceği adet.
Özellikler satır satır hizalanır; değerleri farklı olanlar `differing_specs` içinde listelenir.
</details>

<details>
<summary><b>check_bom</b> — malzeme listesi kontrolü</summary>

```json
{
  "items": [
    { "part": "STM32F103C8T6", "quantity": 1, "reference": "U1" },
    { "part": "NE555P", "quantity": 2, "reference": "U2,U3" }
  ],
  "boards": 50,
  "currency": "TRY"
}
```

Her satır için: gerekli ve sipariş edilmesi gereken adet (MOQ/kat uygulanmış), stok, birim fiyat, satır toplamı ve
uyarılar (stok yetersiz, EOL, teklif gerekli, bulunamadı + öneriler, aynı parça numarasıyla stokta olabilecek diğer ilanlar).
En sonda KDV hariç toplam. Tek çağrıda en fazla 60 satır işlenir (satır başına ~1 sn); daha büyük BOM'ları parçalara bölün.
İstemci destekliyorsa ilerleme bildirimi gönderilir ve iptal edilen çağrılar arka planda çalışmaya devam etmez.
</details>

<details>
<summary><b>download_datasheet</b> / <b>read_datasheet</b> — datasheet</summary>

- `download_datasheet(product, directory?, overwrite?)`: PDF'i varsayılan olarak `~/Downloads/ozdisan-datasheets` klasörüne indirir ve dosya yolunu döndürür. Aynı dosya tekrar indirilmez.
- `read_datasheet(product | url, search?, pages?, max_chars?)`: PDF'ten metin çıkarır. `search` ile önce ilgili sayfalar bulunur (alaka sırasına göre), `pages` ile (`"1-3,7"`) belirli sayfalar okunur. Görseller/çizimler metne dahil değildir.
</details>

## Ayarlar (ortam değişkenleri)

İstemci yapılandırmasında `env` alanıyla verilir:

```json
{
  "mcpServers": {
    "ozdisan": {
      "command": "npx",
      "args": ["-y", "ozdisan-mcp"],
      "env": { "OZDISAN_CURRENCY": "USD", "OZDISAN_LANG": "en" }
    }
  }
}
```

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `OZDISAN_LANG` | `tr` | Kategori ve özellik adlarının dili (`tr` / `en`) |
| `OZDISAN_CURRENCY` | `TRY` | Varsayılan para birimi (`TRY` / `USD` / `EUR`) |
| `OZDISAN_DOWNLOAD_DIR` | `~/Downloads/ozdisan-datasheets` | Datasheet indirme klasörü |
| `OZDISAN_CACHE_DIR` | `~/.cache/ozdisan-mcp` | Kategori ağacı disk önbelleği |
| `OZDISAN_DISK_CACHE` | açık | `0` ile disk önbelleği kapatılır |
| `OZDISAN_TIMEOUT_MS` | `30000` | İstek zaman aşımı |
| `OZDISAN_MIN_INTERVAL_MS` | `250` | İki istek arasındaki en kısa süre |
| `OZDISAN_MAX_CONCURRENCY` | `2` | Aynı anda en fazla istek sayısı |
| `OZDISAN_MAX_DOWNLOAD_MB` | `50` | İndirilebilecek en büyük dosya |
| `OZDISAN_BASE_URL` | `https://www.ozdisan.com` | Sunucunun okuduğu site kökü (ayna/proxy/test için) |

Her araç ayrıca `currency` ve `language` parametreleriyle çağrı bazında da ayarlanabilir.

## Nasıl çalışır?

```
Yapay zekâ istemcisi  ⇄  (stdio / MCP)  ⇄  ozdisan-mcp (sizin bilgisayarınızda)  ⇄  (HTTPS)  ⇄  www.ozdisan.com
```

- Sunucu, ozdisan.com web sitesinin tarayıcıda kullandığı herkese açık uç noktalardan veri okur; giriş yapmaz,
  sepet/sipariş gibi hiçbir işlem yapmaz.
- **Siteye saygılı çalışır:** aynı anda en fazla 2 istek, istekler arasında bekleme, 429/5xx yanıtlarında geri çekilerek
  yeniden deneme ve önbellekleme (ürün listeleri 5 dk, filtre şemaları 1 saat, kategori ağacı 24 saat).
- Fiyatlar sitede misafir kullanıcıya gösterilen **KDV hariç liste fiyatlarıdır**; kurumsal (B2B) hesap fiyatlarınız farklı olabilir.
- Hiçbir veri üçüncü bir tarafa gönderilmez; telemetri yoktur.

## Geliştirme ve testler

```bash
npm install          # bağımlılıklar + derleme
npm run dev          # TypeScript kaynağından çalıştır
npm run typecheck    # tip kontrolü
npm test             # birim testleri (ağ gerektirmez)
npm run test:e2e     # uçtan uca testler (canlı ozdisan.com'a bağlanır)
npm run doctor       # canlı uç noktaları tek tek denetler (PASS/FAIL tablosu, sitenin yapısı değiştiyse burada görünür)
npm run inspect      # MCP Inspector ile araçları elle deneyin
```

**Bir şeyler bozulduğunda:** araçlar tuhaf sonuç veriyorsa önce `npm run doctor` çalıştırın. Özdisan sitesi
HTML/API yapısını değiştirdiğinde sunucu bunu **kullanıcı hatası gibi göstermez**: "ürün bulunamadı" demek yerine
`SiteContractError` döner ve mesajda `npm run doctor` + güncelleme gereksinimi yazar. `--json` ile makine tarafından
okunabilir çıktı alınır (`node scripts/doctor.mjs --json`).

**Test yapısı**

- `test/unit` — Ağsız testler: filtre çözümleme (özellik adı → kimlik, birim dönüşümü, değer eşleştirme), fiyat kırılımı ve
  MOQ hesapları, Türkçe metin eşleştirme, HTTP yeniden deneme/zaman aşımı/eşzamanlılık, PDF metin çıkarma ve
  bellek içi MCP istemcisiyle tüm araçlar (sahte ağ yanıtlarıyla).
- `test/e2e` — Derlenmiş sunucu gerçek bir MCP istemcisiyle **stdio üzerinden** başlatılır ve canlı siteye karşı
  her araç uçtan uca çalıştırılır: arama, ürün detayı (kod/URL/parça no), TRY/USD/EUR ve TR/EN, kategori gezme,
  parametrik filtre + sıralama + sayfalama, hatalı girdi önerileri, muadil, karşılaştırma, BOM, datasheet indirme ve okuma.
  Ayrıca stdout'a JSON-RPC dışında hiçbir şey yazılmadığı doğrulanır.

Canlı veri değiştiği için e2e testleri fiyat/stok değerlerini değil, yapıyı ve iş kurallarını doğrular. Birim testlerdeki
örnek veriler `npm run fixtures` ile yenilenebilir.

Katkılarınızı bekliyoruz: hata bildirimi ve önerileriniz için [issue](https://github.com/mert-ozkul/ozdisan-mcp/issues) açın veya pull request gönderin.

## Sık sorulan sorular

**Ücretli mi? API anahtarı gerekiyor mu?**
Hayır. Sunucu açık kaynaklıdır (MIT) ve herkese açık site verisini okur; anahtar veya üyelik gerekmez.

**Sipariş verebilir mi?**
Hayır, bilerek salt okunur tasarlanmıştır. Sipariş için ürün bağlantısını kullanarak ozdisan.com'dan devam edin.

**Fiyatlar KDV dahil mi?**
Hayır, KDV hariç birim liste fiyatlarıdır. `currency` ile TRY, USD veya EUR seçebilirsiniz.

**Yanıtlar neden Türkçe özellik adlarıyla geliyor?**
Varsayılan dil Türkçedir. İngilizce için `OZDISAN_LANG=en` ayarlayın veya araçlara `language: "en"` verin.
Filtrelerde özellik adlarını iki dilde de yazabilirsiniz.

**"Hiç ürün bulunamadı" diyor.**
Filtreler çok dar olabilir. `get_category_filters` aracına mevcut filtrelerinizi verirseniz hâlâ seçilebilir değerleri ve kalan ürün sayısını görürsünüz.

**Araçlar eskiden çalışıyordu, şimdi saçmalıyor.**
Özdisan site yapısını değiştirmiş olabilir. `npm run doctor` çalıştırın: yedi uç noktayı tek tek dener ve hangisinin
bozulduğunu söyler. Sunucu bu durumda "ürün bulunamadı" demez, `SiteContractError` ile açık uyarı verir.

**Kurumsal hesabımla giriş yapıp kendi fiyatlarımı görebilir miyim?**
Şu an desteklenmiyor; yalnızca misafir fiyatları gösterilir.

## Bu depo hakkında (fork)

Bu depo [`mert-ozkul/ozdisan-mcp`](https://github.com/mert-ozkul/ozdisan-mcp) projesinin bir çatalıdır; özgün kod ve
MIT lisansı korunmuştur. Çatalda yapılanlar:

- **Sessiz hata maskeleme kaldırıldı:** site HTML/API yapısı değiştiğinde araçlar artık "bulunamadı" demiyor;
  `SiteContractError` + `npm run doctor` yönlendirmesi dönüyor.
- **Uç nokta sözleşmesi denetimi:** kategori ağacı, ürün listesi, filtre ve hızlı arama yanıtları beklenen alanları
  taşımıyorsa boş sonuç yerine açık hata veriliyor.
- **`npm run doctor`:** canlı uç noktaları tek tek denetleyen teşhis komutu (`--json` destekli).
- Doküman tutarsızlıkları giderildi (`OZDISAN_BASE_URL`, npm durumu), `SECURITY.md`, `CONTRIBUTING.md`, dependabot ve
  yayın iş akışı eklendi.

## Sorumluluk reddi

Bu proje bağımsız, açık kaynaklı bir topluluk projesidir; Özdisan Elektronik A.Ş. tarafından geliştirilmemiştir ve
resmi olarak desteklenmemektedir. "Özdisan" adı ve markası sahibine aittir. Ürün, fiyat ve stok bilgileri anlık olarak
ozdisan.com'dan okunur; satın alma kararı vermeden önce ürün sayfasından doğrulayın. Lütfen aracı makul kullanım
sınırları içinde kullanın.

## Lisans

[MIT](LICENSE)

---

<sub>Anahtar kelimeler: Özdisan MCP, ozdisan mcp server, Model Context Protocol, Claude MCP, Cursor MCP, elektronik komponent arama,
elektronik malzeme, datasheet indir, devre tasarımı yapay zekâ, PCB, BOM maliyet, muadil parça bulma, stok sorgulama,
STM32, Arduino, ESP32, regülatör, MOSFET, kondansatör, direnç.</sub>
