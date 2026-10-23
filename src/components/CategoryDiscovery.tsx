import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, post, type BusinessCategoriesResponse, type HunterMeta, type HuntRunDetail } from '../api/client.ts';
import { COVERAGE_LABEL } from '../lib/discovery.ts';
import { AreaPicker, areaOf, type AreaValue } from './AreaPicker.tsx';
import { Button, Checkbox, Field, SelectField } from './ui.tsx';

/*
 * «Cerca nuove farmacie» (e così per ogni categoria): avvia una ricerca reale con la pipeline del Lead Hunter, usando
 * i settori della categoria (decisi dal server, server/categories/catalog.ts). L'area parte da quella filtrata nella
 * pagina. Le aziende trovate vengono salvate man mano, senza doppioni, e classificate dalle loro prove; l'avanzamento
 * reale è nella pagina della ricerca. Nessuna email parte durante la ricerca.
 */

type Category = BusinessCategoriesResponse['categories'][number];

export function CategoryDiscovery({
  category,
  meta,
  initialArea,
  onClose,
}: {
  category: Category;
  meta: HunterMeta;
  initialArea: AreaValue;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const navigate = useNavigate();
  const [area, setArea] = useState<AreaValue>(initialArea);
  const [target, setTarget] = useState('100');
  const [audit, setAudit] = useState(true);
  // fonte: OpenStreetMap se configurato, altrimenti Google Maps se configurato
  const sources = meta.providers;
  const [source, setSource] = useState<'osm' | 'google'>(
    () => (sources.find((p) => p.configured)?.id ?? 'osm') as 'osm' | 'google',
  );
  const chosen = sources.find((p) => p.id === source);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const sectors = meta.sectors.filter((s) => category.sectors.includes(s.id));
  const limited = sectors.filter((s) => s.coverage !== 'buona');

  const close = () => {
    if (busy) return;
    ref.current?.close();
    onClose();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<HuntRunDetail>('/hunter/runs', {
        target: Number(target),
        area: areaOf(area),
        category: category.id,
        provider: source,
        options: { websitePreference: 'any', minScore: null, excludeKnown: false, audit },
      });
      void navigate(`/lead-hunter/${r.run.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Avvio non riuscito.'));
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialog dialog--wide"
      aria-labelledby={titleId}
      onCancel={(ev) => {
        ev.preventDefault();
        close();
      }}
    >
      <form onSubmit={(e) => void submit(e)} aria-label={category.discover}>
        <div className="dialog__body">
          <h2 className="dialog__title" id={titleId}>
            {category.discover}
          </h2>
          <p className="dialog__text">
            Ricerca su {chosen?.label ?? meta.provider.label} per{' '}
            {sectors.map((s, i) => (
              <span key={s.id}>
                {i > 0 && (i === sectors.length - 1 ? ' e ' : ', ')}«{s.label}»
              </span>
            ))}
            . Le aziende trovate vengono salvate man mano, senza doppioni, e ognuna riceve la categoria indicata dalle
            sue prove. Durante la ricerca non viene inviata nessuna email.
          </p>
          <SelectField
            label="Fonte"
            value={source}
            disabled={busy}
            onChange={(e) => setSource(e.target.value as 'osm' | 'google')}
            hint={
              source === 'google'
                ? 'Google Maps fornisce nome, indirizzo, sito e telefono, non l’email: le email si cercano poi sui siti delle aziende. Ogni richiesta è a pagamento, entro il limite giornaliero impostato sul server; i risultati possono essere incompleti.'
                : 'OpenStreetMap: dati aperti dei volontari, gratuiti; alcune attività possono mancare.'
            }
          >
            {sources.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.configured ? '' : ' (non configurata)'}
              </option>
            ))}
          </SelectField>
          {source === 'osm' && limited.length > 0 && (
            <ul className="small muted category-discovery__notes">
              {limited.map((s) => (
                <li key={s.id}>
                  {s.label}: {COVERAGE_LABEL[s.coverage].toLowerCase()}
                  {s.note ? `. ${s.note}` : '.'}
                </li>
              ))}
            </ul>
          )}
          <AreaPicker value={area} onChange={setArea} allLabel="Tutta Italia" disabled={busy} />
          <Field
            label="Quante aziende cercare"
            type="number"
            min={1}
            max={meta.limits.maxTarget}
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
            error={error?.fields.target}
            hint="Traguardo, non garanzia: se la fonte ne contiene meno, la ricerca lo dichiara."
          />
          <Checkbox
            label="Verifica automatica dei siti trovati"
            checked={audit}
            disabled={busy}
            onChange={(e) => setAudit(e.target.checked)}
          />
          {chosen && !chosen.configured && (
            <p role="alert" className="field__error">
              {chosen.setupHint ?? `La ricerca con ${chosen.label} non è configurata sul server.`}
            </p>
          )}
          {error && !error.fields.target && (
            <p role="alert" className="field__error">
              {error.message}
            </p>
          )}
        </div>
        <div className="dialog__actions">
          <Button variant="ghost" type="button" onClick={close} disabled={busy}>
            Annulla
          </Button>
          <Button type="submit" busy={busy} disabled={!chosen?.configured || !Number(target)}>
            Avvia la ricerca
          </Button>
        </div>
      </form>
    </dialog>
  );
}
