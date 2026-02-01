
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

function mountApp() {
  const rootElement = document.getElementById('root');

  if (!rootElement) {
    console.error("Target container 'root' not found");
    return;
  }

  // Se l'elemento root mostra ancora il testo di caricamento del CSS, lo puliamo
  if (rootElement.innerHTML === "" || rootElement.innerText === "Accendendo la Luce...") {
    rootElement.innerHTML = "";
  }

  try {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (err) {
    console.error("Mounting Error:", err);
    rootElement.innerHTML = `
      <div style="padding: 20px; font-family: sans-serif; text-align: center; color: #f43f5e;">
        <h2>Si è verificato un errore ✨</h2>
        <p>Riprova ad aggiornare la pagina.</p>
        <button onclick="location.reload()" style="background:#f43f5e; color:white; border:none; padding:10px 20px; border-radius:10px; cursor:pointer;">Aggiorna</button>
      </div>
    `;
  }
}

// Assicuriamoci che il DOM sia pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountApp);
} else {
  mountApp();
}
