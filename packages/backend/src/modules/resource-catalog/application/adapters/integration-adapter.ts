import type { IntegrationTriggerSnapshotFactory } from '@/modules/integration/composition/required-ports'

export function composeIntegrationTriggerSnapshotFactory(
  source: IntegrationTriggerSnapshotFactory,
): IntegrationTriggerSnapshotFactory {
  return { inTransaction: (tx, pair) => source.inTransaction(tx, pair) }
}
