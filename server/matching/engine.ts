import { FINDINGS } from '../audit/findings.ts';
import { CATEGORIES, type CategoryId } from '../discovery/categories.ts';
import { CAPABILITIES, type Capability, type ScoringConfig } from '../scoring/config.ts';
import {
  capabilityState,
  hasEcommercePlatform,
  websiteSituation,
  type CapabilityState,
  type ScoreResult,
  type ScoringInput,
} from '../scoring/engine.ts';
import {
  MATCH_DIMENSIONS,
  MATCHING_ALGORITHM_VERSION,
  type CatalogService,
  type MatchDimension,
  type ServiceCatalog,
} from './catalog.ts';

/*
 * Abbinamento ai servizi: funzione PURA e deterministica. Per ogni servizio attivo e abbinabile in automatico:
 *
 *   corrispondenza = Σ (valore_dimensione × peso) / Σ pesi delle dimensioni con prove
 *
 * Dimensioni: rilievi dell'audit pertinenti (35), capacità mancanti (25), pertinenza del settore (15),
 * affidabilità delle prove della Fase 4 (15), contesto verificato (10). Il punteggio del lead (Fase 4) NON entra nel
 * calcolo: è solo contesto mostrato accanto. Senza una prova di bisogno il servizio non viene proposto, qualunque sia
 * il settore. Con prove insufficienti lo stato è "insufficient_evidence", mai un numero apparentemente preciso.
 */

export type MatchStatus = 'recommended' | 'possible' | 'needs_review' | 'insufficient_evidence' | 'not_relevant';
export type MatchStrength = 'recommended' | 'possible' | null;

export interface MatchSignal {
  kind: 'fact' | 'inference';
  text: string;
  ref?: { auditId?: string; codes?: string[]; page?: string; capability?: Capability };
}

export interface ServiceMatchResult {
  serviceId: string;
  status: MatchStatus;
  /** Forza dell'abbinamento prima dei controlli di verifica (ordina anche i "da verificare"). */
  strength: MatchStrength;
  score: number | null;
  rawScore: number | null;
  confidence: { value: number; level: 'high' | 'medium' | 'low' };
  /** Quota dei pesi delle dimensioni con prove (0–100). */
  completeness: number;
  dimensions: Record<
    MatchDimension,
    { score: number | null; weight: number; effectiveWeight: number; contribution: number }
  >;
  evidence: {
    auditId: string | null;
    findings: { code: string; title: string; severity: string; confidence: string; page: string; points: number }[];
    capabilities: { capability: Capability; label: string; state: CapabilityState }[];
    repeatedFailure: boolean;
  };
  signals: { positive: MatchSignal[]; negative: MatchSignal[]; unknown: MatchSignal[] };
  reasons: string[];
  problem: string | null;
  explanation: string;
  nextStep: string;
  dedupeGroup: string;
}

export interface MatchRunResult {
  algorithmVersion: number;
  matches: ServiceMatchResult[];
  /** Confidenza della Fase 4 usata (contesto comune a tutti i servizi). */
  confidenceLevel: 'high' | 'medium' | 'low';
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const SOURCE_CONTEXT: Record<string, keyof ScoringInput['business']['has']> = {
  sourcePhone: 'phone',
  sourceAddress: 'address',
  sourceOpeningHours: 'openingHours',
};
const CONTEXT_LABEL: Record<string, string> = {
  sourcePhone: 'telefono indicato dalla fonte',
  sourceAddress: 'indirizzo indicato dalla fonte',
  sourceOpeningHours: 'orari indicati dalla fonte',
  catalog: 'catalogo di prodotti presente sul sito',
  servicesSection: 'servizi o prodotti presentati sul sito',
  address: 'indirizzo presente sul sito',
  otaLinks: 'link a portali di prenotazione',
  social: 'profili social collegati',
};

function levelOf(value: number, scoringConfig: ScoringConfig): 'high' | 'medium' | 'low' {
  return value >= scoringConfig.thresholds.confidenceHigh
    ? 'high'
    : value >= scoringConfig.thresholds.confidenceMedium
      ? 'medium'
      : 'low';
}

export function matchServices(
  input: ScoringInput,
  lead: Pick<ScoreResult, 'confidence' | 'evidence'>,
  scoringConfig: ScoringConfig,
  catalog: ServiceCatalog,
): MatchRunResult {
  const situation = websiteSituation(input, scoringConfig);
  const audit = situation.auditApplies ? input.audit : null;
  const usable = situation.reachable && audit ? audit : null;
  const category = input.business.category as CategoryId;
  const categoryLabel = CATEGORIES[category]?.label ?? input.business.category;
  const fp = catalog.findingPoints;
  const matches: ServiceMatchResult[] = [];

  for (const svc of catalog.services) {
    if (!svc.active || !svc.verified || !svc.autoMatch) continue;
    matches.push(matchOne(svc));
  }
  return { algorithmVersion: MATCHING_ALGORITHM_VERSION, matches, confidenceLevel: lead.confidence.level };

  /** Segnale dell'audit; la vendita online risulta anche da una piattaforma di e-commerce riconosciuta. */
  function signalPresent(name: string): boolean {
    if (!usable) return false;
    if ((name === 'ecommerce' || name === 'catalog') && hasEcommercePlatform(usable)) return true;
    return Boolean(usable.summary.signals?.[name]);
  }

  function matchOne(svc: CatalogService): ServiceMatchResult {
    const positive: MatchSignal[] = [];
    const negative: MatchSignal[] = [];
    const unknown: MatchSignal[] = [];
    const reasons: string[] = [];
    const auditRef = usable ? { auditId: usable.id } : undefined;

    // ---------- rilievi pertinenti ----------
    const findingCodes = Object.keys(svc.findings);
    let findingsScore: number | null = null;
    const evidenceFindings: ServiceMatchResult['evidence']['findings'] = [];
    const repeated = situation.repeatedFailure && svc.repeatedFailure;
    if (usable && findingCodes.length) {
      const best = new Map<string, ServiceMatchResult['evidence']['findings'][number]>();
      for (const f of usable.findings) {
        const imp = svc.findings[f.code as keyof typeof svc.findings];
        if (!imp || !f.actionable || f.observation === 'not_inspected') continue;
        const points = imp * fp.severity[f.severity] * fp.confidence[f.confidence];
        if (points <= 0) continue;
        const cur = best.get(f.code);
        // lo stesso rilievo su più pagine è un solo problema
        if (!cur || points > cur.points)
          best.set(f.code, {
            code: f.code,
            title: FINDINGS[f.code as keyof typeof FINDINGS]?.title ?? f.code,
            severity: f.severity,
            confidence: f.confidence,
            page: f.page,
            points: round1(points),
          });
      }
      evidenceFindings.push(...[...best.values()].sort((a, b) => b.points - a.points || a.code.localeCompare(b.code)));
      findingsScore = Math.min(
        100,
        Math.round((evidenceFindings.reduce((s, f) => s + f.points, 0) / fp.saturation) * 100),
      );
    } else if (repeated) findingsScore = 100;
    for (const f of evidenceFindings.slice(0, 4))
      positive.push({ kind: 'fact', text: `${f.title}.`, ref: { auditId: usable?.id, codes: [f.code], page: f.page } });
    if (repeated)
      positive.push({
        kind: 'fact',
        text: 'Il sito non ha risposto in audit consecutivi.',
        ref: audit ? { auditId: audit.id } : undefined,
      });

    // ---------- capacità mancanti ----------
    const caps = (Object.entries(svc.capabilityGaps) as [Capability, number][]).map(([capability, importance]) => ({
      capability,
      importance,
      label: CAPABILITIES[capability],
      state: capabilityState(capability, situation, audit),
    }));
    const knownCaps = caps.filter((c) => c.state !== 'unknown');
    let capabilitiesScore: number | null = null;
    if (knownCaps.length) {
      const gap = knownCaps.reduce(
        (s, c) =>
          s + c.importance * (c.state === 'present' ? 0 : catalog.gapFactor[c.state as 'missing' | 'not_detected']),
        0,
      );
      capabilitiesScore = Math.round((gap / knownCaps.reduce((s, c) => s + c.importance, 0)) * 100);
    }
    for (const c of caps) {
      if (c.capability === 'website') continue;
      if (c.state === 'missing')
        positive.push({
          kind: 'fact',
          text: `${c.label}: assente (misurato).`,
          ref: { ...auditRef, capability: c.capability },
        });
      else if (c.state === 'not_detected')
        positive.push({
          kind: 'inference',
          text: `${c.label}: non rilevato nelle pagine esaminate.`,
          ref: { ...auditRef, capability: c.capability },
        });
      else if (c.state === 'present')
        negative.push({
          kind: 'fact',
          text: `${c.label}: già presente.`,
          ref: { ...auditRef, capability: c.capability },
        });
      else unknown.push({ kind: 'fact', text: `${c.label}: non valutabile con le prove attuali.` });
    }

    // ---------- settore ----------
    const relevance = svc.categories[category] ?? 0;

    // ---------- affidabilità (dalla Fase 4) ----------
    const measured = evidenceFindings.length > 0 || repeated || caps.some((c) => c.state === 'missing');
    // un abbinamento basato solo su elementi "non rilevati" è meno affidabile di uno su fatti misurati
    const confidenceValue = Math.round(lead.confidence.value * (measured ? 1 : 0.75));
    const confidenceLevel = levelOf(confidenceValue, scoringConfig);

    // ---------- contesto verificato ----------
    let contextScore: number | null = null;
    let knownW = 0;
    let presentW = 0;
    for (const [key, imp] of Object.entries(svc.context)) {
      let state: boolean | null = null;
      if (key in SOURCE_CONTEXT) state = input.business.has[SOURCE_CONTEXT[key]!] ? true : null;
      else if (usable?.summary.signals) state = signalPresent(key);
      if (state === null) continue;
      knownW += imp;
      if (state) {
        presentW += imp;
        positive.push({ kind: 'fact', text: `Contesto: ${CONTEXT_LABEL[key] ?? key}.` });
      }
    }
    if (knownW > 0) contextScore = Math.round((presentW / knownW) * 100);

    // ---------- combinazione ----------
    const values: Record<MatchDimension, number | null> = {
      findings: findingsScore,
      capabilities: capabilitiesScore,
      category: relevance,
      evidence: confidenceValue,
      context: contextScore,
    };
    const totalW = MATCH_DIMENSIONS.reduce((s, d) => s + catalog.weights[d], 0);
    const activeW = MATCH_DIMENSIONS.reduce((s, d) => s + (values[d] === null ? 0 : catalog.weights[d]), 0);
    const raw =
      activeW > 0 ? MATCH_DIMENSIONS.reduce((s, d) => s + (values[d] ?? 0) * catalog.weights[d], 0) / activeW : null;
    const dimensions = {} as ServiceMatchResult['dimensions'];
    for (const d of MATCH_DIMENSIONS) {
      const eff = values[d] !== null && activeW > 0 ? catalog.weights[d] / activeW : 0;
      dimensions[d] = {
        score: values[d],
        weight: catalog.weights[d],
        effectiveWeight: round1(eff * 100),
        contribution: round1((values[d] ?? 0) * eff),
      };
    }
    const completeness = totalW ? Math.round((activeW / totalW) * 100) : 0;
    const rawScore = raw === null ? null : Math.round(raw * 100) / 100;
    const provisional = rawScore === null ? null : Math.max(0, Math.min(100, Math.round(rawScore)));

    // ---------- stato ----------
    const disqualified = usable?.summary.signals ? svc.disqualifiers.find((q) => signalPresent(q.signal)) : undefined;
    const needEvidence =
      evidenceFindings.length > 0 ||
      repeated ||
      caps.some((c) => c.capability !== 'website' && (c.state === 'missing' || c.state === 'not_detected'));
    let status: MatchStatus;
    let strength: MatchStrength = null;
    let nextStep = svc.nextSteps[0]!;
    if (relevance <= 0) {
      status = 'not_relevant';
      reasons.push(`Servizio non pertinente per il settore ${categoryLabel}.`);
    } else if (disqualified) {
      status = 'not_relevant';
      reasons.push(disqualified.reason);
    } else if (situation.noOwnWebsite) {
      status = 'insufficient_evidence';
      reasons.push(
        input.business.websiteShared
          ? 'La fonte indica solo una pagina su una piattaforma condivisa: l’assenza di un sito proprio non è verificata.'
          : 'La fonte non indica un sito: l’assenza di un sito non è verificata.',
      );
      nextStep = svc.capabilityGaps.website
        ? 'Verificare se l’azienda ha un sito proprio: se non lo ha, il servizio diventa pertinente.'
        : 'Verificare prima se l’azienda ha un sito proprio.';
    } else if (situation.changed) {
      status = 'insufficient_evidence';
      reasons.push('L’indirizzo del sito è cambiato dopo l’ultimo audit: le prove precedenti non valgono più.');
      nextStep = 'Ripetere l’audit del sito.';
    } else if (!usable && !repeated) {
      status = 'insufficient_evidence';
      reasons.push(
        !input.audit
          ? 'Il sito non è ancora stato verificato con un audit.'
          : 'L’ultimo audit non ha potuto esaminare il sito (non raggiungibile o accesso negato): un singolo controllo non basta.',
      );
      nextStep = !input.audit ? 'Avviare l’audit del sito.' : 'Ripetere l’audit più tardi.';
    } else if (!needEvidence) {
      status = 'not_relevant';
      reasons.push('Nessuna prova di un bisogno per questo servizio nelle pagine esaminate.');
    } else if ((activeW / totalW) * 100 < catalog.thresholds.minActiveWeightPct || provisional === null) {
      status = 'insufficient_evidence';
      reasons.push('Prove insufficienti per valutare il servizio.');
    } else if (provisional < catalog.thresholds.possible) {
      status = 'not_relevant';
      reasons.push(`Corrispondenza debole (${provisional}/100, sotto la soglia di ${catalog.thresholds.possible}).`);
    } else {
      strength = provisional >= catalog.thresholds.recommended ? 'recommended' : 'possible';
      status = strength;
      if (svc.requiresTeamConfirmation) {
        status = 'needs_review';
        reasons.push('Da confermare con il team prima di proporlo.');
      }
      if (confidenceValue < catalog.thresholds.minConfidence) {
        status = 'needs_review';
        reasons.push(`Prove poco affidabili (affidabilità ${confidenceValue}/100): verificare prima di proporlo.`);
      }
      if (lead.evidence.freshness === 'stale') {
        status = 'needs_review';
        reasons.push(
          `L’audit ha ${lead.evidence.auditAgeDays} giorni: le prove potrebbero non descrivere più il sito.`,
        );
        nextStep = `Aggiornare l’audit. ${nextStep}`;
      }
    }
    const score = strength ? provisional : null;
    if (audit && !usable && !repeated && status !== 'not_relevant')
      unknown.push({ kind: 'fact', text: 'Rilievi del sito non disponibili nell’ultimo audit.' });
    if (lead.evidence.freshness === 'aging')
      unknown.push({
        kind: 'fact',
        text: `L’audit ha ${lead.evidence.auditAgeDays} giorni: conviene aggiornarlo prima di proporre il servizio.`,
      });
    if (usable && audit && audit.runStatus === 'partial')
      unknown.push({ kind: 'fact', text: 'L’ultimo audit è parziale: alcuni controlli non sono stati completati.' });

    // ---------- problema e spiegazione (solo da prove presenti) ----------
    const topGap = caps.find(
      (c) => c.capability !== 'website' && (c.state === 'missing' || c.state === 'not_detected'),
    );
    const problem = repeated
      ? 'Il sito non risponde in modo ripetuto.'
      : evidenceFindings[0]
        ? `${evidenceFindings[0].title}.`
        : topGap
          ? `${topGap.label}: ${topGap.state === 'missing' ? 'assente' : 'non rilevato nelle pagine esaminate'}.`
          : null;
    const level = { high: 'alta', medium: 'media', low: 'bassa' }[confidenceLevel];
    let explanation: string;
    if (score !== null) {
      const parts: string[] = [];
      if (evidenceFindings.length)
        parts.push(
          `${evidenceFindings.length} ${evidenceFindings.length === 1 ? 'rilievo pertinente' : 'rilievi pertinenti'} dell’audit (${evidenceFindings
            .slice(0, 2)
            .map((f) => f.title.toLowerCase())
            .join('; ')})`,
        );
      if (repeated) parts.push('sito non raggiungibile in audit consecutivi');
      const gaps = caps.filter(
        (c) => c.capability !== 'website' && (c.state === 'missing' || c.state === 'not_detected'),
      );
      // "assenti: …" / "non rilevati nelle pagine esaminate: …": nessun accordo forzato con le etichette, sigle intatte
      const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
      const missing = gaps.filter((g) => g.state === 'missing').map((g) => lower(g.label));
      const notDetected = gaps.filter((g) => g.state === 'not_detected').map((g) => lower(g.label));
      if (missing.length) parts.push(`assenti: ${missing.join(', ')}`);
      if (notDetected.length) parts.push(`non rilevati nelle pagine esaminate: ${notDetected.join(', ')}`);
      parts.push(`settore ${categoryLabel} (pertinenza ${relevance}/100)`);
      explanation = `${svc.name}, corrispondenza ${score}/100: ${parts.join('; ')}. Affidabilità delle prove: ${level}.`;
    } else explanation = `${svc.name}: ${reasons.join(' ')}`;

    return {
      serviceId: svc.id,
      status,
      strength,
      score,
      rawScore,
      confidence: { value: confidenceValue, level: confidenceLevel },
      completeness,
      dimensions,
      evidence: {
        auditId: audit?.id ?? null,
        findings: evidenceFindings,
        capabilities: caps.map((c) => ({ capability: c.capability, label: c.label, state: c.state })),
        repeatedFailure: repeated,
      },
      signals: { positive, negative, unknown },
      reasons,
      problem,
      explanation,
      nextStep,
      dedupeGroup: svc.dedupeGroup,
    };
  }
}

/** Stato effettivo di una revisione (azioni registrate da una persona). */
export type ReviewStatus = 'accepted_for_review' | 'dismissed' | 'needs_review' | null;

export interface ShortlistCandidate {
  serviceId: string;
  status: MatchStatus;
  strength: MatchStrength;
  score: number | null;
  dedupeGroup: string;
  review: ReviewStatus;
}

/**
 * Lista breve: servizi proponibili (consigliati, possibili, da verificare), non archiviati, ordinati per
 * corrispondenza, al massimo uno per problema di fondo; meno voci se le prove sono poco affidabili.
 */
export function shortlist(
  candidates: ShortlistCandidate[],
  catalog: ServiceCatalog,
  confidenceLevel: 'high' | 'medium' | 'low',
): string[] {
  const order = new Map(catalog.services.map((s, i) => [s.id, i]));
  const max = confidenceLevel === 'low' ? catalog.shortlist.maxWithLowConfidence : catalog.shortlist.max;
  const eligible = candidates
    .filter(
      (c) =>
        c.review !== 'dismissed' &&
        c.score !== null &&
        (c.status === 'recommended' || c.status === 'possible' || c.status === 'needs_review'),
    )
    .sort(
      (a, b) =>
        Number(b.review === 'accepted_for_review') - Number(a.review === 'accepted_for_review') ||
        b.score! - a.score! ||
        (order.get(a.serviceId) ?? 99) - (order.get(b.serviceId) ?? 99),
    );
  const groups = new Set<string>();
  const out: string[] = [];
  for (const c of eligible) {
    if (out.length >= max) break;
    if (groups.has(c.dedupeGroup)) continue;
    groups.add(c.dedupeGroup);
    out.push(c.serviceId);
  }
  return out;
}
