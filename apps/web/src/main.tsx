import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// self-hosted OFL faces (DESIGN.md "The One Sign Face Rule"): the sign face at the three weights the
// system uses (only the unicode-range slices a page needs load), and the numeral face (fonts.ts).
import '@fontsource/noto-sans-sc/600.css';
import '@fontsource/noto-sans-sc/700.css';
import '@fontsource/noto-sans-sc/800.css';
import './styles.css';
import { App } from './App.js';
import { registerNumeralFace } from './fonts.js';

registerNumeralFace();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
