import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ApiError,
  get,
  patch,
  post,
  type BusinessDetail,
  type BusinessSummary,
  type EmailDetail,
  type EmailEvidenceItem,
  type EmailMeta,
  type EmailMode,
  type EmailObjective,
  type EmailPrecheck,
  type EmailSendResult,
  type EmailTone,
  type Paged,
} from '../api/client.ts';
import {
  Button,
  Checkbox,
  ConfirmDialog,
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
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { SendingStatusBar, STATUS_TONE } from './EmailListPage.tsx';

/*
 * Spazio di lavoro di un'email commerciale (Fase 9).
 * Aprire una bozza non chiama l'AI e non invia nulla: si genera solo con «Genera», si invia solo dopo la conferma.
 */

const errorOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', fallback));

/** requestId per richiesta idempotente (creazione, conferma di invio). */
const newRequestId = () => crypto.randomUUID();

// ---------------------------------------------------------------- nuova email

function NewEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const preselected = params.get('business');
  const opportunityId = params.get('opportunity');
  const [requestId] = useState(newRequestId);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ id: string; name: string; place: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const pre = useApi<{ business: BusinessDetail }>(preselected ? `/businesses/${preselected}` : null);
  const results = useApi<Paged<BusinessSummary>>(
    search ? `/businesses?q=${encodeURIComponent(search)}&pageSize=8&excluded=include&sort=name&dir=asc` : null,
  );
  const selected =
    chosen ??
    (pre.data
      ? {
          id: pre.data.business.id,
          name: pre.data.business.name,
          place: pre.data.business.place.municipality ?? '',
        }
      : null);
  const excluded = pre.data && selected?.id === pre.data.business.id ? Boolean(pre.data.business.excluded) : false;

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<EmailDetail>('/emails', {
        requestId,
        businessId: selected.id,
        ...(opportunityId ? { opportunityId } : {}),
      });
      void navigate(`/email/${r.email.id}`, { replace: true });
    } catch (e) {
      setError(errorOf(e, 'Bozza non creata.'));
      setBusy(false);
    }
  };

  return (
    <>
      <p className="breadcrumb">
        <Link to="/email">Email commerciali</Link> / Nuova email
      </p>
      <PageHeader
        title="Nuova email"
        lede="Scegli l’azienda: la bozza parte dal Modello commerciale standard Noventra. Potrai personalizzarla con l’AI, modificarla e salvarla prima di decidere se inviarla."
      />
      <Section title="Azienda" description="Cerca tra le aziende del database.">
        <div className="stack">
          {pre.loading && <Loading label="Azienda selezionata…" />}
          {selected && (
            <p className="email-chosen">
              <strong>{selected.name}</strong>
              {selected.place && <span className="muted"> · {selected.place}</span>}{' '}
              <button type="button" className="link-button small" onClick={() => (setChosen(null), setSearch(null))}>
                Cambia
              </button>
            </p>
          )}
          {excluded && (
            <Notice tone="warn">
              <p>L’azienda è contrassegnata «non contattare»: puoi preparare una bozza, ma l’invio resterà bloccato.</p>
            </Notice>
          )}
          {(!selected || chosen === null) && !preselected && (
            <form
              className="filters__search"
              role="search"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                setSearch(q.trim() || null);
              }}
            >
              <Field
                label="Cerca l’azienda per nome, dominio o comune"
                type="search"
                value={q}
                maxLength={100}
                onChange={(e) => setQ(e.target.value)}
              />
              <Button type="submit" variant="secondary">
                Cerca
              </Button>
            </form>
          )}
          {results.data && !chosen && (
            <ul className="business-results" aria-label="Aziende trovate">
              {results.data.items.length === 0 && <li className="small muted">Nessuna azienda trovata.</li>}
              {results.data.items.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className="business-results__item"
                    onClick={() => setChosen({ id: b.id, name: b.name, place: b.place.municipality ?? '' })}
                  >
                    <span>{b.name}</span>
                    <span className="small muted">
                      {[b.sector?.label ?? b.categoryLabel, b.place.municipality].filter(Boolean).join(' · ')}
                      {b.contacts.email ? ' · email pubblica' : ' · nessuna email pubblica'}
                      {b.excluded ? ' · non contattare' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="field__error">{error.message}</p>}
          <div>
            <Button busy={busy} disabled={!selected} onClick={() => void create()}>
              Crea la bozza dal modello standard
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- invio

function SendDialog({
  d,
  open,
  onClose,
  onSent,
}: {
  d: EmailDetail;
  open: boolean;
  onClose: () => void;
  onSent: (r: EmailSendResult) => void;
}) {
  const e = d.email;
  const [check, setCheck] = useState<EmailPrecheck | null>(null);
  const [checkError, setCheckError] = useState<ApiError | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [lawful, setLawful] = useState(false);
  const [acceptUncertain, setAcceptUncertain] = useState(false);
  const [requestId, setRequestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    get<EmailPrecheck>(`/emails/${e.id}/precheck`).then(
      (c) => !cancelled && (setCheck(c), setCheckError(null)),
      (err: unknown) => !cancelled && setCheckError(errorOf(err, 'Controlli non disponibili.')),
    );
    return () => {
      cancelled = true;
    };
  }, [open, e.id, e.version]);

  const close = () => {
    setReviewed(false);
    setLawful(false);
    setAcceptUncertain(false);
    setError(null);
    setCheck(null);
    // una nuova apertura è una nuova conferma
    setRequestId(newRequestId());
    onClose();
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<EmailSendResult>(`/emails/${e.id}/send`, {
        requestId,
        version: e.version,
        reviewed: true,
        lawful: true,
        acceptUncertain,
      });
      onSent(r);
      close();
    } catch (err) {
      setError(errorOf(err, 'Invio non riuscito.'));
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(check?.canSend) && reviewed && lawful && (!e.failureUncertain || acceptUncertain);
  return (
    <ConfirmDialog
      open={open}
      title="Inviare questa email?"
      confirmLabel="Invia ora"
      busy={busy}
      confirmDisabled={!ready}
      onCancel={close}
      onConfirm={() => void confirm()}
    >
      <div className="stack stack--tight send-dialog">
        <dl className="props props--compact">
          <dt>Azienda</dt>
          <dd>{d.business.name}</dd>
          <dt>Destinatario</dt>
          <dd className="mono">{e.recipient ?? '—'}</dd>
          <dt>Oggetto</dt>
          <dd>{e.subject || '—'}</dd>
          <dt>Mittente</dt>
          <dd className="mono">{check?.from ? `${check.from.name} <${check.from.address}>` : '—'}</dd>
        </dl>
        {!check && !checkError && <Loading label="Controlli prima dell’invio…" />}
        {checkError && <p className="field__error">{checkError.message}</p>}
        {check && check.blockers.length > 0 && (
          <div role="alert" className="send-dialog__blockers">
            <p>
              <strong>Invio bloccato:</strong>
            </p>
            <ul>
              {check.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
        {check && check.warnings.length > 0 && (
          <ul className="send-dialog__warnings">
            {check.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {check?.needsOpportunity && check.canSend && (
          <p className="small">
            L’azienda non ha un’opportunità aperta: dopo l’invio verrà creata un’opportunità «Da qualificare» per
            registrare l’email nel CRM. La fase non cambierà da sola.
          </p>
        )}
        {check?.canSend && (
          <>
            <Checkbox
              label="Ho riletto oggetto e testo e verificato il destinatario."
              checked={reviewed}
              onChange={(ev) => setReviewed(ev.target.checked)}
            />
            <Checkbox
              label="Il contatto è lecito e appropriato (norme italiane ed europee su privacy e marketing elettronico)."
              hint="Un recapito pubblico non autorizza automaticamente l’invio di comunicazioni commerciali."
              checked={lawful}
              onChange={(ev) => setLawful(ev.target.checked)}
            />
            {e.failureUncertain && (
              <Checkbox
                label="Ho controllato la posta inviata: il tentativo precedente non è partito, invia di nuovo."
                checked={acceptUncertain}
                onChange={(ev) => setAcceptUncertain(ev.target.checked)}
              />
            )}
          </>
        )}
        {error && <p className="field__error">{error.message}</p>}
      </div>
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------- editor

function Evidence({ d }: { d: EmailDetail }) {
  const e = d.email;
  const [all, setAll] = useState<EmailEvidenceItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  return (
    <Section
      title="Prove e note interne"
      description="Servono a te per controllare il testo: non compaiono nell’email."
    >
      <div className="stack stack--tight">
        {e.mode === 'ai' && e.evidence.length > 0 ? (
          <>
            <h3 className="sub-title">Prove usate dalla personalizzazione</h3>
            <ul className="evidence-list">
              {e.evidence.map((x) => (
                <li key={x.id}>
                  <span className="mono small">{x.id}</span> <span>{x.text}</span>{' '}
                  <span className="small muted">· {x.usedFor}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="small muted">
            {e.mode === 'standard'
              ? 'Modello standard: nessuna informazione sull’azienda inserita nel testo.'
              : 'Nessuna prova specifica citata.'}
          </p>
        )}
        {e.internalNotes && (
          <>
            {e.internalNotes.verifiedFacts.length > 0 && (
              <>
                <h3 className="sub-title">Fatti verificati</h3>
                <ul className="evidence-list">
                  {e.internalNotes.verifiedFacts.map((f) => (
                    <li key={f.text}>
                      {f.text} <span className="mono small muted">{f.refs.join(', ')}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {e.internalNotes.inferences.length > 0 && (
              <>
                <h3 className="sub-title">Deduzioni (da verificare)</h3>
                <ul className="evidence-list">
                  {e.internalNotes.inferences.map((f) => (
                    <li key={f.text}>
                      {f.text} <span className="mono small muted">{f.refs.join(', ')}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {e.internalNotes.unknowns.length > 0 && (
              <>
                <h3 className="sub-title">Non noto</h3>
                <ul className="evidence-list">
                  {e.internalNotes.unknowns.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        <details
          onToggle={(ev) => {
            if (!(ev.target as HTMLDetailsElement).open || all) return;
            get<{ evidence: EmailEvidenceItem[] }>(`/emails/${e.id}/evidence`).then(
              (r) => setAll(r.evidence),
              (err: unknown) => setLoadError(err instanceof ApiError ? err.message : 'Prove non disponibili.'),
            );
          }}
        >
          <summary className="small">Tutte le prove disponibili per questa azienda</summary>
          {loadError && <p className="field__error">{loadError}</p>}
          {!all && !loadError && <Loading label="Prove…" />}
          {all && (
            <ul className="evidence-list">
              {all.map((x) => (
                <li key={x.id}>
                  <span className="mono small">{x.id}</span> {x.text}
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
    </Section>
  );
}

function Editor({ d, meta, onChange }: { d: EmailDetail; meta: EmailMeta; onChange: (d: EmailDetail) => void }) {
  const e = d.email;
  const editable = ['draft', 'review', 'ready', 'failed'].includes(e.status);
  const [recipient, setRecipient] = useState(e.recipient ?? '');
  const [subject, setSubject] = useState(e.subject);
  const [body, setBody] = useState(e.body);
  const [mode, setMode] = useState<EmailMode>(e.mode);
  const [objective, setObjective] = useState<EmailObjective>(e.objective);
  const [tone, setTone] = useState<EmailTone>(e.tone);
  const [serviceId, setServiceId] = useState(e.serviceId ?? '');
  const [instructions, setInstructions] = useState(e.instructions ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // nuova versione dal server (salvataggio, generazione, invio): i campi seguono il testo salvato
  const [syncedVersion, setSyncedVersion] = useState(e.version);
  if (syncedVersion !== e.version) {
    setSyncedVersion(e.version);
    setRecipient(e.recipient ?? '');
    setSubject(e.subject);
    setBody(e.body);
    setMode(e.mode);
    setObjective(e.objective);
    setTone(e.tone);
    setServiceId(e.serviceId ?? '');
    setInstructions(e.instructions ?? '');
  }

  const dirty = recipient !== (e.recipient ?? '') || subject !== e.subject || body !== e.body;
  const objectiveInfo = d.objectives.find((o) => o.id === objective);

  // uscire dalla pagina con modifiche non salvate: avviso del browser
  useEffect(() => {
    if (!dirty) return;
    const warn = (ev: BeforeUnloadEvent) => ev.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function run(key: string, fn: () => Promise<EmailDetail>, done?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      onChange(r);
      if (done) setNotice({ tone: 'ok', text: done });
      return true;
    } catch (err) {
      setError(errorOf(err, 'Operazione non riuscita.'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const save = (status?: 'ready') =>
    run(
      status ? 'ready' : 'save',
      () =>
        patch<EmailDetail>(`/emails/${e.id}`, {
          version: e.version,
          recipient: recipient.trim(),
          subject,
          body,
          ...(status ? { status } : {}),
        }),
      status ? 'Email segnata come pronta per l’invio.' : 'Bozza salvata.',
    );

  const generate = (overwrite: boolean) =>
    run(
      'generate',
      () =>
        post<EmailDetail>(`/emails/${e.id}/generate`, {
          version: e.version,
          mode,
          objective,
          tone,
          ...(objective === 'servizio' ? { serviceId: serviceId || null } : {}),
          instructions: instructions.trim() || null,
          overwrite,
        }),
      mode === 'ai'
        ? 'Bozza personalizzata generata: rileggila e modificala prima di inviarla.'
        : 'Testo del modello standard ripristinato.',
    );

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setNotice({ tone: 'error', text: 'Copia non riuscita: seleziona il testo e copialo a mano.' });
    }
  };

  return (
    <>
      <div className="email-grid">
        <div className="email-main stack">
          {e.status === 'sent' && (
            <Notice tone="ok" title="Email inviata">
              <p>
                Accettata dal server di posta il {formatDateTime(e.sentAt)} da {e.sentFrom}
                {e.sentBy ? ` (invio di ${e.sentBy})` : ''}. L’accettazione non conferma la consegna nella casella del
                destinatario. Identificativo: <span className="mono small">{e.providerMessageId}</span>
              </p>
            </Notice>
          )}
          {e.status === 'failed' && e.lastError && (
            <Notice tone={e.failureUncertain ? 'warn' : 'error'} title="Invio non riuscito">
              <p>{e.lastError} La bozza è intatta: puoi correggerla e riprovare.</p>
            </Notice>
          )}
          {e.status === 'review' && (
            <Notice tone="warn">
              <p>Testo generato dall’AI: rileggilo con attenzione, correggi ciò che serve e salvalo.</p>
            </Notice>
          )}
          {d.business.doNotContact && (
            <Notice tone="error" title="Non contattare">
              <p>
                L’azienda è esclusa dalla prospezione
                {d.business.doNotContactReason ? ` (${d.business.doNotContactReason})` : ''}: l’invio è bloccato.
              </p>
            </Notice>
          )}
          <form
            className="stack email-form"
            aria-label="Email"
            onSubmit={(ev) => {
              ev.preventDefault();
              void save();
            }}
          >
            <Field
              label="Destinatario"
              type="email"
              value={recipient}
              maxLength={254}
              disabled={!editable}
              onChange={(ev) => setRecipient(ev.target.value)}
              hint={
                !recipient
                  ? 'Nessun indirizzo: la fonte non indica un’email generica dell’azienda.'
                  : recipient === d.business.publicEmail && e.recipientSource !== 'manual'
                    ? 'Email pubblica indicata dalla fonte (OpenStreetMap): non verificata.'
                    : 'Indirizzo inserito a mano: non verificato.'
              }
              error={error?.fields.recipient}
            />
            <Field
              label="Oggetto"
              value={subject}
              maxLength={200}
              disabled={!editable}
              onChange={(ev) => setSubject(ev.target.value)}
              error={error?.fields.subject}
            />
            <TextAreaField
              label="Testo"
              className="input textarea email-body"
              value={body}
              rows={24}
              maxLength={20000}
              disabled={!editable}
              onChange={(ev) => setBody(ev.target.value)}
            />
            <div className="row email-actions">
              {editable && (
                <>
                  <Button
                    type="submit"
                    variant={dirty ? 'primary' : 'secondary'}
                    busy={busy === 'save'}
                    disabled={!dirty}
                  >
                    Salva bozza
                  </Button>
                  {e.status !== 'ready' && (
                    <Button variant="secondary" busy={busy === 'ready'} onClick={() => void save('ready')}>
                      Segna come pronta
                    </Button>
                  )}
                  <Button
                    disabled={dirty || !meta.sending.canSend}
                    title={
                      dirty
                        ? 'Salva le modifiche prima di inviare'
                        : !meta.sending.canSend
                          ? meta.sending.label
                          : undefined
                    }
                    onClick={() => setSending(true)}
                  >
                    Invia email
                  </Button>
                </>
              )}
              <span className="email-actions__copy">
                <Button variant="ghost" onClick={() => void copy('oggetto', subject)}>
                  Copia oggetto
                </Button>
                <Button variant="ghost" onClick={() => void copy('testo', body)}>
                  Copia testo
                </Button>
                <Button variant="ghost" onClick={() => void copy('email', `Oggetto: ${subject}\n\n${body}`)}>
                  Copia email completa
                </Button>
              </span>
            </div>
            <p className="small muted" aria-live="polite">
              {copied
                ? `Copiato: ${copied}.`
                : dirty
                  ? 'Modifiche non salvate.'
                  : !meta.sending.canSend && editable
                    ? `Invio non disponibile: ${meta.sending.label.toLowerCase()}. Puoi salvare e copiare il testo.`
                    : `Versione ${e.version}, salvata ${formatDateTime(e.updatedAt)}.`}
            </p>
            {notice && (
              <p role="status" className={`small export__result export__result--${notice.tone}`}>
                {notice.text}
              </p>
            )}
            {error && !error.fields.recipient && !error.fields.subject && (
              <p role="alert" className="field__error">
                {error.message}
              </p>
            )}
          </form>
        </div>

        <aside className="email-aside stack">
          {editable && (
            <Section title="Generazione" description="La generazione non invia nulla e non cambia il CRM.">
              <form
                className="stack stack--tight"
                aria-label="Generazione"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (dirty || e.editedAfterGeneration) setConfirmRegenerate(true);
                  else void generate(false);
                }}
              >
                <fieldset className="fieldset fieldset--plain">
                  <legend>Modalità</legend>
                  <label className="check check--inline">
                    <input
                      type="radio"
                      name="mode"
                      checked={mode === 'standard'}
                      onChange={() => setMode('standard')}
                    />
                    <span>Modello standard</span>
                  </label>
                  <label className="check check--inline">
                    <input
                      type="radio"
                      name="mode"
                      checked={mode === 'ai'}
                      disabled={!meta.aiConfigured}
                      onChange={() => setMode('ai')}
                    />
                    <span>Email personalizzata con AI</span>
                  </label>
                  <p className="small muted">
                    {mode === 'standard'
                      ? `${meta.template.name}: testo ufficiale, invariato.`
                      : 'Personalizza apertura, osservazione sul sito, servizi pertinenti e invito finale con i dati verificati; offerta, consulenza gratuita, preventivo entro 24 ore e contatti restano quelli ufficiali.'}
                    {!meta.aiConfigured && ' Personalizzazione AI non configurata sul server.'}
                  </p>
                </fieldset>
                {mode === 'ai' && (
                  <>
                    <SelectField
                      label="Obiettivo commerciale"
                      value={objective}
                      onChange={(ev) => setObjective(ev.target.value as EmailObjective)}
                      hint={objectiveInfo && !objectiveInfo.available ? (objectiveInfo.reason ?? undefined) : undefined}
                    >
                      {d.objectives.map((o) => (
                        <option key={o.id} value={o.id} disabled={!o.available}>
                          {o.label}
                          {o.available ? '' : ' (non disponibile)'}
                        </option>
                      ))}
                    </SelectField>
                    {objective === 'servizio' && (
                      <SelectField label="Servizio" value={serviceId} onChange={(ev) => setServiceId(ev.target.value)}>
                        <option value="">Scegli dal catalogo</option>
                        {d.catalog.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </SelectField>
                    )}
                    <SelectField label="Tono" value={tone} onChange={(ev) => setTone(ev.target.value as EmailTone)}>
                      {meta.tones.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </SelectField>
                    <TextAreaField
                      label="Istruzioni (facoltative)"
                      value={instructions}
                      maxLength={1000}
                      rows={3}
                      placeholder="Es. concentrati sul sito mobile; proponi una call di 15 minuti"
                      onChange={(ev) => setInstructions(ev.target.value)}
                    />
                  </>
                )}
                <div>
                  <Button
                    type="submit"
                    variant="secondary"
                    busy={busy === 'generate'}
                    disabled={
                      (mode === 'ai' && (!meta.aiConfigured || !objectiveInfo?.available)) ||
                      (mode === 'ai' && objective === 'servizio' && !serviceId)
                    }
                  >
                    {mode === 'ai'
                      ? e.mode === 'ai'
                        ? 'Rigenera con AI'
                        : 'Genera con AI'
                      : 'Usa il modello standard'}
                  </Button>
                </div>
              </form>
            </Section>
          )}

          <Section title="Azienda e CRM">
            <dl className="props props--compact">
              <dt>Azienda</dt>
              <dd>
                <Link to={`/aziende/${d.business.id}`}>{d.business.name}</Link>
                <span className="small muted">
                  {[d.business.sector, d.business.municipality].filter(Boolean).length > 0 &&
                    ` · ${[d.business.sector, d.business.municipality].filter(Boolean).join(' · ')}`}
                </span>
              </dd>
              <dt>Sito</dt>
              <dd className="small">{d.business.website ?? 'Non indicato dalla fonte'}</dd>
              <dt>Opportunità</dt>
              <dd>
                {d.opportunity ? (
                  <Link to={`/pipeline/${d.opportunity.id}`}>{d.opportunity.stageLabel}</Link>
                ) : (
                  <span className="small muted">Nessuna opportunità aperta</span>
                )}
              </dd>
            </dl>
          </Section>

          <Evidence d={d} />

          <Section title="Storico">
            <div className="stack stack--tight">
              {d.attempts.length > 0 && (
                <>
                  <h3 className="sub-title">Tentativi di invio</h3>
                  <ul className="plain-list small">
                    {d.attempts.map((a) => (
                      <li key={a.at}>
                        {formatDateTime(a.at)} ·{' '}
                        {a.outcome === 'accepted'
                          ? 'accettata dal server'
                          : a.outcome === 'uncertain'
                            ? 'esito incerto'
                            : a.outcome === 'pending'
                              ? 'in corso'
                              : 'non riuscito'}{' '}
                        · <span className="mono">{a.recipient}</span>
                        {a.error && <span className="muted"> — {a.error}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h3 className="sub-title">Altre email a questa azienda</h3>
              {d.history.length === 0 ? (
                <p className="small muted">Nessuna.</p>
              ) : (
                <ul className="plain-list small">
                  {d.history.map((h) => (
                    <li key={h.id}>
                      <Link to={`/email/${h.id}`}>{h.subject || 'Senza oggetto'}</Link> ·{' '}
                      <Status tone={STATUS_TONE[h.status]}>{h.statusLabel}</Status>
                      <span className="muted">
                        {' '}
                        {h.sentAt ? formatDateTime(h.sentAt) : formatDateTime(h.updatedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="sub-title">Revisioni</h3>
              <ul className="plain-list small">
                {d.revisions.map((r) => (
                  <li key={r.version}>
                    v{r.version} ·{' '}
                    {r.source === 'ai'
                      ? 'generata con AI'
                      : r.source === 'template'
                        ? 'modello standard'
                        : 'modificata'}
                    {r.by && ` da ${r.by}`} · {formatDateTime(r.at)}
                  </li>
                ))}
              </ul>
              {e.status !== 'sent' && e.status !== 'sending' && (
                <div>
                  {e.status === 'archived' ? (
                    <Button
                      variant="secondary"
                      busy={busy === 'restore'}
                      onClick={() =>
                        void run('restore', () => post<EmailDetail>(`/emails/${e.id}/restore`), 'Email ripristinata.')
                      }
                    >
                      Ripristina
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => setConfirmArchive(true)}>
                      Archivia
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Section>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmRegenerate}
        title="Sostituire il testo attuale?"
        confirmLabel="Sostituisci"
        busy={busy === 'generate'}
        onCancel={() => setConfirmRegenerate(false)}
        onConfirm={() => {
          setConfirmRegenerate(false);
          void generate(true);
        }}
      >
        <p>
          {dirty
            ? 'Hai modifiche non salvate che andranno perse.'
            : 'Il testo contiene modifiche salvate: la versione attuale resterà nelle revisioni.'}{' '}
          Il nuovo testo sostituirà oggetto e corpo dell’email.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmArchive}
        title="Archiviare l’email?"
        confirmLabel="Archivia"
        busy={busy === 'archive'}
        onCancel={() => setConfirmArchive(false)}
        onConfirm={() => {
          setConfirmArchive(false);
          void run(
            'archive',
            () => post<EmailDetail>(`/emails/${e.id}/archive`, { version: e.version }),
            'Email archiviata: puoi ripristinarla quando vuoi.',
          );
        }}
      >
        <p>L’email esce dalle bozze ma resta nello storico; nulla viene inviato o cancellato.</p>
      </ConfirmDialog>
      <SendDialog
        d={d}
        open={sending}
        onClose={() => setSending(false)}
        onSent={(r) => {
          onChange(r);
          setNotice(
            r.outcome === 'accepted'
              ? {
                  tone: 'ok',
                  text: 'Email accettata dal server di posta e registrata nel CRM. La consegna nella casella del destinatario non è confermata.',
                }
              : r.outcome === 'uncertain'
                ? { tone: 'warn', text: r.message ?? 'Esito incerto: controlla la posta inviata prima di ritentare.' }
                : { tone: 'error', text: r.message ?? 'Invio non riuscito: la bozza è intatta.' },
          );
        }}
      />
    </>
  );
}

function ExistingEmail({ id }: { id: string }) {
  const detail = useApi<EmailDetail>(`/emails/${id}`);
  const meta = useApi<EmailMeta>('/emails/meta');
  const [current, setCurrent] = useState<EmailDetail | null>(null);
  const d = current && current.email.id === id ? current : detail.data;
  if ((detail.loading && !detail.data) || (meta.loading && !meta.data)) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} onRetry={detail.reload} />;
  if (meta.error) return <ErrorNotice error={meta.error} onRetry={meta.reload} />;
  if (!d || !meta.data) return null;
  return (
    <>
      <p className="breadcrumb">
        <Link to="/email">Email commerciali</Link> / {d.email.statusLabel}
      </p>
      <PageHeader
        title={d.business.name}
        lede={
          <>
            <Status tone={STATUS_TONE[d.email.status]}>{d.email.statusLabel}</Status>{' '}
            {d.email.mode === 'ai' ? 'Email personalizzata con AI' : meta.data.template.name}
            {d.email.createdBy && ` · creata da ${d.email.createdBy}`}
          </>
        }
      />
      <SendingStatusBar status={meta.data.sending} onChange={meta.reload} />
      <Editor key={d.email.id} d={d} meta={meta.data} onChange={setCurrent} />
    </>
  );
}

export function EmailEditorPage() {
  const { id } = useParams();
  if (!id || id === 'nuova') return <NewEmail />;
  return <ExistingEmail id={id} />;
}
