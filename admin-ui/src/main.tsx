import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

// Defer render one frame so window.location is settled before React Router
// reads it — fixes blank page in puppeteer/Chrome DevTools timing edge case
requestAnimationFrame(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
