import { useState } from 'react';
import { ApiError, post } from '../api/client.ts';
import { Button, ConfirmDialog, Notice } from './ui.tsx';

/*
 * Decisione su una coppia di possibili duplicati: unire (scegliendo quale azienda resta) oppure segnare come
 * attività distinte. L'unione chiede sempre conferma: l'azienda non mantenuta diventa un rimando.
 */
export function DuplicateActions({
  candidateId,
  a,
  b,
  onDone,
}: {
  candidateId: string;
  a: { id: string; name: string };
  b: { id: string; name: string };
  onDone: () => void;
}) {
  const [keep, setKeep] = useState<{ id: string; name: string; other: string } | null>(null);
  const [busy, setBusy] = useState<'merge' | 'distinct' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: 'merge' | 'distinct') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'merge') await post(`/duplicates/${candidateId}/merge`, { keep: keep!.id });
      else await post(`/duplicates/${candidateId}/distinct`);
      setKeep(null);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Operazione non riuscita.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack stack--tight">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="row">
        <Button variant="secondary" onClick={() => setKeep({ ...a, other: b.name })}>
          Unisci, mantieni la prima
        </Button>
        <Button variant="secondary" onClick={() => setKeep({ ...b, other: a.name })}>
          Unisci, mantieni la seconda
        </Button>
        <Button variant="ghost" busy={busy === 'distinct'} onClick={() => void act('distinct')}>
          Sono attività diverse
        </Button>
      </div>
      <ConfirmDialog
        open={keep !== null}
        title="Unire le due aziende?"
        confirmLabel="Unisci"
        busy={busy === 'merge'}
        onConfirm={() => void act('merge')}
        onCancel={() => setKeep(null)}
      >
        Resta «{keep?.name}». L’altra scheda («{keep?.other}») non comparirà più negli elenchi: le sue fonti passano
        all’azienda mantenuta e ne completano i dati mancanti. L’operazione è registrata nella cronologia.
      </ConfirmDialog>
    </div>
  );
}
