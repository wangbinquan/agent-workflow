# RFC-394 类型化部署 profile：选择点返回 profile，`StartOptions` 退役（RFC-294 S2c 第二步）

- **状态**：In Progress（2026-10-21 落档并派发 Codex 实施、本会话审核。用户 2026-10-20「按你推荐继续推进」：
  由本会话设计、交 Codex 实施并审核，免设计门与实现门；规则取舍由本会话按推荐决定，见 §6）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2c「以类型化的 profile 取代 `StartOptions` 覆盖；
  入口根不再按部署模式分支」）；design §9.2「部署能力差异由 profile 提供的能力描述表达」、§9.3「选择只在 bootstrap 发生一次」、
  §10.1「入口根只做参数解析、profile 选择」；前置 [RFC-393](../RFC-393-cli-bootstrap-separation/proposal.md)
- **基线**：HEAD `55f87d0a9`（行号仅作定位提示，以实施时源码为准）
- **落位**：`bootstrap/` 内的部署选择点与两个 profile 工厂；启动序列、会话图与应用图只消费 profile。

## 1. 背景

RFC-393 之后，部署相关的装配都在 `bootstrap/`，但「profile」还不是一个值：

- `bootstrap/deployment.ts` 读 `AW_DEPLOYMENT_MODE`：单机返回 `{}`，托管由 `bootstrap/crewstation.ts` 返回一份 `StartOptions` 覆盖；
  `main.ts` 再以 `{ ...deployment, ...opts, ...development }` 合并后交给 `startCommand`。
- `StartOptions` 有 77 个全可选槽（RFC-294 plan 记的 55 已过时），其中托管填 70 个、开发热重载填 2 个，5 个没有任何生产产出方。
- 同一组选择项被逐字段声明三次（`StartOptions` → `DaemonProviderSessionComposeInput` → `DaemonApplicationInput`），
  中间两处逐字段复制的对象字面量。
- 启动序列按 `executionHost` 分支决定是否做本机 git / claude-code 探测——这是 G9 账本里唯一的入口根部署分支。
- 「托管只跑 PostgreSQL」由 `bootstrap/daemonSessionAdapters.ts` 按 25 个键名逐个拦截，挂在 provider 轴上，同一检查执行两次。

## 2. 目标

- **G1 profile 是一个值**：部署选择点返回类型化的 `DeploymentProfile`（种类、所需 provider、宿主探测、默认监听地址与选择项），
  单机与托管各有一个工厂。
- **G2 `StartOptions` 退役**：启动序列接收 profile、命令行监听参数与开发热重载叠加三样东西，不再合并同型对象。
- **G3 选择项只声明一次**：`DeploymentSelections` 单一声明，会话输入与应用图输入经继承复用，不再逐字段重声明或逐字段复制。
- **G4 入口根零部署分支**：宿主探测由 profile 提供，启动序列只按探测结果统一处理致命错误；G9 账本 6 → 5。
- **G5 一次 provider 判定**：`admitSelections` 与 `HOSTED_ONLY_SELECTIONS` 删除，换成按 profile 所需 provider 的判定。
- **G6 `main.ts` 变薄**：只解析参数、选择 profile、调用启动序列；不再注入会话组合函数（RFC-391 为跨目录依赖留下的写法）。

## 3. 非目标

- 单机默认值集中构造、选择项改为必填、死槽 / 被遮蔽槽 / 可派生槽的清理：后继 RFC。
- 执行权端口去掉部署字面量，SPA 标记与生命周期 profile 改由 profile 描述提供：后继 RFC。
- `main.ts` 自行装配的命令依赖迁入 `bootstrap/`：后继 RFC。
- 改变任何生产行为、路由面或 API；安全相关改动。

## 4. 用户可见变化

无。

- 单机与托管的启动顺序、探测内容、日志与退出码不变；
- `--host` / `--port` 仍覆盖托管的默认监听地址。

## 5. 验收标准

- **AC-1 结构**（结构锁）：
  - `StartOptions`、`composeDeploymentStartOptions`、`composeCrewStationStartOptions`、`admitSelections`、`HOSTED_ONLY_SELECTIONS` 不存在；
  - `DeploymentSelections` 只声明一次，会话输入与应用图输入继承它且不重声明它的任何键；
  - 启动序列与 `main.ts` 不出现部署模式比较，也不读 `executionHost`；
  - `main.ts` 的 start 分支恰好调用一次部署选择与一次启动序列，不做对象展开合并。
- **AC-2 行为**：单机与托管 profile 各自的选择项、默认监听地址、宿主探测与 provider 判定有正向与负向用例；
  后端全量（SQLite）、PostgreSQL 补跑与双 lane 通过，既有用例不改断言意图。
- **AC-3 账本**：
  - G9 `deployment-mode-branch-sites` 6 → 5，`architecture/counts.json` 同步下调；
  - 其余账本、清单、守卫同提交修订，`counts.json` 其他项不升。
- **AC-4 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、windows-platform、maintenance-soak、三平台 e2e）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **profile 形状**：`kind`、`requiredProvider`、`probeHost`、`listen`（默认监听地址）、`selections` 五项。
   - `kind` 本 RFC 只用于日志与类型识别，生命周期与 SPA 标记改由它驱动留给后继 RFC；
   - 托管的 `host: '0.0.0.0'` 与端口从 `listen` 给出。
2. **选择项保持扁平、继承复用**：`DeploymentSelections` 沿用现有键名与可选性，会话输入与应用图输入 `extends` 它。
   - 应用图内 `input.x` 的读取与对模块组的转发不变；
   - 按 owner context 分组留到选择项改必填的后继 RFC 一并做，避免同一批行改两次。
3. **宿主探测归 profile**：
   - 单机工厂承载今天的 git merge-tree 门与 claude-code 软探测；
   - 托管工厂只记日志；
   - 启动序列只按探测结果（致命错误则打印、释放锁、退出码 1）统一处理。
4. **provider 判定**：profile 声明 `requiredProvider`（托管为 PostgreSQL），会话在打开数据库前判定一次，应用图对直接调用它的测试路径再判定一次，
   错误码沿用 `hosted-deployment-requires-postgresql`。托管以外的选择项在 SQLite 上不再按键名拦截，因为只有托管工厂会产出它们。
5. **`StartOptions` 中无产出方的 `configuration` 槽删除**；`runtimeLegacyConfiguration`、`databasePreOpenRecovery`、`startupLease`、
   `nodeRunPromptContentEffects` 四个无产出方的槽在本 RFC 原样保留在选择项里，由后继 RFC 逐个决定去留。
6. **开发热重载叠加**：`daemonHost` 与 `developmentIntegrity` 组成单独的开发叠加类型，由热重载根传入，不进 profile。
7. **偏离项**：无。
