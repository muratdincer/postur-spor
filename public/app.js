import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  onAuthStateChanged, signInWithEmailAndPassword, signOut
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
// config/assignments (repo: programs/assignments.json, deploy workflow'u yazar). Yalnızca atanmış kullanıcı şablonu okur.
// EX: hareket kütüphanesi (weight: true → kg alanı, video: YouTube ID, alt: salon↔ev karşılığı),
// PLAN: Pazartesi..Pazar 7 gün; her günün salon programı kendisi, ev alternatifi `home` alanıdır.
let PROGRAM = null;
let EX = {};
let PLAN = [];

// Hareket videoları tek yerde: hareket kimliği → YouTube videosu. Program şablonundaki `video` alanı yalnızca
// burada karşılığı olmayan hareketler için yedek olarak kullanılır. Yeni ID eklemeden önce oEmbed ile doğrula
// (https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=ID&format=json); uydurma ID ekleme.
// `start`: videonun başlayacağı saniye (popup embed'i ve "YouTube'da aç" linki bu saniyeden açılır).
const exerciseVideos = {
  chinTuck: { id: "0tWxFbOHvRo", title: "Boyun düzleşmesinde kullanılan Chin Tuck egzersizi", channel: "Fizyoterapist Oğuz Özdemir", language: "tr" },
  row: { id: "u3Yg9h0WZRY", title: "Dumbbell Incline Row Nasıl Yapılır", channel: "Gel Gel Hoca", language: "tr" },
  lat: { id: "QDsllbOkwEs", title: "V-Bar Lat Pulldown Nasıl Yapılır", channel: "Gel Gel Hoca", language: "tr" },
  reversePec: { id: "iklaLgWUgMs", title: "Machine Reverse Fly Nasıl Yapılır", channel: "MACFit", language: "tr" },
  legPress: { id: "uVwrVUXBPec", title: "Leg Press Nasıl Yapılır", channel: "Cenk Hoca", language: "tr" },
  legCurl: { id: "-xnlcqQCBC4", title: "Machine Seated Leg Curl Nasıl Yapılır", channel: "MACFit", language: "tr" },
  hipThrust: { id: "D040DUMZuUs", title: "Hip Thrust Egzersizi Nasıl Yapılır? | Adım Adım Doğru Teknik", channel: "Egzersiz Rehberim - Ege Berk BÜYÜKSU", language: "tr" },
  pallof: { id: "_2xWmYNnFS8", title: "Pallof press", channel: null, language: null },
  openBook: { id: "OW6YHlxY6JI", title: "Open book", channel: null, language: null },
  thoracic: { id: "9Y11Kc0E0og", title: "Foam roller thoracic extension", channel: null, language: null },
  pecStretch: { id: "M850sCj9LHQ", title: "Doorway pec stretch", channel: null, language: null },
  hipFlexor: { id: "qWMXPKLFF2A", title: "Half-kneeling hip-flexor stretch", channel: null, language: null },
  deadBug: { id: "kGyhUpnw70E", title: "Dead Bug Egzersizi Nasıl Yapılır? (Core Bölgeni Güçlendir)", channel: "Egzersiz Rehberim - Ege Berk BÜYÜKSU", language: "tr" },
  birdDog: { id: "VSvp8iEoLC8", title: "Bird Dog Egzersizi Nasıl Yapılır? (Core Stabilizasyonu & Bel Sağlığı)", channel: "Egzersiz Rehberim - Ege Berk BÜYÜKSU", language: "tr" },
  chestPress: { id: "2wFMkurVmrQ", title: "Machine Chest Press Nasıl Yapılır?", channel: "MACFit", language: "tr" },
  extRot: { id: "LpNgc6Vx4iY", title: "Cable external rotation", channel: null, language: null },
  sidePlank: { id: "lvpPNjRQONQ", title: "Side plank (dizler yerde)", channel: null, language: null },
  // Ev hareketleri
  snowAngel: { id: "KEF6yQ8b4F8", title: "Reverse Snow Angel Nasıl Yapılır?", channel: "MACFit", language: "tr" },
  wallSlide: { id: "Zz7-2Ya3iu8", title: "Wall Slide Egzersizi – Omuz ve Gövde Mobilizasyonu", channel: "Fizyoterapi Rehberi / Onur Kırcaoğlu", language: "tr" },
  heelDigBridge: { id: "mUjc48MBKRk", title: "Hip-Hamstring Bridge Nasıl Yapılır? | Kalça ve Arka Bacak Güçlendirme", channel: "Egzersiz Rehberim - Ege Berk BÜYÜKSU", language: "tr" },
  gluteBridge: { id: "R73ClX1LpAI", title: "Glute Bridge / Hamstring Bridge doğru form", channel: "Egzersiz Rehberim - Ege Berk BÜYÜKSU", language: "tr" },
  wallPushUp: { id: "p9JDV4YxSBw", title: "Wall Push Up Nasıl Yapılır?", channel: "hegesports", language: "tr" }
};

// Merkezi mapping önce, şablondaki `video` yedek. { id, start, title } döner; video yoksa null.
function videoFor(exId) {
  const v = exerciseVideos[exId];
  if (v?.id) return { id: v.id, start: v.start || 0, title: v.language === "tr" ? v.title : null };
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

function parseWeight(str) {
  const n = parseFloat(String(str).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 1000);
}
const fmtKg = (w) => `${String(w).replace(".", ",")} kg`;

const ytWatch = (id, start = 0) => `https://www.youtube.com/watch?v=${id}${start > 0 ? `&t=${start}s` : ""}`;
const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const ytSearch = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

function placeholderImg(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#dfe9f5"/>` +
    `<g fill="none" stroke="#2563eb" stroke-width="6" stroke-linecap="round"><path d="M110 90h100M96 70v40M224 70v40M82 80v20M238 80v20"/></g>` +
    `<text x="160" y="146" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#4a5b70">${label.replace(/[<>&"]/g, "")}</text></svg>`;
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
  el.textContent = { saving: "Kaydediliyor...", saved: "Kaydedildi ✓", offline: "Çevrimdışı", idle: "" }[s] || "";
}

function refreshConnectionUi() {
  const offline = !navigator.onLine || lastError;
  $("offlineBanner").hidden = !offline;
  if (offline) setStatus("offline");
  else if (inflight > 0) setStatus("saving");
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
  } catch (err) {
    console.error("Kayıt hatası:", err);
    lastError = true;
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
const PROGRAM_FIELDS = ["id", "version", "name", "safetyNote", "progression", "exercises", "days"];

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

// Program kaynağı Firestore'dur. assignments.json'da kullanıcıya bir şablon atanmışsa ve Firestore'daki
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
      catch { copyBtn.textContent = "Kimliği elle seçip kopyalayın"; }
    }
  });
  return missing
    ? h("div", { class: "card day-head no-program" },
        h("h2", { text: "Program atanmadı" }),
        h("p", { class: "sub", text: "Size henüz kişisel bir program tanımlanmamış. Aşağıdaki kullanıcı kimliğini program hazırlayan kişiye iletin." }),
        uidBox, copyBtn)
    : h("div", { class: "card day-head no-program" },
        h("h2", { text: "Program yüklenemedi" }),
        h("p", { class: "sub", text: "Bağlantıyı kontrol edip sayfayı yenileyin." }));
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

// iOS tarzı SALON | EVDE seçici.
function modeSwitch() {
  const opt = (mode, label) => h("button", {
    type: "button", role: "radio", class: "seg-btn", "aria-checked": String(state.mode === mode),
    text: label, onclick: () => setMode(mode)
  });
  return h("div", { class: "segmented", role: "radiogroup", "aria-label": "Antrenman yeri" },
    opt("gym", "SALON"), opt("home", "EVDE"));
}

function renderProgram() {
  const idx = state.selectedIdx;
  const date = weekDates()[idx];
  const panel = $("dayPanel");
  if (!PROGRAM) {
    panel.replaceChildren(state.programState === "missing" ? noProgramCard()
      : h("div", { class: "card empty", text: "Program yükleniyor…" }));
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
    panel.replaceChildren(head);
    return;
  }
  if (state.loading) {
    panel.replaceChildren(head, h("div", { class: "empty", text: "Kayıtlar yükleniyor…" }));
    return;
  }
  panel.replaceChildren(head, h("div", { class: "view" },
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
  const entry = state.docs[date]?.exercises[item.key];
  const setsData = () => ensureEntry(date, item, order).sets;
  const initial = entry ? entry.sets : Array.from({ length: item.sets }, () => ({ completed: false, weight: null }));
  const last = lib.weight ? lastWeight(item.ex, date) : null;

  const setsBox = h("div", { class: "sets" });

  const drawSets = () => {
    const current = state.docs[date]?.exercises[item.key]?.sets || initial;
    setsBox.replaceChildren(...current.map((s, i) => setRow(i, s)));
  };

  const setRow = (i, s) => {
    const btn = h("button", {
      type: "button", class: "chk", role: "checkbox",
      "aria-pressed": String(!!s.completed), "aria-label": `Set ${i + 1} tamamlandı`, text: "✓"
    });
    let input = null;
    if (lib.weight) {
      input = h("input", {
        type: "text", inputmode: "decimal", pattern: "[0-9]*[.,]?[0-9]*", autocomplete: "off",
        enterkeyhint: "done", placeholder: last != null ? String(last).replace(".", ",") : "0",
        value: s.weight != null ? String(s.weight).replace(".", ",") : "",
        "aria-label": `Set ${i + 1} ağırlık (kg)`
      });
      input.addEventListener("input", () => {
        const e = ensureEntry(date, item, order);
        e.sets[i].weight = parseWeight(input.value);
        e.touched = true;
        scheduleSave(date);
      });
      input.addEventListener("blur", () => { if (debounceTimers[date]) saveNow(date); });
    }
    btn.addEventListener("click", () => {
      const e = ensureEntry(date, item, order);
      const cur = e.sets[i];
      cur.completed = !cur.completed;
      e.touched = true;
      if (cur.completed && cur.weight == null && input && last != null) {
        cur.weight = last; // son ağırlık başlangıç önerisi
        input.value = String(last).replace(".", ",");
      }
      btn.setAttribute("aria-pressed", String(cur.completed));
      saveNow(date);
      if (cur.completed && $("autoTimer").checked) timerStart(90);
      // Yalnızca kullanıcı bir seti işaretleyip hareketin tüm setleri bittiğinde ilerle (geri almada kaydırma yok).
      if (cur.completed && e.sets.every((x) => x.completed)) onExerciseDone(btn.closest(".ex"), date);
      else refreshDayDone(date);
    });
    return h("div", { class: "set-row" },
      h("span", { class: "set-label", text: `Set ${i + 1}` }),
      btn,
      input && h("label", { class: "kg" }, input, h("span", { text: "kg" }))
    );
  };

  drawSets();

  const changeSets = (delta) => {
    const e = ensureEntry(date, item, order);
    const next = e.sets.length + delta;
    if (next < 1 || next > 6) return;
    if (delta > 0) e.sets.push({ completed: false, weight: null });
    else e.sets.pop();
    e.touched = true;
    drawSets();
    saveNow(date);
    refreshDayDone(date);
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
        (altName || (home && !lib.cardio)) && h("div", { class: "ex-tags" },
          home && !lib.cardio && h("span", { class: "tag", text: "Vücut ağırlığı" }),
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
      h("button", { type: "button", class: "btn", text: "⏱ Dinlenme", onclick: () => timerStart() }),
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

function renderHistory() {
  const root = $("viewHistory");
  const list = workoutList();
  if (!list.length) {
    root.replaceChildren(h("div", { class: "card empty", text: "Henüz kayıtlı antrenman yok." }));
    return;
  }
  const shown = list.slice(0, state.historyShown);
  const items = shown.map((d) => {
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
      h("div", null, h("div", { class: "h-date", text: longDate(d.date) }), h("div", { class: "h-day", text: d.day })),
      h("span", { class: "h-count", text: `${countSets(d)} set ›` })
    );
    return h("div", { class: "card h-item" }, toggle, detail);
  });
  if (list.length > shown.length) {
    items.push(h("button", {
      type: "button", class: "btn btn-block", text: "Daha fazla göster",
      onclick: () => { state.historyShown += 30; renderHistory(); }
    }));
  }
  root.replaceChildren(...items);
}

/* ============================================================
   İSTATİSTİK GÖRÜNÜMÜ
   ============================================================ */

function weightSeries() {
  // Programdan bağımsız: kayıtta kg girilmiş her hareket sayılır (program değişse de geçmiş korunur).
  const byEx = {}; // exId -> { name, pts: [{date, max}] }
  const dates = Object.keys(state.docs).sort();
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
  line.setAttribute("stroke", "#2563eb");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.append(line);
  const last = coords[coords.length - 1];
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", last[0]); dot.setAttribute("cy", last[1]); dot.setAttribute("r", "3"); dot.setAttribute("fill", "#2563eb");
  svg.append(dot);
  return svg;
}

function renderStats() {
  const root = $("viewStats");
  const list = workoutList();
  const today = new Date();
  const d7 = ymd(addDays(today, -6));
  const d30 = ymd(addDays(today, -29));
  const c7 = list.filter((d) => d.date >= d7).length;
  const c30 = list.filter((d) => d.date >= d30).length;
  const sets = list.reduce((n, d) => n + countSets(d), 0);
  const total = state.totalWorkouts ?? list.length;

  const tile = (v, l) => h("div", { class: "card tile" }, h("div", { class: "v", text: String(v) }), h("div", { class: "l", text: l }));

  const series = weightSeries();
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
        pts.length >= 2 && sparkline(pts)
      );
    });

  root.replaceChildren(
    h("div", { class: "tiles" },
      tile(c7, "Son 7 gün antrenman"),
      tile(c30, "Son 30 gün antrenman"),
      tile(total, "Toplam antrenman"),
      tile(sets, "Tamamlanan set (son 90 gün)")
    ),
    h("div", { class: "section-title", text: "Ağırlık gelişimi (son 90 gün)" }),
    ...(rows.length ? rows : [h("div", { class: "card empty", text: "Ağırlıklı hareket kaydı yok." })])
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
    if (state.view === "stats") {
      const tiles = $("viewStats").querySelectorAll(".tile .v");
      if (tiles[2]) tiles[2].textContent = String(state.totalWorkouts);
    }
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

function showView(name) {
  state.view = name;
  $("viewProgram").hidden = name !== "program";
  $("viewHistory").hidden = name !== "history";
  $("viewStats").hidden = name !== "stats";
  $("dayTabs").hidden = name !== "program";
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
  renderCurrent();
  window.scrollTo(0, 0);
}

/* ============================================================
   DİNLENME SAYACI
   ============================================================ */

const timer = { preset: 90, remaining: 90, running: false, endAt: 0, iv: null };

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
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch { /* desteklenmiyor */ }
  }
  timerRender();
}

function timerStop() {
  clearInterval(timer.iv);
  timer.iv = null;
  timer.running = false;
}

function timerOpen() {
  $("timer").hidden = false;
  $("timerFab").hidden = true;
}

function timerStart(preset) {
  timerOpen();
  if (preset) { timer.preset = preset; timerStop(); timer.remaining = preset; }
  if (timer.remaining <= 0) timer.remaining = timer.preset;
  timerStop();
  timer.endAt = Date.now() + timer.remaining * 1000;
  timer.running = true;
  timer.iv = setInterval(timerTick, 250);
  timerRender();
}

function timerPause() {
  if (timer.running) timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
  timerStop();
  timerRender();
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
    b.addEventListener("click", () => {
      timer.preset = Number(b.dataset.preset);
      timerReset();
    }));
  $("autoTimer").checked = lsGet("postur-auto-timer") === "1";
  $("autoTimer").addEventListener("change", (e) => lsSet("postur-auto-timer", e.target.checked ? "1" : "0"));
  $("timerFab").hidden = false;
  timerRender();
}

/* ============================================================
   VİDEO MODALI (iframe yalnızca kullanıcı tıklayınca oluşturulur)
   ============================================================ */

let modalReturnFocus = null;

function openVideo(id, title, trigger, start = 0) {
  modalReturnFocus = trigger || null;
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
  $("videoModal").hidden = false;
  document.body.classList.add("modal-open");
  $("videoClose").focus();
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
  $("videoModal").hidden = true;
  document.body.classList.remove("modal-open");
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
}

function initModal() {
  $("videoClose").addEventListener("click", closeVideo);
  $("videoModal").addEventListener("click", (e) => { if (e.target === $("videoModal")) closeVideo(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("videoModal").hidden) closeVideo(); });
}

/* ============================================================
   FIREBASE / AUTH / AÇILIŞ
   ============================================================ */

function authMessage(code) {
  switch (code) {
    case "auth/invalid-email": return "E-posta adresi geçersiz.";
    case "auth/user-disabled": return "Bu hesap devre dışı.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential": return "E-posta veya şifre hatalı.";
    case "auth/too-many-requests": return "Çok fazla deneme. Biraz bekleyip tekrar deneyin.";
    case "auth/network-request-failed": return "Bağlantı hatası. İnternetinizi kontrol edin.";
    default: return "Giriş yapılamadı. Lütfen tekrar deneyin.";
  }
}

function showLogin(message) {
  $("splash").hidden = true;
  $("appShell").hidden = true;
  $("loginScreen").hidden = false;
  const err = $("loginError");
  err.hidden = !message;
  err.textContent = message || "";
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
  showView("program");

  state.programState = "loading";
  PROGRAM = null; EX = {}; PLAN = [];
  await loadHistory();
  await loadProgram();
  restorePending();
  state.initialScroll = true;
  renderTabs();
  renderCurrent();
  if (!state.historyLoaded) loadSingleDay(weekDates()[state.selectedIdx]);
  migrateLegacy(); // beklenmez; arka planda
}

function onSignedOut() {
  state.uid = null;
  PROGRAM = null; EX = {}; PLAN = [];
  state.programState = "loading";
  state.docs = {};
  Object.values(debounceTimers).forEach(clearTimeout);
  timerReset();
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

function initLogin() {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!configured) return;
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    if (!email || !password) { showLogin("E-posta ve şifre girin."); return; }
    const btn = $("loginSubmit");
    btn.disabled = true;
    btn.textContent = "Giriş yapılıyor…";
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email, password);
      $("loginPassword").value = "";
    } catch (err) {
      showLogin(authMessage(err.code));
    } finally {
      btn.disabled = false;
      btn.textContent = "Giriş Yap";
    }
  });
  $("logoutBtn").addEventListener("click", async () => {
    try { await signOut(auth); } catch (err) { console.error(err); }
  });
}

function initNav() {
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
}

function initLifecycle() {
  window.addEventListener("online", () => {
    lastError = false;
    refreshConnectionUi();
    if (!state.uid) return;
    pendingDates().forEach((date) => saveNow(date));
    if (!state.historyLoaded) loadHistory().then(renderCurrent);
    if (state.programState !== "ready") loadProgram().then(renderCurrent);
  });
  window.addEventListener("offline", refreshConnectionUi);
  // Uygulama arka plandan dönerken gün değiştiyse yeniden bugüne git.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (timer.running) timerTick();
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

function boot() {
  initLogin();
  initNav();
  initTimer();
  initModal();
  initLifecycle();

  if (!configured) {
    showLogin("Firebase yapılandırması eksik. public/firebase-config.js dosyasına firebaseConfig değerlerini yapıştırın.");
    $("loginSubmit").disabled = true;
    return;
  }
  try {
    initFirebase();
  } catch (err) {
    console.error(err);
    showLogin("Firebase başlatılamadı. firebase-config.js değerlerini kontrol edin.");
    return;
  }
  onAuthStateChanged(auth, (user) => {
    if (user) onSignedIn(user);
    else onSignedOut();
  });
}

boot();
