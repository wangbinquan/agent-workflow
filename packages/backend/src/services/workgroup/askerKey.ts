// RFC-207 §3.7.4 — the directive key for one clarify round.
//
// Shared by the answer-time "stop asking" write and the workgroup host path, so a
// stop lands on exactly the asker the human was answering.
//
// Non-workgroup nodes pass through unchanged: a plain node has no shard and gets
// the '' node-level row (byte-for-byte the pre-RFC-207 behaviour), while an
// ordinary fan-out shard now gets its own row — stopping shard 3's questions no
// longer silences shard 7. That narrowing is intentional and disclosed.

import { wgClarifyAskerKey } from '@agent-workflow/shared'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from './constants'

export function wgClarifyAskerKeyForRound(nodeId: string, shardKey: string | null): string {
  if (nodeId === WG_LEADER_NODE_ID || nodeId === WG_MEMBER_NODE_ID) {
    return wgClarifyAskerKey(nodeId, shardKey, WG_LEADER_NODE_ID)
  }
  return shardKey ?? ''
}
