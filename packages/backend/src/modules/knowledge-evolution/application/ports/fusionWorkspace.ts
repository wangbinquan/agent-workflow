/** Workspace references retain their historical string representation. Only
 * the selected adapter interprets them as physical directories or volumes. */
export interface FusionSeedGitResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}
/** Preserves the existing test-only seed failure injection. */
export type FusionSeedGit = (workspace: string, args: string[]) => Promise<FusionSeedGitResult>

export type FusionManifestRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-plain-file' }
  | { readonly kind: 'found'; readonly text: string }

export interface FusionWorkspace {
  directory(fusionId: string, iteration: number): string
  versionFiles(skillId: string, contentVersion: number): string
  ensure(reference: string): Promise<void>
  exists(reference: string): Promise<boolean>
  copyContent(source: string, destination: string): Promise<void>
  seedBaseline(reference: string): Promise<string>
  captureResult(
    reference: string,
  ): Promise<{ readonly diff: string; readonly manifest: FusionManifestRead }>
  overlayProposal(source: string, destination: string): Promise<void>
  remove(reference: string): Promise<void>
}

export interface FusionWorkspaceFactory {
  /** Construction captures the binding and performs no workspace effects. */
  create(input: { readonly appHome: string; readonly seedGit?: FusionSeedGit }): FusionWorkspace
}
