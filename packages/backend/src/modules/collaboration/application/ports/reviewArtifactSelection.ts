import type { HumanGateArtifactStore } from './humanGateArtifactStore'
import type { ReviewArtifactContentPort } from './reviewArtifactContent'

/** Selected once by the assembly root; every review journal reader and writer
 * must use the same content owner, including recovery and route mutations. */
export interface ReviewArtifactSelection {
  readonly store: HumanGateArtifactStore
  readonly content: ReviewArtifactContentPort
}
