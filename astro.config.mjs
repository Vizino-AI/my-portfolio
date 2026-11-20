import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://portfolio.vizino.ai',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'auto' },
  // The homepage is the blog now, and the case studies, How We Work and
  // Engagement Model pages are taken down (kept as src/pages/_*.astro).
  // Old links land on the homepage instead of a 404. /work/<slug> is in vercel.json.
  redirects: {
    '/blog': '/',
    '/work': '/',
    '/how-we-work': '/',
    '/engagement-model': '/',
  },
});
