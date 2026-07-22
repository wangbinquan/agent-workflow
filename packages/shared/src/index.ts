// Shared types and schemas between frontend and backend.

export const SHARED_PACKAGE_VERSION = '0.0.0'

export * from './schemas/agent'
export * from './schemas/apiError'
export * from './schemas/cachedRepo'
export * from './schemas/clarify'
export * from './schemas/config'
export * from './schemas/oidcProvider'
export * from './schemas/operationRevision'
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
export * from './schemas/overview' // RFC-190
export * from './schemas/task'
export * from './schemas/scheduledTask' // RFC-159
export * from './schemas/taskCollab'
export * from './schemas/taskFeedback'
export * from './schemas/user'
export * from './schemas/workflow'
export * from './schemas/workgroup' // RFC-164
export * from './schemas/workgroupRuntime' // RFC-164 PR-2
export * from './schemas/sessionView'
export * from './schemas/structuralDiff'
export * from './schemas/ws'
export * from './sessionView'
export * from './inventory'
export * from './clarify'
export * from './git-url'
export * from './prompt'
export * from './promptFencing' // RFC-200
export * from './agent-md'
export * from './skill-md'
export * from './skill-zip'
export * from './outputKinds'
export * from './lifecycle'
export * from './lifecycle-alerts'
export * from './diagnose-repair'
export * from './node-kind-behavior'
export * from './workflow-sync-diff' // RFC-109
export * from './workflow-canonical' // RFC-199
export * from './mcp-operation' // RFC-201
export * from './plugin-operation' // RFC-201
export * from './workflow-yaml' // RFC-199
export * from './workflow-node-references' // RFC-199 T7.1
export * from './task-questions' // RFC-120
// RFC-060 PR-E: removed `./sharding` (was RFC-055 agent-multi sharding strategy
// helpers — agent-multi NodeKind has been removed in favor of wrapper-fanout).
export * from './kindParser'
export * from './agentCapability' // RFC-166
// RFC-167 generation protocol (orchestrator output → WorkflowDefinition). The
// separate `dynamic_workflow_spaces` resource was reverted (2026-07-11 pivot:
// dynamic workflow became a workgroup mode); only the generation protocol +
// conversion survive, reused by the workgroup dynamic-mode engine.
export * from './dynamicWorkflow' // RFC-167
export * from './agentLaunchForm' // RFC-218
export * from './shardingRegistry'
export * from './signalPromptGuard'
export * from './wrapperFanout'
export * from './nodePorts'
export * from './systemChannelPorts'
export * from './scheduleTime' // RFC-159
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
// RFC-154 — per-runtime config-dir injection profile (protocol defaults +
// reserved spawn env keys). Dependency-free leaf.
export * from './runtimeConfigDir'
