// RFC-353 T4（RFC-294 W4-E3）—— knowledge-evolution domain 层的内部聚合出口。
//
// 这不是 public 面：`public/` 才是对外合同（RFC-317 T24 只允许
// commands/queries/participants/events/operations/types 六个 exact 入口）。
// 这里只是给同模块的 application / infrastructure 与迁移期的 legacy 编排一个稳定的取用点，
// 免得每个调用方各自深入到具体文件。

export { isValidFusionTransition } from './fusionStateMachine'
export { jsonArray, rowToFusion } from './fusionRow'
export {
  FUSION_WORKFLOW_DESCRIPTION,
  MERGER_BODY,
  MERGER_DESCRIPTION,
  MERGER_PROMPT_TEMPLATE,
  serializeMemoriesForPrompt,
} from './fusionPrompt'
export {
  canonicalFusionWorkflowDefinition,
  fusionBuiltinWorkflowSeed,
  type FusionBuiltinResourceIdentity,
} from './fusionWorkflowSeed'
