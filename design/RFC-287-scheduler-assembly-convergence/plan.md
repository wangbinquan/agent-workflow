# RFC-287 — 任务分解（plan）

> 前置：RFC-284/285/286 已完工。**本 RFC 落档后须用户批准方可实现**
> （CLAUDE.md RFC workflow §3）。每批第一子任务=逐锚复核（行号基线 83088a83）。
> 2026-08-13 设计门修订版（P1-1/P1-2 契约重写 + P2 批量勘误已入
> proposal/design；本 plan 同步 T1 扩容与冲突面表述）。

## 批次

- T1 逐锚复核 + 对拍基线（P2-5 扩容，五件）：九线锚点核对；①scheduler.ts
  源码文本锁全量清单（≥20 文件）+ 逐条改锚方案；②L4/L7 merge-throw 行为
  夹具（兼 AC-3 红，替 rfc210 文本兜底）；③L1 双处置行为夹具（throw→replay
  可续 / conflict→abandon+failed）；④广播序列快照（L4 逐 attempt vs L5/L6
  单点两形态）；⑤iso discard 失败 warn 路径；外加 L4 三台机器现状夹具
  （拆分前 oracle，锚用勘误后 :5432/:5440-5464/:5905-5935/:5956）。
- T2 骨架落地（G1）：assembly.ts + 单元测试（pools/keep 域含 park 短路/
  merge 默认三态 + disposition 覆写/漂移 A 语义/beforeSpawn 抛出=装配失败）；
  双模式窗口（per-attempt / 跨 attempt+retryPolicy）都有直测；此批不迁移
  任何线。
- T3 L6 迁移（最小对照）+ fanout aggregator 全家绿。
- T4 L5 迁移（beforeSpawn=T14 undo 钩子）+ shard 全家绿。
- T5 L7 迁移 + **漂移 A 红→绿对**（merge 抛出：楔死复现 → keep+
  markMergeFailed）+ rfc253 全家绿；F6 设计门注释改写。
- T6 L1 迁移（preResolved 行变体 + **disposition 覆写声明**：onThrow=
  keepHookIso+rethrow、onConflictHuman=abandon+failed，各带豁免锁）+
  workgroup 全家绿（rfc187-wg-merge-conflict-abandon 必绿）。
- T7 L4 拆分手术（outer + 模式 B assembly + retryPolicy 策略对象；iso 跨
  attempt 稳定性 D17 断言）+ 真实 followup 套件（scheduler-envelope-
  followup-branch / port-validation-followup-decide / rfc092 / rfc122 /
  rfc123 / rfc131 / rfc161 / rfc193）+ 拆分对拍夹具绿。
- T8 取行前奏收编 resolveSchedulerRunRow（4 份 → 1 + overrides）+
  L8 preResolved 短路。
- T9 G3 豁免显式化四锁 + 终局灭绝锁（骨架外散写归零）。
- T10 配额面可配（G4，独立 commit，**不与收敛批混提**）：设置页补三项 + i18n +
  过期头注修正 + 测试（含「设置页覆盖全部 6 项」的防漏锁）。
- T11 实现门（双路独立子代理）+ plan/STATE 记账。

## 依赖

- T2 依赖 T1；T3-T6 依赖 T2、彼此独立但按序单批推进；T7 依赖 T1 夹具 +
  T2；T8 依赖 T3-T7 全落（改它们的取行段）；T9/T10 收尾。
- 冲突面（P3-10 勘误表述）：与 RFC-288/289 **同文件（scheduler.ts）且区域
  相邻**——289 的 fanout 内链贴 L5/L6 接缝、288 的 SCC 拆解会移码毁锚；
  靠 D3 既定顺序（287→288→289）严格串行消解，接手时按新基线重跑逐锚复核。

## 验收清单

- [ ] AC-1…AC-6（proposal §5，设计门修订版口径）
- [ ] C 表（C1/C2/C3）之外零行为差异（对拍豁免声明适用）
- [ ] 九线地图更新为终态（design §1 追记）
