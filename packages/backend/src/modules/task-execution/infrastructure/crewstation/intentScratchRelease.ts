// RFC-417: hosted (CrewStation) Intent scratch release, moved verbatim from composition/crewstationExecution.ts.
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { sha256Hex } from '@/util/hash'
import type { HostedExecution } from './execution'

/** The maintenance Worker releases Intent scratch only after every hosted
 * execution that may still write it has settled; it never adopts them. */
export function createHostedIntentScratchRelease(input: {
  readonly executions: Pick<HostedExecution, 'workspaceSettled'>
  readonly helper: WorkspaceHelper
  readonly workspaces: {
    find(taskId: string): Promise<{ readonly businessTaskId: string } | null>
  }
}) {
  const executions = input.executions
  return {
    async removeIntentScratch(turnId: string) {
      const taskId = 'system:intent'
      const key = sha256Hex(turnId)
      if (!(await executions.workspaceSettled(taskId, `/work/system/intent/${key}`)))
        throw new Error('hosted-intent-scratch-execution-unsettled')
      if ((await input.workspaces.find(taskId)) === null) return
      const result = await input.helper.call<{ removed: boolean }>(
        taskId,
        'system-workspace',
        { method: 'release', namespace: 'intent', key },
        { operationId: `intent-scratch:${turnId}:retention` },
      )
      if (!result.removed) throw new Error('hosted-intent-scratch-release-failed')
    },
  }
}
