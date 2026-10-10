// Misure della camminata (tappa 2a), calcolate dai punti del corpo già trovati.
// Vale per video girati da dietro o di fronte. Angoli in gradi;
// "sinistra" e "destra" sono sempre quelle della persona.

// Limiti del semaforo: valori indicativi, da tarare con il trainer.
export const SOGLIE = {
  // pagella (valori medi)
  busto: { giallo: 2, rosso: 4 },        // pendenza laterale media del busto
  spalle: { giallo: 2, rosso: 4 },       // dislivello medio delle spalle
  bacino: { giallo: 5, rosso: 8 },       // caduta dell'anca opposta in appoggio su una gamba
  // in 2D, di fronte, qualche grado di ginocchio "storto" è normale (rotazione dell'anca, piega del ginocchio)
  ginocchio: { giallo: 8, rosso: 12 },   // ginocchio verso l'interno o l'esterno in appoggio
  appoggio: { giallo: 5, rosso: 10 },    // differenza % del tempo sul piede tra destra e sinistra
  ondeggiamento: { giallo: 10, rosso: 14 }, // oscillazione laterale del bacino a ogni passo (cm)
  // colori sul video, istante per istante
  bustoIstante: { giallo: 3, rosso: 6 },
  spalleIstante: { giallo: 3, rosso: 6 },
  bacinoIstante: { giallo: 5, rosso: 8 },
  ginocchioIstante: { giallo: 8, rosso: 12 },
};

const PUNTI_CHIAVE = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const VISIBILITA_MIN = 0.5;
// larghezza spalle / lunghezza busto: sotto questo valore la persona è di profilo (si sta girando)
const RAPPORTO_SPALLE_MIN = 0.45;
// lunghezza indicativa spalle-anche, per tradurre gli spostamenti in centimetri
const BUSTO_CM = 50;
// velocità minima del tallone (lunghezze del busto al secondo) per riconoscere un passo
const VELOCITA_VOLO_MIN = 0.6;
const TRATTO_MIN_S = 0.7;     // un tratto di camminata più corto non si usa
const BUCO_MAX = 3;           // fotogrammi mancanti tollerati dentro un tratto
const PASSO_MAX_S = 1.5;      // tra due appoggi più distanti di così la persona si è fermata
const PASSO_MIN_S = 0.3;      // due appoggi più vicini di così sono rumore, non un passo

const LATI = {
  sx: { anca: 23, ginocchio: 25, caviglia: 27, tallone: 29, punta: 31 },
  dx: { anca: 24, ginocchio: 26, caviglia: 28, tallone: 30, punta: 32 },
};

export function livello(valore, soglia) {
  if (valore === null || Number.isNaN(valore)) return null;
  const a = Math.abs(valore);
  return a >= soglia.rosso ? "rosso" : a >= soglia.giallo ? "giallo" : "verde";
}

// Differenza minima tra prima e dopo per parlare di cambiamento: sotto è rumore di misura.
const CAMBIAMENTO_MIN = { appoggio: 3, busto: 1, spalle: 1, bacino: 1, ginocchia: 2, ondeggiamento: 2 };

// Confronta la stessa misura di due video. Per tutte le misure "meno è meglio".
export function confrontaVoci(prima, dopo) {
  if (prima?.valore == null || dopo?.valore == null) return { esito: null };
  const differenza = dopo.valore - prima.valore;
  const minimo = CAMBIAMENTO_MIN[prima.chiave] ?? 1;
  const esito = Math.abs(differenza) < minimo ? "uguale" : differenza < 0 ? "migliorato" : "peggiorato";
  return { esito, differenza };
}

export function calcolaMisure(campioni, { larghezza: W, altezza: H, fps }) {
  const n = campioni.length;

  // 1. Coordinate in pixel, lisciate per togliere il tremolio
  const X = {}, Y = {};
  for (const k of PUNTI_CHIAVE) {
    X[k] = liscia(campioni.map((c) => (c ? c.punti[k].x * W : NaN)));
    Y[k] = liscia(campioni.map((c) => (c ? c.punti[k].y * H : NaN)));
  }
  const p = (k, i) => ({ x: X[k][i], y: Y[k][i] });

  // 2. Fotogramma per fotogramma: è utilizzabile? da che parte guarda? quanto valgono gli angoli?
  const f = campioni.map((c, i) => {
    if (!c) return null;
    const dentro = PUNTI_CHIAVE.every((k) => {
      const q = c.punti[k];
      return q.v >= VISIBILITA_MIN && q.x > 0.01 && q.x < 0.99 && q.y > 0.005 && q.y < 0.995;
    });
    const ms = media(p(11, i), p(12, i));
    const mh = media(p(23, i), p(24, i));
    const busto = distanza(ms, mh);
    const larghezzaSpalle = X[11][i] - X[12][i];
    const larghezzaAnche = X[23][i] - X[24][i];
    // u = verso, nell'immagine, del fianco sinistro della persona (+1 a destra, -1 a sinistra)
    const u = Math.sign(larghezzaSpalle + larghezzaAnche) || 1;
    const valido = dentro && busto > 0
      && Math.sign(larghezzaSpalle) === Math.sign(larghezzaAnche)
      && Math.abs(larghezzaSpalle) / busto >= RAPPORTO_SPALLE_MIN;
    if (!valido) return { valido: false };
    return {
      valido: true,
      // di fronte la sinistra della persona appare a destra nell'immagine
      verso: u > 0 ? "fronte" : "spalle",
      u,
      busto,
      // + = busto che pende verso la sinistra della persona
      inclinazione: gradi(Math.atan2((ms.x - mh.x) * u, mh.y - ms.y)),
      // + = spalla / anca sinistra più bassa
      spalle: gradi(Math.atan2(Y[11][i] - Y[12][i], Math.abs(larghezzaSpalle))),
      bacino: gradi(Math.atan2(Y[23][i] - Y[24][i], Math.abs(larghezzaAnche))),
      // + = ginocchio verso l'interno (valgo), - = verso l'esterno (varo)
      ginocchio: {
        sx: angoloGinocchio(p(23, i), p(25, i), p(27, i), -u),
        dx: angoloGinocchio(p(24, i), p(26, i), p(28, i), u),
      },
      // posizione laterale del bacino in lunghezze del busto (+ = verso la sinistra della persona)
      laterale: ((mh.x - W / 2) / busto) * u,
      appoggio: { sx: false, dx: false },
      inCammino: false,
    };
  });

  // 3. Tratti di camminata dritta: fotogrammi validi consecutivi con lo stesso verso
  const tratti = trovaTratti(f, fps);

  // 4. Passi. Col telefono fermo il tallone appoggiato resta fermo nell'immagine,
  //    quello in volo corre: ogni picco di velocità del tallone è un passo, e il
  //    momento in cui il tallone si ferma dopo il picco è l'appoggio a terra.
  //    (Lo stacco della punta invece si confonde: di fronte o di spalle il piede
  //    si alza e avanza insieme, e nell'immagine i due movimenti quasi si annullano.)
  const voli = { sx: [], dx: [] }; // il piede è in aria da "stacco" ad "atterraggio" - 1
  for (const tratto of tratti) {
    const candidati = [];
    for (const lato of ["sx", "dx"]) {
      const { tallone } = LATI[lato];
      const v = [];
      for (let i = tratto.inizio; i <= tratto.fine; i++) {
        const prima = Math.max(tratto.inizio, i - 1);
        const dopo = Math.min(tratto.fine, i + 1);
        v.push((distanza(p(tallone, dopo), p(tallone, prima)) / (dopo - prima || 1) / f[i].busto) * fps);
      }
      for (const [a, b, picco] of trovaVoli(v, VELOCITA_VOLO_MIN)) {
        candidati.push({ lato, stacco: tratto.inizio + a, atterraggio: tratto.inizio + b + 1, picco });
      }
    }
    // I piedi si alternano: due "passi" di fila dello stesso piede vogliono dire che uno
    // è un falso allarme (il tallone appoggiato che scivola un po'). Si tiene il più netto.
    candidati.sort((a, b) => a.stacco - b.stacco);
    const tenuti = [];
    for (const c of candidati) {
      const ultimo = tenuti[tenuti.length - 1];
      if (ultimo && ultimo.lato === c.lato) {
        if (c.picco > ultimo.picco) tenuti[tenuti.length - 1] = c;
      } else {
        tenuti.push(c);
      }
    }
    for (const c of tenuti) voli[c.lato].push({ stacco: c.stacco, atterraggio: c.atterraggio });
  }
  for (const lato of ["sx", "dx"]) {
    voli[lato].sort((a, b) => a.stacco - b.stacco);
    for (const volo of voli[lato]) for (let i = volo.stacco; i < volo.atterraggio; i++) f[i].inVolo = lato;
  }
  for (const tratto of tratti) {
    for (let i = tratto.inizio; i <= tratto.fine; i++) {
      // "in cammino" = entro un secondo c'è almeno un passo (esclude la persona ferma)
      let passo = false;
      for (let j = Math.max(tratto.inizio, i - fps); j <= Math.min(tratto.fine, i + fps) && !passo; j++) passo = !!f[j].inVolo;
      f[i].inCammino = passo;
      if (passo) f[i].appoggio = { sx: f[i].inVolo !== "sx", dx: f[i].inVolo !== "dx" };
    }
  }

  // Tempo su ciascun piede: dall'appoggio di un piede all'appoggio dell'altro
  const atterraggi = [];
  for (const lato of ["sx", "dx"]) for (const volo of voli[lato]) atterraggi.push({ lato, i: volo.atterraggio });
  atterraggi.sort((a, b) => a.i - b.i);
  const tempiSulPiede = { sx: [], dx: [] };
  for (let k = 0; k + 1 < atterraggi.length; k++) {
    const a = atterraggi[k], b = atterraggi[k + 1];
    const stessoTratto = tratti.some((t) => a.i >= t.inizio && b.i <= t.fine);
    const durata = (b.i - a.i) / fps;
    if (stessoTratto && a.lato !== b.lato && durata >= PASSO_MIN_S && durata <= PASSO_MAX_S) {
      tempiSulPiede[a.lato].push({ durata, inizio: a.i, fine: b.i });
    }
  }

  // 5. Colori istante per istante
  for (const x of f) {
    if (!x?.valido) continue;
    x.livelli = {
      busto: livello(x.inclinazione, SOGLIE.bustoIstante),
      spalle: livello(x.spalle, SOGLIE.spalleIstante),
      bacino: livello(x.bacino, SOGLIE.bacinoIstante),
      ginocchioSx: x.appoggio.sx ? livello(x.ginocchio.sx, SOGLIE.ginocchioIstante) : null,
      ginocchioDx: x.appoggio.dx ? livello(x.ginocchio.dx, SOGLIE.ginocchioIstante) : null,
    };
  }

  // 6. Pagella
  const inCammino = [];
  f.forEach((x, i) => { if (x?.valido && x.inCammino) inCammino.push(i); });
  const pagella = [
    misuraAppoggio(tempiSulPiede),
    misuraBusto(f, inCammino),
    misuraSpalle(f, inCammino),
    misuraBacino(f, voli),
    misuraGinocchia(f, voli),
    misuraOndeggiamento(f, tratti, fps),
  ];

  return { fotogrammi: f, tratti, voli, tempiSulPiede, pagella, secondiInCammino: inCammino.length / fps };
}

// ---------- Le singole misure ----------

function misuraAppoggio(tempi) {
  const base = { chiave: "appoggio", titolo: "Su che gamba carica di più" };
  const ns = tempi.sx.length, nd = tempi.dx.length;
  if (ns < 2 || nd < 2) {
    return { ...base, livello: null, frase: "Troppo pochi passi completi per giudicare: serve un tratto di camminata più lungo." };
  }
  const ms = mediaDi(tempi.sx.map((a) => a.durata));
  const md = mediaDi(tempi.dx.map((a) => a.durata));
  const differenza = (Math.abs(ms - md) / Math.min(ms, md)) * 100;
  const lato = md > ms ? "dx" : "sx";
  const lungo = tempi[lato].reduce((x, y) => (y.durata > x.durata ? y : x));
  const frase = differenza < SOGLIE.appoggio.giallo
    ? `Carica in modo simile sulle due gambe: circa ${sec(ms)} s sul piede sinistro e ${sec(md)} s sul destro a ogni passo.`
    : `Resta più tempo sul piede ${nomeLato(lato)}: ${sec(lato === "dx" ? md : ms)} s contro ${sec(lato === "dx" ? ms : md)} s a ogni passo, il ${num(differenza, 0)}% in più.`;
  return {
    ...base,
    livello: livello(differenza, SOGLIE.appoggio),
    valore: differenza,
    breve: differenza < SOGLIE.appoggio.giallo ? `pari (${num(differenza, 0)}%)` : `${nomeLato(lato)} +${num(differenza, 0)}%`,
    frase,
    dettaglio: `Passi contati: ${ns + nd}. Tempo misurato da quando il tallone tocca terra a quando tocca terra l'altro.`,
    momento: lungo.inizio,
  };
}

function misuraBusto(f, indici) {
  const base = { chiave: "busto", titolo: "Busto" };
  if (!indici.length) return { ...base, livello: null, frase: "Nessun tratto di camminata utilizzabile." };
  const m = mediaDi(indici.map((i) => f[i].inclinazione));
  const peggiore = indici.reduce((a, b) => (Math.abs(f[b].inclinazione) > Math.abs(f[a].inclinazione) ? b : a));
  const frase = Math.abs(m) < 0.5
    ? "Resta dritto: in media non pende da nessun lato."
    : `Pende in media di ${num(Math.abs(m))}° verso ${m > 0 ? "sinistra" : "destra"}.`;
  return {
    ...base,
    livello: livello(m, SOGLIE.busto),
    valore: Math.abs(m),
    breve: Math.abs(m) < 0.5 ? "dritto" : `${num(Math.abs(m))}° a ${m > 0 ? "sinistra" : "destra"}`,
    frase,
    dettaglio: `Punta massima: ${num(Math.abs(f[peggiore].inclinazione))}° verso ${f[peggiore].inclinazione > 0 ? "sinistra" : "destra"}.`,
    momento: peggiore,
  };
}

function misuraSpalle(f, indici) {
  const base = { chiave: "spalle", titolo: "Spalle" };
  if (!indici.length) return { ...base, livello: null, frase: "Nessun tratto di camminata utilizzabile." };
  const m = mediaDi(indici.map((i) => f[i].spalle));
  const peggiore = indici.reduce((a, b) => (Math.abs(f[b].spalle) > Math.abs(f[a].spalle) ? b : a));
  const frase = Math.abs(m) < 0.5
    ? "Le spalle stanno alla stessa altezza."
    : `La spalla ${m > 0 ? "sinistra" : "destra"} sta in media ${num(Math.abs(m))}° più bassa.`;
  return {
    ...base,
    livello: livello(m, SOGLIE.spalle),
    valore: Math.abs(m),
    breve: Math.abs(m) < 0.5 ? "pari" : `${num(Math.abs(m))}°, più bassa la ${m > 0 ? "sinistra" : "destra"}`,
    frase,
    momento: peggiore,
  };
}

// Mentre un piede è in volo, la persona sta in appoggio su una gamba sola: l'altra.
const gambaInAppoggio = (latoInVolo) => (latoInVolo === "sx" ? "dx" : "sx");

function misuraBacino(f, voli) {
  const base = { chiave: "bacino", titolo: "Bacino" };
  // per ogni appoggio su una gamba sola: quanto scende l'anca della gamba in volo
  const cadute = { sx: [], dx: [] }; // indicizzate per gamba in appoggio
  let peggiore = null, valorePeggiore = -Infinity;
  for (const latoInVolo of ["sx", "dx"]) {
    const segno = latoInVolo === "sx" ? 1 : -1; // bacino + = anca sinistra più bassa
    for (const volo of voli[latoInVolo]) {
      let massimo = -Infinity, dove = null;
      for (let i = volo.stacco; i < volo.atterraggio; i++) {
        const caduta = f[i].bacino * segno;
        if (caduta > massimo) { massimo = caduta; dove = i; }
      }
      if (dove !== null) {
        cadute[gambaInAppoggio(latoInVolo)].push(massimo);
        if (massimo > valorePeggiore) { valorePeggiore = massimo; peggiore = dove; }
      }
    }
  }
  if (cadute.sx.length < 2 || cadute.dx.length < 2) {
    return { ...base, livello: null, frase: "Troppo pochi passi completi per giudicare." };
  }
  const suSx = mediaDi(cadute.sx); // appoggiato a sinistra, scende l'anca destra
  const suDx = mediaDi(cadute.dx);
  const descrivi = (v, anca) => (v > 0 ? `l'anca ${anca} scende di ${num(v)}°` : `l'anca ${anca} non scende`);
  const caduta = Math.max(suSx, suDx, 0);
  return {
    ...base,
    livello: livello(caduta, SOGLIE.bacino),
    valore: caduta,
    breve: caduta < 0.5 ? "non scende" : `scende ${num(caduta)}°`,
    frase: `In appoggio sulla destra ${descrivi(suDx, "sinistra")}; in appoggio sulla sinistra ${descrivi(suSx, "destra")}.`,
    momento: peggiore,
  };
}

function misuraGinocchia(f, voli) {
  const base = { chiave: "ginocchia", titolo: "Ginocchia" };
  const valori = { sx: [], dx: [] };
  let peggiore = null, valorePeggiore = -1;
  for (const latoInVolo of ["sx", "dx"]) {
    const lato = gambaInAppoggio(latoInVolo);
    // per ogni appoggio su una gamba sola, l'allineamento tipico del ginocchio sotto carico (mediana)
    for (const volo of voli[latoInVolo]) {
      const serie = [];
      for (let i = volo.stacco; i < volo.atterraggio; i++) {
        serie.push(f[i].ginocchio[lato]);
        if (Math.abs(f[i].ginocchio[lato]) > valorePeggiore) { valorePeggiore = Math.abs(f[i].ginocchio[lato]); peggiore = i; }
      }
      valori[lato].push(mediana(serie));
    }
  }
  if (valori.sx.length < 2 || valori.dx.length < 2) {
    return { ...base, livello: null, frase: "Troppo pochi passi completi per giudicare." };
  }
  const ms = mediaDi(valori.sx), md = mediaDi(valori.dx);
  const descrivi = (v, nome) => (Math.abs(v) < 1 ? `il ${nome} resta allineato` : `il ${nome} va ${num(Math.abs(v))}° verso ${v > 0 ? "l'interno" : "l'esterno"}`);
  const maggiore = Math.abs(ms) > Math.abs(md) ? ms : md;
  const latoMaggiore = maggiore === ms ? "sinistro" : "destro";
  return {
    ...base,
    livello: livello(maggiore, SOGLIE.ginocchio),
    valore: Math.abs(maggiore),
    breve: Math.abs(maggiore) < 1 ? "allineate" : `${latoMaggiore} ${num(Math.abs(maggiore))}° ${maggiore > 0 ? "all'interno" : "all'esterno"}`,
    frase: `In appoggio ${descrivi(md, "destro")}, ${descrivi(ms, "sinistro")}.`,
    momento: peggiore,
  };
}

// Quanto oscilla il bacino da un lato all'altro. Si toglie l'andamento generale del
// percorso, che dipende da come è puntato il telefono, e resta l'oscillazione dei passi.
function misuraOndeggiamento(f, tratti, fps) {
  const base = { chiave: "ondeggiamento", titolo: "Ondeggiamento" };
  const scarti = [];
  let peggiore = null, valorePeggiore = -1;
  for (const t of tratti) {
    const punti = [];
    for (let i = t.inizio; i <= t.fine; i++) if (f[i].inCammino) punti.push([i, f[i].laterale]);
    if (punti.length < fps) continue;
    const { pendenza, intercetta } = retta(punti);
    for (const [i, y] of punti) {
      const scarto = y - (intercetta + pendenza * i);
      scarti.push(scarto);
      if (Math.abs(scarto) > valorePeggiore) { valorePeggiore = Math.abs(scarto); peggiore = i; }
    }
  }
  if (scarti.length < fps) return { ...base, livello: null, frase: "Nessun tratto di camminata abbastanza lungo." };
  scarti.sort((a, b) => a - b);
  const cm = (scarti[Math.floor(0.9 * (scarti.length - 1))] - scarti[Math.floor(0.1 * (scarti.length - 1))]) * BUSTO_CM;
  return {
    ...base,
    livello: livello(cm, SOGLIE.ondeggiamento),
    valore: cm,
    breve: `${num(cm, 0)} cm`,
    frase: `A ogni passo il bacino si sposta di circa ${num(cm, 0)} cm da un lato all'altro.`,
    dettaglio: "Stima in centimetri: conta un busto (spalle-anche) di circa 50 cm.",
    momento: peggiore,
  };
}

// ---------- Strumenti ----------

function trovaTratti(f, fps) {
  const tratti = [];
  let corrente = null, buco = 0;
  for (let i = 0; i < f.length; i++) {
    const x = f[i];
    if (x?.valido && (!corrente || x.verso === corrente.verso)) {
      if (!corrente) corrente = { inizio: i, fine: i, verso: x.verso };
      // riempie il buco con l'ultimo fotogramma buono
      for (let j = corrente.fine + 1; j < i; j++) f[j] = { ...f[corrente.fine], appoggio: { sx: false, dx: false }, riempito: true };
      corrente.fine = i;
      buco = 0;
    } else if (corrente && (!x?.valido) && ++buco <= BUCO_MAX) {
      continue;
    } else {
      if (corrente) tratti.push(corrente);
      corrente = x?.valido ? { inizio: i, fine: i, verso: x.verso } : null;
      buco = 0;
    }
  }
  if (corrente) tratti.push(corrente);
  return tratti.filter((t) => (t.fine - t.inizio + 1) / fps >= TRATTO_MIN_S);
}

// Intorno a ogni picco di velocità sopra soglia: l'intervallo [a, b] in cui il tallone
// va almeno al 30% del picco è il volo. Restituisce [a, b, picco].
function trovaVoli(v, soglia) {
  const picchi = [];
  for (let i = 1; i < v.length - 1; i++) {
    if (v[i] >= soglia && v[i] >= v[i - 1] && v[i] > v[i + 1]) picchi.push(i);
  }
  picchi.sort((a, b) => v[b] - v[a]); // prima i picchi più alti
  const preso = new Array(v.length).fill(false);
  const voli = [];
  for (const picco of picchi) {
    if (preso[picco]) continue;
    const limite = 0.3 * v[picco];
    let a = picco, b = picco;
    while (a > 0 && v[a - 1] >= limite && !preso[a - 1]) a--;
    while (b < v.length - 1 && v[b + 1] >= limite && !preso[b + 1]) b++;
    for (let i = a; i <= b; i++) preso[i] = true;
    // un volo tagliato dall'inizio o dalla fine del tratto non è completo
    if (a > 0 && b < v.length - 1) voli.push([a, b, v[picco]]);
  }
  return voli;
}

function liscia(serie, raggio = 2) {
  return serie.map((v, i) => {
    if (Number.isNaN(v)) return NaN;
    let somma = 0, conta = 0;
    for (let j = Math.max(0, i - raggio); j <= Math.min(serie.length - 1, i + raggio); j++) {
      if (!Number.isNaN(serie[j])) { somma += serie[j]; conta++; }
    }
    return somma / conta;
  });
}

function angoloGinocchio(anca, ginocchio, caviglia, mediale) {
  const v1 = { x: anca.x - ginocchio.x, y: anca.y - ginocchio.y };
  const v2 = { x: caviglia.x - ginocchio.x, y: caviglia.y - ginocchio.y };
  const coseno = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
  const deviazione = 180 - gradi(Math.acos(Math.max(-1, Math.min(1, coseno))));
  // da che parte sta il ginocchio rispetto alla linea anca-caviglia
  const xLinea = anca.x + ((caviglia.x - anca.x) * (ginocchio.y - anca.y)) / (caviglia.y - anca.y);
  return deviazione * (Math.sign((ginocchio.x - xLinea) * mediale) || 1);
}

function retta(punti) {
  const mx = mediaDi(punti.map((q) => q[0])), my = mediaDi(punti.map((q) => q[1]));
  let sopra = 0, sotto = 0;
  for (const [x, y] of punti) { sopra += (x - mx) * (y - my); sotto += (x - mx) ** 2; }
  const pendenza = sotto ? sopra / sotto : 0;
  return { pendenza, intercetta: my - pendenza * mx };
}

const media = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distanza = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const gradi = (r) => (r * 180) / Math.PI;
const mediaDi = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const mediana = (v) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const num = (v, cifre = 1) => v.toFixed(cifre).replace(".", ",");
const sec = (v) => num(v, 2);
const nomeLato = (lato) => (lato === "sx" ? "sinistro" : "destro");
