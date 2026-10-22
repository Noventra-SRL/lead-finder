import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get, onAuthProblem, post, type User } from '../api/client.ts';

/*
 * Stato dell'autenticazione nell'interfaccia. La fonte di verità è il server (GET /api/auth/me):
 * il browser non conserva token né dati dell'utente oltre la memoria della pagina.
 */

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous'; notice?: string }
  | { status: 'unavailable'; message: string }
  | { status: 'authenticated'; user: User };

interface AuthApi {
  state: AuthState;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

/** Stato secondo il server: autenticato, anonimo (eventualmente con sessione scaduta) o server non raggiungibile. */
async function currentState(): Promise<AuthState> {
  try {
    const { user, expired } = await get<{ user: User | null; expired?: boolean }>('/auth/session');
    if (user) return { status: 'authenticated', user };
    return { status: 'anonymous', notice: expired ? 'La sessione è scaduta: accedi di nuovo.' : undefined };
  } catch (error) {
    return { status: 'unavailable', message: error instanceof ApiError ? error.message : 'Errore imprevisto.' };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(() => currentState().then(setState), []);

  useEffect(() => {
    let cancelled = false;
    void currentState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onAuthProblem((error) => {
        if (error.code === 'PASSWORD_CHANGE_REQUIRED') {
          setState((s) => (s.status === 'authenticated' ? { ...s, user: { ...s.user, mustChangePassword: true } } : s));
        } else {
          // richieste parallele: dopo "sessione scaduta" il cookie è già cancellato e le altre ricevono "accedi";
          // resta il messaggio più preciso
          setState((s) =>
            s.status === 'anonymous' && s.notice && error.code === 'UNAUTHENTICATED'
              ? s
              : { status: 'anonymous', notice: error.message },
          );
        }
      }),
    [],
  );

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await post<{ user: User }>('/auth/login', { email, password });
    setState({ status: 'authenticated', user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      setState({ status: 'anonymous' });
    }
  }, []);

  const value = useMemo(() => ({ state, login, logout, refresh }), [state, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fuori da AuthProvider');
  return ctx;
}

/** Utente autenticato: da usare solo dentro le pagine protette. */
export function useUser(): User {
  const { state } = useAuth();
  if (state.status !== 'authenticated') throw new Error('useUser senza utente autenticato');
  return state.user;
}
