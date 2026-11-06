# Değişiklik Günlüğü

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
