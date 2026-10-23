import React from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';

function App() {
  return (
    <main>
      <div className="mark" aria-hidden="true">✦</div>
      <p className="eyebrow">A LITTLE HELP, ALWAYS CLOSE</p>
      <h1>Hello Team</h1>
      <p className="description">A little help for everything your day holds.</p>
      <div className="status"><span /> Your butler is taking shape.</div>
      <footer>Made together. <small>Commit {import.meta.env.VITE_COMMIT || 'dev'}</small></footer>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

// Refresh the page to pick up a new deployment; never cache app HTML offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(console.error); });
}
