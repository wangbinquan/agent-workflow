# RFC-287 — 任务分解（plan）

> 前置：RFC-284/285/286 已完工。**本 RFC 落档后须用户批准方可实现**
> （CLAUDE.md RFC workflow §3）。每批第一子任务=逐锚复核（行号基线 83088a83）。

## 批次

- T1 逐锚复核 + 对拍基线：九线锚点核对；L4 三台机器（envelope-followup /
  clarify-flip / session 继承）现状行为夹具落档（拆分前 oracle）。
- T2 骨架落地（G1）：assembly.ts + 单元测试（pools/keep/merge 三态/
  漂移 A 语义）；此批不迁移任何线。
- T3 L6 迁移（最小对照）+ fanout aggregator 全家绿。
- T4 L5 迁移（beforeSpawn=T14 undo 钩子）+ shard 全家绿。
- T5 L7 迁移 + **漂移 A 红→绿对**（merge 抛出：楔死复现 → keep+
  markMergeFailed）+ rfc253 全家绿；F6 设计门注释改写。
- T6 L1 迁移（preResolved 行变体）+ workgroup 全家绿。
- T7 L4 拆分手术（outer/inner + retryPolicy 策略对象）+ rfc119/123/131/
  161/193 全家 + 拆分对拍夹具绿。
- T8 取行前奏收编 resolveSchedulerRunRow（4 份 → 1 + overrides）+
  L8 preResolved 短路。
- T9 G3 豁免显式化四锁 + 终局灭绝锁（骨架外散写归零）。
- T10 实现门（双路独立子代理）+ plan/STATE 记账。

## 依赖

- T2 依赖 T1；T3-T6 依赖 T2、彼此独立但按序单批推进；T7 依赖 T1 夹具 +
  T2；T8 依赖 T3-T7 全落（改它们的取行段）；T9/T10 收尾。
- 与 RFC-288（task↔scheduler 环）/RFC-289（fanout 内链）无文件级冲突面，
  但 288/289 改同文件——**三大件严格串行**（D3 既定顺序）。

## 验收清单

- [ ] AC-1…AC-6（proposal §5）
- [ ] C1 之外零行为差异（对拍）
- [ ] 九线地图更新为终态（design §1 追记）
