// RFC-370 §10 V18 (a) — which repository facts scan the selected workspace uses.
import type { AutomationWorkspaceEffectsFactory } from '../application/ports/automationWorkspaceEffects'
import type { RepositoryFactsScanner } from '../infrastructure/repositoryFactsCollector'
import type { RepositoryFactsScan } from '../infrastructure/repositoryFactsScan'

/** The repository facts scan of a volume selection runs next to the files;
 * the native selection (no tree operations) scans in-process. */
export function repositoryFactsScannerOf(
  workspace: AutomationWorkspaceEffectsFactory | undefined,
): RepositoryFactsScanner | undefined {
  const tree = workspace?.treeOperations
  if (tree === undefined) return undefined
  return async (localPath) =>
    (await tree.run('repository-facts-scan', { root: localPath })) as RepositoryFactsScan
}
