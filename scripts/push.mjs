// Web Push gönderimi (GitHub Actions: .github/workflows/push.yml).
// - Anahtar çifti (VAPID) ilk çalıştırmada üretilir: açık anahtar config/push (istemci okur),
//   gizli anahtar secrets/push (kural yok; yalnızca bu servis hesabı okur). Repo public olduğundan anahtar repoda durmaz.
// - Abonelikler users/{uid}/pushSubs/{id}. Süresi dolan (404/410) abonelik silinir.
// - Loglar public: uç nokta, UID ya da anahtar yazdırılmaz; yalnızca sayılar.
// Ortam: TARGET = latest (son kaydolan cihaz) | all, TITLE, BODY, URL.
// Kimlik: GOOGLE_APPLICATION_CREDENTIALS (deploy workflow'undaki servis hesabı).
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import webpush from "web-push";

initializeApp({ credential: applicationDefault(), projectId: "postur-spor" });
const db = getFirestore();

async function vapidKeys() {
  const secretRef = db.doc("secrets/push");
  const snap = await secretRef.get();
  if (snap.exists) return snap.data();
  const keys = webpush.generateVAPIDKeys();
  await secretRef.set({ ...keys, createdAt: FieldValue.serverTimestamp() });
  await db.doc("config/push").set({ publicKey: keys.publicKey });
  console.log("Yeni bildirim anahtarları üretildi.");
  return keys;
}

const keys = await vapidKeys();
// Açık anahtar kopyası silinmiş ya da eskiyse yenilenir.
const pub = await db.doc("config/push").get();
if (pub.data()?.publicKey !== keys.publicKey) await db.doc("config/push").set({ publicKey: keys.publicKey });
webpush.setVapidDetails("https://postur-spor.web.app", keys.publicKey, keys.privateKey);

const subs = (await db.collectionGroup("pushSubs").get()).docs;
console.log(`Kayıtlı cihaz: ${subs.length}`);
if (!subs.length) process.exit(0);

const target = process.env.TARGET === "all" ? subs
  : [subs.reduce((a, b) => ((b.get("createdAt")?.toMillis() || 0) > (a.get("createdAt")?.toMillis() || 0) ? b : a))];

const payload = JSON.stringify({
  title: process.env.TITLE || "Postür & Spor",
  body: process.env.BODY || "Deneme bildirimi: bildirimler çalışıyor.",
  url: process.env.URL || "/",
  tag: "test"
});

let ok = 0, removed = 0, failed = 0;
for (const d of target) {
  try {
    await webpush.sendNotification({ endpoint: d.get("endpoint"), keys: d.get("keys") }, payload, { TTL: 3600, urgency: "normal" });
    ok++;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) { await d.ref.delete(); removed++; }
    else { failed++; console.error(`Gönderilemedi: HTTP ${err.statusCode || "?"} ${String(err.body || err.message).slice(0, 200)}`); }
  }
}
console.log(`Gönderildi: ${ok}, süresi dolup silinen: ${removed}, hata: ${failed}`);
if (failed) process.exit(1);
