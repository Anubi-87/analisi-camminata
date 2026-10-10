// Analisi camminata.
// Carica un video, riconosce il corpo fotogramma per fotogramma con MediaPipe,
// disegna lo scheletro sopra il video e calcola le misure della camminata.
// Tutto avviene sul dispositivo: il video non viene mai inviato da nessuna parte.
import { PoseLandmarker, FilesetResolver } from "./libs/vision_bundle.mjs";
import { calcolaMisure } from "./misure.js";

const ANALISI_FPS = 30;          // fotogrammi analizzati per ogni secondo di video
const SOGLIA_VISIBILITA = 0.5;   // sotto questa soglia un punto non si disegna
const LATO_MAX_TELA = 1920;      // limite di risoluzione del disegno (video 4K)
const PERCORSO_WASM = "./libs/wasm";
const PERCORSO_MODELLO = "./libs/modelli/pose_landmarker_full.task";

// Indici dei punti nel modello MediaPipe. Sinistra e destra sono quelle della persona.
const PUNTO = {
  naso: 0,
  spalla: { sx: 11, dx: 12 },
  gomito: { sx: 13, dx: 14 },
  polso: { sx: 15, dx: 16 },
  anca: { sx: 23, dx: 24 },
  ginocchio: { sx: 25, dx: 26 },
  caviglia: { sx: 27, dx: 28 },
  tallone: { sx: 29, dx: 30 },
  punta: { sx: 31, dx: 32 },
};
const SEGMENTI_LATO = [
  ["spalla", "gomito"], ["gomito", "polso"],
  ["spalla", "anca"], ["anca", "ginocchio"], ["ginocchio", "caviglia"],
  ["caviglia", "tallone"], ["tallone", "punta"], ["caviglia", "punta"],
];
const PUNTI_LATO = ["spalla", "gomito", "polso", "anca", "ginocchio", "caviglia", "tallone", "punta"];
const COLORE = { sx: "#4da3ff", dx: "#ff9f43", centro: "rgba(255,255,255,0.9)" };
const SEMAFORO = { verde: "#3ddc84", giallo: "#ffd166", rosso: "#ff6b6b" };
const DURATA_LAMPO = 6; // fotogrammi in cui si evidenzia il tallone che tocca terra

const $ = (id) => document.getElementById(id);
const el = {
  sceltaFile: $("scelta-file"),
  testoScelta: $("testo-scelta"),
  inputFile: $("input-file"),
  areaVideo: $("area-video"),
  nomeFile: $("nome-file"),
  durataVideo: $("durata-video"),
  cornice: $("cornice"),
  video: $("video"),
  tela: $("tela"),
  barraAnalisi: $("barra-analisi"),
  riempimento: $("riempimento"),
  testoAvanzamento: $("testo-avanzamento"),
  bottoneAnnulla: $("bottone-annulla"),
  cursore: $("cursore"),
  etichettaTempo: $("etichetta-tempo"),
  bottoneIndietro: $("bottone-indietro"),
  bottonePlay: $("bottone-play"),
  bottoneAvanti: $("bottone-avanti"),
  iconaPlay: $("icona-play"),
  iconaPausa: $("icona-pausa"),
  velocita: $("velocita"),
  mostraScheletro: $("mostra-scheletro"),
  mostraMisure: $("mostra-misure"),
  bottoneAnalizza: $("bottone-analizza"),
  qualita: $("qualita"),
  pagella: $("pagella"),
  statoModello: $("stato-modello"),
};

const stato = {
  fileset: null,
  bufferModello: null,
  delegato: null,       // "GPU" o "CPU", deciso alla prima creazione
  modelloPronto: false,
  videoPronto: false,
  urlVideo: null,
  campioni: [],         // per ogni fotogramma analizzato: { t, punti, mondo } oppure null
  misure: null,         // risultato di calcolaMisure
  lampi: [],            // per fotogramma: talloni appena appoggiati { sx, dx }
  analizzato: false,
  inAnalisi: false,
  annulla: false,
};
window.__analisi = stato; // comodo per il debug dalla console

// ---------- Riconoscimento del corpo ----------

async function preparaRiconoscimento() {
  mostraStatoModello("Preparo il riconoscimento del corpo…");
  try {
    const [fileset, risposta] = await Promise.all([
      FilesetResolver.forVisionTasks(PERCORSO_WASM),
      fetch(PERCORSO_MODELLO),
    ]);
    if (!risposta.ok) throw new Error(`modello non trovato (${risposta.status})`);
    stato.fileset = fileset;
    stato.bufferModello = new Uint8Array(await risposta.arrayBuffer());
    // Una creazione di prova scopre subito se la scheda grafica funziona
    const prova = await creaRiconoscitore();
    prova.close();
    stato.modelloPronto = true;
    mostraStatoModello(`Riconoscimento del corpo pronto (${nomeDelegato()}).`, "ok");
  } catch (errore) {
    console.error(errore);
    mostraStatoModello("Non riesco a preparare il riconoscimento del corpo. Ricarica la pagina; se capita ancora, prova da Safari aggiornato.", "errore");
  }
  aggiornaInterfaccia();
}

async function creaRiconoscitore() {
  const tentativi = stato.delegato ? [stato.delegato] : ["GPU", "CPU"];
  let ultimoErrore;
  for (const delegato of tentativi) {
    try {
      const riconoscitore = await PoseLandmarker.createFromOptions(stato.fileset, {
        baseOptions: { modelAssetBuffer: stato.bufferModello.slice(), delegate: delegato },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      stato.delegato = delegato;
      return riconoscitore;
    } catch (errore) {
      console.warn(`Delegato ${delegato} non disponibile`, errore);
      ultimoErrore = errore;
    }
  }
  throw ultimoErrore;
}

const nomeDelegato = () => (stato.delegato === "GPU" ? "scheda grafica" : "processore");

// ---------- Caricamento del video ----------

el.inputFile.addEventListener("change", () => {
  const file = el.inputFile.files?.[0];
  el.inputFile.value = ""; // permette di riscegliere lo stesso file
  if (file) caricaVideo(file);
});

function caricaVideo(file) {
  if (stato.urlVideo) URL.revokeObjectURL(stato.urlVideo);
  stato.urlVideo = URL.createObjectURL(file);
  azzeraRisultati();
  stato.videoPronto = false;
  el.nomeFile.textContent = file.name;
  el.durataVideo.textContent = "";
  el.areaVideo.hidden = false;
  el.testoScelta.textContent = "Cambia video";
  el.video.src = stato.urlVideo;
  el.video.load();
  aggiornaInterfaccia();
}

el.video.addEventListener("loadedmetadata", () => {
  const { videoWidth: l, videoHeight: a, duration } = el.video;
  const scala = Math.min(1, LATO_MAX_TELA / Math.max(l, a));
  el.tela.width = Math.round(l * scala);
  el.tela.height = Math.round(a * scala);
  el.cornice.style.aspectRatio = `${l} / ${a}`;
  el.cornice.style.width = `min(100%, calc(70vh * ${l / a}))`;
  el.cursore.max = String(duration);
  el.durataVideo.textContent = `${formattaSecondi(duration)} s · ${l}×${a}`;
  stato.videoPronto = true;
  aggiornaTempo(0);
  disegna(0);
  aggiornaInterfaccia();
});

el.video.addEventListener("error", () => {
  stato.videoPronto = false;
  el.durataVideo.textContent = "";
  mostraStatoModello("Questo video non si riesce ad aprire in questo browser. Prova con un video girato con la fotocamera dell'iPhone.", "errore");
  aggiornaInterfaccia();
});

// ---------- Analisi fotogramma per fotogramma ----------

el.bottoneAnalizza.addEventListener("click", analizza);
el.bottoneAnnulla.addEventListener("click", () => { stato.annulla = true; });

async function analizza() {
  if (stato.inAnalisi || !stato.modelloPronto || !stato.videoPronto) return;
  const video = el.video;
  const durata = video.duration;
  if (!isFinite(durata) || durata <= 0) return;

  stato.inAnalisi = true;
  stato.annulla = false;
  azzeraRisultati();
  aggiornaInterfaccia();

  // Su iPhone il video va "sbloccato" con un play prima di poter saltare tra i fotogrammi
  try { await video.play(); } catch { /* va bene anche se rifiuta */ }
  video.pause();

  const totale = Math.ceil(durata * ANALISI_FPS - 1e-9);
  const inizio = performance.now();
  let riconoscitore = null;
  let completata = false;
  try {
    riconoscitore = await creaRiconoscitore();
    for (let i = 0; i < totale; i++) {
      if (stato.annulla) break;
      const t = tempoCasella(i, durata);
      const timestamp = Math.round((i * 1000) / ANALISI_FPS);
      await vaiAlFotogramma(t);
      let risultato;
      try {
        risultato = riconoscitore.detectForVideo(video, timestamp);
      } catch (errore) {
        // Su alcuni telefoni la scheda grafica si rompe al primo uso: si ripiega sul processore
        if (stato.delegato !== "GPU") throw errore;
        console.warn("La scheda grafica non regge, passo al processore", errore);
        riconoscitore.close();
        stato.delegato = "CPU";
        riconoscitore = await creaRiconoscitore();
        risultato = riconoscitore.detectForVideo(video, timestamp);
        mostraStatoModello(`Riconoscimento del corpo pronto (${nomeDelegato()}).`, "ok");
      }
      stato.campioni[i] = estraiCampione(t, risultato);
      disegna(t);
      aggiornaAvanzamento(i + 1, totale, inizio);
    }
    completata = !stato.annulla;
  } catch (errore) {
    console.error(errore);
    mostraStatoModello("L'analisi si è interrotta per un errore. Riprova; se capita ancora, ricarica la pagina.", "errore");
  } finally {
    riconoscitore?.close();
    stato.inAnalisi = false;
  }

  if (completata) {
    stato.analizzato = true;
    mostraQualita();
    preparaMisure();
  } else {
    stato.campioni = [];
  }
  aggiornaInterfaccia();
  await vaiAlFotogramma(0);
  disegna(0);
  aggiornaTempo(0);
}

function azzeraRisultati() {
  stato.campioni = [];
  stato.misure = null;
  stato.lampi = [];
  stato.analizzato = false;
  el.qualita.hidden = true;
  el.pagella.hidden = true;
  el.pagella.innerHTML = "";
}

function preparaMisure() {
  try {
    stato.misure = calcolaMisure(stato.campioni, {
      larghezza: el.video.videoWidth,
      altezza: el.video.videoHeight,
      fps: ANALISI_FPS,
    });
  } catch (errore) {
    console.error(errore);
    stato.misure = null;
    el.pagella.innerHTML = `<p class="errore">Non sono riuscito a calcolare le misure su questo video.</p>`;
    el.pagella.hidden = false;
    return;
  }
  // i talloni che toccano terra si evidenziano per qualche fotogramma
  stato.lampi = stato.campioni.map(() => ({ sx: false, dx: false }));
  for (const lato of ["sx", "dx"]) {
    for (const volo of stato.misure.voli[lato]) {
      for (let i = volo.atterraggio; i < Math.min(stato.lampi.length, volo.atterraggio + DURATA_LAMPO); i++) {
        stato.lampi[i][lato] = true;
      }
    }
  }
  mostraPagella();
}

// Ogni fotogramma analizzato occupa una "casella" di 1/30 di secondo. Si mira al centro
// della casella: saltando esattamente sul bordo, per arrotondamento, a volte il video
// ricade sul fotogramma precedente e uno viene perso.
const tempoCasella = (i, durata) => Math.min((i + 0.5) / ANALISI_FPS, durata - 0.001);
const casellaDi = (t) => Math.floor(t * ANALISI_FPS + 1e-3);

// Porta il video al tempo t e aspetta che il fotogramma sia disponibile.
function vaiAlFotogramma(t) {
  const video = el.video;
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

function estraiCampione(t, risultato) {
  if (!risultato.landmarks?.length) return null;
  const punti = risultato.landmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z, v: p.visibility ?? 1 }));
  const mondo = risultato.worldLandmarks?.[0]?.map((p) => ({ x: p.x, y: p.y, z: p.z })) ?? null;
  return { t, punti, mondo };
}

function aggiornaAvanzamento(fatti, totale, inizio) {
  const quota = fatti / totale;
  el.riempimento.style.width = `${(quota * 100).toFixed(1)}%`;
  const trascorsi = (performance.now() - inizio) / 1000;
  const restanti = fatti > 5 ? Math.round((trascorsi / fatti) * (totale - fatti)) : null;
  el.testoAvanzamento.textContent =
    `Analizzo il video… ${Math.round(quota * 100)}%` + (restanti !== null ? ` · circa ${restanti} s` : "");
}

function mostraQualita() {
  const totale = stato.campioni.length;
  if (!totale) return;
  const conCorpo = stato.campioni.filter(Boolean);
  const piediVisti = conCorpo.filter((c) =>
    [PUNTO.tallone.sx, PUNTO.tallone.dx, PUNTO.punta.sx, PUNTO.punta.dx]
      .every((i) => c.punti[i].v >= SOGLIA_VISIBILITA)
  ).length;
  // I momenti senza nessuno in scena (inizio e fine del video) non sono un difetto:
  // la qualità dei piedi si misura solo quando la persona è inquadrata.
  const secondiConCorpo = conCorpo.length / ANALISI_FPS;
  const secondiTotali = totale / ANALISI_FPS;
  const piedi = conCorpo.length ? piediVisti / conCorpo.length : 0;

  const righe = [];
  const classe = (q) => (q >= 0.9 ? "ok" : q >= 0.7 ? "attenzione" : "errore");
  const classeCorpo = secondiConCorpo >= 4 ? "ok" : secondiConCorpo >= 2 ? "attenzione" : "errore";
  righe.push(`<p class="${classeCorpo}">Persona riconosciuta per ${formattaSecondi(secondiConCorpo)} s su ${formattaSecondi(secondiTotali)} s di video.</p>`);
  if (conCorpo.length) {
    righe.push(`<p class="${classe(piedi)}">Mentre è inquadrata, i piedi si vedono bene nel ${Math.round(piedi * 100)}% dei fotogrammi.</p>`);
  }
  if (secondiConCorpo < 2) {
    righe.push(`<p class="nota">La persona non si vede bene: inquadrala intera dalla testa ai piedi, con più luce e lo sfondo libero.</p>`);
  } else if (piedi < 0.7) {
    righe.push(`<p class="nota">I piedi si vedono poco: abbassa un po' il telefono o allontanalo, pavimento libero, meglio pantaloncini o pantaloni aderenti.</p>`);
  }
  el.qualita.innerHTML = righe.join("");
  el.qualita.hidden = false;
}

// ---------- Pagella delle misure ----------

function mostraPagella() {
  const m = stato.misure;
  if (!m.tratti.length || !m.secondiInCammino) {
    el.pagella.innerHTML = `<h2>Misure</h2><p class="nota">Non trovo tratti in cui la persona cammina verso il telefono o si allontana, intera e ben visibile: le misure si calcolano solo su quelli.</p>`;
    el.pagella.hidden = false;
    return;
  }
  const tratti = m.tratti
    .map((t) => `${t.verso === "fronte" ? "di fronte" : "di spalle"} ${formattaSecondi(t.inizio / ANALISI_FPS)}–${formattaSecondi((t.fine + 1) / ANALISI_FPS)} s`)
    .join(" · ");
  const voci = m.pagella.map((v) => `
    <article class="voce ${v.livello ?? "neutro"}">
      <span class="semaforo" role="img" aria-label="${v.livello ?? "non valutabile"}"></span>
      <div>
        <h3>${v.titolo}</h3>
        <p>${v.frase}</p>
        ${v.dettaglio ? `<p class="dettaglio">${v.dettaglio}</p>` : ""}
        ${v.momento != null ? `<button class="bottone piccolo vai" type="button" data-momento="${v.momento}">Vedi il momento</button>` : ""}
      </div>
    </article>`).join("");
  el.pagella.innerHTML = `
    <h2>Misure</h2>
    <p class="nota">Camminata usata per le misure: ${formattaSecondi(m.secondiInCammino)} s (${tratti}).</p>
    ${voci}
    <p class="nota">Verde: a posto. Giallo: da guardare. Rosso: fuori norma. I limiti sono indicativi e vanno tarati con il trainer.</p>`;
  el.pagella.hidden = false;
}

// "Vedi il momento": porta il video al fotogramma peggiore di quella misura
el.pagella.addEventListener("click", (evento) => {
  const bottone = evento.target.closest("[data-momento]");
  if (!bottone || stato.inAnalisi) return;
  el.video.pause();
  el.video.currentTime = tempoCasella(Number(bottone.dataset.momento), el.video.duration);
  el.cornice.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- Disegno dello scheletro ----------

function disegna(t) {
  const ctx = el.tela.getContext("2d");
  const L = el.tela.width;
  const A = el.tela.height;
  ctx.clearRect(0, 0, L, A);
  if (!el.mostraScheletro.checked || !stato.campioni.length) return;
  const indice = Math.min(stato.campioni.length - 1, Math.max(0, casellaDi(t)));
  const c = stato.campioni[indice];
  if (!c) return;
  // misure di questo fotogramma: solo mentre la persona cammina dritta
  const conMisure = el.mostraMisure.checked;
  const f = conMisure ? stato.misure?.fotogrammi[indice] : null;
  const misura = f?.valido && f.inCammino ? f : null;
  const lampo = conMisure ? stato.lampi[indice] : null;
  const coloreLivello = (liv) => (liv ? SEMAFORO[liv] : COLORE.centro);

  const spessore = Math.max(2, Math.min(L, A) / 140);
  const visibile = (i) => c.punti[i].v >= SOGLIA_VISIBILITA;
  const pos = (i) => [c.punti[i].x * L, c.punti[i].y * A];
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Ogni linea ha un bordo scuro sotto, così si legge su qualsiasi sfondo
  const tratto = (punti, colore, tratteggio = []) => {
    for (const [larghezza, stile] of [[spessore + 3, "rgba(0,0,0,0.55)"], [spessore, colore]]) {
      ctx.beginPath();
      ctx.setLineDash(tratteggio.map((d) => d * spessore));
      ctx.lineWidth = larghezza;
      ctx.strokeStyle = stile;
      punti.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  };
  const linea = (a, b, colore) => {
    if (visibile(a) && visibile(b)) tratto([pos(a), pos(b)], colore);
  };
  const cerchio = ([x, y], raggio, colore, riempimento = "#fff") => {
    ctx.beginPath();
    ctx.arc(x, y, raggio, 0, Math.PI * 2);
    ctx.fillStyle = riempimento;
    ctx.fill();
    ctx.lineWidth = Math.max(2, spessore * 0.6);
    ctx.strokeStyle = colore;
    ctx.stroke();
  };
  // Cartellino col valore di una misura, sul colore del semaforo
  const corpoTesto = Math.round(Math.max(12, Math.min(L, A) / 26));
  const etichetta = (testo, colore, x, y, versoSinistra) => {
    ctx.font = `600 ${corpoTesto}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
    const larghezza = ctx.measureText(testo).width + corpoTesto * 0.8;
    const altezza = corpoTesto * 1.45;
    const x0 = Math.min(Math.max(2, versoSinistra ? x - larghezza : x), L - larghezza - 2);
    const y0 = Math.min(Math.max(2, y - altezza / 2), A - altezza - 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y0, larghezza, altezza, altezza / 3);
    else ctx.rect(x0, y0, larghezza, altezza);
    ctx.fillStyle = colore;
    ctx.fill();
    ctx.fillStyle = "#11140a";
    ctx.textBaseline = "middle";
    ctx.fillText(testo, x0 + corpoTesto * 0.4, y0 + altezza / 2);
  };
  const gradiTesto = (v) => `${Math.round(Math.abs(v))}°`;
  const margine = spessore * 3;

  // Centro: linea delle spalle, linea del bacino e asse del busto (tratteggiato)
  linea(PUNTO.spalla.sx, PUNTO.spalla.dx, misura ? coloreLivello(misura.livelli.spalle) : COLORE.centro);
  linea(PUNTO.anca.sx, PUNTO.anca.dx, misura ? coloreLivello(misura.livelli.bacino) : COLORE.centro);
  const busto = [PUNTO.spalla.sx, PUNTO.spalla.dx, PUNTO.anca.sx, PUNTO.anca.dx];
  if (busto.every(visibile)) {
    const medio = (a, b) => [(pos(a)[0] + pos(b)[0]) / 2, (pos(a)[1] + pos(b)[1]) / 2];
    tratto([medio(PUNTO.spalla.sx, PUNTO.spalla.dx), medio(PUNTO.anca.sx, PUNTO.anca.dx)],
      misura ? coloreLivello(misura.livelli.busto) : COLORE.centro, [2, 2]);
  }

  // Lati sinistro e destro
  for (const lato of ["sx", "dx"]) {
    for (const [a, b] of SEGMENTI_LATO) linea(PUNTO[a][lato], PUNTO[b][lato], COLORE[lato]);
  }
  for (const lato of ["sx", "dx"]) {
    const livelloGinocchio = misura?.livelli[lato === "sx" ? "ginocchioSx" : "ginocchioDx"];
    for (const nome of PUNTI_LATO) {
      const i = PUNTO[nome][lato];
      if (!visibile(i)) continue;
      // il ginocchio in appoggio prende il colore del semaforo
      const riempimento = nome === "ginocchio" && livelloGinocchio ? SEMAFORO[livelloGinocchio] : "#fff";
      // il tallone più grande: è il punto che conta per l'appoggio
      const raggio = spessore * (nome === "tallone" ? 1.6 : nome === "ginocchio" && livelloGinocchio ? 1.5 : 1.1);
      cerchio(pos(i), raggio, COLORE[lato], riempimento);
    }
    // tallone che ha appena toccato terra: un anello attorno
    if (lampo?.[lato] && visibile(PUNTO.tallone[lato])) {
      const [x, y] = pos(PUNTO.tallone[lato]);
      ctx.beginPath();
      ctx.arc(x, y, spessore * 4, 0, Math.PI * 2);
      ctx.lineWidth = spessore * 0.9;
      ctx.strokeStyle = COLORE[lato];
      ctx.stroke();
    }
  }
  if (visibile(PUNTO.naso)) cerchio(pos(PUNTO.naso), spessore * 1.3, COLORE.centro);

  // I valori scritti accanto: busto a sinistra, spalle e bacino a destra, ginocchia all'esterno
  if (misura && busto.every(visibile)) {
    const spallaSinistraImmagine = pos(PUNTO.spalla.sx)[0] < pos(PUNTO.spalla.dx)[0] ? "sx" : "dx";
    const spallaDestraImmagine = spallaSinistraImmagine === "sx" ? "dx" : "sx";
    const [xs, ys] = pos(PUNTO.spalla[spallaSinistraImmagine]);
    const [xd, yd] = pos(PUNTO.spalla[spallaDestraImmagine]);
    const [xa, ya] = pos(PUNTO.anca[spallaDestraImmagine]);
    etichetta(`Busto ${gradiTesto(misura.inclinazione)}`, coloreLivello(misura.livelli.busto), xs - margine, ys, true);
    etichetta(`Spalle ${gradiTesto(misura.spalle)}`, coloreLivello(misura.livelli.spalle), xd + margine, yd, false);
    etichetta(`Bacino ${gradiTesto(misura.bacino)}`, coloreLivello(misura.livelli.bacino), xa + margine, ya, false);
    for (const lato of ["sx", "dx"]) {
      const liv = misura.livelli[lato === "sx" ? "ginocchioSx" : "ginocchioDx"];
      if (!liv || !visibile(PUNTO.ginocchio[lato])) continue;
      const [x, y] = pos(PUNTO.ginocchio[lato]);
      const aSinistra = lato === spallaSinistraImmagine;
      etichetta(gradiTesto(misura.ginocchio[lato]), SEMAFORO[liv], aSinistra ? x - margine : x + margine, y, aSinistra);
    }
  }
}

// ---------- Riproduzione ----------

el.bottonePlay.addEventListener("click", () => {
  if (el.video.paused) el.video.play().catch(() => {});
  else el.video.pause();
});

el.video.addEventListener("play", () => {
  aggiornaInterfaccia();
  if (!stato.inAnalisi) cicloDisegno();
});
el.video.addEventListener("pause", () => {
  aggiornaInterfaccia();
  if (stato.inAnalisi) return;
  disegna(el.video.currentTime);
  aggiornaTempo(el.video.currentTime);
});
el.video.addEventListener("ended", aggiornaInterfaccia);
el.video.addEventListener("seeked", () => {
  if (stato.inAnalisi) return;
  disegna(el.video.currentTime);
  aggiornaTempo(el.video.currentTime);
});

// Durante la riproduzione ridisegna a ogni fotogramma mostrato
function cicloDisegno() {
  const video = el.video;
  if ("requestVideoFrameCallback" in video) {
    const passo = (_ora, info) => {
      disegna(info.mediaTime);
      aggiornaTempo(info.mediaTime);
      if (!video.paused && !video.ended) video.requestVideoFrameCallback(passo);
    };
    video.requestVideoFrameCallback(passo);
  } else {
    const passo = () => {
      disegna(video.currentTime);
      aggiornaTempo(video.currentTime);
      if (!video.paused && !video.ended) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }
}

el.cursore.addEventListener("input", () => {
  el.video.pause();
  el.video.currentTime = Number(el.cursore.value);
});

const spostaDiFotogrammi = (n) => {
  el.video.pause();
  const ultima = Math.ceil(el.video.duration * ANALISI_FPS - 1e-9) - 1;
  const casella = Math.min(Math.max(0, casellaDi(el.video.currentTime) + n), ultima);
  el.video.currentTime = tempoCasella(casella, el.video.duration);
};
el.bottoneIndietro.addEventListener("click", () => spostaDiFotogrammi(-1));
el.bottoneAvanti.addEventListener("click", () => spostaDiFotogrammi(1));

el.velocita.addEventListener("click", (evento) => {
  const bottone = evento.target.closest("[data-velocita]");
  if (!bottone) return;
  el.video.playbackRate = Number(bottone.dataset.velocita);
  for (const b of el.velocita.querySelectorAll("[data-velocita]")) b.classList.toggle("attivo", b === bottone);
});

el.mostraScheletro.addEventListener("change", () => disegna(el.video.currentTime));
el.mostraMisure.addEventListener("change", () => disegna(el.video.currentTime));

// Tastiera (utile da computer): spazio play/pausa, frecce un fotogramma
document.addEventListener("keydown", (evento) => {
  if (stato.inAnalisi || !stato.videoPronto || evento.target.matches("input")) return;
  // sopra un bottone lo spazio lo preme già il browser
  if (evento.key === " " && !evento.target.matches("button")) { evento.preventDefault(); el.bottonePlay.click(); }
  if (evento.key === "ArrowLeft") { evento.preventDefault(); spostaDiFotogrammi(-1); }
  if (evento.key === "ArrowRight") { evento.preventDefault(); spostaDiFotogrammi(1); }
});

// ---------- Interfaccia ----------

function aggiornaInterfaccia() {
  const occupato = stato.inAnalisi;
  const pronto = stato.videoPronto && !occupato;
  el.sceltaFile.classList.toggle("disabilitato", occupato);
  el.inputFile.disabled = occupato;
  el.barraAnalisi.hidden = !occupato;
  for (const b of [el.bottonePlay, el.bottoneIndietro, el.bottoneAvanti, el.cursore, el.mostraScheletro, el.mostraMisure,
                   ...el.velocita.querySelectorAll("button")]) {
    b.disabled = !pronto;
  }
  el.bottoneAnalizza.disabled = !(pronto && stato.modelloPronto);
  el.bottoneAnalizza.textContent = stato.analizzato ? "Analizza di nuovo" : "Analizza";
  el.bottoneAnalizza.hidden = occupato;
  const inPausa = el.video.paused || el.video.ended;
  el.iconaPlay.hidden = !inPausa;
  el.iconaPausa.hidden = inPausa;
  el.bottonePlay.setAttribute("aria-label", inPausa ? "Riproduci" : "Pausa");
  if (occupato) el.riempimento.style.width = "0%";
}

function aggiornaTempo(t) {
  if (document.activeElement !== el.cursore) el.cursore.value = String(t);
  el.etichettaTempo.textContent = `${formattaSecondi(t)} / ${formattaSecondi(el.video.duration || 0)} s`;
}

function mostraStatoModello(testo, tipo = "") {
  el.statoModello.textContent = testo;
  el.statoModello.className = tipo;
}

const formattaSecondi = (s) => (isFinite(s) ? s.toFixed(1).replace(".", ",") : "0,0");

aggiornaInterfaccia();
preparaRiconoscimento();
