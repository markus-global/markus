import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n/index.ts';
import { App } from './App.tsx';
import { LayoutProvider } from './contexts/LayoutContext.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LayoutProvider>
      <App />
    </LayoutProvider>
  </StrictMode>,
);
