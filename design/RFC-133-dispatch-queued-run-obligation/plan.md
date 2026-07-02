# RFC-133 任务分解

单 RFC 单 PR(默认约定);commit 前缀 `feat(clarify): RFC-133 …`。依赖:T1 → {T2, T3};
T4、T5 与 T2/T3 可并行;T6 收口。

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| RFC-133-T1 | oracle 改造:`isDispatchedEntryConsumed` in-flight NULL 分支改「run 义务 + cause 序列化」判定(design §2.1 (a)(b)),Pick 加宽(两 target 列 + roleKind)+ 可选参 `mintCause`;`causeClassForEntry` 迁移导出到 `clarifyRerunLedger.ts`;单元矩阵 case 1-8 + `clarify-rerun-ledger-deadlock.test.ts:272` 锁修订 | — |
| RFC-133-T2 | dispatch 集成:QMGP5 复现 e2e(case 9,先红后绿)、idle 同 cause 变体(10)、异 cause 仍 409(11,Codex P2)、pending/running 仍 409 回归(12);`findOpenDispatchTarget` 接 `mintCauseByTarget`(预检+in-tx 复检同份) | T1 |
| RFC-133-T3 | quick 路径集成:`hasOpenDispatchedEntryOnHome` 加 `mintCause` 必传参(三调用点静态 cause);clarify / crossClarify quick-finalize 同 cause 放行 / 异 cause + pending 仍拒(case 13);`clarifyAutoDispatch` 现有测试回归确认 | T1 |
| RFC-133-T4 | 报错 details:`findOpenDispatchTarget` 返回体加宽、`NodeDispatchInFlight` 携带、三处 ConflictError 挂 `details` + message 改写(design §3);case 14 | T1 |
| RFC-133-T5 | 前端:看板 staged 勾选(excluded 反选集)+「下发所选 (N)」+ 0 选禁用;`DISPATCH_ERROR_KEYS` 命中走 `t(key, {node})` + zh/en 文案插值;vitest case 15-18;RFC-128 §11.1 注释改写 | T4(文案联动) |
| RFC-133-T6 | 收口:全门槛(typecheck / bun test / format:check / 前端 vitest / build:binary smoke)+ push 查 CI;live 验证 QMGP5 第 5 批原样下发成功、任务离开 awaiting_human;STATE.md / plan.md 索引置 Done | T1-T5 |

验收清单 = proposal §5(1-6 全项)。

风险与缓解:

- 锁定测试(deadlock:272)语义修订必须在同 commit 内完成并注明本 RFC,避免出现「红 case
  被顺手改绿」的观感——T1 的 diff 里测试与实现同进。
- 并发防护回归风险靠 case 12 + 既有 in-tx 复检测试兜底;新谓词不新增 tx 读(design §2.3)。
- 异 cause 塌缩风险(Codex 设计 gate P2,2026-07-02 fold)由谓词 (b) 项 + case 7/11/13
  锁定;`mintCause` 语义=「本次会在该目标 mint」,非 frontier 排队不受影响。
- 前端勾选引入的 selection 漂移(refetch/新问题进入)用反选集设计规避(design §4),
  case 13-15 锁定。
