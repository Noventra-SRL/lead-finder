import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, expectHome, navLink, signInAsAdmin, trackErrors } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Invio rapido sul programma reale: da «Trova aziende» un clic su «Invia email» apre il messaggio già pronto
 * (modello ufficiale, personalizzato dal fornitore AI FINTO), «Conferma e invia» lo invia con il client SMTP reale
 * verso il server SMTP FINTO locale (nessuna email esce). Dopo l'accettazione l'azienda passa «In attesa di risposta»,
 * con attività nel CRM e data dell'ultimo contatto. Gira dopo workflow-lead-hunter.spec.ts, che trova lo studio
 * dentistico di prova con l'email generica info@dentista-prova.example.it.
 */

test.describe.configure({ mode: 'serial' });

const DENTIST = /^Studio Dentistico di Prova/;
const EMAIL = 'info@dentista-prova.example.it';
const ADDED = 'Possiamo sentirci anche solo per un primo confronto.';
let name = '';
let before = { emailsSent: 0, awaitingReply: 0 };

async function signIn(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
}

const row = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('link', { name: DENTIST }) });

test('da «Trova aziende»: messaggio pronto, rifiuto del server con messaggio intatto, invio accettato in due clic', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page);
  await navLink(page, 'Trova aziende').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trova aziende' })).toBeVisible();
  await page.getByLabel('Cerca per nome dell’azienda').fill('Studio Dentistico di Prova');
  await page.getByRole('button', { name: 'Cerca', exact: true }).click();
  const r = row(page).first();
  await expect(r).toContainText(EMAIL);
  await expect(r).toContainText('Da contattare');
  name = (await r.getByRole('link', { name: DENTIST }).first().textContent())!;
  await expectAccessible(page, 'trova aziende');
  before = (await (await page.request.get('/api/home')).json()).sales;

  // clic 1: il composer si apre con destinatario, oggetto e testo già pronti; nessuna email parte aprendolo
  await r.getByRole('button', { name: `Invia email a ${name}` }).click();
  const dialog = page.getByRole('dialog', { name: `Email a ${name}` });
  await expect(dialog.getByLabel('Destinatario')).toHaveValue(EMAIL);
  await expect(dialog.getByText('Email pubblica indicata dalla fonte (OpenStreetMap): non verificata.')).toBeVisible();
  await expect(dialog.getByLabel('Oggetto')).not.toHaveValue('');
  await expect(dialog.getByLabel('Testo')).toContainText('Noventra');
  const send = dialog.getByRole('button', { name: 'Conferma e invia' });
  await expect(send).toBeEnabled();
  await expect(dialog.getByText(/conferma che hai riletto il messaggio e che il contatto è lecito/)).toBeVisible();
  // nota interna accanto al testo (mai nell'email): sintesi, servizio principale, qualità delle prove
  const why = dialog.getByRole('region', { name: 'Perché questa email' });
  await expect(why).toContainText('nota interna, non inviata');
  await expect(why).toContainText('Servizio principale');
  await expect(why).toContainText('Qualità delle prove');
  await expect(dialog.getByLabel('Testo')).not.toHaveValue(/Perché questa email|Qualità delle prove/);
  await expectAccessible(page, 'composer');

  // rigenerazione su richiesta: nuova versione, nessun invio
  await dialog.getByRole('button', { name: 'Rigenera' }).click();
  await expect(dialog.getByText(/Nuova versione personalizzata: rileggila prima di inviare/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copia', exact: true })).toBeEnabled();

  // modifica facoltativa del testo, salvata come bozza; un destinatario rifiutato dal server: il messaggio resta
  // com'è, si può riprovare
  const body = dialog.getByLabel('Testo');
  const saveDraft = dialog.getByRole('button', { name: 'Salva bozza' });
  await expect(saveDraft).toBeDisabled();
  await body.fill(`${await body.inputValue()}\n\n${ADDED}`);
  await saveDraft.click();
  await expect(dialog.getByText('Bozza salvata. Nessuna email è stata inviata.')).toBeVisible();
  await dialog.getByLabel('Destinatario').fill('rifiuta@dentista-prova.example.it');
  await send.click();
  await expect(dialog.getByText(/Il messaggio è salvato: puoi correggerlo e riprovare\./)).toBeVisible();
  await expect(body).toHaveValue(new RegExp(ADDED.replace('.', '\\.')));
  await expect(dialog.getByRole('status')).toHaveCount(0);

  // indirizzo corretto, clic 2: accettato dal server di posta (la consegna non è confermata)
  await dialog.getByLabel('Destinatario').fill(EMAIL);
  await send.click();
  await expect(dialog.getByText('Email accettata dal server di posta')).toBeVisible();
  await expect(dialog.getByText(/L’accettazione non conferma la consegna/)).toBeVisible();
  await expect(send).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Chiudi' }).click();

  // la riga si aggiorna: in attesa di risposta, con la data dell'ultimo contatto
  await expect(r).toContainText('In attesa di risposta');
  await expect(r).toContainText(/ultimo \d/);
  expect(errors).toEqual([]);
});

test('dopo l’invio: «In attesa», attività nel CRM, trattativa avanzata, un solo messaggio inviato', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page);
  await navLink(page, 'Email commerciali').click();
  const views = page.getByRole('navigation', { name: 'Viste delle email' });
  // non è più tra le aziende da contattare (vista predefinita)
  await expect(page.getByRole('table', { name: /da contattare/i })).toBeVisible();
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);

  // storico: un solo messaggio inviato a questa azienda (il rifiuto non ha creato doppioni)
  const api = await (await page.request.get(`/api/emails?status=sent&q=${encodeURIComponent(name)}`)).json();
  expect(api.items.filter((e: { recipient: string }) => e.recipient === EMAIL)).toHaveLength(1);

  await views.getByRole('link', { name: /^In attesa/ }).click();
  await expect(page).toHaveURL(/vista=in-attesa/);
  const waiting = page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(waiting).toContainText('In attesa di risposta');
  await expectAccessible(page, 'email in attesa');

  // trattativa: creata all'invio, fase «In attesa di risposta», attività registrata con il destinatario
  await waiting.getByRole('link', { name: `Registra la risposta di ${name}` }).click();
  await expect(page.getByLabel('Fase della pipeline')).toHaveValue('in_attesa');
  const timeline = page.getByRole('list', { name: 'Attività' });
  await expect(timeline.getByText(/Email commerciale inviata a info@dentista-prova\.example\.it/)).toBeVisible();
  await expect(timeline.getByText(/→ In attesa di risposta/)).toBeVisible();

  // dashboard: un'email inviata e un'azienda in attesa in più (il tentativo rifiutato non conta)
  await navLink(page, 'Dashboard').click();
  const home = await (await page.request.get('/api/home')).json();
  expect(home.sales.emailsSent).toBe(before.emailsSent + 1);
  expect(home.sales.awaitingReply).toBe(before.awaitingReply + 1);
  const kpis = page.getByRole('list', { name: 'Numeri principali' });
  await expect(kpis.getByRole('listitem').filter({ hasText: 'Email inviate' }).locator('.dash-kpi__value')).toHaveText(
    Number(home.sales.emailsSent).toLocaleString('it-IT', { useGrouping: 'always' } as Intl.NumberFormatOptions),
  );
  expect(errors).toEqual([]);
});

test('senza email o da non contattare: «Invia email» disattivato', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/trova?email=no&q=Bar%20di%20Prova');
  const noEmail = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: /^Bar di Prova/ }) })
    .first();
  await expect(noEmail).toContainText('Email non disponibile');
  await expect(noEmail.getByRole('button', { name: /^Invia email a / })).toBeDisabled();

  // rifiuto commerciale: esclusa e con divieto di contatto; reinclusa, il divieto resta e l'invio resta bloccato
  await page.goto(`/trova?q=${encodeURIComponent(name)}`);
  await row(page)
    .first()
    .getByRole('link', { name: `Dettagli di ${name}` })
    .click();
  await page.getByRole('button', { name: 'Gestisci contatto' }).click();
  const manage = page.getByRole('dialog', { name: 'Gestisci contatto' });
  await manage.getByRole('radio', { name: /^Rifiuto commerciale/ }).check();
  await expect(manage.getByRole('radio', { name: /^Tutti i canali/ })).toBeChecked();
  // annullare non cambia nulla
  await manage.getByRole('button', { name: 'Annulla' }).click();
  await expect(page.getByRole('button', { name: 'Invia email' })).toBeEnabled();
  await page.getByRole('button', { name: 'Gestisci contatto' }).click();
  await manage.getByRole('radio', { name: /^Rifiuto commerciale/ }).check();
  await manage.getByRole('button', { name: 'Conferma l’esclusione' }).click();
  await expect(page.locator('.notice__title', { hasText: 'Contatto vietato' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invia email' })).toBeDisabled();
  // «Aziende escluse» in «Trova aziende»
  await page.goto(`/trova?q=${encodeURIComponent(name)}&escluse=1`);
  const excluded = row(page).first();
  await expect(excluded).toContainText('Non contattare');
  await expect(excluded.getByRole('button', { name: `Invia email a ${name}` })).toBeDisabled();
  // riportata tra i potenziali clienti: il divieto di contatto resta
  await excluded.getByRole('link', { name: `Dettagli di ${name}` }).click();
  await page.getByRole('button', { name: 'Gestisci contatto' }).click();
  await expect(manage.getByText(/Il divieto di contatto resta attivo/)).toBeVisible();
  await manage.getByRole('button', { name: 'Riporta tra i potenziali clienti' }).click();
  await expect(page.locator('.notice__title', { hasText: 'Contatto vietato' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invia email' })).toBeDisabled();
  // anche chiamando l'API direttamente: nessuna bozza
  const api = await page.request.post('/api/emails', {
    data: { requestId: crypto.randomUUID(), businessId: page.url().split('/').pop() },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(api.status()).toBe(409);
  expect(errors).toEqual([]);
});
