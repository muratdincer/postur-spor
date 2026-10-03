// Elle bildirim gönderimi (Actions: "Bildirim gönder", push.yml). Ortak kod push-lib.mjs.
// Ortam: TARGET = latest (son kaydolan cihaz) | all, TITLE, BODY, URL.
import { setupPush, allSubscriptions, sendTo } from "./push-lib.mjs";

await setupPush();
const subs = await allSubscriptions();
console.log(`Kayıtlı cihaz: ${subs.length}`);
if (!subs.length) process.exit(0);

const created = (s) => s.doc.get("createdAt")?.toMillis() || 0;
const target = process.env.TARGET === "all" ? subs : [subs.reduce((a, b) => (created(b) > created(a) ? b : a))];

const r = await sendTo(target, {
  title: process.env.TITLE || "Postür & Spor",
  body: process.env.BODY || "Deneme bildirimi: bildirimler çalışıyor.",
  url: process.env.URL || "/",
  tag: "test"
});
console.log(`Gönderildi: ${r.ok}, süresi dolup silinen: ${r.removed}, hata: ${r.failed}`);
if (r.failed) process.exit(1);
