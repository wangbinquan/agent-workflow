import {
  createLocalSystemAgentRetainedContents,
  createLocalSystemAgentRuntimeBindings,
} from '@/modules/runtime-management/composition/systemAgentMaterial'
import { selectLocalAgentMaterialDefinition } from '@/modules/runtime-management/composition/localAgentMaterial'
import {
  createLocalSystemAgentRunFamily,
  type LocalSystemAgentRunFamilyInput,
} from '../infrastructure/local/systemAgentRunFamily'

/** Native facts and fake-run projection are selected only by an explicit root. RFC-422: the opener is
 * infrastructure/local/systemAgentRunFamily.ts; this root selects the runtime-management providers. */
export function composeLocalSystemAgentRunFamily(input: LocalSystemAgentRunFamilyInput) {
  return createLocalSystemAgentRunFamily(input, {
    runtimes: createLocalSystemAgentRuntimeBindings(),
    contents: createLocalSystemAgentRetainedContents(input),
    materialDefinitions: selectLocalAgentMaterialDefinition,
  })
}
