// RFC-417: the hosted workspace command reconciliation owner, moved verbatim from composition/crewstationExecution.ts.
import type { HostedWorkspaceCommands } from '@/modules/source-control/public/participants'
import type { Logger } from '@/util/log'

const SETTLEMENT_INTERVAL_MS = 60_000

/** Commands of earlier owners are settled from their platform result; a long
 * one never delays the next pass (in-flight rows are skipped). */
export function createHostedWorkspaceCommandReconciliation(input: {
  readonly commands: Pick<HostedWorkspaceCommands, 'reconcile'>
  readonly log: Pick<Logger, 'warn'>
}) {
  return {
    id: 'hosted-workspace-command-reconciliation',
    async run(signal: AbortSignal) {
      while (!signal.aborted) {
        input.commands.reconcile(signal).catch((error: unknown) => {
          input.log.warn('hosted workspace command reconciliation failed', {
            reason: error instanceof Error ? error.message : String(error),
          })
        })
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, SETTLEMENT_INTERVAL_MS)
          function done(): void {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
          }
          signal.addEventListener('abort', done, { once: true })
        })
      }
    },
  }
}
