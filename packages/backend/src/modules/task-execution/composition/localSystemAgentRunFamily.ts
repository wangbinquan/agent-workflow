import type {
  NativeMaterialDefinitions,
  NativeSystemAgentContents,
} from '../infrastructure/local/nativeRunFamilyProviders'
import {
  createLocalSystemAgentRunFamily,
  type LocalSystemAgentRunFamilyInput,
  type LocalSystemAgentRuntimes,
} from '../infrastructure/local/systemAgentRunFamily'

/** RFC-489: the runtime-management providers of the native system agent run family (bootstrap passes them in). `Bind`
 * is the runtime binding the family hands back unchanged. */
export interface LocalSystemAgentRunProviders<Bind> {
  /** The system agent runtime bindings. */
  runtimes(): LocalSystemAgentRuntimes<Bind>
  /** The retained contents over this family's input. */
  contents(input: LocalSystemAgentRunFamilyInput): NativeSystemAgentContents
  readonly materialDefinitions: NativeMaterialDefinitions
}

/** Native facts and fake-run projection are selected only by an explicit root. RFC-422: the opener is
 * infrastructure/local/systemAgentRunFamily.ts. RFC-489: the runtime-management providers arrive from bootstrap. */
export function composeLocalSystemAgentRunFamily<Bind>(
  input: LocalSystemAgentRunFamilyInput,
  providers: LocalSystemAgentRunProviders<Bind>,
) {
  return createLocalSystemAgentRunFamily(input, {
    runtimes: providers.runtimes(),
    contents: providers.contents(input),
    materialDefinitions: providers.materialDefinitions,
  })
}
