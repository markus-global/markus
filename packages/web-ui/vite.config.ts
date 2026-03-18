import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));

const configPath = join(homedir(), '.markus', 'markus.json');
let apiPort = 3001;
if (existsSync(configPath)) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (cfg.server?.apiPort) apiPort = cfg.server.apiPort;
  } catch { /* use defaults */ }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
