import { Link } from 'react-router';
import { PageHeader, Section, Status } from '../components/ui.tsx';
import { navIndex, type NavItem } from '../navigation.ts';

/*
 * Pagina di un modulo non ancora operativo. Dichiara cosa farà e da quale fase sarà disponibile:
 * nessun dato dimostrativo, nessun controllo che non funziona.
 */
export function ModulePage({ item }: { item: NavItem }) {
  return (
    <>
      <PageHeader index={navIndex(item.path)} title={item.label} lede={item.lede} />
      <Section title="Stato del modulo" description="Lo sviluppo procede per fasi verificate una alla volta.">
        <dl className="props">
          <dt>Disponibilità</dt>
          <dd>
            <Status tone="idle">Non ancora attivo</Status>
          </dd>
          <dt>Fase di sviluppo</dt>
          <dd className="mono">Fase {item.phase} (prevista)</dd>
          <dt>Dati</dt>
          <dd>Nessun dato viene mostrato finché il modulo non legge informazioni reali dal database.</dd>
        </dl>
        <p className="small muted after">
          Lo stato complessivo del sistema è sulla <Link to="/">dashboard</Link>.
        </p>
      </Section>
    </>
  );
}
