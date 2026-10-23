import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError, patch, post, type BusinessDetail, type StageId } from '../api/client.ts';
import { BUSINESS_CATEGORY_OPTIONS } from '../lib/categories.ts';
import { STAGE_LABEL } from '../lib/crm.ts';
import { AreaPicker, type AreaValue } from './AreaPicker.tsx';
import { Button, ConfirmDialog, Field, Notice, SelectField, TextAreaField } from './ui.tsx';

/*
 * «Modifica» della scheda azienda: un modulo con i dati attuali, diviso in Dati aziendali, Contatti, Indirizzo,
 * Informazioni commerciali, Note e CRM.
 *  - si inviano solo i campi cambiati, con la versione della scheda letta (il server rifiuta se nel frattempo è
 *    cambiata: niente sovrascritture);
 *  - svuotare un campo che aveva un valore chiede conferma;
 *  - «Annulla» e l'uscita dalla pagina avvisano se ci sono modifiche non salvate;
 *  - un errore lascia il modulo com'è, con gli errori accanto ai campi.
 * Punteggi, audit, email e storico del CRM non vengono toccati; il divieto di contatto si gestisce da «Gestisci
 * contatto» e resta valido.
 */

const OPERATING = [
  { id: '', label: 'Non verificato' },
  { id: 'attiva', label: 'Attiva' },
  { id: 'chiusa_temporaneamente', label: 'Chiusa temporaneamente' },
  { id: 'chiusa_definitivamente', label: 'Chiusa definitivamente' },
] as const;

/** Fasi scelte da qui: «Non contattare» passa da «Gestisci contatto», che registra il motivo. */
const EDITABLE_STAGES = Object.keys(STAGE_LABEL).filter((s) => s !== 'non_contattare') as StageId[];

interface Values {
  name: string;
  category: string;
  operatingStatus: string;
  email: string;
  phone: string;
  fax: string;
  website: string;
  contactName: string;
  contactRole: string;
  street: string;
  housenumber: string;
  postcode: string;
  city: string;
  municipalityCode: string;
  notes: string;
}

const LABEL: Record<keyof Values, string> = {
  name: 'Nome',
  category: 'Categoria',
  operatingStatus: 'Stato dell’attività',
  email: 'Email',
  phone: 'Telefono',
  fax: 'Fax',
  website: 'Sito web',
  contactName: 'Referente',
  contactRole: 'Ruolo del referente',
  street: 'Via',
  housenumber: 'Civico',
  postcode: 'CAP',
  city: 'Località',
  municipalityCode: 'Comune',
  notes: 'Note',
};

function valuesOf(b: BusinessDetail): Values {
  return {
    name: b.name,
    // categoria scelta a mano, oppure «classificazione automatica» (stringa vuota)
    category: b.businessCategory?.source === 'manuale' ? b.businessCategory.id : '',
    operatingStatus: b.operatingStatus ?? '',
    email: b.contacts.email ?? '',
    phone: b.contacts.phone ?? '',
    fax: b.contacts.fax ?? '',
    website: b.website?.url ?? '',
    contactName: b.contactPerson?.name ?? '',
    contactRole: b.contactPerson?.role ?? '',
    street: b.address.street ?? '',
    housenumber: b.address.housenumber ?? '',
    postcode: b.address.postcode ?? '',
    city: b.address.city ?? '',
    municipalityCode: b.place.municipalityCode ?? '',
    notes: b.notes ?? '',
  };
}

export function BusinessEditor({
  business: b,
  onSaved,
  onCancel,
}: {
  business: BusinessDetail;
  onSaved: (b: BusinessDetail) => void;
  onCancel: () => void;
}) {
  const [initial] = useState(() => valuesOf(b));
  const [v, setV] = useState(initial);
  const [area, setArea] = useState<AreaValue>({
    region: b.place.regionCode ?? '',
    province: b.place.provinceCode ?? '',
    municipality: b.place.municipalityCode ?? '',
  });
  const [stage, setStage] = useState<StageId | ''>(b.crm?.open ? b.crm.stage : '');
  const [stageNote, setStageNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirmClear, setConfirmClear] = useState<(keyof Values)[] | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const values = { ...v, municipalityCode: area.municipality };
  const changed = (Object.keys(values) as (keyof Values)[]).filter((k) => values[k].trim() !== initial[k].trim());
  const stageChanged = Boolean(b.crm?.open && stage && stage !== b.crm.stage);
  const dirty = changed.length > 0 || stageChanged || stageNote.trim() !== '';
  const set = (k: keyof Values) => (e: { target: { value: string } }) =>
    setV((cur) => ({ ...cur, [k]: e.target.value }));
  const err = (k: string) => error?.fields[k];

  // uscita dalla pagina con modifiche non salvate: avviso del browser
  useEffect(() => {
    if (!dirty) return;
    const warn = (ev: BeforeUnloadEvent) => ev.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function save(clearConfirmed: boolean) {
    // campi che avevano un valore e ora sono vuoti: si cancellano solo con una conferma
    const emptied = changed.filter(
      (k) => k !== 'category' && k !== 'operatingStatus' && !values[k].trim() && initial[k].trim(),
    );
    if (emptied.length && !clearConfirmed) {
      setConfirmClear(emptied);
      return;
    }
    setConfirmClear(null);
    setBusy(true);
    setError(null);
    try {
      let saved: BusinessDetail | null = null;
      if (changed.length) {
        const body: Record<string, unknown> = { updatedAt: b.updatedAt };
        for (const k of changed) {
          const value = values[k].trim();
          if (k === 'notes') body.notes = values.notes.trim() ? values.notes : null;
          else body[k] = value || null;
        }
        if (changed.includes('name')) body.name = values.name.trim();
        if (emptied.length) body.clear = emptied;
        saved = (await patch<{ business: BusinessDetail }>(`/businesses/${b.id}`, body)).business;
      }
      // fase del CRM: stesso percorso della pipeline (attività registrata, regole del CRM)
      if (stageChanged || (b.crm?.open && stageNote.trim())) {
        await post(`/crm/opportunities/${b.crm!.opportunityId}/stage`, {
          stage: stage || b.crm!.stage,
          ...(stageNote.trim() ? { note: stageNote.trim() } : {}),
          ...(stage === 'perso' ? { lostReason: stageNote.trim() || 'Indicato dalla scheda azienda.' } : {}),
        });
        saved = null; // la scheda va riletta per la nuova fase
      }
      onSaved(saved ?? b);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e
          : new ApiError(0, 'UNKNOWN', 'Salvataggio non riuscito: controlla la connessione e riprova.'),
      );
      setBusy(false);
    }
  }

  return (
    <form
      className="biz-edit stack"
      aria-label="Modifica azienda"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!busy) void save(false);
      }}
    >
      <p className="small muted">
        Stai modificando la scheda. Punteggi, verifiche del sito, email e storico del CRM restano invariati; il divieto
        di contatto si gestisce da «Gestisci contatto».
      </p>

      <fieldset className="fieldset biz-edit__group">
        <legend>Dati aziendali</legend>
        <div className="grid-2">
          <Field
            label={LABEL.name}
            value={v.name}
            onChange={set('name')}
            maxLength={200}
            required
            error={err('name')}
          />
          <SelectField
            label={LABEL.category}
            value={v.category}
            onChange={set('category')}
            error={err('category')}
            hint={
              b.businessCategory
                ? `Attuale: ${b.businessCategory.label} (${b.businessCategory.source === 'manuale' ? 'scelta a mano' : 'automatica'}). Cambia il modello delle nuove email, non le bozze esistenti.`
                : undefined
            }
          >
            <option value="">Classificazione automatica</option>
            {BUSINESS_CATEGORY_OPTIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={LABEL.operatingStatus}
            value={v.operatingStatus}
            onChange={set('operatingStatus')}
            error={err('operatingStatus')}
          >
            {OPERATING.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </SelectField>
        </div>
      </fieldset>

      <fieldset className="fieldset biz-edit__group">
        <legend>Contatti</legend>
        <div className="grid-2">
          <Field
            label={LABEL.email}
            type="email"
            value={v.email}
            onChange={set('email')}
            maxLength={254}
            error={err('email')}
            hint="Un indirizzo inserito a mano resta «da verificare»."
          />
          <Field
            label={LABEL.phone}
            type="tel"
            value={v.phone}
            onChange={set('phone')}
            maxLength={40}
            error={err('phone')}
          />
          <Field label={LABEL.fax} type="tel" value={v.fax} onChange={set('fax')} maxLength={40} error={err('fax')} />
          <Field
            label={LABEL.website}
            value={v.website}
            onChange={set('website')}
            maxLength={500}
            placeholder="https://www.esempio.it"
            error={err('website')}
            hint="Un nuovo sito va controllato di nuovo: le verifiche precedenti restano nello storico."
          />
          <Field
            label={LABEL.contactName}
            value={v.contactName}
            onChange={set('contactName')}
            maxLength={120}
            error={err('contactName')}
          />
          <Field
            label={LABEL.contactRole}
            value={v.contactRole}
            onChange={set('contactRole')}
            maxLength={80}
            error={err('contactRole')}
          />
        </div>
      </fieldset>

      <fieldset className="fieldset biz-edit__group">
        <legend>Indirizzo</legend>
        <div className="grid-2">
          <Field label={LABEL.street} value={v.street} onChange={set('street')} maxLength={200} error={err('street')} />
          <Field
            label={LABEL.housenumber}
            value={v.housenumber}
            onChange={set('housenumber')}
            maxLength={20}
            error={err('housenumber')}
          />
          <Field
            label={LABEL.postcode}
            value={v.postcode}
            onChange={set('postcode')}
            inputMode="numeric"
            maxLength={10}
            error={err('postcode')}
          />
          <Field
            label={LABEL.city}
            value={v.city}
            onChange={set('city')}
            maxLength={120}
            error={err('city')}
            hint="Frazione o località, se diversa dal comune."
          />
        </div>
        <AreaPicker value={area} onChange={setArea} allLabel="Non indicata" />
        {err('municipalityCode') && <p className="field__error">{err('municipalityCode')}</p>}
      </fieldset>

      <fieldset className="fieldset biz-edit__group">
        <legend>Informazioni commerciali</legend>
        <dl className="props props--compact">
          <dt>Punteggio commerciale</dt>
          <dd>
            {b.commercial ? `${b.commercial.score} · ${b.commercial.band?.label ?? ''}` : 'Non ancora calcolato'}
            <span className="small muted"> (calcolato dall’applicazione, non modificabile)</span>
          </dd>
          <dt>Stato del contatto</dt>
          <dd>{b.contact?.label ?? '—'}</dd>
        </dl>
      </fieldset>

      <fieldset className="fieldset biz-edit__group">
        <legend>Note e CRM</legend>
        <TextAreaField
          label={LABEL.notes}
          value={v.notes}
          onChange={set('notes')}
          rows={4}
          maxLength={5000}
          error={err('notes')}
          hint="Note interne sull’azienda: non compaiono mai nelle email."
        />
        {b.crm?.open ? (
          <div className="grid-2">
            <SelectField label="Fase nel CRM" value={stage} onChange={(e) => setStage(e.target.value as StageId)}>
              {EDITABLE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </SelectField>
            <TextAreaField
              label={stage === 'perso' ? 'Motivo (obbligatorio per «Perso»)' : 'Nota di follow-up (facoltativa)'}
              value={stageNote}
              onChange={(e) => setStageNote(e.target.value)}
              rows={2}
              maxLength={1000}
              hint="Registrata come attività nel CRM."
            />
          </div>
        ) : (
          <p className="small muted">
            Nessuna opportunità aperta nel CRM: la si crea da «Attività commerciali» con «Aggiungi al CRM».
          </p>
        )}
        {b.crm?.open && (
          <p className="small">
            <Link to={`/pipeline/${b.crm.opportunityId}`}>Apri l’opportunità</Link> per attività e follow-up completi.
          </p>
        )}
      </fieldset>

      {error && !Object.keys(error.fields).length && (
        <Notice tone="error">
          <p>
            {error.message}
            {error.code === 'STALE'
              ? ' I dati inseriti restano nel modulo: copia ciò che serve prima di ricaricare.'
              : ''}
          </p>
        </Notice>
      )}
      {error && Object.keys(error.fields).length > 0 && (
        <p role="alert" className="field__error">
          {error.message}
        </p>
      )}

      <div className="row biz-edit__actions">
        <Button type="submit" busy={busy} disabled={!dirty}>
          Salva modifiche
        </Button>
        <Button
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => (dirty ? setConfirmDiscard(true) : onCancel())}
        >
          Annulla
        </Button>
        <span className="small muted" aria-live="polite">
          {dirty ? 'Modifiche non salvate.' : 'Nessuna modifica.'}
        </span>
      </div>

      <ConfirmDialog
        open={confirmClear !== null}
        title="Svuotare questi campi?"
        confirmLabel="Svuota e salva"
        tone="danger"
        busy={busy}
        onCancel={() => setConfirmClear(null)}
        onConfirm={() => void save(true)}
      >
        <p>
          I valori attuali di {(confirmClear ?? []).map((k) => LABEL[k].toLowerCase()).join(', ')} verranno cancellati
          dalla scheda. La modifica resta nella cronologia.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDiscard}
        title="Scartare le modifiche?"
        confirmLabel="Scarta le modifiche"
        tone="danger"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onCancel();
        }}
      >
        <p>Le modifiche non salvate andranno perse.</p>
      </ConfirmDialog>
    </form>
  );
}
