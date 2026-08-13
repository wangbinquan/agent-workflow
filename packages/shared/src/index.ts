// Shared types and schemas between frontend and backend.

export const SHARED_PACKAGE_VERSION = '0.0.0'

export * from './schemas/agent'
export * from './schemas/apiError'
export * from './schemas/changeNarrative' // RFC-239
export * from './schemas/cachedRepo'
export * from './schemas/clarify'
export * from './schemas/config'
export * from './settingsNumericBounds'
export * from './schemas/auth'
export * from './schemas/oidcProvider'
export * from './schemas/resourcePackage'
export * from './schemas/operationRevision'
export * from './schemas/permission'
export * from './schemas/repo'
export * from './schemas/resourceAcl'
export * from './schemas/resourceName' // RFC-264
export * from './schemas/intentChangeset' // RFC-234
export * from './schemas/intentSession' // RFC-234
export * from './schemas/startupVerification' // RFC-280
export * from './schemas/runtimeInventory' // RFC-297
export * from './schemas/importRef'
export * from './schemas/review'
export * from './schemas/runtime'
export * from './schemas/mcp'
export * from './schemas/mcpProbe'
export * from './schemas/mcpRuntimeTest' // RFC-238
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
export * from './schemas/codeIntel' // RFC-258
export * from './schemas/ws'
export * from './sessionView'
export * from './inventory'
export * from './clarify'
export * from './git-url'
export * from './prompt'
export * from './runtimeBuiltins' // RFC-295
export * from './templateAuthority' // RFC-295
export * from './promptFencing' // RFC-200
export * from './templateRef' // RFC-292
export * from './callGoalTemplate' // RFC-292
export * from './triggerContext' // RFC-292
export * from './webhookTriggerContext' // RFC-292
export * from './webhookTaskSourceLink' // RFC-298
export * from './workflowTemplateSurfaces' // RFC-292
export * from './workflowMigration' // RFC-292
export * from './agent-md'
export * from './agent-md-serialize' // RFC-234
export * from './intentSecretSlots' // RFC-234
export * from './intent-dump-serialize' // RFC-234
export * from './skill-md'
export * from './skill-zip'
export * from './outputKinds'
export * from './lifecycle'
export * from './lifecycle-alerts'
export * from './diagnose-repair'
export * from './node-kind-behavior'
export * from './workflow-sync-diff' // RFC-109
export * from './workflow-canonical' // RFC-199
export * from './workflowScope'
export * from './loopPolicy' // RFC-236
export * from './workgroup-canonical' // RFC-225
export * from './mcp-operation' // RFC-201
export * from './plugin-operation' // RFC-201
export * from './workflow-yaml' // RFC-199
export * from './workflow-node-references' // RFC-199 T7.1
export * from './task-questions' // RFC-120
export * from './taskOperations' // RFC-244
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
export * from './scriptNode' // RFC-253
export * from './workflowNodeAncestry' // RFC-269（RFC-253 抽取）
export * from './privilegedNodeRedaction' // RFC-270
// RFC-271 决策 29 — 统一引用模型（归一化 AST + 六域 wire codec + 解析契约）。
export * from './ref'
// RFC-271 — ResourceBundle 表达层（payload / op / 闭合性 / 脱敏投影）。
export * from './bundle'
// RFC-269 — code-host call node: action registry, template encoding and path
// judgements. Trigger context is owned by the source-neutral exports above.
export * from './codeHost/actions'
export * from './codeHost/authorProjection'
export * from './codeHost/path'
export * from './codeHost/template'
export * from './codeHost/templateProjection' // RFC-295
export * from './workflowCalls'
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
// RFC-239 — RFC-088 breaking-risk semantics, hoisted from the frontend so the
// change-group model computes severity identically on both ends. Dependency-free
// leaf (type-only import from the structural-diff schema).
export * from './structureSemantics'
// RFC-239 — deterministic change-group model shared by the overview sidebar
// and the AI-narrative input. Dependency-free leaf.
export * from './changeGroups'
// RFC-248/249 — 仓库组显式目录树。schema 与**纯**布局代数（节点规范化 /
// 子树变换 / 递归展平 / 包含关系 / 排除计划 / 分支序号 / 仓 key）。零 DB /
// 零 fs 依赖，前端编辑与后端物化共用，两边不可能算出不同的布局。
export * from './schemas/repoGroup'
export * from './repoGroupLayout'
export * from './platformEnv'
// RFC-257 — 代码平台 webhook 触发器：事件信封 / 触发器规则 / 三形态启动参数
// 模板封套 / 投递与触发 closed enum，以及模板变量的纯函数面（保存期静态校验
// 与运行期渲染同源）。零 DB / 零 fs 依赖，前后端共用。
export * from './schemas/webhook'
export * from './schemas/codeHost' // RFC-269
export * from './webhookTemplate'
// RFC-262 — upload 文件名净化与落点判重的纯函数面。启动表单提交前与 daemon
// 收到 multipart 后跑的是同一套规则，两边不可能给出不同判定。零依赖叶子。
export * from './uploadNaming'
