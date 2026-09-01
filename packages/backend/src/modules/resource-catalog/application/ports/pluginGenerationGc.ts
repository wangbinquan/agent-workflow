export interface PluginGenerationReferenceReadPort {
  listReferencedCachedPaths(): Promise<readonly string[]>
}

export interface PluginGenerationFilesystemGcPort {
  hasCandidates(input: { readonly graceMs?: number; readonly now?: number }): Promise<boolean>
  collect(input: {
    readonly referencedCachedPaths: ReadonlySet<string>
    readonly graceMs?: number
    readonly now?: number
  }): Promise<readonly string[]>
}
