# RFC-618 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **裁定一：对账表是测试数据，迁入 `T/helpers/`**。`S/modules/intent/domain/teaching/reconciliation.ts` 的文件头写明它由
  `T/intent-teaching-reconciliation.test.ts` 跑两条规则，`T/zod4-contracts.test.ts` 也取它的 `schemaKeys`；生产入口一个都不取。原样迁入
  `T/helpers/intentTeachingReconciliation.ts`（三条同目录相对 import 改成 `@/modules/intent/domain/teaching/...` 别名），与 RFC-467 / RFC-584 迁出
  只供用例的参照的做法一致。登记的“移出须有明确后继”由本 RFC 承担。
- **裁定二：portable-import 引用一对删除**。`S/modules/resource-catalog/application/portableImportReferences.ts` 只被同名装配取，装配
  `S/modules/resource-catalog/composition/portableImportReferences.ts` 自 `6474b3ec3`（RFC-349 双 provider 目录装配）写成、`a507b13ea`（RFC-359 W4-D14）合一，
  `git log -S` 只见这两次，`src` 与用例里都没有消费方。生产的 portable import 走 `application/agents/importPorts.ts`、`infrastructure/agentImportQueries.ts` 与
  `application/package/*`。删除优于迁移：没有任何调用方的代码不值得换个地方留着。
- **裁定三：YAML 预览与选择子投影删除**。`S/modules/resource-catalog/infrastructure/legacy/workflow.yaml.ts` 的唯一生产导出（`stringifyWorkflowYaml`）RFC-454 已迁到 shared，
  RFC-401 T6 删了导入写入器，RFC-271 C1 / C2 下线了 `GET /api/workflows/:id/export` 与 `POST /api/workflows/import`（由配置包取代）。余下的 `previewWorkflowYaml` 与
  `workflowDefinitionToSelectors` 只有四条用例在测，删除，四条用例随之删去（§2）。`workflowPersistence.ts` 里 `WORKFLOW_NAME_INVALID_MESSAGE` 的注释原写“改名检查与 YAML 导入共用”，
  改为只写改名检查。
- **其余四个不动**（proposal §3）。
- **偏离项**：无。

## 1. 改动

- 迁移：`S/modules/intent/domain/teaching/reconciliation.ts` → `T/helpers/intentTeachingReconciliation.ts`（逐字，三条 import 改别名，文件头加一行来由）。
- 删除：`S/modules/resource-catalog/application/portableImportReferences.ts`、`S/modules/resource-catalog/composition/portableImportReferences.ts`、
  `S/modules/resource-catalog/infrastructure/legacy/workflow.yaml.ts`。
- 用例：
  - `T/intent-teaching-reconciliation.test.ts`、`T/zod4-contracts.test.ts` 改取 helper；
  - `T/rfc243-call-refs-yaml.test.ts` 删去“后端 `workflowDefinitionToSelectors` 两条路径都剥 `workflowId`”一条，shared `workflowDefinitionToNameSelectors` 那条保留
    （该 describe 不再需要数据库，改为普通 `describe`）；
  - `T/rfc264-unicode-names.test.ts` 删去“RFC-264 YAML import”一组三条。
- 账本：
  - `T/architecture/rfc376-structural-guards.test.ts`：`unreachable-production-files` 基线删四条、三组保留理由删去，留一行来由；
  - `T/rfc305-architecture-lock.test.ts`：identity-access 边账删去 `portableImportReferences.ts` 那一条；
  - `T/rfc359-w4-d14-adapters.test.ts`：中立装配清单删去 `composition/portableImportReferences.ts`；
  - `T/fixtures/rfc395-module-table-ownership-debt.json`：`legacy/workflow.yaml.ts` 依赖 `users` 表的那条跨 context 表引用债随文件删除而清偿，删去（`rfc317` 逐条相等）；
  - 按路径读这些文件的三条源码锁：`T/rfc271-capability-removal.test.ts` 的“下线不得误伤仍被使用的帮手”改为锁 shared 里仍在用的
    `stripCallWorkflowNodeIds` / `workflowDefinitionToNameSelectors`（后端的 `workflowDefinitionToSelectors` 已证实只剩用例在用）；
    `T/rfc345-agent-import-queries.test.ts` 删去锁 portable-import 那一对事务绑定的一条（被锁的代码已删）；`T/rfc454-services-one-hop-facade-sweep.test.ts`
    删去“`legacy/workflow.yaml.ts` 不再导出 `stringifyWorkflowYaml`”一条（文件已删）；
  - `architecture/counts.json`：`unreachable-production-files` 8 → 4。

## 2. 用例

- 新增 `T/rfc618-unreachable-production-files-boundary.test.ts`，登记 guard-manifest：
  1. 四个旧位置不在，测试数据在 `T/helpers/`。
  2. backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts`、`tests` 里没有文件再经任何写法取四个旧位置（按语法树取模块说明符，语料下限 3,000）。
  3. 生产树不取 `T/helpers/intentTeachingReconciliation`，也不在别处重新声明退役的五个名字（两个装配、应用工厂、YAML 预览、选择子投影）。
  4. 负对照：别名、相对路径与 `mock.module` 三种写法都认得出，字符串里的路径不算；生产文件取测试数据、以函数 / 常量 / 导出别名重新声明都认得出，近似名不算。
- **删去的四条用例所守的行为**：
  - RFC-264“导入时名字折叠、非法名 422”：配置包导入经 `createWorkflowMutationParticipant` 与 shared `CreateWorkflowSchema`（`name: WorkflowNameSchema`）建工作流，
    同一份 schema 的折叠与拒绝由 `rfc264` 余下的“创建接受中文并存折叠后的名字”“非法名在创建边界仍被拒”两组用例覆盖；
  - RFC-243“导出剥掉 `workflowId` 缓存”：shared `workflowDefinitionToNameSelectors` 那条保留。
- 对账表的两条规则照旧由 `T/intent-teaching-reconciliation.test.ts` 跑，`T/zod4-contracts.test.ts` 照旧取 `schemaKeys`。

## 3. 失败模式

- **有人把对账表放回生产树，或再写一份没有消费方的生产文件**：`unreachable-production-files` 超过 max，`rfc376` 的精确基线红。
- **有人恢复 YAML 预览 / portable-import 装配**：RFC-618 用例 ③ 红。
- **生产代码取测试数据**：RFC-618 用例 ③ 红。

## 4. 对 RFC-294 刷新后规则的对账

- **S11**：生产树只留生产入口走得到的文件；保留的例外各有登记理由。**C12**：RFC-618 用例扫全部源码与用例，带语料下限与负对照。**C13**：计数降、不升。
