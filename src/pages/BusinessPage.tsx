import { useState } from 'react';
import { EmailComposer } from '../components/EmailComposer.tsx';
import { CategoryControl } from '../components/CategoryControl.tsx';
import { BusinessContacts } from '../components/BusinessContacts.tsx';
import { BusinessEditor } from '../components/BusinessEditor.tsx';
import { ManageContact } from '../components/ManageContact.tsx';
import { CONTACT_TONE } from '../components/ProspectTable.tsx';
import { useUser } from '../auth/AuthContext.tsx';
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
import { Button, ConfirmDialog, ErrorNotice, Loading, Notice, Section, Status } from '../components/ui.tsx';
import { RUN_STATUS, WEBSITE_STATUS } from '../lib/audit.ts';
import { STAGE_LABEL } from '../lib/crm.ts';
import { COMPLETENESS_FIELDS, JOB_STATUS, placeLabel } from '../lib/discovery.ts';
import { formatDate, formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';

const HISTORY_LABEL: Record<string, string> = {
  'business.created': 'Creata da una ricerca',
  'business.updated': 'Aggiornata dalla fonte',
  'business.source_linked': 'Collegata un’altra fonte (stessa attività)',
  'business.merged': 'Unione di duplicati',
  'business.email_found': 'Email trovata sul sito e usata come recapito',
  'business.email_confirmed': 'Email già nota trovata anche sul sito',
  'business.category_set': 'Categoria scelta a mano',
  'business.edited': 'Scheda modificata a mano',
  'business.category_automatic': 'Categoria tornata alla classificazione automatica',
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
  email: 'email',
  phone: 'telefono',
  fax: 'fax',
  contact_name: 'referente',
  contact_role: 'ruolo del referente',
  notes: 'note',
  operating_status: 'stato dell’attività',
  latitude: 'posizione',
  longitude: 'posizione',
  has_phone: 'telefono indicato',
  has_email: 'email indicata',
  has_opening_hours: 'orari indicati',
};

const OPERATING_LABEL: Record<string, string> = {
  attiva: 'Attiva',
  chiusa_temporaneamente: 'Chiusa temporaneamente',
  chiusa_definitivamente: 'Chiusa definitivamente',
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

/** Relazione tra l'indirizzo e il sito (server/enrichment/emails.ts). */
const EMAIL_RELATION = {
  same_domain: 'dominio del sito',
  free_provider: 'casella gratuita',
  pec: 'PEC, non un recapito commerciale',
  other_domain: 'altro dominio, non usato come recapito',
} as const;

export function BusinessPage() {
  const { id } = useParams();
  const user = useUser();
  const { data, error, loading, reload } = useApi<{ business: BusinessDetail }>(`/businesses/${id}`);
  const [composing, setComposing] = useState(false);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const b = data.business;
  const a = b.address;
  const street = [a.street, a.housenumber].filter(Boolean).join(' ');
  const pending = b.duplicates.filter((d) => d.status === 'pending');
  const emailForbidden = Boolean(b.doNotContact && b.doNotContact.scope !== 'telefono');
  // motivo per cui «Invia email» è disattivato (gli stessi controlli li ripete il server)
  const sendBlockedReason = b.mergedInto
    ? 'Scheda unita a un’altra: scrivi dalla scheda mantenuta.'
    : emailForbidden
      ? 'Contatto vietato: l’azienda ha rifiutato le comunicazioni commerciali.'
      : b.excluded
        ? 'Azienda esclusa dai potenziali clienti: riportala tra i potenziali clienti per scriverle.'
        : !b.contacts.email || b.contacts.emailKind === 'personal'
          ? 'Email non disponibile.'
          : null;

  return (
    <>
      <p className="breadcrumb">
        <Link to="/trova">Trova aziende</Link>
        {b.businessCategory && (
          <>
            {' '}
            / <Link to={`/trova?categoria=${b.businessCategory.id}`}>{b.businessCategory.label}</Link>
          </>
        )}{' '}
        / Scheda
      </p>
      <header className="biz-head">
        <div className="biz-head__top">
          <h1 className="biz-head__title">{b.name}</h1>
          {!b.mergedInto && !editing && (
            <Button
              variant="secondary"
              onClick={() => {
                setSaved(false);
                setEditing(true);
              }}
            >
              Modifica
            </Button>
          )}
        </div>
        <p className="biz-head__meta">
          {b.businessCategory?.label ?? b.sector?.label ?? b.categoryLabel}
          {' · '}
          {placeLabel(b)}
          {b.place.region ? `, ${b.place.region}` : ''}
          {b.contact && (
            <>
              {' · '}
              <Status tone={CONTACT_TONE[b.contact.status]}>{b.contact.label}</Status>
            </>
          )}
        </p>
      </header>

      {b.mergedInto && (
        <Notice tone="warn" title="Scheda unita a un’altra">
          <p>
            Questa azienda è stata riconosciuta come duplicato.{' '}
            <Link to={`/aziende/${b.mergedInto}`}>Apri la scheda mantenuta</Link>.
          </p>
        </Notice>
      )}
      {b.doNotContact && (
        <Notice tone="error" title="Contatto vietato">
          <p>
            L’azienda ha rifiutato le comunicazioni commerciali ({formatDateTime(b.doNotContact.at)}
            {b.doNotContact.note ? ` — ${b.doNotContact.note}` : ''}). L’applicazione blocca l’invio di email
            {b.doNotContact.scope === 'email' ? '' : ' e le chiamate da questa scheda'}.
          </p>
        </Notice>
      )}
      {b.excluded && (
        <Notice tone="warn" title="Esclusa dai potenziali clienti">
          <p>
            {b.excluded.label}
            {b.excluded.reason ? ` — ${b.excluded.reason}` : ''} · dal {formatDateTime(b.excluded.at)}. Non compare in
            «Trova aziende», «Da contattare» né nelle esportazioni; la sua storia resta.
          </p>
        </Notice>
      )}

      {saved && !editing && (
        <Notice tone="ok">
          <p>Modifiche salvate.</p>
        </Notice>
      )}
      {editing ? (
        <BusinessEditor
          key={b.updatedAt ?? b.id}
          business={b}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setSaved(true);
            reload();
          }}
        />
      ) : (
        <>
          <BusinessContacts
            business={b}
            canSend={!sendBlockedReason}
            sendBlockedReason={sendBlockedReason}
            onCompose={() => setComposing(true)}
            onManage={() => setManaging(true)}
          />
          {(b.contactPerson || b.notes || b.operatingStatus) && (
            <section className="biz-notes" aria-label="Note e referente">
              <dl className="props props--compact">
                {b.contactPerson && (
                  <>
                    <dt>Referente</dt>
                    <dd>
                      {b.contactPerson.name ?? '—'}
                      {b.contactPerson.role && <span className="muted"> · {b.contactPerson.role}</span>}
                    </dd>
                  </>
                )}
                {b.operatingStatus && (
                  <>
                    <dt>Stato dell’attività</dt>
                    <dd>{OPERATING_LABEL[b.operatingStatus]}</dd>
                  </>
                )}
                {b.notes && (
                  <>
                    <dt>Note</dt>
                    <dd className="biz-notes__text">{b.notes}</dd>
                  </>
                )}
              </dl>
              {b.editedAt && <p className="small muted">Ultima modifica a mano: {formatDateTime(b.editedAt)}</p>}
            </section>
          )}
        </>
      )}
      {composing && (
        <EmailComposer business={{ id: b.id, name: b.name }} onClose={() => setComposing(false)} onSent={reload} />
      )}
      {managing && (
        <ManageContact
          business={b}
          isAdmin={user.role === 'admin'}
          onClose={() => setManaging(false)}
          onChanged={reload}
        />
      )}

      <details className="biz-section">
        <summary className="biz-section__summary">
          Valutazione commerciale
          {b.commercial && (
            <span className="biz-section__hint">
              {b.commercial.score} · {b.commercial.band?.label}
              {b.commercial.source === 'rules' ? ' (a regole)' : ''}
            </span>
          )}
        </summary>
        <AiAssessmentPanel businessId={b.id} merged={Boolean(b.mergedInto)} />
        <LeadScorePanel businessId={b.id} merged={Boolean(b.mergedInto)} />
        <ServicesPanel businessId={b.id} lead={b.lead} merged={Boolean(b.mergedInto)} />
      </details>

      <details className="biz-section">
        <summary className="biz-section__summary">
          Sito web
          <span className="biz-section__hint">{WEBSITE_STATUS[b.audit.websiteStatus]?.label ?? ''}</span>
        </summary>
        <AuditSection business={b} />
        {b.websiteEmails.length > 0 && (
          <Section
            title="Email trovate sul sito"
            description="Indirizzi scritti sulle pagine del sito dell’azienda, con la pagina e le date. Nessuno è verificato; quelli non più presenti restano nello storico."
          >
            <ul className="site-emails">
              {b.websiteEmails.map((e) => (
                <li key={e.email}>
                  <span className="mono">{e.email}</span>
                  <span className="small muted">
                    {' '}
                    · {EMAIL_RELATION[e.relation]} ·{' '}
                    <a href={e.pageUrl} target="_blank" rel="noopener noreferrer">
                      pagina
                    </a>{' '}
                    · vista dal {formatDate(e.firstSeenAt)}
                    {e.current
                      ? ' · presente nell’ultimo controllo'
                      : ` · non più presente dal ${formatDate(e.lastSeenAt)}`}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </details>

      <details className="biz-section">
        <summary className="biz-section__summary">
          Attività commerciali
          {b.contact?.lastContactAt && (
            <span className="biz-section__hint">ultimo contatto {formatDate(b.contact.lastContactAt)}</span>
          )}
        </summary>
        {!b.mergedInto && <CrmLink business={b} />}
        {!b.mergedInto && <BusinessFollowUp business={b} onDone={reload} />}
        {!b.mergedInto && <EmailHistory businessId={b.id} />}
      </details>

      <details className="biz-section">
        <summary className="biz-section__summary">Informazioni azienda</summary>
        {!b.mergedInto && <CategoryControl businessId={b.id} category={b.businessCategory} onChanged={reload} />}
        <Section
          title="Dati"
          description="Solo ciò che la fonte riporta. «Non indicato» significa sconosciuto, non assente."
        >
          <dl className="props">
            <dt>Categoria della fonte</dt>
            <dd>
              {b.categoryLabel}
              {b.sector && b.sector.label !== b.categoryLabel && (
                <span className="muted"> · settore {b.sector.label}</span>
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
            <dt>Indirizzo della fonte</dt>
            <dd>
              {street || a.postcode || a.city ? (
                [street, [a.postcode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
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
            <dt>Ultima verifica della fonte</dt>
            <dd>{formatDateTime(b.lastVerifiedAt)}</dd>
            <dt>Ultimo controllo del sito</dt>
            <dd>{b.audit.lastAuditAt ? formatDateTime(b.audit.lastAuditAt) : <span className="muted">Mai</span>}</dd>
          </dl>
          <p className="small muted">
            Solo recapiti aziendali pubblicati. Un recapito pubblico non equivale a un consenso a ricevere comunicazioni
            commerciali.
          </p>
        </Section>

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
          {pending.length > 1 && (
            <p className="small muted">{pending.length} segnalazioni aperte per questa azienda.</p>
          )}
        </Section>

        <Section title="Provenienza" description="Fonti da cui provengono i dati, con licenza e date di lettura.">
          <ul className="plain-list">
            {b.sources.map((s) => (
              <li key={`${s.provider}:${s.ref}`} className="source">
                <p>
                  <strong>
                    {s.provider === 'osm' ? 'OpenStreetMap' : s.provider === 'google' ? 'Google Maps' : s.provider}
                  </strong>{' '}
                  · <span className="mono">{s.ref}</span>
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

        <Section
          title="Cronologia"
          description="Creazione, aggiornamenti dalla fonte, esclusioni e decisioni sui duplicati."
        >
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
      </details>
    </>
  );
}
