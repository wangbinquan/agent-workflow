// RFC-349 — provider-neutral terminal human-gate sweep orchestrator.

import type {
  HumanGateTerminalSweepCommand,
  HumanGateTerminalSweepResult,
} from '@/modules/collaboration/application/ports/humanGateTerminalSweep'
import { createLogger } from '@/util/log'

const log = createLogger('terminal-sweep')

export type TerminalSweepResult = HumanGateTerminalSweepResult

export async function sealOpenHumanGatesForTask(
  command: HumanGateTerminalSweepCommand,
  taskId: string,
  cause: string,
): Promise<TerminalSweepResult> {
  const result = await command.run({ taskId, cause })
  if (
    result.sealedSelfRounds > 0 ||
    result.abandonedCrossRounds > 0 ||
    result.canceledRuns.length > 0
  ) {
    log.info(
      `sealed open human gates for terminal task ${taskId} (cause=${cause}): ` +
        `${result.sealedSelfRounds} self round(s), ${result.abandonedCrossRounds} cross round(s), ` +
        `${result.canceledRuns.length} node_run(s)`,
    )
  }
  return result
}
