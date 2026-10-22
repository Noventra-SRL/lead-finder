import { Link } from 'react-router';
import { PageHeader } from '../components/ui.tsx';

export function NotFoundPage() {
  return (
    <>
      <PageHeader
        index="404"
        title="Pagina non trovata"
        lede="L’indirizzo non corrisponde a nessuna sezione di Lead Finder."
      />
      <p>
        <Link to="/">Torna alla dashboard</Link>
      </p>
    </>
  );
}
