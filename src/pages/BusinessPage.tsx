import { useState, type FormEvent } from 'react';
import { EmailComposer } from '../components/EmailComposer.tsx';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, post, type AuditHistory, type BusinessDetail, type OpportunityDetail } from '../api/client.ts';
import { StartAudit } from '../components/AuditControls.tsx';
import { Attribution } from '../components/Attribution.tsx';
import { DuplicateActions } from '../components/DuplicateActions.tsx';
import { AiAssessmentPanel } from '../components/AiAssessmentPanel.tsx';
import { LeadScorePanel } from '../components/LeadScorePanel.tsx';
import { ServicesPanel } from '../components/ServicesPanel.tsx';
import { EmailHistory } from '../components/EmailHistory.tsx';
import { FollowUpForm, type FollowUpInput } from '../components/FollowUpForm.tsx';
import {
  Button,
  ConfirmDialog,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageHeader,
  Section,
  Status,
} from '../components/ui.tsx';
import { RUN_STATUS, WEBSITE_STATUS } from '../lib/audit.ts';
import { STAGE_LABEL } from '../lib/crm.ts';
import { COMPLETENESS_FIELDS, JOB_STATUS, placeLabel } from '../lib/discovery.ts';
import { formatDate, formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';

const HISTORY_LABEL: Record<string, string> = {
  'business.created': 'Creata da una ricerca',
  'business.updated': 'Aggiornata dalla fonte',
  'business.source_linked': 'Collegata un’altra fonte (stesso sito, stessa posizione)',
  'business.merged': 'Unione di duplicati',
  'duplicate.marked_distinct': 'Segnata come distinta da un possibile duplicato',
};

const FIELD_LABEL: Record<string, string> = {
  name: 'nome',
  category: 'categoria',
  website_url: 'sito',
  address_street: 'via',
  address_housenumber: 'civico',
  address_postcode: 'CAP',
  address_city: 'località',
  municipality_code: 'comune',
  latitude: 'posizione',
  longitude: 'posizione',
  has_phone: 'telefono indicato',
  has_email: 'email indicata',
  has_opening_hours: 'orari indicati',
};

function changeSummary(details: Record<string, unknown>): string | null {
  const changes = details.changes as Record<string, unknown> | undefined;
  if (!changes) return null;
  const fields = [
    ...new Set(
      Object.keys(changes)
        .map((k) => FIELD_LABEL[k])
        .filter(Boolean),
    ),
  ];
  return fields.length ? `Campi cambiati: ${fields.join(', ')}` : null;
}

function AuditSection({ business }: { business: BusinessDetail }) {
  const { data, error, loading, reload } = useApi<AuditHistory>(`/businesses/${business.id}/audits?pageSize=10`);
  const status = business.audit.websiteStatus;
  const canAudit = Boolean(business.website && !business.website.shared) && !business.mergedInto;
  const audited = Boolean(business.audit.lastAuditId);
  return (
    <Section
      title="Sito web e audit"
      description="Controllo esterno e non invasivo del sito indicato dalla fonte. Ogni audit resta nello storico."
    >
      <div className="stack">
        <p>
          <Status tone={WEBSITE_STATUS[status].tone}>{WEBSITE_STATUS[status].label}</Status>
          {data?.website?.statusReason && <span className="small muted"> · {data.website.statusReason}</span>}
        </p>
        {audited && (
          <p className="small">
            Ultimo audit {formatDateTime(business.audit.lastAuditAt)}:{' '}
            <span className="mono">{business.audit.actionableFindings ?? 0}</span> rilievi utili
            {business.audit.performanceScore !== null && (
              <>
                {' '}
                · prestazioni mobile <span className="mono">{business.audit.performanceScore}</span>/100
              </>
            )}{' '}
            · <Link to={`/audit/esiti/${business.audit.lastAuditId}`}>Apri l’esito completo</Link>
          </p>
        )}
        {canAudit ? (
          <StartAudit
            businessIds={[business.id]}
            label={audited ? 'Ripeti l’audit' : 'Avvia l’audit del sito'}
            force={audited}
            variant={audited ? 'secondary' : 'primary'}
          />
        ) : (
          <p className="small muted">
            {business.mergedInto
              ? 'Scheda unita a un’altra: l’audit si avvia dalla scheda mantenuta.'
              : 'Nessun sito proprio da verificare: la fonte non ne indica uno, oppure indica solo una pagina su una piattaforma condivisa.'}
          </p>
        )}
        {loading && !data && <Loading label="Caricamento dello storico…" />}
        {error && <ErrorNotice error={error} onRetry={reload} />}
        {data && data.items.length > 0 && (
          <ol className="log" aria-label="Storico degli audit">
            {data.items.map((a) => (
              <li
                key={a.id}
                className={`log__item${a.runStatus === 'failed' ? ' log__item--error' : a.runStatus === 'partial' ? ' log__item--warning' : ''}`}
              >
                <time className="mono small muted" dateTime={a.finishedAt}>
                  {formatDateTime(a.finishedAt)}
                </time>
                <span>
                  <Link to={`/audit/esiti/${a.id}`}>{RUN_STATUS[a.runStatus].label}</Link> ·{' '}
                  {WEBSITE_STATUS[a.websiteStatus].label} · <span className="mono">{a.actionableCount}</span> rilievi
                  utili · {a.pagesInspected} {a.pagesInspected === 1 ? 'pagina' : 'pagine'}
                </span>
              </li>
            ))}
          </ol>
        )}
        {data && data.total > data.items.length && (
          <p className="small muted">
            Mostrati gli ultimi {data.items.length} audit su {data.total}.
          </p>
        )}
      </div>
    </Section>
  );
}

/**
 * Esclusione dalla prospezione: l'azienda resta nel database (e nella provenienza delle ricerche)
 * ma non compare negli elenchi, nelle esportazioni né nel conteggio verso gli obiettivi del Lead Hunter.
 */
function Exclusion({ business, onDone }: { business: BusinessDetail; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const save = async (excluded: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/businesses/${business.id}/exclusion`, {
        excluded,
        reason: excluded ? reason.trim() || undefined : undefined,
      });
      setOpen(false);
      setReason('');
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));
    } finally {
      setBusy(false);
    }
  };
  const ex = business.excluded;
  return (
    <div className="stack">
      {error && <Notice tone="error">{error.message}</Notice>}
      {ex ? (
        <Notice tone="warn" title="Esclusa dalla prospezione">
          <p>
            Dal {formatDateTime(ex.at)}
            {ex.reason ? ` — ${ex.reason}` : ''}. Non compare negli elenchi né nelle esportazioni, salvo filtro
            esplicito.
          </p>
          <div className="row notice__actions">
            <Button variant="secondary" busy={busy} onClick={() => void save(false)}>
              Includi di nuovo
            </Button>
          </div>
        </Notice>
      ) : open ? (
        <form
          className="exclusion-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <Field
            label="Motivo (facoltativo)"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            hint="Es. già cliente, ha chiesto di non essere contattata, fuori target."
          />
          <div className="row">
            <Button type="submit" variant="danger" busy={busy}>
              Escludi
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Annulla
            </Button>
          </div>
        </form>
      ) : (
        <p>
          <button type="button" className="link-button small" onClick={() => setOpen(true)}>
            Escludi dalla prospezione
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Collegamento al CRM (Fase 7): apre l'opportunità aperta invece di crearne una doppia; altrimenti la crea su
 * richiesta esplicita. Un'azienda esclusa dalla prospezione non può diventare un'opportunità.
 */
function CrmLink({ business }: { business: BusinessDetail }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const crm = business.crm;
  if (crm?.open)
    return (
      <p className="crm-link">
        Nel CRM: <strong>{STAGE_LABEL[crm.stage]}</strong> ·{' '}
        <Link to={`/pipeline/${crm.opportunityId}`}>Apri l’opportunità</Link>
      </p>
    );
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<OpportunityDetail>('/crm/opportunities', { businessId: business.id });
      void navigate(`/pipeline/${r.opportunity.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Creazione non riuscita.'));
      setBusy(false);
    }
  };
  return (
    <div className="crm-link stack stack--tight">
      <div className="row">
        <Button variant="secondary" busy={busy} disabled={Boolean(business.excluded)} onClick={() => void add()}>
          Aggiungi al CRM
        </Button>
        {crm && (
          <span className="small muted">
            Opportunità precedente: <Link to={`/pipeline/${crm.opportunityId}`}>{STAGE_LABEL[crm.stage]}</Link>
          </span>
        )}
        {business.excluded && (
          <span className="small muted">Esclusa dalla prospezione: reincludila per aggiungerla.</span>
        )}
      </div>
      {error && <p className="field__error">{error.message}</p>}
    </div>
  );
}

/**
 * Follow-up dalla scheda dell'azienda (Fase 8). Ogni follow-up appartiene a un'opportunità: se l'azienda ne ha una
 * aperta si usa quella; altrimenti si chiede conferma prima di aggiungerla al CRM (fase «Da qualificare»).
 */
function BusinessFollowUp({ business, onDone }: { business: BusinessDetail; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState<{ input: FollowUpInput; resolve: (ok: boolean) => void } | null>(null);
  const [created, setCreated] = useState<{ opportunityId: string; createdOpportunity: boolean } | null>(null);
  if (business.excluded) return null;

  const send = async (input: FollowUpInput, createOpportunity: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ opportunityId: string; createdOpportunity: boolean }>(
        `/businesses/${business.id}/followups`,
        { ...input, createOpportunity },
      );
      setCreated(r);
      onDone();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NO_OPEN_OPPORTUNITY')
        return new Promise<boolean>((resolve) => setConfirm({ input, resolve }));
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Follow-up non salvato.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="business-followup">
      <summary>Pianifica un follow-up</summary>
      {created && (
        <Notice tone="ok">
          <p>
            Follow-up salvato{created.createdOpportunity ? ' e azienda aggiunta al CRM in «Da qualificare»' : ''}.{' '}
            <Link to={`/pipeline/${created.opportunityId}`}>Apri l’opportunità</Link>
          </p>
        </Notice>
      )}
      <FollowUpForm
        busy={busy}
        error={error}
        onSubmit={(input) =>
          // senza un'opportunità aperta si chiede conferma prima di inviare (il server la richiede comunque)
          business.crm?.open ? send(input, false) : new Promise<boolean>((resolve) => setConfirm({ input, resolve }))
        }
      />
      {error && <p className="field__error">{error.message}</p>}
      <ConfirmDialog
        open={confirm !== null}
        title="Aggiungere l’azienda al CRM?"
        confirmLabel="Aggiungi e salva il follow-up"
        busy={busy}
        onCancel={() => {
          confirm?.resolve(false);
          setConfirm(null);
        }}
        onConfirm={() => {
          const c = confirm!;
          setConfirm(null);
          void send(c.input, true).then(c.resolve);
        }}
      >
        <p>
          Ogni follow-up appartiene a un’opportunità commerciale e questa azienda non ne ha una aperta. Confermando,
          viene creata un’opportunità nella fase «Da qualificare» con il follow-up. Nessun messaggio viene inviato
          all’azienda.
        </p>
      </ConfirmDialog>
    </details>
  );
}

export function BusinessPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<{ business: BusinessDetail }>(`/businesses/${id}`);
  const [composing, setComposing] = useState(false);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const b = data.business;
  const a = b.address;
  const street = [a.street, a.housenumber].filter(Boolean).join(' ');
  const pending = b.duplicates.filter((d) => d.status === 'pending');

  return (
    <>
      <p className="breadcrumb">
        <Link to="/aziende">Aziende</Link> / Scheda
      </p>
      <PageHeader
        title={b.name}
        lede={`${b.sector?.label ?? b.categoryLabel} · ${placeLabel(b)}${b.place.region ? `, ${b.place.region}` : ''}`}
      />

      {!b.mergedInto && (
        <div className="row business-actions">
          <Button
            disabled={!b.contacts.email || b.contacts.emailKind === 'personal' || Boolean(b.excluded)}
            title={!b.contacts.email ? 'Email non disponibile' : b.excluded ? 'Azienda da non contattare' : undefined}
            onClick={() => setComposing(true)}
          >
            Invia email
          </Button>
          {!b.contacts.email && <span className="small muted">Email non disponibile</span>}
          {b.contact && <span className="small">Contatto: {b.contact.label}</span>}
        </div>
      )}
      {composing && (
        <EmailComposer business={{ id: b.id, name: b.name }} onClose={() => setComposing(false)} onSent={reload} />
      )}

      {!b.mergedInto && <CrmLink business={b} />}

      {!b.mergedInto && <BusinessFollowUp business={b} onDone={reload} />}

      {!b.mergedInto && <Exclusion business={b} onDone={reload} />}

      {b.mergedInto && (
        <Notice tone="warn" title="Scheda unita a un’altra">
          <p>
            Questa azienda è stata riconosciuta come duplicato.{' '}
            <Link to={`/aziende/${b.mergedInto}`}>Apri la scheda mantenuta</Link>.
          </p>
        </Notice>
      )}

      {!b.mergedInto && <EmailHistory businessId={b.id} />}

      <AiAssessmentPanel businessId={b.id} merged={Boolean(b.mergedInto)} />

      <LeadScorePanel businessId={b.id} merged={Boolean(b.mergedInto)} />

      <ServicesPanel businessId={b.id} lead={b.lead} merged={Boolean(b.mergedInto)} />

      <Section
        title="Dati"
        description="Solo ciò che la fonte riporta. «Non indicato» significa sconosciuto, non assente."
      >
        <dl className="props">
          <dt>Categoria</dt>
          <dd>
            {b.categoryLabel}
            {b.sector && b.sector.label !== b.categoryLabel && (
              <span className="muted"> · settore {b.sector.label}</span>
            )}
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
            ) : b.contacts.emailKind === 'personal' ? (
              <span className="muted">email personale indicata dalla fonte, non salvata</span>
            ) : (
              <span className="muted">email generica non indicata</span>
            )}
            <div className="small muted">
              Solo recapiti aziendali pubblicati dalla fonte. Un recapito pubblico non equivale a un consenso a ricevere
              comunicazioni commerciali.
            </div>
          </dd>
          <dt>Indirizzo</dt>
          <dd>
            {street || a.postcode || a.city ? (
              <>
                {street}
                {street && (a.postcode || a.city) && ', '}
                {[a.postcode, a.city].filter(Boolean).join(' ')}
              </>
            ) : (
              <span className="muted">Non indicato</span>
            )}
          </dd>
          <dt>Comune (ISTAT)</dt>
          <dd>
            {b.place.municipality ? (
              <>
                {b.place.municipality}, {b.place.province} ({b.place.provinceSigla}), {b.place.region}{' '}
                <span className="mono muted small">{b.place.municipalityCode}</span>
              </>
            ) : (
              <span className="muted">Non determinato dalla fonte</span>
            )}
          </dd>
          <dt>Sito web</dt>
          <dd>
            {b.website ? (
              <>
                <a href={b.website.url} target="_blank" rel="noopener noreferrer nofollow" className="mono">
                  {b.website.url}
                </a>
                {b.website.shared && (
                  <div className="small muted">
                    Pagina su una piattaforma condivisa (social, directory): non è un sito proprio.
                  </div>
                )}
              </>
            ) : (
              <span className="muted">Non indicato</span>
            )}
          </dd>
          <dt>Completezza</dt>
          <dd>
            <span className="mono">{b.completeness}</span>/5 —{' '}
            {COMPLETENESS_FIELDS.map((f, i) => (
              <span key={f.key}>
                {i > 0 && ', '}
                {f.label} {b.has[f.key] ? 'indicato' : <span className="muted">non indicato</span>}
              </span>
            ))}
          </dd>
          <dt>Posizione</dt>
          <dd className="mono small">
            {b.position ? (
              `${b.position.lat.toFixed(5)}, ${b.position.lon.toFixed(5)}`
            ) : (
              <span className="muted">Non indicata</span>
            )}
          </dd>
          <dt>Acquisita</dt>
          <dd>{formatDateTime(b.firstSeenAt)}</dd>
          <dt>Ultima verifica</dt>
          <dd>{formatDateTime(b.lastVerifiedAt)}</dd>
        </dl>
      </Section>

      <AuditSection business={b} />

      <Section title="Possibili duplicati" description="Le coppie sospette non vengono mai unite in automatico.">
        {b.duplicates.length === 0 && <p className="muted small">Nessuna segnalazione.</p>}
        <ul className="plain-list">
          {b.duplicates.map((d) => (
            <li key={d.id} className="stack stack--tight">
              <p>
                <Link to={`/aziende/${d.other.id}`}>{d.other.name}</Link>
                {d.other.municipality && <span className="muted"> · {d.other.municipality}</span>} — {d.reason}
                {d.distanceM !== null && <span className="mono muted"> ({d.distanceM} m)</span>}{' '}
                <Status tone={d.status === 'pending' ? 'warn' : 'idle'}>
                  {d.status === 'pending' ? 'Da verificare' : d.status === 'merged' ? 'Unite' : 'Distinte'}
                </Status>
              </p>
              {d.status === 'pending' && !b.mergedInto && (
                <DuplicateActions candidateId={d.id} a={{ id: b.id, name: b.name }} b={d.other} onDone={reload} />
              )}
            </li>
          ))}
        </ul>
        {pending.length > 1 && <p className="small muted">{pending.length} segnalazioni aperte per questa azienda.</p>}
      </Section>

      <Section title="Provenienza" description="Fonti da cui provengono i dati, con licenza e date di lettura.">
        <ul className="plain-list">
          {b.sources.map((s) => (
            <li key={`${s.provider}:${s.ref}`} className="source">
              <p>
                <strong>{s.provider === 'osm' ? 'OpenStreetMap' : s.provider}</strong> ·{' '}
                <span className="mono">{s.ref}</span>
                {s.primary ? ' · fonte principale' : ' · fonte aggiuntiva'} ·{' '}
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  Apri il record originale
                </a>
              </p>
              <p className="small muted">
                Licenza: {s.license}. Vista la prima volta {formatDateTime(s.firstSeenAt)}, l’ultima{' '}
                {formatDateTime(s.lastSeenAt)}
                {s.lastJobId && (
                  <>
                    {' '}
                    (<Link to={`/scoperta/ricerche/${s.lastJobId}`}>ricerca</Link>)
                  </>
                )}
                .{' '}
                {s.sourceDataAt ? (
                  <>I dati della fonte sono aggiornati al {formatDate(s.sourceDataAt)}.</>
                ) : (
                  <>La fonte non ha dichiarato la data dei suoi dati.</>
                )}
              </p>
              <details>
                <summary className="small">Tag originali conservati</summary>
                <dl className="props props--compact">
                  {Object.entries(s.tags).map(([k, v]) => (
                    <div key={k} className="props__pair">
                      <dt className="mono">{k}</dt>
                      <dd className="mono">{v}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </li>
          ))}
        </ul>
        {b.hunts.length > 0 && (
          <>
            <h3 className="sub-title">Ricerche di lead</h3>
            <ul className="plain-list">
              {b.hunts.map((h) => (
                <li key={h.id} className="small">
                  <Link to={`/lead-hunter/${h.id}`}>{h.area}</Link> · {formatDateTime(h.createdAt)} ·{' '}
                  {h.isNew ? 'trovata per la prima volta da questa ricerca' : 'già presente nel database'} ·{' '}
                  <Status tone={JOB_STATUS[h.status].tone}>{JOB_STATUS[h.status].label}</Status>
                </li>
              ))}
            </ul>
          </>
        )}
        <Attribution />
      </Section>

      <Section title="Cronologia" description="Creazione, aggiornamenti dalla fonte e decisioni sui duplicati.">
        <ol className="log">
          {b.history.map((h, i) => (
            <li key={`${h.at}-${i}`} className="log__item">
              <time className="mono small muted" dateTime={h.at}>
                {formatDateTime(h.at)}
              </time>
              <span>
                {HISTORY_LABEL[h.action] ?? h.action}
                {h.user && <span className="muted"> · {h.user}</span>}
                {changeSummary(h.details) && <span className="small muted"> · {changeSummary(h.details)}</span>}
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
