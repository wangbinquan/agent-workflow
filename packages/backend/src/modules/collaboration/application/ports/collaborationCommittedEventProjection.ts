import type {
  CollaborationCommittedV1,
  CollaborationProjectionFrame,
} from '../../domain/collaborationCommittedEvent'

/** Provider-selected read model for legacy payloads whose committed event did
 * not yet carry its complete websocket projection. */
export interface CollaborationCommittedEventProjection {
  frames(event: CollaborationCommittedV1): Promise<readonly CollaborationProjectionFrame[]>
}
