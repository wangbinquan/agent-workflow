// Shared types and schemas between frontend and backend.

export const SHARED_PACKAGE_VERSION = '0.0.0'

export * from './schemas/agent'
export * from './schemas/apiError'
export * from './schemas/cachedRepo'
export * from './schemas/clarify'
export * from './schemas/config'
export * from './schemas/oidcProvider'
export * from './schemas/permission'
export * from './schemas/repo'
export * from './schemas/resourceAcl'
export * from './schemas/review'
export * from './schemas/runtime'
export * from './schemas/mcp'
export * from './schemas/mcpProbe'
export * from './schemas/fusion'
export * from './schemas/memory'
export * from './schemas/plugin'
export * from './schemas/repoBatchImport'
export * from './schemas/skill'
export * from './schemas/skillVersion'
export * from './schemas/task'
export * from './schemas/taskCollab'
export * from './schemas/taskFeedback'
export * from './schemas/user'
export * from './schemas/workflow'
export * from './schemas/sessionView'
export * from './schemas/structuralDiff'
export * from './schemas/ws'
export * from './sessionView'
export * from './inventory'
export * from './clarify'
export * from './git-url'
export * from './prompt'
export * from './agent-md'
export * from './skill-md'
export * from './skill-zip'
export * from './outputKinds'
export * from './lifecycle'
export * from './lifecycle-alerts'
export * from './diagnose-repair'
export * from './node-kind-behavior'
export * from './workflow-sync-diff' // RFC-109
export * from './task-questions' // RFC-120
// RFC-060 PR-E: removed `./sharding` (was RFC-055 agent-multi sharding strategy
// helpers — agent-multi NodeKind has been removed in favor of wrapper-fanout).
export * from './kindParser'
export * from './shardingRegistry'
export * from './signalPromptGuard'
export * from './wrapperFanout'
export * from './nodePorts'
export * from './worktree-files'
// RFC-079 — review multi-document mode pure helpers.
export * from './reviewMultiDoc'
// RFC-079 — list wire-form splitter. Re-exported from its dependency-free
// module (NOT outputKinds/list) so the barrel never pulls the parametric
// handler registry into a module-init cycle (see listWire.ts header).
export * from './listWire'
// RFC-083 — structural-diff symbol-graph set-diff + summary aggregation.
// Dependency-free leaf (type-only import from the schema), re-exported here so
// the barrel never drags a registry-coupled module into a module-init cycle
// (same discipline as listWire; see structuralDiffGraph.ts header).
export * from './structuralDiffGraph'
