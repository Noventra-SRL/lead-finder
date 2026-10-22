import { BrowserRouter, Route, Routes } from 'react-router';
import { ProspectsPage } from './pages/ProspectsPage.tsx';
import { AuthProvider, useAuth } from './auth/AuthContext.tsx';
import { AppShell } from './components/AppShell.tsx';
import { Button, Loading, Notice } from './components/ui.tsx';
import { NAV_ITEMS } from './navigation.ts';
import { ChangePasswordPage } from './pages/ChangePasswordPage.tsx';
import { AiJobPage } from './pages/AiJobPage.tsx';
import { AiPage } from './pages/AiPage.tsx';
import { AuditDetailPage } from './pages/AuditDetailPage.tsx';
import { AuditJobPage } from './pages/AuditJobPage.tsx';
import { AuditPage } from './pages/AuditPage.tsx';
import { BusinessPage } from './pages/BusinessPage.tsx';
import { CrmFollowUpsPage } from './pages/CrmFollowUpsPage.tsx';
import { CrmListPage } from './pages/CrmListPage.tsx';
import { CrmPage } from './pages/CrmPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { DiscoverPage } from './pages/DiscoverPage.tsx';
import { DuplicatesPage } from './pages/DuplicatesPage.tsx';
import { EmailEditorPage } from './pages/EmailEditorPage.tsx';
import { EmailListPage } from './pages/EmailListPage.tsx';
import { HuntRunPage } from './pages/HuntRunPage.tsx';
import { JobPage } from './pages/JobPage.tsx';
import { LeadHunterPage } from './pages/LeadHunterPage.tsx';
import { LeadsPage } from './pages/LeadsPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { ModulePage } from './pages/ModulePage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { OpportunityPage } from './pages/OpportunityPage.tsx';
import { RemindersPage } from './pages/RemindersPage.tsx';
import { ReportPage } from './pages/ReportPage.tsx';
import { ServicesPage } from './pages/ServicesPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

const PAGES: Record<string, () => React.JSX.Element | null> = {
  '/': DashboardPage,
  '/lead-hunter': LeadHunterPage,
  '/trova': ProspectsPage,
  '/aziende': LeadsPage,
  '/audit': AuditPage,
  '/analisi-ai': AiPage,
  '/pipeline': CrmPage,
  '/email': EmailListPage,
  '/servizi': ServicesPage,
  '/report': ReportPage,
  '/impostazioni': SettingsPage,
};

function Gate() {
  const { state, refresh } = useAuth();
  if (state.status === 'loading') {
    return (
      <div className="main">
        <Loading label="Verifica dell’accesso…" />
      </div>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <div className="main">
        <div className="main__inner stack">
          <Notice tone="error" title="Lead Finder non è raggiungibile">
            <p>{state.message}</p>
          </Notice>
          <div>
            <Button onClick={() => void refresh()}>Riprova</Button>
          </div>
        </div>
      </div>
    );
  }
  // l'indirizzo resta quello richiesto: dopo l'accesso si apre direttamente la pagina voluta
  if (state.status === 'anonymous') return <LoginPage notice={state.notice} />;
  if (state.user.mustChangePassword) return <ChangePasswordPage />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        {NAV_ITEMS.map((item) => {
          const Page = PAGES[item.path];
          return <Route key={item.path} path={item.path} element={Page ? <Page /> : <ModulePage item={item} />} />;
        })}
        {/* ricerca manuale per zona e categoria: seconda scheda di «Trova aziende» */}
        <Route path="/scoperta" element={<DiscoverPage />} />
        <Route path="/scoperta/ricerche/:id" element={<JobPage />} />
        <Route path="/lead-hunter/:id" element={<HuntRunPage />} />
        <Route path="/audit/verifiche/:id" element={<AuditJobPage />} />
        <Route path="/audit/esiti/:id" element={<AuditDetailPage />} />
        <Route path="/analisi-ai/lotti/:id" element={<AiJobPage />} />
        <Route path="/pipeline/elenco" element={<CrmListPage />} />
        <Route path="/pipeline/follow-up" element={<CrmFollowUpsPage />} />
        <Route path="/pipeline/:id" element={<OpportunityPage />} />
        <Route path="/promemoria" element={<RemindersPage />} />
        <Route path="/email/:id" element={<EmailEditorPage />} />
        <Route path="/aziende/duplicati" element={<DuplicatesPage />} />
        <Route path="/aziende/:id" element={<BusinessPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
