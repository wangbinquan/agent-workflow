import { createDesignAssistGeneration } from '../infrastructure/designAssistGeneration'
export function composeDesignAssistGeneration(input: {
  registry: Parameters<typeof createDesignAssistGeneration>[0]['registry']
  getDefaultRuntime: Parameters<typeof createDesignAssistGeneration>[0]['getDefaultRuntime']
  binding: Pick<Parameters<typeof createDesignAssistGeneration>[0], 'family' | 'bindRuntime'>
}) {
  return createDesignAssistGeneration({
    registry: input.registry,
    getDefaultRuntime: input.getDefaultRuntime,
    ...input.binding,
  })
}
