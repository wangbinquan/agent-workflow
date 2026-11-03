// RFC-431: the graph-development artifact store and verification commands are deployment selections
// (`graphDevelopmentArtifacts`, `verificationCommands`); only the request-artifact view is composed here.
import { createGraphDesignArtifacts } from '../infrastructure/graph-development/designArtifacts'

export const graphDevelopmentRequestArtifacts = createGraphDesignArtifacts
