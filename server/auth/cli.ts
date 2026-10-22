import { parseArgs } from 'node:util';
import { z } from 'zod';
import { describeDatabase, loadConfig } from '../config.ts';
import { openDatabase } from '../db/client.ts';
import { assertMigrated } from '../db/migrate.ts';
import { createUser, listUsers, resetPassword, ROLES, setDisabled, setRole, UserError, type Role } from './users.ts';

/*
 * Gestione degli utenti interni (unico modo per creare account):
 *   npm run user -- crea --email nome@noventra.it --nome "Nome Cognome" [--ruolo admin|sales]
 *   npm run user -- elenco
 *   npm run user -- reimposta --email nome@noventra.it      nuova password temporanea, chiude le sessioni
 *   npm run user -- disattiva --email nome@noventra.it      chiude le sessioni, blocca l'accesso
 *   npm run user -- riattiva --email nome@noventra.it
 *   npm run user -- ruolo --email nome@noventra.it --ruolo admin|sales
 * La password temporanea compare una sola volta in questo terminale e va cambiata al primo accesso.
 * Con PGlite, l'API deve essere ferma (un solo processo per cartella dei dati).
 */

const USAGE = `Uso: npm run user -- <comando> [opzioni]
  crea       --email <email> --nome <nome> [--ruolo admin|sales]
  elenco
  reimposta  --email <email>
  disattiva  --email <email>
  riattiva   --email <email>
  ruolo      --email <email> --ruolo admin|sales`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: 'string' }, nome: { type: 'string' }, ruolo: { type: 'string' } },
});
const command = positionals[0];

function required(name: 'email' | 'nome' | 'ruolo'): string {
  const v = values[name];
  if (!v) {
    console.error(`Manca --${name}.\n\n${USAGE}`);
    process.exit(2);
  }
  return v;
}

function role(raw: string | undefined, fallback: Role): Role {
  const r = raw ?? fallback;
  if (!ROLES.includes(r as Role)) {
    console.error(`Ruolo non valido: usa ${ROLES.join(' o ')}.`);
    process.exit(2);
  }
  return r as Role;
}

const printPassword = (email: string, password: string) =>
  console.log(
    `\nPassword temporanea per ${email}:\n\n    ${password}\n\nComunicala in modo sicuro: non viene salvata e non sarà più mostrata. Andrà cambiata al primo accesso.`,
  );

if (!command || !['crea', 'elenco', 'reimposta', 'disattiva', 'riattiva', 'ruolo'].includes(command)) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const config = loadConfig();
  console.log(`Database: ${describeDatabase(config.database)}`);
  const db = await openDatabase(config.database);
  try {
    await assertMigrated(db);
    switch (command) {
      case 'crea': {
        const email = required('email');
        const created = await createUser(db, {
          email,
          displayName: required('nome'),
          role: role(values.ruolo, 'sales'),
        });
        console.log(`Utente creato (${created.id}).`);
        printPassword(email.toLowerCase(), created.temporaryPassword);
        break;
      }
      case 'elenco': {
        const users = await listUsers(db);
        if (!users.length)
          console.log('Nessun utente. Crea il primo con: npm run user -- crea --email … --nome … --ruolo admin');
        for (const u of users)
          console.log(
            `  ${u.disabled ? '✗' : '✓'} ${u.email.padEnd(36)} ${u.role.padEnd(6)} ${u.displayName}` +
              `${u.mustChangePassword ? '  (password temporanea)' : ''}`,
          );
        break;
      }
      case 'reimposta': {
        const email = required('email');
        printPassword(email.toLowerCase(), await resetPassword(db, email));
        break;
      }
      case 'disattiva':
      case 'riattiva':
        await setDisabled(db, required('email'), command === 'disattiva');
        console.log(command === 'disattiva' ? 'Utente disattivato e sessioni chiuse.' : 'Utente riattivato.');
        break;
      case 'ruolo':
        await setRole(db, required('email'), role(required('ruolo'), 'sales'));
        console.log('Ruolo aggiornato.');
        break;
    }
  } finally {
    await db.close();
  }
} catch (error) {
  if (error instanceof z.ZodError) console.error(`Errore: ${error.issues.map((i) => i.message).join(' ')}`);
  else if (error instanceof UserError) console.error(`Errore: ${error.message}`);
  else console.error(`Errore imprevisto: ${(error as Error).message}`);
  process.exitCode = 1;
}
