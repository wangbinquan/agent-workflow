// RFC-341 — bootstrap-only assembly surface for collaboration committed events.

export {
  collaborationCommittedEventCodec,
  createCollaborationDurableConsumerDefinitions,
} from '../application/collaborationCommittedEventConsumers'
export { createHumanGateContinuationWorkerDefinition } from '../application/humanGateContinuationWorker'
// RFC-359 W9：投影合一为一份中立实现，两个 daemon 共用。
export {
  createCollaborationWsProjector,
  createCollaborationCommittedEventProjection,
} from '../infrastructure/collaborationCommittedEventWsProjector'
