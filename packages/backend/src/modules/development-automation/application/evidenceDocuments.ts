/** Logical bundle membership and exact document bytes; JSON policy stays with DA. */
export interface EvidenceDocumentQueries {
  readText(input: {
    readonly bundleRef: string
    readonly relativePath: string
  }): string | null | Promise<string | null>
}
