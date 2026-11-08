# RFC-472 设计

**落在哪个 context、哪一层**：属主重新准入的端口在 intent `application/ports`（消费方拥有端口），实现在 identity-access `composition`（按结构满足），
接线在 bootstrap；REST 的 Bearer 语法在 identity-access `domain`，经 `public/types` 提供。**承担的演进**：W9-D 的一步——identity-access 最后一个
legacy 兼容转出 `auth/session.ts` 退役，intent 经 legacy 文件取 identity-access composition 的那条藏起来的值依赖消失。**留下的债**：`routes/auth.ts`
仍在 legacy `routes/`（取多个 legacy `src/auth/*` 文件，迁入模块会生出 `R2`）；HTTP 会话路由仍需要整个 dispatch 依赖（含属主重新准入），虽然
HTTP 发起的 turn 本身不重新准入。

## 1. intent：属主重新准入端口

- **`application/ports/intentOwnerAdmission.ts`**（新）：
  ```ts
  export interface IntentOwnerAdmissionPort {
    admitOwner(ownerUserId: string): Promise<Actor | null>
  }
  ```
  `Actor` 取 legacy `@/auth/actor`（dispatcher 已取）。注释写明语义：返回的是登记过的直接权威的 actor（`resourceCatalogFor` 会把它解析回权威，
  手拼的投影会被拒），null 即账号停用或删除，调用方跳过该会话、不换别的身份。
- **`application/dispatcher.ts`**：`IntentDispatchDeps.identityAccess: DirectAuthorityAdmissionRuntime` 换成 `ownerAdmission: IntentOwnerAdmissionPort`；
  `resumeQueuedIntentWorkingSets` 里 `admitDurableWorkOwner(deps.identityAccess, id)` + `actorOfDirectAuthority(admitted)` 换成
  `await deps.ownerAdmission.admitOwner(id)`（null 照旧 `continue`）。不再 import `@/auth/session`。
- **`inbound/intentSessionRoutes.ts`**：`IntentSessionRouteDependencies.identityAccess` 换成 `ownerAdmission: IntentDispatchDeps['ownerAdmission']`，
  拼 dispatch 依赖时转交。

## 2. identity-access

- **`composition/authentication.ts`**：新增 `composeDurableWorkOwnerAdmission(identityAccess: DirectAuthorityAdmissionRuntime)`，返回冻结的
  `{ admitOwner(ownerUserId) }`（`Promise<Actor | null>`；返回类型由推断给出，不为它新取 legacy `@/auth/actor`）。`admitOwner` 的函数体就是
  dispatcher 原来那两行：`admitDurableWorkOwner(identityAccess, id)`，非 null 取 `actorOfDirectAuthority`。不 import intent。
  只为本文件而在的转出一并删除：`parseLocalBearerHeader`（改由 `public/types` 提供，见下）、`extractUpgradeToken`（只在本地 WS 适配器内部用）、
  `resolveIdentity`、`reresolveActor`、`reresolveIdentity`、`ResolvedUpgradeIdentity`、`WsCredentialFingerprint`（全仓零消费）；定义处与模块内的
  调用不动。留下的转出（守护进程与属主准入、`describeCredential`、`resolveActor`、`resolveActorWithWsCredential` 等）服务装配根与用例的凭据夹具，
  头注释随之改写。
- **`domain/localBearerCredential.ts`**（新）：`parseLocalBearerHeader` 从 `infrastructure/local/httpAuthentication.ts` 原样迁来（正则与空值处理逐字不变）。
  本地 HTTP 适配器与 CrewStation 适配器改从这里取（CrewStation 原来取本地适配器的文件）。
- **`public/types.ts`**：转出 `parseLocalBearerHeader`（定义处在 domain）。

## 3. 其余调用方

- **`bootstrap/daemonModules/providerCore.ts`**：`admitDaemonIdentity` / `actorOfDirectAuthority` 改从 `composition/authentication` 取（与已有的
  `CredentialAdapterSelection` 并成一条 import）。
- **`bootstrap/daemonApplication.ts`**（应用根）：给 intent 束的输入加 `ownerAdmission: composeDurableWorkOwnerAdmission(identityAccess)`
  （`identityAccess` 即 provider core 的 identity-access runtime，与原来 intent 束取的 `directAuthority` 是同一个）。组装放在应用根而不放进
  intent 束：RFC-380 规定 `bootstrap/daemonModules/` 里只有 provider core 可以 import identity-access；应用根本来就把 identity-access 的组装注入
  各个束（如 integration 束的 `createEventAutomationDelegatedContextBinding`）。
- **`bootstrap/daemonModules/intent.ts`**：`DaemonIntentInput` 加 `ownerAdmission: IntentDispatchDeps['ownerAdmission']`，dispatch 与会话路由都收它；
  原来的 `identityAccess = { directAuthority }` 冻结对象删除。
- **`routes/auth.ts`**：登出与改密码两处 `extractBearerToken(c)` 换成 `parseLocalBearerHeader(c.req.header('Authorization'))`，从 identity-access
  `public/types` 取（与 `UserAccessError` 同一条 import）；RFC-285 B4 的注释改写：REST 的 Bearer 读点就是这一个 public 函数。
- **`src/auth/session.ts`** 删除（`multiAuth` 与 `extractBearerToken` 随之退役）。`src/auth/actor.ts` 的头注释原来写「由 auth/session.ts 的
  multiAuth 解析」，改指 HTTP 认证中间件（只改注释）。

## 4. 行为等价

- **属主重新准入**：`composeDurableWorkOwnerAdmission` 的函数体与 dispatcher 原来的两行同一段计算（同一个 `admitDurableWorkOwner`、同一个
  `actorOfDirectAuthority`），null 的条件不变；装配根给的 runtime 仍是 `{ directAuthority: core.directAuthority }`。
- **Bearer**：同一个函数（迁移不改函数体），登出与改密码读的是同一个 `Authorization` 头。
- **composition 转出**：删掉的只是转出名，函数定义与模块内调用不变。
- **守护进程准入**：`providerCore` 取的是同一对函数（原来经本文件转出）。
- **HTTP 认证中间件**：生产从未用 `multiAuth`（装配根经 `credentials.http` 组装）；`multiAuth` 的函数体就是本地 HTTP 凭据适配器
  （`composeLocalHttpAuthentication`）外面套传输中间件（`composeHttpAuthenticationMiddleware`），用例改用同一条组装。

## 5. 用例与账本

- **改 import 路径**（`@/auth/session` → `@/modules/identity-access/composition/authentication`，名字不变）：`tests/fixtures/rfc363-task-workspace-crash-worker.ts`、
  `tests/helpers/{daemonTaskExecutionBundle,eachProviderTaskExecution,realtimeRuntime}.ts` 与 `rfc212` ×2、`rfc305-user-access-integration`、
  `rfc310-digital-employee-human-review-system-mock-e2e`、`rfc310-pr4-execution-host`、`rfc312` ×2、`rfc349-intent-boot-resume-authority`、
  `rfc349-postgresql-daemon-system-identity`、`rfc359-t3-action-execution-runners`、`rfc359-w5hn-launch-resources-delegated-authority`、
  `rfc362-launch-contracts`、`rfc363` ×2、`rfc370-workspace-upload-bindings`、`rfc382` ×2、`rfc383-daemon-actor`（命名空间 spy 改 spy 同一模块）、
  `rfc384-daemon-intent-bundle`、`rfc396-mr-runtime-wiring`。
- **intent 依赖改名**：`rfc293-intent-state`、`rfc349-intent-boot-resume-authority`、`rfc370-intent-configuration-query`、`rfc370-system-agent-callers`
  传 `ownerAdmission: composeDurableWorkOwnerAdmission(runtime)`；`rfc384-daemon-intent-bundle` 的路由依赖键断言改为 `ownerAdmission` 只有 `admitOwner`。
- **`auth-session`**：`multiAuth` 换成用例内用生产组装拼中间件（本地 HTTP 凭据适配器收 `createAuthRuntimeFor({ db })`——与装配根同一个工厂——、
  守护令牌与 identity-access runtime，外面套传输中间件），四组断言不动；RFC-285 B4 文本锁改指新的读点：`routes/auth.ts` 从 identity-access
  `public/types` 取 `parseLocalBearerHeader`、identity-access `public/` 不转出 `extractUpgradeToken`、本地 HTTP 适配器与 Bearer 语法文件都没有 query
  读点，其余（`routes/` 不碰 upgrade 入口、`tokenAuth` 不复活、WS 只经注入的凭据面）不变。
- **路径清单**：`rfc305-architecture-lock` 的 identity-access 消费方清单去掉本文件两条、加 `bootstrap/daemonApplication.ts` 取
  `composition/authentication` 一条，public `types.ts` 的导出名清单加 `parseLocalBearerHeader`；`rfc347-identity-access-runtime`
  的 `importPaths('identity-access/composition')` 去掉本文件；`rfc349-auth-provider-contract` 的 legacy auth
  facade 清单去掉本文件；架构报告 owner 表去掉本文件。指着本文件的四处注释（两个用例 helper、`rfc359-w5hn`、system-mocks 的 `dev-auth/seed.ts`）改指
  `localCredentialAdmission.ts`。
- **新增 `tests/rfc472-auth-session-facade-retirement.test.ts`**：
  1. 本文件不在、四个包（backend / shared / frontend / system-mocks）与 e2e、脚本零 import、零按路径读（说明符与字符串字面量扫描，带负对照）；
  2. 编译期锁：`ReturnType<typeof composeDurableWorkOwnerAdmission>` 与 `IntentOwnerAdmissionPort` 逐项相同（`Equal`）；
  3. 依赖方向：intent 的源码对 identity-access 只有 `public/` 的类型导入（现有的六处都是 `import type`），没有值导入（AST 判定，带正对照）；
     dispatcher 不再出现 `admitDurableWorkOwner` / `identityAccess`；
  4. 接线：应用根组装一份 `ownerAdmission` 交给 intent 束（intent 束不 import identity-access），dispatch 与路由收的是同一个，只有 `admitOwner`；
  5. 行为（两引擎）：属主重新准入对在册用户返回登记过的 actor（`resourceCatalogFor` 能解析回权威），停用与删除的账号返回 null；
     `parseLocalBearerHeader` 的语法（大小写、空白、缺值、多段）与 public 转出的是同一个函数。
- **账本**：`architecture/commons-debt.json` 的 `R1` 按实测销账（预期 57 → 53）；guard-manifest 刷新改到的守卫文件行数。

## 6. 失败模式

- 装配根漏接 → 编译期（`ownerAdmission` 必填）与 `rfc384` / 本 RFC 的接线锁同时报出。
- identity-access 改了准入返回形状 → 本 RFC 的 `Equal` 锁编译期报出。
- 有人在 intent 里重新取 identity-access 的值 → 本 RFC 的依赖方向锁与架构报告（`R1` / 跨 context 记录、off-DAG 值边）报出。
- 第二个 REST Bearer 读点 → B4 文本锁报出。

## 7. 测试策略

完整实现与用例写完后集中验证：backend 全量 SQLite（导出仓库）、PostgreSQL lane（改到的用例、闭包、全部架构测试）、P0 两引擎、shared /
system-mocks / frontend 三个包的用例、文档用例、架构报告计数复核。
