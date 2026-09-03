// RFC-353 T5（RFC-294 W4-E3）—— knowledge-evolution 的对外**查询**面。
//
// design §638 给 KE 列的查询是 `GetFusionView / ListFusionSummaries / GetSkillProvenance`。
// 前两个在本刀落；`GetSkillProvenance` 是 T9 的新功能。

export {
  awaitingApprovalFusionOwners,
  getFusion,
  listFusionSummaries,
} from '../application/fusionOrchestration'
