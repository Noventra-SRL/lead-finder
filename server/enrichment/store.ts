import { audit } from '../audit.ts';
import type { Queryable } from '../db/client.ts';
import { chooseContact, isBusinessAddress, type FoundEmail } from './emails.ts';

/*
 * Email trovate sul sito durante un audit: salvate con la provenienza e usate per il recapito delle aziende del sito.
 *
 * Regole di conservazione (mai perdere informazioni):
 *  - website_emails: una riga per indirizzo e sito; un indirizzo non più presente resta (con l'ultima data vista);
 *  - si conservano solo indirizzi dell'attività (generici o con il nome di un'azienda del sito), mai personali;
 *  - businesses.email viene SCRITTO solo se è vuoto. Un recapito esistente non viene mai sostituito: se l'indirizzo
 *    esistente è anche scritto sul sito, guadagna solo la prova («pubblicata», con la pagina);
 *  - un recapito «verificato» o inserito a mano non viene mai toccato.
 * La disponibilità dell'email è un attributo di contattabilità separato: non cambia gli indicatori della fonte
 * (has_email) né la data di aggiornamento dell'azienda, quindi non altera il punteggio commerciale.
 */

export async function recordWebsiteEmails(
  tx: Queryable,
  input: { websiteId: string; auditId: string; emails: FoundEmail[]; pagesChecked: number; checkedAt: Date },
): Promise<{ stored: number; contactsSet: number; contactsConfirmed: number }> {
  const { rows: businesses } = await tx.query<{
    id: string;
    name: string;
    email: string | null;
    email_source: string | null;
    email_status: string | null;
  }>(
    `SELECT b.id, b.name, b.email, b.email_source, b.email_status FROM business_websites bw
       JOIN businesses b ON b.id = bw.business_id
      WHERE bw.website_id = $1 AND b.merged_into IS NULL FOR UPDATE OF b`,
    [input.websiteId],
  );
  // solo indirizzi dell'attività: generici o con il nome di un'azienda di questo sito
  const kept = input.emails.filter((e) => businesses.some((b) => isBusinessAddress(e.email, b.name)));
  for (const e of kept)
    await tx.query(
      `INSERT INTO website_emails (website_id, email, relation, via, page_url, first_seen_at, last_seen_at, last_audit_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
       ON CONFLICT (website_id, email) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, last_audit_id = EXCLUDED.last_audit_id,
         relation = EXCLUDED.relation`,
      [input.websiteId, e.email, e.relation, e.via, e.pageUrl.slice(0, 600), input.checkedAt, input.auditId],
    );
  await tx.query('UPDATE websites SET emails_checked_at = $2, emails_pages_checked = $3 WHERE id = $1', [
    input.websiteId,
    input.checkedAt,
    Math.min(input.pagesChecked, 32767),
  ]);

  let contactsSet = 0;
  let contactsConfirmed = 0;
  for (const b of businesses) {
    const own = kept.filter((e) => isBusinessAddress(e.email, b.name));
    // il recapito esistente è scritto sul sito: stessa email, ora con la prova
    const same = b.email ? own.find((e) => e.email === b.email) : undefined;
    if (same && b.email_status !== 'verificata' && b.email_source !== 'manuale' && b.email_status !== 'pubblicata') {
      await tx.query(
        `UPDATE businesses SET email_source = 'website', email_status = 'pubblicata', email_source_url = $2,
                email_found_at = COALESCE(email_found_at, $3) WHERE id = $1`,
        [b.id, same.pageUrl.slice(0, 600), input.checkedAt],
      );
      await audit(tx, {
        userId: null,
        action: 'business.email_confirmed',
        entityType: 'business',
        entityId: b.id,
        details: { email: b.email, page: same.pageUrl, previousSource: b.email_source },
      });
      contactsConfirmed++;
      continue;
    }
    if (b.email) continue; // un recapito esistente non viene mai sostituito
    const choice = chooseContact(own);
    if (!choice) continue;
    await tx.query(
      `UPDATE businesses SET email = $2, email_kind = 'generic', email_source = 'website', email_status = 'pubblicata',
              email_source_url = $3, email_found_at = $4 WHERE id = $1 AND email IS NULL`,
      [b.id, choice.email, choice.pageUrl.slice(0, 600), input.checkedAt],
    );
    await audit(tx, {
      userId: null,
      action: 'business.email_found',
      entityType: 'business',
      entityId: b.id,
      details: { email: choice.email, page: choice.pageUrl, relation: choice.relation },
    });
    contactsSet++;
  }
  return { stored: kept.length, contactsSet, contactsConfirmed };
}
