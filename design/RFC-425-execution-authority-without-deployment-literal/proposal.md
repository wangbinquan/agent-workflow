# RFC-425 执行权端口去部署字面量：部署种类由 profile 提供（RFC-294 S2c）

- **状态**：In Progress（2026-11-02 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你可以
  不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，无用户
  可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c「部署 profile」余项第 2 项
- **前序**：[RFC-393](../RFC-393-cli-bootstrap-separation/proposal.md) §7 第 2 项、[RFC-394](../RFC-394-typed-deployment-profile/proposal.md)
  §3 非目标第 2 条（类型化 profile 已有 `kind`，生命周期与 SPA 标记改由它驱动留给本 RFC）。
- **落位**：system-operations `application/ports`（端口）与 `infrastructure`（三个实现），`bootstrap/`（部署种类下传），`server.ts` /
  `embed.ts`（读必填的部署种类）。

## 1. 背景

执行权端口 `ExecutionAuthorityPort` 带一个部署字面量字段 `mode: 'standalone' | 'crewstation'`，三个实现（本地、托管、托管待命）各自写死。
它被三处借来回答「这是哪种部署」：

- 公开的执行状态 `ExecutionStatus.mode`（`executionStatusOf`）；
- HTTP 应用的 `deploymentMode`（决定 SPA 首页是否注入托管标记）；
- 生命周期程序的 `profile`（`daemonSession.ts`）。

而部署种类本来就由类型化部署 profile 给出（RFC-394 的 `DeploymentProfile.kind`）。端口携带部署字面量让「执行权」与「部署选择」两件事
耦合：RFC-376 的部署分支盘点里，端口上的两处字面量与 `embed.ts` 的 `deployment === 'standalone'` 比较都记在 5 处余量之中。

## 2. 目标

- **G1 端口只描述执行权**：删除 `ExecutionAuthorityPort.mode`，三个实现不再写死部署字面量。
- **G2 部署种类由 profile 下传**：bootstrap 把 `profile.kind` 作为必填值交给会话 / 应用装配；执行状态投影、HTTP 应用与生命周期程序都从它取。
- **G3 SPA 标记无比较**：`embed.ts` 只按 profile 给出的标记（单机为空）注入首页，不再比较部署字面量。
- **G4 行为不变**：`ExecutionStatus` 的线上取值、SPA 首页、生命周期顺序全部不变；RFC-376 的部署分支 5 → 2（端口两处与 SPA 比较一处销账）。

## 3. 非目标

- 执行可用性在未绑定读取器时的回落值（`readExecutionStatus` 的 `?? { mode: 'standalone', … }`）：牵涉全部未绑定读取器的工具 / 测试根，另立。
- 定时备份来源移出 provider 适配表、托管 `databaseBackup` 选择：另立。
- 单机默认值集中、选择项改必填、入口根瘦身（S2c 余项第 1、3 项）：另立。
- CrewStation 事件收件箱端口上的通道字面量。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`ExecutionAuthorityPort` 不含 `mode`；src 中没有执行权实现写部署字面量（结构锁锁定，含负例）。
- **AC-2**：执行状态、HTTP 应用与生命周期程序的部署种类都来自 bootstrap 下传的 profile 种类；单机与托管两种 profile 下执行状态的 `mode`、
  SPA 首页标记与生命周期 profile 与改动前相同（用例覆盖两种 profile）。
- **AC-3**：RFC-376 `deployment-mode-branch-sites` 由 5 降到 2，基线与计数同步改小。
- **AC-4**：既有执行状态、托管控制面、生命周期与统一测试入口用例，以及 P0 变异 lane 全部通过。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **部署种类作为必填值下传，而不是给端口换个名字**：端口回答「此刻能不能执行」，部署种类回答「这是哪种部署」，两者生命周期不同（托管
   实例会在待命与活动之间变化，部署种类不会）。
2. **SPA 标记由 profile 给出标记内容**：`embed.ts` 只负责注入，不认识部署种类，标记文本的唯一来源在 profile 描述里。
3. **回落值与备份来源另立**：两者各自牵涉一批工具 / 测试根或托管备份路径，与本 RFC 的端口改动无交集。
