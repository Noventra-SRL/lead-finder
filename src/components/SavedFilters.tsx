import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, del, patch, post, type SavedFilter, type SavedFilterScope } from '../api/client.ts';
import { useApi } from '../lib/useApi.ts';
import { Button, ConfirmDialog, Field } from './ui.tsx';

/** Parametri che non sono criteri (stessa regola del server). */
const NOT_CRITERIA = new Set(['page', 'pageSize']);
export function criteriaOf(query: string): string {
  const entries = [...new URLSearchParams(query).entries()].filter(([k, v]) => !NOT_CRITERIA.has(k) && v !== '');
  entries.sort(([a], [b]) => a.localeCompare(b));
  return new URLSearchParams(entries).toString();
}

const messageOf = (e: unknown) => (e instanceof ApiError ? e.message : 'Operazione non riuscita.');

/**
 * Filtri salvati di un elenco: si salvano i criteri (non le righe), quindi riaprendo un filtro i risultati sono quelli
 * di oggi. Il numero accanto al nome è calcolato adesso dal server; i filtri con criteri non più validi restano
 * visibili con il motivo, ma non si aprono.
 */
export function SavedFilters({
  scope,
  query,
  basePath,
}: {
  scope: SavedFilterScope;
  /** Criteri attuali dell'elenco (query string). */
  query: string;
  /** Pagina su cui aprire un filtro. */
  basePath: string;
}) {
  const list = useApi<{ items: SavedFilter[] }>(`/saved-filters?scope=${scope}`);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [renaming, setRenaming] = useState<SavedFilter | null>(null);
  const [deleting, setDeleting] = useState<SavedFilter | null>(null);

  const current = criteriaOf(query);
  const items = list.data?.items ?? [];
  const active = items.find((f) => f.query === current);

  async function run(action: () => Promise<unknown>, done: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      done();
      list.reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setSaving(false);
    setRenaming(null);
    setDeleting(null);
    setError(null);
    setName('');
  };

  return (
    <div className="saved-filters" aria-label="Filtri salvati" role="group">
      <span className="saved-filters__label">Filtri salvati</span>
      {list.data && items.length === 0 && <span className="small muted">Nessuno per ora.</span>}
      {list.error && <span className="small text-danger">Filtri salvati non disponibili.</span>}
      <ul className="saved-filters__list">
        {items.map((f) => (
          <li key={f.id}>
            {f.valid ? (
              <Link
                to={`${basePath}${f.query ? `?${f.query}` : ''}`}
                aria-current={f.id === active?.id ? 'true' : undefined}
              >
                {f.name} <span className="mono muted">{f.count?.toLocaleString('it-IT')}</span>
              </Link>
            ) : (
              <span className="saved-filters__invalid" title={f.invalidReason ?? undefined}>
                {f.name} <span className="small">· non valido</span>
              </span>
            )}
            {managing && (
              <span className="saved-filters__manage">
                <button type="button" className="link-button small" onClick={() => (setRenaming(f), setName(f.name))}>
                  Rinomina
                </button>
                <button type="button" className="link-button small text-danger" onClick={() => setDeleting(f)}>
                  Elimina
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <span className="saved-filters__actions">
        <Button
          variant="ghost"
          disabled={!current || Boolean(active)}
          title={
            !current
              ? 'Imposta almeno un filtro'
              : active
                ? `Già salvato come «${active.name}»`
                : 'Salva i criteri attuali'
          }
          onClick={() => setSaving(true)}
        >
          Salva filtri
        </Button>
        {items.length > 0 && (
          <Button variant="ghost" aria-pressed={managing} onClick={() => setManaging(!managing)}>
            {managing ? 'Fatto' : 'Gestisci'}
          </Button>
        )}
      </span>
      {managing && items.some((f) => !f.valid) && (
        <p className="small muted saved-filters__note">
          I filtri «non validi» usano criteri che non esistono più (per esempio un settore rimosso): eliminali o
          ricreali.{' '}
          {items
            .filter((f) => !f.valid)
            .map((f) => `${f.name}: ${f.invalidReason}`)
            .join(' ')}
        </p>
      )}

      <ConfirmDialog
        open={saving}
        title="Salva i filtri attuali"
        confirmLabel="Salva"
        busy={busy}
        confirmDisabled={!name.trim()}
        onCancel={close}
        onConfirm={() => void run(() => post('/saved-filters', { scope, name: name.trim(), query: current }), close)}
      >
        <div className="stack stack--tight">
          <p>Si salvano i criteri, non le righe: riaprendo il filtro vedrai i risultati aggiornati.</p>
          <Field
            label="Nome"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            error={error ?? undefined}
            autoFocus
          />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={renaming !== null}
        title="Rinomina il filtro"
        confirmLabel="Rinomina"
        busy={busy}
        confirmDisabled={!name.trim()}
        onCancel={close}
        onConfirm={() => void run(() => patch(`/saved-filters/${renaming!.id}`, { name: name.trim() }), close)}
      >
        <Field
          label="Nuovo nome"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
          autoFocus
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== null}
        title="Eliminare il filtro?"
        confirmLabel="Elimina"
        tone="danger"
        busy={busy}
        onCancel={close}
        onConfirm={() => void run(() => del(`/saved-filters/${deleting!.id}`), close)}
      >
        <p>
          Il filtro «{deleting?.name}» verrà eliminato. Le aziende e le opportunità non cambiano: si perde solo la
          scorciatoia.
        </p>
        {error && <p className="field__error">{error}</p>}
      </ConfirmDialog>
    </div>
  );
}
