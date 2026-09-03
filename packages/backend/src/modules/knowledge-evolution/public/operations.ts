// RFC-353 T5（RFC-294 W4-E3）—— knowledge-evolution 的对外**运维**面。
//
// 这一组不是用户命令，是 daemon 生命周期与 system-operations 备份恢复要调的东西：
// 内建资源播种、启动时的 provenance 修复、决策半状态回滚、以及 reconcile 循环体。
//
// `repairFusionProvenance` 的消费者是 `modules/system-operations/composition.ts`
// （RFC-223 备份恢复后要先修 provenance 再放行 fusion 恢复）——跨 context，必须经 public。
// 其余三个的消费者是 `cli/start.ts` 的启动序列，顺序不能变（详见 application 内的注释）。

export {
  recoverFusionDecisions,
  reconcileFusion,
  reconcileRunningFusions,
  repairFusionProvenance,
  seedFusionResources,
  startFusionReconcileLoop,
} from '../application/fusionOrchestration'
