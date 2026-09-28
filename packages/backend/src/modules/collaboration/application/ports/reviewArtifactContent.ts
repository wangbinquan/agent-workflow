/** Content bytes addressed by the review journal's logical key. Labels are
 * diagnostic only; application decisions never interpret a physical path. */
export interface ReviewArtifactContentPort {
  read(reference: string): Promise<{
    readonly body: Uint8Array
    readonly label: string
  } | null>
}
