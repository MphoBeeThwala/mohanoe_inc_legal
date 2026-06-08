import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

reportWebVitals();

function showUpdateBanner(onConfirm) {
  const existing = document.getElementById('sw-update-banner');
  if (existing) {
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'sw-update-banner';
  banner.setAttribute('role', 'status');
  banner.style.cssText =
    'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;' +
    'display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:16px;' +
    'background:#0d1f19;color:#f8fbf8;box-shadow:0 16px 40px rgba(8,24,18,0.28);' +
    'font-family:Inter,Segoe UI,Arial,sans-serif;font-size:0.92rem;max-width:min(92vw,520px);';

  const text = document.createElement('span');
  text.textContent = 'A new version is available.';
  banner.appendChild(text);

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Refresh';
  refresh.style.cssText =
    'border:none;border-radius:12px;padding:8px 14px;font-weight:700;cursor:pointer;' +
    'background:linear-gradient(135deg,#1b7a58,#0f5d43);color:#f8fff9;';
  refresh.addEventListener('click', onConfirm);
  banner.appendChild(refresh);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Later';
  dismiss.setAttribute('aria-label', 'Dismiss update notice');
  dismiss.style.cssText =
    'border:1px solid rgba(255,255,255,0.2);border-radius:12px;padding:8px 12px;' +
    'background:transparent;color:#f8fbf8;cursor:pointer;';
  dismiss.addEventListener('click', () => banner.remove());
  banner.appendChild(dismiss);

  document.body.appendChild(banner);
}

if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${process.env.PUBLIC_URL || ''}/sw.js`)
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) {
            return;
          }

          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(() => {
                worker.postMessage({ type: 'SKIP_WAITING' });
                window.location.reload();
              });
            }
          });
        });

        if (registration.waiting) {
          showUpdateBanner(() => {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            window.location.reload();
          });
        }
      })
      .catch(() => {});

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) {
        return;
      }
      refreshing = true;
      window.location.reload();
    });
  });
}
