# RFC-424 实施计划

**前置**：RFC-423 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                                              | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-424-T1 | `services/task.ts` 删除测试专用入口与 `resumeKick` 链；工厂装配、wake 迁入 `tests/helpers/`；生产注释改指，`taskDriveLegacy` 删去无人使用的再导出 | design §1、§2 |
| RFC-424-T2 | 用例迁移：8 个 wake 用例、`retryEngine`、4 个回滚目标用例、3 个 helper 改 import；2 个动态工作流用例走生产确认命令                                | design §2、§3 |
| RFC-424-T3 | 锁与账本：RFC-386 盘点锁（含负例）、RFC-103 / RFC-332 改钉 bootstrap、其余读 `services/task.ts` 的锁逐条核对、路径键账本、guard-manifest          | design §4     |
| RFC-424-T4 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                                                 | design §5     |

## 实施记录

1. `services/task.ts` 按 TypeScript AST 删除 18 个声明（含前导注释，其中几段是早已删除的函数留下的孤儿 JSDoc），再按 eslint 清理失效 import；
   新增行只有 import 收窄与一处解构改写。
2. 迁出的工厂、依赖类型、缺省入队器、wake 与回滚包装逐字搬入测试 helper（只把 `taskDriveComposition.X` 类型引用改为直接导入）。
3. 集中验证第一轮发现删除连带的三处问题，均已处置：
   - legacy 工作组状态模块与其 facade 失去最后一个生产消费者——RFC-376「不可达生产文件」27 → 29、RFC-345「零消费者 facade 必须退役」报红。
     两个文件删除，模块原样迁入 `tests/helpers/legacyWorkgroupState.ts`，10 个用例改 import；随之销账 `commons-debt` 一条、RFC-376 export-star
     基线一条、RFC-317 表归属账本三条，RFC-395 两本测试直接读写账本登记该夹具（类别 `target-runtime-state`，与动态工作流用例同类），RFC-395
     任务定义边界用例改为断言 legacy 文件不在生产树；
   - RFC-359 W5-T19f 的单引擎分类把 `rfc142-review-rounds` 判为无理由：它原先靠「从 `services/task` 导入」被认作驱动 SQLite 执行面，wake 搬到
     helper 后补上同义拼法（判据自测补正例）。
4. 附带：`rfc311-backup-concurrency` 一例的 20s 显式预算（RFC-423 CI 红格的归因，见 RFC-423 plan「CI（AC-5）」）。

## 集中验证（T4）

- **静态**：后端 typecheck（含 tests，6 GiB heap）三次均 0 错误，最后一次在 legacy 工作组状态退役之后。改动的 TS 文件 eslint
  `--max-warnings 0` 与 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：迁出的工厂、依赖类型、缺省入队器、wake 与回滚包装和 HEAD 逐字相同（只把两处 `taskDriveComposition.X`
  类型引用改为直接导入）；`services/task.ts` 的新增行只有 import 收窄与一处解构改写；`retryEngine` 的重试装配与原实现等价（它总会注入
  `repositoryPreparation` 绑定，`repositoryWorkspace` 回落用不到；两份 frozen layout 查询主体相同）；两个动态工作流用例经生产确认命令后断言不变。
  PASS。
- **针对性验证集**（6 worker，负载约 19～31）：782 个文件，765 个通过。范围是以 `services/task.ts`、`taskDriveLegacy.ts` 与五个改动的测试
  helper 为种子的反向导入闭包（516 个），加上全部架构测试、读 `services/task.ts` / `commons-debt` / guard-manifest 文本的守卫与扫描语料的守卫。
  17 个失败里三个是删除连带的问题（实施记录第 3 条前两项与 T19f），已处置；其余 14 个是 PostgreSQL 一侧的负载超时，含 600s 的计划审计。
- **第二轮**（4 worker，负载约 8～15）：第一轮的 17 个失败、全部架构测试、legacy 工作组状态夹具的 10 个使用方与 `rfc217-architecture-locks`，
  共 158 个，151 个通过。新出现的三条（RFC-317 表归属账本三条失效、RFC-395 两本测试直接读写账本缺该夹具）都是 legacy 模块搬到测试侧的直接
  后果，处置后单独复跑通过；其余 4 个是负载超时。
- **第三轮**（单进程，负载约 8～9，本候选与基线 HEAD `128e439d7` 的导出对照）：上述 7 个在两侧全部通过、用时相近，例如 `api-code-routes`
  54 s / 50 s、`scheduler-clarify-dispatch` 51 s / 51 s。负载超时不归本 RFC。
- **按已提交源码生成报告的用例**：在「HEAD 加本候选」的独立导出仓库里，`rfc376-report` 16/16、`rfc370-committed-architecture-source` 2/2
  通过；同一仓库里 RFC-386 盘点锁、RFC-376 结构门、RFC-317 模块边界 / 账本 / 语料下限 / 负例守卫也通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

- **`556a45573`**：主 CI `41420057803` 70 个 job 全部 success，windows-platform `41420057759` 与 git-protocols-e2e `41420057760`
  success。AC-5 成立，RFC-424 Done；同一运行作为 RFC-422 / RFC-423 的后继证据。

## 冲突面

- **生产**：`services/task.ts`（只删）；`TE/composition/taskDriveLegacy.ts`（只删再导出）；`TE/infrastructure/taskRouteOperations.ts`（只改注释）；
  删除 `services/workgroup/state.ts` 与 `resource-catalog/infrastructure/legacy/workgroup/state.ts`。
- **测试**：`tests/helpers/{legacyTaskDrive,retryEngine,resumeRollbackTargets,legacyWorkgroupState,productionTaskLaunch,hostTaskLaunchKernel}.ts`
  与迁移的用例。
- **守卫与账本**：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`556a45573`，见上）
