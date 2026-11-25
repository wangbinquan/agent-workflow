# RFC-583 技术设计

记号：`S/` = `packages/backend/src/`，`SO/` = system-operations 的模块目录。数字取 HEAD `1c5d5947e`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：三个绑定进 system-operations 的 `inbound/http`，挂载函数经 `SO/composition/routes.ts` 转出（RFC-576 的形状）；两个传输
  工具进 `platform/http`（与 `requestParsing`、`jsonDocument`、`multipartLaunch` 等同层）。
- **承担的演进**：`routes/` → 模块 `inbound/` 的第八批，并让 platform 的 HTTP 工具开始从 `routes/` 归位。
- **不新增** DAG 之外的边：三个绑定只取本模块 public、platform 与 legacy 的 `@/auth/actor`、`routes/registry`（与别的绑定相同）；platform 的两个文件
  不取任何模块。
- **留下的债**：`registry`、`operationRoute` 仍在 `routes/`（见 §5 第 3 条）；`health`。
- **偏离项**：无。归属表把三个绑定记为 platform，本 RFC 放进 system-operations，理由见 §5 第 1 条；这不改检测器的规则（文件进模块目录后按路径
  归属，归属表的那一行随之删除）。

## 1. 文件去向与连接

| 原文件                          | 新位置                                 |
| ------------------------------- | -------------------------------------- |
| `S/routes/config.ts`            | `SO/inbound/http/configRoutes.ts`      |
| `S/routes/docs.ts`              | `SO/inbound/http/docsRoutes.ts`        |
| `S/routes/plantuml.ts`          | `SO/inbound/http/plantumlRoutes.ts`    |
| `S/routes/publicOrigin.ts`      | `S/platform/http/publicOrigin.ts`      |
| `S/routes/verifiedBodyLimit.ts` | `S/platform/http/verifiedBodyLimit.ts` |

- **`configRoutes.ts`**：删去为旧路径保留的 `ConfigConcurrencyHotApplyInput` / `ConfigConcurrencyHotApplyCommand` 转出——取它们的
  `bootstrap/daemonHttpComposition.ts` 与一个用例改从 `SO/public/commands` 取（装配根只取模块的 public 与 composition）。
- **撤回**：`ApplicationConfigurationCommands`（读 / 更新守护进程配置的命令端口）在模块外只有这个绑定用，声明逐字移进
  `SO/application/applicationConfiguration.ts`（它的工厂所在），本模块的 composition 与绑定从那里取。它带的 open-type 记录（`update(patch: unknown)`）
  随之离开 public 面，`rfc294-architecture-preflight` 的偏差账本删去那一行。
- **`publicOrigin.ts`**：参数类型从 system-operations 的配置查询换成本文件声明的 `PublicBaseUrlConfiguration`（`read()` 同步或异步地给出
  `Pick<Config, 'publicBaseUrl'>`——配置查询的 `read()` 两种都可能，`Config` 来自 shared）。配置查询结构上满足它，两个调用方（`docsRoutes.ts` 与 `routes/oidc-auth.ts`）不改调用，只改 import；
  `oidc-auth.ts` 按凭据相邻文件的约定只改那一行 import。
- **`verifiedBodyLimit.ts`**：只改说明注释；两个使用方（collaboration 的评审路由、resource-catalog 的资源包路由）改 import。
- `SO/composition/routes.ts` 多转出 `mountConfigRoutes`、`mountDocsRoutes`、`mountWellKnownRoutes`、`mountPlantumlRoutes`；`server.ts` 的三条 import 并进
  已有的那一条，挂载调用与顺序不变。

## 2. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去五行；`counts.json` 的 `legacy-horizontal-files` 上限 69 → 64，`public-surface-deviations` 上限 29 → 28。
- RFC-576 用例断言 `composition/routes.ts` 恰好转出它的七个挂载函数、`server.ts` 恰好从那里取这七个：改为七个加本 RFC 的四个。
- 钉着旧路径的用例随改：按路径读源码的 `rfc203-uniform-errors`、`rfc234-config-intent-runtime`、`rfc266-task-fanout-pools`、
  `rfc349-config-route-provider-boundary` 与 `rfc441-platform-helpers-out-of-services`（按名字表拼 `routes/` 下的路径）；`rfc305-architecture-lock` 的“读账号角色的文件”清单（同一处读，换了路径）；直接 import 旧路径的用例与测试
  辅助文件由搬迁脚本改说明符（`rfc349` 那条另把取类型的部分改从 `SO/public/commands` 取）。源码注释里指向旧文件的三处（task-execution 的执行许可、
  资源包路由）改写成新位置或端点名。
- 不改：描述过往迁移的注释；e2e 注释里的源码行号锚点（同 RFC-579 design §2）；`architecture/commons-debt.json` 的审计锚点（记的是审计当时的位置，
  同条目的其他锚点早已不在原处，没有用例读它们）。
- 新增 `tests/rfc583-system-operations-config-docs-plantuml-routes-and-http-helpers-boundary.test.ts`，登记 guard-manifest：① 五个旧路径不存在，`src` /
  `tests` / `scripts` 的全部说明符不再解析到它们（带负对照）；② 三个绑定对模块的 import 只取本模块（别名到 public，相对路径到 application / domain /
  public），不取 `@/db` 与 `services/`（带负对照）；③ platform 的两个文件不取任何模块与 legacy 横向目录（带负对照）；④ `ApplicationConfigurationCommands`
  不在 public 面、在 application 里声明一次；⑤ `server.ts` 从 `composition/routes` 取四个挂载函数。

## 3. 检索与推算

同 RFC-578 design §3；在 `1c5d5947e` 的报告上推算三个绑定一起进 system-operations（`publicOrigin` 换掉类型后不再取它，效果相同）：撤回
`ApplicationConfigurationCommands`、`ConfigConcurrencyHotApplyCommand` 与 `ConfigConcurrencyHotApplyInput` 三个——后两个是装配根经旧路径的转出取的，
装配根改从 public 取之后仍有模块外消费者，留在 public；实际撤回 1 个。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-583 用例 ① 红，`legacy-horizontal-files` 也红。
- **绑定多取别的模块**：用例 ② 红；取 DAG 之外的 offered public 时 `rfc294-review-offered-edge-dag` 也红。
- **platform 的文件又取模块**（例如把配置查询类型加回来）：用例 ③ 红，platform 的层规则也红。
- **撤回的端口又回到 public**：用例 ④ 红，未消费 public 符号计数也红。

## 5. 取舍（可推翻）

1. **三个绑定归 system-operations，而不是归属表记的 platform**：platform 不依赖模块（design §3），而这三个绑定读的正是 system-operations 的配置
   查询 / 命令；system-operations 已经是守护进程级端点（总览、守护进程信息、维护、备份 / 还原、迁移）的 owner，配置、API 文档与 PlantUML 代理同属
   这一类。归档的 RFC-294 plan 曾把 config 归“配置用例”、docs / health 归“platform liveness/docs”；docs 若要进 platform，得先有 platform 里的路由
   注册器，那是第 3 条暂缓的事。
2. **`publicOrigin` 进 platform 时换成中性形状，而不是留在 system-operations**：它是纯推导加一层读请求头，调用方里还有 identity-access 的 OIDC
   路由；放进 system-operations 会让那个 legacy 文件深引模块内部。中性形状只声明它读的那一个字段，配置查询结构上满足它。
3. **`registry` / `operationRoute` 暂缓**：它们进 platform 前得先让 HTTP 鉴权门不再从 identity-access 取 actor（换成 platform 声明的请求主体槽位，
   identity-access 往里放），这是动鉴权门的改法，与 identity-access 的路由一起另立。
4. **`health` 暂缓**：它读 task-execution 的运行任务计数，放进 system-operations 会产生 DAG 之外的类型边；与 RFC-582 汇总的五个路由一起等用户定。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`，装配根经 composition 取；中性的 HTTP 机制进 platform。**C11**：system-operations 的 public 面收窄
  一个只被本模块用的端口。**C12**：RFC-583 用例 ① 覆盖 `src` / `tests` / `scripts` 的全部说明符；② ～ ⑤ 只读相关文件。**C13**：
  `legacy-horizontal-files` 69 → 64、public 类型偏差 29 → 28，其余计数不升。
- **留下的债**：`routes/` 余 16 个；`registry` / `operationRoute` 与鉴权门；`health` 与等用户定的五个路由；identity-access 与凭据相邻的路由；task-catalog。
