import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, setDoc, getDoc, getDocs, collection, query, where, orderBy, limit,
  getCountFromServer, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ============================================================
   SABİTLER: gün adları, hareket kütüphanesi, haftalık program
   ============================================================ */

const DAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

// Program kullanıcıya özeldir ve Firestore'da users/{uid}/settings/program dokümanında durur.
// Şablonlar Firestore templates/{id} (kişisel sağlık bilgisi içerir, repoda tutulmaz), kullanıcı → şablon eşlemesi
// config/assignments (yalnızca Firestore'da; UID'ler repoda tutulmaz). Yalnızca atanmış kullanıcı şablonu okur.
// EX: hareket kütüphanesi (weight: true → kg alanı, video: YouTube ID, alt: salon↔ev karşılığı),
// PLAN: Pazartesi..Pazar 7 gün; her günün salon programı kendisi, ev alternatifi `home` alanıdır.
let PROGRAM = null;
let EX = {};
let PLAN = [];

// Hareket videoları: hareket kimliği → { id, title, channel, language, start }. Kodda tutulmaz; kullanıcının
// Firestore alanında (users/{uid}/settings/videos, alan: items) durur, uygulama içinden "#videolar" ile aktarılır.
// Burada karşılığı olmayan hareketlerde şablondaki `video` alanı yedek olarak kullanılır.
let exerciseVideos = {};

// Merkezi mapping önce, şablondaki `video` yedek. { id, start, title } döner; video yoksa null.
function videoFor(exId) {
  const v = exerciseVideos[exId];
  if (v?.id) return { id: v.id, start: v.start || 0, title: v.language === "tr" ? v.title : null, language: v.language };
  return EX[exId]?.video ? { id: EX[exId].video, start: 0, title: null } : null;
}

/* ============================================================
   YARDIMCILAR
   ============================================================ */

const $ = (id) => document.getElementById(id);

// Güvenli DOM üretimi (innerHTML kullanılmaz; kullanıcı verisi textContent olarak girer).
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const pad = (n) => String(n).padStart(2, "0");
// Yerel saat dilimine göre YYYY-MM-DD (UTC kayması yok).
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayIndex = (d) => (d.getDay() + 6) % 7; // Pzt=0 … Paz=6
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const longDate = (s) => { const d = parseYmd(s); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const isDateKey = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function relLabel(diff) {
  if (diff === 0) return "BUGÜN";
  if (diff === -1) return "DÜN";
  if (diff === 1) return "YARIN";
  return diff < 0 ? `${-diff} GÜN ÖNCE` : `${diff} GÜN SONRA`;
}

// Ağırlık alanı denetimi: boş geçerlidir (ağırlık yok); hata metni ya da null döner.
function weightError(str) {
  const t = String(str).trim();
  if (!t) return null;
  if (!/^\d+([.,]\d+)?$/.test(t)) return "Ağırlığı sayı olarak yaz (ör. 12,5).";
  if (parseFloat(t.replace(",", ".")) > 1000) return "En fazla 1000 kg girilebilir.";
  return null;
}

function parseWeight(str) {
  const n = parseFloat(String(str).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 1000);
}
const fmtKg = (w) => `${String(w).replace(".", ",")} kg`;

const ytWatch = (id, start = 0) => `https://www.youtube.com/watch?v=${id}${start > 0 ? `&t=${start}s` : ""}`;
const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const ytSearch = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

// CSS token'ının o anki değeri (açık/koyu temaya göre).
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function placeholderImg(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${cssVar("--thumb-bg")}"/>` +
    `<g fill="none" stroke="${cssVar("--accent")}" stroke-width="6" stroke-linecap="round"><path d="M110 90h100M96 70v40M224 70v40M82 80v20M238 80v20"/></g>` +
    `<text x="160" y="146" text-anchor="middle" font-family="sans-serif" font-size="15" fill="${cssVar("--muted")}">${label.replace(/[<>&"]/g, "")}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* özel mod vb. */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* yoksay */ } };

/* ============================================================
   DURUM
   ============================================================ */

const configured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
let auth = null;
let db = null;

const state = {
  uid: null,
  docs: {},               // "YYYY-MM-DD" -> { date, day, exercises: { key: { exId, name, order, sets:[{completed,weight}], touched } } }
  historyLoaded: false,
  loading: true,
  selectedIdx: dayIndex(new Date()),
  loadedToday: ymd(new Date()),
  view: "program",
  totalWorkouts: null,
  totalDirty: true,
  historyShown: 30,
  statsRange: [7, 30, 90].includes(Number(lsGet("postur-stats-range"))) ? Number(lsGet("postur-stats-range")) : 30,
  openHistory: new Set(),
  programState: "loading", // loading | ready | missing
  initialScroll: false,     // açılışta bugünün kaldığı harekete bir kez kaydır
  mode: lsGet("postur-mode") === "home" ? "home" : "gym" // SALON / EVDE, gün seçiminden bağımsız
};

const debounceTimers = {};
const versions = {};
let inflight = 0;
let lastError = false;

/* ============================================================
   DURUM GÖSTERGESİ
   ============================================================ */

function setStatus(s) {
  const el = $("saveStatus");
  el.dataset.state = s;
  el.textContent = { saving: "Kaydediliyor…", saved: "Kaydedildi ✓", offline: "Çevrimdışı", error: "Kaydedilemedi", idle: "" }[s] || "";
}

// Bağlantı yokluğu ile sunucu hatası ayrı gösterilir; ikisinde de veri cihazda bekler.
function refreshConnectionUi() {
  const offline = !navigator.onLine;
  const failed = !offline && lastError;
  $("offlineBanner").hidden = !offline && !failed;
  $("retryBtn").hidden = !failed;
  $("offlineText").textContent = offline
    ? "Bağlantı yok. Değişikliklerin cihazda tutuluyor, bağlantı gelince kaydedilecek."
    : failed ? "Sunucuya kaydedilemedi. Değişikliklerin cihazda tutuluyor, birazdan yeniden denenecek." : "";
  if (offline) setStatus("offline");
  else if (failed) setStatus("error");
  else if (inflight > 0) setStatus("saving");
}

/* ---------- Yeniden deneme: hata sonrası artan aralıkla (5 sn, 10 sn … en fazla 5 dk) ---------- */

let retryTimer = null;
let retryDelay = 5000;

function scheduleRetry() {
  if (retryTimer || !navigator.onLine) return; // çevrimdışıyken "online" olayı tetikler
  retryTimer = setTimeout(retryNow, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 300000);
}

function retryNow() {
  clearTimeout(retryTimer);
  retryTimer = null;
  lastError = false;
  refreshConnectionUi();
  if (!state.uid) return;
  pendingDates().forEach((date) => saveNow(date));
  if (!state.historyLoaded) loadHistory().then(renderCurrent);
  if (state.programState !== "ready") loadProgram().then(renderCurrent);
}

function retrySucceeded() {
  clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 5000;
}

/* ============================================================
   VERİ KATMANI
   ============================================================ */

const workoutRef = (date) => doc(db, "users", state.uid, "workouts", date);
const pendingKey = (date) => `postur-pending-${state.uid}-${date}`;

function normalizeDoc(data, date) {
  const exercises = {};
  for (const [key, e] of Object.entries(data.exercises || {})) {
    exercises[key] = {
      exId: e.exId || key,
      name: e.name || key,
      order: e.order ?? 0,
      sets: (e.sets || []).map((s) => ({ completed: !!s.completed, weight: s.weight ?? null })),
      touched: true
    };
  }
  return { date, day: data.day || DAYS[dayIndex(parseYmd(date))], exercises };
}

function countSets(d) {
  let n = 0;
  for (const e of Object.values(d.exercises)) for (const s of e.sets) if (s.completed) n++;
  return n;
}

function buildPayload(d) {
  const exercises = {};
  for (const [key, e] of Object.entries(d.exercises)) {
    if (!e.touched) continue;
    exercises[key] = {
      exId: e.exId, name: e.name, order: e.order,
      sets: e.sets.map((s) => ({ completed: !!s.completed, weight: s.weight ?? null }))
    };
  }
  return { date: d.date, day: d.day, completedSets: countSets(d), exercises };
}

function getDay(date) {
  if (!state.docs[date]) {
    state.docs[date] = { date, day: DAYS[dayIndex(parseYmd(date))], exercises: {} };
  }
  return state.docs[date];
}

function ensureEntry(date, item, order) {
  const d = getDay(date);
  let e = d.exercises[item.key];
  if (!e) {
    e = d.exercises[item.key] = {
      exId: item.ex, name: item.name || EX[item.ex]?.name || item.ex, order,
      sets: Array.from({ length: item.sets }, () => ({ completed: false, weight: null })),
      touched: false
    };
  }
  return e;
}

function scheduleSave(date) {
  clearTimeout(debounceTimers[date]);
  if (navigator.onLine) setStatus("saving");
  debounceTimers[date] = setTimeout(() => saveNow(date), 800);
}

async function saveNow(date) {
  clearTimeout(debounceTimers[date]);
  const d = state.docs[date];
  if (!d || !db || !state.uid) return;
  const payload = buildPayload(d);
  const ver = (versions[date] = (versions[date] || 0) + 1);
  const key = pendingKey(date);
  lsSet(key, JSON.stringify(payload)); // bağlantı olmasa da cihazda dursun
  state.totalDirty = true;
  inflight++;
  refreshConnectionUi();
  try {
    await setDoc(workoutRef(date), { ...payload, updatedAt: serverTimestamp() }, { merge: true });
    if (versions[date] === ver) lsDel(key);
    lastError = false;
    retrySucceeded();
  } catch (err) {
    console.error("Kayıt hatası:", err);
    lastError = true;
    scheduleRetry();
  } finally {
    inflight--;
    if (inflight === 0) {
      if (lastError || !navigator.onLine) refreshConnectionUi();
      else { refreshConnectionUi(); setStatus("saved"); }
    }
  }
}

function pendingDates() {
  const out = [];
  const prefix = `postur-pending-${state.uid}-`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        const date = k.slice(prefix.length);
        if (isDateKey(date)) out.push(date);
      }
    }
  } catch { /* yoksay */ }
  return out;
}

// Cihazda bekleyen (henüz Firestore'a ulaşmamış) kayıtları belleğe alıp yeniden gönderir.
function restorePending() {
  for (const date of pendingDates()) {
    let p;
    try { p = JSON.parse(lsGet(pendingKey(date))); } catch { continue; }
    if (!p || !p.exercises) continue;
    const local = normalizeDoc(p, date);
    const d = getDay(date);
    Object.assign(d.exercises, local.exercises);
    saveNow(date);
  }
}

async function loadHistory() {
  const from = ymd(addDays(new Date(), -90));
  try {
    const q = query(
      collection(db, "users", state.uid, "workouts"),
      where("date", ">=", from), orderBy("date", "desc"), limit(120)
    );
    const snap = await getDocs(q);
    const pending = new Set(pendingDates());
    for (const s of snap.docs) {
      const date = s.id;
      if (!isDateKey(date) || pending.has(date)) continue; // bekleyen yerel veri öncelikli
      state.docs[date] = normalizeDoc(s.data(), date);
    }
    state.historyLoaded = true;
    lastError = false;
  } catch (err) {
    console.error("Geçmiş yüklenemedi:", err);
    lastError = true;
    scheduleRetry();
  }
  state.loading = false;
  refreshConnectionUi();
}

// Geçmiş sorgusu başarısızsa yalnızca seçili günü tek doküman olarak dene.
async function loadSingleDay(date) {
  if (state.historyLoaded || state.docs[date]) return;
  try {
    const s = await getDoc(workoutRef(date));
    if (s.exists() && !state.docs[date]) {
      state.docs[date] = normalizeDoc(s.data(), date);
      renderCurrent();
    }
  } catch { /* çevrimdışı: yerel veriyle devam */ }
}

function lastWeight(exId, beforeDate) {
  const dates = Object.keys(state.docs).filter((d) => d < beforeDate).sort().reverse();
  for (const date of dates) {
    for (const e of Object.values(state.docs[date].exercises)) {
      if (e.exId !== exId) continue;
      for (let i = e.sets.length - 1; i >= 0; i--) {
        const s = e.sets[i];
        if (s.completed && s.weight != null) return s.weight;
      }
    }
  }
  return null;
}

/* ---------- Kişiye özel program ---------- */

const programRef = () => doc(db, "users", state.uid, "settings", "program");
const programCacheKey = () => `postur-program-${state.uid}`;
const videosRef = () => doc(db, "users", state.uid, "settings", "videos");
const videosCacheKey = () => `postur-videos-${state.uid}`;

// Firestore'dan video listesini okur; çevrimdışıyken yerel önbellek kullanılır.
async function loadVideos() {
  try {
    const cached = validVideos(JSON.parse(lsGet(videosCacheKey())));
    if (cached) exerciseVideos = cached;
  } catch { /* önbellek yok */ }
  try {
    const snap = await getDoc(videosRef());
    const items = snap.exists() ? validVideos(snap.data().items) : null;
    exerciseVideos = items || {};
    lsSet(videosCacheKey(), JSON.stringify(exerciseVideos));
  } catch (err) {
    console.warn("Videolar okunamadı:", err);
  }
}

// { hareketId: { id, title, channel?, language?, start? } } biçimini doğrular ve temizler; geçersizse null.
function validVideos(obj) {
  const r = checkVideos(obj);
  return r.errors.length ? null : r.items;
}

// Aynı denetim, içe aktarmada her hatalı kaydı adıyla bildirmek için hata listesiyle döner.
function checkVideos(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { items: {}, errors: ['Liste bir JSON nesnesi olmalı: { "hareketKimliği": { "id": "…", "title": "…" } }'] };
  }
  const items = {}, errors = [];
  for (const [key, v] of Object.entries(obj)) {
    const fail = (msg) => errors.push(`"${key}": ${msg}`);
    if (!/^[A-Za-z0-9]{1,40}$/.test(key)) { fail("hareket kimliği yalnızca harf ve rakam olabilir (en fazla 40)."); continue; }
    if (!v || typeof v !== "object") { fail("değer bir nesne olmalı."); continue; }
    if (typeof v.id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(v.id)) { fail("YouTube video kimliği (id) 11 karakter olmalı."); continue; }
    if (typeof v.title !== "string" || !v.title || v.title.length > 200) { fail("başlık (title) boş olamaz, en fazla 200 karakter."); continue; }
    const start = v.start ?? 0;
    if (!Number.isInteger(start) || start < 0 || start > 36000) { fail("başlangıç saniyesi (start) 0 ile 36000 arasında tam sayı olmalı."); continue; }
    const str = (x) => (typeof x === "string" && x.length <= 100 ? x : null);
    items[key] = { id: v.id, title: v.title, channel: str(v.channel), language: str(v.language), start };
  }
  return { items, errors };
}
// source: "ai" → kullanıcının yapay zekâyla hazırlayıp onayladığı program (atanmış şablon bunu ezmez).
const PROGRAM_FIELDS = ["id", "version", "name", "safetyNote", "progression", "exercises", "days", "source", "createdAt"];

function validDay(d) {
  return d && (d.rest || (Array.isArray(d.items) && d.items.every((it) =>
    it && typeof it.ex === "string" && typeof it.key === "string" && Number.isInteger(it.sets) && it.sets >= 1 && it.sets <= 10)));
}

function validProgram(p) {
  if (!p || typeof p !== "object" || typeof p.exercises !== "object" || !Array.isArray(p.days) || p.days.length !== 7) return false;
  return p.days.every((d) => validDay(d) && (d.home == null || validDay(d.home)));
}

// Yalnızca program alanlarını al (Firestore Timestamp vb. dışarıda kalsın).
function pickProgram(p) {
  const out = {};
  for (const k of PROGRAM_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

function applyProgram(p) {
  PROGRAM = pickProgram(p);
  EX = PROGRAM.exercises;
  PLAN = PROGRAM.days;
  state.programState = "ready";
  lsSet(programCacheKey(), JSON.stringify(PROGRAM));

  $("safetyText").textContent = PROGRAM.safetyNote || "";
  $("safetyNote").hidden = !PROGRAM.safetyNote;
  const prog = PROGRAM.progression;
  $("progression").hidden = !prog?.items?.length;
  $("progressionTitle").textContent = prog?.title || "İlerleme";
  $("progressionList").replaceChildren(...(prog?.items || []).map((t) => h("li", { text: t })));
}

function hasLegacyLocal() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("postur-check-") || k.startsWith("postur-v3-"))) return true;
    }
  } catch { /* yoksay */ }
  return false;
}

// Program kaynağı Firestore'dur. config/assignments'ta kullanıcıya bir şablon atanmışsa ve Firestore'daki
// program yoksa / farklı şablonsa / eski sürümse, şablon Firestore'a yazılır. Çevrimdışıyken önbellek kullanılır.
async function loadProgram() {
  if (!PROGRAM) {
    try {
      const cached = JSON.parse(lsGet(programCacheKey()));
      if (validProgram(cached)) applyProgram(cached);
    } catch { /* önbellek yok */ }
  }

  let stored = null, storedOk = false;
  try {
    const snap = await getDoc(programRef());
    storedOk = true;
    if (snap.exists()) stored = snap.data();
  } catch (err) {
    console.error("Program okunamadı:", err);
  }

  let assignedId = null;
  try {
    const snap = await getDoc(doc(db, "config", "assignments"));
    if (!snap.exists()) throw new Error("config/assignments yok");
    const a = snap.data();
    assignedId = a.users?.[state.uid] || null;
    state.assignedTemplate = assignedId;
    // Programı henüz olmayan ama zaten kayıtları bulunan (bu özellikten önceki) kullanıcıya varsayılan şablon.
    if (!assignedId && storedOk && !stored && a.existingUsersDefault &&
        (Object.keys(state.docs).length > 0 || hasLegacyLocal())) {
      assignedId = a.existingUsersDefault;
    }
  } catch (err) {
    console.warn("Program ataması okunamadı:", err);
  }
  // Açık atama yoksa kullanıcının mevcut şablonu kalır; şablonun yeni sürümü varsa güncellenir.
  if (!assignedId && storedOk && typeof stored?.id === "string") assignedId = stored.id;

  // Kullanıcının onayladığı yapay zekâ programı şablonla ezilmez; şablona Ayarlar > "Hazır programa dön" ile geçilir.
  if (stored?.source === "ai" && validProgram(stored)) assignedId = null;

  if (assignedId && storedOk && /^[a-z0-9-]+$/i.test(assignedId)) {
    try {
      const snap = await getDoc(doc(db, "templates", assignedId));
      if (!snap.exists()) throw new Error(`templates/${assignedId} yok`);
      const tpl = snap.data();
      const outdated = !stored || stored.id !== tpl.id || (stored.version || 0) < (tpl.version || 0);
      if (validProgram(tpl) && outdated) {
        stored = pickProgram(tpl);
        await setDoc(programRef(), { ...stored, assignedAt: serverTimestamp() });
      }
    } catch (err) {
      console.error("Program şablonu yüklenemedi:", err);
    }
  }

  if (validProgram(stored)) applyProgram(stored);
  else if (!PROGRAM) state.programState = storedOk ? "missing" : "error";
}

function noProgramCard() {
  const missing = state.programState === "missing";
  const uidBox = h("code", { class: "uid", text: state.uid || "" });
  const copyBtn = h("button", {
    type: "button", class: "btn", text: "Kimliği kopyala",
    onclick: async () => {
      try { await navigator.clipboard.writeText(state.uid); copyBtn.textContent = "Kopyalandı ✓"; }
      catch { copyBtn.textContent = "Kopyalanamadı, kimliği elle seçip kopyala"; }
    }
  });
  return missing
    ? h("div", { class: "card day-head no-program" },
        h("h2", { text: "Program atanmadı" }),
        h("p", { class: "sub", text: "Kendi yapay zekâ hesabınla program hazırlatabilir ya da aşağıdaki kullanıcı kimliğini program hazırlayan kişiye iletebilirsin." }),
        h("button", { type: "button", class: "btn btn-primary", text: "Yapay zekâ ile program hazırla", onclick: () => openAi() }),
        uidBox, copyBtn)
    : h("div", { class: "card day-head no-program" },
        h("h2", { text: "Program yüklenemedi" }),
        h("p", { class: "sub", text: "Sunucuya ulaşılamadı. İnternet bağlantını kontrol edip tekrar dene." }),
        retryProgramBtn());
}

function retryProgramBtn() {
  const btn = h("button", {
    type: "button", class: "btn btn-primary", text: "Tekrar dene",
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = "Deneniyor…";
      await loadProgram();
      renderCurrent();
      if (state.programState !== "ready") toast("Program yine yüklenemedi. Bağlantını kontrol edip biraz sonra tekrar dene.");
    }
  });
  return btn;
}

// Eski uygulamadaki anahtarlar: postur-check-<gün>-<n> ("1"), postur-v3-<gün>-<n>-set-<i> ("1"),
// postur-v3-<gün>-<n>-kg-<i> (sayı). Gün kodları: pzt sal car per cum cmt pzr.
const LEGACY_DAYS = { pzt: 0, sal: 1, car: 2, per: 3, cum: 4, cmt: 5, pzr: 6 };

function legacyToday(legacy) {
  const idx = dayIndex(new Date());
  const code = Object.keys(LEGACY_DAYS).find((c) => LEGACY_DAYS[c] === idx);
  if (PROGRAM?.id !== "postur-baslangic") return null; // eski anahtarlar yalnızca bu programa karşılık gelir
  const items = PLAN[idx]?.items;
  if (!items) return null;
  const sets = {}; // n -> { done:bool, sets:{i:{completed,weight}} }
  for (const [k, v] of Object.entries(legacy)) {
    let m = k.match(new RegExp(`^postur-check-${code}-(\\d+)$`));
    if (m && v === "1") (sets[m[1]] ||= { done: false, sets: {} }).done = true;
    m = k.match(new RegExp(`^postur-v3-${code}-(\\d+)-(set|kg)-(\\d+)$`));
    if (m) {
      const e = (sets[m[1]] ||= { done: false, sets: {} });
      const st = (e.sets[m[3]] ||= { completed: false, weight: null });
      if (m[2] === "set") st.completed = v === "1"; else st.weight = parseWeight(v);
    }
  }
  const exercises = {};
  items.forEach((item, order) => {
    const e = sets[String(order + 1)];
    if (!e) return;
    const list = Array.from({ length: item.sets }, (_, i) => {
      const st = e.sets[String(i + 1)] || { completed: false, weight: null };
      return { completed: st.completed || (e.done && !Object.keys(e.sets).length), weight: EX[item.ex].weight ? st.weight : null };
    });
    if (list.some((x) => x.completed || x.weight != null)) {
      exercises[item.key] = { exId: item.ex, name: item.name || EX[item.ex].name, order, sets: list };
    }
  });
  return Object.keys(exercises).length ? exercises : null;
}

// Eski localStorage kayıtlarını bir kez Firestore'a taşır (bugünün günü gerçek set/kg kaydına dönüşür,
// ham anahtarların hepsi ayrıca legacyLocal alanında saklanır).
async function migrateLegacy() {
  if (lsGet("postur-firebase-migrated") === "true") return;
  const legacy = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("postur-check-") || k.startsWith("postur-v3-"))) {
        legacy[k] = String(localStorage.getItem(k)).slice(0, 2000);
      }
    }
  } catch { return; }
  try {
    if (Object.keys(legacy).length) {
      const now = new Date();
      const today = ymd(now);
      const data = { date: today, day: DAYS[dayIndex(now)], legacyLocal: legacy, migratedAt: serverTimestamp() };
      const existing = state.docs[today];
      const hasData = existing && Object.values(existing.exercises).some((e) => e.touched);
      const ex = hasData ? null : legacyToday(legacy);
      if (ex) {
        data.exercises = ex;
        data.completedSets = Object.values(ex).reduce((n, e) => n + e.sets.filter((x) => x.completed).length, 0);
      }
      await setDoc(workoutRef(today), data, { merge: true });
      if (ex) {
        state.docs[today] = normalizeDoc(data, today);
        state.totalDirty = true;
        renderCurrent();
      }
    }
    if (legacy["postur-v3-auto-rest"] === "1" && lsGet("postur-auto-timer") == null) {
      lsSet("postur-auto-timer", "1");
      $("autoTimer").checked = true;
    }
    lsSet("postur-firebase-migrated", "true");
  } catch (err) {
    console.error("Migration hatası (sonra tekrar denenecek):", err);
  }
}

/* ============================================================
   PROGRAM GÖRÜNÜMÜ
   ============================================================ */

function weekDates() {
  const today = new Date();
  const mon = addDays(today, -dayIndex(today));
  return DAYS.map((_, i) => ymd(addDays(mon, i)));
}

function renderTabs() {
  const nav = $("dayTabs");
  const todayIdx = dayIndex(new Date());
  nav.replaceChildren(...DAYS.map((name, i) => {
    const active = i === state.selectedIdx;
    return h("button", {
      type: "button", role: "tab", "aria-selected": String(active),
      class: `day-tab${active ? " is-active" : ""}${i === todayIdx ? " is-today" : ""}${dayDoneAt(i) ? " is-done" : ""}`,
      onclick: () => selectDay(i)
    }, h("span", { class: "d-name", text: name }), h("span", { class: "d-rel", text: relLabel(i - todayIdx) }));
  }));
  const act = nav.querySelector(".is-active");
  if (act) nav.scrollLeft = act.offsetLeft - (nav.clientWidth - act.offsetWidth) / 2;
}

function selectDay(i) {
  state.selectedIdx = i;
  state.initialScroll = false;
  renderTabs();
  renderProgram();
  loadSingleDay(weekDates()[i]);
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  lsSet("postur-mode", mode);
  renderProgram();
}

// iOS tarzı Salon | Evde seçici.
function modeSwitch() {
  const opt = (mode, label) => h("button", {
    type: "button", role: "radio", class: "seg-btn", "aria-checked": String(state.mode === mode),
    tabindex: state.mode === mode ? "0" : "-1", text: label, onclick: () => setMode(mode)
  });
  return h("div", { class: "segmented", role: "radiogroup", "aria-label": "Antrenman yeri", "data-rg": "mode" },
    opt("gym", "Salon"), opt("home", "Evde"));
}

function renderProgram() {
  const idx = state.selectedIdx;
  const date = weekDates()[idx];
  const panel = $("dayPanel");
  const draftCard = aiDraftCard();
  if (!PROGRAM) {
    panel.replaceChildren(...[draftCard, state.programState === "missing" || state.programState === "error" ? noProgramCard()
      : h("div", { class: "card empty", text: "Program yükleniyor…" })].filter(Boolean));
    return;
  }
  const hasHome = Boolean(PLAN[idx].home);
  const mode = hasHome ? state.mode : "gym";
  const plan = mode === "home" ? PLAN[idx].home : PLAN[idx];
  const todayIdx = dayIndex(new Date());

  const head = h("div", { id: "dayHead", class: "card day-head" },
    h("h2", { text: DAYS[idx] }),
    idx === todayIdx && h("div", { class: "day-badge", text: "BUGÜN" }),
    h("div", { class: "day-badge done-badge", text: "TAMAMLANDI ✓" }),
    hasHome && modeSwitch(),
    h("div", { class: "sub", text: `${longDate(date)} · ${plan.title}` }),
    plan.note && h("div", { class: "sub", text: plan.note })
  );

  if (plan.rest) {
    head.append(h("ul", { class: "rest-list" }, (plan.lines || []).map((l) => h("li", { text: l }))));
    panel.replaceChildren(...[draftCard].filter(Boolean), head);
    return;
  }
  if (state.loading) {
    panel.replaceChildren(...[draftCard].filter(Boolean), head, h("div", { class: "empty", text: "Kayıtlar yükleniyor…" }));
    return;
  }
  panel.replaceChildren(...[draftCard].filter(Boolean), head, h("div", { class: "view" },
    plan.items.map((item, n) => exerciseCard(date, item, n, mode)),
    h("div", { id: "dayDone", class: "card day-done", role: "status", hidden: !dayComplete(date, plan), text: "Antrenman tamamlandı ✓" })
  ));
  head.classList.toggle("is-done", dayComplete(date, plan));
  if (state.initialScroll && idx === todayIdx && (state.historyLoaded || state.docs[date])) {
    state.initialScroll = false;
    requestAnimationFrame(() => scrollToProgress(date, plan));
  }
}

// Açılışta: son tamamlanan hareketten sonrakine, o yoksa ilk tamamlanmamışa kaydır.
// Hiç hareket yapılmamışsa ya da gün tamamlandıysa üstte kalır.
function scrollToProgress(date, plan) {
  const done = plan.items.map((it) => exerciseDone(date, it));
  const last = done.lastIndexOf(true);
  if (last < 0 || done.every(Boolean)) return;
  const target = last + 1 < done.length ? last + 1 : done.indexOf(false);
  const card = $("dayPanel").querySelectorAll(".ex")[target];
  if (card) scrollToCard(card, false);
}

function currentPlan() {
  const day = PLAN[state.selectedIdx];
  return day?.home && state.mode === "home" ? day.home : day;
}

function exerciseDone(date, item) {
  const sets = state.docs[date]?.exercises[item.key]?.sets;
  return sets?.length > 0 && sets.every((s) => s.completed);
}

function dayComplete(date, plan) {
  if (!plan || plan.rest || !plan.items?.length) return false;
  return plan.items.every((it) => exerciseDone(date, it));
}

// Gün sekmesi: salon ya da ev programından biri tamamlandıysa gün bitmiş sayılır.
function dayDoneAt(i) {
  const day = PLAN[i];
  if (!day) return false;
  const date = weekDates()[i];
  return dayComplete(date, day) || dayComplete(date, day.home);
}

function refreshDayDone(date) {
  const complete = dayComplete(date, currentPlan());
  const el = $("dayDone");
  if (el) el.hidden = !complete;
  $("dayHead")?.classList.toggle("is-done", complete);
  $("dayTabs").children[state.selectedIdx]?.classList.toggle("is-done", dayDoneAt(state.selectedIdx));
}

function scrollToCard(el, smooth = true) {
  const header = document.querySelector(".topbar");
  el.style.scrollMarginTop = `${(header ? header.offsetHeight : 0) + 12}px`; // sticky başlık + gün sekmeleri altında kalmasın
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth && !reduce ? "smooth" : "auto", block: "start" });
}

// Bir hareketin tüm setleri kullanıcı tarafından tamamlandığında sonraki karta kaydırır; son hareketse gün durumunu gösterir.
function onExerciseDone(card, date) {
  refreshDayDone(date);
  let next = card?.nextElementSibling;
  while (next && !next.classList.contains("ex")) next = next.nextElementSibling;
  if (next) { scrollToCard(next); return; }
  const done = $("dayDone");
  if (done && !done.hidden) scrollToCard(done);
}

function exerciseCard(date, item, order, mode = "gym") {
  const home = mode === "home";
  const base = EX[item.ex] || { name: item.ex, weight: false };
  const lib = home ? { ...base, weight: false } : base; // evde kg alanı yok
  const name = item.name || lib.name;
  const altName = lib.alt && EX[lib.alt]?.name;
  const video = videoFor(item.ex);
  const foreignVideo = video?.language && video.language !== "tr"; // dil bilinmiyorsa etiket yok
  const entry = state.docs[date]?.exercises[item.key];
  const setsData = () => ensureEntry(date, item, order).sets;
  const initial = entry ? entry.sets : Array.from({ length: item.sets }, () => ({ completed: false, weight: null }));
  const last = lib.weight ? lastWeight(item.ex, date) : null;
  const timing = setTiming(item);
  const kind = timing && musicKind(item, lib, timing);

  const setsBox = h("div", { class: "sets" });

  const drawSets = () => {
    const current = state.docs[date]?.exercises[item.key]?.sets || initial;
    setsBox.replaceChildren(...current.map((s, i) => setRow(i, s)));
  };

  const setRow = (i, s) => {
    const btn = h("button", {
      type: "button", class: "chk", role: "checkbox",
      "aria-checked": String(!!s.completed), "aria-label": `Set ${i + 1} tamamlandı`, text: "✓"
    });
    // Set sayacı (süreli ya da tahmini süreli): sayaç bitince set işaretlenir. Kart o an ekranda değilse (gün değişti vb.) doğrudan kaydedilir.
    const workKey = `${date}|${item.key}|${i}`;
    const markDone = () => {
      const e = ensureEntry(date, item, order);
      if (!e.sets[i] || e.sets[i].completed) return;
      e.sets[i].completed = true;
      e.touched = true;
      saveNow(date);
      renderTabs();
    };
    const workBtn = timing && h("button", {
      type: "button", class: "btn work",
      "aria-label": `Set ${i + 1} sayacını başlat, ${timing.estimated ? "tahmini " : ""}${fmtTime(timing.total)}`,
      onclick: () => workToggle(workKey, timing, workBtn, btn, markDone, {
        name, set: `Set ${i + 1} / ${state.docs[date]?.exercises[item.key]?.sets.length || item.sets}`,
        kind, track: musicTrackFor(item.ex, kind)
      })
    });
    if (workBtn) workBind(workKey, timing, workBtn, btn);
    let input = null;
    const errId = `kgErr-${item.key}-${i}`;
    const errEl = h("p", { id: errId, class: "form-error set-error", hidden: true });
    const showWeightError = (msg) => {
      errEl.textContent = msg || "";
      errEl.hidden = !msg;
      if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    };
    if (lib.weight) {
      input = h("input", {
        type: "text", inputmode: "decimal", pattern: "[0-9]*[.,]?[0-9]*", autocomplete: "off",
        enterkeyhint: "done", placeholder: last != null ? String(last).replace(".", ",") : "0",
        value: s.weight != null ? String(s.weight).replace(".", ",") : "",
        "aria-label": `Set ${i + 1} ağırlık (kg)`, "aria-describedby": errId
      });
      // Geçersiz değer kaydedilmez; uyarı alan bırakılınca gösterilir, düzeltilince hemen kalkar.
      input.addEventListener("input", () => {
        const msg = weightError(input.value);
        if (msg) { if (errEl.isConnected && !errEl.hidden) showWeightError(msg); return; }
        showWeightError(null);
        const e = ensureEntry(date, item, order);
        e.sets[i].weight = parseWeight(input.value);
        e.touched = true;
        scheduleSave(date);
      });
      input.addEventListener("blur", () => {
        showWeightError(weightError(input.value));
        if (debounceTimers[date]) saveNow(date);
      });
    }
    btn.addEventListener("click", () => {
      const e = ensureEntry(date, item, order);
      const cur = e.sets[i];
      cur.completed = !cur.completed;
      e.touched = true;
      if (cur.completed && cur.weight == null && input && last != null) {
        cur.weight = last; // son ağırlık başlangıç önerisi
        input.value = String(last).replace(".", ",");
        showWeightError(null);
      }
      btn.setAttribute("aria-checked", String(cur.completed));
      saveNow(date);
      if (cur.completed && $("autoTimer").checked) timerStart(timer.preset);
      // Yalnızca kullanıcı bir seti işaretleyip hareketin tüm setleri bittiğinde ilerle (geri almada kaydırma yok).
      if (cur.completed && e.sets.every((x) => x.completed)) onExerciseDone(btn.closest(".ex"), date);
      else refreshDayDone(date);
    });
    return h("div", { class: "set-row" },
      h("span", { class: "set-label", text: `Set ${i + 1}` }),
      btn,
      input && h("label", { class: "kg" }, input, h("span", { text: "kg" })),
      workBtn,
      input && errEl
    );
  };

  drawSets();

  const applySets = () => {
    ensureEntry(date, item, order).touched = true;
    drawSets();
    saveNow(date);
    refreshDayDone(date);
  };
  const changeSets = (delta) => {
    const e = ensureEntry(date, item, order);
    const next = e.sets.length + delta;
    if (next < 1 || next > 6) {
      toast(next < 1 ? "En az 1 set olmalı." : "En fazla 6 set eklenebilir.");
      return;
    }
    if (delta > 0) { e.sets.push({ completed: false, weight: null }); applySets(); return; }
    const removed = e.sets.pop();
    const n = e.sets.length + 1;
    applySets();
    // Silinen set (işaret ve ağırlığıyla) 5 sn içinde geri alınabilir.
    toast(`${name}: Set ${n} silindi.`, {
      action: "Geri al",
      onAction: () => {
        const cur = ensureEntry(date, item, order);
        if (cur.sets.length >= 6) return;
        cur.sets.push(removed);
        applySets();
      }
    });
  };

  const videoTitle = video?.title || name;
  const media = video
    ? h("button", {
        type: "button", class: "thumb", "aria-label": `${name} videosunu aç`,
        onclick: (ev) => openVideo(video.id, videoTitle, ev.currentTarget, video.start)
      }, thumbImg(video.id, name), h("span", { class: "play", "aria-hidden": "true", text: "▶" }))
    : h("div", { class: "thumb static" }, h("img", { src: placeholderImg(name), alt: name, loading: "lazy" }));

  return h("article", { class: "card ex" },
    h("div", { class: "ex-head" },
      h("span", { class: "ex-num", text: String(order + 1) }),
      h("div", null,
        h("h3", { text: name }),
        h("div", { class: "ex-reps" },
          item.sets > 1 ? h("b", { text: `${item.sets} × ${item.reps}` }) : h("b", { text: item.reps }),
          item.hint && ` · ${item.hint}`
        ),
        (altName || (home && !lib.cardio) || foreignVideo) && h("div", { class: "ex-tags" },
          home && !lib.cardio && h("span", { class: "tag", text: "Vücut ağırlığı" }),
          foreignVideo && h("span", { class: "tag", text: `${LANG_NAMES[video.language] || video.language.toUpperCase()} video` }),
          altName && h("span", { class: "tag alt", text: `${home ? "Salon" : "Ev"} alternatifi: ${altName}` })
        )
      )
    ),
    media,
    h("div", { class: "notes" },
      lib.purpose && h("div", null, h("b", { text: "Amaç: " }), lib.purpose),
      lib.form && h("div", null, h("b", { text: "Form: " }), lib.form)
    ),
    lib.weight && h("div", { class: "last", text: last != null ? `Son: ${fmtKg(last)}` : "Son: kayıt yok" }),
    setsBox,
    h("div", { class: "ex-actions" },
      h("button", { type: "button", class: "btn small", "aria-label": "Set çıkar", text: "−", onclick: () => changeSets(-1) }),
      h("button", { type: "button", class: "btn small", "aria-label": "Set ekle", text: "+", onclick: () => changeSets(1) }),
      h("button", { type: "button", class: "btn", onclick: () => timerStart() }, h("span", { "aria-hidden": "true", text: "⏱" }), "Dinlenme"),
      video
        ? h("a", { class: "btn", href: ytWatch(video.id, video.start), target: "_blank", rel: "noopener noreferrer", text: "YouTube'da aç ↗" })
        : h("a", { class: "btn", href: ytSearch(lib.search || name), target: "_blank", rel: "noopener noreferrer", text: "YouTube'da ara ↗" })
    )
  );
}

function thumbImg(id, name) {
  const img = h("img", { src: ytThumb(id), alt: name, loading: "lazy" });
  img.addEventListener("error", () => { img.src = placeholderImg(name); }, { once: true });
  return img;
}

/* ============================================================
   GEÇMİŞ GÖRÜNÜMÜ
   ============================================================ */

function workoutList() {
  return Object.values(state.docs)
    .filter((d) => countSets(d) > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// Yakın tarihler göreli ("Bugün", "Dün"), eskiler tam tarih.
function relDay(date) {
  const diff = Math.round((parseYmd(ymd(new Date())) - parseYmd(date)) / 86400000);
  return diff === 0 ? "Bugün" : diff === 1 ? "Dün" : null;
}

const dayName = (date) => DAYS[dayIndex(parseYmd(date))];
const weekStart = (date) => { const d = parseYmd(date); return ymd(addDays(d, -dayIndex(d))); };

function weekLabel(start) {
  const thisWeek = weekStart(ymd(new Date()));
  if (start === thisWeek) return "Bu hafta";
  if (start === ymd(addDays(parseYmd(thisWeek), -7))) return "Geçen hafta";
  const a = parseYmd(start), b = addDays(a, 6);
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]}`
    : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
}

function emptyCard(text, action, onclick) {
  return h("div", { class: "card empty empty-action" }, h("p", { text }),
    action && h("button", { type: "button", class: "btn btn-primary", text: action, onclick }));
}

function renderHistory() {
  const root = $("viewHistory");
  const list = workoutList();
  if (!list.length) {
    root.replaceChildren(emptyCard("Henüz kayıtlı antrenman yok. Programdaki setleri işaretledikçe antrenmanların burada listelenir.",
      "Programa git", () => showView("program")));
    return;
  }
  const shown = list.slice(0, state.historyShown);
  const items = [];
  let week = null;
  for (const d of shown) {
    const ws = weekStart(d.date);
    if (ws !== week) {
      week = ws;
      const n = list.filter((x) => weekStart(x.date) === ws).length;
      items.push(h("h2", { class: "section-title", text: `${weekLabel(ws)} · ${n} antrenman` }));
    }
    items.push(historyItem(d));
  }
  if (list.length > shown.length) {
    items.push(h("button", {
      type: "button", class: "btn btn-block", text: "Daha fazla göster",
      onclick: () => { state.historyShown += 30; renderHistory(); }
    }));
  }
  root.replaceChildren(...items);
}

function historyItem(d) {
  {
    const open = state.openHistory.has(d.date);
    const detail = h("div", { class: "h-detail", hidden: !open },
      Object.values(d.exercises)
        .filter((e) => e.sets.some((s) => s.completed || s.weight != null))
        .sort((a, b) => a.order - b.order)
        .map((e) => h("div", { class: "h-ex" },
          h("h4", { text: e.name }),
          e.sets.map((s, i) => h("div", {
            text: `${s.weight == null ? `Set ${i + 1}` : fmtKg(s.weight)} ${s.completed ? "✓" : "–"}`
          }))
        ))
    );
    const toggle = h("button", {
      type: "button", class: "h-toggle", "aria-expanded": String(open),
      onclick: () => {
        const nowOpen = detail.hidden;
        detail.hidden = !nowOpen;
        toggle.setAttribute("aria-expanded", String(nowOpen));
        if (nowOpen) state.openHistory.add(d.date); else state.openHistory.delete(d.date);
      }
    },
      h("div", null,
        h("div", { class: "h-date", text: relDay(d.date) || longDate(d.date) }),
        h("div", { class: "h-day", text: relDay(d.date) ? `${dayName(d.date)} · ${longDate(d.date)}` : dayName(d.date) })),
      h("span", { class: "h-count", text: `${countSets(d)} set ›` })
    );
    return h("div", { class: "card h-item" }, toggle, detail);
  }
}

/* ============================================================
   İSTATİSTİK GÖRÜNÜMÜ
   ============================================================ */

function weightSeries(from = "") {
  // Programdan bağımsız: kayıtta kg girilmiş her hareket sayılır (program değişse de geçmiş korunur).
  const byEx = {}; // exId -> { name, pts: [{date, max}] }
  const dates = Object.keys(state.docs).filter((d) => d >= from).sort();
  for (const date of dates) {
    const perEx = {};
    for (const e of Object.values(state.docs[date].exercises)) {
      for (const s of e.sets) {
        if (s.completed && s.weight != null) {
          perEx[e.exId] = Math.max(perEx[e.exId] ?? 0, s.weight);
          (byEx[e.exId] ||= { name: e.name, pts: [] }).name = EX[e.exId]?.name || e.name;
        }
      }
    }
    for (const [id, max] of Object.entries(perEx)) byEx[id].pts.push({ date, max });
  }
  return byEx;
}

function sparkline(points) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 96 34");
  svg.setAttribute("aria-hidden", "true");
  const vals = points.map((p) => p.max);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = 3 + (i / (points.length - 1)) * 90;
    const y = 30 - ((p.max - min) / span) * 26;
    return [x, y];
  });
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("points", coords.map((c) => c.join(",")).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor"); // renk CSS'ten (--accent)
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.append(line);
  const last = coords[coords.length - 1];
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", last[0]); dot.setAttribute("cy", last[1]); dot.setAttribute("r", "3"); dot.setAttribute("fill", "currentColor");
  svg.append(dot);
  return svg;
}

// Aralık seçici (7/30/90 gün). Uygulama son 90 günü yüklediği için 90 günde önceki dönemle karşılaştırma yok.
function rangeSwitch() {
  const opt = (n) => h("button", {
    type: "button", role: "radio", class: "seg-btn", "aria-checked": String(state.statsRange === n),
    tabindex: state.statsRange === n ? "0" : "-1", text: `${n} gün`,
    onclick: () => { state.statsRange = n; lsSet("postur-stats-range", String(n)); renderStats(); }
  });
  return h("div", { class: "segmented seg-3", role: "radiogroup", "aria-label": "Zaman aralığı", "data-rg": "range" },
    opt(7), opt(30), opt(90));
}

// Önceki döneme göre fark: renge ek olarak ok ve metinle anlatılır.
function deltaLine(cur, prev, range) {
  if (prev == null) return null;
  const d = cur - prev;
  const text = d > 0 ? `↑ ${d} artış` : d < 0 ? `↓ ${-d} azalış` : "= aynı";
  return h("div", { class: `delta${d > 0 ? " up" : ""}`, text: `${text}, önceki ${range} güne göre` });
}

function renderStats() {
  const root = $("viewStats");
  const list = workoutList();
  const today = new Date();
  const R = state.statsRange;
  const from = ymd(addDays(today, -(R - 1)));
  const prevFrom = ymd(addDays(today, -(2 * R - 1)));
  const inRange = list.filter((d) => d.date >= from);
  const inPrev = R < 90 ? list.filter((d) => d.date >= prevFrom && d.date < from) : null;
  const setsOf = (l) => l.reduce((n, d) => n + countSets(d), 0);
  const total = state.totalWorkouts ?? list.length;
  const perWeek = (inRange.length / (R / 7)).toFixed(1).replace(".", ",");

  const tile = (v, l, delta, id) => h("div", { class: "card tile" },
    h("div", { class: "v", id, text: String(v) }), h("div", { class: "l", text: l }), delta);

  const series = weightSeries(from);
  const rows = Object.values(series)
    .sort((a, b) => a.name.localeCompare(b.name, "tr"))
    .map(({ name, pts }) => {
      const first = pts[0].max, lastV = pts[pts.length - 1].max, mx = Math.max(...pts.map((p) => p.max));
      return h("div", { class: "card w-row" },
        h("div", { class: "w-txt" },
          h("div", { class: "w-name", text: name }),
          h("div", { class: "w-range", text: `${first} kg → ${lastV} kg` }),
          h("div", { class: "w-max", text: `Maks: ${mx} kg` })
        ),
        pts.length >= 2 ? sparkline(pts) : h("div", { class: "w-note", text: "Grafik için en az 2 kayıt gerekir" })
      );
    });

  root.replaceChildren(
    rangeSwitch(),
    h("div", { class: "tiles" },
      tile(inRange.length, `Antrenman (son ${R} gün)`, deltaLine(inRange.length, inPrev?.length, R)),
      tile(setsOf(inRange), `Tamamlanan set (son ${R} gün)`, deltaLine(setsOf(inRange), inPrev && setsOf(inPrev), R)),
      tile(perWeek, `Haftalık ortalama antrenman (son ${R} gün)`),
      tile(total, "Toplam antrenman (tümü)", null, "totalTile")
    ),
    h("h2", { class: "section-title", text: `Ağırlık gelişimi (son ${R} gün)` }),
    ...(rows.length ? rows : [emptyCard("Bu aralıkta ağırlık kaydı yok. Ağırlıklı hareketlerde kg girdikçe gelişimin burada görünür.")])
  );

  refreshTotal();
}

// Toplam antrenman sayısı: tek bir aggregate sorgu (birkaç doküman okuması değerinde).
async function refreshTotal() {
  if (!state.totalDirty || !navigator.onLine || !state.uid) return;
  state.totalDirty = false;
  try {
    const snap = await getCountFromServer(
      query(collection(db, "users", state.uid, "workouts"), where("completedSets", ">", 0))
    );
    state.totalWorkouts = snap.data().count;
    if (state.view === "stats" && $("totalTile")) $("totalTile").textContent = String(state.totalWorkouts);
  } catch { state.totalDirty = true; }
}

/* ============================================================
   GÖRÜNÜM YÖNETİMİ
   ============================================================ */

function renderCurrent() {
  if (state.view === "program") renderProgram();
  else if (state.view === "history") renderHistory();
  else renderStats();
}

// Görünümlerin adresi: Program kök, Geçmiş #gecmis, İstatistik #istatistik (yer imi ve geri tuşu için).
const VIEW_HASH = { program: "", history: "#gecmis", stats: "#istatistik" };
const hashToView = (hash) => Object.keys(VIEW_HASH).find((v) => VIEW_HASH[v] && VIEW_HASH[v] === hash) || "program";
const viewScroll = {}; // görünüm → kaydırma konumu (sekme değişince korunur)

function showView(name, { push = true } = {}) {
  if (state.view && !$("appShell").hidden) viewScroll[state.view] = window.scrollY;
  if (push) {
    const url = location.pathname + location.search + VIEW_HASH[name];
    if (url !== location.pathname + location.search + location.hash) history.pushState({ view: name }, "", url);
  }
  state.view = name;
  $("viewProgram").hidden = name !== "program";
  $("viewHistory").hidden = name !== "history";
  $("viewStats").hidden = name !== "stats";
  $("dayTabs").hidden = name !== "program";
  document.querySelectorAll(".nav-btn").forEach((b) => {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  renderCurrent();
  window.scrollTo(0, viewScroll[name] || 0);
}

/* ============================================================
   DİNLENME SAYACI
   ============================================================ */

// Dinlenme süresi cihazda saklanır; hazır süreler ya da ±15 sn ile ayarlanan özel süre (15 sn – 10 dk).
const REST_MIN = 15, REST_MAX = 600;
const savedRest = Number(lsGet("postur-rest"));
const restPreset = Number.isInteger(savedRest) && savedRest >= REST_MIN && savedRest <= REST_MAX ? savedRest : 90;
const timer = { preset: restPreset, remaining: restPreset, running: false, endAt: 0, iv: null };

// Ekran okuyucuya kısa duyuru (her saniye değil; yalnızca önemli anlar).
function announce(msg) {
  const el = $("srAnnounce");
  el.textContent = "";
  requestAnimationFrame(() => { el.textContent = msg; });
}

const fmtTime = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

function timerRender() {
  $("timerDisplay").textContent = timer.remaining === 0 ? "Bitti!" : fmtTime(timer.remaining);
  $("timerToggle").textContent = timer.running ? "Duraklat" : (timer.remaining > 0 && timer.remaining < timer.preset ? "Devam" : "Başlat");
  $("timer").classList.toggle("is-done", timer.remaining === 0);
  document.querySelectorAll("#timer [data-preset]").forEach((b) =>
    b.setAttribute("aria-pressed", String(Number(b.dataset.preset) === timer.preset)));
}

function timerTick() {
  timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
  if (timer.remaining === 0) {
    timerStop();
    announce("Dinlenme bitti.");
    beep(2);
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch { /* desteklenmiyor */ }
  }
  timerRender();
}

function timerStop() {
  clearInterval(timer.iv);
  timer.iv = null;
  timer.running = false;
  keepAwake("rest", false);
}

function timerOpen() {
  $("timer").hidden = false;
  $("timerFab").hidden = true;
}

function timerStart(preset) {
  audioUnlock();
  timerOpen();
  if (preset) { timer.preset = preset; timerStop(); timer.remaining = preset; }
  if (timer.remaining <= 0) timer.remaining = timer.preset;
  timerStop();
  timer.endAt = Date.now() + timer.remaining * 1000;
  timer.running = true;
  timer.iv = setInterval(timerTick, 250);
  keepAwake("rest", true);
  timerRender();
}

function timerPause() {
  if (timer.running) timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
  timerStop();
  timerRender();
}

function setRestPreset(sec) {
  timer.preset = Math.min(REST_MAX, Math.max(REST_MIN, sec));
  lsSet("postur-rest", String(timer.preset));
  timerReset();
}

// Çalışırken yalnızca kalan süre değişir; dururken varsayılan dinlenme süresi değişir.
function timerAdjust(delta) {
  if (timer.running) {
    timer.endAt = Math.max(Date.now() + 1000, timer.endAt + delta * 1000);
    timerTick();
  } else if (timer.remaining > 0 && timer.remaining < timer.preset) {
    timer.remaining = Math.max(1, timer.remaining + delta);
    timerRender();
  } else {
    setRestPreset(timer.preset + delta);
  }
}

function timerReset() {
  timerStop();
  timer.remaining = timer.preset;
  timerRender();
}

function initTimer() {
  $("timerToggle").addEventListener("click", () => (timer.running ? timerPause() : timerStart()));
  $("timerReset").addEventListener("click", timerReset);
  $("timerClose").addEventListener("click", () => {
    timerReset();
    $("timer").hidden = true;
    $("timerFab").hidden = false;
  });
  $("timerFab").addEventListener("click", timerOpen);
  document.querySelectorAll("#timer [data-preset]").forEach((b) =>
    b.addEventListener("click", () => setRestPreset(Number(b.dataset.preset))));
  document.querySelectorAll("#timer [data-adjust]").forEach((b) =>
    b.addEventListener("click", () => timerAdjust(Number(b.dataset.adjust))));
  $("autoTimer").checked = lsGet("postur-auto-timer") === "1";
  $("autoTimer").addEventListener("change", (e) => lsSet("postur-auto-timer", e.target.checked ? "1" : "0"));
  $("timerFab").hidden = false;
  timerRender();
}

/* ============================================================
   SET SAYACI: süreli setlerde gerçek süre, tekrarlı setlerde tahmini süre; sayaç boyunca müzik çalar
   ============================================================ */

// Süre: şablondaki `duration` (sn) öncelikli, yoksa `reps` metninden okunur: "30 sn", "45 saniye", "1 dk",
// "1 dk 30 sn", "20–30 sn" (üst sınır). Tekrar sayılı hareketler ("12 tekrar, 2 sn tut") süreli sayılmaz.
function durationOf(item) {
  if (Number.isInteger(item.duration) && item.duration >= 5 && item.duration <= 3600) return item.duration;
  const s = String(item.reps ?? "").toLocaleLowerCase("tr");
  if (s.includes("tekrar")) return null;
  const num = String.raw`(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*`;
  const val = (m) => (m ? parseFloat((m[2] || m[1]).replace(",", ".")) : 0);
  const total = Math.round(val(s.match(new RegExp(num + "(?:dk|dakika|min)"))) * 60 +
    val(s.match(new RegExp(num + "(?:sn|saniye|sec)"))));
  return total >= 5 && total <= 3600 ? total : null;
}

const REP_SEC = 4;     // tahmini tekrar süresi: kontrollü tempo (≈2 sn kaldır, 2 sn indir)
const SIDE_SWITCH = 5; // iki taraf arasında geçiş (sn)

const repText = (item) => `${item.reps ?? ""} ${item.hint ?? ""}`.toLocaleLowerCase("tr");
// Taraf başına yapılan hareket: "10 / taraf", "30 sn / taraf", "her bacak".
const perSide = (item) => /\/\s*taraf|her (taraf|bacak|kol)|each side|per side/.test(repText(item));

// Tekrar sayısı: "12" → 12, "10–12" → 12 (üst sınır), "6 / taraf" → 6.
function repCount(reps) {
  const m = String(reps ?? "").match(/(\d+)(?:\s*[-–]\s*(\d+))?/);
  const n = m ? Number(m[2] || m[1]) : 0;
  return n >= 1 && n <= 100 ? n : null;
}

// Tekrar başına bekleme: "Her tekrarda 5 sn", "12 tekrar, 2 sn tut".
function holdOf(item) {
  const s = repText(item);
  if (!/tekrar|tut/.test(s)) return 0;
  const m = s.match(/(\d+)\s*(?:sn|saniye)/);
  return m ? Math.min(30, Number(m[1])) : 0;
}

// Setin süresi. Süreli harekette şablondaki süre; tekrarlı harekette tekrar × tempo tahmini (5 sn'ye yuvarlanır).
// Taraf başına hareketlerde iki taraf ve aradaki geçiş eklenir. Süresi okunamayan sette sayaç yoktur.
function setTiming(item) {
  const sides = perSide(item) ? 2 : 1;
  const timed = durationOf(item);
  if (timed) {
    const total = timed * sides + (sides > 1 ? SIDE_SWITCH : 0);
    return total <= 3600 ? { seg: timed, sides, total, estimated: false } : null;
  }
  const reps = repCount(item.reps);
  if (!reps) return null;
  const perRep = REP_SEC + holdOf(item);
  const seg = Math.ceil((reps * perRep) / 5) * 5;
  const total = seg * sides + (sides > 1 ? SIDE_SWITCH : 0);
  return total <= 3600 ? { seg, sides, total, estimated: true, reps, perRep } : null;
}

const segmentsOf = (t) => (t.sides > 1
  ? [{ side: 1, end: t.seg }, { change: true, end: t.seg + SIDE_SWITCH }, { side: 2, end: t.total }]
  : [{ end: t.total }]);

const WORK_PREP = 3; // başlamadan önce pozisyon alma süresi (sn)
const WORK_EXTEND = 15; // tahmini sette "+15 sn"
const work = {
  key: null, total: 0, segs: [], segIdx: -1, timing: null, endAt: 0, iv: null, btn: null, chk: null, done: null,
  paused: false, leftMs: 0, lastBeep: null, kind: null, track: 0
};

const workLabel = (t) => `${t.estimated ? "~" : ""}${fmtTime(t.total)}`;

function workIdle(btn, timing) {
  btn.textContent = `▶ ${workLabel(timing)}`;
  btn.classList.remove("is-running");
  btn.setAttribute("aria-pressed", "false");
}

const workLeftMs = () => Math.max(0, work.paused ? work.leftMs : work.endAt - Date.now());

// Geçen süreye göre bulunulan bölüm (tek taraf, ya da 1. taraf → geçiş → 2. taraf). Hazırlıkta -1.
function workSegment(leftMs) {
  const el = work.total * 1000 - leftMs;
  if (el < 0) return { i: -1, el };
  const i = work.segs.findIndex((s) => el < s.end * 1000);
  return { i: i < 0 ? work.segs.length - 1 : i, el };
}

// Tam ekran sayaç ve set satırındaki düğme birlikte güncellenir. Büyük sayı bulunulan bölümün kalan süresidir,
// çubuk ve set satırındaki düğme bütün setin.
function workRender() {
  const leftMs = workLeftMs();
  const left = Math.ceil(leftMs / 1000);
  const { i, el } = workSegment(leftMs);
  const prep = i < 0;
  const seg = work.segs[i];
  const b = work.btn;
  if (b?.isConnected) {
    b.textContent = prep ? `Hazır ${left - work.total}` : `■ ${fmtTime(left)}`;
    b.classList.add("is-running");
    b.setAttribute("aria-pressed", "true");
  }
  $("workScreen").dataset.phase = work.paused ? "paused" : prep || seg.change ? "prep" : "work";
  $("workPhase").textContent = work.paused ? "Duraklatıldı" : prep ? "Hazırlan" : seg.change ? "Taraf değiştir"
    : seg.side ? `Çalış · ${seg.side}. taraf` : "Çalış";
  $("workTime").textContent = prep ? String(left - work.total) : fmtTime(Math.ceil((seg.end * 1000 - el) / 1000));
  const frac = prep ? 0 : el / (work.total * 1000);
  $("workBar").style.transform = `scaleX(${Math.min(1, Math.max(0, frac))})`;
  $("workPause").textContent = work.paused ? "Devam" : "Duraklat";
}

// Kart yeniden çizildiğinde çalışan sayaç yeni düğmeye bağlanır.
function workBind(key, timing, btn, chk) {
  if (work.key !== key) { workIdle(btn, timing); return; }
  work.btn = btn;
  work.chk = chk;
  workRender();
}

// Set düğmesi tam ekran sayacı açar; çalışırken aynı düğmeye dokunmak iptal eder.
// Müzik bu dokunuşla başlar (iOS yalnızca kullanıcı dokunuşuyla ses başlatmaya izin verir).
function workToggle(key, timing, btn, chk, done, info) {
  const same = work.key === key;
  workCancel();
  if (same) return;
  audioUnlock();
  Object.assign(work, {
    key, timing, total: timing.total, segs: segmentsOf(timing), segIdx: -1, btn, chk, done, paused: false, lastBeep: null,
    endAt: Date.now() + (WORK_PREP + timing.total) * 1000, kind: info.kind, track: info.track
  });
  $("workName").textContent = info.name;
  $("workSet").textContent = info.set;
  $("workHint").textContent = timing.estimated
    ? `Tahmini süre: ${timing.reps} tekrar${timing.sides > 1 ? " her tarafta" : ""} × ~${timing.perRep} sn. Erken biterse “Seti bitir”e dokun.`
    : timing.sides > 1 ? `Her taraf ${fmtTime(timing.seg)}, arada ${SIDE_SWITCH} sn geçiş.` : "";
  $("workHint").hidden = !$("workHint").textContent;
  $("workExtend").hidden = !timing.estimated;
  openModal($("workScreen"), { close: workCancel, focus: $("workPause"), returnFocus: btn });
  work.iv = setInterval(workTick, 250);
  keepAwake("work", true);
  musicStart(work.kind, work.track);
  workRender();
}

function workTick() {
  if (!work.key || work.paused) return;
  const leftMs = work.endAt - Date.now();
  if (leftMs <= 0) { workFinish(); return; }
  const { i, el } = workSegment(leftMs);
  if (i >= 0) {
    const seg = work.segs[i];
    if (i !== work.segIdx) {
      work.segIdx = i;
      if (seg.change) { beep(2); announce("Taraf değiştir."); }
      else { beep(1); announce(seg.side === 2 ? "Diğer taraf, başla." : "Başla."); }
    } else if (!seg.change) {
      const segLeft = Math.ceil((seg.end * 1000 - el) / 1000);
      if (segLeft <= 3 && segLeft !== work.lastBeep) { work.lastBeep = segLeft; beep(1, 0.08); } // bölümün son 3 sn'si
    }
  }
  workRender();
}

function workPauseToggle() {
  if (!work.key) return;
  if (work.paused) {
    work.endAt = Date.now() + work.leftMs;
    work.paused = false;
    work.iv = setInterval(workTick, 250);
    musicResume();
  } else {
    work.leftMs = work.endAt - Date.now();
    work.paused = true;
    clearInterval(work.iv);
    musicPause();
  }
  workRender();
}

// Tahmini sette süre yetmediyse son bölüm uzatılır.
function workExtend() {
  if (!work.key) return;
  work.total += WORK_EXTEND;
  work.segs[work.segs.length - 1].end += WORK_EXTEND;
  if (work.paused) work.leftMs += WORK_EXTEND * 1000; else work.endAt += WORK_EXTEND * 1000;
  work.lastBeep = null;
  announce(`${WORK_EXTEND} saniye eklendi.`);
  workRender();
}

function workCancel() {
  clearInterval(work.iv);
  musicStop();
  if (work.btn) workIdle(work.btn, work.timing);
  const focusBack = work.btn?.isConnected ? work.btn : null;
  Object.assign(work, { key: null, iv: null, btn: null, chk: null, done: null, paused: false });
  closeModal($("workScreen"), focusBack);
  keepAwake("work", false);
}

function initWork() {
  $("workPause").addEventListener("click", workPauseToggle);
  $("workFinish").addEventListener("click", () => workFinish(true));
  $("workExtend").addEventListener("click", workExtend);
  $("workStop").addEventListener("click", workCancel);
  initMusic();
}

// early: kullanıcı "Seti bitir"e bastı (tahmini süre dolmadan).
function workFinish(early = false) {
  if (!work.key) return;
  const { chk, done } = work;
  musicStop({ fade: !early });
  workCancel();
  announce(early ? "Set tamamlandı." : "Süre doldu, set tamamlandı.");
  if (!early) {
    beep(3);
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch { /* desteklenmiyor */ }
  }
  // Ekrandaki ✓ düğmesine basılmış gibi: kayıt, otomatik dinlenme ve sonraki harekete geçiş aynı yoldan.
  if (chk?.isConnected) { if (chk.getAttribute("aria-checked") !== "true") chk.click(); }
  else done?.();
}

/* ============================================================
   ANTRENMAN MÜZİĞİ
   Sabit liste: Kevin MacLeod (incompetech.com), CC BY 4.0. Dosyalar public/music/ altında.
   Her hareket türüne göre bir listeye atanır; hareketin kendi parçası adından seçilir, liste sırayla
   ve döngüyle çalar. Parçaların kaldığı yer hatırlanır; arka arkaya setlerde müzik baştan başlamaz.
   ============================================================ */

const MUSIC = {
  power: { label: "Kuvvet", tracks: ["volatile-reaction", "fearless-first", "exit-the-premises"] },
  cardio: { label: "Kardiyo", tracks: ["raving-energy", "funkorama", "chill-wave", "wallpaper"] },
  steady: { label: "Tempo", tracks: ["movement-proposition", "electrodoodle", "brain-dance"] },
  calm: { label: "Esneme", tracks: ["meditation-impromptu-01", "dreamer", "deliberate-thought"] }
};
const TRACK_TITLES = {
  "volatile-reaction": "Volatile Reaction", "fearless-first": "Fearless First", "exit-the-premises": "Exit the Premises",
  "raving-energy": "Raving Energy", funkorama: "Funkorama", "chill-wave": "Chill Wave", wallpaper: "Wallpaper",
  "movement-proposition": "Movement Proposition", electrodoodle: "Electrodoodle", "brain-dance": "Brain Dance",
  "meditation-impromptu-01": "Meditation Impromptu 01", dreamer: "Dreamer", "deliberate-thought": "Deliberate Thought"
};
const MUSIC_ARTIST = "Kevin MacLeod";
const CALM_RE = /stretch|esne|germe|mobil|chin (tuck|nod)|open book|thoracic|nefes|breath/;

// Hareket türü: uzun ve sürekli (≥ 5 dk) → kardiyo, esneme/mobilite → sakin, salonda ağırlıklı → kuvvet,
// geri kalan (vücut ağırlığı, core, denge) → tempo.
function musicKind(item, lib, timing) {
  if (lib.cardio || timing.total >= 300) return "cardio";
  if (CALM_RE.test(`${item.name || ""} ${lib.name || ""} ${lib.purpose || ""}`.toLocaleLowerCase("tr"))) return "calm";
  return lib.weight ? "power" : "steady";
}

// Aynı hareket her zaman aynı parçayla başlar.
function musicTrackFor(exId, kind) {
  let n = 0;
  for (const c of String(exId)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % MUSIC[kind].tracks.length;
}

const music = {
  el: null, on: lsGet("postur-music") !== "0", kind: null, idx: 0, pos: {}, playing: false, fadeIv: null, failed: false
};
const musicId = () => (music.kind ? MUSIC[music.kind].tracks[music.idx] : null);

function musicEl() {
  if (music.el) return music.el;
  const a = new Audio();
  a.preload = "none";
  a.addEventListener("ended", () => {
    music.pos[musicId()] = 0;
    music.idx = (music.idx + 1) % MUSIC[music.kind].tracks.length;
    if (music.playing) { musicLoad(); musicPlay(); }
  });
  a.addEventListener("error", () => { if (music.playing) musicFailed(); });
  // Ekran kilitliyken zamanlayıcı yavaşlayabilir; müzik çalıyorsa onun olaylarıyla da süre kontrol edilir.
  a.addEventListener("timeupdate", () => { if (work.key && !work.paused) workTick(); });
  music.el = a;
  return a;
}

function musicLoad() {
  const a = musicEl();
  const id = musicId();
  const src = `music/${id}.m4a`;
  if (!a.src.endsWith(src)) a.src = src;
  const at = music.pos[id] || 0;
  if (a.readyState >= 1) a.currentTime = at;
  else if (at) a.addEventListener("loadedmetadata", () => { if (musicId() === id) a.currentTime = at; }, { once: true });
  musicRender();
  if ("mediaSession" in navigator && window.MediaMetadata) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: TRACK_TITLES[id], artist: MUSIC_ARTIST, album: "Postür & Spor" });
    } catch { /* desteklenmiyor */ }
  }
}

function musicPlay() {
  const a = musicEl();
  clearInterval(music.fadeIv);
  a.volume = 1;
  music.failed = false;
  const p = a.play();
  p?.catch((err) => { if (err?.name !== "AbortError" && music.playing) musicFailed(); });
  musicRender();
}

function musicFailed() {
  music.failed = true;
  musicRender();
}

// Set başında çağrılır. Aynı türde art arda setlerde kalan parçadan devam edilir.
function musicStart(kind, track) {
  if (!kind) return;
  if (music.kind !== kind) { music.kind = kind; music.idx = track; }
  if (!music.on) { musicRender(); return; }
  music.playing = true;
  musicLoad();
  musicPlay();
}

function musicSavePos() {
  const a = music.el, id = musicId();
  if (!a || !id) return;
  music.pos[id] = a.duration && a.currentTime > a.duration - 5 ? 0 : a.currentTime;
}

function musicPause() {
  if (!music.playing || !music.el) return;
  music.el.pause();
  musicSavePos();
}

function musicResume() {
  if (!music.playing) return;
  musicPlay();
}

// Set bitince müzik kısılarak durur (iOS ses düzeyini değiştirmeye izin vermez; orada kısa beklemeyle durur).
function musicStop({ fade = false } = {}) {
  if (!music.playing) return;
  music.playing = false;
  const a = music.el;
  if (!a) return;
  musicSavePos();
  clearInterval(music.fadeIv);
  if (!fade || a.paused) { a.pause(); musicRender(); return; }
  const start = a.volume;
  let step = 0;
  music.fadeIv = setInterval(() => {
    step++;
    try { a.volume = Math.max(0, start * (1 - step / 8)); } catch { /* salt okunur */ }
    if (step >= 8) { clearInterval(music.fadeIv); a.pause(); a.volume = 1; }
  }, 75);
  musicRender();
}

// Tam ekran sayaçtaki müzik satırı ve düğmesi.
function musicRender() {
  const btn = $("workMusic");
  const info = $("workTrack");
  btn.setAttribute("aria-pressed", String(music.on));
  btn.textContent = music.on ? "Müziği kapat" : "Müziği aç";
  const id = musicId();
  info.textContent = !music.on ? "Müzik kapalı"
    : music.failed ? "Müzik çalınamadı. İnternet bağlantını kontrol et; sayaç devam ediyor."
    : id ? `♪ ${TRACK_TITLES[id]} · ${MUSIC_ARTIST} · ${MUSIC[music.kind].label}` : "";
}

function setMusicOn(on) {
  music.on = on;
  lsSet("postur-music", on ? "1" : "0");
  $("musicOn").checked = on;
  if (!on) musicStop();
  else if (work.key) { music.playing = true; musicLoad(); if (!work.paused) musicPlay(); }
  musicRender();
}

function initMusic() {
  $("musicOn").checked = music.on;
  $("musicOn").addEventListener("change", (e) => setMusicOn(e.target.checked));
  $("workMusic").addEventListener("click", () => setMusicOn(!music.on));
  $("musicList").replaceChildren(...Object.values(MUSIC).map((m) =>
    h("li", null, h("b", { text: `${m.label}: ` }), m.tracks.map((t) => TRACK_TITLES[t]).join(", "))));
  // Kilit ekranı ve kulaklık düğmeleri sayacı da duraklatır/sürdürür.
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler("pause", () => { if (work.key && !work.paused) workPauseToggle(); });
      ms.setActionHandler("play", () => { if (work.key && work.paused) workPauseToggle(); });
    } catch { /* desteklenmiyor */ }
  }
  musicRender();
}

// Bip sesi: AudioContext yalnızca kullanıcı dokunuşuyla açılabilir (iOS), ilk başlatmada hazırlanır.
let audioCtx = null;
function audioUnlock() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
  } catch { audioCtx = null; }
}

function beep(n, len = 0.2) {
  if (!audioCtx) return;
  try {
    for (let k = 0; k < n; k++) {
      const t = audioCtx.currentTime + k * 0.3;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + len + 0.02);
    }
  } catch { /* ses yok */ }
}

// Süreli set sürerken ekran kararmasın (destekleyen tarayıcılarda).
// Süreli set ya da dinlenme sayacı çalışırken ekran kararmasın. Nedenlerden biri sürdükçe kilit tutulur.
let wakeSentinel = null;
const wakeReasons = new Set();
async function keepAwake(reason, on) {
  if (reason) { if (on) wakeReasons.add(reason); else wakeReasons.delete(reason); }
  if (!wakeReasons.size) { wakeSentinel?.release().catch(() => {}); wakeSentinel = null; return; }
  if (wakeSentinel || !navigator.wakeLock) return;
  try {
    const s = await navigator.wakeLock.request("screen");
    if (!wakeReasons.size) { s.release().catch(() => {}); return; }
    wakeSentinel = s;
    s.addEventListener("release", () => { if (wakeSentinel === s) wakeSentinel = null; });
  } catch { /* izin yok / desteklenmiyor */ }
}

/* ============================================================
   MODAL YÖNETİMİ: odak modal içinde kalır, Escape ve arka plana dokunma kapatır,
   kapanınca odak açan öğeye döner. Her modal kendi `close` işleviyle kapanır.
   ============================================================ */

const modalStack = []; // { el, close, returnFocus }

const focusables = (el) => [...el.querySelectorAll(
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select, iframe, [tabindex]:not([tabindex="-1"])'
)].filter((x) => !x.hidden && x.getClientRects().length > 0);

/* Geri tuşu açık modalı kapatır: her modal geçmişe bir kayıt ekler, modal düğmeyle kapanınca o kayıt
   history.back() ile geri alınır. history.back() asenkron olduğundan, bekleyen bir geri dönüş varken açılan
   modalın kaydı geri dönüş tamamlanınca eklenir (yoksa yeni kayıt yanlışlıkla geri alınırdı). */
let backPending = 0;
let closingFromPop = false;
const deferredPush = [];
const afterBackQueue = [];

function pushModalState(m) {
  if (backPending) { deferredPush.push(m); return; }
  history.pushState({ modal: true }, "");
  m.pushed = true;
}

// Bekleyen geri dönüş bittikten sonra çalıştır (adres temizliği gibi).
function afterBack(fn) {
  if (backPending) afterBackQueue.push(fn); else fn();
}

function onPopState() {
  if (backPending) {
    backPending--;
    if (!backPending) {
      afterBackQueue.splice(0).forEach((fn) => fn());
      deferredPush.splice(0).forEach((m) => { if (modalStack.includes(m)) pushModalState(m); });
    }
    return;
  }
  const top = modalStack[modalStack.length - 1];
  if (top?.pushed) {
    top.pushed = false; // kaydı tarayıcı zaten geri aldı
    closingFromPop = true;
    try { top.close(); } finally { closingFromPop = false; }
    return;
  }
  if (state.uid) showView(hashToView(location.hash), { push: false });
}

function openModal(el, { close, focus, returnFocus } = {}) {
  if (modalStack.some((m) => m.el === el)) return;
  const m = { el, close: close || (() => closeModal(el)), returnFocus: returnFocus || document.activeElement, pushed: false };
  modalStack.push(m);
  pushModalState(m);
  el.hidden = false;
  document.body.classList.add("modal-open");
  (focus || focusables(el)[0])?.focus();
}

// returnFocus verilirse kayıtlı öğe yerine ona dönülür (ör. yeniden çizilen set düğmesi).
function closeModal(el, returnFocus) {
  const i = modalStack.findIndex((m) => m.el === el);
  if (i < 0) return;
  const [m] = modalStack.splice(i, 1);
  el.hidden = true;
  if (m.pushed && !closingFromPop) { backPending++; history.back(); }
  if (!modalStack.length) document.body.classList.remove("modal-open");
  const back = returnFocus || m.returnFocus;
  if (back?.isConnected) back.focus({ preventScroll: true });
}

function initModals() {
  document.addEventListener("keydown", (e) => {
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (e.key === "Escape") { e.preventDefault(); top.close(); return; }
    if (e.key !== "Tab") return;
    const list = focusables(top.el);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1];
    if (!top.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Alt sayfa modallarında arka plana dokunmak kapatır (tam ekran sayaçta arka plan yok).
  document.querySelectorAll(".modal").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target !== el) return;
    modalStack.find((m) => m.el === el)?.close();
  }));
}

/* ---------- Radio grupları: ok tuşlarıyla seçim (WAI-ARIA APG) ---------- */

// Grupta yalnızca seçili seçenek Tab ile odaklanır; oklar, Home ve End seçimi değiştirir.
// Seçim grubu yeniden çizebildiği için (Salon/Evde) odak data-rg ile yeni öğede bulunur.
function initRadioKeys() {
  document.addEventListener("keydown", (e) => {
    const radio = e.target.closest?.('[role="radio"]');
    const group = radio?.closest('[role="radiogroup"][data-rg]');
    if (!group) return;
    const list = [...group.querySelectorAll('[role="radio"]')];
    const i = list.indexOf(radio);
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const n = (next + list.length) % list.length;
    const id = group.dataset.rg;
    list[n].click();
    const target = document.querySelector(`[data-rg="${id}"]`)?.querySelectorAll('[role="radio"]')[n];
    target?.focus();
  });
}

/* ---------- Kısa bildirim (toast) ---------- */

let toastTimer = null;
let toastAction = null;

// Bilgi ya da "Geri al" için; 5 sn sonra kendiliğinden kapanır. alert() yerine kullanılır.
function toast(message, { action, onAction, duration = 5000 } = {}) {
  const el = $("toast"), btn = $("toastAction");
  clearTimeout(toastTimer);
  toastAction = onAction || null;
  btn.hidden = !action;
  btn.textContent = action || "";
  el.hidden = false;
  $("toastMsg").textContent = "";
  requestAnimationFrame(() => { $("toastMsg").textContent = message; }); // ekran okuyucu değişikliği duyursun
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastAction = null;
  $("toast").hidden = true;
}

function initToast() {
  $("toastAction").addEventListener("click", () => {
    const fn = toastAction;
    hideToast();
    fn?.();
  });
}

/* ---------- Onay sayfası (confirm() yerine) ---------- */

let confirmResolve = null;

function confirmSheet({ title, text, ok, danger = false }) {
  confirmResolve?.(false);
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text || "";
  $("confirmText").hidden = !text;
  const okBtn = $("confirmOk");
  okBtn.textContent = ok;
  okBtn.className = `btn btn-block ${danger ? "btn-danger" : "btn-primary"}`;
  return new Promise((resolve) => {
    confirmResolve = resolve;
    openModal($("confirmModal"), { close: () => finishConfirm(false), focus: $("confirmCancel") });
  });
}

function finishConfirm(result) {
  const fn = confirmResolve;
  confirmResolve = null;
  closeModal($("confirmModal"));
  fn?.(result);
}

function initConfirm() {
  $("confirmOk").addEventListener("click", () => finishConfirm(true));
  $("confirmCancel").addEventListener("click", () => finishConfirm(false));
}

const LANG_NAMES = { en: "İngilizce", de: "Almanca", es: "İspanyolca", fr: "Fransızca" };

/* ---------- Ayarlar sayfası: görünüm, dinlenme, veriler, hesap ---------- */

function openSettings() {
  $("restInfo").textContent = `Dinlenme süresi şu an ${fmtRest(timer.preset)}. Sayaçtaki ±15 sn ile değiştirebilirsin.`;
  $("accountEmail").textContent = auth?.currentUser?.email ? `Giriş yapılan hesap: ${auth.currentUser.email}` : "";
  $("accountEmail").hidden = !auth?.currentUser?.email;
  refreshProgramSettings();
  if (!exportFile) resetExport();
  const opts = [...document.querySelectorAll("[data-theme-opt]")];
  openModal($("settingsModal"), { focus: opts.find((b) => b.getAttribute("aria-checked") === "true") });
}

const fmtRest = (s) => (s % 60 ? (s >= 60 ? `${Math.floor(s / 60)} dk ${s % 60} sn` : `${s} sn`) : `${s / 60} dk`);

function initSettings() {
  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsClose").addEventListener("click", () => closeModal($("settingsModal")));
  $("exportCsv").addEventListener("click", () => exportWorkouts("csv"));
  $("exportJson").addEventListener("click", () => exportWorkouts("json"));
  $("exportDeliver").addEventListener("click", deliverExport);
  $("exportCancel").addEventListener("click", () => { resetExport(); $("exportCsv").focus(); });
}

/* ---------- Veri dışa aktarma (KVKK veri taşınabilirliği) ---------- */

// Bütün kayıtlar sunucudan okunur; olmazsa cihazdaki son 90 gün aktarılır ve bu söylenir.
async function allWorkouts() {
  try {
    const snap = await getDocs(query(collection(db, "users", state.uid, "workouts"), orderBy("date", "desc")));
    const out = {};
    for (const s of snap.docs) if (isDateKey(s.id)) out[s.id] = normalizeDoc(s.data(), s.id);
    for (const date of pendingDates()) if (state.docs[date]) out[date] = state.docs[date]; // gönderilmemiş yerel kayıt öncelikli
    return { docs: out, partial: false };
  } catch {
    return { docs: state.docs, partial: true };
  }
}

function workoutsCsv(docs) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [["Tarih", "Gün", "Hareket", "Set", "Tamamlandı", "Ağırlık (kg)"].map(q).join(";")];
  for (const d of Object.values(docs).sort((a, b) => (a.date < b.date ? 1 : -1))) {
    for (const e of Object.values(d.exercises).sort((a, b) => a.order - b.order)) {
      e.sets.forEach((s, i) => {
        if (!s.completed && s.weight == null) return;
        rows.push([d.date, dayName(d.date), e.name, i + 1, s.completed ? "Evet" : "Hayır",
          s.weight == null ? "" : String(s.weight).replace(".", ",")].map(q).join(";"));
      });
    }
  }
  return "\uFEFF" + rows.join("\r\n"); // BOM + ";" + ondalık virgül: Türkçe Excel doğru açar
}

/* Dışa aktarma iki aşamalı: önce hazırlanır (gösterge ile), paylaşım penceresi yalnızca kullanıcı
   "Paylaş"a basınca açılır. Böylece pencere beklenmedik anda açılmaz ve iOS'un "kullanıcı dokunuşu"
   şartı (navigator.share) her zaman sağlanır. Paylaşım yoksa (masaüstü) hazırlanınca doğrudan iner. */
let exportFile = null;

function resetExport() {
  exportFile = null;
  $("exportReady").hidden = true;
  $("exportStatus").textContent = "";
  for (const [id, label] of [["exportCsv", "Excel için (CSV)"], ["exportJson", "Yedek (JSON)"]]) {
    $(id).disabled = false;
    $(id).textContent = label;
    $(id).removeAttribute("aria-busy");
  }
}

async function exportWorkouts(format) {
  resetExport();
  const btn = $(format === "csv" ? "exportCsv" : "exportJson");
  $("exportCsv").disabled = $("exportJson").disabled = true;
  btn.textContent = "Hazırlanıyor…";
  btn.setAttribute("aria-busy", "true");
  $("exportStatus").textContent = "Antrenman kayıtların hazırlanıyor…";
  try {
    const { docs, partial } = await allWorkouts();
    const list = Object.values(docs).filter((d) => countSets(d) > 0 || Object.values(d.exercises).some((e) => e.sets.some((s) => s.weight != null)));
    if (!list.length) { resetExport(); $("exportStatus").textContent = "Dışa aktarılacak antrenman kaydı yok."; return; }
    const name = `postur-spor-${ymd(new Date())}.${format}`;
    const body = format === "csv"
      ? workoutsCsv(Object.fromEntries(list.map((d) => [d.date, d])))
      : JSON.stringify({ exportedAt: new Date().toISOString(), workouts: list.map((d) => ({ date: d.date, exercises: Object.values(d.exercises).map(({ touched, ...e }) => e) })) }, null, 2);
    const file = new File([body], name, { type: format === "csv" ? "text/csv" : "application/json" });
    const what = `${list.length} antrenman${partial ? " (çevrimdışı: yalnızca cihazdaki son 90 gün)" : ""}`;
    resetExport();
    if (navigator.canShare?.({ files: [file] })) {
      exportFile = file;
      $("exportStatus").textContent = `${what} hazır: ${name}. Göndermek ya da Dosyalar'a kaydetmek için Paylaş'a dokun.`;
      $("exportReady").hidden = false;
      $("exportDeliver").focus();
    } else {
      downloadFile(file);
      $("exportStatus").textContent = `${what} indirildi: ${name}.`;
    }
  } catch {
    resetExport();
    $("exportStatus").textContent = "Kayıtlar hazırlanamadı. Biraz sonra tekrar dene.";
  }
}

async function deliverExport() {
  const file = exportFile;
  if (!file) return;
  try {
    await navigator.share({ files: [file], title: file.name });
    resetExport();
    $("exportStatus").textContent = `Paylaşıldı: ${file.name}.`;
  } catch (e) {
    if (e?.name === "AbortError") return; // vazgeçti; dosya hazır kalır, yeniden Paylaş'a basabilir
    downloadFile(file);
    resetExport();
    $("exportStatus").textContent = `Paylaşılamadı, indirildi: ${file.name}.`;
  }
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = h("a", { href: url, download: file.name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   YAPAY ZEKÂ İLE PROGRAM
   Kullanıcı kendi yapay zekâ hesabını (ChatGPT, Claude, Gemini…) kullanır: uygulama talimatı hazırlar,
   kullanıcı yapay zekâyla konuşur, son cevabı geri yapıştırır; uygulama doğrular, önizler, onayla yükler.
   Sunucu ya da API anahtarı yoktur. Yarım kalan akış cihazda taslak olarak saklanır (uygulama
   değiştirirken iPhone sayfayı kapatabilir).
   ============================================================ */

const aiDraftKey = () => `postur-ai-${state.uid}`;
const programBackupRef = () => doc(db, "users", state.uid, "settings", "programBackup");
const AI_DRAFT_DAYS = 7;

function aiDraft() {
  try {
    const d = JSON.parse(lsGet(aiDraftKey()));
    if (!d || Date.now() - (d.savedAt || 0) > AI_DRAFT_DAYS * 86400000) return null;
    return { step: [1, 2, 3].includes(d.step) ? d.step : 1, request: String(d.request || ""), output: String(d.output || ""),
      mode: ["modify", "new"].includes(d.mode) ? d.mode : null, savedAt: d.savedAt };
  } catch { return null; }
}

function saveAiDraft(patch) {
  const d = { ...(aiDraft() || { step: 1, request: "", output: "" }), ...patch, savedAt: Date.now() };
  lsSet(aiDraftKey(), JSON.stringify(d));
}

function clearAiDraft() {
  lsDel(aiDraftKey());
}

// Program ekranında yarım kalan akış için kalıcı kart (kaybolan toast'a bırakılmaz).
function aiDraftCard() {
  if (!state.uid) return null;
  const d = aiDraft();
  if (!d || (d.step < 2 && !d.output)) return null;
  return h("div", { class: "card ai-draft", role: "region", "aria-label": "Yarım kalan yapay zekâ programı" },
    h("strong", { text: "Yapay zekâyla hazırladığın program yarım kaldı" }),
    h("span", { class: "muted", text: d.step === 3 ? "Planı yapıştırma adımındaydın." : "Yapay zekâdan son cevabı alıp buraya yapıştırman gerekiyor." }),
    h("div", { class: "settings-row" },
      h("button", { type: "button", class: "btn btn-primary", text: "Devam et", onclick: () => openAi() }),
      h("button", { type: "button", class: "btn btn-ghost", text: "Vazgeç", onclick: () => {
        const prev = aiDraft();
        clearAiDraft();
        renderCurrent();
        toast("Yarım kalan program silindi.", { action: "Geri al", onAction: () => { saveAiDraft(prev); renderCurrent(); } });
      } })
    ));
}

/* ---------- Talimat ---------- */

function exerciseLibrary() {
  const lib = { ...(PROGRAM?.exercises || {}) };
  const rows = Object.entries(lib).map(([k, e]) =>
    `- ${k}: ${e.name}${e.weight ? " (ağırlıklı)" : ""}${e.cardio ? " (kardiyo)" : ""}${exerciseVideos[k] || e.video ? " [videolu]" : ""}`);
  return rows.length ? rows.join("\n") : "(Kütüphane boş; yeni hareketler tanımlayabilirsin.)";
}

const AI_EXAMPLE = {
  name: "Postür ve kuvvet – 3 gün",
  safetyNote: "Ağrı artarsa hareketi bırak. Sürekli ağrıda doktora ya da fizyoterapiste danış.",
  progression: { title: "İlerleme", items: ["Tüm setler rahatsa bir sonraki hafta 2,5 kg ekle."] },
  exercises: {
    gobletSquat: { name: "Goblet squat", weight: true, purpose: "Bacak ve kalça gücü.", form: "Göğüs dik, dizler ayak ucu yönünde.", search: "goblet squat doğru form", alt: "sitToStand" },
    sitToStand: { name: "Sandalyeden kalkış", weight: false, purpose: "Bacak gücü.", form: "Kollar önde, kontrollü otur-kalk.", search: "sandalyeden kalkış egzersizi", alt: "gobletSquat" },
    plank: { name: "Plank", weight: false, purpose: "Gövde dayanıklılığı.", form: "Kalça düz, karın sıkı.", search: "plank doğru form" }
  },
  days: [
    { title: "Tüm vücut A", items: [{ ex: "gobletSquat", key: "a1", sets: 3, reps: "10 tekrar" }, { ex: "plank", key: "a2", sets: 2, reps: "30 sn" }],
      home: { title: "Evde A", items: [{ ex: "sitToStand", key: "h1", sets: 3, reps: "12 tekrar" }, { ex: "plank", key: "h2", sets: 2, reps: "30 sn" }] } },
    { rest: true, title: "Dinlenme", lines: ["20–30 dk tempolu yürüyüş."] },
    "… (toplam 7 gün, Pazartesi'den Pazar'a)"
  ]
};

// Programın talimata girecek hali (uygulamaya özel alanlar olmadan).
function programForPrompt(p) {
  const { id, version, source, createdAt, ...rest } = pickProgram(p);
  return JSON.stringify(rest, null, 2);
}

// mode: "modify" → mevcut program korunur, yalnızca istenen kısımlar değişir; "new" → sıfırdan program.
function buildAiPrompt(request, mode) {
  const req = request.trim();
  const modify = mode === "modify" && PROGRAM;
  const task = modify
    ? `Deneyimli bir antrenörsün. Kişinin MEVCUT haftalık programını isteğine göre DEĞİŞTİRECEKSİN. İstenmeyen kısımlara dokunma: gün başlıkları, hareketler, hareket anahtarları ve "key" değerleri aynen kalsın; yalnızca kişinin istediği kısımları değiştir. Program "Postür & Spor" uygulamasına yüklenecek; bu yüzden sonunda aşağıdaki JSON biçimine tam uymalısın. Türkçe konuş.`
    : `Deneyimli bir antrenörsün. Aşağıdaki kişi için SIFIRDAN yeni bir haftalık spor ve postür programı hazırlayacaksın. Program "Postür & Spor" uygulamasına yüklenecek; bu yüzden sonunda aşağıdaki JSON biçimine tam uymalısın. Türkçe konuş.`;
  const current = modify
    ? `# Mevcut program (bunu temel al; değiştirdiğin kısımlar dışında aynen koru)
\`\`\`json
${programForPrompt(PROGRAM)}
\`\`\``
    : "";
  const flow = modify
    ? `1. İstek açıksa doğrudan değiştir. Belirsizse en fazla 3 kısa soruyu TEK mesajda sor ve cevap bekle; bu aşamada JSON verme.
2. Değişiklik ağrı, sakatlık ya da hastalıkla ilgiliyse riskli ve zorlayıcı hareketlerden kaçın, bunu güvenlik notuna yaz ve doktora ya da fizyoterapiste danışmasını öner. Tıbbi teşhis koyma.
3. Sonunda neyi değiştirdiğini 2–4 kısa maddede yaz ve ardından programın TAMAMINI TEK bir \`\`\`json kod bloğunda ver.
4. Kişi başka değişiklik isterse programın TAMAMINI aynı biçimde yeniden ver.`
    : `1. Önce şunların bilinip bilinmediğini kontrol et: hedef; haftada kaç gün ve seans süresi; deneyim; salon, ev ya da ikisi; ağrı, sakatlık, ameliyat ya da hastalık; yapamadığı ya da sevmediği hareketler. Eksik olanları en fazla 5 kısa soru olarak TEK mesajda sor ve cevap bekle. Bu aşamada JSON verme.
2. Ağrı, sakatlık ya da hastalık varsa riskli ve zorlayıcı hareketlerden kaçın, bunu güvenlik notuna yaz ve doktora ya da fizyoterapiste danışmasını öner. Tıbbi teşhis koyma.
3. Bilgiler tamamlanınca programı hazırla. Cevabın 2–3 cümlelik kısa bir özet ve ardından TEK bir \`\`\`json kod bloğu olsun.
4. Kişi değişiklik isterse programın TAMAMINI aynı biçimde yeniden ver.`;
  return `# Görev
${task}

# Kişinin isteği
${req || (modify ? "(Kişi henüz yazmadı; neyi değiştirmek istediğini sor.)" : "(Kişi bir şey yazmadı; ihtiyaçlarını sorarak öğren.)")}
${current ? `\n${current}\n` : ""}
# Hareket kütüphanesi
Bu hareketlerin uygulamada videosu ve geçmiş kayıtları var. Uygun olanlarda bu anahtarları ve adları AYNEN kullan; gerekiyorsa yeni hareket de ekleyebilirsin.
${exerciseLibrary()}

# Çalışma şekli
${flow}

# JSON biçimi (kesin kurallar)
- Kök: "name" (program adı), "safetyNote" (güvenlik notu), "progression" ({"title", "items": [cümleler]}), "exercises" (hareketler), "days" (tam 7 gün, Pazartesi'den Pazar'a).
- "exercises": anahtar yalnızca harf ve rakam (ör. "gobletSquat"). Her hareket: "name" (Türkçe ad), "weight" (kg ile yapılıyorsa true, değilse false), "purpose" (amaç, 1 cümle), "form" (doğru form, 1 cümle), "search" (YouTube'da Türkçe arama ifadesi); isteğe bağlı "alt" (salon↔ev karşılığı hareketin anahtarı), "cardio": true (kardiyo ise).
- Antrenman günü: {"title", "note" (isteğe bağlı), "items": [{"ex": hareket anahtarı, "key": gün içinde benzersiz kısa kod (ör. "a1"), "sets": 1–10 arası tam sayı, "reps": "10 tekrar" ya da "30 sn", "hint" (isteğe bağlı kısa ipucu)}], "home" (isteğe bağlı, aynı yapıda ekipmansız ev alternatifi)}.
- Dinlenme günü: {"rest": true, "title": "Dinlenme", "lines": ["öneri cümlesi"]}.
- Süreli hareketlerde "reps" "30 sn" ya da "1 dk" biçiminde olsun; uygulama sayacı buna göre açar.
- JSON içinde yorum ya da başka alan olmasın.

# Kısaltılmış örnek (biçimi göstermek içindir; "days" gerçek cevapta tam 7 gün olmalı)
\`\`\`json
${JSON.stringify(AI_EXAMPLE, null, 2)}
\`\`\``;
}

/* ---------- Cevabı çözme ve doğrulama ---------- */

// Metin içinden JSON'u bulur: önce ```json bloğu, yoksa ilk "{" ile son "}" arası.
function extractAiJson(text) {
  const t = String(text || "").trim();
  if (!t) return { errors: ["Önce yapay zekânın son cevabını yapıştır."] };
  const fenced = [...t.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)].map((m) => m[1]).filter((b) => b.includes("{"));
  const src = fenced.length ? fenced[fenced.length - 1] : t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
  if (!src || !src.includes("{")) return { errors: ["Cevapta program (JSON) bulunamadı. Yapay zekâ henüz soru soruyor olabilir; soruları cevaplayıp son cevabı yapıştır."] };
  try { return { obj: JSON.parse(src), errors: [] }; } catch (e) {
    const pos = Number(String(e.message).match(/position (\d+)/)?.[1]);
    const line = Number.isFinite(pos) ? src.slice(0, pos).split("\n").length : null;
    return { errors: [`Program okunamadı${line ? ` (JSON ${line}. satır civarı)` : ""}: cevap eksik kopyalanmış olabilir. Cevabın tamamını kopyalayıp tekrar yapıştır ya da yapay zekâdan "JSON'u eksiksiz yeniden ver" iste.`] };
  }
}

const isStr = (v, max, min = 1) => typeof v === "string" && v.trim().length >= min && v.length <= max;
const optStr = (v, max) => v == null || isStr(v, max, 0);

// Yapay zekâ cevabını uygulamanın program biçimine çevirir; her hatayı yeriyle söyler.
function validateAiProgram(obj) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { errors: ["Cevaptaki JSON bir program nesnesi değil."] };

  const exIn = obj.exercises && typeof obj.exercises === "object" && !Array.isArray(obj.exercises) ? obj.exercises : null;
  if (!exIn) err("exercises", "hareket listesi eksik.");
  const exercises = {};
  for (const [k, e] of Object.entries(exIn || {})) {
    const at = `"${k}" hareketi`;
    if (!/^[A-Za-z0-9]{1,40}$/.test(k)) { err(at, "anahtar yalnızca harf ve rakam olabilir."); continue; }
    if (!e || typeof e !== "object") { err(at, "hareket bilgisi eksik."); continue; }
    if (!isStr(e.name, 80)) { err(at, "\"name\" (ad) eksik ya da çok uzun."); continue; }
    if (!optStr(e.purpose, 300) || !optStr(e.form, 300) || !optStr(e.search, 100)) { err(at, "açıklama alanlarından biri çok uzun."); continue; }
    exercises[k] = {
      name: e.name.trim(), weight: e.weight === true,
      ...(e.purpose ? { purpose: e.purpose } : {}), ...(e.form ? { form: e.form } : {}),
      search: e.search || e.name, ...(e.cardio === true ? { cardio: true } : {}), ...(typeof e.alt === "string" ? { alt: e.alt } : {})
    };
  }
  if (Object.keys(exercises).length > 80) err("exercises", "en fazla 80 hareket olabilir.");

  const lib = PROGRAM?.exercises || {};
  const useEx = (ex) => {
    if (exercises[ex]) return true;
    if (lib[ex]) { exercises[ex] = { ...lib[ex] }; return true; } // kütüphaneden kullanıldı, tanımı eksik verildi
    return false;
  };

  const checkPlan = (plan, where) => {
    if (!plan || typeof plan !== "object") { err(where, "gün bilgisi eksik."); return null; }
    if (plan.rest === true) {
      const lines = Array.isArray(plan.lines) ? plan.lines.filter((l) => isStr(l, 300)).slice(0, 6) : [];
      return { rest: true, title: isStr(plan.title, 80) ? plan.title : "Dinlenme", lines };
    }
    if (!Array.isArray(plan.items) || !plan.items.length) { err(where, "hareket listesi (\"items\") boş; dinlenme günüyse \"rest\": true olmalı."); return null; }
    if (plan.items.length > 15) err(where, "en fazla 15 hareket olabilir.");
    const keys = new Set();
    const items = [];
    plan.items.forEach((it, i) => {
      const at = `${where}, ${i + 1}. hareket`;
      if (!it || typeof it !== "object") { err(at, "bilgi eksik."); return; }
      if (typeof it.ex !== "string" || !useEx(it.ex)) { err(at, `"${it?.ex}" hareketi "exercises" içinde tanımlı değil.`); return; }
      const key = typeof it.key === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(it.key) ? it.key : `k${i + 1}`;
      if (keys.has(key)) { err(at, `"key" (${key}) gün içinde tekrar ediyor.`); return; }
      keys.add(key);
      if (!Number.isInteger(it.sets) || it.sets < 1 || it.sets > 10) { err(at, "\"sets\" 1–10 arası tam sayı olmalı."); return; }
      if (!isStr(String(it.reps ?? ""), 40)) { err(at, "\"reps\" (tekrar ya da süre) eksik."); return; }
      items.push({ ex: it.ex, key, sets: it.sets, reps: String(it.reps),
        ...(isStr(it.hint, 80) ? { hint: it.hint } : {}),
        ...(Number.isInteger(it.duration) && it.duration >= 5 && it.duration <= 3600 ? { duration: it.duration } : {}) });
    });
    return { title: isStr(plan.title, 80) ? plan.title : "Antrenman", ...(isStr(plan.note, 300) ? { note: plan.note } : {}), items };
  };

  const days = [];
  if (!Array.isArray(obj.days) || obj.days.length !== 7) err("days", `tam 7 gün olmalı (cevapta ${Array.isArray(obj.days) ? obj.days.length : 0} var).`);
  else obj.days.forEach((d, i) => {
    const day = checkPlan(d, DAYS[i]);
    if (!day) return;
    if (d.home != null) { const home = checkPlan(d.home, `${DAYS[i]} (ev)`); if (home) day.home = home; }
    days.push(day);
  });

  // alt referansı olmayan harekete gidiyorsa kaldır (uygulamada kırık bağlantı olmasın).
  for (const e of Object.values(exercises)) if (e.alt && !exercises[e.alt]) delete e.alt;
  // Yalnızca kullanılan hareketler kalsın.
  const used = new Set(days.flatMap((d) => [...(d.items || []), ...(d.home?.items || [])].map((it) => it.ex)));
  for (const e of Object.values(exercises)) if (e.alt) used.add(e.alt);
  for (const k of Object.keys(exercises)) if (!used.has(k)) delete exercises[k];

  if (errors.length) return { errors };
  const prog = obj.progression && typeof obj.progression === "object" ? obj.progression : null;
  const program = {
    id: `ai-${ymd(new Date())}`, version: 1, source: "ai", createdAt: new Date().toISOString(),
    name: isStr(obj.name, 80) ? obj.name.trim() : "Yapay zekâ programı",
    ...(isStr(obj.safetyNote, 600) ? { safetyNote: obj.safetyNote.trim() } : {}),
    ...(prog && Array.isArray(prog.items) ? { progression: {
      title: isStr(prog.title, 80) ? prog.title : "İlerleme",
      items: prog.items.filter((t) => isStr(t, 200)).slice(0, 10) } } : {}),
    exercises, days
  };
  if (!days.some((d) => !d.rest)) return { errors: ["Programda hiç antrenman günü yok."] };
  if (!validProgram(program)) return { errors: ["Program uygulamanın biçimine uymuyor."] };
  return { program, errors: [] };
}

/* ---------- Önizleme ---------- */

function aiDiff(next) {
  const names = (p) => new Set(Object.values(p?.exercises || {}).map((e) => e.name));
  const before = names(PROGRAM), after = names(next);
  const added = [...after].filter((n) => !before.has(n)).length;
  const removed = PROGRAM ? [...before].filter((n) => !after.has(n)).length : 0;
  const workDays = next.days.filter((d) => !d.rest).length;
  const homeDays = next.days.filter((d) => d.home && !d.home.rest).length;
  const parts = [`${workDays} antrenman günü, ${7 - workDays} dinlenme`, `${after.size} hareket`];
  if (PROGRAM) parts.push([added && `${added} yeni`, removed && `${removed} çıkarıldı`].filter(Boolean).join(", ") || "hareketler aynı");
  if (homeDays) parts.push(`${homeDays} günde ev alternatifi`);
  return parts.join(" · ");
}

// Değişen günlerin adları (değiştir modunda neyin değiştiğini göstermek için).
function changedDays(next) {
  if (!PROGRAM) return [];
  const plan = (prog, d) => d && [d.rest, d.title, (d.items || []).map((it) => [prog.exercises[it.ex]?.name, it.sets, it.reps])];
  const sig = (prog, d) => d && JSON.stringify([plan(prog, d), plan(prog, d.home)]);
  return DAYS.filter((_, i) => sig(PROGRAM, PROGRAM.days[i]) !== sig(next, next.days[i]));
}

function aiPreview(p) {
  const list = (plan) => plan.rest
    ? h("ul", null, (plan.lines.length ? plan.lines : ["Dinlenme"]).map((l) => h("li", { text: l })))
    : h("ul", null, plan.items.map((it) => h("li", { text: `${p.exercises[it.ex].name} · ${it.sets > 1 ? `${it.sets} × ` : ""}${it.reps}` })));
  return [
    h("div", { class: "ai-summary", text: `${p.name} — ${aiDiff(p)}` }),
    aiMode === "modify" && h("div", { text: changedDays(p).length ? `Değişen günler: ${changedDays(p).join(", ")}` : "Günlerde değişiklik yok; yalnızca notlar ya da açıklamalar değişmiş olabilir." }),
    p.safetyNote && h("div", { class: "ai-safety" }, h("strong", { text: "Güvenlik notu: " }), p.safetyNote),
    ...p.days.map((d, i) => h("div", null,
      h("h4", { text: `${DAYS[i]} · ${d.title}` }), list(d),
      d.home && h("div", { class: "muted", text: `Evde: ${d.home.title}` }), d.home && list(d.home)))
  ];
}

/* ---------- Akış ---------- */

let aiCurrent = null; // doğrulanmış program (yüklemeye hazır)

function aiShowStep(step) {
  saveAiDraft({ step });
  [1, 2, 3].forEach((n) => { $(`aiStep${n}`).hidden = n !== step; });
  $("aiStepLabel").textContent = `Adım ${step}/3`;
  if (step === 1 && !$("aiModeBox").hidden && !aiMode) { aiModeRadios()[0].focus(); return; }
  const focus = { 1: "aiRequest", 2: "aiToPaste", 3: "aiOutput" }[step];
  $(focus)?.focus();
}

/* Değiştir / Yeni seçimi: önceden işaretli gelmez (GOV.UK). Programı olmayan kullanıcıda yalnızca "yeni". */
let aiMode = null;
const aiModeRadios = () => [...document.querySelectorAll("[data-ai-mode]")];

const AI_MODE_TEXT = {
  modify: { label: "Neyi değiştirmek istiyorsun? Kendi cümlelerinle yaz.", placeholder: "Ör. Çarşambayı ev antrenmanı yap, bacak hareketlerini azalt, plank süresini 45 sn'ye çıkar." },
  new: { label: "Hedefin, haftada kaç gün ve kaç dakika, salon mu ev mi, ağrın ya da sakatlığın varsa kendi cümlelerinle yaz. Boş bırakırsan yapay zekâ sorar.",
    placeholder: "Ör. Haftada 3 gün, 45 dakika salonda; boyun ağrım var, duruşumu düzeltmek istiyorum." }
};

function setAiMode(mode, { save = true } = {}) {
  aiMode = mode;
  aiModeRadios().forEach((b, i) => {
    const on = b.dataset.aiMode === mode;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on || (!mode && i === 0) ? 0 : -1; // hiçbiri seçili değilse ilk seçenek Tab ile odaklanır
  });
  const t = AI_MODE_TEXT[mode || "new"];
  $("aiRequestLabel").textContent = t.label;
  $("aiRequest").placeholder = t.placeholder;
  if (mode) $("aiModeError").hidden = true;
  if (save) saveAiDraft({ mode });
}

// Talimat üretmeden önce seçim yapılmış mı; yapılmadıysa uyarı ve odak.
function aiModeReady() {
  if (aiMode) return true;
  $("aiModeError").hidden = false;
  aiModeRadios()[0].focus();
  return false;
}

function openAi() {
  if (!state.uid) return;
  if (!$("settingsModal").hidden) closeModal($("settingsModal"));
  const d = aiDraft() || { step: 1, request: "", output: "", mode: null };
  $("aiModeBox").hidden = !PROGRAM; // değiştirilecek program yoksa seçim de yok
  $("aiModeError").hidden = true;
  setAiMode(PROGRAM ? d.mode : "new", { save: false });
  $("aiRequest").value = d.request;
  $("aiOutput").value = d.output;
  $("aiManual").hidden = true;
  $("aiShare").hidden = !navigator.share;
  aiCurrent = null;
  $("aiError").hidden = true;
  $("aiPreview").hidden = true;
  openModal($("aiModal"), { close: closeAi });
  aiShowStep(d.step);
  if (d.step === 3 && d.output) aiCheck(false);
}

function closeAi() {
  closeModal($("aiModal"));
  renderCurrent(); // yarım kaldıysa "Devam et" kartı görünsün
}

async function aiCopy() {
  if (!aiModeReady()) return;
  const text = buildAiPrompt($("aiRequest").value, aiMode);
  saveAiDraft({ request: $("aiRequest").value });
  try {
    await navigator.clipboard.writeText(text);
    toast("Talimat kopyalandı. Yapay zekâya yapıştır.");
    aiShowStep(2);
  } catch {
    $("aiPromptText").value = text;
    $("aiManual").hidden = false;
    $("aiPromptText").focus();
    $("aiPromptText").select();
  }
}

async function aiShare() {
  if (!aiModeReady()) return;
  const text = buildAiPrompt($("aiRequest").value, aiMode);
  saveAiDraft({ request: $("aiRequest").value });
  try { await navigator.share({ text }); aiShowStep(2); }
  catch (e) { if (e?.name !== "AbortError") aiCopy(); }
}

// show: hata ve önizleme gösterilsin mi (yapıştırırken sessiz, düğmede tam).
function aiCheck(show = true) {
  const text = $("aiOutput").value;
  saveAiDraft({ output: text });
  aiCurrent = null;
  const parsed = extractAiJson(text);
  const res = parsed.errors.length ? parsed : validateAiProgram(parsed.obj);
  const errEl = $("aiError");
  if (res.errors.length) {
    $("aiPreview").hidden = true;
    if (show || !errEl.hidden) {
      errEl.replaceChildren(res.errors.length === 1 ? res.errors[0] : `${res.errors.length} sorun var. Yapay zekâya bunları düzeltmesini söyleyip yeni cevabı yapıştır:`);
      if (res.errors.length > 1) errEl.append(h("ul", null, res.errors.slice(0, 6).map((t) => h("li", { text: t })),
        res.errors.length > 6 && h("li", { text: `… ve ${res.errors.length - 6} sorun daha` })));
      errEl.hidden = false;
    }
    return null;
  }
  errEl.hidden = true;
  aiCurrent = res.program;
  $("aiPreview").replaceChildren(...aiPreview(res.program).filter(Boolean));
  $("aiPreview").hidden = false;
  return res.program;
}

async function writeProgram(program, { backup = true } = {}) {
  if (backup && PROGRAM) await setDoc(programBackupRef(), { program: PROGRAM, savedAt: serverTimestamp() });
  await setDoc(programRef(), { ...program, assignedAt: serverTimestamp() });
  applyProgram(program);
  renderTabs();
  renderCurrent();
}

async function aiLoad() {
  const program = aiCurrent || aiCheck(true);
  if (!program) return;
  const btn = $("aiLoad");
  btn.disabled = true;
  try {
    await writeProgram(program);
    clearAiDraft();
    closeAi();
    toast(`"${program.name}" yüklendi.`, { action: "Geri al", duration: 10000, onAction: () => restorePrevious() });
  } catch {
    $("aiError").replaceChildren("Program kaydedilemedi. İnternet bağlantını kontrol edip tekrar dene.");
    $("aiError").hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// Önceki programla şimdikini yer değiştirir (geri al da aynı işlemle yapılır).
async function restorePrevious() {
  try {
    const snap = await getDoc(programBackupRef());
    const prev = snap.exists() ? snap.data().program : null;
    if (!validProgram(prev)) { toast("Önceki program bulunamadı."); return; }
    await writeProgram(pickProgram(prev));
    toast(`"${PROGRAM.name || "Önceki program"}" geri yüklendi.`, { action: "Geri al", duration: 10000, onAction: () => restorePrevious() });
  } catch {
    toast("Önceki programa dönülemedi. İnternet bağlantını kontrol edip tekrar dene.");
  }
}

async function restoreTemplate() {
  const id = state.assignedTemplate;
  try {
    const snap = id && /^[a-z0-9-]+$/i.test(id) ? await getDoc(doc(db, "templates", id)) : null;
    const tpl = snap?.exists() ? snap.data() : null;
    if (!validProgram(tpl)) { toast("Sana atanmış hazır program bulunamadı."); return; }
    closeModal($("settingsModal"));
    await writeProgram(pickProgram(tpl));
    toast("Hazır programa dönüldü.", { action: "Geri al", duration: 10000, onAction: () => restorePrevious() });
  } catch {
    toast("Hazır programa dönülemedi. İnternet bağlantını kontrol edip tekrar dene.");
  }
}

// Ayarlar açılınca Program bölümünü günceller.
async function refreshProgramSettings() {
  const ai = PROGRAM?.source === "ai";
  const when = ai && PROGRAM.createdAt ? ` · ${longDate(ymd(new Date(PROGRAM.createdAt)))}` : "";
  $("programInfo").textContent = PROGRAM
    ? `Şu anki program: ${PROGRAM.name || "Program"}${ai ? ` (yapay zekâyla hazırlandı${when})` : ""}.`
    : state.programState === "loading" ? "Program yükleniyor…" : "Henüz programın yok.";
  $("programTemplate").hidden = !(ai && state.assignedTemplate);
  $("programPrev").hidden = true;
  try { $("programPrev").hidden = !(await getDoc(programBackupRef())).exists(); } catch { /* çevrimdışı */ }
}

function initAi() {
  $("aiOpen").addEventListener("click", openAi);
  $("aiClose").addEventListener("click", closeAi);
  $("aiCopy").addEventListener("click", aiCopy);
  $("aiCopyAgain").addEventListener("click", aiCopy);
  $("aiShare").addEventListener("click", aiShare);
  $("aiToPaste").addEventListener("click", () => aiShowStep(3));
  $("aiBack2").addEventListener("click", () => aiShowStep(1));
  $("aiBack3").addEventListener("click", () => aiShowStep(2));
  $("aiLoad").addEventListener("click", aiLoad);
  aiModeRadios().forEach((b) => b.addEventListener("click", () => setAiMode(b.dataset.aiMode)));
  let t = null;
  $("aiRequest").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => saveAiDraft({ request: $("aiRequest").value }), 300); });
  $("aiOutput").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => aiCheck(false), 300); });
  $("programPrev").addEventListener("click", () => { closeModal($("settingsModal")); restorePrevious(); });
  $("programTemplate").addEventListener("click", restoreTemplate);
}

/* ---------- Görünüm (tema) seçimi ---------- */

// "system" telefonun ayarını izler; "light" / "dark" <html data-theme> ile ezer (CSS'te iki blok).
// Seçim cihaza özeldir (localStorage). İlk boyamadaki uygulama index.html'deki satır içi betikte.
const THEME_COLORS = { light: "#f5f7fb", dark: "#000000" };

function currentTheme() {
  const t = lsGet("postur-theme");
  return t === "light" || t === "dark" ? t : "system";
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme; else root.dataset.theme = theme;
  // Durum çubuğu rengi: seçim varsa iki meta da ona, yoksa her biri kendi media sorgusuna göre.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const own = m.media.includes("dark") ? "dark" : "light";
    m.content = THEME_COLORS[theme === "system" ? own : theme];
  });
  document.querySelectorAll("[data-theme-opt]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.themeOpt === theme));
    b.tabIndex = b.dataset.themeOpt === theme ? 0 : -1;
  });
}

function setTheme(theme) {
  if (theme === "system") lsDel("postur-theme"); else lsSet("postur-theme", theme);
  applyTheme(theme);
  if (state.uid) renderCurrent(); // video yer tutucusu gibi JS'te üretilen renkler yenilensin
}

function initTheme() {
  applyTheme(currentTheme());
  document.querySelectorAll("[data-theme-opt]").forEach((b) =>
    b.addEventListener("click", () => setTheme(b.dataset.themeOpt)));
  // Sistem modunda telefon temayı değiştirince JS'te üretilen renkler de yenilensin.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (currentTheme() === "system" && state.uid) renderCurrent();
  });
}

/* ============================================================
   VİDEO MODALI (iframe yalnızca kullanıcı tıklayınca oluşturulur)
   ============================================================ */

function openVideo(id, title, trigger, start = 0) {
  $("videoTitle").textContent = title;
  $("videoLink").href = ytWatch(id, start);
  const iframe = h("iframe", {
    // playsinline=0: iPhone'da video oynamaya başlayınca iOS'un kendi tam ekran oynatıcısında açılır.
    // enablejsapi: diğer cihazlarda oynatma olayını dinleyip tam ekrana geçmek için (fullscreenOnPlay).
    src: `https://www.youtube.com/embed/${encodeURIComponent(id)}?playsinline=0&rel=0&autoplay=1&mute=1` +
      `&enablejsapi=1&origin=${encodeURIComponent(location.origin)}${start > 0 ? `&start=${start}` : ""}`,
    title, allow: "accelerometer; autoplay; encrypted-media; fullscreen; gyroscope; picture-in-picture",
    allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin"
  });
  $("videoFrame").replaceChildren(iframe);
  openModal($("videoModal"), { close: closeVideo, focus: $("videoClose"), returnFocus: trigger });
  fullscreenOnPlay(iframe);
}

// YouTube IFrame API yalnızca oynatma olayını dinlemek için kullanılır; ilk popup açılışında yüklenir.
let ytApi = null;
function loadYtApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return ytApi ||= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => { ytApi = null; s.remove(); reject(new Error("YouTube API yüklenemedi")); };
    document.head.append(s);
  });
}

// Video oynamaya başlayınca oynatıcıyı tam ekrana alır (oynatıcıdaki tam ekran düğmesine basılmış gibi).
// Tarayıcı izin vermezse (kullanıcı etkileşimi yok) sonraki oynatmada tekrar dener. iPhone'da Fullscreen API
// yoktur; orada playsinline=0 ile iOS tam ekranı kendisi açar.
function fullscreenOnPlay(iframe) {
  const req = iframe.requestFullscreen || iframe.webkitRequestFullscreen;
  if (!req) return;
  loadYtApi().then((YT) => {
    if (!iframe.isConnected) return;
    let done = false;
    new YT.Player(iframe, { events: { onStateChange: (e) => {
      if (done || e.data !== YT.PlayerState.PLAYING || !iframe.isConnected) return;
      done = true;
      Promise.resolve(req.call(iframe))
        .then(() => screen.orientation?.lock?.("landscape")?.catch(() => {}))
        .catch(() => { done = false; });
    } } });
  }).catch(() => { /* API yüklenemezse video normal oynar */ });
}

function closeVideo() {
  $("videoFrame").replaceChildren(); // iframe'i kaldır (video durur)
  closeModal($("videoModal"));
}

// Video listesi içe aktarma: adresin sonuna #videolar eklenince açılır; JSON yalnızca kullanıcının kendi alanına yazılır.
function openVideoImport() {
  if (!state.uid) return;
  $("importText").value = "";
  $("importPreview").textContent = "";
  showImportErrors([]);
  openModal($("importModal"), { close: closeVideoImport, focus: $("importText") });
}

function closeVideoImport() {
  closeModal($("importModal"));
  // Geri dönüş bitmeden adres değişirse #videolar kaydına dönülünce modal yeniden açılırdı.
  afterBack(() => {
    if (location.hash === "#videolar") history.replaceState(null, "", location.pathname + location.search);
  });
}

// Yapıştırılan metni çözer: { items, errors }. JSON hatasında satır numarası verilir.
function parseImport(text) {
  if (!text.trim()) return { items: {}, errors: [] };
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    const pos = Number(String(e.message).match(/position (\d+)/)?.[1]);
    const line = Number.isFinite(pos) ? text.slice(0, pos).split("\n").length : null;
    return { items: {}, errors: [`JSON okunamadı${line ? ` (${line}. satır civarı)` : ""}: eksik ya da fazla virgül, tırnak veya parantez olabilir.`] };
  }
  const r = checkVideos(obj);
  if (!r.errors.length && !Object.keys(r.items).length) r.errors.push("Listede hiç video yok.");
  return r;
}

// Kaydetmeden önce mevcut listeyle farkı söyler.
function importDiff(items) {
  const cur = exerciseVideos;
  const keys = Object.keys(items);
  const added = keys.filter((k) => !cur[k]).length;
  const changed = keys.filter((k) => cur[k] && (cur[k].id !== items[k].id || cur[k].start !== items[k].start || cur[k].title !== items[k].title)).length;
  const removed = Object.keys(cur).filter((k) => !items[k]).length;
  const parts = [added && `${added} yeni`, changed && `${changed} değişecek`, removed && `${removed} kaldırılacak`].filter(Boolean);
  return `${keys.length} video okundu${parts.length ? `: ${parts.join(", ")}` : ", mevcut listeyle aynı"}.` +
    (removed ? " Listede olmayan hareketlerin videosu silinir." : "");
}

function showImportErrors(errors) {
  const err = $("importError");
  err.hidden = !errors.length;
  err.replaceChildren();
  if (!errors.length) return;
  err.append(errors.length === 1 ? errors[0] : `${errors.length} hata var, düzeltip tekrar dene:`);
  if (errors.length > 1) err.append(h("ul", null, errors.slice(0, 5).map((t) => h("li", { text: t })),
    errors.length > 5 && h("li", { text: `… ve ${errors.length - 5} hata daha` })));
}

let importPreviewTimer = null;
function updateImportPreview() {
  clearTimeout(importPreviewTimer);
  importPreviewTimer = setTimeout(() => {
    const r = parseImport($("importText").value);
    $("importPreview").textContent = !r.errors.length && Object.keys(r.items).length ? importDiff(r.items) : "";
    if (!$("importError").hidden) showImportErrors(r.errors); // hata gösteriliyorsa düzeldikçe güncelle
  }, 300);
}

async function writeVideos(items) {
  await setDoc(videosRef(), { items, updatedAt: serverTimestamp() });
  exerciseVideos = items;
  lsSet(videosCacheKey(), JSON.stringify(items));
  renderCurrent();
}

async function saveVideoImport() {
  const r = parseImport($("importText").value);
  if (!r.errors.length && !Object.keys(r.items).length) r.errors.push("Önce video listesini (JSON) yapıştır.");
  showImportErrors(r.errors);
  if (r.errors.length) return;
  const previous = exerciseVideos;
  $("importSave").disabled = true;
  try {
    await writeVideos(r.items);
    closeVideoImport();
    // Eski liste 10 sn içinde geri yüklenebilir.
    toast(`${Object.keys(r.items).length} video kaydedildi.`, {
      action: "Geri al", duration: 10000,
      onAction: async () => {
        try { await writeVideos(previous); toast("Önceki video listesi geri yüklendi."); }
        catch { toast("Önceki liste geri yüklenemedi. Bağlantını kontrol edip tekrar dene."); }
      }
    });
  } catch {
    showImportErrors(["Liste kaydedilemedi. İnternet bağlantını kontrol edip tekrar dene."]);
  } finally {
    $("importSave").disabled = false;
  }
}

function initVideoImport() {
  $("importCancel").addEventListener("click", closeVideoImport);
  $("importSave").addEventListener("click", saveVideoImport);
  $("importText").addEventListener("input", updateImportPreview);
  window.addEventListener("hashchange", () => { if (location.hash === "#videolar") openVideoImport(); });
}

function initModal() {
  $("videoClose").addEventListener("click", closeVideo);
}

/* ============================================================
   FIREBASE / AUTH / AÇILIŞ
   ============================================================ */

function authMessage(code) {
  switch (code) {
    case "auth/invalid-email": return "E-posta adresi geçerli değil. Yazımını kontrol edip tekrar dene.";
    case "auth/user-disabled": return "Bu hesap devre dışı bırakılmış. Açılması için yöneticiye yaz.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential": return "E-posta ya da şifre hatalı. Kontrol edip tekrar dene.";
    case "auth/too-many-requests": return "Çok fazla deneme yapıldı. Birkaç dakika bekleyip tekrar dene.";
    case "auth/network-request-failed": return "Sunucuya ulaşılamadı. İnternet bağlantını kontrol edip tekrar dene.";
    default: return "Giriş yapılamadı. Biraz sonra tekrar dene.";
  }
}

function showLogin(message) {
  $("splash").hidden = true;
  $("appShell").hidden = true;
  $("loginScreen").hidden = false;
  const err = $("loginError");
  err.hidden = !message;
  err.textContent = message || "";
  if (message) $("loginInfo").hidden = true;
}

async function onSignedIn(user) {
  state.uid = user.uid;
  state.docs = {};
  state.historyLoaded = false;
  state.loading = true;
  state.totalWorkouts = null;
  state.totalDirty = true;
  state.selectedIdx = dayIndex(new Date()); // her açılışta gerçek bugün
  state.loadedToday = ymd(new Date());

  $("splash").hidden = true;
  $("loginScreen").hidden = true;
  $("appShell").hidden = false;
  setStatus("idle");
  refreshConnectionUi();
  renderTabs();
  showView(hashToView(location.hash), { push: false }); // #gecmis / #istatistik ile doğrudan açılabilir

  state.programState = "loading";
  state.assignedTemplate = null;
  PROGRAM = null; EX = {}; PLAN = [];
  await loadHistory();
  await Promise.all([loadProgram(), loadVideos()]);
  restorePending();
  state.initialScroll = true;
  renderTabs();
  renderCurrent();
  if (!state.historyLoaded) loadSingleDay(weekDates()[state.selectedIdx]);
  migrateLegacy(); // beklenmez; arka planda
  if (location.hash === "#videolar") openVideoImport();
}

function onSignedOut() {
  state.uid = null;
  PROGRAM = null; EX = {}; PLAN = [];
  exerciseVideos = {};
  state.programState = "loading";
  state.docs = {};
  Object.values(debounceTimers).forEach(clearTimeout);
  retrySucceeded();
  lastError = false;
  timerReset();
  workCancel();
  [...modalStack].reverse().forEach((m) => m.close());
  hideToast();
  showLogin();
}

function initFirebase() {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    // Çevrimdışı önbellek: bağlantı gelince yazmalar otomatik senkronlanır.
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (err) {
    console.warn("Firestore kalıcı önbellek açılamadı, bellek önbelleği kullanılıyor:", err);
    db = getFirestore(app);
  }
}

function initPasswordToggle() {
  $("pwToggle").addEventListener("click", () => {
    const input = $("loginPassword");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("pwToggle").textContent = show ? "Gizle" : "Göster";
    $("pwToggle").setAttribute("aria-pressed", String(show));
  });
}

// Hesabın var olup olmadığı açık edilmez: sonuç mesajı her durumda aynıdır.
async function sendReset() {
  const email = $("loginEmail").value.trim();
  const info = $("loginInfo");
  info.hidden = true;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    showLogin("Şifre sıfırlama bağlantısı için önce e-posta adresini yaz.");
    $("loginEmail").focus();
    return;
  }
  $("loginError").hidden = true;
  const btn = $("forgotBtn");
  btn.disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    info.textContent = "Bu adrese kayıtlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi. Gelen kutunu ve spam klasörünü kontrol et.";
    info.hidden = false;
  } catch (err) {
    if (err?.code === "auth/user-not-found" || err?.code === "auth/invalid-email") {
      info.textContent = "Bu adrese kayıtlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi. Gelen kutunu ve spam klasörünü kontrol et.";
      info.hidden = false;
    } else {
      showLogin(err?.code === "auth/network-request-failed"
        ? "Bağlantı gönderilemedi. İnternet bağlantını kontrol edip tekrar dene."
        : "Bağlantı gönderilemedi. Biraz sonra tekrar dene.");
    }
  } finally {
    btn.disabled = false;
  }
}

function initLogin() {
  initPasswordToggle();
  $("forgotBtn").addEventListener("click", sendReset);
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!configured) return;
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    if (!email || !password) { showLogin("Giriş için e-posta adresini ve şifreni yaz."); return; }
    const btn = $("loginSubmit");
    btn.disabled = true;
    btn.textContent = "Giriş yapılıyor…";
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email, password);
      $("loginPassword").value = "";
      $("loginPassword").type = "password"; // "Göster" açık kaldıysa bir sonraki girişte gizli başlasın
      $("pwToggle").textContent = "Göster";
      $("pwToggle").setAttribute("aria-pressed", "false");
    } catch (err) {
      showLogin(authMessage(err.code));
    } finally {
      btn.disabled = false;
      btn.textContent = "Giriş yap";
    }
  });
  $("logoutBtn").addEventListener("click", async () => {
    const ok = await confirmSheet({
      title: "Çıkış yapılsın mı?",
      text: "Tekrar girmek için e-posta adresin ve şifren gerekecek.",
      ok: "Çıkış yap", danger: true
    });
    if (!ok) return;
    // Bekleyen (debounce'taki) kayıtlar çıkıştan önce gönderilir; yoksa onSignedOut onları siler.
    await Promise.all(Object.keys(debounceTimers).filter((d) => state.docs[d]).map((d) => saveNow(d)));
    try { await signOut(auth); } catch (err) { console.error(err); toast("Çıkış yapılamadı. Tekrar dene."); }
  });
}

function initNav() {
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // konumu görünüm başına biz tutuyoruz
  window.addEventListener("popstate", onPopState);
}

function initLifecycle() {
  window.addEventListener("online", retryNow);
  $("retryBtn").addEventListener("click", retryNow);
  window.addEventListener("offline", refreshConnectionUi);
  // Uygulama arka plandan dönerken gün değiştiyse yeniden bugüne git.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (timer.running) timerTick();
    if (work.key) workTick();
    keepAwake(); // sekme gizlenince tarayıcı kilidi bırakır; neden sürüyorsa yeniden al
    const today = ymd(new Date());
    if (state.uid && today !== state.loadedToday) {
      state.loadedToday = today;
      state.selectedIdx = dayIndex(new Date());
      renderTabs();
      if (state.view === "program") renderProgram();
    }
  });
  // Sekme kapanırken bekleyen debounce'u hemen gönder.
  window.addEventListener("pagehide", () => {
    Object.keys(debounceTimers).forEach((date) => { if (state.docs[date]) saveNow(date); });
  });
}

// Uygulama kabuğu çevrimdışı açılabilsin (bkz. sw.js). Kayıt başarısızsa uygulama normal çalışır.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("Service worker kaydedilemedi:", err));
  });
}

function boot() {
  registerServiceWorker();
  initLogin();
  initNav();
  initTimer();
  initWork();
  initModals();
  initToast();
  initConfirm();
  initTheme();
  initSettings();
  initAi();
  initRadioKeys();
  initModal();
  initVideoImport();
  initLifecycle();

  if (!configured) {
    showLogin("Firebase yapılandırması eksik. public/firebase-config.js dosyasına firebaseConfig değerlerini yapıştır.");
    $("loginSubmit").disabled = true;
    return;
  }
  try {
    initFirebase();
  } catch (err) {
    console.error(err);
    showLogin("Firebase başlatılamadı. firebase-config.js değerlerini kontrol et.");
    return;
  }
  onAuthStateChanged(auth, (user) => {
    if (user) onSignedIn(user);
    else onSignedOut();
  });
}

boot();
