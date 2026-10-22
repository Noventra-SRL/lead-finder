/*
 * Lead Finder dalla chat (prove in sviluppo): comandi per cercare aziende, verificarne i siti, elencarle e valutarle
 * da una sessione di Claude Code, parlando con l'API locale avviata (`npm run dev:api`). Nessuna chiave AI: la
 * valutazione la scrive chi usa la chat, e il server la valida e calcola il punteggio come per il modello.
 *
 *   npm run chat -- accedi --email staff@noventra.it --password …   (sessione salvata in .data/chat/cookie)
 *   npm run chat -- categorie
 *   npm run chat -- cerca --comune Pozzuoli --categorie ristorazione,ospitalita [--raggio 2] [--max 200]
 *   npm run chat -- stato
 *   npm run chat -- verifica-siti [--n 30]                          audit dei siti delle aziende ancora da verificare
 *   npm run chat -- riprendi-verifica                               riprende una verifica in pausa (es. dopo un riavvio)
 *   npm run chat -- aziende [--n 20] [--comune Pozzuoli] [--q testo]
 *   npm run chat -- da-valutare [--n 5] [--ids id1,id2]             scrive .data/chat/da-valutare.json
 *   npm run chat -- valuta .data/chat/risposte.json                 [{ "businessId": "…", "output": { … } }]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const API = process.env.LEAD_FINDER_API ?? 'http://127.0.0.1:8810';
const DIR = '.data/chat';
const COOKIE = `${DIR}/cookie`;
mkdirSync(DIR, { recursive: true });

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    comune: { type: 'string' },
    categorie: { type: 'string' },
    raggio: { type: 'string' },
    max: { type: 'string' },
    n: { type: 'string' },
    q: { type: 'string' },
    ids: { type: 'string' },
  },
});
const [command, arg] = positionals;

function cookie(): string {
  try {
    return readFileSync(COOKIE, 'utf8').trim();
  } catch {
    return '';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      cookie: cookie(),
      // stessa origine dell'API: il server accetta le modifiche solo dalla propria origine
      origin: API,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) writeFileSync(COOKIE, set.map((c) => c.split(';')[0]).join('; '));
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error;
    throw new Error(
      `${res.status} ${e?.code ?? ''}: ${e?.message ?? text}${e?.fields ? ` ${JSON.stringify(e.fields)}` : ''}`,
    );
  }
  return data as T;
}

const n = (fallback: number) => Number(opt.n ?? fallback);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Lettura durante l'attesa: un errore di rete temporaneo (API che si riavvia) non interrompe il comando. */
const poll = <T>(path: string) => call<T>('GET', path).catch(() => null);

async function municipalityCode(name: string): Promise<{ code: string; name: string; context: string }> {
  if (/^\d{6}$/.test(name)) return { code: name, name, context: '' };
  const r = await call<{ areas: { type: string; code: string; name: string; context: string }[] }>(
    'GET',
    `/geo/search?q=${encodeURIComponent(name)}`,
  );
  const m = r.areas.find((a) => a.type === 'municipality');
  if (!m) throw new Error(`Comune non trovato: ${name}`);
  return m;
}

type Job = { id: string; status: string; counters?: Record<string, number>; counts?: Record<string, number> };

const commands: Record<string, () => Promise<void>> = {
  async accedi() {
    if (!opt.email || !opt.password) throw new Error('Servono --email e --password.');
    const r = await call<{ user: { displayName: string; role: string } }>('POST', '/auth/login', {
      email: opt.email,
      password: opt.password,
    });
    console.log(`Accesso come ${r.user.displayName} (${r.user.role}). Sessione salvata in ${COOKIE}.`);
  },

  async categorie() {
    const m = await call<{ categories: { id: string; label: string; coverage?: string }[] }>('GET', '/discovery/meta');
    for (const c of m.categories)
      console.log(`${c.id.padEnd(22)} ${c.label}${c.coverage ? ` (copertura ${c.coverage})` : ''}`);
  },

  async cerca() {
    if (!opt.comune || !opt.categorie) throw new Error('Servono --comune e --categorie (vedi «categorie»).');
    const m = await municipalityCode(opt.comune);
    const r = await call<{ job: Job }>('POST', '/discovery/jobs', {
      area: { type: 'municipality', code: m.code },
      ...(opt.raggio ? { radiusKm: Number(opt.raggio) } : {}),
      categories: opt.categorie.split(','),
      maxResults: Number(opt.max ?? 200),
      minCompleteness: 0,
      requireWebsite: false,
    });
    console.log(`Ricerca avviata a ${m.name} ${m.context} (job ${r.job.id}). Attendo la fine…`);
    for (;;) {
      await sleep(5000);
      const job = await poll<{ job: Job }>(`/discovery/jobs/${r.job.id}`).then((x) => x?.job);
      if (!job) continue;
      if (!['pending', 'running'].includes(job.status)) {
        console.log(`Stato: ${job.status}`, JSON.stringify(job.counters ?? job.counts ?? {}));
        return;
      }
    }
  },

  async stato() {
    const s = await call<Record<string, unknown>>('GET', '/discovery/stats');
    console.log(JSON.stringify(s, null, 2));
  },

  async 'verifica-siti'() {
    const list = await call<{ items: { id: string }[] }>(
      'GET',
      `/businesses?website=own&audit=unaudited&pageSize=${Math.min(n(30), 100)}`,
    );
    if (!list.items.length) return console.log('Nessun sito da verificare.');
    const r = await call<{ job: Job; queued: number }>('POST', '/audits/jobs', {
      businessIds: list.items.map((b) => b.id),
      maxPages: 3,
      performance: false,
    });
    console.log(`Verifica avviata per ${r.queued} siti (job ${r.job.id}). Attendo la fine…`);
    for (;;) {
      await sleep(5000);
      const job = await poll<{ job: Job & { progress?: Record<string, number> } }>(`/audits/jobs/${r.job.id}`).then(
        (x) => x?.job,
      );
      if (!job) continue;
      if (!['pending', 'running'].includes(job.status)) {
        console.log(`Stato: ${job.status}`, JSON.stringify(job.progress ?? {}));
        return;
      }
    }
  },

  async 'riprendi-verifica'() {
    const list = await call<{ items: Job[] }>('GET', '/audits/jobs?status=all');
    const paused = list.items.find((j) => j.status === 'paused');
    if (!paused) return console.log('Nessuna verifica in pausa.');
    await call('POST', `/audits/jobs/${paused.id}/resume`);
    console.log(`Verifica ${paused.id} ripresa.`);
  },

  async aziende() {
    const q = new URLSearchParams({ pageSize: String(Math.min(n(20), 100)), sort: 'commercial', dir: 'desc' });
    if (opt.q) q.set('q', opt.q);
    if (opt.comune) q.set('municipality', (await municipalityCode(opt.comune)).code);
    const list = await call<{
      total: number;
      items: {
        id: string;
        name: string;
        sector?: { label: string } | null;
        categoryLabel: string;
        website?: { domain: string | null } | null;
        contacts: { email: string | null; phone: string | null };
        commercial?: { score: number; source: string; band?: { label: string } | null } | null;
      }[];
    }>('GET', `/businesses?${q}`);
    console.log(`${list.total} aziende (mostrate ${list.items.length}, per punteggio commerciale):`);
    for (const b of list.items)
      console.log(
        [
          b.id,
          b.name,
          b.sector?.label ?? b.categoryLabel,
          b.commercial
            ? `${b.commercial.score} ${b.commercial.band?.label ?? ''} (${b.commercial.source})`
            : 'non valutata',
          b.website?.domain ?? 'senza sito',
          b.contacts.email ?? 'senza email',
        ].join(' | '),
      );
  },

  async 'da-valutare'() {
    const q = new URLSearchParams({ limit: String(Math.min(n(5), 20)) });
    if (opt.ids) q.set('ids', opt.ids);
    const r = await call<{
      system: string;
      schema: unknown;
      items: { businessId: string; name: string; prompt: string }[];
    }>('GET', `/ai/chat/pending?${q}`);
    const file = `${DIR}/da-valutare.json`;
    writeFileSync(file, JSON.stringify(r, null, 2));
    console.log(`${r.items.length} aziende da valutare scritte in ${file}:`);
    for (const i of r.items) console.log(`  ${i.businessId}  ${i.name}`);
  },

  async valuta() {
    if (!arg) throw new Error('Indica il file con le risposte: [{ "businessId": "…", "output": { … } }].');
    const answers = JSON.parse(readFileSync(arg, 'utf8')) as { businessId: string; output: unknown }[];
    for (const a of answers) {
      const r = await call<{
        outcome: { status: string; code?: string; message?: string };
        assessment?: { current?: { score?: number; band?: { label: string } } | null } | null;
      }>('POST', '/ai/chat/assessments', a);
      const cur = r.assessment?.current;
      console.log(
        `${a.businessId}: ${r.outcome.status}${r.outcome.message ? ` — ${r.outcome.message}` : ''}${cur?.score !== undefined ? ` — punteggio ${cur.score} ${cur.band?.label ?? ''}` : ''}`,
      );
    }
  },
};

const run = command ? commands[command] : undefined;
if (!run) {
  console.log(`Comandi: ${Object.keys(commands).join(', ')}`);
  process.exit(command ? 1 : 0);
}
try {
  await run();
} catch (error) {
  console.error(`Errore: ${(error as Error).message}`);
  process.exit(1);
}
