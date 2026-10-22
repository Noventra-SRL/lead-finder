import { useState } from 'react';
import type { ApiError, CommercialPriority } from '../api/client.ts';
import { PRIORITY_LABEL, todayRome } from '../lib/crm.ts';
import { Button, Field, SelectField, TextAreaField } from './ui.tsx';

export interface FollowUpInput {
  description: string;
  dueDate: string;
  dueTime: string | null;
  priority: CommercialPriority;
  notes?: string;
}

/**
 * Nuovo follow-up: titolo, scadenza (ora facoltativa), priorità, descrizione. Usato dalla scheda dell'opportunità e
 * dalla scheda dell'azienda. `onSubmit` restituisce true se il follow-up è stato salvato (il modulo si svuota).
 */
export function FollowUpForm({
  onSubmit,
  busy,
  error,
  submitLabel = 'Aggiungi il follow-up',
}: {
  onSubmit: (input: FollowUpInput) => Promise<boolean>;
  busy: boolean;
  error: ApiError | null;
  submitLabel?: string;
}) {
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [priority, setPriority] = useState<CommercialPriority>('media');
  const [notes, setNotes] = useState('');

  return (
    <form
      className="stack crm-form"
      aria-label="Nuovo follow-up"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({
          description: description.trim(),
          dueDate,
          dueTime: dueTime || null,
          priority,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }).then((ok) => {
          if (!ok) return;
          setDescription('');
          setDueDate('');
          setDueTime('');
          setPriority('media');
          setNotes('');
        });
      }}
    >
      <h3 className="sub-title">Pianifica un follow-up</h3>
      <div className="grid-2">
        <Field
          label="Azione"
          value={description}
          maxLength={300}
          required
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Es. richiamare per fissare una call"
          error={error?.fields.description}
        />
        <Field
          label="Scadenza"
          type="date"
          min={todayRome()}
          value={dueDate}
          required
          onChange={(e) => setDueDate(e.target.value)}
          error={error?.fields.dueDate}
        />
        <Field label="Ora (facoltativa)" type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
        <SelectField
          label="Priorità del follow-up"
          value={priority}
          onChange={(e) => setPriority(e.target.value as CommercialPriority)}
        >
          {(Object.keys(PRIORITY_LABEL) as CommercialPriority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </SelectField>
      </div>
      <TextAreaField
        label="Descrizione (facoltativa)"
        value={notes}
        maxLength={2000}
        rows={2}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div>
        <Button type="submit" busy={busy} disabled={!description.trim() || !dueDate}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
