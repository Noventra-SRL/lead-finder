import { Link } from 'react-router';

/**
 * «Trova aziende» ha due modi di cercare, nella stessa voce del menu:
 *  - per obiettivo (Lead Hunter): quante aziende, dove, in quali settori; verifica dei siti e punteggio automatici;
 *  - manuale per zona e categoria (scoperta da OpenStreetMap): una ricerca puntuale su un comune, provincia o regione.
 */
export function FindTabs({ current }: { current: 'goal' | 'manual' }) {
  return (
    <nav className="tabs find-tabs" aria-label="Modi di cercare">
      <Link to="/lead-hunter" className="tabs__item" aria-current={current === 'goal' ? 'page' : undefined}>
        Ricerca per obiettivo
        <span className="find-tabs__hint">quante aziende, dove e in quali settori</span>
      </Link>
      <Link to="/scoperta" className="tabs__item" aria-current={current === 'manual' ? 'page' : undefined}>
        Ricerca manuale
        <span className="find-tabs__hint">una zona e una categoria</span>
      </Link>
    </nav>
  );
}
