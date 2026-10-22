/** Utenti di prova del database dei test end-to-end (.data/e2e, ricreato a ogni esecuzione; mai usati altrove). */
export const E2E_USERS = {
  admin: { email: 'admin@e2e.test', password: 'password-amministratore-e2e', name: 'Giulia Amministratrice' },
  fresh: { email: 'nuovo@e2e.test', password: 'temporanea-e2e-12345' },
};

/** Porta del server Overpass FINTO usato dai test end-to-end (dati inventati). */
export const E2E_FAKE_OVERPASS_PORT = 8812;

/** Porte dei siti FINTI per l'audit (pagine "di Prova"), raggiungibili solo grazie ad AUDIT_TEST_LOOPBACK_PORTS. */
export const E2E_FAKE_SITE_PORTS = { good: 8813, poor: 8814, closed: 8815 };
/** Server finto del fornitore AI (protocollo di Anthropic, solo test): nessuna chiamata reale, nessun costo. */
export const E2E_FAKE_AI_PORT = 8816;
/** Server SMTP finto (solo test): riceve i messaggi su 127.0.0.1, nessuna email reale. */
export const E2E_FAKE_SMTP_PORT = 8817;

/** Aziende di prova collegate ai siti finti (provincia di Trieste: fuori dalle aree usate dai test della scoperta). */
export const E2E_AUDIT_BUSINESSES = {
  good: 'Farmacia Audit di Prova',
  poor: 'Trattoria Audit di Prova',
  down: 'Ottica Audit di Prova',
};
