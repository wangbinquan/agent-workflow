import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type reactPlugin from '../../../packages/frontend/node_modules/@vitejs/plugin-react'
const require = createRequire(new URL('../../../packages/frontend/package.json', import.meta.url))
const react = require('@vitejs/plugin-react') as { default: typeof reactPlugin }
export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react.default()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../../packages/frontend/src', import.meta.url)),
      react: fileURLToPath(
        new URL('../../../packages/frontend/node_modules/react', import.meta.url),
      ),
      'react-dom': fileURLToPath(
        new URL('../../../packages/frontend/node_modules/react-dom', import.meta.url),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5396,
    strictPort: true,
    watch: { usePolling: true, interval: 500 },
  },
}
