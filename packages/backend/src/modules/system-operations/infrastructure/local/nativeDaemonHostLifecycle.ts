import { unlinkSync, writeFileSync } from 'node:fs'
import { startControlListener } from '@/services/controlListener'
import type { DaemonHostLifecyclePort } from '../../application/ports/daemonHostLifecycle'
import { createFileDaemonRuntimeQueries } from './fileDaemonRuntimeQueries'

export interface NativeDaemonHostOptions {
  readonly infoPath: string
  readonly controlPath: string
  readonly pid: number
  readonly devWatch: boolean
}

/** Existing standalone files, process signals and control listener stay local. */
export function createNativeDaemonHostLifecycle(
  options: NativeDaemonHostOptions,
): DaemonHostLifecyclePort {
  const queries = createFileDaemonRuntimeQueries({ infoPath: options.infoPath })
  const withdrawReady = (): void => {
    try {
      unlinkSync(options.infoPath)
    } catch {
      // Already removed or never written, as in standalone start.
    }
  }
  return {
    readCurrent: () => queries.readCurrent(),
    publishReady(readiness) {
      writeFileSync(options.infoPath, JSON.stringify({ pid: options.pid, ...readiness }, null, 2))
    },
    withdrawReady,
    subscribeShutdown(callbacks) {
      const request = (reason: string): void => {
        withdrawReady()
        void Promise.resolve(callbacks.onShutdown(reason)).catch(callbacks.onFailure)
      }
      const control = startControlListener({
        controlFilePath: options.controlPath,
        devWatch: options.devWatch,
        onShutdown: () => request('control-shutdown'),
      })
      process.on('SIGTERM', () => request('SIGTERM'))
      process.on('SIGINT', () => request('SIGINT'))
      process.on('exit', () => {
        withdrawReady()
        control.close()
        callbacks.onExit()
      })
      return { close: () => control.close() }
    },
    announceReady(browserUrl) {
      process.stdout.write(
        `\nagent-workflow ready — open this URL in your browser:\n  ${browserUrl}\n\n`,
      )
    },
    terminate: (code) => process.exit(code),
  }
}
