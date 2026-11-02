# RFC-427 入口根瘦身：命令依赖迁入 bootstrap，迁移 / 校验成为部署操作（RFC-294 S2c）

- **状态**：Done（2026-11-02 落档并实施；exact SHA `c96f2c907` 主 CI 70/70 与 windows-platform 全绿）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你可以
  不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，无用户
  可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c「部署 profile」余项第 3 项（退出门「入口根只做
  参数解析与 profile 选择」）
- **前序**：[RFC-393](../RFC-393-cli-bootstrap-separation/proposal.md) §7 第 3 项、[RFC-394](../RFC-394-typed-deployment-profile/proposal.md)
  §3 非目标第 3 条
- **落位**：`bootstrap/`（命令依赖的装配、部署选择与部署操作）；`main.ts` 只剩参数解析、部署选择与分发。

## 1. 背景

`packages/backend/src/main.ts`（731 行）除了解析参数和分发子命令，还自己装配命令依赖：

- 约 160 行的三个装配函数：`composeUserCommandBootstrap`、`composePackageCommandBootstrap` 与它们共用的 `resolveCommandProvider`；
- `backup` / `restore` / `doctor` / `db` 分支里就地组合系统运维、诊断、数据库迁移操作，`restore` 还自己读配置、解析 provider 运行时；
- 一个只在 e2e 构建可用的 `__managed-process-output-probe`，约 60 行逻辑写在分支里；
- 两个托管 Git 凭据子命令直接按需 import 模块的 composition。

因此 `main.ts` import 了 identity-access、resource-catalog、code-capability、system-operations 等模块的 composition 与 `services/`。

部署选择也分散：`bootstrap/deployment.ts` 的 `migrateForDeployment`、`verifyDatabaseRestoreForDeployment`、
`verifyDatabaseMigrationForDeployment` 各自重读一次 `AW_DEPLOYMENT_MODE` 再分支，两个只在托管可用的校验各写一句拒绝。

## 2. 目标

- **G1 命令依赖由 bootstrap 装配**：上述装配原样迁入 `bootstrap/`，`main.ts` 只调用 bootstrap 给出的入口，再把结果交给 `cli/` 的处理器。
  CLI 处理器的类型留在 `cli/`；bootstrap 的返回值按结构满足它们（RFC-393：`cli/` 与 `bootstrap/` 互不 import）。
- **G2 部署选择一次，命令是部署的操作**：`selectDeployment(env)` 读一次部署模式，返回带 `profile()` 与
  `migrate()` / `verifyDatabaseRestore()` / `verifyDatabaseMigration()` 的部署描述。`main.ts` 的 `start` / `migrate` / 两个校验命令都从它取。
- **G3 不支持的部署操作统一报错**：由同一个错误类型给出，报文与现在逐字相同（「database restore verification requires CrewStation
  deployment」等）。
- **G4 行为不变**：所有子命令的输出、退出码、按需加载与部署行为不变。

## 3. 非目标

- 新增任何部署下的命令拒绝。托管部署下仍可运行的本地命令照旧，收缩能力不在本 RFC。
- 子命令的参数解析方式、帮助文本。
- S2c 余项第 1 项（单机默认值集中、选择项改必填）。
- `cli/` 处理器本身的改写；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：
  - `main.ts` 只 import `cli/`、`bootstrap/` 与一张写明理由的小白名单（进程启动器、版本、日志、路径、Git 凭据协议）；
  - 除参数解析辅助与 `main` 外不声明函数；
  - `bootstrap/deployment.ts` 只在 `selectDeployment` 里读部署模式；
  - 以上由结构锁锁定，含负例。
- **AC-2**：`selectDeployment` 对两种部署给出对应的 `kind` 与操作；单机的两个校验操作以统一错误、原报文拒绝；托管描述在选择时捕获环境
  （用例）。
- **AC-3**：既有 CLI、托管迁移 / 还原 / 待命集成用例与架构守卫（RFC-349 / 359 / 393 / 394 / 395 / 400）全部通过，P0 变异 lane 通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **部署描述而不是在 `DeploymentProfile` 上加操作**：托管 profile 的构造会先校验数据库，`migrate` 与两个校验命令不能为了拿到操作先跑一遍
   启动前的校验。描述只在选择时捕获环境，`profile()` 仍按需构造。
2. **统一报错保持原报文**：拒绝走同一个错误类型，文本与现在一致，脚本与运维文档不受影响。
3. **按需加载照旧**：托管 Git 凭据、工作区镜像等轻量子命令仍按需 import，只是 import 的对象换成 bootstrap 的入口。
