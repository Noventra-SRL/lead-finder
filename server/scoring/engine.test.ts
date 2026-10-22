import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORING_CONFIG, validateScoringConfig, type ScoringConfig } from './config.ts';
import { scoreLead, type ScoringFinding, type ScoringInput } from './engine.ts';

/* Motore del punteggio: funzione pura, dati di prova costruiti a mano. */

const NOW = new Date('2026-10-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const cfg = DEFAULT_SCORING_CONFIG;
const withCfg = (patch: (c: ScoringConfig) => void) => {
  const c = structuredClone(cfg);
  patch(c);
  return c;
};

const finding = (code: string, over: Partial<ScoringFinding> = {}): ScoringFinding => ({
  code,
  category: code.startsWith('SEC_')
    ? 'security'
    : code.startsWith('MOBILE_')
      ? 'mobile'
      : code.startsWith('PERF_')
        ? 'performance'
        : code.startsWith('AVAIL_')
          ? 'availability'
          : 'seo',
  severity: 'medium',
  confidence: 'high',
  observation: 'problem',
  actionable: true,
  service: 'seo',
  page: 'https://esempio.it/',
  ...over,
});

const ALL_SIGNALS = {
  contactPage: true,
  phoneLink: true,
  emailLink: true,
  contactForm: true,
  address: true,
  openingHours: true,
  privacy: true,
  cookie: true,
  callToAction: true,
  servicesSection: true,
  booking: true,
  appointment: true,
  ordering: true,
  menu: true,
  ecommerce: true,
  rooms: true,
  schedule: true,
  catalog: true,
  otaLinks: false,
  social: true,
};

function input(
  over: {
    category?: string;
    website?: string | null;
    shared?: boolean;
    audit?: Partial<NonNullable<ScoringInput['audit']>> | null;
    findings?: ScoringFinding[];
    signals?: Partial<typeof ALL_SIGNALS>;
    recentStatuses?: string[];
    linkedUrl?: string | null;
    pendingReviews?: number;
    lastVerifiedDays?: number;
  } = {},
): ScoringInput {
  const website = over.website === undefined ? 'https://esempio.it/' : over.website;
  const audit =
    over.audit === null
      ? null
      : {
          id: '00000000-0000-4000-8000-0000000000a1',
          runStatus: 'completed' as const,
          websiteStatus: 'valid',
          finishedAt: daysAgo(3),
          pagesInspected: 3,
          summary: { homepage: { jsRendered: false }, hasViewport: true, signals: { ...ALL_SIGNALS, ...over.signals } },
          findings: over.findings ?? [],
          ...over.audit,
        };
  return {
    business: {
      id: '00000000-0000-4000-8000-0000000000b1',
      category: over.category ?? 'farmacie',
      municipalityCode: '058091',
      websiteUrl: website,
      websiteShared: over.shared ?? false,
      has: { website: Boolean(website), address: true, phone: true, email: false, openingHours: true },
      completeness: 4,
      lastVerifiedAt: daysAgo(over.lastVerifiedDays ?? 10),
      pendingReviews: over.pendingReviews ?? 0,
    },
    website: {
      websiteId: website ? '00000000-0000-4000-8000-0000000000c1' : null,
      linkedUrl: over.linkedUrl === undefined ? website : over.linkedUrl,
      linkStatus: null,
    },
    audit,
    recentStatuses: over.recentStatuses ?? (audit ? [audit.websiteStatus] : []),
  };
}

const MANY_ISSUES = [
  finding('SEC_NO_HTTPS', { severity: 'high', service: 'hosting_assistenza' }),
  finding('MOBILE_NO_VIEWPORT', { severity: 'high', service: 'sviluppo_siti_web' }),
  finding('SEO_MISSING_TITLE', { severity: 'high' }),
  finding('SEO_NO_SITEMAP', { severity: 'low' }),
  finding('SEO_BROKEN_INTERNAL_LINKS', { severity: 'medium', service: 'sviluppo_siti_web' }),
];

describe('punteggio: proprietà generali', () => {
  it('sempre tra 0 e 100, intero, e deterministico', () => {
    const cases = [
      input(),
      input({
        findings: MANY_ISSUES,
        signals: { booking: false, appointment: false, catalog: false, ecommerce: false },
      }),
      input({ website: null, audit: null }),
      input({ audit: { websiteStatus: 'unreachable' }, findings: [] }),
    ];
    for (const c of cases) {
      const a = scoreLead(c, cfg, NOW);
      const b = scoreLead(structuredClone(c), cfg, NOW);
      expect(b).toEqual(a);
      expect(a.rawScore === null || (a.rawScore >= 0 && a.rawScore <= 100)).toBe(true);
      if (a.score !== null) {
        expect(Number.isInteger(a.score)).toBe(true);
        expect(a.score).toBeGreaterThanOrEqual(0);
        expect(a.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('normalizzazione: punteggio grezzo = Σ valore × peso / Σ pesi delle sole dimensioni con prove', () => {
    const r = scoreLead(input({ findings: MANY_ISSUES }), cfg, NOW);
    const dims = Object.values(r.dimensions);
    const active = dims.filter((d) => d.score !== null);
    const expected = active.reduce((s, d) => s + d.score! * d.weight, 0) / active.reduce((s, d) => s + d.weight, 0);
    expect(r.rawScore).toBeCloseTo(expected, 2);
    expect(active.reduce((s, d) => s + d.effectiveWeight, 0)).toBeCloseTo(100, 0);
    expect(r.score).toBe(Math.round(r.rawScore!));
    // pesi raddoppiati in proporzione: stesso risultato
    const doubled = withCfg((c) => {
      for (const k of Object.keys(c.weights) as (keyof typeof c.weights)[]) c.weights[k] *= 2;
    });
    expect(scoreLead(input({ findings: MANY_ISSUES }), doubled, NOW).score).toBe(r.score);
  });

  it('configurazione non valida: pesi negativi, tutti zero, fasce non ordinate, gruppi sovrapposti', () => {
    const bad = (patch: (c: ScoringConfig) => void) => validateScoringConfig(withCfg(patch));
    expect(bad((c) => (c.weights.technical = -1))).toMatchObject({ ok: false });
    expect(
      bad((c) => {
        for (const k of Object.keys(c.weights) as (keyof typeof c.weights)[]) c.weights[k] = 0;
      }),
    ).toMatchObject({ ok: false, errors: { weights: expect.any(String) } });
    expect(bad((c) => (c.bands.B = 90))).toMatchObject({ ok: false });
    expect(bad((c) => c.technical.groups.https!.push('SEO_MISSING_TITLE'))).toMatchObject({ ok: false });
    expect(bad((c) => (c.categories.farmacie!.capabilities = { volo: 1 } as never))).toMatchObject({ ok: false });
    expect(validateScoringConfig({ ...cfg, extra: 1 })).toMatchObject({ ok: false });
    expect(validateScoringConfig(cfg)).toMatchObject({ ok: true });
  });
});

describe('dati mancanti e prove insufficienti', () => {
  it('nessun sito indicato dalla fonte: dati insufficienti, assenza NON confermata, mai trattata come problema certo', () => {
    const r = scoreLead(input({ website: null, audit: null }), cfg, NOW);
    expect(r.status).toBe('insufficient_data');
    expect(r.score).toBeNull();
    expect(r.band).toBeNull();
    expect(r.dimensions.technical.score).toBeNull();
    expect(r.capabilities.find((c) => c.capability === 'website')?.state).toBe('not_detected');
    expect(r.signals.unknown.map((s) => s.text).join(' ')).toMatch(/non è verificata/);
    expect(r.nextStep).toMatch(/Verifica se l’azienda ha un sito/);
  });

  it('sito irraggiungibile una volta: non è "senza sito", i problemi tecnici restano sconosciuti', () => {
    const r = scoreLead(input({ audit: { websiteStatus: 'unreachable', runStatus: 'partial' } }), cfg, NOW);
    expect(r.status).toBe('insufficient_data');
    expect(r.dimensions.technical.score).toBeNull();
    expect(r.capabilities.find((c) => c.capability === 'website')?.state).toBe('unknown');
    expect(r.nextStep).toMatch(/Ripeti l’audit più tardi/);
    // nemmeno "bloccato" equivale a "assente"
    const blocked = scoreLead(input({ audit: { websiteStatus: 'blocked', runStatus: 'partial' } }), cfg, NOW);
    expect(blocked.capabilities.find((c) => c.capability === 'website')?.state).toBe('unknown');
    expect(blocked.signals.unknown.map((s) => s.text).join(' ')).toMatch(/non significa che manchi/);
  });

  it('sito irraggiungibile in audit consecutivi: problema ripetuto, valutato', () => {
    const r = scoreLead(
      input({
        audit: { websiteStatus: 'unreachable', runStatus: 'partial' },
        recentStatuses: ['unreachable', 'timeout'],
      }),
      cfg,
      NOW,
    );
    expect(r.dimensions.technical.score).toBe(cfg.technical.repeatedFailureScore);
    expect(r.services.find((s) => s.service === 'hosting_assistenza')).toBeUndefined(); // non tra i servizi del settore farmacie
  });

  it('nessun audit: dimensioni del sito sconosciute (non 0, non 100), completezza bassa', () => {
    const r = scoreLead(input({ audit: null }), cfg, NOW);
    expect(r.dimensions.technical.score).toBeNull();
    expect(r.dimensions.capabilities.score).toBeNull();
    expect(r.dimensions.industry.score).toBeNull();
    expect(r.status).toBe('insufficient_data');
    expect(r.completeness.value).toBeLessThan(cfg.thresholds.minCompleteness);
    expect(r.nextStep).toMatch(/Avvia l’audit/);
  });

  it('indirizzo del sito cambiato dopo l’audit: le prove vecchie non valgono', () => {
    const r = scoreLead(input({ linkedUrl: 'https://vecchio-sito.it/', findings: MANY_ISSUES }), cfg, NOW);
    expect(r.dimensions.technical.score).toBeNull();
    expect(r.status).toBe('insufficient_data');
    expect(r.nextStep).toMatch(/indirizzo del sito è cambiato/);
  });
});

describe('dimensioni', () => {
  it('rilievi dello stesso problema raggruppati: tre rilievi di metadati non valgono tre problemi', () => {
    const one = scoreLead(input({ findings: [finding('SEO_MISSING_META_DESCRIPTION')] }), cfg, NOW);
    const three = scoreLead(
      input({
        findings: [
          finding('SEO_MISSING_META_DESCRIPTION'),
          finding('SEO_NO_OPEN_GRAPH'),
          finding('SEO_META_DESCRIPTION_LENGTH', { page: 'https://esempio.it/contatti' }),
        ],
      }),
      cfg,
      NOW,
    );
    const separate = scoreLead(
      input({
        findings: [
          finding('SEO_MISSING_META_DESCRIPTION'),
          finding('SEC_HTTP_NOT_REDIRECTED'),
          finding('MOBILE_LEGACY_LAYOUT'),
        ],
      }),
      cfg,
      NOW,
    );
    expect(three.topFindings).toHaveLength(1);
    expect(three.topFindings[0]!.codes).toHaveLength(3);
    // il gruppo aggiunge solo una frazione dei rilievi secondari
    expect(three.dimensions.technical.score!).toBeLessThan(one.dimensions.technical.score! * 2);
    expect(separate.dimensions.technical.score!).toBeGreaterThan(three.dimensions.technical.score!);
    // lo stesso rilievo su più pagine è un solo problema
    const pages = scoreLead(
      input({ findings: [finding('SEO_MISSING_H1'), finding('SEO_MISSING_H1', { page: 'https://esempio.it/a' })] }),
      cfg,
      NOW,
    );
    expect(pages.dimensions.technical.score).toBe(
      scoreLead(input({ findings: [finding('SEO_MISSING_H1')] }), cfg, NOW).dimensions.technical.score,
    );
  });

  it('gravità e affidabilità: alta > media > bassa; informativi e "non verificato" non contano', () => {
    const t = (f: ScoringFinding) => scoreLead(input({ findings: [f] }), cfg, NOW).dimensions.technical.score!;
    expect(t(finding('SEC_NO_HTTPS', { severity: 'high' }))).toBeGreaterThan(
      t(finding('SEC_NO_HTTPS', { severity: 'medium' })),
    );
    expect(t(finding('SEC_NO_HTTPS', { severity: 'medium' }))).toBeGreaterThan(
      t(finding('SEC_NO_HTTPS', { severity: 'low' })),
    );
    expect(t(finding('SEC_NO_HTTPS', { confidence: 'high' }))).toBeGreaterThan(
      t(finding('SEC_NO_HTTPS', { confidence: 'low' })),
    );
    expect(t(finding('SEC_HEADERS_MISSING', { severity: 'info' }))).toBe(0);
    expect(t(finding('SEO_NO_SITEMAP', { observation: 'not_inspected' }))).toBe(0);
    expect(t(finding('SEO_NO_SITEMAP', { actionable: false }))).toBe(0);
  });

  it('capacità: solo quelle pertinenti al settore; "non rilevato" pesa meno di "assente"; presenti = nessuna lacuna', () => {
    const factory = scoreLead(
      input({ category: 'industria', signals: { menu: false, booking: false, rooms: false } }),
      cfg,
      NOW,
    );
    expect(factory.capabilities.map((c) => c.capability)).not.toContain('menu');
    expect(factory.capabilities.map((c) => c.capability)).not.toContain('reservation');
    const office = scoreLead(input({ category: 'studi_professionali', signals: { ecommerce: false } }), cfg, NOW);
    expect(office.capabilities.map((c) => c.capability)).not.toContain('ecommerce');

    const full = scoreLead(input({ category: 'ristorazione' }), cfg, NOW);
    expect(full.dimensions.capabilities.score).toBe(0);
    const noMenu = scoreLead(input({ category: 'ristorazione', signals: { menu: false } }), cfg, NOW);
    expect(noMenu.capabilities.find((c) => c.capability === 'menu')?.state).toBe('not_detected');
    const noViewport = scoreLead(
      input({
        category: 'ristorazione',
        audit: { summary: { homepage: { jsRendered: false }, hasViewport: false, signals: ALL_SIGNALS } },
        findings: [finding('MOBILE_NO_VIEWPORT', { severity: 'high' })],
      }),
      cfg,
      NOW,
    );
    expect(noViewport.capabilities.find((c) => c.capability === 'mobile')?.state).toBe('missing');
    // stessa importanza (menù 3 vs … ): "assente" (1,0) pesa più di "non rilevato" (0,6) a parità di peso
    expect(cfg.capabilities.gapFactor.missing).toBeGreaterThan(cfg.capabilities.gapFactor.not_detected);
    // contenuti generati da JavaScript: ciò che non si vede è "sconosciuto", non "non rilevato"
    const js = scoreLead(
      input({
        category: 'ristorazione',
        signals: { menu: false },
        audit: {
          summary: { homepage: { jsRendered: true }, hasViewport: true, signals: { ...ALL_SIGNALS, menu: false } },
        },
      }),
      cfg,
      NOW,
    );
    expect(js.capabilities.find((c) => c.capability === 'menu')?.state).toBe('unknown');
  });

  it('settore: da solo non genera punteggio; conta solo con lacune collegate ai suoi servizi', () => {
    const clean = scoreLead(input({ category: 'hotel' }), cfg, NOW);
    expect(clean.dimensions.industry.score).toBe(0);
    const gaps = scoreLead(input({ category: 'hotel', signals: { booking: false, rooms: false } }), cfg, NOW);
    expect(gaps.dimensions.industry.score!).toBeGreaterThan(0);
    expect(gaps.dimensions.industry.score!).toBeLessThanOrEqual(cfg.categories.hotel!.baseRelevance);
    expect(gaps.services.find((s) => s.service === 'gestionali_crm')).toMatchObject({ supported: true });
  });

  it('affidabilità separata dall’opportunità: prove recenti > invecchiate > superate', () => {
    const fresh = scoreLead(input({ findings: MANY_ISSUES }), cfg, NOW);
    const aging = scoreLead(input({ findings: MANY_ISSUES, audit: { finishedAt: daysAgo(60) } }), cfg, NOW);
    const stale = scoreLead(input({ findings: MANY_ISSUES, audit: { finishedAt: daysAgo(400) } }), cfg, NOW);
    expect(fresh.confidence.value).toBeGreaterThan(aging.confidence.value);
    expect(aging.confidence.value).toBeGreaterThan(stale.confidence.value);
    expect(fresh.evidence.freshness).toBe('fresh');
    expect(stale.evidence.freshness).toBe('stale');
    expect(stale.signals.unknown.map((s) => s.text).join(' ')).toMatch(/400 giorni/);
    expect(stale.nextStep).toMatch(/Aggiorna l’audit/);
    // le pagine esaminate non sono "più prove": oltre la seconda non aumentano l'affidabilità
    const many = scoreLead(input({ findings: MANY_ISSUES, audit: { pagesInspected: 10 } }), cfg, NOW);
    expect(many.confidence.value).toBe(fresh.confidence.value);
  });

  it('prove deboli su un problema serio: da verificare, non in cima alla classifica', () => {
    const weak = MANY_ISSUES.map((f) => ({ ...f, confidence: 'low' as const }));
    const c = withCfg((x) => (x.thresholds.minConfidence = 70));
    const r = scoreLead(input({ findings: weak, audit: { finishedAt: daysAgo(200), runStatus: 'partial' } }), c, NOW);
    expect(r.status).toBe('needs_review');
    expect(r.reasons.join(' ')).toMatch(/prove poco affidabili/);
  });

  it('possibile duplicato in sospeso: da verificare', () => {
    expect(scoreLead(input({ findings: MANY_ISSUES, pendingReviews: 1 }), cfg, NOW).status).toBe('needs_review');
  });
});

describe('fasce e stati', () => {
  it('soglie: 80 → A, 79 → B, 60 → B, 59 → C, 40 → C, 39 → bassa', () => {
    // un solo dato attivo controllato: la dimensione delle prove, con le altre a peso zero
    const only = withCfg((c) => {
      c.weights = { technical: 0, capabilities: 0, industry: 0, evidence: 1, commercial: 0 };
      c.thresholds.minConfidence = 0;
      c.thresholds.minActiveWeightPct = 0;
    });
    const r = scoreLead(input({ findings: MANY_ISSUES }), only, NOW);
    const value = r.confidence.value;
    const at = (score: number) => {
      const c = structuredClone(only);
      // sposta le fasce attorno al valore misurato per verificare i confini esatti
      const shift = value - score;
      c.bands = { A: 80 + shift, B: 60 + shift, C: 40 + shift };
      return scoreLead(input({ findings: MANY_ISSUES }), c, NOW).band;
    };
    expect(r.score).toBe(value);
    expect(at(80)).toBe('A');
    expect(at(79)).toBe('B');
    expect(at(60)).toBe('B');
    expect(at(59)).toBe('C');
    expect(at(40)).toBe('C');
    expect(at(39)).toBe('low');
  });

  it('opportunità forte e documentata → Priorità A con spiegazione basata solo sui dati', () => {
    const r = scoreLead(
      input({
        category: 'hotel',
        findings: MANY_ISSUES,
        signals: { booking: false, rooms: false, callToAction: false, servicesSection: false },
      }),
      cfg,
      NOW,
    );
    expect(r.status).toBe('ranked');
    expect(['A', 'B']).toContain(r.band);
    expect(r.explanation).toMatch(
      /^Priorità (A|B): sito ufficiale raggiungibile con 5 problemi tecnici documentati \(3 di gravità alta\)/,
    );
    expect(r.explanation).toMatch(/Affidabilità delle prove: alta/);
    expect(r.topFindings[0]).toMatchObject({ auditId: '00000000-0000-4000-8000-0000000000a1' });
    for (const s of r.signals.positive.filter((x) => x.dimension === 'technical'))
      expect(s.ref?.codes?.length).toBeGreaterThan(0);
  });

  it('spiegazione in italiano corretto: singolare, sigle intatte, nessun accordo forzato', () => {
    const r = scoreLead(
      input({ findings: [finding('SEO_MISSING_H1')], signals: { address: false, openingHours: false } }),
      cfg,
      NOW,
    );
    expect(r.explanation).toMatch(/con 1 problema tecnico documentato;/);
    expect(r.explanation).toMatch(
      /non rilevati nelle pagine esaminate: segnali di SEO locale \(.+\), orari di apertura;/,
    );
  });

  it('sito curato senza lacune → priorità bassa, non "non adatta"', () => {
    const r = scoreLead(input(), cfg, NOW);
    expect(r.status).toBe('ranked');
    expect(r.band).toBe('low');
    expect(r.explanation).toMatch(/senza problemi tecnici rilevanti/);
  });

  it('"non adatta" solo per una regola esplicita della configurazione', () => {
    const c = withCfg((x) => (x.rules.notSuitableCategories = ['farmacie']));
    const r = scoreLead(input({ findings: MANY_ISSUES }), c, NOW);
    expect(r).toMatchObject({ status: 'not_suitable', score: null, band: null });
    expect(r.reasons[0]).toMatch(/escluso dalla configurazione/);
  });
});
