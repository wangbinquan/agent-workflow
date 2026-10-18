# RFC-374 实施计划

**前置**：RFC-370 冻结（或发布）其未发布迁移 SQLite 0259 / PostgreSQL 0035（design §8）。前置满足前本 RFC 保持 Draft，不派发实施。
派发后单批次交付，先完成全部实现与用例，再集中验证一次（CLAUDE.md 文首硬规则）。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-374-T1 | PostgreSQL 迁移种类 V8（已有表追加可空列 + 含新列的唯一索引），含生成器路由、历史加载校验、行桥折叠与恢复写入器列清单核实；V8 单测 | design §4.3 |
| RFC-374-T2 | schema：`nodeRunSeqAllocations` 表、`nodeRuns.seq` 末列、`idx_node_runs_task_seq`；改写 `db/schema.ts` 中「Freshness is pure ULID」的注释；`RFC349_SOURCE_TABLES` 增加新表 | design §3、§4.1 |
| RFC-374-T3 | 迁移：SQLite `0260_rfc374_node_run_seq`（drizzle-kit 生成）与 PG `0036_rfc374_node_run_seq`（`--append` 生成）；重新生成 RFC-349 schema-contract；`upgrade-rolling` 260、`rfc349-schema-contract` 217 / 211 | design §4.2 |
| RFC-374-T4 | 铸造程序加分配步骤（先分配后插入），改写文件头注释；更新 W47、rfc144、`rfc359-w6-node-run-insert-lineage-completeness` | design §3 |
| RFC-374-T5 | shared `nodeRunOrder.ts` 比较器与助手、`NodeRunSchema.seq`、`RunLineageView.seq`、`resolveHandlerRun` | design §2、§6 |
| RFC-374-T6 | 存量追平：规划器、端口、作业、store、persistence 接线、启动恢复第 0 步、报告计数；可选的逻辑目标不变量 | design §5 |
| RFC-374-T7 | 后端读者切换：design §1.3 A～E 全部语义站点、投影与类型补 `seq`、隐式顺序判定改显式 | design §6 |
| RFC-374-T8 | 前端切换到 shared 比较器；夹具补 `seq: null` | design §6 |
| RFC-374-T9 | 结构门 `rfc374-node-run-order-guard`（负例、合规样例、例外清单、语料下限、登记） | design §7 |
| RFC-374-T10 | 测试（design §9 第 1～11 项） | design §9 |
| RFC-374-T11 | 文档：关闭 `docs/audit-backlog.md` 中对应系统级条目；dev-gotchas 记录「种子行不带 seq 视为更旧」与 seq 优先的排序写法；`services/freshness.ts`、`FE/lib/call-node-nav.ts` 中 ULID 前提的头注释 | — |

依赖：T1 → T2 → T3；T4、T5 依赖 T2；T6 依赖 T2、T4；T7、T8 依赖 T5；T9 依赖 T5、T7；T10 贯穿。

## 冲突面

- 与 S6 共用 `nodeRunMint` / freshness / `nodeMechanics` / `wrapperMechanics`，二者串行。
- RFC-375 会先改 `services/scheduler.ts`（不同片段）与删除部分死代码，本 RFC 以其落地后的源码为准。
- 迁移编号以派发时为准；与 RFC-370 的时序见 design §8。

## 验收清单

- [ ] proposal AC-1～AC-7
- [ ] 两种 provider 的 fresh / upgrade、逻辑复制、归档恢复（CI postgresql-evidence 与 Ubuntu 双引擎分片）
- [ ] 推送后 exact SHA CI 全绿
