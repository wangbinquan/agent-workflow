import type {
  ProcessEffectProjection,
  ProcessEffectOutcome,
} from '../../application/ports/processEffectProjection'
import type { TaskExecutionEffectPersistence } from '../../application/ports/taskExecutionEffectStore'
import { sha256Hex } from '../../domain/digest'
import { requestHash } from '../../domain/executionEffect'

export interface LocalProcessSpawnReceipt {
  readonly pid: number
  readonly spawnBinaryPath: string
  readonly launchNonce?: string
}

export interface LocalProcessSettlement extends ProcessEffectOutcome {
  readonly exitCode: number | null
  readonly pid: number | null
  readonly launchNonce?: string
  readonly drainTimedOut?: boolean
  readonly pumpError?: string
}

export type LocalProcessResources = readonly string[] | Readonly<{ writerWorkspace: string }>

/** RFC-370: the original RFC-328 wire format and fingerprint belong to the
 * local execution implementation. No new identity or recovery policy. */
export function createLocalProcessEffectProjection(input: {
  readonly persistence: TaskExecutionEffectPersistence
  readonly processKind: 'agent' | 'script'
  readonly argv: readonly string[]
  readonly cwd: string
  readonly resourceKeys?: LocalProcessResources
}): ProcessEffectProjection<LocalProcessSpawnReceipt, LocalProcessSettlement> {
  return {
    describe() {
      const fingerprint = requestHash({
        v: 1,
        processKind: input.processKind,
        argv: input.argv,
        cwd: input.cwd,
      })
      const resources = input.resourceKeys
      return {
        requestHash: fingerprint,
        resourceKeys: Array.isArray(resources)
          ? resources
          : resources !== undefined && 'writerWorkspace' in resources
            ? [`workspace:${sha256Hex(resources.writerWorkspace)}`]
            : (resources ?? []),
        recoveryClass: 'managed-process-preactivation',
        classifierVersion: 'rfc328-managed-process-v1',
        transportPolicyVersion: 'rfc328-preactivation-v1',
      }
    },
    async recordSpawnReceipt({ receipt, runtimeParamsJson, ...identity }) {
      if (receipt.launchNonce === undefined || receipt.launchNonce.length === 0) {
        throw new Error('task-owned process spawn receipt lacks launch nonce')
      }
      await input.persistence.recordProcessSpawn({
        ...identity,
        pid: receipt.pid,
        spawnBinaryPath: receipt.spawnBinaryPath,
        launchNonce: receipt.launchNonce,
        ...(runtimeParamsJson === undefined ? {} : { runtimeParamsJson }),
      })
    },
    settlementReceipt(result) {
      return JSON.stringify({
        v: 1,
        phase: 'reaped',
        outcome: result.outcome,
        exitCode: result.exitCode,
        pid: result.pid,
        launchNonce: result.launchNonce ?? null,
        drainTimedOut: result.drainTimedOut === true,
        pumpError: result.pumpError ?? null,
      })
    },
  }
}
