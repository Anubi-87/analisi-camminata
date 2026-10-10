// Archivio delle analisi già fatte, salvato nel browser del telefono (IndexedDB).
// Si salvano solo i punti del corpo, mai il video. Se lo stesso video viene
// ricaricato, l'analisi è pronta subito. Ogni errore qui è innocuo: senza
// archivio (navigazione privata, spazio pieno, dati cancellati da Safari) si rianalizza.

const NOME_DB = "analisi-camminata";
const DEPOSITO = "analisi";
const MAX_ANALISI = 30;       // oltre, si cancellano le più vecchie
const BLOCCO_IMPRONTA = 2 * 1024 * 1024;
const PUNTI = 33;

let aperto = null;

function apri() {
  if (!aperto) {
    aperto = new Promise((resolve, reject) => {
      const richiesta = indexedDB.open(NOME_DB, 1);
      richiesta.onupgradeneeded = () => {
        const deposito = richiesta.result.createObjectStore(DEPOSITO, { keyPath: "impronta" });
        deposito.createIndex("data", "data");
      };
      richiesta.onsuccess = () => resolve(richiesta.result);
      richiesta.onerror = () => reject(richiesta.error);
    }).catch((errore) => { aperto = null; throw errore; });
  }
  return aperto;
}

const comeTransazione = (richiesta) => new Promise((resolve, reject) => {
  richiesta.onsuccess = () => resolve(richiesta.result);
  richiesta.onerror = () => reject(richiesta.error);
});

// Impronta del video: dimensione del file + firma dei primi e degli ultimi 2 MB.
// Se il file è identico l'impronta è la stessa, qualunque nome gli dia il telefono.
export async function calcolaImpronta(file) {
  try {
    if (!crypto?.subtle) return null;
    const inizio = await file.slice(0, BLOCCO_IMPRONTA).arrayBuffer();
    const fine = await file.slice(Math.max(0, file.size - BLOCCO_IMPRONTA)).arrayBuffer();
    const insieme = new Uint8Array(inizio.byteLength + fine.byteLength);
    insieme.set(new Uint8Array(inizio), 0);
    insieme.set(new Uint8Array(fine), inizio.byteLength);
    const firma = new Uint8Array(await crypto.subtle.digest("SHA-256", insieme));
    return `${file.size}-${[...firma].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  } catch (errore) {
    console.warn("Impronta del video non calcolabile", errore);
    return null;
  }
}

export async function leggiAnalisi(impronta) {
  if (!impronta) return null;
  try {
    const db = await apri();
    const voce = await comeTransazione(db.transaction(DEPOSITO).objectStore(DEPOSITO).get(impronta));
    return voce ? { ...voce, campioni: espandi(voce.campioni) } : null;
  } catch (errore) {
    console.warn("Archivio non leggibile", errore);
    return null;
  }
}

export async function salvaAnalisi({ impronta, nome, durata, larghezza, altezza, campioni }) {
  if (!impronta) return;
  try {
    const db = await apri();
    const deposito = db.transaction(DEPOSITO, "readwrite").objectStore(DEPOSITO);
    await comeTransazione(deposito.put({
      impronta, nome, durata, larghezza, altezza, data: Date.now(), campioni: comprimi(campioni),
    }));
    await pota(db);
  } catch (errore) {
    console.warn("Analisi non salvata nell'archivio", errore);
  }
}

// Tiene solo le analisi più recenti
async function pota(db) {
  // l'indice "data" restituisce le chiavi dalla più vecchia alla più recente
  const chiavi = await comeTransazione(db.transaction(DEPOSITO).objectStore(DEPOSITO).index("data").getAllKeys());
  const daTogliere = chiavi.slice(0, Math.max(0, chiavi.length - MAX_ANALISI));
  if (!daTogliere.length) return;
  const transazione = db.transaction(DEPOSITO, "readwrite");
  for (const chiave of daTogliere) transazione.objectStore(DEPOSITO).delete(chiave);
  await new Promise((resolve, reject) => {
    transazione.oncomplete = resolve;
    transazione.onerror = () => reject(transazione.error);
  });
}

// Ogni fotogramma diventa 33 × (x, y, z, visibilità) numeri compatti, o null
function comprimi(campioni) {
  return campioni.map((c) => {
    if (!c) return null;
    const numeri = new Float32Array(PUNTI * 4);
    c.punti.forEach((p, k) => numeri.set([p.x, p.y, p.z, p.v], k * 4));
    return numeri;
  });
}

function espandi(dati) {
  return dati.map((numeri) => {
    if (!numeri) return null;
    const punti = [];
    for (let k = 0; k < PUNTI; k++) {
      punti.push({ x: numeri[k * 4], y: numeri[k * 4 + 1], z: numeri[k * 4 + 2], v: numeri[k * 4 + 3] });
    }
    return { punti };
  });
}
