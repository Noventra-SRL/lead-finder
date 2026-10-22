import { useEffect, useState } from 'react';
import { ApiError, get, post, type ScoringJob } from '../api/client.ts';
import { Button, Notice } from './ui.tsx';

/* Aggiornamento in background dei punteggi di più aziende, con avanzamento reale del job. */

export function ScoreSelected({
  businessIds,
  label = 'Aggiorna punteggio dei selezionati',
  scope = 'businesses',
  force = false,
  onDone,
}: {
  businessIds?: string[];
  label?: string;
  scope?: 'businesses' | 'all';
  force?: boolean;
  onDone: () => void;
}) {
  const [job, setJob] = useState<ScoringJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const running = job && (job.status === 'pending' || job.status === 'running');

  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => {
      get<{ job: ScoringJob }>(`/scoring/jobs/${job.id}`).then(
        (r) => {
          setJob(r.job);
          if (r.job.status === 'completed') onDone();
        },
        (e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Stato non disponibile.')),
      );
    }, 1000);
    return () => clearTimeout(t);
  }, [job, running, onDone]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ job: ScoringJob }>('/scoring/jobs', {
        scope,
        businessIds: scope === 'all' ? undefined : businessIds,
        force,
      });
      setJob(r.job);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack stack--tight">
      <div>
        <Button
          variant="secondary"
          busy={busy || Boolean(running)}
          disabled={scope === 'businesses' && !businessIds?.length}
          onClick={() => void start()}
        >
          {label}
        </Button>
      </div>
      {job && (
        <p className="small" role="status">
          {running
            ? `Calcolo in corso: ${job.progress.processed} di ${job.progress.total}…`
            : job.status === 'completed'
              ? `Punteggi aggiornati: ${job.progress.created} ricalcolati, ${job.progress.unchanged} già aggiornati.`
              : job.status === 'failed'
                ? (job.error ?? 'Calcolo non riuscito.')
                : 'Calcolo annullato.'}
        </p>
      )}
      {error && <Notice tone="error">{error.message}</Notice>}
    </div>
  );
}
