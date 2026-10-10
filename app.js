// Analisi camminata: pagina con un solo video.
// Carica un video, riconosce il corpo fotogramma per fotogramma con MediaPipe,
// disegna lo scheletro sopra il video e calcola le misure della camminata.
// Tutto avviene sul dispositivo: il video non viene mai inviato da nessuna parte.
import {
  ANALISI_FPS, preparaRiconoscimento, analizzaVideo, nomeDelegato,
  tempoCasella, casellaDi, numeroCaselle,
} from "./riconoscimento.js?v=202610102132";
import { disegnaScheletro, calcolaLampi, PUNTO, SOGLIA_VISIBILITA } from "./disegno.js?v=202610102132";
import { calcolaMisure } from "./misure.js?v=202610102132";
import { calcolaImpronta, leggiAnalisi, salvaAnalisi } from "./archivio.js?v=202610102132";

const LATO_MAX_TELA = 1920; // limite di risoluzione del disegno (video 4K)

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
  archivio: $("archivio"),
  qualita: $("qualita"),
  pagella: $("pagella"),
  statoModello: $("stato-modello"),
};

const stato = {
  modelloPronto: false,
  videoPronto: false,
  urlVideo: null,
  file: null,
  impronta: null,       // Promise dell'impronta del video, per l'archivio
  campioni: [],         // per ogni fotogramma analizzato: { punti } oppure null
  misure: null,         // risultato di calcolaMisure
  lampi: [],            // per fotogramma: talloni appena appoggiati { sx, dx }
  analizzato: false,
  inAnalisi: false,
  annulla: false,
};
window.__analisi = stato; // comodo per il debug dalla console

// ---------- Riconoscimento del corpo ----------

async function avviaRiconoscimento() {
  mostraStatoModello("Preparo il riconoscimento del corpo…");
  try {
    await preparaRiconoscimento();
    stato.modelloPronto = true;
    mostraStatoModello(`Riconoscimento del corpo pronto (${nomeDelegato()}).`, "ok");
  } catch (errore) {
    console.error(errore);
    mostraStatoModello("Non riesco a preparare il riconoscimento del corpo. Ricarica la pagina; se capita ancora, prova da Safari aggiornato.", "errore");
  }
  aggiornaInterfaccia();
}

// ---------- Caricamento del video ----------

el.inputFile.addEventListener("change", () => {
  const file = el.inputFile.files?.[0];
  el.inputFile.value = ""; // permette di riscegliere lo stesso file
  if (file) caricaVideo(file);
});

function caricaVideo(file) {
  if (stato.urlVideo) URL.revokeObjectURL(stato.urlVideo);
  stato.urlVideo = URL.createObjectURL(file);
  stato.file = file;
  stato.impronta = calcolaImpronta(file);
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

el.video.addEventListener("loadedmetadata", async () => {
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
  await recuperaDallArchivio();
});

el.video.addEventListener("error", () => {
  stato.videoPronto = false;
  el.durataVideo.textContent = "";
  mostraStatoModello("Questo video non si riesce ad aprire in questo browser. Prova con un video girato con la fotocamera dell'iPhone.", "errore");
  aggiornaInterfaccia();
});

// Se questo video è già stato analizzato su questo telefono, l'analisi è pronta subito
async function recuperaDallArchivio() {
  const file = stato.file;
  const voce = await leggiAnalisi(await stato.impronta);
  if (!voce || file !== stato.file || stato.inAnalisi || stato.analizzato) return;
  if (voce.campioni.length !== numeroCaselle(el.video.duration)) return;
  stato.campioni = voce.campioni;
  completaAnalisi();
  const data = new Date(voce.data).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
  el.archivio.textContent = `Analisi già fatta il ${data}: recuperata dalla memoria del telefono.`;
  el.archivio.hidden = false;
  aggiornaInterfaccia();
  disegna(el.video.currentTime);
}

// ---------- Analisi fotogramma per fotogramma ----------

el.bottoneAnalizza.addEventListener("click", analizza);
el.bottoneAnnulla.addEventListener("click", () => { stato.annulla = true; });

async function analizza() {
  if (stato.inAnalisi || !stato.modelloPronto || !stato.videoPronto) return;
  const video = el.video;
  if (!isFinite(video.duration) || video.duration <= 0) return;

  stato.inAnalisi = true;
  stato.annulla = false;
  azzeraRisultati();
  aggiornaInterfaccia();

  const inizio = performance.now();
  let campioni = null;
  try {
    campioni = await analizzaVideo(video, {
      annullata: () => stato.annulla,
      dopoFotogramma: (i, totale, t, parziali) => {
        // lo scheletro si vede comparire mentre l'analisi avanza
        disegnaScheletro(el.tela, { campione: el.mostraScheletro.checked ? parziali[i] : null });
        aggiornaAvanzamento(i + 1, totale, inizio);
      },
      cambioDelegato: () => mostraStatoModello(`Riconoscimento del corpo pronto (${nomeDelegato()}).`, "ok"),
    });
  } catch (errore) {
    console.error(errore);
    mostraStatoModello("L'analisi si è interrotta per un errore. Riprova; se capita ancora, ricarica la pagina.", "errore");
  } finally {
    stato.inAnalisi = false;
  }

  if (campioni) {
    stato.campioni = campioni;
    completaAnalisi();
    salvaAnalisi({
      impronta: await stato.impronta,
      nome: stato.file?.name,
      durata: video.duration,
      larghezza: video.videoWidth,
      altezza: video.videoHeight,
      campioni,
    });
  }
  aggiornaInterfaccia();
  video.currentTime = tempoCasella(0, video.duration);
}

function azzeraRisultati() {
  stato.campioni = [];
  stato.misure = null;
  stato.lampi = [];
  stato.analizzato = false;
  el.archivio.hidden = true;
  el.qualita.hidden = true;
  el.pagella.hidden = true;
  el.pagella.innerHTML = "";
}

function completaAnalisi() {
  stato.analizzato = true;
  mostraQualita();
  preparaMisure();
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
  stato.lampi = calcolaLampi(stato.misure, stato.campioni.length);
  mostraPagella();
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

// ---------- Disegno ----------

function disegna(t) {
  if (!el.mostraScheletro.checked || !stato.campioni.length) {
    disegnaScheletro(el.tela, { campione: null });
    return;
  }
  const i = Math.min(stato.campioni.length - 1, Math.max(0, casellaDi(t)));
  const conMisure = el.mostraMisure.checked;
  const f = conMisure ? stato.misure?.fotogrammi[i] : null;
  disegnaScheletro(el.tela, {
    campione: stato.campioni[i],
    // le misure si mostrano solo mentre la persona cammina dritta
    misura: f?.valido && f.inCammino ? f : null,
    lampo: conMisure ? stato.lampi[i] : null,
  });
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
  const ultima = numeroCaselle(el.video.duration) - 1;
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
avviaRiconoscimento();
