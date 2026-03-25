import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));

const configPath = join(homedir(), '.markus', 'markus.json');
let apiPort = 8056;
let webPort = 8057;
if (existsSync(configPath)) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (cfg.server?.apiPort) apiPort = cfg.server.apiPort;
    if (cfg.server?.webPort) webPort = cfg.server.webPort;
  } catch { /* use defaults */ }
}

const apiTarget = `http://localhost:${apiPort}`;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    proxy: {
      '/api': {
        target: apiTarget,
        timeout: 0,
        proxyTimeout: 0,
      },
      '/ws': {
        target: apiTarget.replace('http', 'ws'),
        ws: true,
        rewriteWsOrigin: true,
        configure: (proxy) => {
          proxy.on('error', () => {});
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', () => {});
          });
        },
      },
    },
  },
});
