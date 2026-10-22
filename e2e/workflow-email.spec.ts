import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, navLink, signInAsAdmin, trackErrors, expectHome } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Fase 9 sul programma reale: email commerciali dalla barra laterale e dalle schede, modello ufficiale,
 * personalizzazione con il fornitore AI FINTO, revisione, invio confermato con il client SMTP reale verso un server
 * SMTP FINTO locale (nessuna email esce), registrazione nel CRM. Usa le aziende "di Prova" della scoperta e
 * l'opportunità aperta della Trattoria creata da workflow-crm.spec.ts.
 */

test.describe.configure({ mode: 'serial' });

const TRATTORIA = 'Trattoria di Prova Albano Laziale';
const FARMACIA = 'Farmacia di Prova Albano Laziale';
const ADDED = 'Restiamo a disposizione anche per una semplice chiacchierata.';

async function signIn(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
}

test('voce «Email commerciali» nella barra laterale: pagina dedicata, stato dell’invio, filtri', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await navLink(page, 'Email commerciali').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Email commerciali' })).toBeVisible();
  await expect(navLink(page, 'Email commerciali')).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByText('Da contattare, in attesa, follow-up e risposte: ogni messaggio parte solo con la tua conferma.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Nuova email' }).first()).toBeVisible();
  // invio configurato verso il server SMTP finto: mittente predefinito staff@noventra.it
  await expect(page.getByLabel('Configurazione dell’invio')).toContainText('Noventra <staff@noventra.it>');
  // tre viste: da contattare (predefinita), in attesa di risposta, storico dei messaggi
  const views = page.getByRole('navigation', { name: 'Viste delle email' });
  for (const label of ['Da contattare', 'In attesa', 'Storico'])
    await expect(views.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
  await views.getByRole('link', { name: /^Storico/ }).click();
  await expect(page).toHaveURL(/vista=storico/);
  const filters = page.getByRole('navigation', { name: 'Email per stato' });
  for (const label of [
    'Tutte',
    'Bozze',
    'Da revisionare',
    'Pronte per l’invio',
    'Inviate',
    'Invio non riuscito',
    'Archiviate',
  ])
    await expect(filters.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
  await expect(page.getByText('Ancora nessuna email')).toBeVisible();
  await expectAccessible(page, 'email commerciali');
  expect(errors).toEqual([]);
});

test('dall’opportunità: azienda preselezionata, personalizzazione AI con prove, revisione, invio confermato, CRM', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/pipeline/elenco?q=trattoria%20di%20prova%20albano');
  await page.getByRole('link', { name: TRATTORIA }).click();
  await expect(page.getByRole('heading', { level: 1, name: TRATTORIA })).toBeVisible();
  const stageBefore = await page.getByLabel('Fase della pipeline').inputValue();
  await page.getByRole('link', { name: 'Scrivi un’email' }).click();

  // azienda preselezionata, bozza dal modello standard
  await expect(page.getByText(TRATTORIA)).toBeVisible();
  await page.getByRole('button', { name: 'Crea la bozza dal modello standard' }).click();
  await expect(page.getByRole('heading', { level: 1, name: TRATTORIA })).toBeVisible();
  const form = page.getByRole('form', { name: 'Email' });
  await expect(form.getByLabel('Oggetto')).toHaveValue('Un sito web professionale per la tua attività | Noventra');
  await expect(form.getByLabel('Testo')).toHaveValue(/^Buongiorno,\n\nmi presento, sono un referente di Noventra/);
  await expect(form.getByLabel('Testo')).toHaveValue(/staff@noventra\.it\n081 091 0236$/);
  // la ricarica riapre la stessa bozza (nessun doppione)
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: TRATTORIA })).toBeVisible();

  // personalizzazione con AI: obiettivo, tono, istruzioni; il testo resta da revisionare
  const gen = page.getByRole('form', { name: 'Generazione' });
  await gen.getByLabel('Email personalizzata con AI').check();
  await expect(
    gen.getByRole('option', { name: /Follow-up su un contatto precedente \(non disponibile\)/ }),
  ).toBeDisabled();
  await gen.getByLabel('Obiettivo commerciale').selectOption({ label: 'Richiedere una call conoscitiva' });
  await gen.getByLabel('Tono').selectOption({ label: 'Cordiale e consulenziale' });
  await gen.getByLabel('Istruzioni (facoltative)').fill('proponi una call di 15 minuti');
  await gen.getByRole('button', { name: 'Genera con AI' }).click();
  await expect(page.getByText('Testo generato dall’AI: rileggilo con attenzione')).toBeVisible();
  await expect(form.getByLabel('Oggetto')).toHaveValue(/Noventra$/);
  await expect(form.getByLabel('Testo')).toHaveValue(
    /consulenza gratuita e senza impegno, con un preventivo chiaro entro 24 ore/,
  );
  await expect(page.getByRole('heading', { name: 'Prove usate dalla personalizzazione' })).toBeVisible();
  // le note interne non entrano nel testo
  await expect(form.getByLabel('Testo')).not.toHaveValue(/Referente e budget non noti/);

  // modifica non salvata + rigenerazione: serve la conferma, annullando il testo resta
  const body = form.getByLabel('Testo');
  const generated = await body.inputValue();
  await body.fill(generated.replace('Un cordiale saluto,', `${ADDED}\n\nUn cordiale saluto,`));
  await gen.getByRole('button', { name: 'Rigenera con AI' }).click();
  const regen = page.getByRole('dialog', { name: 'Sostituire il testo attuale?' });
  await expect(regen).toContainText('modifiche non salvate');
  await regen.getByRole('button', { name: 'Annulla' }).click();
  await expect(body).toHaveValue(new RegExp(ADDED));

  // destinatario (nessuna email pubblica nella fonte): inserito a mano, segnalato come non verificato
  await form.getByLabel('Destinatario').fill('info@trattoria-prova.example.it');
  await expect(form.getByRole('button', { name: 'Invia email' })).toBeDisabled();
  await form.getByRole('button', { name: 'Salva bozza' }).click();
  await expect(page.getByText('Bozza salvata.')).toBeVisible();
  await form.getByRole('button', { name: 'Segna come pronta' }).click();
  await expect(page.getByText('Email segnata come pronta per l’invio.')).toBeVisible();
  await expectAccessible(page, 'editor email');

  // conferma esplicita: annullare non invia
  await form.getByRole('button', { name: 'Invia email' }).click();
  const dialog = page.getByRole('dialog', { name: 'Inviare questa email?' });
  await expect(dialog).toContainText('info@trattoria-prova.example.it');
  await expect(dialog).toContainText(TRATTORIA);
  await expect(dialog).toContainText('Noventra <staff@noventra.it>');
  await expect(dialog).toContainText('Indirizzo inserito a mano: non verificato.');
  await expect(dialog.getByRole('button', { name: 'Invia ora' })).toBeDisabled();
  await expectAccessible(page, 'conferma di invio');
  await dialog.getByRole('button', { name: 'Annulla' }).click();
  await expect(page.getByRole('heading', { level: 1, name: TRATTORIA })).toBeVisible();
  await expect(page.getByText('Email inviata')).toHaveCount(0);

  await form.getByRole('button', { name: 'Invia email' }).click();
  await dialog.getByLabel('Ho riletto oggetto e testo e verificato il destinatario.').check();
  await dialog.getByLabel(/Il contatto è lecito e appropriato/).check();
  await dialog.getByRole('button', { name: 'Invia ora' }).click();
  await expect(page.getByText('Email accettata dal server di posta e registrata nel CRM.')).toBeVisible();
  await expect(page.getByText('Email inviata', { exact: true })).toBeVisible();
  await expect(page.getByText('L’accettazione non conferma la consegna')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Invia email' })).toHaveCount(0);

  // CRM: attività registrata, fase portata a «In attesa di risposta» (da «Da contattare»), storico sull'opportunità
  expect(stageBefore).toBe('da_contattare');
  await page.getByRole('link', { name: 'In attesa di risposta' }).click();
  await expect(page.getByRole('heading', { level: 1, name: TRATTORIA })).toBeVisible();
  await expect(page.getByLabel('Fase della pipeline')).toHaveValue('in_attesa');
  await expect(
    page.getByRole('list', { name: 'Attività' }).getByText(/Da contattare → In attesa di risposta/),
  ).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Attività' });
  await expect(timeline.getByText(/Email commerciale inviata a info@trattoria-prova\.example\.it/)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Email commerciali' }).getByText('Inviata', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('dalla scheda azienda: preselezione, invio rifiutato dal server con bozza intatta, archiviazione', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/aziende?q=farmacia%20di%20prova%20albano');
  await page.getByRole('link', { name: FARMACIA, exact: true }).click();
  await page.getByRole('region', { name: 'Email commerciali' }).getByRole('link', { name: 'Scrivi un’email' }).click();
  await expect(page.getByText(FARMACIA)).toBeVisible();
  await page.getByRole('button', { name: 'Crea la bozza dal modello standard' }).click();
  const form = page.getByRole('form', { name: 'Email' });
  // il server SMTP finto rifiuta i destinatari che contengono "rifiuta"
  await form.getByLabel('Destinatario').fill('rifiuta@farmacia-prova.example.it');
  await form.getByRole('button', { name: 'Salva bozza' }).click();
  await expect(page.getByText('Bozza salvata.')).toBeVisible();
  await form.getByRole('button', { name: 'Invia email' }).click();
  const dialog = page.getByRole('dialog', { name: 'Inviare questa email?' });
  await expect(dialog).toContainText('L’azienda non ha un’opportunità aperta');
  await dialog.getByLabel('Ho riletto oggetto e testo e verificato il destinatario.').check();
  await dialog.getByLabel(/Il contatto è lecito e appropriato/).check();
  await dialog.getByRole('button', { name: 'Invia ora' }).click();
  await expect(page.getByText('Invio non riuscito', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/rifiutato il destinatario/).first()).toBeVisible();
  await expect(form.getByLabel('Testo')).toHaveValue(/^Buongiorno,/);
  await expect(form.getByRole('button', { name: 'Invia email' })).toBeEnabled();

  // nessuna attività né opportunità creata da un invio non riuscito
  await page.getByRole('link', { name: FARMACIA }).first().click();
  await expect(page.getByRole('button', { name: 'Aggiungi al CRM' })).toBeVisible();
  const history = page.getByRole('region', { name: 'Email commerciali' });
  await expect(history.getByText('Invio non riuscito', { exact: true })).toBeVisible();
  await history.getByRole('link', { name: /Un sito web professionale/ }).click();

  await page.getByRole('button', { name: 'Archivia' }).click();
  await page.getByRole('dialog', { name: 'Archiviare l’email?' }).getByRole('button', { name: 'Archivia' }).click();
  await expect(page.getByText('Email archiviata')).toBeVisible();
  await page.goto('/email?status=archived');
  await expect(page.getByRole('link', { name: FARMACIA })).toBeVisible();
  await page.goto('/email?status=sent');
  await expect(page.getByRole('link', { name: TRATTORIA })).toBeVisible();
  await expect(page.getByRole('link', { name: FARMACIA })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('spazio di lavoro su telefono @mobile', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/email?status=sent');
  await page.getByRole('link', { name: TRATTORIA }).click();
  await expect(page.getByRole('heading', { level: 1, name: TRATTORIA })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(navLink(page, 'Email commerciali')).toBeVisible();
  await expectAccessible(page, 'email su telefono');
  expect(errors).toEqual([]);
});
