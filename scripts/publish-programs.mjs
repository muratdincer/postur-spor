// programs/*.json → Firestore. Şablonlar templates/{id}, atamalar config/assignments dokümanına yazılır.
// Repo public olduğundan şablonlar ve UID içeren atamalar normalde repoda durmaz (kaynak Firestore); bu betik
// yalnızca programs/ klasörüne geçici olarak dosya eklendiğinde bir şey yazar. Olmayan dosyaya karşılık gelen
// Firestore dokümanına dokunmaz.
// Hosting'e çıkmazlar; yalnızca giriş yapmış kullanıcı okuyabilir (firestore.rules). Admin SDK kuralları aşar.
// Kimlik: GOOGLE_APPLICATION_CREDENTIALS (deploy workflow'undaki servis hesabı, "Cloud Datastore User" rolü gerekir).
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, readFileSync, readdirSync } from "node:fs";

initializeApp({ credential: applicationDefault(), projectId: "postur-spor" });
const db = getFirestore();
const dir = new URL("../programs/", import.meta.url);
if (!existsSync(dir)) { console.log("programs/ yok; yayınlanacak bir şey yok"); process.exit(0); }

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const data = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
  if (file === "assignments.json") {
    await db.doc("config/assignments").set(data);
    console.log("config/assignments yazıldı");
    continue;
  }
  const id = file.slice(0, -".json".length);
  if (data.id !== id) throw new Error(`${file}: "id" alanı dosya adıyla aynı olmalı (${data.id})`);
  await db.doc(`templates/${id}`).set(data);
  console.log(`templates/${id} yazıldı (sürüm ${data.version ?? "-"})`);
}
