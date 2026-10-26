import { readPidFromLock, acquireLock, isProcessAlive, type Lock } from '@/util/lock'
import { readControlFile, requestShutdown } from '@/services/controlListener'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { QuiescePort } from '../../application/ports/epochSwitch'
import { EpochSwitchError, type EpochSwitchFaults } from '../../domain/epochSwitch/model'

export interface EpochStopProtocol {
  pid(): number | null
  alive(pid: number): boolean
  request(pid: number, timeoutMs: number): Promise<boolean>
  acquire(): Lock
  wait(ms: number): Promise<void>
}
export function createLocalEpochQuiesce(input: {
  lockPath: string
  controlPath: string
  platform?: NodeJS.Platform
  now?: () => number
  faults?: EpochSwitchFaults
  protocol?: EpochStopProtocol
}): QuiescePort {
  const now = input.now ?? Date.now
  const protocol: EpochStopProtocol = input.protocol ?? {
    pid: () => readPidFromLock(input.lockPath),
    alive: isProcessAlive,
    async request(pid, timeoutMs) {
      if ((input.platform ?? process.platform) !== 'win32') {
        try {
          process.kill(pid, 'SIGTERM')
          return true
        } catch {
          return !isProcessAlive(pid)
        }
      }
      const endpoint = readControlFile(input.controlPath)
      return (
        endpoint !== null &&
        endpoint.pid === pid &&
        (await requestShutdown(endpoint, Math.min(timeoutMs, 5000))) === 'accepted'
      )
    },
    acquire: () => acquireLock(input.lockPath),
    wait: async (ms) => {
      await Bun.sleep(ms)
    },
  }
  let held: { op: string; lock: Lock } | null = null
  return {
    async quiesce({ operationId, drainTimeoutMs }) {
      if (held && held.op !== operationId)
        throw new EpochSwitchError('v3-daemon-lock-held', { category: 'owner-conflict' })
      let stopped = false
      if (!held) {
        const pid = protocol.pid()
        if (pid !== null && protocol.alive(pid)) {
          if (pid === process.pid)
            throw new EpochSwitchError('v3-offline-command-required', {
              category: 'operation-conflict',
            })
          if (!(await protocol.request(pid, drainTimeoutMs)))
            throw new EpochSwitchError('v3-drain-timeout', {
              category: 'drain-timeout',
              retryable: true,
            })
          stopped = true
          input.faults?.('after-stop-request')
        }
        const deadline = now() + drainTimeoutMs
        for (;;) {
          try {
            held = { op: operationId, lock: protocol.acquire() }
            break
          } catch {
            if (now() >= deadline)
              throw new EpochSwitchError('v3-drain-timeout', {
                category: 'drain-timeout',
                retryable: true,
              })
            await protocol.wait(Math.min(100, Math.max(1, deadline - now())))
          }
        }
        input.faults?.('after-lock-acquired')
      }
      const receipt = {
        version: 1 as const,
        operationId,
        deployment: 'standalone' as const,
        kind: stopped ? ('daemon-stopped' as const) : ('already-stopped' as const),
        stoppedAt: now(),
        freezeReference: null,
      }
      return { ...receipt, digest: valueDigest(receipt) }
    },
    async release(op) {
      if (held?.op === op) {
        held.lock.release()
        held = null
      }
    },
    async assertHeld(op) {
      if (!held || held.op !== op || protocol.pid() !== held.lock.pid)
        throw new EpochSwitchError('v3-daemon-lock-lost', { category: 'owner-conflict' })
    },
  }
}
