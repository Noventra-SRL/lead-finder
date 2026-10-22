import { rmSync } from 'node:fs';
import { goodPharmacyHome, poorRestaurantHome, startFakeSite } from '../server/audit/fakeSite.ts';
import { hashPassword } from '../server/auth/passwords.ts';
import { createUser } from '../server/auth/users.ts';
import { openDatabase } from '../server/db/client.ts';
import { migrate } from '../server/db/migrate.ts';
import { startFakeAnthropic } from '../server/ai/fakeAnthropic.ts';
import { startFakeSmtp } from '../server/email/fakeSmtp.ts';
import { startFakeOverpass } from '../server/discovery/osm/fakeOverpass.ts';
import { saveRecord } from '../server/discovery/store.ts';
import {
  E2E_AUDIT_BUSINESSES,
  E2E_FAKE_AI_PORT,
  E2E_FAKE_OVERPASS_PORT,
  E2E_FAKE_SMTP_PORT,
  E2E_FAKE_SITE_PORTS,
  E2E_USERS,
} from './users.ts';

/*
 * Avvio per i test end-to-end: il PROGRAMMA REALE (server/index.ts), con l'interfaccia compilata in dist/
 * servita dallo stesso processo e la sua Content-Security-Policy, su un database PGlite dedicato in
 * .data/e2e (ricreato a ogni esecuzione, mai .data/pglite).
 * Prima dell'avvio: migrazioni e utenti di prova con password note (dati di test, non dimostrativi).
 * La scoperta usa un server Overpass FINTO locale (dati inventati "di Prova"): i test non dipendono da Internet
 * e non caricano i server pubblici di OpenStreetMap.
 * L'audit analizza siti FINTI locali (pagine "di Prova" su 127.0.0.1): la protezione SSRF li bloccherebbe, quindi il
 * server parte con NODE_ENV=test e AUDIT_TEST_LOOPBACK_PORTS limitata a quelle porte (eccezione rifiutata fuori dai test).
 * Le tre aziende collegate ai siti finti sono create qui, con dati di test, in provincia di Trieste.
 */

const dataDir = '.data/e2e';
rmSync(dataDir, { recursive: true, force: true });

const db = await openDatabase({ kind: 'pglite', dataDir });
await migrate(db);
const admin = await createUser(db, { email: E2E_USERS.admin.email, displayName: E2E_USERS.admin.name, role: 'admin' });
const fresh = await createUser(db, { email: E2E_USERS.fresh.email, displayName: 'Nuovo Commerciale', role: 'sales' });
await db.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [
  admin.id,
  await hashPassword(E2E_USERS.admin.password),
]);
// resta "password temporanea": il test verifica il cambio obbligatorio al primo accesso
await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
  fresh.id,
  await hashPassword(E2E_USERS.fresh.password),
]);

const { good, poor, closed } = E2E_FAKE_SITE_PORTS;
const seeds = [
  { name: E2E_AUDIT_BUSINESSES.good, category: 'farmacie', website: `http://127.0.0.1:${good}/` },
  { name: E2E_AUDIT_BUSINESSES.poor, category: 'ristorazione', website: `http://127.0.0.1:${poor}/` },
  { name: E2E_AUDIT_BUSINESSES.down, category: 'negozi', website: `http://127.0.0.1:${closed}/` },
] as const;
for (const [i, b] of seeds.entries()) {
  await db.transaction((tx) =>
    saveRecord(
      tx,
      {
        provider: 'osm',
        ref: `node/${9_900_000_000 + i}`,
        sourceUrl: `https://www.openstreetmap.org/node/${9_900_000_000 + i}`,
        name: b.name,
        category: b.category,
        websiteUrl: b.website,
        websiteDomain: new URL(b.website).host,
        websiteShared: false,
        sector: null,
        contacts: { phone: null, email: null, emailKind: null },
        address: { street: null, housenumber: null, postcode: null, city: null },
        municipalityCode: '032006',
        latitude: 45.64 + i * 0.01,
        longitude: 13.77,
        has: { website: true, address: false, phone: false, email: false, openingHours: false },
        sourceTags: { name: b.name },
      },
      {
        jobId: null,
        fetchedAt: new Date(),
        sourceDataAt: null,
        minCompleteness: 0,
        requireWebsite: false,
        seen: new Set(),
      },
    ),
  );
}
await db.close();

const fake = await startFakeOverpass(E2E_FAKE_OVERPASS_PORT);
await startFakeSite(
  {
    '/': { body: goodPharmacyHome() },
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' },
  },
  good,
);
// il sito "lento" risponde dopo 1,5 s: la verifica resta in corso abbastanza a lungo da poterla seguire
await startFakeSite({ '/': { body: poorRestaurantHome(), delayMs: 1500 } }, poor);

process.env.PGLITE_DATA_DIR = dataDir;
process.env.API_PORT = process.env.E2E_PORT ?? '8811';
process.env.LOG_LEVEL = 'warn';
process.env.DISCOVERY_OVERPASS_URL = fake.url;
process.env.DISCOVERY_MIN_INTERVAL_MS = '0';
process.env.DISCOVERY_MAX_RETRIES = '0';
process.env.NODE_ENV = 'test';
process.env.AUDIT_TEST_LOOPBACK_PORTS = `${good},${poor},${closed}`;
process.env.AUDIT_HOST_INTERVAL_MS = '500';
process.env.AUDIT_REQUEST_TIMEOUT_MS = '5000';
process.env.AUDIT_CONNECT_TIMEOUT_MS = '2000';
// valutazione AI: SDK reale verso un server finto locale (ammesso solo con NODE_ENV=test), chiave di prova
const fakeAi = await startFakeAnthropic(E2E_FAKE_AI_PORT);
process.env.AI_API_KEY = 'sk-ant-chiave-di-prova-e2e-0000000000000000';
process.env.AI_TEST_BASE_URL = fakeAi.url;
process.env.AI_MODEL = 'claude-opus-5-5';
// valutazione automatica spenta nei test end-to-end: i test controllano quali aziende vengono valutate e quando
process.env.AI_AUTO_ASSESS = 'off';
// email commerciali: client SMTP reale (nodemailer) verso un server SMTP finto locale; nessuna email esce
await startFakeSmtp(E2E_FAKE_SMTP_PORT);
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(E2E_FAKE_SMTP_PORT);
process.env.SMTP_SECURITY = 'none';
process.env.EMAIL_SENDER_AUTHORIZED = 'si';
await import('../server/index.ts');
