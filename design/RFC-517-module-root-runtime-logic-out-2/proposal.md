# RFC-517 模块根装配文件的运行期逻辑迁出（二）：数字员工、系统运维与任务执行（RFC-294 S10 第二十四步）

- **状态**：In Progress（2026-11-19）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10。
- **前序**：[RFC-516](../RFC-516-module-root-runtime-logic-out-1/proposal.md)（S10 第二十三步）清掉了 event-center、identity-access 与
  source-control 的模块根。本 RFC 清掉 RFC-515 门例外清单里余下的 3 个模块根：digital-employee、system-operations 与 task-execution；装配入
  口与导出的名字、签名不变。

## 1. 背景

三个模块根 `composition.ts` 里的运行期逻辑是 RFC-515 门的例外：

- `digital-employee/composition.ts`：Intent 平台清单的参与者 `composeDigitalEmployeePlatformInventoryParticipant`（按语言取文本、按工作项汇
  总工具各一个循环）；员工定义视图的投影 `employeeView`（当前版本、版本行、工作范围与岗位版本缺失时各抛一个错误）。
- `system-operations/composition.ts`：文件库启动准备里持有升级锁的那一段（`try / finally` 释放锁）；PostgreSQL 系统运维装配时 schema 计划与
  契约摘要不符就抛 `postgresql-system-operations-schema-plan-mismatch`；HTTP 的暂存还原命令执行后释放上传工件（`try / finally`）。
- `task-execution/composition.ts`：任务执行模块的两个类——`TaskExecutionModule`（认领失败时退还许可并重抛，`pause` / `dispose` 缺理由时抛错）
  与 `ProviderTaskExecutionModule`（持久化认领，同形）——以及关停控制器 `createTaskExecutionShutdownController`（`try / finally` 清计时器）。

## 2. 目标

- **G1 运行期部件与用例归位**（迁移的代码逐字不变；两处装配期的核对只把闭包变量换成参数）：
  - digital-employee：清单参与者连同它的文本 / 排序函数与两个类型迁入新的 `application/platformInventoryParticipant.ts`；员工定义视图投影迁
    入新的 `application/employeeDefinitionView.ts`（工厂收 authoring store，返回原投影函数）。
  - system-operations：文件库启动准备的持锁段迁入新的 `infrastructure/local/fileDatabaseProviderBoot.ts`（锁、epoch 准入、迁库恢复与运行时准
    备都是单机 profile 的机制）；schema 计划核对迁入新的 `application/postgresqlSchemaPlanAdmission.ts`；暂存还原后释放工件迁入新的
    `application/stageRestoreArtifactRelease.ts`。
  - task-execution：两个类、认领结果类型、两个归属期常量与关停控制器迁入新的 `infrastructure/taskExecutionModule.ts`（它们组装 application
    的认领闸门与 infrastructure 的运行时登记表、归属持久化，按 RFC-294 design §3 只能落 infrastructure）。
- **G2 模块根只装配**：三个模块根改为取新位置，照旧导出这些名字；进程级的 `taskExecutionModule` 单例与两个模块工厂留在模块根；启动准备里“托
  管安装 / 文件库”的二选一留在模块根。
- **G3 门收紧**：RFC-515 门的例外清单删去这 3 个模块根（30 → 27，只剩 RFC-370 的文件）；新增 RFC-517 用例。

## 3. 非目标

- RFC-370 的 `crewstation*` / `taskImage*` 例外文件与 `composition-forbidden-import-files` 的 12 个。
- 两个类里两份同形认领体的合并；数字员工模块根其余的视图映射与平台工具目录；改名；任何行为变化、接口与界面。
- `architecture/commons-debt.json` 的 DE-11 登记（锚点只校验文件存在；本 RFC 不处理该发现）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；三个模块根 `composition.ts` 不再有循环、`try` 与 `throw`，RFC-515 门的例外清单删去它们
  后仍绿（只剩 RFC-370 的 27 个）；导出的名字与签名不变。
- **AC-2**：同样输入下清单参与者、员工定义视图、文件库启动准备、schema 计划核对、暂存还原后的释放、任务执行模块的认领 / 暂停 / 销毁与关停控
  制器的结果、错误与次序不变。
- **AC-3**：新文件的依赖面是闭集，服从 RFC-294 design §3 的层次（application 不取 infrastructure 与 composition，infrastructure 不取
  composition）；public surface 不升；计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
