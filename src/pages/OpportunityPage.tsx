import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiError,
  patch,
  post,
  type ActivityType,
  type AuditDetail,
  type CommercialPriority,
  type CrmActivity,
  type CrmFollowUp,
  type CrmMeta,
  type OpportunityDetail,
} from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { Attribution } from '../components/Attribution.tsx';
import { StageControl } from '../components/CrmControls.tsx';
import { EmailHistory } from '../components/EmailHistory.tsx';
import { FollowUpForm } from '../components/FollowUpForm.tsx';
import { AiAssessmentPanel } from '../components/AiAssessmentPanel.tsx';
import { LeadScorePanel } from '../components/LeadScorePanel.tsx';
import { ServicesPanel } from '../components/ServicesPanel.tsx';
import {
  Button,
  Checkbox,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageHeader,
  Section,
  SelectField,
  Status,
  TextAreaField,
} from '../components/ui.tsx';
import { SEVERITY, WEBSITE_STATUS } from '../lib/audit.ts';
import { formatDue, formatEuro, nowLocalInput, PRIORITY_LABEL, STAGE_TONE, todayRome } from '../lib/crm.ts';
import { formatDate, formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';

/*
 * Scheda di un'opportunità: stato commerciale, prossime azioni, cronologia, dati dell'azienda e qualificazione.
 * I dati dell'azienda, dell'audit, del punteggio e dei servizi sono quelli già presenti (letti, mai copiati né
 * modificati da qui). Le note commerciali sono interne e separate dai dati pubblici dell'azienda.
 */

const errorOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', fallback));

function Commercial({ d, meta, onDone }: { d: OpportunityDetail; meta: CrmMeta; onDone: () => void }) {
  const o = d.opportunity;
  const [priority, setPriority] = useState<CommercialPriority>(o.priority);
  const [owner, setOwner] = useState(o.owner?.id ?? '');
  const [value, setValue] = useState(o.estimatedValue === null ? '' : String(o.estimatedValue));
  const [services, setServices] = useState<string[]>(o.services.map((s) => s.id));
  const [notes, setNotes] = useState(o.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const recommended = new Set((o.recommended ?? []).map((s) => s.serviceId));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const v = value.trim().replace(',', '.');
      await patch(`/crm/opportunities/${o.id}`, {
        priority,
        ownerId: owner || null,
        estimatedValue: v === '' ? null : Number(v),
        services,
        notes: notes.trim() || null,
      });
      setSaved(true);
      onDone();
    } catch (err) {
      setError(errorOf(err, 'Salvataggio non riuscito.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Stato commerciale"
      description="Fase, priorità e valore sono decisi da una persona: nessun ricalcolo del punteggio li modifica."
    >
      <div className="stack">
        <div className="grid-2">
          <StageControl opportunity={o} meta={meta} onDone={onDone} label="Fase della pipeline" />
          <p className="small">
            <Status tone={STAGE_TONE[o.stage]}>{o.stageLabel}</Status>
            {o.lostReason && <span className="muted"> · motivo: {o.lostReason}</span>}
            {o.closedAt && <span className="muted"> · chiusa il {formatDate(o.closedAt)}</span>}
          </p>
        </div>
        <form className="stack" aria-label="Dati commerciali" onSubmit={(e) => void save(e)}>
          <div className="grid-2">
            <SelectField
              label="Priorità commerciale"
              value={priority}
              onChange={(e) => setPriority(e.target.value as CommercialPriority)}
            >
              {meta.priorities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </SelectField>
            <SelectField label="Responsabile" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Nessuno</option>
              {meta.owners.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </SelectField>
            <Field
              label="Valore stimato (€)"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              error={error?.fields.estimatedValue}
              hint="Facoltativo, inserito a mano. Non viene mai calcolato dal sistema."
            />
          </div>
          <fieldset className="fieldset fieldset--plain">
            <legend>Servizi proposti</legend>
            <div className="checklist">
              {meta.services
                .filter((s) => s.active || services.includes(s.id))
                .map((s) => (
                  <Checkbox
                    key={s.id}
                    label={
                      <>
                        {s.name}
                        {recommended.has(s.id) && <span className="coverage">consigliato dall’abbinamento</span>}
                      </>
                    }
                    checked={services.includes(s.id)}
                    onChange={(e) =>
                      setServices((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))
                    }
                  />
                ))}
            </div>
          </fieldset>
          <TextAreaField
            label="Note interne"
            value={notes}
            maxLength={5000}
            rows={4}
            onChange={(e) => setNotes(e.target.value)}
            hint="Visibili solo al team. Non inserire dati personali non necessari."
          />
          {error && !error.fields.estimatedValue && <Notice tone="error">{error.message}</Notice>}
          <div className="row">
            <Button type="submit" busy={busy}>
              Salva i dati commerciali
            </Button>
            {saved && (
              <span role="status" className="small export__result--ok">
                Salvato.
              </span>
            )}
          </div>
        </form>
      </div>
    </Section>
  );
}

function FollowUps({ d, onDone }: { d: OpportunityDetail; onDone: () => void }) {
  const o = d.opportunity;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reschedule, setReschedule] = useState<{ id: string; date: string } | null>(null);
  const pending = d.followUps.filter((f) => f.status === 'pending');
  const done = d.followUps.filter((f) => f.status !== 'pending');

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onDone();
      return true;
    } catch (err) {
      setError(errorOf(err, 'Operazione non riuscita.'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Prossime azioni"
      description="Follow-up con scadenza (ora italiana). Completare un follow-up non cambia la fase."
    >
      <div className="stack">
        {pending.length === 0 && (
          <p className="small muted">{o.open ? 'Nessuna azione pianificata.' : 'Opportunità chiusa.'}</p>
        )}
        {pending.length > 0 && (
          <ol className="followup-list">
            {pending.map((f: CrmFollowUp) => (
              <li key={f.id} className={`followup${f.overdue ? ' followup--overdue' : ''}`}>
                <div className="followup__when mono small">
                  {f.overdue && <span className="text-danger">Scaduto · </span>}
                  {formatDue(f.dueDate, f.dueTime, d.today)}
                </div>
                <div className="followup__what">
                  <p>
                    <strong>{f.description}</strong>{' '}
                    <span className={`small priority priority--${f.priority}`}>
                      Priorità {PRIORITY_LABEL[f.priority].toLowerCase()}
                    </span>
                  </p>
                  {f.notes && <p className="small muted">{f.notes}</p>}
                  {reschedule?.id === f.id && (
                    <div className="row">
                      <Field
                        label="Nuova scadenza"
                        type="date"
                        min={todayRome()}
                        value={reschedule.date}
                        onChange={(e) => setReschedule({ id: f.id, date: e.target.value })}
                      />
                      <Button
                        variant="secondary"
                        busy={busy === `move-${f.id}`}
                        onClick={() =>
                          void run(`move-${f.id}`, () =>
                            patch(`/crm/followups/${f.id}`, { dueDate: reschedule.date }),
                          ).then((ok) => ok && setReschedule(null))
                        }
                      >
                        Salva
                      </Button>
                    </div>
                  )}
                </div>
                <div className="row followup__actions">
                  <Button
                    variant="secondary"
                    busy={busy === `done-${f.id}`}
                    onClick={() => void run(`done-${f.id}`, () => post(`/crm/followups/${f.id}/complete`))}
                  >
                    Completa
                  </Button>
                  <Button variant="ghost" onClick={() => setReschedule({ id: f.id, date: f.dueDate })}>
                    Sposta
                  </Button>
                  <Button
                    variant="ghost"
                    busy={busy === `cancel-${f.id}`}
                    onClick={() => void run(`cancel-${f.id}`, () => post(`/crm/followups/${f.id}/cancel`))}
                  >
                    Annulla
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
        {o.open && (
          <FollowUpForm
            busy={busy === 'new'}
            error={error}
            onSubmit={(input) => run('new', () => post(`/crm/opportunities/${o.id}/followups`, input))}
          />
        )}
        {error && <Notice tone="error">{error.message}</Notice>}
        {done.length > 0 && (
          <details>
            <summary className="small">Completati e annullati ({done.length})</summary>
            <ul className="plain-list small">
              {done.map((f) => (
                <li key={f.id}>
                  {f.status === 'completed'
                    ? `Completato ${formatDateTime(f.completedAt)}`
                    : `Annullato ${formatDateTime(f.cancelledAt)}${f.cancelReason === 'opportunity_closed' ? ' (opportunità chiusa)' : ''}`}{' '}
                  — {f.description}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Section>
  );
}

function ActivityForm({
  meta,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  meta: CrmMeta;
  initial?: CrmActivity;
  submitLabel: string;
  onSubmit: (body: {
    type: ActivityType;
    occurredAt: string;
    summary: string;
    notes: string | null;
  }) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [type, setType] = useState<ActivityType>(initial?.type ?? 'call');
  const [at, setAt] = useState(() => {
    if (!initial) return nowLocalInput();
    const d = new Date(initial.occurredAt);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  });
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack crm-form"
      aria-label={initial ? 'Modifica attività' : 'Nuova attività'}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSubmit({
          type,
          occurredAt: new Date(at).toISOString(),
          summary: summary.trim(),
          notes: notes.trim() || null,
        }).then((ok) => {
          setBusy(false);
          if (ok && !initial) {
            setSummary('');
            setNotes('');
            setAt(nowLocalInput());
          }
        });
      }}
    >
      <div className="grid-2">
        <SelectField label="Tipo" value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
          {meta.activityTypes
            .filter((t) => t.manual)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
        </SelectField>
        <Field
          label="Data e ora"
          type="datetime-local"
          value={at}
          max={nowLocalInput()}
          required
          onChange={(e) => setAt(e.target.value)}
        />
      </div>
      <Field
        label="Sintesi"
        value={summary}
        maxLength={300}
        required
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Es. parlato con il titolare, interessato a un preventivo"
      />
      <TextAreaField
        label="Note (facoltative)"
        value={notes}
        maxLength={5000}
        rows={2}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="row">
        <Button type="submit" busy={busy} disabled={!summary.trim()}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Annulla
          </Button>
        )}
      </div>
    </form>
  );
}

function Timeline({ d, meta, onDone }: { d: OpportunityDetail; meta: CrmMeta; onDone: () => void }) {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.user : null;
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const send = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onDone();
      return true;
    } catch (err) {
      setError(errorOf(err, 'Operazione non riuscita.'));
      return false;
    }
  };
  return (
    <Section
      title="Cronologia"
      description="Attività registrate dal team e cambi di fase, dal più recente. Nessuna attività è generata in automatico."
    >
      <div className="stack">
        <details className="crm-add">
          <summary>Registra un’attività</summary>
          <ActivityForm
            meta={meta}
            submitLabel="Registra"
            onSubmit={(body) =>
              send(() =>
                post(`/crm/opportunities/${d.opportunity.id}/activities`, { ...body, notes: body.notes ?? undefined }),
              )
            }
          />
        </details>
        {error && <Notice tone="error">{error.message}</Notice>}
        <ol className="log timeline" aria-label="Attività">
          {d.activities.map((a) => (
            <li key={a.id} className={`log__item timeline__item timeline__item--${a.type}`}>
              <time className="mono small muted" dateTime={a.occurredAt}>
                {formatDateTime(a.occurredAt)}
              </time>
              <div>
                {editing === a.id ? (
                  <ActivityForm
                    meta={meta}
                    initial={a}
                    submitLabel="Salva"
                    onCancel={() => setEditing(null)}
                    onSubmit={(body) =>
                      send(() => patch(`/crm/activities/${a.id}`, body)).then((ok) => {
                        if (ok) setEditing(null);
                        return ok;
                      })
                    }
                  />
                ) : (
                  <>
                    <p>
                      <span className="timeline__type">{a.typeLabel}</span> {a.summary}
                    </p>
                    {a.notes && <p className="small timeline__notes">{a.notes}</p>}
                    <p className="small muted">
                      {a.user?.name ?? 'Utente rimosso'}
                      {a.edited && ` · modificata da ${a.edited.by} il ${formatDateTime(a.edited.at)}`}
                      {a.type !== 'stage_change' && me && (me.id === a.user?.id || me.role === 'admin') && (
                        <>
                          {' · '}
                          <button type="button" className="link-button" onClick={() => setEditing(a.id)}>
                            Modifica
                          </button>
                        </>
                      )}
                    </p>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}

/** Rilievi dell'ultimo audit del sito (Fase 3), solo quelli utili, con il collegamento all'esito completo. */
function AuditFindings({ auditId }: { auditId: string }) {
  const audit = useApi<AuditDetail>(`/audits/${auditId}`);
  if (audit.loading && !audit.data) return <Loading />;
  if (audit.error) return <ErrorNotice error={audit.error} onRetry={audit.reload} />;
  if (!audit.data) return null;
  const findings = audit.data.findings.filter((f) => f.actionable).slice(0, 6);
  return (
    <div className="stack">
      {findings.length === 0 ? (
        <p className="small muted">L’ultimo audit non ha rilievi utili per una proposta.</p>
      ) : (
        <ul className="plain-list">
          {findings.map((f) => (
            <li key={`${f.code}-${f.page}`} className="small">
              <Status tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Status> {f.title}
            </li>
          ))}
        </ul>
      )}
      <p className="small">
        <Link to={`/audit/esiti/${auditId}`}>Esito completo dell’audit</Link> · eseguito il{' '}
        {formatDateTime(audit.data.audit.startedAt)}
      </p>
    </div>
  );
}

export function OpportunityPage() {
  const { id } = useParams();
  const meta = useApi<CrmMeta>('/crm/meta');
  const detail = useApi<OpportunityDetail>(`/crm/opportunities/${id}`);
  if ((detail.loading && !detail.data) || (meta.loading && !meta.data)) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} onRetry={detail.reload} />;
  if (meta.error) return <ErrorNotice error={meta.error} onRetry={meta.reload} />;
  if (!detail.data || !meta.data) return null;
  const d = detail.data;
  const o = d.opportunity;
  const b = o.business;
  const status = WEBSITE_STATUS[b.audit.websiteStatus];

  return (
    <>
      <p className="breadcrumb">
        <Link to="/pipeline">Clienti e trattative</Link> / Opportunità
      </p>
      <PageHeader
        title={b.name}
        lede={`${b.sector?.label ?? b.categoryLabel} · ${[b.place.municipality, b.place.region].filter(Boolean).join(', ') || 'comune non determinato'} · ${o.stageLabel}`}
      />
      {b.mergedInto && (
        <Notice tone="warn" title="Azienda unita a un’altra">
          <p>
            L’azienda di questa opportunità è stata riconosciuta come duplicato e l’altra ha già un’opportunità aperta.{' '}
            <Link to={`/aziende/${b.mergedInto}`}>Apri la scheda mantenuta</Link> e chiudi una delle due opportunità.
          </p>
        </Notice>
      )}
      {b.excluded && (
        <Notice tone="warn" title="Non contattare">
          <p>
            L’azienda è esclusa dalla prospezione{b.excluded.reason ? ` (${b.excluded.reason})` : ''}. Per riaprire,
            reincludila prima dalla <Link to={`/aziende/${b.id}`}>scheda dell’azienda</Link>.
          </p>
        </Notice>
      )}

      <Commercial key={o.updatedAt} d={d} meta={meta.data} onDone={detail.reload} />
      <FollowUps d={d} onDone={detail.reload} />
      <EmailHistory businessId={b.id} opportunityId={o.id} />
      <Timeline d={d} meta={meta.data} onDone={detail.reload} />

      <Section title="Azienda" description="Dati pubblici dalla fonte, non modificabili da qui.">
        <dl className="props">
          <dt>Settore</dt>
          <dd>{b.sector?.label ?? b.categoryLabel}</dd>
          <dt>Comune</dt>
          <dd>
            {b.place.municipality
              ? `${b.place.municipality}, ${b.place.province} (${b.place.provinceSigla}), ${b.place.region}`
              : 'Non determinato'}
          </dd>
          <dt>Sito web</dt>
          <dd>
            {b.website ? (
              <a href={b.website.url} target="_blank" rel="noopener noreferrer nofollow" className="mono">
                {b.website.domain}
              </a>
            ) : (
              <span className="muted">Non indicato dalla fonte (assenza non verificata)</span>
            )}{' '}
            · <Status tone={status.tone}>{status.label}</Status>
          </dd>
          <dt>Recapiti pubblici</dt>
          <dd>
            {b.contacts.phone ? (
              <a href={`tel:${b.contacts.phone.replace(/\s/g, '')}`} className="mono">
                {b.contacts.phone}
              </a>
            ) : (
              <span className="muted">Telefono non indicato</span>
            )}
            {' · '}
            {b.contacts.email ? (
              <a href={`mailto:${b.contacts.email}`}>{b.contacts.email}</a>
            ) : (
              <span className="muted">email generica non indicata</span>
            )}
          </dd>
          <dt>Fonte</dt>
          <dd>
            OpenStreetMap · acquisita {formatDate(b.firstSeenAt)}, ultima conferma {formatDate(b.lastVerifiedAt)}
          </dd>
        </dl>
        <p className="after small">
          <Link to={`/aziende/${b.id}`}>Scheda completa dell’azienda</Link>
        </p>
        <Attribution />
      </Section>

      <Section
        title="Rilievi del sito"
        description="Dall’ultimo audit (Fase 3): fatti osservati sul sito, con gravità. Non sono il punteggio del lead."
      >
        {b.audit.lastAuditId ? (
          <AuditFindings auditId={b.audit.lastAuditId} />
        ) : (
          <p className="small muted">
            {b.website ? 'Il sito non è ancora stato verificato.' : 'Nessun sito proprio da verificare.'} Il CRM non
            richiede un audit per qualificare un’opportunità.
          </p>
        )}
      </Section>

      <AiAssessmentPanel businessId={b.id} merged={Boolean(b.mergedInto)} />

      <LeadScorePanel businessId={b.id} merged={Boolean(b.mergedInto)} />
      <ServicesPanel businessId={b.id} lead={b.lead} merged={Boolean(b.mergedInto)} />

      {d.otherOpportunities.length > 0 && (
        <Section
          title="Altre opportunità con questa azienda"
          description="Storico: le opportunità chiuse restano consultabili."
        >
          <ul className="plain-list small">
            {d.otherOpportunities.map((x) => (
              <li key={x.id}>
                <Link to={`/pipeline/${x.id}`}>{x.stageLabel}</Link> · aperta il {formatDate(x.createdAt)}
                {x.closedAt && `, chiusa il ${formatDate(x.closedAt)}`}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <p className="small muted">
        Valore stimato: {formatEuro(o.estimatedValue)} · creata il {formatDate(o.createdAt)} · ultima attività{' '}
        {formatDateTime(o.lastActivityAt)}
      </p>
    </>
  );
}
