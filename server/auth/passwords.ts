import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/*
 * Password degli utenti interni: Argon2id (@node-rs/argon2) con i parametri predefiniti della libreria
 * (19 MiB, 2 iterazioni, parallelismo 1: la configurazione minima raccomandata da OWASP).
 * Nel database finisce solo l'hash in formato PHC ($argon2id$…).
 */

export const PASSWORD_MIN = 12;
/** Oltre questa lunghezza la password si rifiuta: evita richieste che fanno lavorare inutilmente il server. */
export const PASSWORD_MAX = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // hash illeggibile: accesso negato, mai un errore che riveli qualcosa all'esterno
    return false;
  }
}

/*
 * Verifica fittizia per gli accessi con email inesistente o account disattivato:
 * il tempo di risposta non rivela se l'email corrisponde a un account.
 */
let dummyHash: Promise<string> | null = null;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hash('lead-finder-password-inesistente');
  await verifyPassword(await dummyHash, password);
  return false;
}

/** Problemi di una nuova password, in italiano; vuoto se è accettabile. */
export function passwordProblems(password: string, context: { email?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN) problems.push(`Usa almeno ${PASSWORD_MIN} caratteri.`);
  if (password.length > PASSWORD_MAX) problems.push(`Usa al massimo ${PASSWORD_MAX} caratteri.`);
  if (/^(.)\1+$/.test(password)) problems.push('Non usare un solo carattere ripetuto.');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local))
    problems.push('Non includere il tuo indirizzo email.');
  return problems;
}

/** Password temporanea per creazione e reimpostazione da CLI: 20 caratteri senza simboli ambigui. */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  let out = '';
  // 256 non è multiplo di 54: si scartano i byte oltre 216 per evitare distorsioni
  for (let i = 0; out.length < 20; i++) {
    const b = i < bytes.length ? bytes[i]! : randomBytes(1)[0]!;
    if (b < 216) out += alphabet[b % alphabet.length];
  }
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15)}`;
}
