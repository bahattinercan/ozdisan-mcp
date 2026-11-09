# Değişiklik Günlüğü

## 0.1.1

Site değiştiğinde hatalı sonuç vermeyi önleyen düzeltmeler (fork).

- **Hata maskeleme kaldırıldı.** Ürün sayfasında `__NEXT_DATA__` yoksa veya JSON'u bozuksa sunucu artık
  "ürün bulunamadı" demiyor; `SiteContractError` fırlatıyor. Gerçek "ürün yok" durumu (site 200 + `pageProps.error`)
  hâlâ `UserInputError` olarak dönüyor.
- **Uç nokta sözleşmesi denetimi eklendi.** Kategori ağacı, kategori arama, ürün listesi (`variantList`), filtre
  (`propertyFilters`) ve hızlı arama yanıtları beklenen alanları taşımıyorsa boş sonuç yerine açık hata veriliyor.
- **`npm run doctor`.** Yedi canlı uç noktayı tek tek denetleyen teşhis komutu (`node scripts/doctor.mjs --json`
  makine tarafından okunabilir çıktı verir); bozuk uç noktada 1 ile çıkar.
- **MCP istemcisine doğru ipucu.** `SiteContractError` sonucunda "ağ/bağlantı" değil, "site yapısı değişmiş olabilir,
  `npm run doctor` + güncelleme" ipucu dönüyor ve modelin bunu "bulunamadı" diye özetlemesi engelleniyor.
- Doküman: `OZDISAN_BASE_URL` belgelendi, npm yayın durumu düzeltildi, teşhis bölümü ve fork notu eklendi.
- Depo: `SECURITY.md`, `CONTRIBUTING.md`, dependabot, yayın iş akışı ve issue/PR şablonları.
- Testler: 10 yeni birim testi (sözleşme bozulması senaryoları) + 1 ipucu testi (116 test).

## 0.1.0

İlk sürüm.

- 11 araç: `search_products`, `get_product`, `search_categories`, `browse_categories`, `get_category_filters`,
  `filter_products`, `get_alternatives`, `compare_products`, `check_bom`, `download_datasheet`, `read_datasheet`
- 2 istem: `komponent_sec`, `bom_kontrol`
- Parametrik filtrelerde Türkçe/İngilizce özellik adları, birimli sayısal aralıklar ve hatalı girdilerde öneriler
- TRY/USD/EUR fiyatlar, TR/EN dil desteği
- Hız sınırlama, yeniden deneme, bellek ve disk önbelleği
- Güvenlik: datasheet okumada yerel/özel ağ adreslerine (DNS ve yönlendirmeler dahil) erişim engeli, akışla boyut sınırı,
  PDF imza doğrulaması, eşzamanlı indirmelerde dosya bütünlüğü
- Değer ve birim eşleştirmede ondalık nokta, işaret ve m/M (mili/mega) ön ekleri asla yok sayılmaz
- İstemci iptaline uyum ve uzun işlemlerde (BOM, karşılaştırma) ilerleme bildirimi
- Birim ve uçtan uca (canlı site, stdio) testler
