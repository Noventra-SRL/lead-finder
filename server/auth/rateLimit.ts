/*
 * Limite di tentativi a finestra fissa, in memoria, per le operazioni sensibili (accesso, cambio password).
 * Vale per un singolo processo: con più istanze del server serve il limite del proxy o un archivio condiviso.
 * Le chiavi contengono IP o email normalizzata, mai password o token.
 */

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Conta un tentativo; restituisce i secondi di attesa se il limite è superato, altrimenti 0. */
  hit(key: string, rule: RateLimitRule): number {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + rule.windowMs });
      this.prune(now);
      return 0;
    }
    entry.count++;
    return entry.count > rule.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  /** Secondi di attesa se la chiave ha già superato il limite, senza contare un nuovo tentativo. */
  blocked(key: string, rule: RateLimitRule): number {
    const entry = this.hits.get(key);
    const now = this.now();
    return entry && entry.resetAt > now && entry.count >= rule.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private prune(now: number) {
    if (this.hits.size < 10_000) return;
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

const MINUTE = 60_000;

export const RULES = {
  /** Richieste di accesso per IP. */
  loginByIp: { limit: 30, windowMs: 15 * MINUTE },
  /** Accessi falliti per email: protegge il singolo account da tentativi ripetuti. */
  loginFailuresByEmail: { limit: 6, windowMs: 15 * MINUTE },
  /** Cambi password per utente (verifica della password attuale inclusa). */
  passwordChangeByUser: { limit: 10, windowMs: 15 * MINUTE },
  /** Creazione e ripresa di ricerche (operazioni costose per il fornitore di dati). */
  discoveryJobsByUser: { limit: 20, windowMs: 60 * MINUTE },
  /** Avvio e ripresa di verifiche dei siti (richieste verso siti di terzi). */
  auditJobsByUser: { limit: 30, windowMs: 60 * MINUTE },
  /** Calcolo del punteggio di una singola azienda (economico, ma limitato). */
  scoringByUser: { limit: 300, windowMs: 15 * MINUTE },
  /** Ricalcoli in blocco dei punteggi. */
  scoringJobsByUser: { limit: 20, windowMs: 60 * MINUTE },
  /** Esportazioni CSV dei lead. */
  exportsByUser: { limit: 30, windowMs: 60 * MINUTE },
  /** Avvio e controllo delle ricerche di lead (Lead Hunter). */
  huntsByUser: { limit: 30, windowMs: 60 * MINUTE },
  /** Operazioni di revisione dei duplicati. */
  reviewWritesByUser: { limit: 300, windowMs: 15 * MINUTE },
  /** Modifiche del CRM (opportunità, attività, follow-up): uso normale ampio, blocca solo gli abusi. */
  crmWritesByUser: { limit: 600, windowMs: 15 * MINUTE },
  /** Valutazioni AI singole (chiamate a pagamento al fornitore). */
  aiAssessmentsByUser: { limit: 60, windowMs: 60 * MINUTE },
  /** Creazione e controllo delle valutazioni AI in blocco. */
  aiJobsByUser: { limit: 30, windowMs: 60 * MINUTE },
  /** Aggiunte in blocco al CRM. */
  crmBulkByUser: { limit: 30, windowMs: 60 * MINUTE },
  /** Generazioni di email commerciali con l'AI (chiamate a pagamento al fornitore). */
  emailGenerationsByUser: { limit: 60, windowMs: 60 * MINUTE },
  /** Invii di email commerciali: uno per conferma; il limite blocca gli usi impropri (nessun invio massivo). */
  emailSendsByUser: { limit: 40, windowMs: 60 * MINUTE },
  /** Modifiche delle bozze (salvataggi, archiviazioni). */
  emailWritesByUser: { limit: 600, windowMs: 15 * MINUTE },
} satisfies Record<string, RateLimitRule>;
