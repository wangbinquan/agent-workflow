// RFC-560 (RFC-294 S9 step 15): the fusion engine task port (`FusionEngineTaskOperations`, its launch command and task
// record) left this entry point — it is a consumer-owned required port of knowledge-evolution, declared in
// `application/ports/fusionEngineTasks.ts` and handed to its implementer (task-execution's designated
// knowledge-evolution adapter) through `composition/required-ports.ts`.

// ---------------------------------------------------------------------------
// RFC-353 T7（RFC-294 W4-E3）—— 技能回滚的成员关系协调，KE offered。
//
// resource-catalog 铸新版本、memory 退回记忆，而「回滚时该退回哪些、必须与版本推进
// 同事务」这条规则归 knowledge-evolution。RC 只认识下面这个窄端口（给事务、还 id），
// 既不认识 memory，也不必知道 `aboveVersion` 是怎么算出来的——从而拆掉
// `resource-catalog → memory/infrastructure` 那条跨 context 内部 import（RFC-317 R2）。
//
// 装配在 bootstrap：RFC-294 的目标边表里只有 `knowledge-evolution → resource-catalog`，
// 反向边不存在，所以 RC 不能 import KE；由 `cli/start.ts` / `server.ts` /
// `cli/postgresqlDaemonApplication.ts` 把 KE 铸好的协调器交给 RC 的 composition。
// ---------------------------------------------------------------------------

export type { SkillRestoreMembershipRequest } from '../application/skillRestoreMembership'
export { createAsyncSkillRestoreMembership } from '../application/skillRestoreMembership'
