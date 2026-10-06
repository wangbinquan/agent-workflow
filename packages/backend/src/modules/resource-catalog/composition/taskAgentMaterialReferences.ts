import { createLocalTaskAgentMaterialReferences } from '../infrastructure/local/taskAgentMaterialReferences'

/** Explicit native bootstrap binding; callers may select another complete owner. */
export function composeLocalTaskAgentMaterialReferences(input: { readonly appHome: string }) {
  return createLocalTaskAgentMaterialReferences(input)
}
