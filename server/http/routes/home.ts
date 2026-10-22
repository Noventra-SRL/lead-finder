import { z } from 'zod';
import { mondayOf, weekAgenda } from '../../agenda.ts';
import { homeOverview } from '../../home.ts';
import { ok, parseQuery, sessionOf, type Route } from '../core.ts';

/*
 * GET /api/home — dati della pagina iniziale in una sola richiesta (aziende, fasce del punteggio commerciale, CRM,
 * stato dell'AI, attività recenti). Solo letture dal database: nessuna chiamata al modello AI.
 * GET /api/home/agenda?settimana=YYYY-MM-DD — agenda della settimana che contiene il giorno (predefinito: oggi).
 */
export const homeRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/home$/,
    async handle(ctx) {
      return ok({
        ...(await homeOverview(ctx.db, sessionOf(ctx).user.id)),
        aiConfigured: ctx.state.ai.provider !== null,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/home\/agenda$/,
    async handle(ctx) {
      sessionOf(ctx);
      const q = parseQuery(z.object({ settimana: z.iso.date().optional() }), ctx.url.searchParams);
      const day = q.settimana ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
      return ok(await weekAgenda(ctx.db, mondayOf(day)));
    },
  },
];
