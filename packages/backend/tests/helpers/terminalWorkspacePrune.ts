// RFC-569 — the suites' one-off terminal workspace prune policies. The policy is a closed interface with one method;
// this builds it from the decision function a case writes inline.
import type { TerminalWorkspacePrunePolicy } from '@/modules/task-execution/domain/terminalWorkspacePrune'

export function prunePolicyOf(
  decide: TerminalWorkspacePrunePolicy['decide'],
): TerminalWorkspacePrunePolicy {
  return { decide }
}
