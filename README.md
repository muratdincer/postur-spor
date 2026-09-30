# Postür & Spor

Mobil odaklı, tek kullanıcılı spor/postür takip uygulaması. Vanilla HTML/CSS/JS, build yok.
Firebase Authentication (e-posta/şifre) + Cloud Firestore + Firebase Hosting.

```
public/index.html          arayüz iskeleti
public/styles.css          stiller
public/app.js              program, set takibi, timer, geçmiş, istatistik, Firebase
public/firebase-config.js  ← firebaseConfig BURAYA yapıştırılır
programs/                  kullanıcı → şablon atamaları (şablonların kendisi repoda değil, Firestore'da)
scripts/publish-programs.mjs  programs/ → Firestore (deploy workflow'u çalıştırır)
firebase.json              Hosting + Firestore rules ayarı
firestore.rules            kullanıcı yalnızca kendi verisine ve kendisine atanmış şablona erişir
```

## 1) Firebase Console'da yapılacaklar (elle)

1. https://console.firebase.google.com → proje oluştur (Spark/ücretsiz plan yeterli).
2. **Proje ayarları (dişli) → Genel → Uygulamalarınız → Web (`</>`)** → uygulama ekle (Hosting kurmak şart değil). Çıkan `firebaseConfig` değerlerini **`public/firebase-config.js`** dosyasına yapıştır.
3. **Build → Authentication → Sign-in method → E-posta/Şifre** → etkinleştir.
4. **Authentication → Users → Add user** → kendi e-posta ve şifreni oluştur (uygulamada herkese açık kayıt yok).
5. **Build → Firestore Database → Create database** (production mode, sana yakın bölge).
6. **Build → Hosting → Get started** (bir kez; site oluşur).

## 2) Cloud Shell ile deploy (bilgisayara bir şey kurmadan)

1. Firebase Console'a gir, sağ üstten (veya https://shell.cloud.google.com) **Cloud Shell**'i aç.
2. Bu klasörü Cloud Shell'e al. Ya `git clone <repo-url>` ya da Cloud Shell'in üç nokta menüsünden **Upload** ile dosyaları yükle (`public/`, `firebase.json`, `firestore.rules`).
3. Klasöre gir: `cd postur-spor`
4. Cloud Shell'de Firebase CLI hazır gelir. Gerekirse: `firebase login --no-localhost`
5. Projeyi seç: `firebase use --add` (listeden projeyi seç, alias: `default`)
6. Deploy:

```bash
firebase deploy --only hosting,firestore:rules
```

Çıktıdaki `Hosting URL` (https://PROJE.web.app) adresini iPhone'da aç.

**Firebase Studio alternatifi:** https://studio.firebase.google.com → yeni workspace → dosyaları yükle/import et → terminalde `firebase use --add` ve aynı deploy komutu.

> Uygulamayı `file://` ile açma; Auth, Firestore ve YouTube gömme Hosting üzerinden (HTTPS) test edilmelidir.

## 3) GitHub Actions ile otomatik deploy

`.github/workflows/deploy.yml`, `main`'e gelen her değişiklikte (`public/`, `firebase.json`, `firestore.rules`) Hosting'i, `firestore.rules` değiştiyse kuralları da yayınlar. Actions sekmesinden **Run workflow** ile elle de çalıştırılabilir.

Bir kerelik kurulum:
1. Firebase Console → Proje ayarları → **Hizmet hesapları** → **Yeni özel anahtar oluştur** → JSON dosyası iner.
2. GitHub → repo → Settings → Secrets and variables → Actions → **New repository secret**: ad `FIREBASE_SERVICE_ACCOUNT`, değer JSON dosyasının tamamı.
3. JSON dosyasını bilgisayardan sil; repoya asla ekleme.
4. Servis hesabının rolleri (Google Cloud Console → IAM): **Firebase Hosting Admin**, **Firebase Rules Admin** ve **Cloud Datastore User**. Rules Admin yoksa kural deploy'u, Cloud Datastore User yoksa şablon yayını 403 verir. Kurallar yalnızca `firestore.rules` değiştiğinde yayınlandığından Hosting deploy'u bundan etkilenmez.

## Veri modeli

`users/{uid}/workouts/{YYYY-MM-DD}` — her gün ayrı doküman (yerel saat dilimine göre tarih):

```
{ date, day, completedSets, updatedAt,
  exercises: { chestSupportedRow…: { exId, name, order, sets: [{completed, weight}] } } }
```

- Yazma `merge` ile yapılır; yalnızca o günün dokümanı güncellenir, geçmiş günlere dokunulmaz.
- Açılışta son 90 günün kayıtları **tek sorguda** okunur; geçmiş, istatistik ve "Son: X kg" bu önbellekten hesaplanır (gereksiz okuma yok). Toplam antrenman sayısı tek aggregate sorgusudur.
- Ağırlık yazımları 800 ms debounce'lu, ✓ değişiklikleri anında kaydedilir.
- Offline: Firestore kalıcı önbellek + her değişiklik `localStorage`'a (`postur-pending-*`) yazılır; bağlantı gelince senkronlanır. Üstte "Kaydediliyor... / Kaydedildi ✓ / Çevrimdışı" gösterilir.

## Kişiye özel program

Her kullanıcının programı Firestore'da `users/{uid}/settings/program` dokümanında durur ve uygulama programı oradan okur.

- Şablonlar: Firestore `templates/<şablon-id>` (hareket kütüphanesi `exercises` + 7 günlük `days`, güvenlik notu, ilerleme notları). Kişisel sağlık bilgisi içerdikleri için repo public olduğundan **repoda ve Hosting'de tutulmaz**; kaynak Firestore'daki dokümandır (Firebase Console → Firestore → `templates`). Gerekirse `programs/<şablon-id>.json` geçici olarak eklenip push edilince `scripts/publish-programs.mjs` onu Firestore'a yazar; sonra dosya repodan silinmelidir (git geçmişinde kalır, bu yüzden tercihen Console'dan düzenle).
- Atama: `programs/assignments.json` → `"users": { "<UID>": "<şablon-id>" }` (Firestore `config/assignments`). Şablonu yalnızca burada ona atanmış kullanıcı okuyabilir; atama yoksa kullanıcı Firestore'daki mevcut programıyla devam eder ama şablon güncellemesi almaz.
- Yeni kullanıcı ilk girişte programı yoksa "Program atanmadı" ekranında kendi **UID**'sini görür. Bu UID ile şablon atanıp deploy edilince, bir sonraki açılışta şablon kullanıcının Firestore kaydına yazılır.
- Şablonda `version` artırılıp deploy edilirse, o şablona atanmış (ya da `assignments.json`'da ataması olmayıp Firestore'daki programı aynı şablon `id`'sini taşıyan) kullanıcıların programı güncellenir.
- `existingUsersDefault`: bu özellikten önce kayıt tutmuş (programı olmayan) kullanıcıya otomatik verilen şablon.
- **SALON / EVDE:** Her günün salon programı `days[i].items`, ekipmansız ev alternatifi `days[i].home` alanındadır. Gün başlığındaki seçici ikisi arasında geçiş yapar; seçim gün sekmesinden bağımsızdır ve `localStorage`'da (`postur-mode`) tutulur. Ev hareketlerinin anahtarları `h` önekiyle ayrıdır (`hDeadBug` gibi), bu yüzden aynı gün iki programın işaretlemeleri aynı dokümanda ayrı durur ve geçişte kaybolmaz. Evde kg alanı gösterilmez. Kütüphanedeki `alt` alanı kartta "Ev/Salon alternatifi" etiketini üretir.
- Geçmiş ve istatistik programdan bağımsızdır; program değişse de eski kayıtlar görünür.
- Kullanıcı UID'si ayrıca Firebase Console → Authentication → Users listesinde görünür.

## Eski localStorage migration

İlk girişte `postur-check-*` / `postur-v3-*` kayıtları (v4 dosyasındaki format) bulunursa, **bugünün gününe** ait olanlar bugünün Firestore kaydına gerçek set/kg olarak taşınır (bugünde zaten veri varsa ezilmez); tüm ham anahtarlar ayrıca `legacyLocal` alanında saklanır. Sonra `postur-firebase-migrated = true` konur ve tekrar çalışmaz. Not: eski uygulama tarih tutmadığı için diğer günlerin kayıtları yalnızca ham olarak saklanır. Migration, eski dosyanın açıldığı **aynı tarayıcı/adreste** (aynı origin) çalışır; `file://` ile Hosting adresinin localStorage'ı ayrıdır.
