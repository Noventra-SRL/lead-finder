import { z } from 'zod';
import { audit } from '../../audit.ts';
import { PASSWORD_MAX, verifyAgainstDummy, verifyPassword } from '../../auth/passwords.ts';
import { RULES } from '../../auth/rateLimit.ts';
import {
  clearedSessionCookie,
  createSession,
  deleteOtherSessions,
  deleteSession,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  validateSession,
} from '../../auth/sessions.ts';
import { changeOwnPassword, emailSchema, UserError } from '../../auth/users.ts';
import { HttpError, limit, msg, noContent, ok, parseBody, sessionOf, tooManyAttempts, type Route } from '../core.ts';

/*
 * Accesso degli utenti interni.
 *  POST   /api/auth/login              email + password → cookie di sessione
 *  POST   /api/auth/logout             chiude la sessione sul server
 *  GET    /api/auth/session            stato dell'accesso, sempre 200: { user } oppure { user: null, expired? }
 *                                      (usato all'apertura dell'app: un visitatore non autenticato non è un errore)
 *  GET    /api/auth/me                 utente della sessione (401 senza sessione)
 *  POST   /api/auth/password           cambio password (password attuale richiesta); chiude le altre sessioni
 *  GET    /api/auth/sessions           sessioni attive dell'utente
 *  POST   /api/auth/sessions/revoke-others
 * Gli errori di accesso non rivelano se un'email ha un account.
 */

const loginSchema = z.object({
  email: z.string({ error: msg.required }).min(1, msg.required).max(254, msg.tooLong(254)),
  password: z.string({ error: msg.required }).min(1, msg.required).max(PASSWORD_MAX, msg.tooLong(PASSWORD_MAX)),
});

const passwordSchema = z.object({
  currentPassword: z.string({ error: msg.required }).min(1, msg.required).max(PASSWORD_MAX),
  newPassword: z.string({ error: msg.required }).min(1, msg.required).max(PASSWORD_MAX, msg.tooLong(PASSWORD_MAX)),
});

const INVALID_CREDENTIALS = 'Email o password non corretti.';

export const authRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/auth\/session$/,
    access: 'public',
    async handle(ctx) {
      const token = readCookie(ctx.req.headers.cookie, SESSION_COOKIE);
      if (!token) return ok({ user: null });
      const session = await validateSession(ctx.db, token, ctx.state.config.sessions);
      if (!session) {
        ctx.cookies.push(clearedSessionCookie(ctx.state.config.security.secureCookies));
        return ok({ user: null, expired: true });
      }
      return ok({ user: session.user, expiresAt: session.expiresAt.toISOString() });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/login$/,
    access: 'public',
    async handle(ctx) {
      limit(ctx, `login:ip:${ctx.ip}`, RULES.loginByIp);
      const body = parseBody(loginSchema, ctx.body);
      const parsedEmail = emailSchema.safeParse(body.email);
      const email = parsedEmail.success ? parsedEmail.data : body.email.trim().toLowerCase();
      const failureKey = `login:fail:${email}`;
      const wait = ctx.limiter.blocked(failureKey, RULES.loginFailuresByEmail);
      if (wait > 0) throw tooManyAttempts(wait);

      const { rows } = await ctx.db.query<{ id: string; password_hash: string; disabled_at: Date | null }>(
        'SELECT id, password_hash, disabled_at FROM users WHERE email = $1',
        [email],
      );
      const user = rows[0];
      const valid =
        user && !user.disabled_at
          ? await verifyPassword(user.password_hash, body.password)
          : await verifyAgainstDummy(body.password);
      if (!valid || !user) {
        ctx.limiter.hit(failureKey, RULES.loginFailuresByEmail);
        if (user)
          await audit(ctx.db, {
            userId: user.id,
            action: 'auth.login_failed',
            entityType: 'user',
            entityId: user.id,
            details: { reason: user.disabled_at ? 'disabled' : 'password' },
          });
        ctx.log.warn('accesso non riuscito', { known: Boolean(user) });
        throw new HttpError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
      }
      ctx.limiter.reset(failureKey);
      const session = await createSession(ctx.db, user.id, ctx.state.config.sessions, ctx.userAgent);
      await ctx.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await audit(ctx.db, { userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
      ctx.cookies.push(sessionCookie(session.token, session.expiresAt, ctx.state.config.security.secureCookies));
      const me = await ctx.db.query<{
        id: string;
        email: string;
        display_name: string;
        role: string;
        must_change_password: boolean;
      }>('SELECT id, email, display_name, role, must_change_password FROM users WHERE id = $1', [user.id]);
      const u = me.rows[0]!;
      return ok({
        user: {
          id: u.id,
          email: u.email,
          displayName: u.display_name,
          role: u.role,
          mustChangePassword: u.must_change_password,
        },
        expiresAt: session.expiresAt.toISOString(),
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/logout$/,
    allowPendingPassword: true,
    async handle(ctx) {
      const session = sessionOf(ctx);
      await deleteSession(ctx.db, session.sessionId);
      await audit(ctx.db, {
        userId: session.user.id,
        action: 'auth.logout',
        entityType: 'user',
        entityId: session.user.id,
      });
      ctx.cookies.push(clearedSessionCookie(ctx.state.config.security.secureCookies));
      return noContent();
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/auth\/me$/,
    allowPendingPassword: true,
    async handle(ctx) {
      const session = sessionOf(ctx);
      return ok({ user: session.user, expiresAt: session.expiresAt.toISOString() });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/password$/,
    allowPendingPassword: true,
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `password:${session.user.id}`, RULES.passwordChangeByUser);
      const body = parseBody(passwordSchema, ctx.body);
      const { rows } = await ctx.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
        session.user.id,
      ]);
      if (!rows[0] || !(await verifyPassword(rows[0].password_hash, body.currentPassword)))
        throw new HttpError(400, 'VALIDATION_ERROR', 'Controlla i campi evidenziati.', {
          currentPassword: 'La password attuale non è corretta.',
        });
      if (body.newPassword === body.currentPassword)
        throw new HttpError(400, 'VALIDATION_ERROR', 'Controlla i campi evidenziati.', {
          newPassword: 'La nuova password deve essere diversa da quella attuale.',
        });
      try {
        const result = await changeOwnPassword(ctx.db, session.user, body.newPassword, session.sessionId);
        return ok(result);
      } catch (error) {
        if (error instanceof UserError)
          throw new HttpError(400, 'VALIDATION_ERROR', 'Controlla i campi evidenziati.', {
            newPassword: error.message,
          });
        throw error;
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/auth\/sessions$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const { rows } = await ctx.db.query<{
        id: string;
        created_at: Date;
        last_seen_at: Date;
        expires_at: Date;
        user_agent: string;
      }>(
        `SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions
          WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`,
        [session.user.id],
      );
      return ok({
        sessions: rows.map((r) => ({
          current: r.id === session.sessionId,
          createdAt: new Date(r.created_at).toISOString(),
          lastSeenAt: new Date(r.last_seen_at).toISOString(),
          expiresAt: new Date(r.expires_at).toISOString(),
          userAgent: r.user_agent,
        })),
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/sessions\/revoke-others$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const closed = await deleteOtherSessions(ctx.db, session.user.id, session.sessionId);
      await audit(ctx.db, {
        userId: session.user.id,
        action: 'auth.sessions_revoked',
        entityType: 'user',
        entityId: session.user.id,
        details: { closed },
      });
      return ok({ closed });
    },
  },
];
