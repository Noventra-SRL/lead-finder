import { homeOverview } from '../../home.ts';
import { ok, sessionOf, type Route } from '../core.ts';

/*
 * GET /api/home — dati della pagina iniziale in una sola richiesta (aziende, fasce del punteggio commerciale, CRM,
 * stato dell'AI, attività recenti). Solo letture dal database: nessuna chiamata al modello AI.
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
];
