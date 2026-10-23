import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { BusinessCategoriesResponse, BusinessCategoryId } from '../api/client.ts';

/*
 * Categorie di «Trova aziende»: un elenco compatto con il numero reale di aziende accanto a ogni categoria, calcolato
 * dal server con i filtri attivi. Ogni voce è un link alla stessa pagina con la categoria nell'indirizzo: si cambia
 * categoria senza lasciare la pagina, e il link si può condividere o riaprire. Su telefono l'elenco diventa una
 * striscia scorrevole.
 */

const fmt = (n: number) => n.toLocaleString('it-IT');

export function CategoryNav({
  data,
  current,
  hrefFor,
}: {
  data: BusinessCategoriesResponse | null;
  current: BusinessCategoryId | null;
  hrefFor: (id: BusinessCategoryId | null) => string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const items: { id: BusinessCategoryId | null; label: string; count: number | null }[] = [
    { id: null, label: 'Tutte le aziende', count: data ? data.all.total : null },
    ...(data?.categories.map((c) => ({ id: c.id, label: c.label, count: c.counts.total })) ?? []),
  ];
  const loaded = Boolean(data);
  // striscia scorrevole (telefono): la categoria scelta resta visibile, senza spostare la pagina in verticale
  useEffect(() => {
    const ul = list.current;
    const active = ul?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!ul || !active || ul.scrollWidth <= ul.clientWidth) return;
    ul.scrollLeft = Math.max(0, active.offsetLeft - ul.offsetLeft - 16);
  }, [current, loaded]);
  return (
    <nav className="catnav" aria-label="Categorie">
      <p className="catnav__title">Categorie</p>
      <ul className="catnav__list" ref={list}>
        {items.map((it) => (
          <li key={it.id ?? 'tutte'}>
            <Link
              to={hrefFor(it.id)}
              className={`catnav__item${it.count === 0 ? ' catnav__item--empty' : ''}`}
              aria-current={it.id === current ? 'page' : undefined}
            >
              <span className="catnav__label">{it.label}</span>
              {it.count !== null && (
                <span className="catnav__count mono">
                  <span className="visually-hidden"> (</span>
                  {fmt(it.count)}
                  <span className="visually-hidden">)</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {data && data.pending > 0 && (
        <p className="small muted catnav__note">
          {fmt(data.pending)} {data.pending === 1 ? 'azienda' : 'aziende'} in classificazione: compaiono in «Tutte le
          aziende».
        </p>
      )}
    </nav>
  );
}
