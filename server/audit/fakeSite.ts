import { createServer, type Server } from 'node:http';
import { listenOnFetchablePort } from '../testing.ts';
import type { AddressInfo } from 'node:net';

/*
 * SITI FINTI — SOLO PER I TEST (automatici ed end-to-end). Non fanno parte dell'applicazione.
 * Un server locale che risponde con pagine scritte a mano ("di Prova") per esercitare l'audit senza contattare
 * siti reali. Le risposte si definiscono per percorso; ogni richiesta viene registrata.
 */

export interface FakeRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Ritardo della risposta (per i timeout). */
  delayMs?: number;
}

export interface FakeSite {
  url: string;
  port: number;
  hits: string[];
  routes: Map<string, FakeRoute>;
  close(): Promise<void>;
}

export async function startFakeSite(routes: Record<string, FakeRoute> = {}, port = 0): Promise<FakeSite> {
  const map = new Map(Object.entries(routes));
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('#')[0]!;
    hits.push(path);
    const route = map.get(path) ??
      map.get(path.split('?')[0]!) ?? { status: 404, body: '<html><body><h1>Pagina non trovata</h1></body></html>' };
    const send = () => {
      res.writeHead(route.status ?? 200, { 'Content-Type': 'text/html; charset=utf-8', ...route.headers });
      res.end(route.body ?? '');
    };
    if (route.delayMs) setTimeout(send, route.delayMs);
    else send();
  });
  // porta 0 (test): una porta che fetch() accetta; porta fissa (e2e): quella richiesta
  if (port === 0) await listenOnFetchablePort(server);
  else await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    port: actual,
    hits,
    routes: map,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Pagina principale ben fatta di una farmacia inventata. */
export function goodPharmacyHome(): string {
  return `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8">
<title>Farmacia di Prova — Albano Laziale</title>
<meta name="description" content="Farmacia di Prova ad Albano Laziale: servizi, prenotazioni e consigli per la salute di tutta la famiglia.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="/">
<meta property="og:title" content="Farmacia di Prova">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Pharmacy","name":"Farmacia di Prova","address":{"@type":"PostalAddress","streetAddress":"Via di Prova 1"},"openingHours":"Mo-Sa 08:30-19:30"}</script>
<script src="https://cdn.iubenda.com/cs/iubenda_cs.js"></script>
</head><body>
<header><nav><a href="/servizi">Servizi</a> <a href="/contatti">Contatti</a> <a href="/privacy">Privacy</a> <a href="/cookie-policy">Cookie policy</a></nav></header>
<h1>Farmacia di Prova</h1>
<p>${'La nostra farmacia offre consulenza, misurazione della pressione, autoanalisi e prodotti di dermocosmesi. '.repeat(8)}</p>
<p>Orari: lun-sab 08:30 - 19:30. Via di Prova 1, 00041 Albano Laziale.</p>
<a href="tel:+390600000000">Chiamaci</a> <a href="/prenota">Prenota un servizio</a>
<img src="/logo.png" alt="Logo della farmacia" width="120" height="60">
<a href="https://www.facebook.com/farmaciadiprova">Facebook</a>
</body></html>`;
}

/** Pagina principale datata e incompleta di un ristorante inventato. */
export function poorRestaurantHome(): string {
  return `<html><head><title>Benvenuti</title></head><body>
<table width="980"><tr><td><table><tr><td>
<font face="Arial">Trattoria di Prova</font>
<img src="/foto1.jpg"><img src="/foto2.jpg"><img src="/foto3.jpg">
<div style="width: 1000px">contenuto</div>
<a href="/chi-siamo">Chi siamo</a> <a href="/galleria">Galleria</a>
</td></tr></table></td></tr></table>
</body></html>`;
}
