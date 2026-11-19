import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/inter-tight';
import '../../src/styles/tokens.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
