import { build } from 'vite';

process.env.PHARMA_DESKTOP_BUILD = 'true';

await build({
  configFile: 'vite.config.ts',
  base: './',
  build: {
    outDir: 'desktop-app/renderer',
    emptyOutDir: true,
  },
});
