export interface CommittedReviewArtifactReader {
  read(finalPath: string): Promise<string>
}
