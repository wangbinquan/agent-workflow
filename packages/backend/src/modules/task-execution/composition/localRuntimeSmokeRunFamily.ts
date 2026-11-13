import type {
  NativeMaterialDefinitions,
  NativeMaterialWorkspaces,
} from '../infrastructure/local/nativeRunFamilyProviders'
import {
  createLocalRuntimeSmokeRunFamily,
  type LocalRuntimeSmokeRunFamilyInput,
} from '../infrastructure/local/runtimeSmokeRunFamily'

/** RFC-489: the runtime-management providers of the native smoke run family (bootstrap passes them in). */
export interface LocalRuntimeSmokeRunProviders {
  readonly materialWorkspaces: NativeMaterialWorkspaces
  readonly materialDefinitions: NativeMaterialDefinitions
}

/** The native root pairs the target owner, original material builder and
 * executor. The normal family never receives their physical locations. RFC-422: the opener is
 * infrastructure/local/runtimeSmokeRunFamily.ts. RFC-489: the runtime-management providers arrive from bootstrap;
 * the protocol and evidence come from the material definition, so no driver is read here. */
export function composeLocalRuntimeSmokeRunFamily(
  input: LocalRuntimeSmokeRunFamilyInput,
  providers: LocalRuntimeSmokeRunProviders,
) {
  return createLocalRuntimeSmokeRunFamily(input, {
    materialWorkspaces: providers.materialWorkspaces,
    materialDefinitions: providers.materialDefinitions,
  })
}
