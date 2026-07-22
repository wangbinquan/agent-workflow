// RFC-217 T1 — workgroup sentinel constants, extracted to a ZERO-DEPENDENCY
// leaf module. These ids previously lived in workgroupLaunch.ts, which sits on
// the heavy `launch → task → scheduler → runner → rounds → launch` import
// cycle (workgroupRounds.ts:12-17 pre-move); importing launch just for a
// string constant meant any consumer could observe an undefined top-level
// const under an unlucky module-init order (RFC-079 class of bug, only
// `build:binary` catches it). This module must NEVER import anything — the
// dependency-cruiser `no-circular` rule plus this comment are the guard.
//
// The literal values are WIRE-FROZEN (stored task snapshots / node_runs rows /
// clarify asker keys reference them); renaming the constants is fine, renaming
// the VALUES is a data migration.

/** Fixed ULID-shaped id of the builtin host workflow (lazy seed, ensureWorkgroupHostWorkflow). */
export const WORKGROUP_HOST_WORKFLOW_ID = '00000000000000WORKGROUP00'
export const WORKGROUP_HOST_WORKFLOW_NAME = '__workgroup_host__'

export const WG_LEADER_NODE_ID = '__wg_leader__'
export const WG_MEMBER_NODE_ID = '__wg_member__'
export const WG_CLARIFY_NODE_ID = '__wg_clarify__'
