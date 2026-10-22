import type { Queryable } from '../db/client.ts';
import { FINDINGS, type FindingCode } from '../audit/findings.ts';

/*
 * SOLO PER I TEST: aziende e audit "di Prova" inseriti direttamente nel database, con rilievi scelti dal test.
 * Non fa parte dell'applicazione e non viene mai usato fuori dai test.
 */

let n = 0;

export async function insertBusiness(
  db: Queryable,
  over: {
    name?: string;
    category?: string;
    website?: string | null;
    shared?: boolean;
    municipality?: string;
    completeness?: number;
    verifiedDaysAgo?: number;
  } = {},
): Promise<string> {
  n++;
  const name = over.name ?? `Attività di Prova ${n}`;
  const website = over.website === undefined ? `https://prova-${n}.example.it/` : over.website;
  const muni = over.municipality ?? '058091';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, search_name, category, website_url, website_domain, website_shared, municipality_code, province_code,
                             region_code, municipality_name, has_website, has_address, has_phone, has_email, has_opening_hours,
                             completeness, first_seen_at, last_verified_at)
     VALUES ($1, lower($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, true, true, false, true, $11, now(), now() - make_interval(days => $12))
     RETURNING id`,
    [
      name,
      over.category ?? 'farmacie',
      website,
      website ? new URL(website).host : null,
      over.shared ?? false,
      muni,
      muni === '058091' ? '258' : '032',
      muni === '058091' ? '12' : '06',
      muni === '058091' ? 'Roma' : 'Trieste',
      Boolean(website),
      over.completeness ?? 4,
      over.verifiedDaysAgo ?? 5,
    ],
  );
  return rows[0]!.id;
}

const ALL_SIGNALS = Object.fromEntries(
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

/** Audit registrato per il sito dell'azienda (creato e collegato se serve), con i rilievi indicati. */
export async function insertAudit(
  db: Queryable,
  businessId: string,
  over: {
    websiteStatus?: string;
    runStatus?: 'completed' | 'partial' | 'failed';
    daysAgo?: number;
    signals?: Record<string, boolean>;
    hasViewport?: boolean;
    findings?: { code: FindingCode; severity?: string; confidence?: string; page?: string }[];
  } = {},
): Promise<string> {
  const { rows: b } = await db.query<{ website_url: string }>('SELECT website_url FROM businesses WHERE id = $1', [
    businessId,
  ]);
  const url = b[0]!.website_url;
  const host = new URL(url).host;
  const { rows: w } = await db.query<{ id: string }>(
    `INSERT INTO websites (site_key, url, host) VALUES ($1, $2, $3) ON CONFLICT (site_key) DO UPDATE SET updated_at = now() RETURNING id`,
    [host, url, host],
  );
  const websiteId = w[0]!.id;
  await db.query(
    `INSERT INTO business_websites (business_id, website_id, original_url) VALUES ($1, $2, $3)
     ON CONFLICT (business_id) DO UPDATE SET website_id = $2, original_url = $3`,
    [businessId, websiteId, url],
  );
  const findings = over.findings ?? [];
  const bySeverity: Record<string, number> = {};
  for (const f of findings) {
    const sev = f.severity ?? FINDINGS[f.code].severity;
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }
  const status = over.websiteStatus ?? 'valid';
  const finished = new Date(Date.now() - (over.daysAgo ?? 1) * 86_400_000);
  const summary = {
    websiteStatus: status,
    homepage: status === 'valid' ? { status: 200, jsRendered: false } : null,
    hasViewport: status === 'valid' ? (over.hasViewport ?? true) : null,
    signals: status === 'valid' ? { ...ALL_SIGNALS, ...over.signals } : null,
    findings: { total: findings.length, actionable: findings.length, bySeverity },
  };
  const { rows: a } = await db.query<{ id: string }>(
    `INSERT INTO website_audits (website_id, business_id, run_status, website_status, original_url, final_url, audit_version, config_key,
                                 settings, summary, pages_inspected, findings_count, actionable_count, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $5, 1, 'test', '{}', $6, $7, $8, $8, $9, $9) RETURNING id`,
    [
      websiteId,
      businessId,
      over.runStatus ?? 'completed',
      status,
      url,
      JSON.stringify(summary),
      status === 'valid' ? 3 : 0,
      findings.length,
      finished,
    ],
  );
  const auditId = a[0]!.id;
  for (const f of findings) {
    const d = FINDINGS[f.code];
    await db.query(
      `INSERT INTO audit_findings (audit_id, code, category, severity, observation, title, explanation, evidence, page_url, confidence,
                                   actionable, remediation, service, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $8, $9, $10, $11, $12, $13)`,
      [
        auditId,
        f.code,
        d.category,
        f.severity ?? d.severity,
        d.observation,
        d.title,
        d.explanation,
        f.page ?? url,
        f.confidence ?? 'high',
        d.actionable,
        d.remediation,
        d.service ?? null,
        finished,
      ],
    );
  }
  await db.query('UPDATE websites SET status = $2, last_audit_id = $3, last_checked_at = $4 WHERE id = $1', [
    websiteId,
    status,
    auditId,
    finished,
  ]);
  return auditId;
}
