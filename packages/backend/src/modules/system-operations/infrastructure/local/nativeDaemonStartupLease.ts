import { acquireLock, adoptCurrentProcessLock, DaemonLockHeldError, type Lock } from '@/util/lock'
import { readControlFile, requestShutdown } from '@/services/controlListener'
import { sha256Hex } from '@/util/hash'
import type { DaemonStartupLeasePort } from '../../application/ports/daemonStartupLease'
import { dirname } from 'node:path'
import { liveAutoUpgrade } from './autoUpgradeState'
import { autoUpgradeTestCheckpoint } from './autoUpgradeTestHooks'

export interface NativeDaemonStartupLeaseOptions {
  readonly lockPath: string
  readonly controlPath: string
  readonly maxWaitMs: number
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void
    error(message: string, fields?: Record<string, unknown>): void
  }
}

async function acquireStartLock(
  lockPath: string,
  onWait: (owner: DaemonLockHeldError, maxWaitMs: number) => void,
  onShutdownRequested: (owner: DaemonLockHeldError) => void,
  onSameProcessAdopted: (owner: DaemonLockHeldError) => void,
  options: NativeDaemonStartupLeaseOptions,
): Promise<Lock> {
  const maxWaitMs = options.maxWaitMs
  const deadline = Date.now() + maxWaitMs
  let announced = false
  let shutdownRequested = false
  const appHome = dirname(lockPath)
  const waitUpgrade = async () => {
    const active = liveAutoUpgrade(appHome)
    if (!active || active.pid === process.pid) return false
    options.log.info('数据库升级进行中', { pid: active.pid, operation: active.operationId })
    await autoUpgradeTestCheckpoint('startup-waiting-upgrade')
    await Bun.sleep(2000)
    return true
  }
  for (;;) {
    if (await waitUpgrade()) continue
    await autoUpgradeTestCheckpoint('startup-before-lock')
    try {
      const lock = acquireLock(lockPath)
      // RFC-398: an earlier absence check cannot authorize this newly acquired lease.
      const active = liveAutoUpgrade(appHome)
      if (active && active.pid !== process.pid) {
        lock.release() // release checks that the file still holds our PID.
        await waitUpgrade()
        continue
      }
      return lock
    } catch (error) {
      if (error instanceof DaemonLockHeldError && (await waitUpgrade())) continue
      const remaining = deadline - Date.now()
      if (!(error instanceof DaemonLockHeldError) || maxWaitMs === 0 || remaining <= 0) {
        throw error
      }
      if (error.pid === process.pid) {
        const adopted = adoptCurrentProcessLock(lockPath)
        const active = liveAutoUpgrade(appHome)
        if (active && active.pid !== process.pid) {
          adopted.release()
          await waitUpgrade()
          continue
        }
        onSameProcessAdopted(error)
        return adopted
      }
      if (!announced) {
        announced = true
        onWait(error, maxWaitMs)
      }
      if (!shutdownRequested) {
        const endpoint = readControlFile(options.controlPath)
        if (endpoint !== null && endpoint.pid === error.pid) {
          // The endpoint belongs to the live lock owner, but only an old dev
          // generation may be replaced. A manually started daemon stays safe.
          if (endpoint.devWatch !== true) throw error
          const outcome = await requestShutdown(endpoint, Math.min(5_000, remaining))
          if (outcome !== 'accepted') throw error
          shutdownRequested = true
          onShutdownRequested(error)
        }
      }
      await Bun.sleep(Math.min(50, remaining))
    }
  }
}

/** Existing PID files and dev control handoff are confined to this local adapter. */
export function createNativeDaemonStartupLease(
  options: NativeDaemonStartupLeaseOptions,
): DaemonStartupLeasePort {
  return {
    async acquire() {
      const log = options.log
      // 2. Single-instance lock.
      let lock: Lock
      try {
        lock = await acquireStartLock(
          options.lockPath,
          (owner, maxWaitMs) => {
            log.info('waiting for previous daemon lock handoff', {
              replacementPid: process.pid,
              pid: owner.pid,
              lock: owner.lockPath,
              maxWaitMs,
            })
          },
          (owner) => {
            log.info('requested previous dev daemon shutdown', {
              pid: owner.pid,
              lock: owner.lockPath,
            })
          },
          (owner) => {
            log.info('adopted current-process lock for Bun watch generation', {
              pid: owner.pid,
              lock: owner.lockPath,
            })
          },
          options,
        )
      } catch (err) {
        if (err instanceof DaemonLockHeldError) {
          log.error('another daemon is already running', { pid: err.pid, lock: err.lockPath })
          console.error(
            `agent-workflow: another daemon is already running (PID ${err.pid})\n` +
              `  lock file: ${err.lockPath}\n` +
              `  if it is stale, remove the lock file manually and try again`,
          )
          process.exit(1)
        }
        throw err
      }
      return Object.freeze({
        diagnostics: Object.freeze({ pid: lock.pid, lock: lock.path }),
        recoveryAuthority(input: { readonly daemonGeneration: string; readonly now?: number }) {
          return Object.freeze({
            daemonGeneration: input.daemonGeneration,
            acquiredAt: input.now ?? Date.now(),
            receiptDigest: sha256Hex(
              `${lock.path}\u0000${lock.pid}\u0000${input.daemonGeneration}`,
            ),
          })
        },
        release: () => lock.release(),
        releaseOnExit: () => lock.release(),
      })
    },
  }
}
