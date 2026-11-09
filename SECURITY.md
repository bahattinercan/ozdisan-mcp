# Güvenlik Politikası

## Desteklenen sürümler

| Sürüm | Destek |
|---|---|
| 0.1.x | ✅ güvenlik düzeltmeleri alır |

## Güvenlik açığı bildirimi

Lütfen **herkese açık issue açmayın**. GitHub'ın özel bildirim kanalını kullanın:

<https://github.com/bahattinercan/ozdisan-mcp/security/advisories/new>

Bildirimde şunlar olsun: etkilenen sürüm, yeniden üretme adımları, beklenen ve gerçek davranış, varsa önerdiğiniz düzeltme.
İlk yanıt hedefi 72 saattir. Düzeltme yayınlanana kadar ayrıntıyı kamuya açıklamayın.

## Kapsam

Bu sunucu yerel makinenizde çalışır, sizin kullanıcı yetkilerinizle çalışır ve dosya sistemine yazabilir
(`download_datasheet`). Özellikle şu sınıflar kapsam içindedir:

- **SSRF / yerel ağ erişimi:** `read_datasheet`/`download_datasheet` için verilen adreslerin `localhost`, özel ağ,
  bulut metadata (`169.254.169.254`) veya DNS rebinding ile iç adrese yönlenmesi (`src/netguard.ts`).
- **Yol aşımı:** indirilen dosya adının indirme klasörü dışına yazılması (`sanitizeFileName`, `src/api.ts`).
- **Kaynak tüketimi:** boyut sınırı, zaman aşımı ve eşzamanlılık sınırlarının aşılmasıyla hizmet dışı bırakma.
- **İstem enjeksiyonu:** ürün/datasheet içeriğinin modeli araç çağrısı yapmaya yönlendirmesi. Sunucu salt okunurdur,
  ama modele dönen metin güvenilmez kabul edilmelidir.
- **Protokol bozulması:** stdout'a JSON-RPC dışı yazılması.

Kapsam dışı: Özdisan sitesinin kendi güvenlik sorunları (doğrudan ilgili tarafa bildirin), üçüncü taraf datasheet
sunucularının davranışı, kullanıcının kendi yapılandırmasından kaynaklanan yetki sorunları.

## Tasarım gereği sınırlar

- Sunucu **salt okunurdur**: sipariş vermez, giriş yapmaz, çerez/oturum saklamaz, telemetri göndermez.
- Kimlik bilgisi istemez ve saklamaz; `env` üzerinden yalnızca yapılandırma okur.
- Fiyat/stok verisi anlık okunur; satın alma kararı için ürün sayfasından doğrulanmalıdır.
