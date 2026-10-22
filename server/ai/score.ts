import { bandOf, COMPONENTS, PENALTIES, type AiScoringConfig, type Component, type PenaltyType } from './config.ts';
import type { AssessmentContext } from './context.ts';
import { aiOutputSchema, type AiOutput } from './prompt.ts';

/*
 * Validazione della risposta del modello e calcolo deterministico del punteggio commerciale.
 * Il server non si fida mai di un totale del modello: ricalcola tutto dalle componenti validate.
 *
 *   punteggio pesato = Σ componente × peso / 100
 *   punteggio finale = punteggio pesato − penalità applicate, limitato tra 0 e 100
 *
 * Penalità: solo con almeno una prova citata (o dal CRM), una sola per ostacolo di fondo (gruppo), proporzionate
 * alla gravità. Esclusioni (non contattare, attività cessata): il punteggio resta visibile ma l'azienda esce dalle
 * classifiche dei prospect. L'affidabilità finale è la minore tra quella del modello e quella delle prove.
 */

const LIMITS = { text: 600, list: 12, summary: 900 };
const LEVEL = { low: 0, medium: 1, high: 2 } as const;
const LEVELS = ['low', 'medium', 'high'] as const;
type Level = (typeof LEVELS)[number];

export type Validation = { ok: true; output: AiOutput; warnings: string[] } | { ok: false; errors: string[] };

/** Valida forma, intervalli, identificativi, servizi e prove citate. Gli errori gravi rendono la risposta non valida. */
export function validateOutput(raw: unknown, ctx: AssessmentContext): Validation {
  const parsed = aiOutputSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'risposta'}: ${i.message}`),
    };
  const o = structuredClone(parsed.data);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (o.business_id !== ctx.businessId) errors.push('business_id diverso da quello richiesto');
  for (const c of COMPONENTS) {
    const s = o.components[c].score;
    if (!Number.isInteger(s) || s < 0 || s > 100)
      errors.push(`components.${c}.score fuori dall'intervallo 0-100 (${s})`);
  }
  const catalog = new Set(ctx.catalog.map((s) => s.id));
  const unknownServices = o.recommended_service_ids.filter((id) => !catalog.has(id));
  if (unknownServices.length) errors.push(`servizi non presenti nel catalogo: ${unknownServices.join(', ')}`);
  if (errors.length) return { ok: false, errors };

  // prove citate: si tengono solo gli id esistenti; quelli inventati sono tolti e segnalati
  const known = new Set(ctx.evidence.map((e) => e.id));
  let dropped = 0;
  const keep = (r: string[]) => {
    const valid = [...new Set(r)].filter((x) => known.has(x));
    dropped += r.length - valid.length;
    return valid;
  };
  const cut = (s: string, n = LIMITS.text) => s.trim().slice(0, n);
  for (const c of COMPONENTS) {
    o.components[c].evidence_refs = keep(o.components[c].evidence_refs);
    o.components[c].explanation = cut(o.components[c].explanation);
  }
  for (const list of [o.positive_signals, o.negative_signals, o.verified_facts, o.inferences])
    for (const s of list) {
      s.evidence_refs = keep(s.evidence_refs);
      s.text = cut(s.text);
    }
  for (const ob of o.obstacles) {
    ob.evidence_refs = keep(ob.evidence_refs);
    ob.text = cut(ob.text);
  }
  o.positive_signals = o.positive_signals.slice(0, LIMITS.list);
  o.negative_signals = o.negative_signals.slice(0, LIMITS.list);
  o.verified_facts = o.verified_facts.slice(0, LIMITS.list);
  o.inferences = o.inferences.slice(0, LIMITS.list);
  o.obstacles = o.obstacles.slice(0, LIMITS.list);
  o.unknowns = o.unknowns.slice(0, LIMITS.list).map((u) => cut(u));
  o.recommended_service_ids = [...new Set(o.recommended_service_ids)];
  o.summary = cut(o.summary, LIMITS.summary);
  o.next_step = cut(o.next_step);
  o.confidence.explanation = cut(o.confidence.explanation);
  if (dropped) warnings.push(`${dropped} riferimenti a prove inesistenti rimossi`);
  // un "fatto verificato" senza prove non è verificato: diventa una deduzione
  const unsupported = o.verified_facts.filter((f) => f.evidence_refs.length === 0);
  if (unsupported.length) {
    o.verified_facts = o.verified_facts.filter((f) => f.evidence_refs.length > 0);
    o.inferences.push(...unsupported);
    warnings.push(`${unsupported.length} fatti senza prove spostati tra le deduzioni`);
  }
  // chiusura dell'attività solo con prove
  if (o.business_status === 'closed') {
    const closed = o.obstacles.find((x) => x.type === 'inactive_business' && x.evidence_refs.length > 0);
    if (!closed) {
      o.business_status = 'unknown';
      warnings.push('attività indicata come cessata senza prove: stato riportato a "sconosciuto"');
    }
  }
  return { ok: true, output: o, warnings };
}

export interface AppliedPenalty {
  type: PenaltyType;
  label: string;
  group: string;
  severity: 'low' | 'medium' | 'high';
  points: number;
  applied: boolean;
  /** Perché non è stata applicata (prove assenti, stesso ostacolo già contato). */
  reason: string | null;
  source: 'ai' | 'crm';
  evidenceRefs: string[];
  rationale: string;
}

export interface ScoreResult {
  components: Record<
    Component,
    { score: number; weight: number; explanation: string; evidenceRefs: string[]; adjustedFrom?: number }
  >;
  weighted: number;
  penalties: AppliedPenalty[];
  adjustments: string[];
  final: number;
  band: { id: string; label: string };
  confidence: { level: Level; ai: Level; evidence: Level; explanation: string };
  needsReview: boolean;
  reviewReasons: string[];
  exclusion: 'do_not_contact' | 'inactive' | null;
}

/** Affidabilità delle prove, indipendente dal modello: identità, sito, audit, servizi, attualità. */
export function evidenceLevel(ctx: AssessmentContext): { level: Level; points: number; missing: string[] } {
  const f = ctx.facts;
  const checks: [boolean, string][] = [
    [f.hasLocation && f.hasSector, 'identità dell’attività (comune e settore)'],
    // un sito "non indicato dalla fonte" non è un'assenza verificata: non aumenta l'affidabilità
    [f.websiteState === 'verified', 'sito verificato'],
    [f.auditCompleted, 'audit tecnico completato'],
    [f.hasServiceEvidence, 'servizio consigliato con prove'],
    [f.sourceAgeDays <= 180, 'dati della fonte recenti'],
  ];
  const points = checks.filter(([ok]) => ok).length;
  return {
    level: points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low',
    points,
    missing: checks.filter(([ok]) => !ok).map(([, label]) => label),
  };
}

export function computeScore(o: AiOutput, ctx: AssessmentContext, config: AiScoringConfig): ScoreResult {
  const adjustments: string[] = [];
  const components = Object.fromEntries(
    COMPONENTS.map((c) => [
      c,
      {
        score: o.components[c].score,
        weight: config.weights[c],
        explanation: o.components[c].explanation,
        evidenceRefs: o.components[c].evidence_refs,
      },
    ]),
  ) as ScoreResult['components'];

  // miglioramento: un valore alto richiede prove concrete (rilievi dell'audit, o sito non indicato dalla fonte);
  // un sito irraggiungibile o un audit fallito non contano come prova di un sito scadente
  const strong = new Set<string>(ctx.facts.findingIds);
  if (ctx.facts.websiteState === 'none_indicated' || ctx.facts.websiteState === 'shared_platform') strong.add('W1');
  const imp = components.improvement;
  if (imp.score > config.improvementCapWithoutEvidence && !imp.evidenceRefs.some((r) => strong.has(r))) {
    imp.adjustedFrom = imp.score;
    imp.score = config.improvementCapWithoutEvidence;
    adjustments.push(
      `Opportunità di miglioramento limitata a ${config.improvementCapWithoutEvidence}: nessuna prova verificata (rilievo dell’audit o sito non indicato) a sostegno di ${imp.adjustedFrom}.`,
    );
  }

  const weighted =
    Math.round(COMPONENTS.reduce((s, c) => s + (components[c].score * components[c].weight) / 100, 0) * 100) / 100;

  // penalità candidate: dal modello (con prove) e dal CRM (fatti verificati dal server)
  const candidates: AppliedPenalty[] = [];
  for (const ob of o.obstacles) {
    if (!(ob.type in PENALTIES)) continue;
    const type = ob.type as PenaltyType;
    candidates.push({
      type,
      label: PENALTIES[type].label,
      group: PENALTIES[type].group,
      severity: ob.severity,
      points: Math.round(config.penalties[type] * config.severity[ob.severity]),
      applied: ob.evidence_refs.length > 0,
      reason: ob.evidence_refs.length > 0 ? null : 'nessuna prova citata',
      source: 'ai',
      evidenceRefs: ob.evidence_refs,
      rationale: PENALTIES[type].rationale,
    });
  }
  const crmRef = ctx.evidence.filter((e) => e.kind === 'crm').map((e) => e.id);
  if (ctx.facts.existingClient)
    candidates.push({
      type: 'existing_client',
      label: PENALTIES.existing_client.label,
      group: PENALTIES.existing_client.group,
      severity: 'high',
      points: Math.round(config.penalties.existing_client * config.severity.high),
      applied: true,
      reason: null,
      source: 'crm',
      evidenceRefs: crmRef,
      rationale: PENALTIES.existing_client.rationale,
    });
  if (ctx.facts.lostRecentlyAt)
    candidates.push({
      type: 'recently_lost',
      label: PENALTIES.recently_lost.label,
      group: PENALTIES.recently_lost.group,
      severity: 'medium',
      points: Math.round(config.penalties.recently_lost * config.severity.medium),
      applied: true,
      reason: null,
      source: 'crm',
      evidenceRefs: crmRef,
      rationale: PENALTIES.recently_lost.rationale,
    });
  // un ostacolo di fondo conta una volta sola: nel gruppo vince la penalità più alta, poi lo stesso tipo non si ripete
  const byGroup = new Map<string, AppliedPenalty>();
  for (const p of candidates.filter((x) => x.applied).sort((a, b) => b.points - a.points)) {
    const winner = byGroup.get(p.group);
    if (!winner) byGroup.set(p.group, p);
    else {
      p.applied = false;
      p.reason =
        winner.type === p.type
          ? 'stesso ostacolo già contato'
          : `stesso ostacolo di fondo di «${winner.label}», già contato`;
    }
  }
  const penaltyTotal = candidates.filter((p) => p.applied).reduce((s, p) => s + p.points, 0);
  const final = Math.max(0, Math.min(100, Math.round(weighted - penaltyTotal)));
  const band = bandOf(config, final);

  const ev = evidenceLevel(ctx);
  const ai = o.confidence.level;
  const level = LEVELS[Math.min(LEVEL[ai], LEVEL[ev.level])]!;
  const confidenceText = [
    o.confidence.explanation,
    ev.missing.length ? `Prove mancanti: ${ev.missing.join(', ')}.` : null,
    level !== ai
      ? `Affidabilità ridotta a «${level === 'low' ? 'bassa' : 'media'}» dal controllo delle prove disponibili.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  const reviewReasons: string[] = [];
  if (level === 'low') reviewReasons.push('affidabilità bassa');
  if (final >= config.reviewThreshold && level === 'low') reviewReasons.push('punteggio alto con prove deboli');
  if (candidates.some((p) => p.applied && p.severity === 'high')) reviewReasons.push('ostacoli commerciali rilevanti');
  if (components.service_fit.score >= 60 && o.recommended_service_ids.length === 0)
    reviewReasons.push('servizio adatto non indicato');
  if (!ctx.facts.hasServiceEvidence && o.recommended_service_ids.length > 0)
    reviewReasons.push('servizi proposti senza riscontro nell’abbinamento a regole');

  const exclusion = ctx.facts.doNotContact ? 'do_not_contact' : o.business_status === 'closed' ? 'inactive' : null;
  return {
    components,
    weighted,
    penalties: candidates,
    adjustments,
    final,
    band: { id: band.id, label: band.label },
    confidence: { level, ai, evidence: ev.level, explanation: confidenceText },
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    exclusion,
  };
}
