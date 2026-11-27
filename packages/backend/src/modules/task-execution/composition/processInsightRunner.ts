import { createProcessInsightGeneration } from '../infrastructure/processInsightGeneration'

/** RFC-616 §9.3: the text-theme analysis runner on the execution family selected at bootstrap. */
export function composeProcessInsightRunner(input: {
  registry: Parameters<typeof createProcessInsightGeneration>[0]['registry']
  binding: Pick<Parameters<typeof createProcessInsightGeneration>[0], 'family' | 'bindRuntime'>
  runtimeSelection: Parameters<typeof createProcessInsightGeneration>[0]['runtimeSelection']
}) {
  return createProcessInsightGeneration({
    registry: input.registry,
    family: input.binding.family,
    bindRuntime: input.binding.bindRuntime,
    runtimeSelection: input.runtimeSelection,
  })
}
