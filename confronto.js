// Confronto prima/dopo: due video affiancati con comandi in comune,
// salto agli appoggi per vedere lo stesso istante del passo, misure a confronto.
// Tutto avviene sul dispositivo: i video non vengono mai inviati da nessuna parte.
import {
  ANALISI_FPS, preparaRiconoscimento, analizzaVideo, nomeDelegato,
  tempoCasella, casellaDi, numeroCaselle,
} from "./riconoscimento.js?v=202610102132";
import { disegnaScheletro, calcolaLampi } from "./disegno.js?v=202610102132";
import { calcolaMisure, confrontaVoci } from "./misure.js?v=202610102132";
import { calcolaImpronta, leggiAnalisi, salvaAnalisi } from "./archivio.js?v=202610102132";

const LATO_MAX_TELA = 1920;        // limite di risoluzione del disegno (video 4K)
const ANTICIPO_ALLINEAMENTO = 15;  // fotogrammi (mezzo secondo) prima del primo appoggio

const $ = (id) => document.getElementById(id);
const comuni = {
  coppia: $("coppia"),
  cursore: $("cursore"),
  etichettaTempo: $("etichetta-tempo"),
  bottoneIndietro: $("bottone-indietro"),
  bottonePlay: $("bottone-play"),
  bottoneAvanti: $("bottone-avanti"),
  iconaPlay: $("icona-play"),
  iconaPausa: $("icona-pausa"),
  velocita: $("velocita"),
  bottoneAllinea: $("bottone-allinea"),
  notaAllineamento: $("nota-allineamento"),
  mostraScheletro: $("mostra-scheletro"),
  mostraMisure: $("mostra-misure"),
  pagella: $("pagella-confronto"),
  statoModello: $("stato-modello"),
};

const stato = {
  modelloPronto: false,
  inAnalisi: null,       // il lato che si sta analizzando (uno alla volta)
  posizione: 0,          // fotogramma comune: ogni video sta al fotogramma "scarto + posizione"
  inRiproduzione: false,
  attese: new Set(),     // partenze ritardate dei video durante la riproduzione
  ultimoControllo: 0,
};
const SCARTO_MAX_RIPRODUZIONE = 6; // fotogrammi di ritardo tollerati tra i due video mentre vanno

const lati = [creaLato("prima", "Prima"), creaLato("dopo", "Dopo")];
window.__confronto = { stato, lati }; // comodo per il debug dalla console

// ---------- I due riquadri ----------

function creaLato(chiave, titolo) {
  const radice = $("modello-lato").content.firstElementChild.cloneNode(true);
  comuni.coppia.append(radice);
  const q = (selettore) => radice.querySelector(selettore);
  const lato = {
    chiave,
    titolo,
    el: {
      titolo: q(".titolo-lato"),
      scelta: q(".scelta-file"),
      testoScelta: q(".testo-scelta"),
      input: q("input[type=file]"),
      nome: q(".nome-video"),
      cornice: q(".cornice"),
      video: q("video"),
      tela: q("canvas"),
      avanzamento: q(".avanzamento"),
      riempimento: q(".avanzamento div"),
      statoLato: q(".stato-lato"),
      analizza: q(".analizza"),
    },
    file: null,
    url: null,
    impronta: null,
    pronto: false,
    campioni: [],
    misure: null,
    lampi: [],
    analizzato: false,
    annulla: false,
    scarto: 0, // in fotogrammi
  };
  lato.el.titolo.textContent = titolo;
  lato.el.input.addEventListener("change", () => {
    const file = lato.el.input.files?.[0];
    lato.el.input.value = ""; // permette di riscegliere lo stesso file
    if (file) caricaVideo(lato, file);
  });
  lato.el.video.addEventListener("loadedmetadata", () => videoCaricato(lato));
  lato.el.video.addEventListener("error", () => {
    lato.pronto = false;
    scriviStato(lato, "Questo video non si riesce ad aprire. Prova con un video girato con la fotocamera dell'iPhone.", "errore");
    aggiornaInterfaccia();
  });
  lato.el.video.addEventListener("seeked", () => { if (stato.inAnalisi !== lato) disegnaLato(lato); });
  lato.el.video.addEventListener("play", () => { if (stato.inAnalisi !== lato) cicloDisegno(lato); });
  lato.el.video.addEventListener("ended", controllaFine);
  lato.el.analizza.addEventListener("click", () => {
    if (stato.inAnalisi === lato) lato.annulla = true;
    else analizzaLato(lato);
  });
  return lato;
}

function caricaVideo(lato, file) {
  pausa();
  if (lato.url) URL.revokeObjectURL(lato.url);
  lato.url = URL.createObjectURL(file);
  lato.file = file;
  lato.impronta = calcolaImpronta(file);
  lato.pronto = false;
  lato.scarto = 0;
  azzeraRisultati(lato);
  lato.el.nome.textContent = file.name;
  lato.el.testoScelta.textContent = "Cambia";
  lato.el.cornice.hidden = false;
  scriviStato(lato, "Apro il video…");
  lato.el.video.src = lato.url;
  lato.el.video.load();
  mostraPagellaConfronto();
  aggiornaInterfaccia();
}

async function videoCaricato(lato) {
  const { videoWidth: l, videoHeight: a, duration } = lato.el.video;
  const scala = Math.min(1, LATO_MAX_TELA / Math.max(l, a));
  lato.el.tela.width = Math.round(l * scala);
  lato.el.tela.height = Math.round(a * scala);
  lato.el.cornice.style.aspectRatio = `${l} / ${a}`;
  lato.el.cornice.style.width = `min(100%, calc(55vh * ${l / a}))`;
  lato.pronto = true;
  scriviStato(lato, `${formattaSecondi(duration)} s. Premi Analizza.`);
  aggiornaCursore();
  vaiAllaPosizione();
  aggiornaInterfaccia();
  await recuperaDallArchivio(lato);
}

// Se questo video è già stato analizzato su questo telefono, l'analisi è pronta subito
async function recuperaDallArchivio(lato) {
  const file = lato.file;
  const voce = await leggiAnalisi(await lato.impronta);
  if (!voce || file !== lato.file || stato.inAnalisi === lato || lato.analizzato) return;
  if (voce.campioni.length !== numeroCaselle(lato.el.video.duration)) return;
  lato.campioni = voce.campioni;
  const data = new Date(voce.data).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
  completaLato(lato, `Analisi del ${data} recuperata dalla memoria del telefono.`);
}

function azzeraRisultati(lato) {
  lato.campioni = [];
  lato.misure = null;
  lato.lampi = [];
  lato.analizzato = false;
  disegnaScheletro(lato.el.tela, { campione: null });
}

// ---------- Analisi ----------

async function analizzaLato(lato) {
  if (stato.inAnalisi || !stato.modelloPronto || !lato.pronto) return;
  pausa();
  stato.inAnalisi = lato;
  lato.annulla = false;
  lato.el.riempimento.style.width = "0%";
  azzeraRisultati(lato);
  mostraPagellaConfronto();
  aggiornaInterfaccia();

  const video = lato.el.video;
  const inizio = performance.now();
  let campioni = null;
  try {
    campioni = await analizzaVideo(video, {
      annullata: () => lato.annulla,
      dopoFotogramma: (i, totale, _t, parziali) => {
        disegnaScheletro(lato.el.tela, { campione: comuni.mostraScheletro.checked ? parziali[i] : null });
        const quota = (i + 1) / totale;
        lato.el.riempimento.style.width = `${(quota * 100).toFixed(1)}%`;
        const trascorsi = (performance.now() - inizio) / 1000;
        const restanti = i > 5 ? Math.round((trascorsi / (i + 1)) * (totale - i - 1)) : null;
        scriviStato(lato, `Analizzo… ${Math.round(quota * 100)}%` + (restanti !== null ? ` · circa ${restanti} s` : ""));
      },
      cambioDelegato: () => mostraStatoModello(`Riconoscimento del corpo pronto (${nomeDelegato()}).`, "ok"),
    });
  } catch (errore) {
    console.error(errore);
    scriviStato(lato, "L'analisi si è interrotta per un errore. Riprova; se capita ancora, ricarica la pagina.", "errore");
  } finally {
    stato.inAnalisi = null;
  }

  if (campioni) {
    lato.campioni = campioni;
    completaLato(lato);
    salvaAnalisi({
      impronta: await lato.impronta,
      nome: lato.file?.name,
      durata: video.duration,
      larghezza: video.videoWidth,
      altezza: video.videoHeight,
      campioni,
    });
  } else if (lato.annulla) {
    scriviStato(lato, "Analisi annullata.");
  }
  aggiornaInterfaccia();
  vaiAllaPosizione();
}

function completaLato(lato, notaArchivio = "") {
  lato.analizzato = true;
  try {
    lato.misure = calcolaMisure(lato.campioni, {
      larghezza: lato.el.video.videoWidth,
      altezza: lato.el.video.videoHeight,
      fps: ANALISI_FPS,
    });
    lato.lampi = calcolaLampi(lato.misure, lato.campioni.length);
    const secondi = lato.misure.secondiInCammino;
    if (!lato.misure.tratti.length || !secondi) {
      scriviStato(lato, "Non trovo tratti in cui la persona cammina verso il telefono o si allontana, intera: niente misure per questo video.", "attenzione");
    } else {
      scriviStato(lato, `${notaArchivio} Camminata usata per le misure: ${formattaSecondi(secondi)} s.`.trim(), "ok");
    }
  } catch (errore) {
    console.error(errore);
    lato.misure = null;
    scriviStato(lato, "Non sono riuscito a calcolare le misure su questo video.", "errore");
  }
  // quando ci sono tutti e due, si parte già allineati al primo passo
  if (lati.every((l) => l.misure)) allineaAlPrimoPasso();
  mostraPagellaConfronto();
  aggiornaInterfaccia();
  disegnaLato(lato);
}

// ---------- Posizione comune dei due video ----------

const ultimaCasella = (lato) => numeroCaselle(lato.el.video.duration) - 1;
const casellaDelLato = (lato) => Math.min(Math.max(0, lato.scarto + stato.posizione), ultimaCasella(lato));

// Intervallo della posizione comune in cui almeno uno dei due video ha immagini
function limitiPosizione() {
  const pronti = lati.filter((l) => l.pronto);
  if (!pronti.length) return [0, 0];
  return [
    Math.min(...pronti.map((l) => -l.scarto)),
    Math.max(...pronti.map((l) => ultimaCasella(l) - l.scarto)),
  ];
}

function aggiornaCursore() {
  const [minimo, massimo] = limitiPosizione();
  comuni.cursore.min = String(minimo / ANALISI_FPS);
  comuni.cursore.max = String(massimo / ANALISI_FPS);
  if (document.activeElement !== comuni.cursore) comuni.cursore.value = String(stato.posizione / ANALISI_FPS);
  comuni.etichettaTempo.textContent = lati
    .filter((l) => l.pronto)
    .map((l) => `${l.titolo} ${formattaSecondi(casellaDelLato(l) / ANALISI_FPS)} s`)
    .join(" · ") || "0,0 s";
}

function vaiAllaPosizione() {
  for (const lato of lati) {
    if (!lato.pronto || stato.inAnalisi === lato) continue;
    lato.el.video.currentTime = tempoCasella(casellaDelLato(lato), lato.el.video.duration);
  }
  aggiornaCursore();
}

function spostaDiFotogrammi(n) {
  pausa();
  const [minimo, massimo] = limitiPosizione();
  stato.posizione = Math.min(Math.max(minimo, stato.posizione + n), massimo);
  vaiAllaPosizione();
}

const appoggiDi = (lato, piede) => lato.misure.voli[piede].map((v) => v.atterraggio).sort((a, b) => a - b);
const versoDi = (lato, casella) => lato.misure.fotogrammi[casella]?.verso ?? null;
const NOME_VERSO = { fronte: "venendo verso il telefono", spalle: "allontanandosi" };

// Tra gli appoggi di un video, quello da mostrare: preferibilmente nella stessa direzione
// di camminata del video di riferimento, nel verso richiesto, altrimenti il più vicino.
function scegliAppoggio(lato, piede, versoCamminata, attuale, verso) {
  const tutti = appoggiDi(lato, piede);
  const stessaDirezione = tutti.filter((c) => versoDi(lato, c) === versoCamminata);
  const candidati = stessaDirezione.length ? stessaDirezione : tutti;
  if (!candidati.length) return null;
  const nelVerso = verso > 0 ? candidati.find((c) => c > attuale) : [...candidati].reverse().find((c) => c < attuale);
  return nelVerso ?? candidati.reduce((a, b) => (Math.abs(b - attuale) < Math.abs(a - attuale) ? b : a));
}

// Porta il primo video al suo prossimo (o precedente) appoggio di quel piede, l'altro
// all'appoggio corrispondente nella stessa direzione di camminata, e li riallinea lì:
// così si confronta lo stesso istante del passo, prima e dopo.
function vaiAllAppoggio(piede, verso) {
  pausa();
  const analizzati = lati.filter((l) => l.pronto && l.misure);
  if (!analizzati.length) return;
  const [riferimento, ...altri] = analizzati;
  const nomePiede = piede === "dx" ? "destro" : "sinistro";
  const attuale = casellaDelLato(riferimento);
  const appoggiRif = appoggiDi(riferimento, piede);
  const casellaRif = verso > 0 ? appoggiRif.find((c) => c > attuale) : [...appoggiRif].reverse().find((c) => c < attuale);
  if (casellaRif == null) {
    mostraNota(`Nel video "${riferimento.titolo}" non ci sono altri appoggi del piede ${nomePiede} in questa direzione.`);
    return;
  }
  const versoCamminata = versoDi(riferimento, casellaRif);
  const obiettivi = [{ lato: riferimento, casella: casellaRif }];
  const diversi = [];
  for (const lato of altri) {
    const casella = scegliAppoggio(lato, piede, versoCamminata, casellaDelLato(lato), verso);
    if (casella == null || versoDi(lato, casella) !== versoCamminata) diversi.push(lato.titolo);
    obiettivi.push({ lato, casella: casella ?? casellaDelLato(lato) });
  }
  mostraNota(diversi.length
    ? `Tallone ${nomePiede} a terra. Attenzione: nel video "${diversi.join(", ")}" non c'è un appoggio ${NOME_VERSO[versoCamminata] ?? ""}, quindi non è lo stesso momento.`
    : `Tutti e due i video sul momento in cui il tallone ${nomePiede} tocca terra, ${NOME_VERSO[versoCamminata] ?? ""}.`);
  // la posizione comune segue il primo video, gli altri si riallineano a questo istante
  stato.posizione = casellaRif - riferimento.scarto;
  for (const o of obiettivi) o.lato.scarto = o.casella - stato.posizione;
  vaiAllaPosizione();
}

// Fa partire i due video mezzo secondo prima del primo appoggio destro,
// nella stessa direzione di camminata
function allineaAlPrimoPasso() {
  pausa();
  const analizzati = lati.filter((l) => l.pronto && l.misure);
  const [riferimento, ...altri] = analizzati;
  if (!riferimento) return;
  const primoRif = appoggiDi(riferimento, "dx")[0] ?? appoggiDi(riferimento, "sx")[0];
  if (primoRif == null) {
    mostraNota(`Nel video "${riferimento.titolo}" non ho trovato passi: l'allineamento non è possibile.`);
    return;
  }
  const piede = appoggiDi(riferimento, "dx").length ? "dx" : "sx";
  const versoCamminata = versoDi(riferimento, primoRif);
  riferimento.scarto = Math.max(0, primoRif - ANTICIPO_ALLINEAMENTO);
  let tuttiAllineati = true;
  for (const lato of altri) {
    const primo = scegliAppoggio(lato, piede, versoCamminata, -1, 1);
    if (primo == null || versoDi(lato, primo) !== versoCamminata) tuttiAllineati = false;
    lato.scarto = primo != null ? Math.max(0, primo - ANTICIPO_ALLINEAMENTO) : 0;
  }
  stato.posizione = 0;
  mostraNota(tuttiAllineati
    ? `Allineati: i due video partono mezzo secondo prima del primo appoggio del piede ${piede === "dx" ? "destro" : "sinistro"}, ${NOME_VERSO[versoCamminata] ?? ""}.`
    : "In un video non ho trovato un passo nella stessa direzione dell'altro: l'allineamento è solo indicativo.");
  vaiAllaPosizione();
}

function mostraNota(testo) {
  comuni.notaAllineamento.textContent = testo;
  comuni.notaAllineamento.hidden = false;
}

// ---------- Riproduzione insieme ----------

function play() {
  const pronti = lati.filter((l) => l.pronto);
  if (!pronti.length || stato.inAnalisi) return;
  stato.inRiproduzione = true;
  for (const lato of pronti) {
    const casella = lato.scarto + stato.posizione;
    const video = lato.el.video;
    if (casella >= ultimaCasella(lato)) continue; // questo video è già finito
    if (casella < 0) {
      // questo video comincia più tardi: parte quando la posizione comune lo raggiunge
      const ritardo = (-casella / ANALISI_FPS / video.playbackRate) * 1000;
      const attesa = setTimeout(() => {
        stato.attese.delete(attesa);
        if (stato.inRiproduzione) video.play().catch(() => {});
      }, ritardo);
      stato.attese.add(attesa);
    } else {
      video.play().catch(() => {});
    }
  }
  aggiornaInterfaccia();
  cicloCursore();
}

function pausa() {
  if (!stato.inRiproduzione) return;
  stato.inRiproduzione = false;
  stato.attese.forEach(clearTimeout);
  stato.attese.clear();
  // la posizione comune la dà il video che sta andando; poi si rimettono in pari tutti e due
  const guida = lati.find((l) => l.pronto && !l.el.video.paused && !l.el.video.ended)
    ?? lati.find((l) => l.pronto);
  for (const lato of lati) lato.el.video.pause();
  if (guida) stato.posizione = casellaDi(guida.el.video.currentTime) - guida.scarto;
  vaiAllaPosizione();
  aggiornaInterfaccia();
}

function controllaFine() {
  if (stato.inRiproduzione && lati.every((l) => !l.pronto || l.el.video.paused || l.el.video.ended) && !stato.attese.size) {
    pausa();
  }
}

// Mentre i video vanno: cursore ed etichetta seguono il video che fa da guida.
// Una volta al secondo si controlla che l'altro video sia in pari: se è rimasto
// indietro o il browser l'ha fermato, lo si rimette al punto giusto.
function cicloCursore() {
  if (!stato.inRiproduzione) return;
  const guida = lati.find((l) => l.pronto && !l.el.video.paused && !l.el.video.ended);
  if (guida) {
    stato.posizione = casellaDi(guida.el.video.currentTime) - guida.scarto;
    aggiornaCursore();
    const ora = performance.now();
    if (ora - stato.ultimoControllo > 1000) {
      stato.ultimoControllo = ora;
      for (const lato of lati) {
        if (lato === guida || !lato.pronto) continue;
        const voluta = lato.scarto + stato.posizione;
        if (voluta < 0 || voluta >= ultimaCasella(lato)) continue; // non ancora partito o già finito
        const video = lato.el.video;
        if (Math.abs(casellaDi(video.currentTime) - voluta) > SCARTO_MAX_RIPRODUZIONE) {
          video.currentTime = tempoCasella(voluta, video.duration);
        }
        if (video.paused && !stato.attese.size) video.play().catch(() => {});
      }
    }
  }
  requestAnimationFrame(cicloCursore);
}

// Ogni video ridisegna il proprio scheletro a ogni fotogramma mostrato
function cicloDisegno(lato) {
  const video = lato.el.video;
  if ("requestVideoFrameCallback" in video) {
    const passo = (_ora, info) => {
      disegnaLato(lato, info.mediaTime);
      if (!video.paused && !video.ended) video.requestVideoFrameCallback(passo);
    };
    video.requestVideoFrameCallback(passo);
  } else {
    const passo = () => {
      disegnaLato(lato);
      if (!video.paused && !video.ended) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }
}

function disegnaLato(lato, t = lato.el.video.currentTime) {
  if (!comuni.mostraScheletro.checked || !lato.campioni.length) {
    disegnaScheletro(lato.el.tela, { campione: null });
    return;
  }
  const i = Math.min(lato.campioni.length - 1, Math.max(0, casellaDi(t)));
  const conMisure = comuni.mostraMisure.checked;
  const f = conMisure ? lato.misure?.fotogrammi[i] : null;
  disegnaScheletro(lato.el.tela, {
    campione: lato.campioni[i],
    // le misure si mostrano solo mentre la persona cammina dritta
    misura: f?.valido && f.inCammino ? f : null,
    lampo: conMisure ? lato.lampi[i] : null,
  });
}

// ---------- Pagella a confronto ----------

function mostraPagellaConfronto() {
  const [prima, dopo] = lati;
  if (!prima.misure || !dopo.misure) {
    comuni.pagella.hidden = true;
    return;
  }
  const NOMI_ESITO = { migliorato: "Migliorato", peggiorato: "Peggiorato", uguale: "Uguale" };
  const cella = (quando, voce) => `
    <div class="valore">
      <span class="quando">${quando}</span>
      <span><span class="pallino-livello ${voce?.livello ?? "neutro"}"></span>${voce?.breve ?? "non valutabile"}</span>
    </div>`;
  const righe = prima.misure.pagella.map((vocePrima) => {
    const voceDopo = dopo.misure.pagella.find((v) => v.chiave === vocePrima.chiave);
    const { esito } = confrontaVoci(vocePrima, voceDopo);
    return `
      <article class="riga-confronto">
        <h3>${vocePrima.titolo}</h3>
        <div class="valori">
          ${cella("Prima", vocePrima)}
          ${cella("Dopo", voceDopo)}
          <span class="esito ${esito ?? "neutro"}">${NOMI_ESITO[esito] ?? "Non confrontabile"}</span>
        </div>
      </article>`;
  }).join("");
  comuni.pagella.innerHTML = `
    <h2>Misure a confronto</h2>
    ${righe}
    <p class="nota">Per tutte le misure, un valore più basso è meglio. Differenze piccole (sotto 1-3 gradi, punti o centimetri, secondo la misura) contano come "uguale": sono dentro l'errore di misura.</p>`;
  comuni.pagella.hidden = false;
}

// ---------- Comandi ----------

comuni.bottonePlay.addEventListener("click", () => (stato.inRiproduzione ? pausa() : play()));
comuni.bottoneIndietro.addEventListener("click", () => spostaDiFotogrammi(-1));
comuni.bottoneAvanti.addEventListener("click", () => spostaDiFotogrammi(1));
comuni.cursore.addEventListener("input", () => {
  pausa();
  stato.posizione = Math.round(Number(comuni.cursore.value) * ANALISI_FPS);
  vaiAllaPosizione();
});
comuni.velocita.addEventListener("click", (evento) => {
  const bottone = evento.target.closest("[data-velocita]");
  if (!bottone) return;
  pausa();
  for (const lato of lati) lato.el.video.playbackRate = Number(bottone.dataset.velocita);
  for (const b of comuni.velocita.querySelectorAll("[data-velocita]")) b.classList.toggle("attivo", b === bottone);
});
document.querySelectorAll("[data-appoggio]").forEach((bottone) => {
  bottone.addEventListener("click", () => vaiAllAppoggio(bottone.dataset.appoggio, Number(bottone.dataset.verso)));
});
comuni.bottoneAllinea.addEventListener("click", allineaAlPrimoPasso);
for (const interruttore of [comuni.mostraScheletro, comuni.mostraMisure]) {
  interruttore.addEventListener("change", () => lati.forEach((l) => disegnaLato(l)));
}

// Tastiera (utile da computer): spazio play/pausa, frecce un fotogramma
document.addEventListener("keydown", (evento) => {
  if (stato.inAnalisi || !lati.some((l) => l.pronto) || evento.target.matches("input")) return;
  if (evento.key === " " && !evento.target.matches("button")) { evento.preventDefault(); comuni.bottonePlay.click(); }
  if (evento.key === "ArrowLeft") { evento.preventDefault(); spostaDiFotogrammi(-1); }
  if (evento.key === "ArrowRight") { evento.preventDefault(); spostaDiFotogrammi(1); }
});

// ---------- Interfaccia ----------

function aggiornaInterfaccia() {
  const occupato = !!stato.inAnalisi;
  for (const lato of lati) {
    const questo = stato.inAnalisi === lato;
    lato.el.scelta.classList.toggle("disabilitato", occupato);
    lato.el.input.disabled = occupato;
    lato.el.analizza.hidden = !lato.pronto;
    lato.el.analizza.disabled = !stato.modelloPronto || (occupato && !questo);
    lato.el.analizza.textContent = questo ? "Annulla" : lato.analizzato ? "Analizza di nuovo" : "Analizza";
    lato.el.avanzamento.hidden = !questo;
  }
  const conVideo = lati.some((l) => l.pronto) && !occupato;
  const conMisure = lati.some((l) => l.misure) && !occupato;
  for (const b of [comuni.cursore, comuni.bottoneIndietro, comuni.bottonePlay, comuni.bottoneAvanti,
                   comuni.mostraScheletro, comuni.mostraMisure, ...comuni.velocita.querySelectorAll("button")]) {
    b.disabled = !conVideo;
  }
  for (const b of [comuni.bottoneAllinea, ...document.querySelectorAll("[data-appoggio]")]) b.disabled = !conMisure;
  comuni.iconaPlay.hidden = stato.inRiproduzione;
  comuni.iconaPausa.hidden = !stato.inRiproduzione;
  comuni.bottonePlay.setAttribute("aria-label", stato.inRiproduzione ? "Pausa" : "Riproduci");
}

function scriviStato(lato, testo, tipo = "") {
  lato.el.statoLato.textContent = testo;
  lato.el.statoLato.className = `stato-lato ${tipo}`;
}

function mostraStatoModello(testo, tipo = "") {
  comuni.statoModello.textContent = testo;
  comuni.statoModello.className = tipo;
}

const formattaSecondi = (s) => (isFinite(s) ? s.toFixed(1).replace(".", ",") : "0,0");

async function avvia() {
  aggiornaInterfaccia();
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

avvia();
