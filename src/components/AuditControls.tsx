import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, post, type AuditJob } from '../api/client.ts';
import { isActive } from '../lib/discovery.ts';
import { Button, ConfirmDialog, Notice } from './ui.tsx';

/* Avvio di una verifica e comandi di un job di audit (pausa, ripresa, annullamento). */

const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));

/** Errore dell'avvio, con il collegamento alla verifica già attiva quando il server lo indica. */
function StartError({ error }: { error: ApiError }) {
  const jobId = typeof error.data?.jobId === 'string' ? error.data.jobId : null;
  return (
    <Notice tone={error.code === 'DUPLICATE_JOB' ? 'warn' : 'error'}>
      <p>
        {error.message}
        {jobId && (
          <>
            {' '}
            <Link to={`/audit/verifiche/${jobId}`}>Apri la verifica in corso</Link>.
          </>
        )}
      </p>
    </Notice>
  );
}

export function StartAudit({
  businessIds,
  label,
  force = false,
  variant = 'primary',
  disabled,
}: {
  businessIds: string[];
  label: string;
  force?: boolean;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ job: AuditJob }>(
        businessIds.length === 1 ? `/businesses/${businessIds[0]}/audit` : '/audits/jobs',
        businessIds.length === 1 ? { force } : { businessIds, force },
      );
      void navigate(`/audit/verifiche/${res.job.id}`);
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
    }
  };
  return (
    <div className="stack stack--tight">
      <div>
        <Button
          variant={variant}
          busy={busy}
          disabled={disabled || businessIds.length === 0}
          onClick={() => void start()}
        >
          {label}
        </Button>
      </div>
      {error && <StartError error={error} />}
    </div>
  );
}

export function AuditJobActions({ job, onDone }: { job: AuditJob; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (action: 'cancel' | 'pause' | 'resume') => {
    setBusy(action);
    setError(null);
    try {
      await post(`/audits/jobs/${job.id}/${action}`);
      onDone();
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };
  const canPause =
    (job.status === 'running' || job.status === 'pending') && !job.pauseRequested && !job.cancelRequested;
  const canCancel = isActive(job.status) && !job.cancelRequested;
  const canResume = job.status === 'paused' || job.status === 'failed' || job.status === 'completed_with_warnings';
  if (!canPause && !canCancel && !canResume) return null;
  return (
    <div className="stack">
      {error && <Notice tone="error">{error.message}</Notice>}
      <div className="row">
        {canResume && (
          <Button busy={busy === 'resume'} onClick={() => void run('resume')}>
            {job.status === 'paused' ? 'Riprendi' : 'Ripeti le verifiche non riuscite'}
          </Button>
        )}
        {canPause && (
          <Button variant="secondary" busy={busy === 'pause'} onClick={() => void run('pause')}>
            Metti in pausa
          </Button>
        )}
        {canCancel && (
          <Button variant="danger" onClick={() => setConfirm(true)}>
            Annulla la verifica
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title="Annullare la verifica?"
        confirmLabel="Annulla la verifica"
        tone="danger"
        busy={busy === 'cancel'}
        onConfirm={() => void run('cancel')}
        onCancel={() => setConfirm(false)}
      >
        Le aziende non ancora verificate escono dalla coda. Gli audit già completati restano disponibili.
      </ConfirmDialog>
    </div>
  );
}
