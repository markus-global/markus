import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n/index.ts';
import { App } from './App.tsx';
import { LayoutProvider } from './contexts/LayoutContext.tsx';
import './index.css';
import { installAnimationBudget } from './animationBudget.ts';

// Pause all CSS animations while the window is hidden/unfocused — see
// animationBudget.ts for the measurements behind this.
installAnimationBudget();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LayoutProvider>
      <App />
    </LayoutProvider>
  </StrictMode>,
);
