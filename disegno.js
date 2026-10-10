// Disegno dello scheletro e delle misure sopra il video.
// Lo usano sia la pagina di analisi sia quella di confronto.

export const SOGLIA_VISIBILITA = 0.5; // sotto questa soglia un punto non si disegna

// Indici dei punti nel modello MediaPipe. Sinistra e destra sono quelle della persona.
export const PUNTO = {
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
const LARGHEZZA_MIN_ETICHETTE = 260; // sotto questa larghezza a schermo i cartellini non ci stanno

// Disegna un fotogramma.
// campione: { punti } del fotogramma, o null
// misura:   le misure di quel fotogramma se la persona sta camminando, altrimenti null
// lampo:    { sx, dx } talloni che hanno appena toccato terra, o null
export function disegnaScheletro(tela, { campione, misura = null, lampo = null }) {
  const ctx = tela.getContext("2d");
  const L = tela.width;
  const A = tela.height;
  ctx.clearRect(0, 0, L, A);
  if (!campione) return;

  // pixel della tela per ogni pixel dello schermo: linee e scritte restano leggibili a ogni grandezza
  const scala = tela.clientWidth ? L / tela.clientWidth : 1;
  const spessore = Math.max(Math.min(L, A) / 140, 2.2 * scala);
  const visibile = (i) => campione.punti[i].v >= SOGLIA_VISIBILITA;
  const pos = (i) => [campione.punti[i].x * L, campione.punti[i].y * A];
  const coloreLivello = (liv) => (liv ? SEMAFORO[liv] : COLORE.centro);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Ogni linea ha un bordo scuro sotto, così si legge su qualsiasi sfondo
  const tratto = (punti, colore, tratteggio = []) => {
    for (const [larghezza, stile] of [[spessore + 1.5 * scala, "rgba(0,0,0,0.55)"], [spessore, colore]]) {
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
  const corpoTesto = Math.round(Math.max(Math.min(L, A) / 26, 11 * scala));
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
  const conEtichette = !tela.clientWidth || tela.clientWidth >= LARGHEZZA_MIN_ETICHETTE;
  if (misura && conEtichette && busto.every(visibile)) {
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

// I talloni che toccano terra si evidenziano per qualche fotogramma dopo l'appoggio
export function calcolaLampi(misure, numeroFotogrammi, durata = 6) {
  const lampi = Array.from({ length: numeroFotogrammi }, () => ({ sx: false, dx: false }));
  for (const lato of ["sx", "dx"]) {
    for (const volo of misure.voli[lato]) {
      for (let i = volo.atterraggio; i < Math.min(numeroFotogrammi, volo.atterraggio + durata); i++) lampi[i][lato] = true;
    }
  }
  return lampi;
}
