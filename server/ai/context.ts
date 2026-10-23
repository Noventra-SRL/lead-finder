import { createHash } from 'node:crypto';
import type { Queryable } from '../db/client.ts';
import { AUDIT_COLUMNS, FROM_BUSINESSES, summary, type BusinessRow } from '../discovery/businesses.ts';
import { activeCatalog } from '../matching/store.ts';

/*
 * Contesto della valutazione commerciale: solo dati già presenti nell'applicazione, numerati come prove
 * (B = azienda, W = sito, A = audit, F = rilievo, C = capacità del sito, S = servizio abbinato, R = CRM),
 * così il modello può citarle e una persona può verificarle.
 *
 * Minimizzazione: nessun numero di telefono, email, nota del CRM o dato personale; dei recapiti si dice solo se
 * esistono. Nessuna navigazione esterna. I testi che arrivano da fonti esterne (nome dell'attività, indirizzi delle
 * pagine) sono dati, non istruzioni: sono ripuliti, accorciati e passati dentro un blocco JSON.
 */

export interface EvidenceItem {
  id: string;
  kind: 'business' | 'website' | 'audit' | 'finding' | 'capability' | 'service' | 'crm';
  text: string;
}

export interface AssessmentContext {
  businessId: string;
  businessName: string;
  evidence: EvidenceItem[];
  catalog: { id: string; name: string; description: string }[];
  /** Fatti verificati dal server, usati anche dalle regole deterministiche (non solo dal modello). */
  facts: {
    websiteState: 'none_indicated' | 'shared_platform' | 'verified' | 'not_verified' | 'unavailable' | 'audit_failed';
    auditCompleted: boolean;
    findingIds: string[];
    doNotContact: boolean;
    existingClient: boolean;
    lostRecentlyAt: string | null;
    openOpportunityStage: string | null;
    hasServiceEvidence: boolean;
    hasLocation: boolean;
    hasSector: boolean;
    sourceAgeDays: number;
  };
  /** Dati volatili esclusi dall'impronta della cache (non cambiano la valutazione). */
  volatile: { lastVerifiedAt: string };
}

/** Testo esterno reso sicuro: niente caratteri di controllo, spazi compressi, lunghezza limitata. */
export function clean(s: string | null | undefined, max = 200): string {
  if (!s) return '';
  return (
    s
      // eslint-disable-next-line no-control-regex -- si eliminano proprio i caratteri di controllo
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return clean(u.pathname || '/', 80);
  } catch {
    return '';
  }
};

const WEBSITE_TEXT: Record<AssessmentContext['facts']['websiteState'], string> = {
  none_indicated:
    'La fonte (OpenStreetMap) non indica un sito web. Assenza NON verificata: il sito potrebbe esistere ma non essere registrato.',
  shared_platform:
    'La fonte indica solo una pagina su una piattaforma condivisa (social o directory), non un sito proprio.',
  verified: 'Sito proprio raggiungibile e verificato dall’audit tecnico.',
  not_verified: 'Sito proprio indicato dalla fonte ma non ancora verificato dall’audit.',
  unavailable:
    'Sito indicato ma non raggiungibile o bloccato all’ultimo controllo. Può essere un disservizio temporaneo o un blocco dei controlli automatici: NON prova che il sito sia scadente o assente.',
  audit_failed: 'La verifica tecnica del sito non è riuscita: nessuna conclusione possibile sul sito.',
};

export async function buildContext(db: Queryable, businessId: string): Promise<AssessmentContext | null> {
  const { rows } = await db.query<BusinessRow & { updated_at: Date }>(
    `SELECT b.*${AUDIT_COLUMNS} FROM ${FROM_BUSINESSES} WHERE b.id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) return null;
  const b = summary(row);
  const evidence: EvidenceItem[] = [];
  const add = (id: string, kind: EvidenceItem['kind'], text: string) => evidence.push({ id, kind, text });

  add(
    'B1',
    'business',
    `Nome: "${clean(b.name, 120)}". Settore: ${b.sector?.label ?? 'non classificato'}. Categoria: ${b.categoryLabel}.`,
  );
  const hasLocation = Boolean(b.place.municipality);
  add(
    'B2',
    'business',
    hasLocation
      ? `Sede: ${b.place.municipality} (${b.place.provinceSigla}), ${b.place.region}.`
      : 'Comune non determinato dalla fonte.',
  );
  add(
    'B3',
    'business',
    `Recapiti pubblici dell’attività: telefono ${b.contacts.phone ? 'indicato' : 'non indicato'}; email generica ${
      b.contacts.email ? 'indicata' : 'non indicata'
    }. Orari ${b.has.openingHours ? 'indicati' : 'non indicati'}.`,
  );
  const sourceAgeDays = Math.max(0, Math.round((Date.now() - new Date(b.lastVerifiedAt!).getTime()) / 86_400_000));
  add(
    'B4',
    'business',
    `Fonte: OpenStreetMap, attività confermata dalla fonte ${sourceAgeDays <= 1 ? 'di recente' : `${sourceAgeDays} giorni fa`}.`,
  );

  const status = b.audit.websiteStatus;
  const websiteState: AssessmentContext['facts']['websiteState'] = !b.website
    ? 'none_indicated'
    : b.website.shared
      ? 'shared_platform'
      : status === 'valid' || status === 'redirected'
        ? 'verified'
        : status === 'not_checked'
          ? 'not_verified'
          : status === 'audit_failed'
            ? 'audit_failed'
            : 'unavailable';
  add('W1', 'website', `${b.website ? `Dominio: ${clean(b.website.domain, 100)}. ` : ''}${WEBSITE_TEXT[websiteState]}`);

  // audit tecnico più recente (Fase 3): sintesi e rilievi utili, testi dal catalogo interno dei rilievi
  let auditCompleted = false;
  const findingIds: string[] = [];
  if (b.audit.lastAuditId) {
    const { rows: a } = await db.query<{
      run_status: string;
      finished_at: Date;
      pages_inspected: number;
      summary: { findings?: { bySeverity?: Record<string, number> }; performance?: { mobile?: { score?: number } } };
      limitations: unknown;
    }>('SELECT run_status, finished_at, pages_inspected, summary, limitations FROM website_audits WHERE id = $1', [
      b.audit.lastAuditId,
    ]);
    const audit = a[0];
    if (audit) {
      auditCompleted = audit.run_status !== 'failed' && websiteState === 'verified';
      const sev = audit.summary.findings?.bySeverity ?? {};
      const perf = audit.summary.performance?.mobile?.score;
      add(
        'A1',
        'audit',
        `Audit tecnico del ${new Date(audit.finished_at).toISOString().slice(0, 10)} (${audit.run_status === 'partial' ? 'parziale' : audit.run_status === 'failed' ? 'non riuscito' : 'completo'}, ${audit.pages_inspected} pagine): rilievi gravi ${sev.high ?? 0}, medi ${sev.medium ?? 0}, lievi ${sev.low ?? 0}.${
          typeof perf === 'number'
            ? ` Prestazioni mobile (PageSpeed): ${perf}/100.`
            : ' Prestazioni mobile non misurate.'
        } L’audit non esegue JavaScript: alcune funzioni possono sfuggire.`,
      );
      const { rows: findings } = await db.query<{
        code: string;
        category: string;
        severity: string;
        title: string;
        page_url: string;
        observation: string;
      }>(
        `SELECT code, category, severity, title, page_url, observation FROM audit_findings
          WHERE audit_id = $1 AND actionable
          ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, code LIMIT 15`,
        [b.audit.lastAuditId],
      );
      findings.forEach((f, i) => {
        const id = `F${i + 1}`;
        findingIds.push(id);
        add(
          id,
          'finding',
          `[${f.severity}] ${f.category}: ${clean(f.title, 160)} (${f.code}${f.page_url ? `, pagina ${pathOf(f.page_url)}` : ''}).`,
        );
      });
    }
  }

  // capacità del sito rilevate dal punteggio a regole (Fase 4): presenti, assenti, non rilevate, sconosciute
  const { rows: ls } = await db.query<{ breakdown: { capabilities?: { capability: string; state: string }[] } }>(
    'SELECT breakdown FROM lead_scores WHERE business_id = $1 AND is_current',
    [businessId],
  );
  (ls[0]?.breakdown.capabilities ?? []).slice(0, 10).forEach((c, i) => {
    add(
      `C${i + 1}`,
      'capability',
      `Funzione "${c.capability}": ${c.state === 'present' ? 'presente' : c.state === 'missing' ? 'assente (verificato)' : c.state === 'not_detected' ? 'non rilevata' : 'sconosciuta'}.`,
    );
  });

  // abbinamento ai servizi (Fase 5): solo i servizi proponibili, con il problema individuato
  const { rows: matches } = await db.query<{
    service_id: string;
    status: string;
    score: number | null;
    problem: string | null;
    explanation: string;
  }>(
    `SELECT service_id, status, score, problem, explanation FROM service_matches
      WHERE business_id = $1 AND is_current AND status IN ('recommended', 'possible', 'needs_review')
      ORDER BY score DESC NULLS LAST LIMIT 6`,
    [businessId],
  );
  matches.forEach((m, i) =>
    add(
      `S${i + 1}`,
      'service',
      `Abbinamento a regole con il servizio "${m.service_id}": ${m.status}${m.score !== null ? `, corrispondenza ${m.score}/100` : ''}. ${clean(m.problem ?? m.explanation, 300)}`,
    ),
  );

  // CRM (Fase 7): solo fasi ed esiti, mai note o attività
  const { rows: opps } = await db.query<{ stage: string; created_at: Date; closed_at: Date | null }>(
    'SELECT stage, created_at, closed_at FROM crm_opportunities WHERE business_id = $1 ORDER BY created_at DESC LIMIT 5',
    [businessId],
  );
  const open = opps.find((o) => !o.closed_at);
  const won = opps.some((o) => o.stage === 'vinto');
  const lost = opps.find((o) => o.stage === 'perso' && o.closed_at);
  const doNotContact =
    Boolean(row.excluded_at) || Boolean(row.do_not_contact_at) || opps.some((o) => o.stage === 'non_contattare');
  if (opps.length === 0) add('R1', 'crm', 'Nessuna opportunità commerciale registrata: potenziale nuovo cliente.');
  else
    opps.forEach((o, i) =>
      add(
        `R${i + 1}`,
        'crm',
        `Opportunità ${o.closed_at ? `chiusa il ${new Date(o.closed_at).toISOString().slice(0, 10)}` : 'aperta'}: fase "${o.stage}".`,
      ),
    );
  if (doNotContact) add(`R${opps.length + 1}`, 'crm', 'L’azienda è contrassegnata come "non contattare".');

  const catalog = (await activeCatalog(db)).catalog.services
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name, description: clean(s.description, 300) }));

  return {
    businessId,
    businessName: b.name,
    evidence,
    catalog,
    facts: {
      websiteState,
      auditCompleted,
      findingIds,
      doNotContact,
      existingClient: won,
      lostRecentlyAt:
        lost?.closed_at && Date.now() - new Date(lost.closed_at).getTime() < 180 * 86_400_000
          ? new Date(lost.closed_at).toISOString()
          : null,
      openOpportunityStage: open?.stage ?? null,
      hasServiceEvidence: matches.some((m) => m.status === 'recommended' || m.status === 'possible'),
      hasLocation,
      hasSector: Boolean(b.sector),
      sourceAgeDays,
    },
    volatile: { lastVerifiedAt: b.lastVerifiedAt! },
  };
}

/**
 * Impronta per la cache: prove (tranne l'età della conferma della fonte, che cambia ogni giorno senza cambiare la
 * sostanza), catalogo, configurazione, versione del prompt e modello. Se nessuno cambia, la valutazione si riusa.
 */
export function cacheKey(
  ctx: AssessmentContext,
  parts: { configVersion: number; promptVersion: number; model: string },
): string {
  const stable = {
    evidence: ctx.evidence.filter((e) => e.id !== 'B4').map((e) => [e.id, e.text]),
    catalog: ctx.catalog,
    facts: { ...ctx.facts, sourceAgeDays: undefined },
    ...parts,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
