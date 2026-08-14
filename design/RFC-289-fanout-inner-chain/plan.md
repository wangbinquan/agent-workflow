# RFC-289 — 任务分解（plan）

> **本 RFC 已于 2026-08-14 CLOSED（未实现，零生产改动）**——见 `proposal.md` 顶部。
> 下面的批次**不再执行**；重写时以 RFC-294 §5.3 的五条要求为起点，不要照搬本表。

> 前置：RFC-287 实现完毕（骨架先行，锚基线随其终态重定）；RFC-288 与本 RFC
> 同文件严格串行（D3 顺序 287→288→289）。**落档后须用户批准方可实现**。

## 批次

- T1 逐锚复核（289 基线在 287/288 落地后必然全体位移）+ s05 翻转预案表
  （逐断言旁注核对）+ 26 测试文件面清单复核。
- T2 纯函数层：pickShardUpstreamRun + topoSortInner + 直测（正/边界/环/回退）。
- T3 resolveUpstreamInputs 接 shardCtx + dispatchFanoutShard 喂入（G1）+
  consumed-gate 复用失效链回归。
- T4 拓扑序派发（G2）+ 运行时防御两码 + s05 层 1/3 翻转（红→绿：sentinel
  断言先红后绿）。
- T5 validator 挡板置换（G3）+ i18n/前端 target 同步 + rfc094 正反例改判 +
  s05 层 2 翻转。
- T6 e2e 双 inner 链 + routing 源码锁逐条改锚 + 零变化锁全家复跑。
- T7 文档与账本：08-12 审计 :147 锚勘误落档、标签三义正名（design/design.md
  §6.3 引注补充）、路线表/STATE（解封后）。
- T8 实现门（双路独立子代理）+ findings 处置。

## 依赖

T2→T3→T4 串行主链；T5 可与 T4 并批（同刀不同文件）；T6/T7/T8 收尾。

## 验收清单

- [ ] AC-1…AC-6（proposal §5）
- [ ] 能力影响清单口径复核（纯扩张零收缩）
- [ ] 测绘地图更新为终态
