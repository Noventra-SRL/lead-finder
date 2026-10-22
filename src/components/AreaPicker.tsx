import { useApi } from '../lib/useApi.ts';
import { SelectField } from './ui.tsx';

/*
 * Scelta progressiva dell'area: regione → provincia → comune, con i codici ISTAT come valori.
 * Ogni livello è facoltativo: si parte da un comune e si allarga, o si resta su un'area più ampia.
 */

export interface AreaValue {
  region: string;
  province: string;
  municipality: string;
}

export const EMPTY_AREA: AreaValue = { region: '', province: '', municipality: '' };

export function AreaPicker({
  value,
  onChange,
  allLabel,
  disabled,
}: {
  value: AreaValue;
  onChange: (v: AreaValue) => void;
  /** Etichetta dell'opzione "nessun filtro" del primo livello (es. "Tutta Italia"). */
  allLabel: string;
  disabled?: boolean;
}) {
  const regions = useApi<{ regions: { code: string; name: string }[] }>('/geo/regions');
  const provinces = useApi<{ provinces: { code: string; name: string; sigla: string; kind: string }[] }>(
    value.region ? `/geo/regions/${value.region}/provinces` : null,
  );
  const municipalities = useApi<{ municipalities: { code: string; name: string; altName?: string }[] }>(
    value.province ? `/geo/provinces/${value.province}/municipalities` : null,
  );

  return (
    <div className="area-picker">
      <SelectField
        label="Regione"
        value={value.region}
        disabled={disabled || !regions.data}
        onChange={(e) => onChange({ region: e.target.value, province: '', municipality: '' })}
        error={regions.error?.message}
      >
        <option value="">{allLabel}</option>
        {regions.data?.regions.map((r) => (
          <option key={r.code} value={r.code}>
            {r.name}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Provincia o città metropolitana"
        value={value.province}
        disabled={disabled || !value.region || !provinces.data}
        onChange={(e) => onChange({ ...value, province: e.target.value, municipality: '' })}
        error={provinces.error?.message}
      >
        <option value="">{value.region ? 'Tutta la regione' : '—'}</option>
        {provinces.data?.provinces.map((p) => (
          <option key={p.code} value={p.code}>
            {p.name} ({p.sigla})
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Comune"
        value={value.municipality}
        disabled={disabled || !value.province || !municipalities.data}
        onChange={(e) => onChange({ ...value, municipality: e.target.value })}
        error={municipalities.error?.message}
      >
        <option value="">{value.province ? 'Tutta la provincia' : '—'}</option>
        {municipalities.data?.municipalities.map((m) => (
          <option key={m.code} value={m.code}>
            {m.altName ?? m.name}
          </option>
        ))}
      </SelectField>
    </div>
  );
}

/** Area selezionata nel formato dell'API: il livello più specifico scelto. */
export function areaOf(v: AreaValue): { type: 'italy' | 'region' | 'province' | 'municipality'; code: string } {
  if (v.municipality) return { type: 'municipality', code: v.municipality };
  if (v.province) return { type: 'province', code: v.province };
  if (v.region) return { type: 'region', code: v.region };
  return { type: 'italy', code: 'IT' };
}
