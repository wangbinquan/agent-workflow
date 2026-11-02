# RFC-421 task-execution agent 调用栈：中立部分迁入 application，本地调用适配器迁入 infrastructure/local（RFC-294 S6）

- **状态**：In Progress（2026-11-01 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-420](../RFC-420-task-execution-execution-state-residue/proposal.md)；对应 RFC-416 proposal §7 第 2 项的第一段。
- **落位**：
  - task-execution `application/`：两段式调用准备、系统代理运行核心、运行时冒烟核心；
  - `infrastructure/local/`：本地 agent 调用适配器与本地调用准备；
  - `composition/`：各运行 family 只剩跨模块配对与注入。

## 1. 背景

RFC-416 proposal §7 第 2 项是本地 agent 调用适配器与本地 run family。逐个文件看，它其实分两层：

- **调用栈本身**（本 RFC）：
  - **`composition/agentInvocationPreparation.ts`**（41 行）：两段式准备 `createAgentInvocationPreparation`——编译一次，绑定一次（重复绑定报错）。
    与 provider 无关，托管与本地共用。
  - **`composition/systemAgentRunFamily.ts`**（67 行）：系统代理运行核心——默认超时与事件文本上限、打开调用、交给
    `runSystemAgentCore`，调用被拒时释放保留引用。与 provider 无关。
  - **`composition/runtimeSmokeRunFamily.ts`**（31 行）与 **`composition/runtimeSmoke.ts`**（68 行）：冒烟核心——默认值、nonce、交给
    `runRuntimeSmokeCore`；冒烟的材料声明 `createRuntimeSmokeMaterialIntent` 与预备运行 `runPreparedRuntimeSmoke`。与 provider 无关。
  - **`composition/agentInvocation.ts`**（208 行）：本地 agent 调用适配器 `bindNativeAgentInvocation`——命令与环境快照、进程 effect 包住
    整个执行、启动回执、输出行解释、结果映射。它是本地 provider 的适配器。
  - **`composition/localAgentInvocationPreparation.ts`**（94 行）：本地调用准备，把编译出的本地计划交给上面的适配器。
- **各运行 family 的打开逻辑**（后继 RFC）：本地系统代理 / 冒烟 / 任务代理与托管同类 family 里的材料编译适配与意图构造。它们需要
  task-execution 自有的材料端口，单独立项。

另有一处层次倒置：`infrastructure/local/nativeTaskAgentRun.ts` 从 composition 取 `bindNativeAgentInvocation`。

## 2. 目标

- **G1 中立部分迁入 application**：
  - `createAgentInvocationPreparation` 原样迁入 `application/agentInvocationPreparation.ts`；
  - 系统代理运行核心原样迁入 `application/systemAgentRun.ts`，改名 `createSystemAgentRunFamily`；
  - 冒烟核心、材料声明与预备运行原样迁入 `application/runtimeSmoke.ts`（`createRuntimeSmokeRunFamily`、`createRuntimeSmokeMaterialIntent`、
    `runPreparedRuntimeSmoke`）。
- **G2 本地适配器迁入 infrastructure/local**：`bindNativeAgentInvocation` 原样迁入 `infrastructure/local/agentInvocation.ts`；本地调用准备原样
  迁入 `infrastructure/local/agentInvocationPreparation.ts`。
- **G3 composition**：上述六个 composition 文件删除；各运行 family 与 legacy 入口改从新位置取用。
- **G4 纯结构**：以下全部不变——
  - 准备的两段式与单次绑定；
  - 系统代理与冒烟的默认值、nonce 与保留引用的释放；
  - 冒烟材料声明；
  - 本地调用的命令 / 环境快照、进程 effect 的先后、回执、输出解释与结果映射。

## 3. 非目标

- 各运行 family 的打开逻辑（后继 RFC）。
- 退还跨模块 provider 桥接债：适配器对 runtime-management 本地基础设施（材料引用、证据）的依赖随文件迁移，账本条目改指，不增不减。
- composition 其余小块与收口锁。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：
  - 六块主体位于新 owner，六个 composition 文件删除（结构锁锁定，含负例）；
  - 迁入 application 的文件不 import composition、infrastructure 与 `@/services`。
- **AC-2 行为不变**：调用准备、系统代理、运行时冒烟 / 诊断、任务代理运行、进程身份与回执的既有用例，以及 P0 变异 lane 全部通过，断言意图不变。
- **AC-3 守卫**：读源码的锁随 owner 改指，各锁判据不变——RFC-328 任务 effect 边界登记与 provider 桥接债、RFC-294 预检与 RFC-376 的
  跨模块边清单、各 RFC-370 用例的 import。新结构锁带负例。
- **AC-4 账本**：guard-manifest 与 Windows paths 按实测更新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **先迁调用栈，family 打开逻辑另立 RFC**：打开逻辑需要描述 runtime-management 本地材料定义、系统代理保留内容、诊断目标等的
   task-execution 自有端口，设计面不同；调用栈本身只是原样迁移，先落地可以让后继 RFC 直接面向 application / infrastructure 写。
2. **桥接债随文件改指而不退还**：`bindNativeAgentInvocation` 调用 runtime-management 本地基础设施的材料引用与证据工厂，这是 RFC-328 账本里
   已记录的 provider 桥接；退还它需要 bootstrap 注入本地材料能力，属于另一类工作。
3. **核心函数改名**：迁入 application 的 `composeSystemAgentRunFamily` / `composeRuntimeSmokeRunFamily` 改为 `create…`，`compose` 前缀只留给
   composition。
