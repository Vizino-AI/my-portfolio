import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { blogApi } from './server/api';

const editorDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(editorDir, '..');

// Local-only writing tool: `npm run editor`. Never part of the site build.
export default defineConfig({
  root: editorDir,
  // Serve the site's own public/ so uploaded images and videos preview at the
  // same /images/blog/... paths the published post will use.
  publicDir: path.join(projectRoot, 'public'),
  plugins: [blogApi(projectRoot)],
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    port: 4322,
    strictPort: true,
    // The API has no login; no other origin gets to read or write it.
    cors: false,
    // db/ and public/ change on every save and upload; that is data, not code.
    watch: { ignored: ['**/db/**', '**/public/**', '**/_originals/**'] },
  },
});
