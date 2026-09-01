export interface PluginGenerationReferenceReadPort {
  listReferencedCachedPaths(): Promise<readonly string[]>
}

export interface PluginGenerationFilesystemGcPort {
  hasCandidates(): Promise<boolean>
  collect(input: {
    readonly referencedCachedPaths: ReadonlySet<string>
    readonly graceMs?: number
    readonly now?: number
  }): Promise<readonly string[]>
}
