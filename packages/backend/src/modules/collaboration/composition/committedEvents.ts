// RFC-341 — bootstrap-only assembly surface for collaboration committed events.

export {
  collaborationCommittedEventCodec,
  createCollaborationDurableConsumerDefinitions,
} from '../application/collaborationCommittedEventConsumers'
export { createCollaborationWsProjector } from '../infrastructure/collaborationCommittedEventWsProjector'
