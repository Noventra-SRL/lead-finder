import type { CommercialEmail } from '../api/client.ts';

/*
 * Nota interna «Perché questa email»: sintesi della personalizzazione, servizio principale, qualità delle prove e
 * avvisi. Serve al commerciale per decidere se inviare; non compare mai nel testo dell'email.
 * Le bozze generate prima della versione 2 del prompt non hanno questi campi: la nota non si mostra.
 */

const QUALITY: Record<'alta' | 'media' | 'bassa', { label: string; hint: string }> = {
  alta: { label: 'Alta', hint: 'osservazioni sostenute da rilievi sul sito' },
  media: { label: 'Media', hint: 'alcune informazioni specifiche sull’azienda' },
  bassa: { label: 'Bassa', hint: 'solo nome, categoria e città: presentazione generale' },
};

export function EmailRationale({
  email,
  catalog,
  compact = false,
}: {
  email: Pick<CommercialEmail, 'mode' | 'internalNotes' | 'evidence' | 'aiModel' | 'generatedAt'>;
  catalog: { id: string; name: string }[];
  compact?: boolean;
}) {
  const n = email.internalNotes;
  if (email.mode !== 'ai' || !n?.summary) return null;
  const service = n.primaryService ? (catalog.find((s) => s.id === n.primaryService)?.name ?? n.primaryService) : null;
  const quality = n.evidenceQuality ? QUALITY[n.evidenceQuality] : null;
  return (
    <section className={`rationale${compact ? ' rationale--compact' : ''}`} aria-label="Perché questa email">
      <p className="rationale__title">
        Perché questa email <span className="rationale__tag">nota interna, non inviata</span>
      </p>
      <p className="rationale__summary">{n.summary}</p>
      <dl className="rationale__facts">
        <dt>Servizio principale</dt>
        <dd>{service ?? 'Presentazione generale'}</dd>
        {quality && (
          <>
            <dt>Qualità delle prove</dt>
            <dd>
              <span className={`rationale__quality rationale__quality--${n.evidenceQuality}`}>{quality.label}</span>
              <span className="muted"> · {quality.hint}</span>
            </dd>
          </>
        )}
        {!compact && email.evidence.length > 0 && (
          <>
            <dt>Prove citate</dt>
            <dd className="mono small">{email.evidence.map((x) => x.id).join(', ')}</dd>
          </>
        )}
      </dl>
      {n.warnings && n.warnings.length > 0 && (
        <ul className="rationale__warnings">
          {n.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
