// Riconoscimento del corpo con MediaPipe, fotogramma per fotogramma.
// Lo usano sia la pagina di analisi sia quella di confronto.
import { PoseLandmarker, FilesetResolver } from "./libs/vision_bundle.mjs";

export const ANALISI_FPS = 30; // fotogrammi analizzati per ogni secondo di video
const PERCORSO_WASM = "./libs/wasm";
const PERCORSO_MODELLO = "./libs/modelli/pose_landmarker_full.task";

const motore = { fileset: null, bufferModello: null, delegato: null }; // delegato: "GPU" o "CPU"

export async function preparaRiconoscimento() {
  const [fileset, risposta] = await Promise.all([
    FilesetResolver.forVisionTasks(PERCORSO_WASM),
    fetch(PERCORSO_MODELLO),
  ]);
  if (!risposta.ok) throw new Error(`modello non trovato (${risposta.status})`);
  motore.fileset = fileset;
  motore.bufferModello = new Uint8Array(await risposta.arrayBuffer());
  // Una creazione di prova scopre subito se la scheda grafica funziona
  const prova = await creaRiconoscitore();
  prova.close();
}

async function creaRiconoscitore() {
  const tentativi = motore.delegato ? [motore.delegato] : ["GPU", "CPU"];
  let ultimoErrore;
  for (const delegato of tentativi) {
    try {
      const riconoscitore = await PoseLandmarker.createFromOptions(motore.fileset, {
        baseOptions: { modelAssetBuffer: motore.bufferModello.slice(), delegate: delegato },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      motore.delegato = delegato;
      return riconoscitore;
    } catch (errore) {
      console.warn(`Delegato ${delegato} non disponibile`, errore);
      ultimoErrore = errore;
    }
  }
  throw ultimoErrore;
}

export const nomeDelegato = () => (motore.delegato === "GPU" ? "scheda grafica" : "processore");

// Ogni fotogramma analizzato occupa una "casella" di 1/30 di secondo. Si mira al centro
// della casella: saltando esattamente sul bordo, per arrotondamento, a volte il video
// ricade sul fotogramma precedente e uno viene perso.
export const tempoCasella = (i, durata) => Math.min((i + 0.5) / ANALISI_FPS, durata - 0.001);
export const casellaDi = (t) => Math.floor(t * ANALISI_FPS + 1e-3);
export const numeroCaselle = (durata) => Math.ceil(durata * ANALISI_FPS - 1e-9);

// Porta il video al tempo t e aspetta che il fotogramma sia disponibile.
export function vaiAlFotogramma(video, t) {
  return new Promise((resolve) => {
    let finito = false;
    const chiudi = () => {
      if (finito) return;
      finito = true;
      clearTimeout(limite);
      video.removeEventListener("seeked", alSalto);
      video.removeEventListener("canplay", chiudi);
      resolve();
    };
    const alSalto = () => {
      // HAVE_CURRENT_DATA: l'immagine di quel momento è già decodificata
      if (video.readyState >= 2) chiudi();
      else video.addEventListener("canplay", chiudi);
    };
    const limite = setTimeout(chiudi, 3000);
    video.addEventListener("seeked", alSalto);
    video.currentTime = t;
  });
}

// Analizza tutto il video, una casella alla volta. Restituisce i campioni
// (per ogni casella { punti } oppure null), o null se l'analisi è stata annullata.
export async function analizzaVideo(video, { dopoFotogramma, annullata, cambioDelegato } = {}) {
  const durata = video.duration;
  // Su iPhone il video va "sbloccato" con un play prima di poter saltare tra i fotogrammi
  try { await video.play(); } catch { /* va bene anche se rifiuta */ }
  video.pause();

  const totale = numeroCaselle(durata);
  const campioni = [];
  let riconoscitore = await creaRiconoscitore();
  try {
    for (let i = 0; i < totale; i++) {
      if (annullata?.()) return null;
      const t = tempoCasella(i, durata);
      const timestamp = Math.round((i * 1000) / ANALISI_FPS);
      await vaiAlFotogramma(video, t);
      let risultato;
      try {
        risultato = riconoscitore.detectForVideo(video, timestamp);
      } catch (errore) {
        // Su alcuni telefoni la scheda grafica si rompe al primo uso: si ripiega sul processore
        if (motore.delegato !== "GPU") throw errore;
        console.warn("La scheda grafica non regge, passo al processore", errore);
        riconoscitore.close();
        motore.delegato = "CPU";
        riconoscitore = await creaRiconoscitore();
        risultato = riconoscitore.detectForVideo(video, timestamp);
        cambioDelegato?.();
      }
      campioni[i] = estraiCampione(risultato);
      dopoFotogramma?.(i, totale, t, campioni);
    }
    return campioni;
  } finally {
    riconoscitore.close();
  }
}

function estraiCampione(risultato) {
  if (!risultato.landmarks?.length) return null;
  return { punti: risultato.landmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z, v: p.visibility ?? 1 })) };
}
