import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const infoPath = path.join(homedir(), '.agent-workflow', '.daemon.info')

// `bun run --filter '*' dev` launches backend and frontend in parallel. Vite
// resolves its proxy target once at config-load time, so if it reads
// .daemon.info before the daemon has (re)written it, it would lock onto the
// hardcoded fallback (port 7456) for the whole session even though the daemon
// is actually on a different port. We block here until the file exists AND
// its recorded pid is a live process — that means the info is current — then
// trust it. Sync sleep via Atomics.wait so we don't peg the CPU.
const viteStartedAt = Date.now()
function syncSleep(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readDaemonTarget(): string | null {
  try {
    if (!existsSync(infoPath)) return null
    const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as {
      pid?: number
      host?: string
      port?: number
      url?: string
    }
    if (typeof info.pid !== 'number' || !pidAlive(info.pid)) return null
    if (typeof info.url === 'string' && info.url !== '') {
      return info.url.replace(/\/$/, '')
    }
    if (typeof info.host === 'string' && typeof info.port === 'number') {
      return `http://${info.host}:${info.port}`
    }
    return null
  } catch {
    return null
  }
}

function resolveDaemonTarget(): string {
  const fallback = 'http://127.0.0.1:7456'
  const deadline = viteStartedAt + 30_000
  let logged = false
  while (Date.now() < deadline) {
    const target = readDaemonTarget()
    if (target) return target
    if (!logged) {
      // eslint-disable-next-line no-console
      console.log('[vite] waiting for daemon to publish .daemon.info …')
      logged = true
    }
    syncSleep(250)
  }
  // eslint-disable-next-line no-console
  console.warn(`[vite] daemon never appeared, falling back to ${fallback}`)
  return fallback
}

const daemonTarget = resolveDaemonTarget()
// eslint-disable-next-line no-console
console.log(`[vite] proxying /api and /ws → ${daemonTarget}`)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': daemonTarget,
      '/ws': { target: daemonTarget, ws: true, changeOrigin: true },
    },
  },
})
