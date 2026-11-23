# RFC-544 演示种子与数字员工代理模板迁出 services/（RFC-294 §4.7 其余一族第二步）

- **状态**：In Progress（2026-11-23）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.7（W9-D 余项的成批方式）“其余”一族的第二步；
  design §14 “`services/` 清仓”与 proposal C10（迁入时按内容分层落位）。
- **前序**：[RFC-476](../RFC-476-task-delete-and-review-mutation-queue-owners/proposal.md)（“其余”一族第一步：任务删除与评审变更队列归
  task-execution）。

## 1. 背景

`packages/backend/src/services/` 余 6 个文件。其中两个已经没有理由留在那里：

- `services/demoSeed.ts`（首启示例编排，173 行）：只取各模块 public 的参与者类型与完成端口，自己只管持久标记与示例说明；唯一的调用方是
  `bootstrap/daemonApplication.ts`。plan §4.7 记它的 owner 是 bootstrap。
- `services/digitalEmployeeAgentTemplates.ts`（435 行）：开发数字员工的内置代理模板——旧版 8 个模板的定义、工具展示名、旧版到 V2 的升级
  映射、V2 的工具配置，以及 daemon 启动时把内置代理对齐到模板、列出公开模板的两个用例。V2 的 8 个模板定义本身写在 development-automation 的
  `public/participants.ts` 里（约 200 行数据），这个文件是它唯一的生产使用方。调用方只有 bootstrap 的三个文件。plan §4.7 记它归 W4-E9。

## 2. 目标

- **G1 演示种子归 bootstrap**：`services/demoSeed.ts` 原样迁为 `bootstrap/demoSeed.ts`。
- **G2 代理模板归 development-automation 并按内容分层**：V2 模板数据离开 `public/participants.ts`，与旧版模板数据、工具展示、升级映射与工具
  配置一起进 domain；对齐与列出两个用例进 application；bootstrap 经 development-automation 的 public 取用，`public/participants.ts` 只转出。
- **G3 结局不变**：daemon 启动时对齐的内置代理、公开模板列表、工具展示名、升级映射与工具配置不变；首启示例不变。
- **G4 门与用例**：新增 RFC-544 用例（两个文件不在 `services/`；迁入位置与分层；bootstrap 只经 public 取模板；development-automation 的
  domain 不取 public；`public/participants.ts` 不声明、只转出；带负对照）；钉着旧路径的用例与锁随改。`services/` 6 → 4。

## 3. 非目标

- `services/codeRoundContract.ts`（W4-E8，随 code-capability 并入 development-automation）与 git 一族（`gitSubmodule.ts`、`mergeAgent.ts`、
  `repoCredentials.ts`，W5）。
- 模板的内容、对齐规则与示例数据不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/` 下没有这两个文件；演示种子在 `bootstrap/demoSeed.ts`，代理模板按 design §3 落在 development-automation 的 domain 与
  application，bootstrap 只经 public 取用。
- **AC-2**：内置代理对齐、公开模板列表、工具展示名、升级映射、工具配置与首启示例的结局不变。
- **AC-3**：新增 RFC-544 用例并登记 guard-manifest；钉着旧路径的用例与锁随改；减速带计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
