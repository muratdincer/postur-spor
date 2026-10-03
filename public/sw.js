// Service worker: uygulama internet yokken de açılsın diye kabuk dosyalarını (HTML, CSS, JS, ikonlar)
// ve Firebase SDK modüllerini önbellekte tutar. Veri (Firestore/Auth istekleri) burada ele alınmaz;
// onu Firestore'un kendi çevrimdışı önbelleği ve cihazdaki bekleyen kayıtlar yönetir.
//
// Strateji:
// - Uygulama kabuğu (aynı origin): önce ağ, ağ yoksa ya da 3 sn içinde yanıt gelmezse önbellek.
//   Böylece bağlantı varken her açılışta en son yayın gelir (firebase.json no-cache ile uyumlu).
//   Sayfa önbellekten açıldıysa o sayfanın CSS/JS dosyaları da beklemeden önbellekten gelir:
//   3 sn'lik bekleme dosya zincirinde (index → app.js → firebase-config.js) tekrarlanmaz ve
//   eski HTML ile yeni JS karışmaz.
// - Firebase SDK (gstatic, sürüm adreste sabit): önce önbellek; sürüm değişince adres de değişir.

const CACHE = "postur-v1";
const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/firebase-config.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  `${SDK}firebase-app.js`,
  `${SDK}firebase-auth.js`,
  `${SDK}firebase-firestore.js`
];
const NETWORK_TIMEOUT_MS = 3000;

// Önbellekten açılan sayfaların (client) kimlikleri. SW kapanıp açılınca boşalabilir; o durumda
// alt dosyalar yine ağ öncelikli (süre aşımlı) yoldan gelir.
const cacheClients = new Set();

self.addEventListener("install", (event) => {
  // cache: "reload" → HTTP önbelleğini atlayıp sunucudaki güncel dosyayı al.
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("postur-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.href.startsWith(SDK)) {
    event.respondWith(cacheFirst(req));
  } else if (url.origin === self.location.origin && !url.pathname.startsWith("/__/") && !url.pathname.startsWith("/music/")) {
    // /__/ Firebase Hosting'in ayrılmış adresleri (auth yardımcıları vb.); dokunulmaz.
    // /music/ ses dosyaları tarayıcının kendi yolundan (HTTP önbelleği) gelir: iOS ses için parça parça
    // (Range) istek yapar, önbellekten verilen tam yanıtı çalmayabilir.
    event.respondWith(shell(event));
  }
  // Diğer her şey (Firestore, Auth, YouTube, müzik) tarayıcının normal yolundan gider.
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function shell(event) {
  const req = event.request;
  const nav = req.mode === "navigate";
  const cache = await caches.open(CACHE);
  // Sayfa açılışı her zaman kabuğun kendisine düşer (ör. /#videolar, /?kaynak=x).
  const key = nav ? "/index.html" : req;
  const cached = await cache.match(key, { ignoreSearch: nav });

  if (!nav && cached && cacheClients.has(event.clientId)) return cached;

  const network = fetch(req).then((res) => {
    if (res.ok && res.type === "basic") cache.put(key, res.clone());
    return res;
  });
  event.waitUntil(network.then(() => {}, () => {})); // geç gelen yanıt da önbelleğe yazılabilsin
  if (!cached) return network;
  // Zayıf bağlantıda (spor salonu) beklememek için süre aşımında önbellekteki sürüm verilir.
  // Ağ yanıtı geç gelse de önbelleğe yazılır; sonraki açılış güncel olur.
  const fromCache = () => {
    if (nav && event.resultingClientId) cacheClients.add(event.resultingClientId);
    return cached;
  };
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), NETWORK_TIMEOUT_MS));
  const winner = await Promise.race([network.catch(() => "error"), timeout]);
  if (winner === "timeout" || winner === "error") return fromCache();
  if (nav) cacheClients.delete(event.resultingClientId);
  return winner;
}
