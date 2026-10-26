// Composition exposes the selected artifact adapter; persistence stays in infrastructure.
export {
  createContentReviewArtifacts,
  createLocalReviewArtifacts,
  createContentHumanGateArtifactStore,
} from '../infrastructure/contentReviewArtifacts'
