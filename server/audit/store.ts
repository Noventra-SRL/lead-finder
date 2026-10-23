import { recordWebsiteEmails } from '../enrichment/store.ts';
import type { Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';
import { storableMeasurements } from './html.ts';
import { AUDIT_VERSION, type AuditOutcome, type AuditSettings } from './engine.ts';
import type { FindingCategory, Severity } from './findings.ts';
import { websiteTarget } from './url.ts';

/*
 * Salvataggio e lettura degli audit.
 *  - collegamento azienda → sito (business_websites): lo stesso sito scritto in modi diversi è un solo "websites";
 *  - ogni audit è una riga nuova (storico), con pagine, rilievi (unici per codice e pagina) e prestazioni,
 *    salvati in un'unica transazione; il sito punta all'ultimo audit e ne riporta lo stato.
 */

export type WebsiteLink =
  | { kind: 'website'; websiteId: string; url: string }
  | { kind: 'none'; status: 'not_found' | 'invalid_url'; reason: string };

/** Collega l'azienda al sito indicato dalla fonte (o registra che non ne ha uno proprio). */
export async function linkWebsite(tx: Queryable, businessId: string, rawUrl: string | null): Promise<WebsiteLink> {
  const target = websiteTarget(rawUrl);
  if (target.kind !== 'ok') {
    const status = target.kind === 'none' ? 'not_found' : 'invalid_url';
    await tx.query(
      `INSERT INTO business_websites (business_id, website_id, original_url, status, status_reason, updated_at)
       VALUES ($1, NULL, $2, $3, $4, now())
       ON CONFLICT (business_id) DO UPDATE SET website_id = NULL, original_url = $2, status = $3, status_reason = $4, updated_at = now()`,
      [businessId, rawUrl, status, target.reason],
    );
    return { kind: 'none', status, reason: target.reason };
  }
  const { rows } = await tx.query<{ id: string; url: string }>(
    `INSERT INTO websites (site_key, url, host) VALUES ($1, $2, $3)
     ON CONFLICT (site_key) DO UPDATE SET updated_at = now() RETURNING id, url`,
    [target.siteKey, target.url, target.host],
  );
  const site = rows[0]!;
  await tx.query(
    `INSERT INTO business_websites (business_id, website_id, original_url, status, status_reason, updated_at)
     VALUES ($1, $2, $3, NULL, NULL, now())
     ON CONFLICT (business_id) DO UPDATE SET website_id = $2, original_url = $3, status = NULL, status_reason = NULL, updated_at = now()`,
    [businessId, site.id, rawUrl],
  );
  return { kind: 'website', websiteId: site.id, url: site.url };
}

/** Audit recente dello stesso sito con la stessa configurazione (per non ripeterlo senza motivo). */
export async function recentAudit(
  db: Queryable,
  websiteId: string,
  configKey: string,
  hours: number,
): Promise<string | null> {
  if (hours <= 0) return null;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM website_audits
      WHERE website_id = $1 AND config_key = $2 AND run_status <> 'failed'
        AND finished_at > now() - make_interval(secs => $3)
      ORDER BY finished_at DESC LIMIT 1`,
    [websiteId, configKey, hours * 3600],
  );
  return rows[0]?.id ?? null;
}

export async function saveAudit(
  tx: Queryable,
  input: {
    websiteId: string;
    businessId: string | null;
    jobId: string | null;
    settings: AuditSettings;
    configKey: string;
    outcome: AuditOutcome;
  },
): Promise<string> {
  const o = input.outcome;
  const s = o.summary;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO website_audits (website_id, business_id, job_id, run_status, website_status, original_url, final_url, audit_version,
                                 config_key, settings, summary, limitations, pages_inspected, findings_count, actionable_count,
                                 started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
    [
      input.websiteId,
      input.businessId,
      input.jobId,
      o.runStatus,
      o.websiteStatus,
      o.originalUrl,
      o.finalUrl,
      AUDIT_VERSION,
      input.configKey,
      JSON.stringify(input.settings),
      JSON.stringify(s),
      JSON.stringify(o.limitations),
      s.pagesInspected,
      s.findings.total,
      s.findings.actionable,
      o.startedAt,
      o.finishedAt,
    ],
  );
  const auditId = rows[0]!.id;
  for (const [seq, p] of o.pages.entries()) {
    await tx.query(
      `INSERT INTO website_audit_pages (audit_id, seq, role, requested_url, final_url, status_code, content_type, bytes, truncated,
                                        ttfb_ms, total_ms, redirects, headers, tls, measurements, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        auditId,
        seq,
        p.role,
        p.requestedUrl,
        p.finalUrl,
        p.status,
        p.contentType,
        p.bytes,
        p.truncated,
        p.ttfbMs,
        p.totalMs,
        JSON.stringify(p.redirects),
        JSON.stringify(p.headers),
        p.tls ? JSON.stringify(p.tls) : null,
        p.measurements ? JSON.stringify(storableMeasurements(p.measurements)) : null,
        p.error ? JSON.stringify(p.error) : null,
      ],
    );
  }
  for (const f of o.findings) {
    await tx.query(
      `INSERT INTO audit_findings (audit_id, code, category, severity, observation, title, explanation, evidence, page_url, confidence,
                                   actionable, remediation, service, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (audit_id, code, page_url) DO NOTHING`,
      [
        auditId,
        f.code,
        f.category,
        f.severity,
        f.observation,
        f.title,
        f.explanation,
        JSON.stringify(f.evidence),
        f.page,
        f.confidence,
        f.actionable,
        f.remediation,
        f.service,
        o.finishedAt,
      ],
    );
  }
  for (const r of o.performance) {
    await tx.query(
      `INSERT INTO audit_performance (audit_id, provider, strategy, status, url, analyzed_at, lighthouse_version, lab, field, error_kind, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (audit_id, provider, strategy) DO NOTHING`,
      r.status === 'ok'
        ? [
            auditId,
            r.provider,
            r.strategy,
            'ok',
            r.url,
            r.analyzedAt,
            r.lighthouseVersion,
            JSON.stringify(r.lab),
            r.field ? JSON.stringify(r.field) : null,
            null,
            null,
          ]
        : [auditId, r.provider, r.strategy, 'error', r.url, r.analyzedAt, null, null, null, r.errorKind, r.message],
    );
  }
  await tx.query(
    `UPDATE websites SET status = $2, status_reason = $3, final_url = $4, last_audit_id = $5, last_checked_at = $6, updated_at = now()
      WHERE id = $1`,
    [input.websiteId, o.websiteStatus, s.statusReason, o.finalUrl, auditId, o.finishedAt],
  );
  // email scritte nelle pagine lette (solo se almeno una pagina è stata letta: altrimenti il sito resta da controllare)
  if (o.emailPagesChecked > 0)
    await recordWebsiteEmails(tx, {
      websiteId: input.websiteId,
      auditId,
      emails: o.emails,
      pagesChecked: o.emailPagesChecked,
      checkedAt: o.finishedAt,
    });
  return auditId;
}

/** Audit non riuscito per un errore interno: registrato nello storico, il sito resta con l'ultimo esito valido. */
export async function saveFailedAudit(
  tx: Queryable,
  input: {
    websiteId: string;
    businessId: string | null;
    jobId: string | null;
    settings: AuditSettings;
    configKey: string;
    url: string;
    error: string;
    startedAt: Date;
  },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO website_audits (website_id, business_id, job_id, run_status, website_status, original_url, audit_version, config_key,
                                 settings, error, started_at, finished_at)
     VALUES ($1, $2, $3, 'failed', 'audit_failed', $4, $5, $6, $7, $8, $9, now()) RETURNING id`,
    [
      input.websiteId,
      input.businessId,
      input.jobId,
      input.url,
      AUDIT_VERSION,
      input.configKey,
      JSON.stringify(input.settings),
      input.error.slice(0, 500),
      input.startedAt,
    ],
  );
  // mai stato "audit_failed" se il sito ha già un audit riuscito: l'ultimo esito valido resta visibile
  await tx.query(
    `UPDATE websites SET status = 'audit_failed', status_reason = $2, last_checked_at = now(), updated_at = now()
      WHERE id = $1 AND last_audit_id IS NULL`,
    [input.websiteId, input.error.slice(0, 300)],
  );
  return rows[0]!.id;
}

/* ---------- lettura ---------- */

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

interface AuditRow {
  id: string;
  website_id: string;
  business_id: string | null;
  job_id: string | null;
  run_status: string;
  website_status: string;
  original_url: string;
  final_url: string | null;
  audit_version: number;
  config_key: string;
  settings: AuditSettings;
  summary: Record<string, unknown>;
  limitations: string[];
  error: string | null;
  pages_inspected: number;
  findings_count: number;
  actionable_count: number;
  started_at: Date;
  finished_at: Date;
}

function auditDto(r: AuditRow) {
  return {
    id: r.id,
    websiteId: r.website_id,
    businessId: r.business_id,
    jobId: r.job_id,
    runStatus: r.run_status,
    websiteStatus: r.website_status,
    originalUrl: r.original_url,
    finalUrl: r.final_url,
    auditVersion: r.audit_version,
    configKey: r.config_key,
    settings: r.settings,
    summary: r.summary,
    limitations: r.limitations,
    error: r.error,
    pagesInspected: r.pages_inspected,
    findingsCount: r.findings_count,
    actionableCount: r.actionable_count,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

/** Sito collegato all'azienda e storico dei suoi audit (paginato). */
export async function auditHistory(db: Queryable, businessId: string, page: number, pageSize: number) {
  const { rows: link } = await db.query<{
    website_id: string | null;
    status: string | null;
    status_reason: string | null;
    original_url: string | null;
    w_status: string | null;
    w_reason: string | null;
    url: string | null;
    final_url: string | null;
    last_checked_at: Date | null;
    last_audit_id: string | null;
  }>(
    `SELECT bw.website_id, bw.status, bw.status_reason, bw.original_url, w.status AS w_status, w.status_reason AS w_reason, w.url, w.final_url,
            w.last_checked_at, w.last_audit_id
       FROM business_websites bw LEFT JOIN websites w ON w.id = bw.website_id WHERE bw.business_id = $1`,
    [businessId],
  );
  const l = link[0];
  const website = l
    ? {
        id: l.website_id,
        status: l.w_status ?? l.status ?? 'not_checked',
        statusReason: l.w_reason ?? l.status_reason,
        originalUrl: l.original_url,
        url: l.url,
        finalUrl: l.final_url,
        lastCheckedAt: iso(l.last_checked_at),
        lastAuditId: l.last_audit_id,
      }
    : null;
  if (!l?.website_id) return { website, items: [], total: 0, page, pageSize };
  const { rows: total } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM website_audits WHERE website_id = $1',
    [l.website_id],
  );
  const { rows } = await db.query<AuditRow>(
    'SELECT * FROM website_audits WHERE website_id = $1 ORDER BY finished_at DESC, id LIMIT $2 OFFSET $3',
    [l.website_id, pageSize, (page - 1) * pageSize],
  );
  return { website, items: rows.map(auditDto), total: total[0]!.n, page, pageSize };
}

export interface FindingFilters {
  severity?: Severity[];
  category?: FindingCategory[];
  actionable?: boolean;
}

const SEVERITY_ORDER = "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END";

export async function auditDetail(db: Queryable, auditId: string, filters: FindingFilters = {}) {
  const { rows } = await db.query<AuditRow>('SELECT * FROM website_audits WHERE id = $1', [auditId]);
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Audit non trovato.');
  const where = ['audit_id = $1'];
  const params: unknown[] = [auditId];
  if (filters.severity?.length) {
    params.push(filters.severity);
    where.push(`severity = ANY($${params.length})`);
  }
  if (filters.category?.length) {
    params.push(filters.category);
    where.push(`category = ANY($${params.length})`);
  }
  if (filters.actionable !== undefined) {
    params.push(filters.actionable);
    where.push(`actionable = $${params.length}`);
  }
  const findings = await db.query<{
    code: string;
    category: string;
    severity: string;
    observation: string;
    title: string;
    explanation: string;
    evidence: Record<string, unknown>;
    page_url: string;
    confidence: string;
    actionable: boolean;
    remediation: string;
    service: string | null;
    detected_at: Date;
  }>(
    `SELECT * FROM audit_findings WHERE ${where.join(' AND ')} ORDER BY ${SEVERITY_ORDER}, category, code, page_url`,
    params,
  );
  const pages = await db.query<{
    seq: number;
    role: string;
    requested_url: string;
    final_url: string;
    status_code: number | null;
    content_type: string | null;
    bytes: number;
    truncated: boolean;
    ttfb_ms: number | null;
    total_ms: number | null;
    redirects: unknown;
    headers: Record<string, string>;
    tls: unknown;
    measurements: Record<string, unknown> | null;
    error: unknown;
  }>('SELECT * FROM website_audit_pages WHERE audit_id = $1 ORDER BY seq', [auditId]);
  const perf = await db.query<{
    provider: string;
    strategy: string;
    status: string;
    url: string;
    analyzed_at: Date;
    lighthouse_version: string | null;
    lab: unknown;
    field: unknown;
    error_kind: string | null;
    error_message: string | null;
  }>('SELECT * FROM audit_performance WHERE audit_id = $1 ORDER BY strategy', [auditId]);
  const { rows: biz } = await db.query<{ id: string; name: string }>(
    `SELECT b.id, b.name FROM business_websites bw JOIN businesses b ON b.id = bw.business_id
      WHERE bw.website_id = $1 AND b.merged_into IS NULL ORDER BY b.name LIMIT 20`,
    [rows[0].website_id],
  );
  return {
    audit: auditDto(rows[0]),
    businesses: biz,
    findings: findings.rows.map((f) => ({
      code: f.code,
      category: f.category,
      severity: f.severity,
      observation: f.observation,
      title: f.title,
      explanation: f.explanation,
      evidence: f.evidence,
      page: f.page_url,
      confidence: f.confidence,
      actionable: f.actionable,
      remediation: f.remediation,
      service: f.service,
      detectedAt: iso(f.detected_at),
    })),
    pages: pages.rows.map((p) => ({
      seq: p.seq,
      role: p.role,
      requestedUrl: p.requested_url,
      finalUrl: p.final_url,
      status: p.status_code,
      contentType: p.content_type,
      bytes: p.bytes,
      truncated: p.truncated,
      ttfbMs: p.ttfb_ms,
      totalMs: p.total_ms,
      redirects: p.redirects,
      headers: p.headers,
      tls: p.tls,
      measurements: p.measurements,
      error: p.error,
    })),
    performance: perf.rows.map((r) => ({
      provider: r.provider,
      strategy: r.strategy,
      status: r.status,
      url: r.url,
      analyzedAt: iso(r.analyzed_at),
      lighthouseVersion: r.lighthouse_version,
      lab: r.lab,
      field: r.field,
      errorKind: r.error_kind,
      errorMessage: r.error_message,
    })),
  };
}
