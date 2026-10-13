import { z } from 'zod'
import { hostname } from 'node:os'
import type { AgentProcessRequest } from '@/platform/execution/local/agentProcess'
import type { ExecutionRecoveryReferencePort } from '../../application/ports/executionEffect'
import { recoverOriginalLocalAgentProcess } from './agentProcessRecovery'
import { MANAGED_PROCESS_LAUNCHER_SUBCOMMAND } from '@/platform/execution/local/managedProcessLauncher'
import {
  awaitProcessTreeQuiesced,
  killProcessTree,
  releaseProcessTreeOwnership,
} from '@/util/process'

type NativeStartReceipt = Parameters<NonNullable<AgentProcessRequest['onSpawned']>>[0]
const prefix = 'aw-local-execution-recovery-v1:'
const preparedPrefix = 'aw-local-prepared-recovery-v1:'
const preparedIdentity = z
  .object({
    hostname: z.string().min(1),
    platform: z.string().min(1),
    executionRef: z.string().min(1),
    ownerPid: z.number().int().positive(),
    launchNonce: z.string().uuid(),
  })
  .strict()
const nativeReceipt = z
  .object({
    hostname: z.string().min(1),
    platform: z.string().min(1),
    executionRef: z.string().min(1),
    pid: z.number().int().positive(),
    spawnedAt: z.number().finite().nonnegative(),
    spawnBinaryPath: z.string().min(1),
    launchNonce: z.string().min(1),
    jobOwnerPid: z.number().int().positive().optional(),
  })
  .strict()

/** Binary/PID/nonce remain in the selected native receipt dialect, never DTO fields. */
export function encodeLocalAgentExecutionRecoveryReference(
  executionRef: string,
  original: NativeStartReceipt,
): string | undefined {
  const parsed = nativeReceipt.safeParse({
    executionRef,
    hostname: hostname(),
    platform: process.platform,
    ...original,
  })
  return parsed.success
    ? prefix + Buffer.from(JSON.stringify(parsed.data)).toString('base64url')
    : undefined
}

/** Reserved only for a real receipt-gated native launcher. Its target cannot
 * run until the consumer's durable started ACK has completed. */
export function encodeLocalPreparedExecutionRecoveryReference(
  executionRef: string,
  launchNonce: string,
): string {
  const value = preparedIdentity.parse({
    hostname: hostname(),
    platform: process.platform,
    executionRef,
    ownerPid: process.pid,
    launchNonce,
  })
  return preparedPrefix + Buffer.from(JSON.stringify(value)).toString('base64url')
}

async function recoverPreparedIdentity(value: z.infer<typeof preparedIdentity>): Promise<boolean> {
  // The original owner must be dead. A live/reused PID or an unavailable
  // liveness check keeps this reservation unknown, without signaling it.
  try {
    process.kill(value.ownerPid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
  }
  let launchers: number[]
  try {
    const matches = (command: string) =>
      command.includes(MANAGED_PROCESS_LAUNCHER_SUBCOMMAND) && command.includes(value.launchNonce)
    if (process.platform === 'win32') {
      const result = Bun.spawnSync([
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine)',
      ])
      if (result.exitCode !== 0) return false
      const rows = z
        .array(
          z.object({
            ProcessId: z.number().int().nonnegative(),
            CommandLine: z.string().nullable(),
          }),
        )
        .parse(JSON.parse(result.stdout.toString()))
      launchers = rows
        .filter((row) => row.ProcessId > 0 && row.CommandLine !== null && matches(row.CommandLine))
        .map((row) => row.ProcessId)
    } else {
      const result = Bun.spawnSync(['ps', '-ww', '-axo', 'pid=,command='])
      if (result.exitCode !== 0) return false
      launchers = []
      for (const line of result.stdout.toString().split('\n')) {
        const row = /^\s*(\d+)\s+(.*)$/.exec(line)
        if (row && matches(row[2]!)) launchers.push(Number(row[1]))
      }
    }
  } catch {
    return false
  }
  for (const pid of launchers) {
    killProcessTree(pid, 'SIGKILL')
    if ((await awaitProcessTreeQuiesced(pid)) !== 'dead') return false
    releaseProcessTreeOwnership(pid)
  }
  // Before the started ACK there is no activated target. The dead original
  // parent cannot send a future frame; any remaining original helper is reaped.
  return true
}

export function createLocalAgentExecutionRecoveryReferences(): ExecutionRecoveryReferencePort {
  return Object.freeze<ExecutionRecoveryReferencePort>({
    async recoverReference(input) {
      const unknown = { executionRef: input.executionRef, state: 'unknown' as const }
      if (input.recoveryRef.startsWith(preparedPrefix) && input.recoveryRef.length <= 16384) {
        try {
          const value = preparedIdentity.parse(
            JSON.parse(
              Buffer.from(input.recoveryRef.slice(preparedPrefix.length), 'base64url').toString(
                'utf8',
              ),
            ),
          )
          if (
            value.executionRef !== input.executionRef ||
            value.hostname !== hostname() ||
            value.platform !== process.platform
          )
            return unknown
          const reaped = await recoverPreparedIdentity(value)
          return { executionRef: input.executionRef, state: reaped ? 'reaped' : 'unknown' }
        } catch {
          return unknown
        }
      }
      if (!input.recoveryRef.startsWith(prefix) || input.recoveryRef.length > 16384) return unknown
      let value: unknown
      try {
        value = JSON.parse(
          Buffer.from(input.recoveryRef.slice(prefix.length), 'base64url').toString('utf8'),
        )
      } catch {
        return unknown
      }
      const parsed = nativeReceipt.safeParse(value)
      if (
        !parsed.success ||
        parsed.data.executionRef !== input.executionRef ||
        parsed.data.hostname !== hostname() ||
        parsed.data.platform !== process.platform
      )
        return unknown
      const executionRef = parsed.data.executionRef
      const original: NativeStartReceipt = {
        pid: parsed.data.pid,
        spawnedAt: parsed.data.spawnedAt,
        spawnBinaryPath: parsed.data.spawnBinaryPath,
        launchNonce: parsed.data.launchNonce,
        ...(parsed.data.jobOwnerPid === undefined ? {} : { jobOwnerPid: parsed.data.jobOwnerPid }),
      }
      const reaped = await recoverOriginalLocalAgentProcess(original, {
        outcome: 'unreaped',
        pid: original.pid,
        launchNonce: original.launchNonce,
        ...(original.jobOwnerPid === undefined ? {} : { jobOwnerPid: original.jobOwnerPid }),
        lifecycle: { spawnedAt: original.spawnedAt, reapedAt: null, drainedAt: null },
        exitCode: null,
        rawStdout: '',
        stderrTail: '',
        durationMs: 0,
      })
      return { executionRef, state: reaped ? 'reaped' : 'unknown' }
    },
  })
}
