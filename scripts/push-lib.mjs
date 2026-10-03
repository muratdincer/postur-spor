// Web Push ortak kodu: Firestore bağlantısı, VAPID anahtarları, abonelik okuma ve gönderim.
// - Anahtar çifti ilk çalıştırmada üretilir: açık anahtar config/push (istemci okur), gizli anahtar secrets/push
//   (istemci kuralı yok; yalnızca servis hesabı okur). Repo public olduğundan anahtar repoda durmaz.
// - Abonelikler users/{uid}/pushSubs/{id}. Süresi dolan (404/410) abonelik silinir.
// - Loglar public: uç nokta, UID ya da anahtar yazdırılmaz.
// Kimlik: GOOGLE_APPLICATION_CREDENTIALS (servis hesabı, "Cloud Datastore User" rolü).
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import webpush from "web-push";

initializeApp({ credential: applicationDefault(), projectId: "postur-spor" });
export const db = getFirestore();
export { FieldValue };

export async function setupPush() {
  const secretRef = db.doc("secrets/push");
  let keys = (await secretRef.get()).data();
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await secretRef.set({ ...keys, createdAt: FieldValue.serverTimestamp() });
    console.log("Yeni bildirim anahtarları üretildi.");
  }
  // Açık anahtar kopyası yoksa ya da eskiyse yenilenir.
  const pub = await db.doc("config/push").get();
  if (pub.data()?.publicKey !== keys.publicKey) await db.doc("config/push").set({ publicKey: keys.publicKey });
  webpush.setVapidDetails("https://postur-spor.web.app", keys.publicKey, keys.privateKey);
}

// Bütün abonelikler; uid her aboneliğin bağlı olduğu kullanıcı.
export async function allSubscriptions() {
  const snap = await db.collectionGroup("pushSubs").get();
  return snap.docs.map((d) => ({ doc: d, uid: d.ref.parent.parent.id }));
}

// { ok, removed, failed } döner. payload: { title, body, url, tag }
export async function sendTo(subs, payload) {
  const body = JSON.stringify(payload);
  const res = { ok: 0, removed: 0, failed: 0 };
  for (const { doc: d } of subs) {
    try {
      await webpush.sendNotification({ endpoint: d.get("endpoint"), keys: d.get("keys") }, body, { TTL: 3600, urgency: "normal" });
      res.ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { await d.ref.delete(); res.removed++; }
      else { res.failed++; console.error(`Gönderilemedi: HTTP ${err.statusCode || "?"} ${String(err.body || err.message).slice(0, 200)}`); }
    }
  }
  return res;
}
