import { useAuth, useUser } from '../auth/AuthContext.tsx';
import { PasswordForm } from '../components/PasswordForm.tsx';
import { Button } from '../components/ui.tsx';

/** Primo accesso o password reimpostata: finché non si sceglie una password personale, l'app resta bloccata. */
export function ChangePasswordPage() {
  const user = useUser();
  const { refresh, logout } = useAuth();
  return (
    <div className="auth">
      <section className="auth__statement" aria-label="Lead Finder">
        <span className="brand__name">Noventra</span>
        <h2 className="auth__headline">
          Prima di iniziare,
          <br />
          <span>una password tua.</span>
        </h2>
        <p className="auth__note">
          Stai usando una password temporanea creata dall’amministratore. Sceglierne una personale chiude ogni altra
          sessione aperta con quella temporanea.
        </p>
      </section>
      <section className="auth__panel">
        <div className="auth__form">
          <div className="stack stack--tight">
            <span className="eyebrow">{user.email}</span>
            <h1>Imposta la password</h1>
          </div>
          <PasswordForm submitLabel="Salva e continua" onDone={() => void refresh()} />
        </div>
        <p className="auth__foot">
          Non sei tu?{' '}
          <Button variant="ghost" onClick={() => void logout()}>
            Esci
          </Button>
        </p>
      </section>
    </div>
  );
}
