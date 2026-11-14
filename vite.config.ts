import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

function pwaShellPlugin(): Plugin {
  return {
    name: 'smart-expense-tracker-pwa-shell',
    apply: 'build',
    async writeBundle(outputOptions, bundle) {
      const outputDir = resolve(outputOptions.dir ?? 'dist');
      const generatedAssets = Object.keys(bundle)
        .filter((fileName) => fileName === 'index.html' || /\.(?:js|css)$/.test(fileName))
        .sort();
      const precachePaths = [
        './index.html',
        ...generatedAssets
          .filter((fileName) => fileName !== 'index.html')
          .map((fileName) => `./${fileName}`),
        './manifest.webmanifest',
        './icons/icon-192.png',
        './icons/icon-512.png',
        './icons/icon-maskable-512.png',
        './icons/apple-touch-icon.png',
      ];
      const template = await readFile(new URL('./public/sw.js', import.meta.url), 'utf8');
      const staticInputs = [
        'public/manifest.webmanifest',
        'public/icons/icon-192.png',
        'public/icons/icon-512.png',
        'public/icons/icon-maskable-512.png',
        'public/icons/apple-touch-icon.png',
      ];
      const hash = createHash('sha256');
      for (const fileName of generatedAssets) {
        const item = bundle[fileName];
        hash.update(fileName);
        hash.update('type' in item && item.type === 'asset' ? item.source : item.code);
      }
      for (const fileName of staticInputs) {
        hash.update(fileName);
        hash.update(await readFile(new URL(`./${fileName}`, import.meta.url)));
      }
      hash.update(template);
      const buildId = hash.digest('hex').slice(0, 12);
      const worker = template
        .replace("'__BUILD_ID__'", JSON.stringify(buildId))
        .replace('/*__PRECACHE_MANIFEST__*/ []', JSON.stringify(precachePaths));
      await writeFile(resolve(outputDir, 'sw.js'), worker, 'utf8');
    },
  };
}

// GitHub Pages project sites are served below /<repository>/; relative assets keep this portable.
export default defineConfig({
  base: './',
  plugins: [react(), pwaShellPlugin()],
  resolve: {
    alias: {
      // Mirrors the "@/*" path mapping in tsconfig.app.json
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
