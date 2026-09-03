// RFC-353 T5（RFC-294 W4-E3）—— knowledge-evolution 的对外**查询**面。
//
// design §638 给 KE 列的查询是 `GetFusionView / ListFusionSummaries / GetSkillProvenance`。
// 前两个在本刀落；`GetSkillProvenance` 是 T9 的新功能。

export {
  awaitingApprovalFusionOwners,
  getFusion,
  listFusionSummaries,
} from '../application/fusionOrchestration'

// RFC-353 T8：带可见性的三条——路由只解 viewer，判据在 application / domain。
export {
  countVisibleAwaitingApprovalFusions,
  getVisibleFusion,
  listVisibleFusionSummaries,
  type FusionViewer,
} from '../application/fusionViews'

// RFC-353 T9：`GetSkillProvenance` —— 「这个技能的第 N 版是怎么来的、吃进了哪些知识」。
export {
  bindSkillProvenanceDeps,
  getSkillProvenance,
  type SkillProvenanceDeps,
} from '../application/skillProvenanceQuery'
