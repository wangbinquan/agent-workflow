import {
  nativeUsageRootHeads,
  nativeUsageRootTransitions,
  nativeUsageRootSets,
  nativeUsageRootResults,
  nativeUsagePreparations,
  nativeUsageStoreBindings,
  nativeUsagePasses,
  nativeUsagePassHeads,
  nativeUsagePassPages,
  nativeUsageSessionParents,
  nativeUsageStepMembers,
  nativeUsageEmissions,
  nativeUsageRevisionHeads,
  taskExecutionObservationSources,
} from '@/db/schema'
import { systemAgentNativeUsage, systemAgentObservationSources } from '@/db/observationSystem'
import type { NativeUsageReadBinding } from '../application/ports/nativeUsageReadBinding'

const task = Object.freeze({
  nativeUsageRootHeads,
  nativeUsageRootTransitions,
  nativeUsageRootSets,
  nativeUsageRootResults,
  nativeUsagePreparations,
  nativeUsageStoreBindings,
  nativeUsagePasses,
  nativeUsagePassHeads,
  nativeUsagePassPages,
  nativeUsageSessionParents,
  nativeUsageStepMembers,
  nativeUsageEmissions,
  nativeUsageRevisionHeads,
  taskExecutionObservationSources,
  sourcePrefix: 'local-node:',
})
const system = Object.freeze({
  ...systemAgentNativeUsage,
  taskExecutionObservationSources: systemAgentObservationSources,
  sourcePrefix: 'system-agent:',
})

/** Explicit selection retains original Task FK/claim semantics and System's own source IDs. */
export function nativeUsageEvidenceStorage(kind: NativeUsageReadBinding['sourceKind'] = 'task') {
  return kind === 'system' ? system : task
}
