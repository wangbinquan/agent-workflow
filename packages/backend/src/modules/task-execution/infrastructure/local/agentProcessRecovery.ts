import type {
  AgentProcessRequest,
  AgentProcessResult,
} from '@/platform/execution/local/agentProcess'
import {
  awaitProcessTreeQuiesced,
  isProcessTreeAlive,
  isProcessAlive,
  killStaleRunProcessTree,
  releaseProcessTreeOwnership,
} from '@/util/process'

type NativeStartReceipt = Parameters<NonNullable<AgentProcessRequest['onSpawned']>>[0]

/** All native identity and process-tree evidence stay inside the local adapter.
 * A leader's exit alone does not retire descendants or an unknown Windows job. */
export async function recoverOriginalLocalAgentProcess(
  original: NativeStartReceipt | undefined,
  terminal: AgentProcessResult,
): Promise<boolean> {
  if (
    original === undefined ||
    !Number.isInteger(original.pid) ||
    original.pid <= 0 ||
    original.pid !== terminal.pid ||
    original.launchNonce === undefined ||
    original.launchNonce.length === 0 ||
    original.launchNonce !== terminal.launchNonce ||
    original.spawnBinaryPath.length === 0 ||
    !Number.isFinite(original.spawnedAt) ||
    (terminal.lifecycle !== undefined && terminal.lifecycle.spawnedAt !== original.spawnedAt)
  )
    return false
  const pid = original.pid
  if (
    process.platform === 'win32' &&
    original.jobOwnerPid !== undefined &&
    Number.isSafeInteger(original.jobOwnerPid) &&
    original.jobOwnerPid > 0 &&
    original.jobOwnerPid === terminal.jobOwnerPid &&
    !isProcessAlive(original.jobOwnerPid)
  )
    return true // The original kernel kill-on-close job cannot survive its daemon.
  if (isProcessTreeAlive(pid) === false) {
    releaseProcessTreeOwnership(pid)
    return true
  }
  const outcome = await killStaleRunProcessTree({
    pid,
    startedAt: original.spawnedAt,
    spawnBinaryPath: original.spawnBinaryPath,
    spawnLaunchNonce: original.launchNonce,
  })
  if (outcome !== 'killed' && outcome !== 'not-alive') return false
  if ((await awaitProcessTreeQuiesced(pid)) !== 'dead') return false
  releaseProcessTreeOwnership(pid)
  return true
}
