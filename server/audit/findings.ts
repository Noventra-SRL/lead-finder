/*
 * Catalogo dei rilievi dell'audit. Ogni rilievo ha un codice stabile (non cambia tra versioni: Fase 4 e 5 lo usano),
 * una categoria, una gravità, un titolo, una spiegazione di ciò che è stato OSSERVATO, un rimedio e, quando
 * giustificato, l'area di servizio Noventra pertinente. Il testo non promette effetti (nessun "perdi clienti",
 * nessuna "penalizzazione garantita"): descrive l'osservazione e il possibile intervento.
 *
 * observation: 'missing' (elemento assente nel codice esaminato), 'problem' (presente ma problematico),
 * 'not_inspected' (non è stato possibile verificarlo), 'info' (informazione utile, nessun problema).
 */

export type Severity = 'info' | 'low' | 'medium' | 'high';
export type FindingCategory = 'availability' | 'security' | 'seo' | 'mobile' | 'performance' | 'content' | 'industry';
export type Observation = 'missing' | 'problem' | 'not_inspected' | 'info';
export type Confidence = 'high' | 'medium' | 'low';

/** Aree di servizio di Noventra (da https://www.noventra.it/, verificate il 21/10/2026). Fase 5 le renderà configurabili. */
export const SERVICE_AREAS = {
  sviluppo_siti_web: 'Sviluppo Siti Web',
  web_design: 'Web Design & Brand Identity',
  seo: 'SEO Optimization',
  geo: 'GEO (visibilità nei motori di risposta AI)',
  ecommerce: 'E-commerce (Shopify, Magento)',
  gestionali_crm: 'Gestionali Web & CRM',
  hosting_assistenza: 'Server, Hosting & Assistenza',
  digital_marketing: 'Digital Marketing',
} as const;
export type ServiceArea = keyof typeof SERVICE_AREAS;

interface Definition {
  category: FindingCategory;
  severity: Severity;
  observation: Observation;
  title: string;
  explanation: string;
  remediation: string;
  actionable: boolean;
  service: ServiceArea | null;
}

const d = (x: Definition) => x;

export const FINDINGS = {
  /* ---------- disponibilità ---------- */
  AVAIL_UNREACHABLE: d({
    category: 'availability',
    severity: 'high',
    observation: 'problem',
    title: 'Sito non raggiungibile',
    explanation:
      'Il sito non ha risposto alle richieste (errore di DNS o di connessione) al momento della verifica, anche dopo un nuovo tentativo. Può essere un problema temporaneo.',
    remediation: 'Verificare dominio, DNS e hosting; ripetere l’audit più tardi prima di trarre conclusioni.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  AVAIL_TIMEOUT: d({
    category: 'availability',
    severity: 'high',
    observation: 'problem',
    title: 'Il sito non risponde in tempo',
    explanation: 'La pagina principale non è stata ricevuta entro il tempo massimo, anche dopo un nuovo tentativo.',
    remediation: 'Verificare le prestazioni del server e dell’hosting; ripetere l’audit in un altro momento.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  AVAIL_HTTP_ERROR: d({
    category: 'availability',
    severity: 'high',
    observation: 'problem',
    title: 'La pagina principale restituisce un errore',
    explanation: 'Il server ha risposto con un codice di errore HTTP alla richiesta della pagina principale.',
    remediation: 'Controllare la configurazione del server e del sito.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  AVAIL_BLOCKED: d({
    category: 'availability',
    severity: 'info',
    observation: 'not_inspected',
    title: 'Accesso limitato dal sito',
    explanation:
      'Il sito ha negato o limitato l’accesso automatico (es. 403, 429, protezione anti-bot o robots.txt). L’audit non aggira queste protezioni: alcuni controlli non sono stati eseguiti.',
    remediation: 'Nessuna azione: verificare il sito manualmente se necessario.',
    actionable: false,
    service: null,
  }),
  AVAIL_NOT_HTML: d({
    category: 'availability',
    severity: 'medium',
    observation: 'problem',
    title: 'La pagina principale non è HTML',
    explanation: 'L’indirizzo del sito restituisce un contenuto non HTML (ad esempio un file o un’immagine).',
    remediation: 'Verificare che l’indirizzo pubblicato porti a una pagina web.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  AVAIL_REDIRECT_CHAIN: d({
    category: 'availability',
    severity: 'low',
    observation: 'problem',
    title: 'Catena di redirect lunga',
    explanation: 'Per arrivare alla pagina finale servono più di due reindirizzamenti.',
    remediation: 'Ridurre i reindirizzamenti puntando direttamente all’indirizzo definitivo.',
    actionable: true,
    service: 'seo',
  }),
  AVAIL_REDIRECT_OTHER_DOMAIN: d({
    category: 'availability',
    severity: 'info',
    observation: 'info',
    title: 'L’indirizzo porta a un altro dominio',
    explanation:
      'Il sito indicato reindirizza a un dominio diverso (es. cambio di dominio o sito ospitato su una piattaforma).',
    remediation: 'Aggiornare l’indirizzo pubblicato nelle schede e nei profili, se necessario.',
    actionable: false,
    service: null,
  }),
  AVAIL_SLOW_RESPONSE: d({
    category: 'availability',
    severity: 'low',
    observation: 'problem',
    title: 'Risposta del server lenta',
    explanation:
      'Il primo byte della pagina principale è arrivato dopo oltre 1,5 secondi in questa misura singola (indicativa, non è un test di prestazioni).',
    remediation: 'Verificare hosting, cache e configurazione del server.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  /* ---------- sicurezza (indicatori pubblici, non un test di sicurezza) ---------- */
  SEC_NO_HTTPS: d({
    category: 'security',
    severity: 'high',
    observation: 'missing',
    title: 'HTTPS non disponibile',
    explanation:
      'Il sito non risponde in HTTPS: le pagine viaggiano non cifrate e i browser lo segnalano come «non sicuro».',
    remediation: 'Installare un certificato TLS (anche gratuito) e reindirizzare tutto il traffico a HTTPS.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  SEC_TLS_ERROR: d({
    category: 'security',
    severity: 'high',
    observation: 'problem',
    title: 'Certificato HTTPS non valido',
    explanation:
      'La connessione HTTPS non è verificabile (certificato scaduto, autofirmato o per un altro dominio): i browser mostrano un avviso di sicurezza.',
    remediation: 'Rinnovare o correggere il certificato TLS.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  SEC_CERT_EXPIRING: d({
    category: 'security',
    severity: 'medium',
    observation: 'problem',
    title: 'Certificato HTTPS in scadenza',
    explanation: 'Il certificato TLS scade entro 21 giorni.',
    remediation: 'Verificare il rinnovo automatico del certificato.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  SEC_HTTP_NOT_REDIRECTED: d({
    category: 'security',
    severity: 'medium',
    observation: 'problem',
    title: 'La versione HTTP non reindirizza a HTTPS',
    explanation: 'HTTPS funziona, ma l’indirizzo http:// mostra il sito senza reindirizzare alla versione sicura.',
    remediation: 'Aggiungere un reindirizzamento permanente (301) da HTTP a HTTPS.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  SEC_MIXED_CONTENT: d({
    category: 'security',
    severity: 'medium',
    observation: 'problem',
    title: 'Contenuti non sicuri in pagine HTTPS',
    explanation:
      'Pagine servite in HTTPS richiamano risorse in http:// (contenuto misto): i browser possono bloccarle o segnalarle.',
    remediation: 'Caricare tutte le risorse in HTTPS.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  SEC_INSECURE_FORM: d({
    category: 'security',
    severity: 'medium',
    observation: 'problem',
    title: 'Modulo che invia dati in chiaro',
    explanation: 'Un modulo invia i dati a un indirizzo http:// non cifrato.',
    remediation: 'Fare inviare i moduli solo a indirizzi HTTPS.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  SEC_HEADERS_MISSING: d({
    category: 'security',
    severity: 'info',
    observation: 'missing',
    title: 'Intestazioni di sicurezza assenti',
    explanation:
      'Alcune intestazioni HTTP di protezione comuni non sono presenti. La loro assenza da sola non dimostra una vulnerabilità.',
    remediation: 'Valutare l’aggiunta di HSTS, X-Content-Type-Options e protezione dall’inclusione in frame.',
    actionable: true,
    service: 'hosting_assistenza',
  }),
  /* ---------- SEO tecnica ---------- */
  SEO_MISSING_TITLE: d({
    category: 'seo',
    severity: 'high',
    observation: 'missing',
    title: 'Titolo della pagina assente',
    explanation: 'Nell’HTML della pagina non c’è un elemento <title> con un testo.',
    remediation: 'Aggiungere un titolo descrittivo e unico per ogni pagina.',
    actionable: true,
    service: 'seo',
  }),
  SEO_TITLE_LENGTH: d({
    category: 'seo',
    severity: 'low',
    observation: 'problem',
    title: 'Titolo troppo corto o troppo lungo',
    explanation:
      'Il titolo della pagina ha una lunghezza fuori dall’intervallo consigliato (circa 15–65 caratteri) e può essere poco descrittivo o troncato nei risultati di ricerca.',
    remediation: 'Scrivere un titolo che descriva l’attività e la località in modo conciso.',
    actionable: true,
    service: 'seo',
  }),
  SEO_MISSING_META_DESCRIPTION: d({
    category: 'seo',
    severity: 'medium',
    observation: 'missing',
    title: 'Meta description assente',
    explanation: 'Nell’HTML della pagina non è presente una meta description.',
    remediation:
      'Aggiungere una meta description concisa e pertinente, che può migliorare il modo in cui la pagina appare nei risultati di ricerca.',
    actionable: true,
    service: 'seo',
  }),
  SEO_META_DESCRIPTION_LENGTH: d({
    category: 'seo',
    severity: 'low',
    observation: 'problem',
    title: 'Meta description troppo corta o troppo lunga',
    explanation: 'La meta description ha una lunghezza fuori dall’intervallo consigliato (circa 50–170 caratteri).',
    remediation: 'Riscrivere la descrizione in modo completo ma conciso.',
    actionable: true,
    service: 'seo',
  }),
  SEO_MISSING_H1: d({
    category: 'seo',
    severity: 'medium',
    observation: 'missing',
    title: 'Nessun titolo principale (H1)',
    explanation: 'La pagina non contiene un’intestazione H1.',
    remediation: 'Aggiungere un’intestazione H1 che indichi il contenuto principale della pagina.',
    actionable: true,
    service: 'seo',
  }),
  SEO_MULTIPLE_H1: d({
    category: 'seo',
    severity: 'low',
    observation: 'problem',
    title: 'Più titoli principali (H1)',
    explanation: 'La pagina contiene più intestazioni H1: la struttura dei titoli è meno chiara.',
    remediation: 'Usare un solo H1 e organizzare il resto con H2 e H3.',
    actionable: true,
    service: 'seo',
  }),
  SEO_NOINDEX: d({
    category: 'seo',
    severity: 'high',
    observation: 'problem',
    title: 'La pagina chiede di non essere indicizzata',
    explanation:
      'Una direttiva «noindex» (meta robots o intestazione X-Robots-Tag) chiede ai motori di ricerca di non mostrare la pagina.',
    remediation: 'Rimuovere la direttiva se la pagina deve comparire nei risultati di ricerca.',
    actionable: true,
    service: 'seo',
  }),
  SEO_ROBOTS_DISALLOW_ALL: d({
    category: 'seo',
    severity: 'high',
    observation: 'problem',
    title: 'robots.txt blocca l’intero sito',
    explanation: 'Il file robots.txt vieta a tutti i crawler l’accesso all’intero sito.',
    remediation: 'Verificare se il blocco è voluto (spesso resta da un sito in costruzione).',
    actionable: true,
    service: 'seo',
  }),
  SEO_CANONICAL_MISSING: d({
    category: 'seo',
    severity: 'low',
    observation: 'missing',
    title: 'URL canonico non indicato',
    explanation: 'La pagina non indica un URL canonico (link rel="canonical").',
    remediation: 'Indicare l’URL canonico per evitare ambiguità tra versioni della stessa pagina.',
    actionable: true,
    service: 'seo',
  }),
  SEO_CANONICAL_OTHER_HOST: d({
    category: 'seo',
    severity: 'medium',
    observation: 'problem',
    title: 'URL canonico su un altro dominio',
    explanation: 'L’URL canonico indicato punta a un dominio diverso da quello del sito.',
    remediation: 'Verificare che il canonico punti all’indirizzo corretto del sito.',
    actionable: true,
    service: 'seo',
  }),
  SEO_MISSING_LANG: d({
    category: 'seo',
    severity: 'low',
    observation: 'missing',
    title: 'Lingua della pagina non dichiarata',
    explanation: 'L’elemento <html> non dichiara la lingua (attributo lang).',
    remediation: 'Aggiungere lang="it" (o la lingua corretta).',
    actionable: true,
    service: 'seo',
  }),
  SEO_IMAGES_MISSING_ALT: d({
    category: 'seo',
    severity: 'low',
    observation: 'missing',
    title: 'Immagini senza testo alternativo',
    explanation: 'Una parte delle immagini non ha l’attributo alt, utile per accessibilità e ricerca per immagini.',
    remediation: 'Aggiungere testi alternativi descrittivi alle immagini di contenuto.',
    actionable: true,
    service: 'seo',
  }),
  SEO_NO_SITEMAP: d({
    category: 'seo',
    severity: 'low',
    observation: 'missing',
    title: 'Sitemap non trovata',
    explanation: 'Nessuna sitemap XML indicata in robots.txt né presente all’indirizzo /sitemap.xml.',
    remediation: 'Generare una sitemap XML e indicarla in robots.txt.',
    actionable: true,
    service: 'seo',
  }),
  SEO_NO_STRUCTURED_DATA: d({
    category: 'seo',
    severity: 'low',
    observation: 'missing',
    title: 'Dati strutturati dell’attività assenti',
    explanation:
      'Non sono stati trovati dati strutturati (schema.org) che descrivano l’attività, come LocalBusiness o Organization.',
    remediation: 'Aggiungere dati strutturati con nome, indirizzo, orari e contatti dell’attività.',
    actionable: true,
    service: 'geo',
  }),
  SEO_INVALID_JSON_LD: d({
    category: 'seo',
    severity: 'low',
    observation: 'problem',
    title: 'Dati strutturati non leggibili',
    explanation: 'Un blocco JSON-LD non è JSON valido e non può essere letto.',
    remediation: 'Correggere la sintassi dei dati strutturati.',
    actionable: true,
    service: 'seo',
  }),
  SEO_NO_OPEN_GRAPH: d({
    category: 'seo',
    severity: 'info',
    observation: 'missing',
    title: 'Anteprima per i social non configurata',
    explanation: 'Mancano i metadati Open Graph (og:title, og:image…) usati per le anteprime dei link condivisi.',
    remediation: 'Aggiungere i metadati Open Graph principali.',
    actionable: true,
    service: 'digital_marketing',
  }),
  SEO_BROKEN_INTERNAL_LINKS: d({
    category: 'seo',
    severity: 'medium',
    observation: 'problem',
    title: 'Link interni non funzionanti',
    explanation: 'Tra le pagine esaminate, alcune collegate dal sito rispondono con un errore.',
    remediation: 'Correggere o rimuovere i link verso pagine inesistenti.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  SEO_THIN_CONTENT: d({
    category: 'seo',
    severity: 'low',
    observation: 'problem',
    title: 'Poco testo nella pagina principale',
    explanation:
      'Il codice della pagina principale contiene poco testo leggibile. Se il sito genera i contenuti con JavaScript, questa misura può sottostimarli.',
    remediation: 'Descrivere attività, servizi e località con testi propri.',
    actionable: true,
    service: 'seo',
  }),
  /* ---------- mobile (indicatori statici) ---------- */
  MOBILE_NO_VIEWPORT: d({
    category: 'mobile',
    severity: 'high',
    observation: 'missing',
    title: 'Pagina non configurata per i dispositivi mobili',
    explanation:
      'Manca il meta tag viewport: sugli smartphone la pagina viene di norma mostrata rimpicciolita come su un computer. Indicatore statico, non un test visivo.',
    remediation:
      'Rendere il sito responsive e aggiungere <meta name="viewport" content="width=device-width, initial-scale=1">.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  MOBILE_VIEWPORT_FIXED: d({
    category: 'mobile',
    severity: 'medium',
    observation: 'problem',
    title: 'Viewport a larghezza fissa',
    explanation:
      'Il viewport fissa una larghezza in pixel, oppure non indica né width=device-width né initial-scale: il layout non si adatta alla larghezza dello schermo. Indicatore statico.',
    remediation: 'Usare width=device-width e un layout responsive.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  MOBILE_ZOOM_DISABLED: d({
    category: 'mobile',
    severity: 'low',
    observation: 'problem',
    title: 'Zoom disattivato sui dispositivi mobili',
    explanation:
      'Il viewport impedisce lo zoom (user-scalable=no o maximum-scale=1), limitando la leggibilità per chi ne ha bisogno.',
    remediation: 'Consentire lo zoom.',
    actionable: true,
    service: 'web_design',
  }),
  MOBILE_FIXED_WIDTH: d({
    category: 'mobile',
    severity: 'low',
    observation: 'problem',
    title: 'Elementi a larghezza fissa',
    explanation:
      'Nel codice esaminato ci sono elementi con larghezza fissa di 900 px o più, che sui telefoni possono richiedere lo scorrimento orizzontale. Indicatore statico: i fogli di stile esterni non sono stati analizzati.',
    remediation: 'Usare larghezze relative e layout responsive.',
    actionable: true,
    service: 'web_design',
  }),
  MOBILE_LEGACY_LAYOUT: d({
    category: 'mobile',
    severity: 'medium',
    observation: 'problem',
    title: 'Tecniche di impaginazione superate',
    explanation:
      'Il codice usa frame, Flash, tabelle per l’impaginazione o tag di formattazione obsoleti: tecniche non adatte ai dispositivi mobili e ai browser attuali.',
    remediation: 'Valutare il rifacimento del sito con tecnologie attuali.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  MOBILE_IMAGES_NO_DIMENSIONS: d({
    category: 'mobile',
    severity: 'info',
    observation: 'problem',
    title: 'Immagini senza dimensioni dichiarate',
    explanation: 'Molte immagini non dichiarano larghezza e altezza: durante il caricamento la pagina può spostarsi.',
    remediation: 'Indicare width e height (o le proporzioni) delle immagini.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  /* ---------- prestazioni (fornitore opzionale) ---------- */
  PERF_LOW_SCORE: d({
    category: 'performance',
    severity: 'medium',
    observation: 'problem',
    title: 'Punteggio prestazioni basso',
    explanation: 'Il punteggio di prestazioni di laboratorio (Lighthouse, tramite PageSpeed Insights) è basso.',
    remediation: 'Ottimizzare immagini, script e caricamento della pagina.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  PERF_LCP_SLOW: d({
    category: 'performance',
    severity: 'medium',
    observation: 'problem',
    title: 'Contenuto principale lento a comparire (LCP)',
    explanation: 'Il Largest Contentful Paint supera le soglie consigliate (2,5 s buono, oltre 4 s scarso).',
    remediation: 'Ottimizzare l’elemento principale della pagina (immagine o testo) e i tempi del server.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  PERF_CLS_HIGH: d({
    category: 'performance',
    severity: 'medium',
    observation: 'problem',
    title: 'La pagina si sposta durante il caricamento (CLS)',
    explanation: 'Il Cumulative Layout Shift supera le soglie consigliate (0,1 buono, oltre 0,25 scarso).',
    remediation: 'Riservare lo spazio a immagini, annunci e contenuti caricati dopo.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  PERF_INP_SLOW: d({
    category: 'performance',
    severity: 'medium',
    observation: 'problem',
    title: 'Risposta lenta alle interazioni (INP)',
    explanation:
      'Dai dati reali degli utenti (CrUX), l’Interaction to Next Paint supera le soglie consigliate (200 ms buono, oltre 500 ms scarso).',
    remediation: 'Ridurre il lavoro JavaScript che blocca la pagina.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  /* ---------- contenuti e prontezza commerciale ---------- */
  CONTENT_NO_CONTACT: d({
    category: 'content',
    severity: 'medium',
    observation: 'missing',
    title: 'Contatti non rilevati',
    explanation:
      'Nelle pagine esaminate non sono stati trovati link telefonici o email, moduli di contatto né una pagina contatti.',
    remediation: 'Rendere evidenti telefono, email e/o un modulo di contatto.',
    actionable: true,
    service: 'web_design',
  }),
  CONTENT_NO_ADDRESS: d({
    category: 'content',
    severity: 'low',
    observation: 'missing',
    title: 'Indirizzo non rilevato',
    explanation: 'Nelle pagine esaminate non è stato riconosciuto un indirizzo della sede.',
    remediation: 'Indicare indirizzo e indicazioni per raggiungere la sede.',
    actionable: true,
    service: 'web_design',
  }),
  CONTENT_NO_CTA: d({
    category: 'content',
    severity: 'low',
    observation: 'missing',
    title: 'Inviti all’azione non rilevati',
    explanation: 'Non sono stati rilevati inviti all’azione evidenti (contattaci, prenota, richiedi un preventivo…).',
    remediation: 'Aggiungere inviti all’azione chiari nelle pagine principali.',
    actionable: true,
    service: 'web_design',
  }),
  CONTENT_NO_SERVICES: d({
    category: 'content',
    severity: 'low',
    observation: 'missing',
    title: 'Servizi o prodotti non presentati',
    explanation: 'Non è stata rilevata una sezione dedicata a servizi o prodotti.',
    remediation: 'Descrivere servizi e prodotti in pagine dedicate.',
    actionable: true,
    service: 'web_design',
  }),
  CONTENT_NO_PRIVACY_LINK: d({
    category: 'content',
    severity: 'low',
    observation: 'missing',
    title: 'Link all’informativa privacy non rilevato',
    explanation:
      'Nelle pagine esaminate non è stato trovato un link all’informativa privacy. Non è una valutazione di conformità: l’informativa può esistere altrove.',
    remediation: 'Rendere raggiungibile l’informativa privacy da ogni pagina (es. nel piè di pagina).',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  CONTENT_NO_COOKIE_INDICATOR: d({
    category: 'content',
    severity: 'info',
    observation: 'missing',
    title: 'Informativa o banner cookie non rilevati',
    explanation:
      'Non sono stati rilevati un link alla cookie policy né strumenti di gestione del consenso noti. Non è una valutazione di conformità: un banner può essere caricato in modi non rilevabili.',
    remediation: 'Verificare manualmente la gestione dei cookie e del consenso.',
    actionable: true,
    service: 'sviluppo_siti_web',
  }),
  CONTENT_NO_SOCIAL: d({
    category: 'content',
    severity: 'info',
    observation: 'missing',
    title: 'Nessun collegamento ai social',
    explanation: 'Nelle pagine esaminate non ci sono link a profili social.',
    remediation: 'Collegare i profili social attivi, se presenti.',
    actionable: true,
    service: 'digital_marketing',
  }),
  CONTENT_JS_RENDERED: d({
    category: 'content',
    severity: 'info',
    observation: 'not_inspected',
    title: 'Contenuti generati da JavaScript',
    explanation:
      'La pagina contiene pochissimo testo nell’HTML e molti script: i contenuti sono probabilmente creati dal JavaScript, che l’audit non esegue. Alcuni rilievi sui contenuti potrebbero non essere affidabili.',
    remediation: 'Nessuna azione: verificare manualmente i contenuti.',
    actionable: false,
    service: null,
  }),
  CONTENT_PLATFORM: d({
    category: 'content',
    severity: 'info',
    observation: 'info',
    title: 'Piattaforma del sito riconosciuta',
    explanation: 'Il codice contiene indizi di una piattaforma o di un CMS noto.',
    remediation: 'Informazione utile per valutare interventi e manutenzione.',
    actionable: false,
    service: null,
  }),
  CONTENT_TOOLS: d({
    category: 'content',
    severity: 'info',
    observation: 'info',
    title: 'Strumenti di marketing riconosciuti',
    explanation:
      'Il codice delle pagine carica strumenti di terze parti riconoscibili (statistiche, pixel pubblicitari, email marketing, chat, prenotazioni o pagamenti).',
    remediation: 'Informazione utile per capire come l’azienda misura e promuove il sito.',
    actionable: false,
    service: null,
  }),
  CONTENT_AGENCY: d({
    category: 'content',
    severity: 'info',
    observation: 'info',
    title: 'Agenzia citata nei crediti del sito',
    explanation:
      'Il fondo pagina cita esplicitamente chi ha realizzato il sito («realizzato da», «powered by»). L’azienda potrebbe avere già un fornitore.',
    remediation: 'Da considerare prima del contatto: non citare il fornitore attuale nelle email.',
    actionable: false,
    service: null,
  }),
  CONTENT_HIRING: d({
    category: 'content',
    severity: 'info',
    observation: 'info',
    title: 'L’azienda cerca personale',
    explanation:
      'Le pagine esaminate contengono una sezione o un link «lavora con noi» o simili: l’azienda è in crescita.',
    remediation: 'Informazione utile per il contatto: un’azienda che assume è spesso disposta a investire.',
    actionable: false,
    service: null,
  }),
  /* ---------- indicatori di settore (opportunità, non requisiti) ---------- */
  IND_NO_OPENING_HOURS: d({
    category: 'industry',
    severity: 'low',
    observation: 'missing',
    title: 'Orari di apertura non rilevati',
    explanation:
      'Per questo tipo di attività gli orari sono un’informazione cercata spesso; non sono stati rilevati nelle pagine esaminate.',
    remediation: 'Pubblicare gli orari aggiornati, anche come dati strutturati.',
    actionable: true,
    service: 'web_design',
  }),
  IND_NO_ONLINE_BOOKING: d({
    category: 'industry',
    severity: 'low',
    observation: 'missing',
    title: 'Prenotazione online non rilevata',
    explanation: 'Non sono stati rilevati strumenti di prenotazione o richiesta online nelle pagine esaminate.',
    remediation: 'Valutare un sistema di prenotazione o richiesta online.',
    actionable: true,
    service: 'gestionali_crm',
  }),
  IND_HOTEL_NO_DIRECT_BOOKING: d({
    category: 'industry',
    severity: 'medium',
    observation: 'missing',
    title: 'Prenotazione diretta non rilevata',
    explanation:
      'Non è stato rilevato un motore di prenotazione diretta; se presenti, i link portano a portali di terzi.',
    remediation: 'Valutare un motore di prenotazione diretta integrato nel sito.',
    actionable: true,
    service: 'gestionali_crm',
  }),
  IND_HOTEL_NO_ROOMS: d({
    category: 'industry',
    severity: 'low',
    observation: 'missing',
    title: 'Informazioni sulle camere non rilevate',
    explanation: 'Non è stata rilevata una sezione dedicata a camere o alloggi.',
    remediation: 'Presentare camere e servizi con testi e foto.',
    actionable: true,
    service: 'web_design',
  }),
  IND_RESTAURANT_NO_MENU: d({
    category: 'industry',
    severity: 'medium',
    observation: 'missing',
    title: 'Menù non rilevato',
    explanation: 'Non è stato rilevato un menù consultabile nelle pagine esaminate.',
    remediation: 'Pubblicare il menù come pagina web (non solo immagine o PDF).',
    actionable: true,
    service: 'web_design',
  }),
  IND_RESTAURANT_NO_RESERVATION: d({
    category: 'industry',
    severity: 'low',
    observation: 'missing',
    title: 'Prenotazione o ordinazione online non rilevate',
    explanation: 'Non sono stati rilevati strumenti per prenotare un tavolo o ordinare online.',
    remediation: 'Valutare prenotazione online o ordinazione per asporto/consegna.',
    actionable: true,
    service: 'gestionali_crm',
  }),
  IND_NO_CATALOG: d({
    category: 'industry',
    severity: 'low',
    observation: 'missing',
    title: 'Catalogo prodotti non rilevato',
    explanation: 'Non sono stati rilevati un catalogo o una sezione prodotti.',
    remediation: 'Valutare un catalogo online dei prodotti principali.',
    actionable: true,
    service: 'ecommerce',
  }),
  IND_NO_ECOMMERCE: d({
    category: 'industry',
    severity: 'low',
    observation: 'missing',
    title: 'Vendita online non rilevata',
    explanation: 'Non sono stati rilevati carrello, checkout o una piattaforma di e-commerce.',
    remediation: 'Valutare un negozio online integrato.',
    actionable: true,
    service: 'ecommerce',
  }),
  IND_NO_APPOINTMENT: d({
    category: 'industry',
    severity: 'low',
    observation: 'missing',
    title: 'Richiesta di appuntamento non rilevata',
    explanation: 'Non sono stati rilevati strumenti per richiedere un appuntamento né un modulo di contatto.',
    remediation: 'Valutare un modulo di richiesta o un calendario di prenotazione.',
    actionable: true,
    service: 'gestionali_crm',
  }),
  IND_GYM_NO_SCHEDULE: d({
    category: 'industry',
    severity: 'low',
    observation: 'missing',
    title: 'Corsi o orari non rilevati',
    explanation: 'Non sono stati rilevati corsi, calendario delle lezioni o abbonamenti.',
    remediation: 'Pubblicare corsi, orari e abbonamenti, eventualmente con iscrizione online.',
    actionable: true,
    service: 'web_design',
  }),
} satisfies Record<string, Definition>;

export type FindingCode = keyof typeof FINDINGS;

export interface Finding {
  code: FindingCode;
  category: FindingCategory;
  severity: Severity;
  observation: Observation;
  title: string;
  explanation: string;
  /** Valori misurati o trovati (oggettivi). */
  evidence: Record<string, unknown>;
  /** Pagina a cui si riferisce ('' per il sito nel complesso). */
  page: string;
  confidence: Confidence;
  actionable: boolean;
  remediation: string;
  service: ServiceArea | null;
}

export function finding(
  code: FindingCode,
  evidence: Record<string, unknown>,
  opts: { page?: string; confidence?: Confidence; severity?: Severity } = {},
): Finding {
  const def = FINDINGS[code];
  return {
    code,
    category: def.category,
    severity: opts.severity ?? def.severity,
    observation: def.observation,
    title: def.title,
    explanation: def.explanation,
    evidence,
    page: opts.page ?? '',
    confidence: opts.confidence ?? 'high',
    actionable: def.actionable,
    remediation: def.remediation,
    service: def.service,
  };
}

/** Un solo rilievo per codice e pagina (il primo vince). */
export function dedupeFindings(list: Finding[]): Finding[] {
  const seen = new Set<string>();
  return list.filter((f) => {
    const key = `${f.code}|${f.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
