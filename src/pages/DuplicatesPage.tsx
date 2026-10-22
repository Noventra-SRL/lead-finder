import { Link, useSearchParams } from 'react-router';
import type { BusinessSummary, DuplicatePair, Paged } from '../api/client.ts';
import { DuplicateActions } from '../components/DuplicateActions.tsx';
import { Empty, ErrorNotice, Loading, PageHeader, Pagination } from '../components/ui.tsx';
import { placeLabel } from '../lib/discovery.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { navIndex } from '../navigation.ts';

function Card({ b, label }: { b: BusinessSummary; label: string }) {
  return (
    <div className="compare__side">
      <p className="eyebrow">{label}</p>
      <p>
        <Link to={`/aziende/${b.id}`} className="strong-link">
          {b.name}
        </Link>
      </p>
      <dl className="props props--compact">
        <div className="props__pair">
          <dt>Categoria</dt>
          <dd>{b.categoryLabel}</dd>
        </div>
        <div className="props__pair">
          <dt>Comune</dt>
          <dd>{placeLabel(b)}</dd>
        </div>
        <div className="props__pair">
          <dt>Sito</dt>
          <dd className="mono small">{b.website?.domain ?? '—'}</dd>
        </div>
        <div className="props__pair">
          <dt>Completezza</dt>
          <dd className="mono">{b.completeness}/5</dd>
        </div>
        <div className="props__pair">
          <dt>Acquisita</dt>
          <dd>{formatDateTime(b.firstSeenAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

export function DuplicatesPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const { data, error, loading, reload } = useApi<Paged<DuplicatePair>>(`/duplicates?page=${page}&pageSize=10`);

  return (
    <>
      <PageHeader
        index={navIndex('/aziende')}
        title="Possibili duplicati"
        lede="Coppie con lo stesso nome a breve distanza, o lo stesso sito nello stesso comune. Una persona decide se unirle: un nome simile non basta."
      />
      <nav className="tabs" aria-label="Viste del database">
        <Link to="/aziende" className="tabs__item">
          Aziende
        </Link>
        <Link to="/aziende/duplicati" aria-current="page" className="tabs__item">
          Possibili duplicati {data && <span className="mono muted">{data.total}</span>}
        </Link>
      </nav>
      {loading && !data && <Loading />}
      {error && <ErrorNotice error={error} onRetry={reload} />}
      {data && data.total === 0 && (
        <Empty title="Nessun possibile duplicato da verificare">
          Le nuove segnalazioni compaiono qui dopo ogni ricerca.
        </Empty>
      )}
      {data && data.total > 0 && (
        <>
          <ol className="plain-list compare-list">
            {data.items.map((p) => (
              <li key={p.id} className="compare">
                <p className="compare__reason">
                  {p.reason}
                  {p.distanceM !== null && <span className="mono muted"> · {p.distanceM} m</span>}
                </p>
                <div className="compare__grid">
                  <Card b={p.a} label="Prima" />
                  <Card b={p.b} label="Seconda" />
                </div>
                <DuplicateActions candidateId={p.id} a={p.a} b={p.b} onDone={reload} />
              </li>
            ))}
          </ol>
          <Pagination page={page} pageSize={10} total={data.total} onPage={(n) => setParams({ page: String(n) })} />
        </>
      )}
    </>
  );
}
