import { createClarifyFollowupGeneration } from '../infrastructure/clarifyFollowupGeneration'

/** Use the execution family selected at bootstrap, including hosted execution. */
export function composeClarifyFollowupGenerator(input: {
  db: Parameters<typeof createClarifyFollowupGeneration>[0]['db']
  registry: Parameters<typeof createClarifyFollowupGeneration>[0]['registry']
  binding: Pick<Parameters<typeof createClarifyFollowupGeneration>[0], 'family' | 'bindRuntime'>
}) {
  return createClarifyFollowupGeneration({
    db: input.db,
    registry: input.registry,
    family: input.binding.family,
    bindRuntime: input.binding.bindRuntime,
  })
}
