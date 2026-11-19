# RFC-506 设计：身份访问的改密用例与意图目录的演员绑定迁出 composition

## 1. 现状（HEAD `7f0e056c3`，源码实读）

identity-access 组合层控制流（F13 口径，按语法树计数）只有 `userOperations.ts` 第 31、32 行；intent 的非 RFC-370 部分只有
`resourceCatalog.ts` 第 33 行。两个目标文件都不在 `composition-forbidden-import-files` 里。

**identity-access `composition/userOperations.ts`，49 行**：

- 第 3～12 行 import：`ulid`、`@/auth/application/authRuntime` 的 `AuthRuntime` 类型、`@/auth/actor` 的 `SYSTEM_USER_ID`、`@/auth/passwords`
  的 `hashPassword`、本模块 `composition.ts` 的 `IdentityAccessModule` 类型、public `operations` 的 `createIdentityUserOperations` 与
  `IdentityUserOperations` 类型、`@/util/errors` 的 `ValidationError`。
- 第 14～49 行 `composeIdentityUserOperations(input)`：把 identity-access 运行时的成员、`ulid`、`hashPassword` 与认证运行时的两次 OIDC
  查询交给 `createIdentityUserOperations`，其中：
  - `resetPassword`（第 30～43 行）：`userId === SYSTEM_USER_ID` 就抛
    `ValidationError('system-user-immutable', 'cannot reset password for __system__')`（第 31～33 行）；否则取一次 `Date.now()`（第 34 行），
    `await input.auth.writeLocalPasswordIfUnmanaged({ userId, passwordHash: await hashPassword(newPassword), forcePasswordChange: force ?? false, activate: true, updatedAt: now })`
    （第 35～41 行），再 `await input.auth.revokeAllSessionsForUser(userId, now)`（第 42 行）。
  - `afterDisabled`（第 44～47 行）：撤销会话后转交可选的 `input.afterDisabled`。

相关的既有代码：

- public `operations.ts` 第 373 行起的 `resetPassword` 描述符先过 schema 与准入，再调
  `deps.resetPassword({ userId: input.targetUserId, newPassword, force })`，交出 `{ ok: true }`。
- 同目录的命令（`createManagedUser`、`updateOwnProfile`、`updateUserAccess`）都以 `deps.systemUserId` 取系统用户 id，不取 `@/auth`。
- 认证运行时 `AuthRuntime` 声明 `writeLocalPasswordIfUnmanaged(input: LocalPasswordWrite)` 与 `revokeAllSessionsForUser(userId, now?)`；
  `LocalPasswordWrite` 是 `@/auth/application/authPersistence.ts` 第 80～86 行的五个只读字段。

**intent `composition/resourceCatalog.ts`，48 行**：

- 第 2～13 行 import：`@/auth/actor` 的 `Actor` 类型、identity-access public `participants` 的三个类型、resource-catalog public `queries` 的
  `ResourceCatalogQuery` 类型、`@/routes/operationAuthority` 的 `directOperationAuthority` 与 `directRequestAuthority`、本模块 application 的
  `composeIntentResourceCatalogFor` 与它的依赖类型。
- 第 15～48 行 `composeIntentResourceCatalogBinding(input)`：
  - 第 28 行一张 `WeakMap<object, Actor>`；
  - 第 30～36 行交给 `input.resourceCatalog.createQuery` 的 `resolveActor(context)`：按上下文取 actor，取不到就抛
    `intent-resource-catalog-context-not-bound`（第 32～34 行）；
  - 第 37～44 行的 `contextFor(actor)`：经 `directRequestAuthority` 与 identity-access 的上下文工厂铸出 `'http'` 查询上下文，第 42 行登记
    actor 后交出；
  - `authorityFor` 与 `catalogs` 原样交给 `composeIntentResourceCatalogFor`。
- `application/resourceCatalog.ts`（209 行）已有 `composeIntentResourceCatalogFor`，已取 `Actor` 与 `QueryContext` 类型。

使用方（都只取装配入口，名字与路径不变）：

- `composeIdentityUserOperations`：bootstrap `commandBootstraps.ts` 第 27 行取、第 55 行调用；`daemonHttpComposition.ts` 第 60 行取、第 239 行
  调用；用例 `users-cli`（第 29 行动态取、第 37 行调用）与 `helpers/userFixture.ts`（第 12 行取，第 126、170 行调用；改密夹具第 152 行起按
  需替换认证运行时的两个方法以固定时钟）。
- `composeIntentResourceCatalogBinding`：bootstrap `daemonModules/intent.ts` 第 26 行取、第 74 行调用；`rfc384-daemon-intent-bundle` 在
  第 232、562 行 spy 它。

按路径、名字或文本钉着这两个文件的锁：

- `rfc305-architecture-lock`：identity-access 组合入口的两条消费边（第 321、330 行）与 intent 两个文件取 identity-access public
  `participants` 的边（第 365、366 行）。
- `architecture/rfc390-neutral-http-binding` 与 `architecture/rfc380-daemon-module-bundles` 的名字表。
- `rfc347-identity-access-runtime` 第 280 行：`userOperations.ts` 取 `identity-access/composition`。
- `rfc349-auth-caller-closure` 第 26～45 行：读 `userOperations.ts` 的源码，断言它不含 `DbClient` 与两个旧认证存储的 import，且含
  `await input.auth.writeLocalPasswordIfUnmanaged` 与 `await input.auth.revokeAllSessionsForUser`。这是唯一按文本钉着要迁走写法的锁。
- `architecture/rfc359-w5-t19b-composition-root-complete` 的组合根占位账本第 150 行：
  `modules/intent/composition/resourceCatalog.ts: marker=1, prose=0, holder=0`。计入的正是那句 `not-bound`，账本注释（第 94～97 行与
  第 161～162 行）已写明它是每请求的旁路、不是装配缺口。账本逐字相等、只降不升。

`rfc349-intent-boot-resume-authority` 第 95 行是用例自己的夹具副本，不取生产代码。新文件路径与三个新名字都未被占用。

## 2. 机制与落位

### D1 用例与用例状态落 application

改密只经认证运行时的两次凭据写、哈希与时钟工作，是 identity-access 的命令，落 `application/commands/`；演员绑定是纯内存状态，只服务目录
工厂，落 intent 的 `application/resourceCatalog.ts`。两者都不需要 infrastructure。依赖 `@/routes/operationAuthority` 的铸上下文仍留在
intent 的组合文件（application 不取 routes）。

### D2 新位置

- **identity-access `application/commands/resetUserPassword.ts`**（新）：
  - `ResetUserPasswordDependencies`：`systemUserId: string`；`credentials` 是认证运行时的两次凭据写——`writeLocalPasswordIfUnmanaged(input)`
    与 `revokeAllSessionsForUser(userId, now)`，结构类型，写入形状与 `LocalPasswordWrite` 相同；`hashPassword`；`now(): number`。
  - `createResetUserPassword(deps)`：交出 `resetPassword({ userId, newPassword, force })`。函数体是原第 31～42 行：`SYSTEM_USER_ID` 改为
    `deps.systemUserId`，`Date.now()` 改为 `deps.now()`，`input.auth` 改为 `deps.credentials`，`hashPassword` 改为 `deps.hashPassword`；
    其余逐字（错误类型、错误码与文案，先写后撤销，同一时刻）。
  - 只取 `@/util/errors` 的 `ValidationError`。
- **intent `application/resourceCatalog.ts`**：新增 `createIntentCatalogActorBinding()`，交出 `{ bind(context, actor), resolveActor(context) }`。
  表是原第 28 行的 `WeakMap<object, Actor>`，`resolveActor` 是原第 32～34 行逐字，`bind` 是原第 42 行；不新增 import。

### D3 composition 只装配

- `composeIdentityUserOperations(input)` 签名不变：`resetPassword` 改为
  `createResetUserPassword({ systemUserId: SYSTEM_USER_ID, credentials: input.auth, hashPassword, now: () => Date.now() })`，其余成员
  （含 `afterDisabled`）不变。`credentials` 交的是 `input.auth` 本身，两次调用的接收者仍是认证运行时；进程时钟仍在调用时取。
- `composeIntentResourceCatalogBinding(input)` 签名不变：建一个演员绑定，`resolveActor` 交给 `createQuery`，`contextFor` 铸出上下文后
  `bind` 再交出；`authorityFor` 与 `catalogs` 不变。每次装配建一个绑定，与原来每次装配一张表相同。

### D4 锁与账本

- `architecture/counts.json`：`composition-control-flow-identity-access` 2 → 实测（预计 0）、`composition-control-flow-intent` 5 → 实测
  （预计 4）。`guard-manifest.json` 登记 RFC-506 用例。
- T19b 账本删掉 intent 组合文件那一行，留一条销账注释：错误串随用例进 application，application 不在该守卫的扫描面；守卫要挡的是组合根交出
  “以后再补”的占位，这处从来不是。
- `rfc349-auth-caller-closure` 第一条用例另读 `application/commands/resetUserPassword.ts`：
  - 它进同一组“不含 `DbClient` 与两个旧认证存储”的检查；
  - `await deps.credentials.writeLocalPasswordIfUnmanaged` 与 `await deps.credentials.revokeAllSessionsForUser` 由它承接；
  - 组合文件仍须含 `await input.auth.revokeAllSessionsForUser`（`afterDisabled`），只有 `writeLocalPasswordIfUnmanaged` 一条改钉新文件。

  断言不放松：两次写仍须是对认证运行时 Promise 绑定的 `await`。

- 不改：使用方与其余的锁（装配入口不变）；`design/` 里的历史记述。

## 3. 清单（退出门）

| 新位置（`packages/backend/src/modules/` 下）                      | 声明并交出                                                 | 只声明不交出 |
| ----------------------------------------------------------------- | ---------------------------------------------------------- | ------------ |
| `identity-access/application/commands/resetUserPassword.ts`（新） | `ResetUserPasswordDependencies`、`createResetUserPassword` | —            |
| `intent/application/resourceCatalog.ts`                           | `createIntentCatalogActorBinding`                          | —            |

允许的形状：两个组合文件没有 if / for / while / do / switch / try / throw 语句，各自从新位置取实现；`composeIdentityUserOperations` 与
`composeIntentResourceCatalogBinding` 仍在原文件声明并导出。

## 4. 用例

新增 `packages/backend/tests/rfc506-password-reset-catalog-actor-binding-out-of-composition-boundary.test.ts`（文件名带 `boundary`），登记
guard-manifest：

- ① 清单里交出的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的新位置声明；新文件恰好声明、交出清单列的名字，既有
  文件交出清单列的名字；两个组合文件只声明并导出原有的装配入口。
- ② 两个组合文件没有控制流语句、各自从新位置取实现（`createResetUserPassword` 与 `createIntentCatalogActorBinding` 在生产代码里都只在各自的
  组合文件调用一次，时钟以函数交出、系统用户 id 与认证运行时原样交入）；两个组合文件不再出现 `new WeakMap`、`Date.now()` 只以函数交出；
  带负对照。
- ③ 新代码的依赖面是闭集：identity-access 的新文件只取 `@/util/errors` 的 `ValidationError`，不用进程全局；intent 的
  `application/resourceCatalog.ts` 的 import 与此前相同、新函数不用进程全局；带负对照。
- ④ 行为（直接调用新位置）：
  - 改密：系统用户被拒，错误是 `ValidationError`、码 `system-user-immutable`、文案不变，且不哈希、不取时钟、不写、不撤销；普通用户先哈希再写、
    后撤销，写入形状与时刻、撤销的时刻都对，`force` 缺省 false、给 true 时透传，时钟每次取一次；
  - 演员绑定：登记后按上下文取回；未登记的上下文抛 `intent-resource-catalog-context-not-bound`；两个绑定互不串台。

行为另由现有用例对拍：改密经 `users-service`、`users-http`、`users-cli`、`rfc221-account-auth-policy` 与 e2e
`identity-credentials.spec.ts`（含系统用户被拒）；演员绑定经
`rfc384-daemon-intent-bundle`、`rfc349-intent-boot-resume-authority` 与走意图目录的用例。

## 5. 失败模式

- **用例走样**：函数体逐字迁移；系统用户 id 与时钟改由装配传入，取值与次数不变（时钟只在过了系统用户判断后取一次）。
- **方法脱离接收者**：`credentials` 交的是认证运行时对象本身，`deps.credentials.writeLocalPasswordIfUnmanaged(...)` 的 `this` 仍是它；改密
  夹具替换方法后交入的对象同样原样使用。演员绑定的两个方法只用闭包里的表，不用 `this`，作为函数值交给查询时行为不变。
- **遗留引用**：装配入口不变，使用方不改；迁移后按名字、路径片段与代码里的字符串字面量全仓再扫，另按全部文件类型扫一遍。
- **按原始文本扫的锁误计**：`rfc347-identity-access-runtime` 的 `importPaths('identity-access/composition')` 在原始源码（含注释）里找这段
  路径，新文件的注释若写出组合文件的路径就会被算作取组合层的文件。所以新文件的注释不写这条路径（集中验证第一轮因此红过，见 plan）。
- **账本走样**：T19b 账本逐字比对，组合文件那一行若不删就红（减了也红）；`rfc349-auth-caller-closure` 改钉后若新文件不再 `await` 两次写
  就红。

## 6. 取舍（可推翻）

1. **两个模块一个 RFC**：都是 S10 的余项，各只有一处、同一种形状（用例或用例状态写在 composition），清单与用例按文件逐项列。
2. **保留装配入口、只迁实现**：入口被 bootstrap、用例夹具、名字表与消费边钉着，留下它们就不必改使用方。
3. **系统用户 id 由装配传入**：与同目录命令取 `deps.systemUserId` 的做法一致，application 不取 `@/auth`；错误类型保持
   `ValidationError`（不改成本模块的 `UserAccessError`），路由映射出的状态码与错误码不变。
4. **凭据写的依赖用结构类型**：只列两次写的形状，不取 `@/auth/application` 的 `AuthRuntime`，命令只认识它用到的那两个方法。
5. **演员绑定与目录工厂同文件**：它只服务 `composeIntentResourceCatalogFor` 的查询上下文；铸上下文要用 routes 的授权构造，仍在组合文件。
6. **T19b 账本销账而不是迁登记**：该守卫的扫描面是组合根，application 不在其中；账本注释早已把这处定性为每请求的旁路、不是装配缺口，迁出后
   组合根少一处误计，长期目标 0 更近一步。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是一个用例与一处用例状态，都落 application；两个组合文件只装配、没有控制流；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-506 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读两个组合文件与两个新位置；只对这些范围宣告退出门。
- **C13**：两项 `composition-control-flow-*` 收紧到实测；其余触及的计数不升；T19b 账本少一行。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 identity-access 与 intent 的余项：改密用例与目录演员绑定离开 `composition/`；identity-access 组合层控制流归零，intent
  余下的都是 RFC-370 余项。
- **留下**：code-capability 的未绑定缺省、integration 的可选装配与 system-operations 的装配期路径选择（S10 收口的门允许装配期选择时随上限
  登记；缺省回落随 S12）；resource-catalog 的 `resourceAcl.ts` 另立；source-control、development-automation 与 task-execution 的余项由后继
  步骤承接；`crewstation*` / `taskImage*` 待 RFC-370 余项。
