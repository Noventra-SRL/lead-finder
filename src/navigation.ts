/*
 * Sezioni dell'applicazione. Il menu mostra solo quattro voci (Dashboard, Trova aziende, Email commerciali,
 * Impostazioni): il lavoro quotidiano è trovare un'azienda e scriverle. Le altre sezioni restano tutte disponibili
 * (stesse pagine, stessi indirizzi, stessi dati) come viste di dettaglio o avanzate, raggiungibili dalle schede e dagli
 * strumenti avanzati delle Impostazioni; nel menu resta evidenziata la voce a cui appartengono.
 * `phase` indica in quale fase di sviluppo il modulo diventa operativo.
 */

export interface NavItem {
  path: string;
  /** Nome della sezione (nel menu, se visibile). */
  label: string;
  /** Titolo della pagina, se diverso dal nome. */
  title?: string;
  /** Spiegazione breve (suggerimento al passaggio del mouse; descrizione negli strumenti avanzati). */
  hint: string;
  /** Descrizione mostrata in testa alla pagina. */
  lede: string;
  /** Fase in cui il modulo diventa operativo. */
  phase: number;
  /** Voce del menu, oppure sezione raggiungibile dalle pagine (vista avanzata o di dettaglio). */
  inNav: boolean;
  /** Per le sezioni fuori dal menu: la voce del menu che resta evidenziata. */
  parent?: string;
  /** Altri indirizzi che appartengono a questa voce del menu. */
  also?: string[];
}

export const ACTIVE_PHASE = 9;

export const NAV_ITEMS: NavItem[] = [
  {
    path: '/',
    label: 'Dashboard',
    hint: 'Aziende trovate, pronte da contattare, email inviate, risposte attese',
    lede: 'Aziende trovate, pronte da contattare, email inviate e risposte attese. Ogni numero viene dal database.',
    phase: 1,
    inNav: true,
  },
  {
    path: '/trova',
    label: 'Trova aziende',
    hint: 'Cerca le aziende, guarda il punteggio e scrivi alle più promettenti',
    lede: 'Le aziende da contattare, con punteggio commerciale, recapiti e stato del contatto. Un clic su «Invia email» prepara il messaggio.',
    phase: 6,
    inNav: true,
  },
  {
    path: '/email',
    label: 'Email commerciali',
    hint: 'Chi contattare, chi aspetta una risposta, storico dei messaggi',
    lede: 'Crea, personalizza e gestisci le email commerciali per i potenziali clienti di Noventra.',
    phase: 9,
    inNav: true,
  },
  {
    path: '/impostazioni',
    label: 'Impostazioni',
    hint: 'Account, utenti, sistema e strumenti avanzati',
    lede: 'Account, password, sessioni attive, utenti del team, stato del sistema e strumenti avanzati.',
    phase: 1,
    inNav: true,
  },
  // ---- sezioni raggiungibili dalle pagine (non nel menu)
  {
    path: '/lead-hunter',
    label: 'Nuova ricerca di aziende',
    hint: 'Ricerca per obiettivo o manuale per zona e categoria',
    lede: 'Cerca nuove aziende italiane: per obiettivo (quante aziende, dove, in quali settori, con verifica dei siti e punteggio automatici) oppure con una ricerca manuale per zona e categoria.',
    phase: 6,
    inNav: false,
    parent: '/trova',
    also: ['/scoperta'],
  },
  {
    path: '/aziende',
    label: 'Database aziende',
    hint: 'Tutte le aziende con tutti i filtri, selezione multipla ed esportazioni',
    lede: 'Le aziende raccolte dalle ricerche, con fonte, punteggio commerciale, sito, servizi consigliati e stato nelle trattative. Le corrispondenze incerte restano separate finché una persona non decide.',
    phase: 2,
    inNav: false,
    parent: '/trova',
  },
  {
    path: '/pipeline',
    label: 'Trattative',
    hint: 'Opportunità, fasi, attività e follow-up (CRM)',
    lede: 'Le trattative con i potenziali clienti, dalla qualificazione alla chiusura: fasi, attività, follow-up e prossime azioni. Nessun contatto parte in automatico: ogni passo lo decide una persona.',
    phase: 7,
    inNav: false,
    parent: '/email',
  },
  {
    path: '/audit',
    label: 'Analisi dei siti web',
    hint: 'Controllo tecnico dei siti delle aziende',
    lede: 'Analisi controllata e non invasiva dei siti pubblici: disponibilità, HTTPS, SEO tecnica, struttura, prestazioni. Ogni rilievo con evidenza, gravità e affidabilità.',
    phase: 3,
    inNav: false,
    parent: '/impostazioni',
  },
  {
    path: '/analisi-ai',
    label: 'Valutazione dei potenziali clienti',
    hint: 'Valutazione commerciale con AI: stato, coda, formula e penalità',
    lede: 'Valutazione commerciale delle aziende con un modello AI: quanto è realistico acquisirle come clienti, con prove verificabili, penalità esplicite e affidabilità separata. Il punteggio finale lo calcola il server; non è una probabilità di vendita.',
    phase: 7,
    inNav: false,
    parent: '/impostazioni',
  },
  {
    path: '/servizi',
    label: 'Servizi Noventra',
    hint: 'Il catalogo dei servizi usato per abbinamenti e personalizzazione',
    lede: 'I servizi di Noventra con indicatori di opportunità, settori di riferimento, regole di esclusione ed evidenze richieste, modificabili senza toccare il codice.',
    phase: 5,
    inNav: false,
    parent: '/impostazioni',
  },
  {
    path: '/report',
    label: 'Risultati e report',
    hint: 'Report completi ed esportazioni',
    lede: 'Ricerca di clienti e trattative nel periodo scelto: aziende censite e valutate, opportunità create, vinte e perse, tasso di vittoria, valori e follow-up. Solo conteggi dal database, con le definizioni accanto a ogni numero.',
    phase: 8,
    inNav: false,
    parent: '/',
  },
];

export const MENU_ITEMS = NAV_ITEMS.filter((i) => i.inNav);

/** Numero della voce nel menu (vuoto per le sezioni fuori dal menu). */
export const navIndex = (path: string) => {
  const i = MENU_ITEMS.findIndex((m) => m.path === path);
  return i < 0 ? '' : String(i + 1).padStart(2, '0');
};

/** Titolo della pagina di una sezione. */
export const pageTitle = (item: NavItem) => item.title ?? item.label;

/** La voce del menu è quella della pagina aperta (anche per sottopagine e sezioni che le appartengono). */
export function isActive(item: NavItem, pathname: string): boolean {
  const within = (p: string) => (p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(`${p}/`));
  if (within(item.path)) return true;
  if ((item.also ?? []).some(within)) return true;
  // sezioni fuori dal menu che appartengono a questa voce
  return (
    NAV_ITEMS.some(
      (s) => !s.inNav && s.parent === item.path && [s.path, ...(s.also ?? [])].some((p) => p !== '/' && within(p)),
    ) ||
    (item.path === '/email' && within('/promemoria'))
  );
}
