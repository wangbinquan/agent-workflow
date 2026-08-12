# RFC-285 — 任务分解（plan，v2）

> 前置：RFC-284 批 C 已落；**Q1-Q7（proposal §5）拍板后对应批次才可开工**；
> 每批第一子任务=逐锚复核（v1 教训）。

## 批次

- T1 前置排查落档：B4 存量 query-token 全量清单（rg `query('token')` 含
  routes/auth.ts）+ B5 stale 码产出/消费全量对照表 + B1 `task-not-visible`
  产出点全集——三份清单附录本文件。
- T2 B1 404 统一（触点全集 + oracle 消除测试 + 成员门反例 + durability/文本锁
  改判 + ≥10 测试文件改判）。
- T3 B3 InheritedActor 三臂（含 scheduled rebuild 收编三合一；Q5/Q6 裁决落地）。
- T4 B4 token 双入口（含 routes/auth.ts 第二读点收编）。
- T5 B2：schema 迁移（workflow_id FK 软链化）→ 应用层三档统一 → 披露聚合 →
  展示层悬空容忍（Q2 现网检查先行）。
- T6 B5 stale 码归一（按 T1 对照表全改；Q1/Q7 形态）。
- T7 B6①（作者校验+冻结回归锁）+ ②（BatchRecord ownership + upgradeGate）。
- T8 B6③ 三路回归锁 + backlog 导入条销账。
- T9 B7：现状矩阵回归锁 + B6④ distill 门 + 前端 useIsResourceAdmin 两点 +
  candidate（Q4）+ CLAUDE.md/注释过期句更正。
- T10 实现门（独立子代理）+ backlog 销账（review 冒名 / ws-repo-imports /
  memory 谓词过期条 / 403-404 口径 P3 条）+ STATE/索引收尾。

## 依赖

- T2/T3/T4 互独立；T5 依赖 Q2；T6 依赖 Q1/Q7；T9 依赖 Q3/Q4。
- 全程不碰 webhook 路由文件（RFC-283 在途）；B5 与 RFC-283 的新 fence 码在
  实现期对表。

## 验收清单

- [ ] AC-1…AC-8（proposal §6 v2）
- [ ] E 清单（v2：E1-E6/E8/E11）外零行为差异
- [ ] v1 虚项三处的回归锁在位（E7/E9/E10 降级产物）
