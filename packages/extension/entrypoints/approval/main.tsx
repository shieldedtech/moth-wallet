import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../assets/globals.css';
import { initAppearance } from '../../lib/ui/theme';
import { App } from './App';

initAppearance();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
