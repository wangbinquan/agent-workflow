# RFC-472 退役 identity-access 的兼容转出 `auth/session.ts`：intent 的属主重新准入改走自有端口（RFC-294 W9-D 第十九步）

- **状态**：In Progress（2026-11-08）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（legacy 横向层按 owner 归位、兼容转出清仓）
- **前序**：[RFC-370](../RFC-370-crewstation-hosted-deployment/proposal.md)（凭据准入归 identity-access composition，本文件留作兼容转出）；
  [RFC-285](../RFC-285-semantic-unification-and-authz/proposal.md) B4（REST 只读 Bearer 一个入口）；
  [RFC-345](../RFC-345-resource-catalog-contract-cutover/proposal.md)（Resource Catalog 只认已登记的直接权威，intent 启动恢复因此按属主重新准入）。
- **落位**：identity-access `domain/localBearerCredential.ts`、`public/types.ts`、`composition/authentication.ts`；intent
  `application/ports/intentOwnerAdmission.ts`、`application/dispatcher.ts`、`inbound/intentSessionRoutes.ts`；装配根 `bootstrap/daemonApplication.ts`、`bootstrap/daemonModules/`。

## 1. 背景

1. `src/auth/session.ts`（owner 记为 identity-access）是 RFC-370 留下的兼容转出：转出 identity-access `composition/authentication` 的十个函数与四个
   类型，外加两段自有代码——`multiAuth`（用旧参数形状拼 HTTP 认证中间件，生产已不用、只剩一个用例）与 `extractBearerToken`（REST 读 Bearer）。
   它取 identity-access 的 composition，是 4 条 `R1`（commons-debt G-01）。
2. 三个生产调用方：
   - 装配根 `bootstrap/daemonModules/providerCore.ts` 取 `admitDaemonIdentity` / `actorOfDirectAuthority`——装配根本可直取模块 composition；
   - intent 的 `application/dispatcher.ts` 取 `admitDurableWorkOwner` / `actorOfDirectAuthority` 与 `DirectAuthorityAdmissionRuntime`，启动恢复时按会话
     属主重新准入。目标 DAG 上 intent 对 identity-access 只有 `authority-type-only`（只取 `public/types` 的类型），没有值依赖——现在 intent 经
     legacy 文件绕到 identity-access composition，是一条藏起来的依赖（架构报告记 3 条 legacy 出向记录）；
   - `routes/auth.ts`（owner identity-access）的登出与改密码取 `extractBearerToken` 读当前请求的会话令牌。
3. 用例与脚本：25 个文件经本文件取这些函数，5 个用例按路径读它（RFC-285 B4 文本锁、两份 identity-access composition 消费方清单、legacy auth
   facade 无库访问清单、架构报告 owner 表）。

## 2. 目标

- **G1** 装配根直取：`providerCore` 改从 identity-access `composition/authentication` 取守护进程准入。
- **G2** intent 自有端口：intent 声明 `IntentOwnerAdmissionPort`（`admitOwner(ownerUserId) → Actor | null`，null = 账号停用或删除、调用方跳过该会话）；
  dispatcher 与会话路由的依赖 `identityAccess` 换成 `ownerAdmission`；identity-access composition 新增 `composeDurableWorkOwnerAdmission`
  按结构满足（用例编译期锁），应用根组装、注入 intent 束（RFC-380：束里只有 provider core 取 identity-access）。intent 不再取 identity-access 的任何值。
- **G3** REST Bearer 语法由 identity-access public 提供：`parseLocalBearerHeader`（单机部署的 `Authorization: Bearer <token>` 语法，纯函数）从
  `infrastructure/local/httpAuthentication.ts` 迁到 `domain/localBearerCredential.ts`，本地与 CrewStation 两个 HTTP 适配器、`public/types` 都从这里取；
  `routes/auth.ts` 改取 public（它已从同一文件取 `UserAccessError`）。REST 仍只有这一个 Bearer 读点（RFC-285 B4 不变）。
- **G4** 本文件删除；`multiAuth` 随之退役（唯一用例改用生产 composition 拼中间件）；identity-access composition 里只为本文件而在的七个转出名
  （`parseLocalBearerHeader`、`extractUpgradeToken` 与五个全仓零消费的准入名）一并删除；用例改取定义处；路径清单与锁随之改。
- **G5** 账本下降：`R1` 57 → 53、`legacy-horizontal-files` 181 → 180；不新增跨 context 内部文件对、off-DAG 边与文件对、public surface 偏差、
  不可达生产文件与 `module-layer-violations`，未被消费的 public 符号不升（public surface 只多 `parseLocalBearerHeader` 一个、它有生产消费方）。

## 3. 非目标

- `routes/auth.ts` 本身迁入 identity-access（它取多个 legacy `src/auth/*` 文件，迁入会生出 `R2`）；`auth/` 其余文件的去处。
- 准入语义：守护进程准入、会话 / PAT / 守护令牌解析、WS 准入、撤销重扫与属主重新准入的行为逐字不变。
- `services/task.ts`、`services/systemAgentRun.ts`、`services/runtime/**`。
- 任何错误码、错误文案与 HTTP 行为的变化；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`src/auth/session.ts` 不在，四个包的源码、用例与脚本零 import、零按路径读；intent 不取 identity-access 的值；
  `composeDurableWorkOwnerAdmission` 的返回与 intent 端口逐项相同（编译期锁）；REST 只有 `routes/auth.ts` 经 public 取的那一个 Bearer 读点。
- **AC-2**：架构计数按实测（§2 G5），账本逐条相等；越界类计数、public surface 偏差与未被消费的 public 符号不升。
- **AC-3**：受影响用例（HTTP 认证三条令牌轨、登出与改密码、intent 启动恢复的属主重新准入与会话路由、守护进程身份、架构守卫）与新增
  RFC-472 用例全部通过；四个包的用例都跑。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **intent 用自有端口而非取 identity-access public**：目标 DAG 只给 intent 对 identity-access 的类型依赖；属主重新准入要铸一份已登记的直接
   权威（`admittedSessionCredential` 只在 identity-access 内部），intent 只需要「属主 → Actor 或 null」。端口归消费方、identity-access 按结构满足、
   装配根接线（RFC-471 同一模式）。
2. **Bearer 语法放 public 而非经路由依赖注入**：它是单机部署对客户端公开的凭据格式（纯语法、无状态），`routes/auth.ts` 已从 identity-access
   `public/types` 取值；注入一个语法函数只多一层接线。定义迁到 `domain`，public 不必指向 infrastructure，CrewStation 适配器也不再为一条语法
   取本地适配器的文件。
3. **`multiAuth` 退役而非迁走**：生产中间件早已由装配根经 `composeHttpAuthenticationMiddleware(composeLocalHttpAuthentication(…))` 组装，
   `multiAuth` 只剩 `auth-session` 一个用例在用；用例改用同一条生产组装，测的就是生产路径。
