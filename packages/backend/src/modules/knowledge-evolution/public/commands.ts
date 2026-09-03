// RFC-353 T5（RFC-294 W4-E3）—— knowledge-evolution 的对外**命令**面。
//
// design §638 给 KE 列的命令是
// `StartFusion / ApproveFusion / RejectFusion / RetryFusion / RestoreSkillVersion`。
// 本刀先把已有的四个（发起 / 批准 / 拒绝重跑 / 取消）从 application 暴露出来；
// `RestoreSkillVersion` 在 T7 随 skill-restore coordinator 迁入后加进来。
//
// 为什么必须有这一层：`routes/fusions.ts` 与 `cli/start.ts` 此前直接 import
// `application/`——那是 RFC-317 R1 明令禁止的「legacy 消费模块内部」。
// public 面存在之后，它们消费的是 KE 承诺的合同，而不是它此刻的实现布局。

export {
  approveFusion,
  cancelFusion,
  createFusion,
  rejectFusion,
  type FusionDeps,
} from '../application/fusionOrchestration'
