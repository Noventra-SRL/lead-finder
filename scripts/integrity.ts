import { loadConfig } from '../server/config.ts';
import { openDatabase } from '../server/db/client.ts';

/*
 * Controllo di integrità del database, SOLO IN LETTURA (nessuna scrittura, nessuna pulizia automatica).
 * Uso: npm run db:check   (con PGlite il server deve essere fermo: un solo processo per cartella dei dati).
 * Ogni controllo stampa un numero; quelli marcati «deve essere 0» indicano un'incoerenza da esaminare a mano.
 */

const config = loadConfig(process.env);
const db = await openDatabase(config.database);

const checks: { label: string; sql: string; expectZero?: boolean }[] = [
  { label: 'Aziende (non unite ad altre)', sql: 'SELECT count(*)::int AS n FROM businesses WHERE merged_into IS NULL' },
  {
    label: 'Aziende unite a un’altra (storico)',
    sql: 'SELECT count(*)::int AS n FROM businesses WHERE merged_into IS NOT NULL',
  },
  {
    label: 'Riferimenti di fonte (OSM) distinti',
    sql: 'SELECT count(DISTINCT (provider, provider_ref))::int AS n FROM business_sources',
  },
  {
    label: 'Stesso riferimento di fonte su più aziende attive',
    expectZero: true,
    sql: `SELECT count(*)::int AS n FROM (
            SELECT s.provider, s.provider_ref FROM business_sources s JOIN businesses b ON b.id = s.business_id
             WHERE b.merged_into IS NULL GROUP BY 1, 2 HAVING count(DISTINCT b.id) > 1) x`,
  },
  {
    label: 'Aziende attive senza alcuna fonte',
    expectZero: true,
    sql: `SELECT count(*)::int AS n FROM businesses b WHERE b.merged_into IS NULL
            AND NOT EXISTS (SELECT 1 FROM business_sources s WHERE s.business_id = b.id)`,
  },
  {
    label: 'Possibili duplicati in attesa di revisione manuale',
    sql: "SELECT count(*)::int AS n FROM duplicate_candidates WHERE status = 'pending'",
  },
  {
    label: 'Coppie con stesso nome e comune non segnalate come possibili duplicati',
    sql: `SELECT count(*)::int AS n FROM businesses a JOIN businesses b
            ON a.search_name = b.search_name AND a.municipality_code = b.municipality_code AND a.id < b.id
           WHERE a.merged_into IS NULL AND b.merged_into IS NULL
             AND NOT EXISTS (SELECT 1 FROM duplicate_candidates d
                              WHERE (d.business_a = a.id AND d.business_b = b.id) OR (d.business_a = b.id AND d.business_b = a.id))`,
  },
  {
    label: 'Unione a catena (unita a un’azienda a sua volta unita)',
    expectZero: true,
    sql: `SELECT count(*)::int AS n FROM businesses a JOIN businesses b ON b.id = a.merged_into WHERE b.merged_into IS NOT NULL`,
  },
  {
    label: 'Opportunità aperte su aziende unite',
    expectZero: true,
    sql: `SELECT count(*)::int AS n FROM crm_opportunities o JOIN businesses b ON b.id = o.business_id
           WHERE b.merged_into IS NOT NULL AND o.stage NOT IN ('vinto', 'perso', 'non_contattare')`,
  },
  {
    label: 'Aziende con più di un’opportunità aperta',
    expectZero: true,
    sql: `SELECT count(*)::int AS n FROM (SELECT business_id FROM crm_opportunities
           WHERE stage NOT IN ('vinto', 'perso', 'non_contattare') GROUP BY 1 HAVING count(*) > 1) x`,
  },
  {
    label: 'Follow-up in attesa su opportunità chiuse',
    expectZero: true,
    sql: `SELECT count(*)::int AS n FROM crm_followups f JOIN crm_opportunities o ON o.id = f.opportunity_id
           WHERE f.status = 'pending' AND o.stage IN ('vinto', 'perso', 'non_contattare')`,
  },
  {
    label: 'Opportunità «non contattare» su aziende non escluse',
    sql: `SELECT count(*)::int AS n FROM crm_opportunities o JOIN businesses b ON b.id = o.business_id
           WHERE o.stage = 'non_contattare' AND b.excluded_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM crm_opportunities o2 WHERE o2.business_id = b.id AND o2.created_at > o.created_at)`,
  },
  {
    label: 'Email «inviate» senza tentativo accettato',
    expectZero: true,
    sql: `SELECT count(*)::int AS n FROM commercial_emails e WHERE e.status = 'sent'
           AND NOT EXISTS (SELECT 1 FROM commercial_email_attempts a WHERE a.email_id = e.id AND a.outcome = 'accepted')`,
  },
  {
    label: 'Email rimaste «in invio»',
    expectZero: true,
    sql: "SELECT count(*)::int AS n FROM commercial_emails WHERE status = 'sending'",
  },
  {
    label: 'Valutazioni AI correnti su aziende unite',
    sql: `SELECT count(*)::int AS n FROM ai_assessments a JOIN businesses b ON b.id = a.business_id
           WHERE a.is_current AND b.merged_into IS NOT NULL`,
  },
  {
    label: 'Lavori bloccati «in corso» da oltre un’ora (scoperta, audit, AI, Lead Hunter)',
    expectZero: true,
    sql: `SELECT ((SELECT count(*) FROM discovery_jobs WHERE status = 'running' AND updated_at < now() - interval '1 hour')
              + (SELECT count(*) FROM audit_jobs WHERE status = 'running' AND updated_at < now() - interval '1 hour')
              + (SELECT count(*) FROM ai_jobs WHERE status = 'running' AND updated_at < now() - interval '1 hour')
              + (SELECT count(*) FROM hunt_runs WHERE status = 'running' AND updated_at < now() - interval '1 hour'))::int AS n`,
  },
];

let problems = 0;
console.log(`Database: ${config.database.kind === 'pglite' ? `PGlite in ${config.database.dataDir}` : 'PostgreSQL'}\n`);
for (const c of checks) {
  try {
    const { rows } = await db.query<{ n: number }>(c.sql);
    const n = rows[0]!.n;
    const bad = c.expectZero && n > 0;
    if (bad) problems++;
    console.log(`${bad ? '✗' : c.expectZero ? '✓' : '·'} ${c.label}: ${n}`);
  } catch (error) {
    problems++;
    console.log(`✗ ${c.label}: controllo non eseguibile (${(error as Error).message})`);
  }
}

const { rows: states } = await db.query<{ state: string; n: number }>(
  `SELECT CASE
     WHEN b.excluded_at IS NOT NULL THEN 'escluse'
     WHEN ast.lease_expires_at > now() THEN 'in valutazione'
     WHEN aa.id IS NOT NULL AND (ast.fingerprint IS NULL OR aa.cache_key = ast.fingerprint)
       THEN CASE WHEN aa.needs_review THEN 'valutazione incompleta' ELSE 'valutate' END
     WHEN ast.queue_status = 'failed' THEN 'errore di valutazione'
     WHEN aa.id IS NOT NULL THEN 'da aggiornare'
     ELSE 'da valutare' END AS state, count(*)::int AS n
     FROM businesses b LEFT JOIN ai_business_states ast ON ast.business_id = b.id
     LEFT JOIN ai_assessments aa ON aa.business_id = b.id AND aa.is_current
    WHERE b.merged_into IS NULL GROUP BY 1 ORDER BY 2 DESC`,
);
console.log('\nValutazione commerciale per stato:');
for (const s of states) console.log(`  ${s.state}: ${s.n}`);

await db.close();
console.log(problems ? `\n${problems} controlli da esaminare.` : '\nNessuna incoerenza rilevata.');
process.exitCode = problems ? 1 : 0;
