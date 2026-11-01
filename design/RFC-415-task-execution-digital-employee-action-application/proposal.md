# RFC-415 task-execution 数字员工执行核心与动作执行运行器迁入 application（RFC-294 S6）

- **状态**：In Progress（2026-11-01 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-414](../RFC-414-task-execution-composition-io-out/proposal.md)（composition 不再直接做 I/O）
- **落位**：task-execution `application/`（两个执行器的业务流程）、`application/ports/`（它们的端口）、`composition/`（只剩把 provider 能力绑进端口）

## 1. 背景

RFC-414 之后 task-execution composition 不再碰持久化与文件系统，但还有两块**应用逻辑**写在 composition 里：

- `digitalEmployeeExecution.ts` 的 `buildDigitalEmployeeExecution`（约 380 行）：数字员工 Reaction 执行核心——计划 / 尝试 / 环境的解析，
  提示词与计划人审提示词的构造，按 implementation 种类（agent / workflow / program）校验精确引用、合成宿主快照，启动、检查（完成 / 失败 /
  停止 / 计划路径校验 / 工作区语义校验）与取消。
- `actionExecutionRunners.ts`（约 440 行）：数字员工 agent / script 动作执行器——工作区与输入挂载前置校验、宿主快照合成、启动、终态观察、
  结果投影与取消。

它们只经已有的依赖接口（`DigitalEmployeeExecutionDependencies`、`ActionExecutionEnvironment`）与 provider 交互，是应用层的流程，不是装配。

## 2. 目标

- **G1 数字员工执行核心迁入 application**：核心与其解析 schema、提示词构造、活性判据迁入 `application/digitalEmployeeExecution.ts`，经
  `application/ports/digitalEmployeeExecution.ts` 的端口执行；「怎样启动一个宿主任务」（actor、资源授权、调用方、启动主体与借用工作区）收为
  一个窄端口 `launchHost`，由 composition 绑定到根启动内核。
- **G2 动作执行运行器迁入 application**：两个执行器与它们的类型迁入 `application/actionExecutionRunners.ts` / `application/ports/actionExecution.ts`；
  任务状态读与工作区入口检查经环境端口（composition 的环境绑定给出缺省实现）。
- **G3 composition 只剩绑定**：`digitalEmployeeExecution.ts` 只留端口组装（启动绑定、库内缺省端口、Reaction provider），`actionExecutionRunners.ts`
  删除，环境绑定与两个 action 组合入口不变形。
- **G4 纯结构**：校验顺序与错误码 / 文本、宿主快照、启动请求字段、检查与取消的判定、终态观察全部不变。

## 3. 非目标

- 托管代理调用准备、provider 后台循环等其余 composition 逻辑（另立 RFC）。
- 根启动内核类型（`RootTaskLaunch*`）的落位。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：两个执行器的主体在 application，composition 不再声明它们（结构锁锁定，含负例）；application 新文件不 import
  infrastructure / composition（`required-ports` 的类型除外）。
- **AC-2 行为不变**：数字员工 Reaction、计划人审、动作执行（agent / script）、执行合同的既有用例与 P0 变异 lane 全部通过，断言意图不变。
- **AC-3 守卫**：按旧路径取语料的锁随 owner 改指；新结构锁带负例。
- **AC-4 账本**：counts / commons-debt / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **窄启动端口而不是搬启动内核类型**：`RootTaskLaunchRequest` 牵连上传、工作区租约、受保护 MR 守卫等一串 infrastructure 类型；核心只需要
   「以这些字段起一个宿主任务」，故端口只收核心自己的字段，到 `RootTaskLaunchRequest` 的映射（原样迁出的那段）留在 composition 的绑定里。
2. **缺省实现在绑定里选**：原核心在启动时按 `deps.programs ?? createFileProgramToolSource(appHome)` 选程序源、运行器按
   `env.workspaceEntries ?? 本地实现` 选入口检查；二者无状态，绑定在构造时选好交给端口。
3. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
