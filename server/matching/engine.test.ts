import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORING_CONFIG } from '../scoring/config.ts';
import { scoreLead, type ScoringFinding, type ScoringInput } from '../scoring/engine.ts';
import { DEFAULT_CATALOG, validateCatalog, type ServiceCatalog } from './catalog.ts';
import { matchServices, shortlist, type ShortlistCandidate } from './engine.ts';

/* Abbinamento ai servizi: funzione pura, DATI DI TEST costruiti a mano ("di Prova"). */

const NOW = new Date('2026-10-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const scfg = DEFAULT_SCORING_CONFIG;
const cat = DEFAULT_CATALOG;
const withCat = (patch: (c: ServiceCatalog) => void) => {
  const c = structuredClone(cat);
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
          : code.startsWith('IND_')
            ? 'industry'
            : code.startsWith('CONTENT_')
              ? 'content'
              : 'seo',
  severity: 'medium',
  confidence: 'high',
  observation: 'problem',
  actionable: true,
  service: null,
  page: 'https://prova.example.it/',
  ...over,
});

const SIGNALS: Record<string, boolean> = Object.fromEntries(
  [
    'contactPage',
    'phoneLink',
    'emailLink',
    'contactForm',
    'address',
    'openingHours',
    'privacy',
    'cookie',
    'callToAction',
    'servicesSection',
    'booking',
    'appointment',
    'ordering',
    'menu',
    'ecommerce',
    'rooms',
    'schedule',
    'catalog',
    'social',
  ].map((k) => [k, true]),
);

function input(
  over: {
    category?: string;
    website?: string | null;
    audit?: Partial<NonNullable<ScoringInput['audit']>> | null;
    findings?: ScoringFinding[];
    signals?: Record<string, boolean>;
    recentStatuses?: string[];
  } = {},
): ScoringInput {
  const website = over.website === undefined ? 'https://prova.example.it/' : over.website;
  const audit =
    over.audit === null
      ? null
      : {
          id: '00000000-0000-4000-8000-0000000000a1',
          runStatus: 'completed' as const,
          websiteStatus: 'valid',
          finishedAt: daysAgo(2),
          pagesInspected: 3,
          summary: { homepage: { jsRendered: false }, hasViewport: true, signals: { ...SIGNALS, ...over.signals } },
          findings: over.findings ?? [],
          ...over.audit,
        };
  return {
    business: {
      id: '00000000-0000-4000-8000-0000000000b1',
      category: over.category ?? 'farmacie',
      municipalityCode: '058091',
      websiteUrl: website,
      websiteShared: false,
      has: { website: Boolean(website), address: true, phone: true, email: false, openingHours: true },
      completeness: 4,
      lastVerifiedAt: daysAgo(10),
      pendingReviews: 0,
    },
    website: { websiteId: website ? 'w' : null, linkedUrl: website, linkStatus: null },
    audit,
    recentStatuses: over.recentStatuses ?? (audit ? [audit.websiteStatus] : []),
  };
}

const run = (i: ScoringInput, c: ServiceCatalog = cat) => matchServices(i, scoreLead(i, scfg, NOW), scfg, c);
const byId = (r: ReturnType<typeof run>) => Object.fromEntries(r.matches.map((m) => [m.serviceId, m]));
const listed = (r: ReturnType<typeof run>, reviews: Record<string, ShortlistCandidate['review']> = {}, c = cat) =>
  shortlist(
    r.matches.map((m) => ({ ...m, review: reviews[m.serviceId] ?? null })),
    c,
    r.confidenceLevel,
  );

describe('catalogo', () => {
  it('solo servizi verificati su noventra.it; quelli senza prove automatiche restano manuali', () => {
    expect(validateCatalog(cat).ok).toBe(true);
    for (const s of cat.services) {
      expect(s.verified).toBe(true);
      expect(s.source).toMatch(/^https:\/\/www\.noventra\.it\//);
    }
    const manual = cat.services.filter((s) => !s.autoMatch).map((s) => s.id);
    expect(manual).toEqual(
      expect.arrayContaining(['app_mobile', 'intelligenza_artificiale', 'web_advertising', 'digital_marketing']),
    );
    // i servizi manuali non vengono mai valutati in automatico
    const ids = run(input({ findings: [finding('SEO_NOINDEX', { severity: 'high' })] })).matches.map(
      (m) => m.serviceId,
    );
    for (const id of manual) expect(ids).not.toContain(id);
  });

  it('configurazione non valida: pesi, soglie, servizio non confermato attivo, id ripetuti, prerequisiti sconosciuti', () => {
    const bad = (p: (c: ServiceCatalog) => void) => validateCatalog(withCat(p));
    expect(bad((c) => (c.weights.findings = -1))).toMatchObject({ ok: false });
    expect(bad((c) => (c.thresholds.possible = 70))).toMatchObject({ ok: false });
    expect(bad((c) => (c.services[0]!.verified = false))).toMatchObject({
      ok: false,
      errors: { 'services.0.active': expect.any(String) },
    });
    expect(bad((c) => c.services.push(structuredClone(c.services[0]!)))).toMatchObject({ ok: false });
    expect(bad((c) => (c.services[0]!.prerequisites = ['inventato']))).toMatchObject({ ok: false });
    expect(bad((c) => (c.services[0]!.source = 'https://altro-sito.it/x'))).toMatchObject({ ok: false });
    expect(bad((c) => (c.shortlist.maxWithLowConfidence = 9))).toMatchObject({ ok: false });
  });
});

describe('abbinamento', () => {
  it('deterministico, tra 0 e 100, pesi normalizzati sulle sole dimensioni con prove', () => {
    const i = input({
      findings: [finding('SEO_NOINDEX', { severity: 'high' }), finding('MOBILE_NO_VIEWPORT', { severity: 'high' })],
    });
    expect(run(structuredClone(i))).toEqual(run(i));
    for (const m of run(i).matches) {
      if (m.score !== null) {
        expect(m.score).toBeGreaterThanOrEqual(0);
        expect(m.score).toBeLessThanOrEqual(100);
      }
      const active = Object.values(m.dimensions).filter((d) => d.score !== null);
      if (m.rawScore !== null) {
        expect(m.rawScore).toBeCloseTo(
          active.reduce((s, d) => s + d.score! * d.weight, 0) / active.reduce((s, d) => s + d.weight, 0),
          2,
        );
        expect(active.reduce((s, d) => s + d.effectiveWeight, 0)).toBeCloseTo(100, 0);
      }
    }
    // GEO non ha capacità collegate: la dimensione è esclusa, non vale 0
    expect(byId(run(i)).geo!.dimensions.capabilities.score).toBeNull();
  });

  it('rilievi → servizi: indicizzazione → SEO, viewport → sviluppo siti, HTTPS → hosting', () => {
    const m = byId(
      run(
        input({
          findings: [
            finding('SEO_NOINDEX', { severity: 'high' }),
            finding('MOBILE_NO_VIEWPORT', { severity: 'high' }),
            finding('SEC_NO_HTTPS', { severity: 'high' }),
          ],
          audit: { summary: { homepage: { jsRendered: false }, hasViewport: false, signals: SIGNALS } },
        }),
      ),
    );
    expect(m.seo).toMatchObject({
      status: 'recommended',
      evidence: { findings: [expect.objectContaining({ code: 'SEO_NOINDEX' })] },
    });
    expect(m.sviluppo_siti_web!.status).toBe('recommended');
    expect(m.sviluppo_siti_web!.problem).toBe('Pagina non configurata per i dispositivi mobili.');
    expect(m.hosting_assistenza!.status).toBe('recommended');
    expect(m.seo!.explanation).toMatch(
      /^SEO Optimization, corrispondenza \d+\/100: 1 rilievo pertinente dell’audit \(la pagina chiede di non essere indicizzata\)/,
    );
  });

  it('intestazioni di sicurezza mancanti da sole: nessuna proposta di assistenza', () => {
    const m = byId(run(input({ findings: [finding('SEC_HEADERS_MISSING', { severity: 'info' })] })));
    expect(m.hosting_assistenza!.status).toBe('not_relevant');
  });

  it('sito curato: nessun servizio proposto, lista vuota', () => {
    const r = run(input());
    expect(r.matches.every((m) => m.status === 'not_relevant')).toBe(true);
    expect(listed(r)).toEqual([]);
  });

  it('nessun sito indicato: prove insufficienti, mai "assenza confermata"', () => {
    const r = run(input({ website: null, audit: null }));
    expect(r.matches.every((m) => m.status === 'insufficient_evidence' || m.status === 'not_relevant')).toBe(true);
    const site = byId(r).sviluppo_siti_web!;
    expect(site.status).toBe('insufficient_evidence');
    expect(site.score).toBeNull();
    expect(site.reasons.join(' ')).toMatch(/non è verificata/);
    expect(site.nextStep).toMatch(/Verificare se l’azienda ha un sito proprio/);
    expect(listed(r)).toEqual([]);
  });

  it('sito irraggiungibile una volta: prove insufficienti; in audit consecutivi: assistenza consigliata', () => {
    const once = byId(run(input({ audit: { websiteStatus: 'unreachable', runStatus: 'partial' } })));
    expect(once.hosting_assistenza!.status).toBe('insufficient_evidence');
    expect(once.sviluppo_siti_web!.status).toBe('insufficient_evidence');
    const twice = byId(
      run(
        input({
          audit: { websiteStatus: 'unreachable', runStatus: 'partial' },
          recentStatuses: ['unreachable', 'timeout'],
        }),
      ),
    );
    expect(twice.hosting_assistenza).toMatchObject({
      status: 'recommended',
      evidence: { repeatedFailure: true },
      problem: 'Il sito non risponde in modo ripetuto.',
    });
    expect(twice.seo!.status).toBe('insufficient_evidence');
  });

  it('"non rilevato" e "sconosciuto" non sono "assente": contenuti generati da JavaScript', () => {
    const shop = (jsRendered: boolean) =>
      byId(
        run(
          input({
            category: 'negozi',
            signals: { ecommerce: false },
            audit: {
              summary: { homepage: { jsRendered }, hasViewport: true, signals: { ...SIGNALS, ecommerce: false } },
            },
          }),
        ),
      ).ecommerce_shopify!;
    expect(shop(false).evidence.capabilities.find((c) => c.capability === 'ecommerce')?.state).toBe('not_detected');
    expect(shop(false).signals.positive.find((s) => s.kind === 'inference')?.text).toMatch(
      /non rilevato nelle pagine esaminate/,
    );
    const js = shop(true);
    expect(js.evidence.capabilities.find((c) => c.capability === 'ecommerce')?.state).toBe('unknown');
    expect(js.status).toBe('not_relevant');
  });

  it('settore: Farmacube solo per farmacie; e-commerce non proposto se il negozio online c’è già', () => {
    const noShop = { ecommerce: false };
    expect(byId(run(input({ category: 'farmacie', signals: noShop }))).farmacube!.status).not.toBe('not_relevant');
    expect(byId(run(input({ category: 'ristorazione', signals: noShop }))).farmacube).toMatchObject({
      status: 'not_relevant',
      reasons: [expect.stringMatching(/non pertinente per il settore/)],
    });
    expect(byId(run(input({ category: 'negozi', signals: { ecommerce: true } }))).ecommerce_shopify).toMatchObject({
      status: 'not_relevant',
      reasons: ['Un negozio online è già presente sul sito.'],
    });
    // il settore da solo non basta: un negozio con il sito completo non riceve e-commerce
    expect(byId(run(input({ category: 'negozi' }))).ecommerce_shopify!.status).toBe('not_relevant');
  });

  it('servizi da confermare con il team e audit superato: da verificare', () => {
    // hotel realistico senza prenotazione: nessun segnale di prenotazione, ordine o appuntamento, e il rilievo di settore
    const hotel = byId(
      run(
        input({
          category: 'hotel',
          signals: { booking: false, appointment: false, ordering: false },
          findings: [finding('IND_HOTEL_NO_DIRECT_BOOKING', { severity: 'medium' })],
        }),
      ),
    ).gestionali_crm!;
    expect(hotel.status).toBe('needs_review');
    expect(hotel.reasons.join(' ')).toMatch(/confermare con il team/);
    const stale = byId(
      run(input({ findings: [finding('SEO_NOINDEX', { severity: 'high' })], audit: { finishedAt: daysAgo(300) } })),
    ).seo!;
    expect(stale.status).toBe('needs_review');
    expect(stale.nextStep).toMatch(/^Aggiornare l’audit/);
  });

  it('audit parziale: limite dichiarato', () => {
    const m = byId(
      run(input({ findings: [finding('SEO_NOINDEX', { severity: 'high' })], audit: { runStatus: 'partial' } })),
    ).seo!;
    expect(m.signals.unknown.map((s) => s.text).join(' ')).toMatch(/parziale/);
  });

  it('settore senza regole di pertinenza: nessun servizio proposto per quel settore', () => {
    const c = withCat((x) => {
      for (const s of x.services) delete s.categories.farmacie;
    });
    const r = run(input({ findings: [finding('SEO_NOINDEX', { severity: 'high' })] }), c);
    expect(r.matches.every((m) => m.status === 'not_relevant')).toBe(true);
  });

  it('soglie: 60 → consigliato, 59 → possibile, 40 → possibile, 39 → non pertinente', () => {
    const i = input({ findings: [finding('SEO_NOINDEX', { severity: 'high' })] });
    const raw = byId(run(i)).seo!.rawScore!;
    const at = (score: number) => {
      const shift = Math.round(raw) - score;
      return byId(
        run(
          i,
          withCat((c) => (c.thresholds = { ...c.thresholds, recommended: 60 + shift, possible: 40 + shift })),
        ),
      ).seo!.status;
    };
    expect(at(60)).toBe('recommended');
    expect(at(59)).toBe('possible');
    expect(at(40)).toBe('possible');
    expect(at(39)).toBe('not_relevant');
  });

  it('caso reale: farmacia con un negozio Magento il cui carrello non compare nelle pagine esaminate', () => {
    const i = input({
      signals: { ecommerce: false },
      findings: [finding('IND_NO_ECOMMERCE', { severity: 'low' })],
      audit: {
        summary: {
          homepage: { jsRendered: false },
          hasViewport: true,
          signals: { ...SIGNALS, ecommerce: false },
          platforms: ['Magento'],
        },
      },
    });
    const m = byId(run(i));
    // la piattaforma di e-commerce è una prova diretta di vendita online: nessun nuovo negozio proposto
    expect(m.farmacube).toMatchObject({
      status: 'not_relevant',
      reasons: ['Un negozio online è già presente sul sito.'],
    });
    expect(m.ecommerce_shopify!.status).toBe('not_relevant');
    expect(scoreLead(i, scfg, NOW).capabilities.find((c) => c.capability === 'catalog')?.state).toBe('present');
  });

  it('spiegazione: "non rilevati nelle pagine esaminate: …", sigle intatte', () => {
    const m = byId(
      run(input({ findings: [finding('SEO_NOINDEX', { severity: 'high' })], signals: { address: false } })),
    ).seo!;
    expect(m.explanation).toMatch(/non rilevati nelle pagine esaminate: segnali di SEO locale \(/);
  });
});

describe('punteggio del lead e corrispondenza restano separati', () => {
  it('il punteggio del lead non entra nel calcolo', () => {
    const i = input({ findings: [finding('SEO_NOINDEX', { severity: 'high' })] });
    const lead = scoreLead(i, scfg, NOW);
    const a = matchServices(i, lead, scfg, cat);
    const b = matchServices(i, { ...lead, score: 99, band: 'A' } as typeof lead, scfg, cat);
    expect(b).toEqual(a);
  });

  it('lead con priorità bassa ma un servizio fortemente pertinente', () => {
    const i = input({
      findings: [finding('SEO_NOINDEX', { severity: 'high' }), finding('SEO_MISSING_TITLE', { severity: 'high' })],
    });
    const lead = scoreLead(i, scfg, NOW);
    expect(lead.band === 'low' || lead.band === 'C').toBe(true);
    expect(byId(run(i)).seo).toMatchObject({ status: 'recommended' });
    expect(byId(run(i)).seo!.score!).toBeGreaterThan(lead.score!);
  });

  it('lead in fascia alta senza servizi automatici pertinenti', () => {
    // hotel senza prenotazione né camere: priorità alta per le capacità mancanti, ma l'unico servizio collegato
    // (gestionali) va confermato dal team: nessun servizio "consigliato" in automatico
    const i = input({
      category: 'hotel',
      signals: { booking: false, rooms: false, callToAction: false, servicesSection: false },
      findings: [finding('IND_HOTEL_NO_DIRECT_BOOKING', { severity: 'medium' })],
    });
    const lead = scoreLead(i, scfg, NOW);
    const r = run(i);
    expect(r.matches.filter((m) => m.status === 'recommended').map((m) => m.serviceId)).not.toContain('gestionali_crm');
    expect(lead.score).not.toBeNull();
  });
});

describe('lista breve', () => {
  const many = input({
    findings: [
      finding('SEO_NOINDEX', { severity: 'high' }),
      finding('SEO_NO_STRUCTURED_DATA', { severity: 'low' }),
      finding('MOBILE_NO_VIEWPORT', { severity: 'high' }),
      finding('SEC_NO_HTTPS', { severity: 'high' }),
      finding('CONTENT_NO_CTA', { severity: 'low' }),
    ],
    signals: { callToAction: false, servicesSection: false },
    audit: {
      summary: {
        homepage: { jsRendered: false },
        hasViewport: false,
        signals: { ...SIGNALS, callToAction: false, servicesSection: false },
      },
    },
  });

  it('al massimo 3, ordinata per corrispondenza, un solo servizio per problema di fondo (SEO o GEO)', () => {
    const r = run(many);
    const list = listed(r);
    expect(list.length).toBe(3);
    const scores = list.map((id) => byId(r)[id]!.score!);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(list.filter((id) => id === 'seo' || id === 'geo').length).toBeLessThanOrEqual(1);
    expect(
      listed(
        r,
        {},
        withCat((c) => (c.shortlist.max = 1)),
      ),
    ).toHaveLength(1);
  });

  it('archiviati esclusi (resta il prossimo), accettati in testa', () => {
    const r = run(many);
    const first = listed(r)[0]!;
    expect(listed(r, { [first]: 'dismissed' })).not.toContain(first);
    const last = listed(r).at(-1)!;
    expect(listed(r, { [last]: 'accepted_for_review' })[0]).toBe(last);
  });

  it('prove poco affidabili: meno voci', () => {
    expect(
      shortlist(
        run(many).matches.map((m) => ({ ...m, review: null })),
        cat,
        'low',
      ).length,
    ).toBeLessThanOrEqual(cat.shortlist.maxWithLowConfidence);
  });
});
