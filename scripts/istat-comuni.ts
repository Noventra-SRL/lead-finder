import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * Genera server/geo/istat.json dall'elenco ufficiale ISTAT dei comuni italiani
 * ("Codici statistici delle unità amministrative territoriali", licenza CC BY 4.0).
 *
 *   node scripts/istat-comuni.ts                 scarica il file da istat.it
 *   node scripts/istat-comuni.ts percorso.csv    usa un file già scaricato
 *
 * Il file generato va versionato: l'applicazione non dipende da istat.it per funzionare.
 * Modifiche rispetto all'originale: solo selezione delle colonne (codici, denominazioni, sigla, tipologia),
 * conversione da Latin-1 a UTF-8 e formato JSON compatto.
 */

const SOURCE_URL = 'https://www.istat.it/storage/codici-unita-amministrative/Elenco-comuni-italiani.csv';
const OUT = fileURLToPath(new URL('../server/geo/istat.json', import.meta.url));

async function load(): Promise<string> {
  const path = process.argv[2];
  if (path) return new TextDecoder('latin1').decode(readFileSync(path));
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'NoventraLeadFinder (aggiornamento dati ISTAT)' } });
  if (!res.ok) throw new Error(`Download non riuscito: HTTP ${res.status}`);
  return new TextDecoder('latin1').decode(await res.arrayBuffer());
}

const text = await load();
// l'intestazione contiene a capo tra virgolette: si considerano solo le righe di dati (iniziano con i codici)
const rows = text
  .split(/\r?\n/)
  .filter((l) => /^\d{2};\d{3};\d{3};\d{3};\d{6};/.test(l))
  .map((l) => l.split(';'));
if (rows.length < 7000) throw new Error(`Formato inatteso: solo ${rows.length} comuni letti.`);

const regions = new Map<string, string>();
const provinces = new Map<string, [string, string, string, string, number]>();
const municipalities: [string, string, string, string?][] = [];
for (const r of rows) {
  const [regionCode, utsCode, , , code, fullName, italianName, , , , regionName, utsName, utsType, , sigla] =
    r as string[];
  regions.set(regionCode!, regionName!.trim());
  provinces.set(utsCode!, [utsCode!, utsName!.trim(), sigla!.trim(), regionCode!, Number(utsType)]);
  const alt = fullName!.trim() !== italianName!.trim() ? fullName!.trim() : undefined;
  municipalities.push(alt ? [code!, italianName!.trim(), utsCode!, alt] : [code!, italianName!.trim(), utsCode!]);
}

const data = {
  meta: {
    source: 'ISTAT — Codici statistici delle unità amministrative territoriali (Elenco comuni italiani)',
    url: SOURCE_URL,
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.it',
    changes: 'Selezione delle colonne e conversione in JSON',
    generatedAt: new Date().toISOString().slice(0, 10),
    counts: { regions: regions.size, provinces: provinces.size, municipalities: municipalities.length },
  },
  regions: [...regions].sort(([a], [b]) => a.localeCompare(b)),
  provinces: [...provinces.values()].sort((a, b) => a[0].localeCompare(b[0])),
  municipalities: municipalities.sort((a, b) => a[0].localeCompare(b[0])),
};
writeFileSync(OUT, JSON.stringify(data) + '\n');
console.log(`Scritto ${OUT}: ${JSON.stringify(data.meta.counts)}`);
