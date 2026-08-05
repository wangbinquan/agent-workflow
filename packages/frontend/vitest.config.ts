import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
    },
  },
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: { url: 'http://localhost/' },
    },
    setupFiles: ['./tests/setup.ts'],
    css: false,
    globals: false,
    // RFC-254: the windows-latest frontend job runs the SAME OS-agnostic
    // happy-dom tests on a runner that is ~2-4x slower than ubuntu/macos. A
    // correct render that finishes in ~1.5s on Linux can cross vitest's 5000ms
    // default there and time out (session-attempts-picker did exactly that).
    // These are ceilings, not expected durations — a correct test resolves in
    // <100ms and never approaches them on any runner, while a genuinely hung
    // test still fails, only a few seconds later. So the headroom is applied
    // uniformly on every platform rather than branching on process.platform.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
