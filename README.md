# Postür & Spor

Kişisel spor ve postür takip uygulaması. Telefonda kullanılmak üzere tasarlandı.

## Neler yapabilirsin

- **Haftalık program:** Gün sekmelerinden o günün hareketlerini gör. Uygulama her açılışta bugünü gösterir.
- **Salon / Evde:** Salona gidemediğin günlerde ekipmansız ev alternatifine geç.
- **Set takibi:** Her seti ✓ ile işaretle, ağırlığını gir. Bir hareket bitince sonraki harekete geçilir.
- **Kaldığın yer:** Uygulamayı yeniden açtığında en son kaldığın harekete kayar.
- **Tamamlanan gün:** Tüm hareketler bitince gün yeşil ✓ ile işaretlenir.
- **Videolar:** Her hareketin Türkçe anlatımlı videosunu kart üzerinden izle.
- **Dinlenme sayacı:** Set bitince otomatik başlayabilen dinlenme zamanlayıcısı.
- **Set sayacı:** Her setin yanındaki ▶ tam ekran sayacı açar; 3 sn hazırlıktan sonra sayar, duraklatılabilir, bitince bip sesiyle seti kendisi işaretler. Plank gibi süreli setlerde gerçek süre, tekrarlı setlerde tahmini süre (tekrar × ~4 sn, tekrar başı bekleme varsa eklenir; düğmede `~` ile gösterilir) kullanılır. Tahmini sette "+15 sn" ile uzatabilir, "Seti bitir" ile erken bitirebilirsin. "/ taraf" yazan hareketlerde iki taraf arka arkaya sayılır, arada 5 sn "Taraf değiştir" uyarısı verilir.
- **Antrenman müziği:** Set sayacı çalışırken harekete uygun müzik çalar, set bitince durur. Hareketler dört listeye atanır (her birinde 6 parça, en az 4 farklı sanatçı): kuvvet (salonda ağırlıklı), kardiyo (5 dk ve üzeri), tempo (vücut ağırlığı, core) ve esneme (esneme, mobilite). Sayaçtaki ⏮ ⏭ ya da kilit ekranı/kulaklık düğmeleriyle liste içinde önceki/sonraki parçaya geçilir. Sayaçtaki "Müziği kapat" ya da Ayarlar > Müzik ile kapatılabilir.
- **Geçmiş ve istatistik:** Önceki antrenmanlarını ve toplamlarını gör.
- **Ayarlar:** Sağ üstteki dişliden görünüm (Sistem / Açık / Koyu), otomatik dinlenme, müzik, verilerini dışa aktarma (CSV / JSON) ve çıkış.
- **Yapay zekâ ile program:** Ayarlar > Program > "Yapay zekâ ile içe aktar". Uygulamanın hazırladığı talimatı kendi yapay zekâ hesabına (ChatGPT, Claude, Gemini…) yapıştır, soruları orada cevapla, son cevabı geri yapıştır; uygulama kontrol edip önizler, onaylarsan yükler. Önceki programa ya da hazır programa Ayarlar'dan dönebilirsin.
- **Bildirimler:** Ana ekrana eklenmiş uygulamada Ayarlar > Bildirimler > "Bildirimleri aç". Uygulama kapalıyken de gelir. Antrenman hatırlatması (antrenman günlerinde, varsayılan 08:00; o gün başladıysan gelmez), akşam hatırlatması (hiç set işaretlemediysen, 20:00) ve Pazar haftalık özeti (20:30) ayrı ayrı açılıp saatleri değiştirilebilir. Gönderimi GitHub Actions 15 dakikada bir yapar; birkaç dakika gecikebilir.
- **Koyu tema ve yazı boyutu:** Varsayılan olarak telefonun ayarlarını izler.
- **Geri al:** Silinen bir seti 5 saniye içinde geri alabilirsin.
- **Çevrimdışı:** İnternet yokken de uygulamayı açıp işaretlemeye devam et; bağlantı gelince kayıtlar eşitlenir. Bağlantı varken her açılışta en son sürüm gelir.

## Kullanım

1. Uygulama adresini telefonunda aç ve hesabınla giriş yap.
2. iPhone'da Safari → Paylaş → **Ana Ekrana Ekle** ile uygulama gibi kullanabilirsin.
3. Yeni hesaplar yalnızca yönetici tarafından açılır.

## Gizlilik

- Antrenman kayıtların ve kişisel programın yalnızca senin hesabınla okunabilir.
- Kişisel program ve sağlık notları bu depoda tutulmaz.

## Müzik lisansı

`public/music/` altındaki parçalar aşağıdaki sanatçılara aittir; her biri belirtilen Creative Commons lisansıyla kullanılır. Dosyalar ses düzeyi eşitlenip (−16 LUFS) 80 kbps AAC'ye dönüştürülmüştür; içerik değiştirilmemiştir.

| Sanatçı | Lisans | Kaynak |
|---|---|---|
| Kevin MacLeod | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | incompetech.com |
| Jason Shaw (Audionautix) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | audionautix.com |
| Scott Buckley | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | scottbuckley.com.au |
| Komiku | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | freemusicarchive.org/music/Komiku |
| Loyalty Freak Music | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | freemusicarchive.org/music/Loyalty_Freak_Music |

| Liste | Parçalar |
|---|---|
| Kuvvet | Volatile Reaction (Kevin MacLeod), Hard Bounce (Jason Shaw), Road 1 Fight (Komiku), Ultra Metal (Loyalty Freak Music), Cut and Run (Kevin MacLeod), Sweat Time! (Loyalty Freak Music) |
| Kardiyo | Funkorama (Kevin MacLeod), Get A Move On (Jason Shaw), Roller Fever (Loyalty Freak Music), Everything is groovy (Komiku), Origami (Scott Buckley), United We Groove (Jason Shaw) |
| Tempo | Movement Proposition (Kevin MacLeod), Transportation (Jason Shaw), One Cool Minute (Loyalty Freak Music), Facing it (Komiku), Inspired (Kevin MacLeod), Threshold (Jason Shaw) |
| Esneme | Meditation Impromptu 01 (Kevin MacLeod), In This Moment (Scott Buckley), Namaste (Jason Shaw), The Wind (Komiku), Home Was You (Scott Buckley), Once more with you (Loyalty Freak Music) |

Örnek atıflar: "Volatile Reaction" Kevin MacLeod (incompetech.com), Licensed under Creative Commons: By Attribution 4.0 License · "Hard Bounce" Jason Shaw, audionautix.com, CC BY 4.0 · "Origami" Music by Scott Buckley, released under CC-BY 4.0, www.scottbuckley.com.au
