import { useCallback, useEffect, useState } from 'react';
import { ApiError, get } from '../api/client.ts';

interface Result<T> {
  key: string | null;
  data: T | null;
  error: ApiError | null;
}

/**
 * Lettura di una risorsa con stati espliciti di caricamento ed errore, e ricarica manuale.
 * Durante una ricarica restano visibili i dati precedenti; dopo un errore non si mostrano dati vecchi.
 */
export function useApi<T>(path: string | null, poll?: number | false) {
  const [version, setVersion] = useState(0);
  const key = path === null ? null : `${path}#${version}`;
  const [result, setResult] = useState<Result<T>>({ key: null, data: null, error: null });

  useEffect(() => {
    if (path === null || key === null) return;
    let cancelled = false;
    get<T>(path).then(
      (data) => {
        if (!cancelled) setResult({ key, data, error: null });
      },
      (e: unknown) => {
        if (!cancelled)
          setResult({
            key,
            data: null,
            error: e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Errore imprevisto.'),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, key]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  /*
   * Aggiornamento periodico: la richiesta successiva parte solo dopo la risposta precedente (nessuna richiesta
   * sovrapposta). Attivo finché `poll` è un numero di millisecondi.
   */
  useEffect(() => {
    if (!poll || key === null || result.key !== key) return;
    const timer = setTimeout(() => setVersion((v) => v + 1), poll);
    return () => clearTimeout(timer);
  }, [poll, key, result.key]);
  const loading = key !== null && result.key !== key;
  return { data: result.data, error: loading ? null : result.error, loading, reload };
}
