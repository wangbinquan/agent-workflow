export interface GraphArtifactReference {
  readonly artifactRef: string
  readonly digest: string
}

/** Uses the selected DA artifact provider, including hosted material transfer. */
export interface GraphDesignArtifacts {
  put(
    files: readonly { readonly path: string; readonly content: string }[],
  ): Promise<GraphArtifactReference>
  read(reference: GraphArtifactReference, path: string): Promise<string | null>
  files(
    reference: GraphArtifactReference,
  ): Promise<readonly { readonly path: string; readonly content: string }[]>
}
