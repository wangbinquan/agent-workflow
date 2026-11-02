# RFC-423 task-execution composition 其余小块迁出与「只剩装配」收口锁（RFC-294 S6）

- **状态**：In Progress（2026-11-02 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-422](../RFC-422-task-execution-run-family-openers/proposal.md)；对应 RFC-416 proposal §7 第 5 项的其余部分与收口锁。
- **落位**：task-execution `infrastructure/`（三块适配器逻辑）、`composition/`（只剩装配）、守卫（收口锁）。

## 1. 背景

RFC-414～422 之后，task-execution `composition/` 从 108 个文件、9,197 行降到 100 个文件、6,296 行。其中已没有循环与 `switch`；只剩三处
`try`，以及若干分支：

- **适配器逻辑（本 RFC 迁出）**：
  - `triggerExecution.ts`：定时任务启动的载荷解析与分派（agent / workgroup / workflow 三支），触发器参与者；
  - `crewstationRecovery.ts`：托管恢复消费者的业务闭包（owner 任务、请求人、任务状态、续跑）与持有执行权才消费的 tick；
  - `workspacePreparationMaintenance.ts`：准备 GC 的阶段分派，以及 worker 载荷里受保护任务集合的设置与清理。
- **装配层的检查与选择（保留）**：
  - 各 `require…` / `select…` 对注入实现完整性的检查（不完整即抛 `TypeError`）；
  - 本地 / 托管、真实 / 夹具的选择分支；
  - 驱动入口对任务级许可注册项的回收（`taskEngineApplication.ts` 的 `try / finally`）。

  这些是装配本身的职责。

## 2. 目标

- **G1 三块适配器逻辑迁入 infrastructure**：
  - `triggerExecution.ts` 整体迁入 `infrastructure/taskExecutionTrigger.ts`，composition 文件删除，`providerRuntime.ts` 改从 infrastructure 取用；
  - 托管恢复迁入 `infrastructure/crewstation/hostedRecoverySelection.ts`；
  - 准备维护迁入 `infrastructure/workspacePreparationGc.ts`。

  后两者的 composition 入口保留同名绑定，bootstrap 不直接取 module infrastructure 的现状不变。

- **G2 收口锁**：新增 `rfc423-composition-assembly-only` 结构锁，钉住 task-execution `composition/` 的装配形状：
  - 没有循环、`switch`；
  - `try` 只在驱动入口；
  - 含 `throw` 的文件及其次数是精确账本（增减都要改锁）。

  新增逻辑落进 composition 时守卫即报。

- **G3 纯结构**：三块逻辑的判据、错误文本与调用次序全部不变。

## 3. 非目标

- `services/task.ts` 的 legacy 驱动工厂（RFC-386 登记的唯一 bootstrap 外构造点）：退役属于 `services/` 收缩，另立。
- 退还跨模块 provider 桥接债（composition 从别的模块取 provider 的配对）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：三块逻辑位于 infrastructure，composition 不再含它们（结构锁锁定，含负例）。
- **AC-2 收口锁**：task-execution `composition/` 无循环 / `switch`，`try` 只在驱动入口，含 `throw` 的文件与次数与账本一致；各项带负例。
- **AC-3 行为不变**：定时任务启动、Webhook 触发、托管恢复、准备 GC 与 worker 维护的既有用例，以及 P0 变异 lane 全部通过，断言意图不变。
- **AC-4 账本**：RFC-328 / RFC-294 / RFC-376 / RFC-305 中随文件迁移的条目改指，不增不减；guard-manifest 与 Windows paths 按实测更新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **保留检查与选择**：注入实现的完整性检查与实现选择是装配的一部分；收口锁以账本钉住它们的数量，而不是迁走。
2. **bootstrap 入口不变**：bootstrap 目前只取各模块的 composition / public，从不直接取 module infrastructure；托管恢复与准备维护因此保留
   composition 同名绑定（RFC-389 维护 worker 根的单次调用锁也按这两个名字）。
3. **`services/task.ts` 的 legacy 工厂另立**：它由 RFC-386 登记为唯一的 bootstrap 外构造点，退役涉及 `services/` 的任务启动入口，与本 RFC 的
   装配收口无关。
