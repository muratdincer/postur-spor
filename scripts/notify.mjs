// Zamanlanmış bildirimler (Actions: "Zamanlanmış bildirimler", notify.yml; 15 dakikada bir çalışır).
// Türler ve varsayılanlar (kullanıcı Ayarlar > Bildirimler'den değiştirir, users/{uid}/settings/notifications):
//   reminder: antrenman günlerinde hatırlatma (08:00). O gün set işaretlendiyse gönderilmez.
//   evening:  antrenman gününde hiç set işaretlenmediyse akşam hatırlatması (20:00).
//   weekly:   Pazar haftalık özet (20:30).
// Zamanı gelen ve bugün gönderilmemiş bildirim gönderilir; GitHub'ın zamanlayıcısı gecikebildiği için
// zamanından sonraki 3 saat içinde yakalanır, daha geç kalan atlanır. Gönderilenler users/{uid}/settings/notifyState.
// FORCE = reminder | evening | weekly: saat ve "bugün gönderildi" kontrolü olmadan hemen gönderir (deneme).
import { db, setupPush, allSubscriptions, sendTo } from "./push-lib.mjs";

const DEFAULTS = {
  reminder: { on: true, time: "08:00" },
  evening: { on: true, time: "20:00" },
  weekly: { on: true, time: "20:30" }
};
const WINDOW_MIN = 180;
const DAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const FORCE = ["reminder", "evening", "weekly"].includes(process.env.FORCE) ? process.env.FORCE : null;

// Kullanıcının saat dilimindeki tarih (YYYY-AA-GG), gün sırası (Pzt=0) ve dakika.
function localNow(tz) {
  let p;
  try { p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date()); }
  catch { return localNow("Europe/Istanbul"); }
  const g = (t) => p.find((x) => x.type === t).value;
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday"));
  return { date: `${g("year")}-${g("month")}-${g("day")}`, day: wd, min: Number(g("hour")) * 60 + Number(g("minute")) };
}
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const completedSets = (w) => (w ? (w.completedSets ?? Object.values(w.exercises || {}).reduce((n, e) => n + (e.sets || []).filter((s) => s.completed).length, 0)) : 0);
const isTrainingDay = (d) => d && !d.rest && d.items?.length > 0;

async function weekStats(uid, monday) {
  const snap = await db.collection(`users/${uid}/workouts`).where("date", ">=", monday).where("date", "<=", addDays(monday, 6)).get();
  let days = 0, sets = 0;
  for (const d of snap.docs) { const n = completedSets(d.data()); if (n > 0) { days++; sets += n; } }
  return { days, sets };
}

async function message(type, uid, program, now) {
  const day = program?.days?.[now.day];
  if (type === "weekly") {
    if (!FORCE && now.day !== 6) return null;
    const monday = addDays(now.date, -now.day);
    const [cur, prev] = await Promise.all([weekStats(uid, monday), weekStats(uid, addDays(monday, -7))]);
    const planned = (program?.days || []).filter(isTrainingDay).length;
    const of = planned ? `/${planned}` : "";
    const cmp = prev.days || prev.sets ? ` Geçen hafta: ${prev.days}${of} antrenman.` : "";
    return {
      title: "Haftalık özet",
      body: cur.days ? `Bu hafta ${cur.days}${of} antrenman, ${cur.sets} set.${cmp}` : `Bu hafta antrenman kaydı yok.${cmp} Yeni hafta yeni başlangıç.`,
      url: "/#istatistik", tag: "weekly"
    };
  }
  if (!isTrainingDay(day)) return null;
  const today = (await db.doc(`users/${uid}/workouts/${now.date}`).get()).data();
  const done = completedSets(today) > 0;
  if (!FORCE && done) return null; // bugün başlamış; hatırlatmaya gerek yok
  const home = day.home && isTrainingDay(day.home) ? ` Salona gidemezsen ${day.home.items.length} hareketlik ev programı var.` : "";
  if (type === "reminder") {
    return { title: `Bugün: ${day.title || "Antrenman"}`, body: `${DAYS[now.day]} programında ${day.items.length} hareket var.${home}`, url: "/", tag: "reminder" };
  }
  return { title: "Bugün henüz antrenman yapmadın", body: `${day.title || "Antrenman"} seni bekliyor.${home}`, url: "/", tag: "evening" };
}

await setupPush();
const subs = await allSubscriptions();
const byUser = new Map();
for (const s of subs) byUser.set(s.uid, [...(byUser.get(s.uid) || []), s]);
console.log(`Kayıtlı cihaz: ${subs.length}, kullanıcı: ${byUser.size}${FORCE ? `, deneme: ${FORCE}` : ""}`);

let sent = 0, failed = 0;
for (const [uid, userSubs] of byUser) {
  const [prefsSnap, stateSnap, programSnap] = await Promise.all([
    db.doc(`users/${uid}/settings/notifications`).get(),
    db.doc(`users/${uid}/settings/notifyState`).get(),
    db.doc(`users/${uid}/settings/program`).get()
  ]);
  const prefs = prefsSnap.data() || {};
  const sentState = stateSnap.data() || {};
  const now = localNow(prefs.tz || "Europe/Istanbul");
  for (const type of FORCE ? [FORCE] : Object.keys(DEFAULTS)) {
    const p = { ...DEFAULTS[type], ...(prefs[type] || {}) };
    if (!FORCE) {
      const at = toMin(p.time) ?? toMin(DEFAULTS[type].time);
      if (!p.on || sentState[type] === now.date || now.min < at || now.min > at + WINDOW_MIN) continue;
    }
    const msg = await message(type, uid, programSnap.data(), now);
    // Gönderilecek bir şey yoksa da (dinlenme günü, set yapılmış) bugün için işaretlenir; tekrar bakılmaz.
    if (!FORCE) await db.doc(`users/${uid}/settings/notifyState`).set({ [type]: now.date }, { merge: true });
    if (!msg) { console.log(`${type}: gerek yok`); continue; }
    const r = await sendTo(userSubs, msg);
    sent += r.ok; failed += r.failed;
    console.log(`${type}: gönderildi ${r.ok}, silinen ${r.removed}, hata ${r.failed}`);
  }
}
if (failed) process.exit(1);
