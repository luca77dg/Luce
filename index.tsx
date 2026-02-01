
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// Listener globale per intercettare errori che bloccano il rendering
window.onerror = function(message, source, lineno, colno, error) {
  if (rootElement.innerHTML === "" || rootElement.innerText === "Accendendo la Luce...") {
    rootElement.innerHTML = `
      <div style="padding: 30px; color: #b91c1c; background: #fef2f2; border: 2px solid #fee2e2; border-radius: 20px; margin: 40px auto; max-width: 400px; font-family: sans-serif; text-align: center; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);">
        <h2 style="margin-top:0; font-size: 1.5rem">Ops! Un piccolo intoppo ✨</h2>
        <p style="font-size: 0.9rem; line-height: 1.5">Luce ha avuto un problema nel caricamento. Spesso basta un semplice aggiornamento!</p>
        <div style="background: #fff; padding: 10px; border-radius: 8px; font-size: 0.7rem; color: #666; margin: 15px 0; text-align: left; overflow: auto; max-height: 100px;">
          Error: ${message}
        </div>
        <button onclick="location.reload()" style="background: #f43f5e; color: white; border: none; padding: 12px 24px; border-radius: 12px; font-weight: bold; cursor: pointer; transition: transform 0.2s; width: 100%;">Riprova Ora</button>
      </div>
    `;
  }
  return false;
};

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
