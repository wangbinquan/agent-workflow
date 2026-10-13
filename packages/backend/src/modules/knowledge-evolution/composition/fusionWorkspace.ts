import type { FusionWorkspace, FusionWorkspaceFactory } from '../application/ports/fusionWorkspace'

const methods = [
  'directory',
  'versionFiles',
  'ensure',
  'exists',
  'copyContent',
  'seedBaseline',
  'captureResult',
  'overlayProposal',
  'remove',
] as const

export function selectFusionWorkspaceFactory(
  factory: FusionWorkspaceFactory,
): FusionWorkspaceFactory {
  const create = factory?.create
  if (typeof create !== 'function') throw new Error('fusion-workspace-factory-incomplete')
  return Object.freeze({
    create(input) {
      const workspace = create.call(factory, input)
      const captured = {
        directory: workspace?.directory,
        versionFiles: workspace?.versionFiles,
        ensure: workspace?.ensure,
        exists: workspace?.exists,
        copyContent: workspace?.copyContent,
        seedBaseline: workspace?.seedBaseline,
        captureResult: workspace?.captureResult,
        overlayProposal: workspace?.overlayProposal,
        remove: workspace?.remove,
      }
      for (const method of methods) {
        if (typeof captured[method] !== 'function')
          throw new Error('fusion-workspace-binding-incomplete')
      }
      // Capture every method/receiver before a catalog or persistence await.
      return Object.freeze({
        directory: captured.directory.bind(workspace),
        versionFiles: captured.versionFiles.bind(workspace),
        ensure: captured.ensure.bind(workspace),
        exists: captured.exists.bind(workspace),
        copyContent: captured.copyContent.bind(workspace),
        seedBaseline: captured.seedBaseline.bind(workspace),
        captureResult: captured.captureResult.bind(workspace),
        overlayProposal: captured.overlayProposal.bind(workspace),
        remove: captured.remove.bind(workspace),
      } satisfies FusionWorkspace)
    },
  } satisfies FusionWorkspaceFactory)
}
