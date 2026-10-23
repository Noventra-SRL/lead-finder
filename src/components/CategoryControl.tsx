import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, put, type BusinessCategoryInfo, type BusinessCategoryId } from '../api/client.ts';
import { BUSINESS_CATEGORY_OPTIONS } from '../lib/categories.ts';
import { Button, SelectField } from './ui.tsx';

/*
 * Categoria commerciale nella scheda dell'azienda: quale, da dove viene (la prova) e, se serve, la correzione di una
 * persona. Una categoria scelta a mano non viene più cambiata dalla classificazione automatica finché non si torna
 * all'automatica. Ogni modifica è registrata.
 */

export function CategoryControl({
  businessId,
  category,
  onChanged,
}: {
  businessId: string;
  category: BusinessCategoryInfo | null;
  onChanged: () => void;
}) {
  const [value, setValue] = useState<BusinessCategoryId | ''>(category?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: BusinessCategoryId | null) => {
    setBusy(true);
    setError(null);
    try {
      await put(`/businesses/${businessId}/category`, { category: next });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Modifica non riuscita.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="category-control">
      <p className="small">
        Categoria:{' '}
        {category ? (
          <>
            <Link to={`/trova?categoria=${category.id}`}>{category.label}</Link>
            <span className="muted">
              {' '}
              · {category.source === 'manuale' ? 'scelta a mano' : 'automatica'}
              {category.status === 'da_verificare' && ' · da verificare'}
              {category.evidence && category.source === 'automatica' && ` (${category.evidence})`}
            </span>
          </>
        ) : (
          <span className="muted">in classificazione</span>
        )}
      </p>
      <details className="category-control__edit">
        <summary className="small">Correggi la categoria</summary>
        <div className="row">
          <SelectField
            label="Categoria principale"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value as BusinessCategoryId)}
          >
            {!category && <option value="">—</option>}
            {BUSINESS_CATEGORY_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </SelectField>
          <Button
            variant="secondary"
            busy={busy}
            disabled={!value || (value === category?.id && category.source === 'manuale')}
            onClick={() => void save(value as BusinessCategoryId)}
          >
            Salva la categoria
          </Button>
          {category?.source === 'manuale' && (
            <Button variant="ghost" disabled={busy} onClick={() => void save(null)}>
              Torna alla classificazione automatica
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="field__error">
            {error}
          </p>
        )}
      </details>
    </div>
  );
}
