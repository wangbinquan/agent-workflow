# RFC-422 task-execution 运行 family 的打开逻辑迁入 infrastructure，composition 只剩配对（RFC-294 S6）

- **状态**：In Progress（2026-11-01 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-421](../RFC-421-task-execution-agent-invocation-stack/proposal.md)；对应 RFC-416 proposal §7 第 2 项的第二段。
- **落位**：task-execution `infrastructure/local/` 与 `infrastructure/crewstation/`（打开逻辑）、`composition/`（只剩跨模块 provider 的选取与
  注入）。

## 1. 背景

RFC-421 之后，五个运行 family 的 composition 文件里仍是两样东西混在一起：

- **跨模块 provider 的选取**：取 runtime-management 的本地材料定义 / 材料工作区 / 运行时绑定 / 系统代理保留内容 / 诊断目标，source-control
  的工作区内容与 git 控制面观测，resource-catalog 的材料引用。这是装配。
- **打开逻辑**：
  - 材料编译适配——引用核对，不可用的技能 / 插件报错；
  - 调用准备的绑定；
  - 意图构造与观测打开；
  - 夹具 family 的结果投影与原生请求映射；
  - 托管侧的调用 ID 派生与可释放判定；
  - 任务代理的端口产物 / 输出校验映射与 spawn 诊断。

  这些是适配器逻辑。

| 文件                                 | 行数 | 打开逻辑                                                                     |
| ------------------------------------ | ---- | ---------------------------------------------------------------------------- |
| `localSystemAgentRunFamily.ts`       | 252  | 本地系统代理调用、夹具 family、原生请求映射                                  |
| `localRuntimeSmokeRunFamily.ts`      | 110  | 本地冒烟调用（物化工作区、观测、编译）                                       |
| `localTaskAgentRunFamily.ts`         | 232  | 本地任务代理的运行目的（工作区内容、输出校验、端口产物映射、材料选择、诊断） |
| `crewstationSystemAgentRunFamily.ts` | 136  | 托管系统代理调用（调用 ID、可释放判定、意图、托管准备）                      |
| `crewstationRuntimeManagement.ts`    | 137  | 托管冒烟调用（调用 ID、可释放判定、观测、托管准备）与探测预算                |

## 2. 目标

- **G1 打开逻辑迁入 infrastructure**：
  - 三个本地 family 的打开逻辑迁入 `infrastructure/local/`；
  - 两个托管 family 的打开逻辑迁入 `infrastructure/crewstation/`。

  它们经 task-execution 自有的 provider 端口（`infrastructure/local/nativeRunFamilyProviders.ts` 等）拿到各模块的实现，不 import 别的
  模块的 composition 或 infrastructure。

- **G2 composition 只剩配对**：五个 composition 文件只选取 provider 并注入；对外导出的名字与签名不变，bootstrap 与用例的调用方不改。
- **G3 纯结构**：以下全部不变——
  - 引用核对与报错文本；
  - 准备的绑定参数；
  - 意图与观测字段；
  - 夹具投影；
  - 调用 ID 派生与可释放判定；
  - 探测预算；
  - 任务代理的产物 / 校验映射与 spawn 诊断。

## 3. 非目标

- 退还 provider 桥接债：composition 仍从别的模块取 provider，这些边已在 RFC-328 / RFC-294 / RFC-376 账本里；把选取移到 bootstrap 另立。
- composition 其余小块与收口锁。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：打开逻辑位于 infrastructure，五个 composition 文件不再含它们（结构锁锁定，含负例）；迁入的文件不 import 别的模块的
  composition / infrastructure。
- **AC-2 行为不变**：系统代理、运行时冒烟 / 诊断、任务代理运行、托管系统代理与托管运行时管理的既有用例，以及 P0 变异 lane 全部通过，断言
  意图不变。
- **AC-3 守卫**：读源码的锁随 owner 改指，判据不变；新结构锁带负例。
- **AC-4 账本**：guard-manifest 与 Windows paths 按实测更新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **provider 以参数注入，而非由 infrastructure 直接 import**：打开逻辑若直接 import runtime-management 等模块的实现，跨模块桥接只是从
   composition 挪到 infrastructure；以参数注入时，infrastructure 只依赖 task-execution 自有的端口与别的模块的 public 类型，跨模块边留在
   composition，日后由 bootstrap 接手即可。
2. **端口只列打开逻辑实际用到的成员**：runtime-management 的本地实现多为推断类型，端口按使用面写成结构类型，由类型检查保证实现满足。
3. **对外名字不变**：`composeLocalSystemAgentRunFamily` 等仍从原 composition 文件导出，bootstrap 与十余个用例不改调用方式。
