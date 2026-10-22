import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { ApiError } from '../api/client.ts';

/* Componenti di base del design system. Stili in src/styles/components.css. */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  busy = false,
  block = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean; block?: boolean }) {
  const classes = ['btn', variant !== 'primary' && `btn--${variant}`, block && 'btn--block', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  hint,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function TextAreaField({
  label,
  error,
  hint,
  ...area
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="input textarea"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        rows={3}
        {...area}
      />
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  error,
  hint,
  children,
  ...select
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="input select"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...select}
      >
        {children}
      </select>
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function Checkbox({
  label,
  hint,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="check">
      <input id={id} type="checkbox" aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="check__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Avanzamento con valore reale (unità completate su totali), annunciato ai lettori di schermo. */
export function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <span className="progress__bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // una sola pagina: niente controlli da mostrare
  if (total === 0 || pages === 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Pagine dei risultati">
      <span className="pager__info">
        <span className="mono">
          {from}–{to}
        </span>{' '}
        di <span className="mono">{total}</span>
      </span>
      <div className="row">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Precedente
        </Button>
        <span className="pager__page mono" aria-live="polite">
          {page} / {pages}
        </span>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Successiva
        </Button>
      </div>
    </nav>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'error';
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div>
        {title && <p className="notice__title">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/** Errore di una richiesta, con il codice per il supporto quando il server lo fornisce. */
export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <Notice tone="error" title="Impossibile caricare i dati">
      <p>{error.message}</p>
      <div className="row notice__actions">
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            Riprova
          </Button>
        )}
        {error.requestId && <span className="muted small mono">rif. {error.requestId}</span>}
      </div>
    </Notice>
  );
}

export function Loading({ label = 'Caricamento…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading__bar" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <div className="empty__text">{children}</div>}
    </div>
  );
}

export function Status({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'idle'; children: ReactNode }) {
  return <span className={`status status--${tone}`}>{children}</span>;
}

/** Intestazione di pagina: titolo e una riga di contesto (`index` resta accettato ma non si mostra più). */
export function PageHeader({ title, lede }: { index?: string; title: string; lede?: ReactNode }) {
  return (
    <header className="page-head">
      <h1 className="page-head__title">{title}</h1>
      {lede && <p className="page-head__lede">{lede}</p>}
    </header>
  );
}

export function Section({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section className="section" aria-labelledby={headingId} id={id}>
      <div className="section__head">
        <h2 className="section__title" id={headingId}>
          {title}
        </h2>
        {description && <p className="section__desc">{description}</p>}
      </div>
      <div className="section__body">{children}</div>
    </section>
  );
}

/** Dialogo di conferma accessibile (elemento <dialog> nativo: focus intrappolato, Esc per chiudere). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = 'primary',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  /** Conferma non ancora possibile (es. manca un campo obbligatorio nel dialogo). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="dialog__body">
        <h2 className="dialog__title" id={titleId}>
          {title}
        </h2>
        <div className="dialog__text">{children}</div>
      </div>
      <div className="dialog__actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Annulla
        </Button>
        <Button
          variant={tone === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
          busy={busy}
          disabled={confirmDisabled}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
