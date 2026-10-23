import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/discovery.css';
import './styles/audit.css';
import './styles/scoring.css';
import './styles/services.css';
import './styles/hunter.css';
import './styles/crm.css';
import './styles/ai.css';
import './styles/home.css';
import './styles/workflow.css';
import './styles/email.css';
import './styles/categories.css';
import './styles/business.css';
import './styles/dashboard.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
