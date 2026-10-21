# RFC-393 `cli/` 与 `bootstrap/` 分离：守护进程装配机制迁入 `bootstrap/`（RFC-294 S2c 第一步）

- **状态**：In Progress（2026-10-21 落档并派发 Codex 实施、本会话审核。用户 2026-10-20「按你推荐继续推进」：
  由本会话设计、交 Codex 实施并审核，免设计门与实现门；规则取舍由本会话按推荐决定，见 §6）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2c「消除 `cli/` ↔ `bootstrap/` 互相依赖」）；
  design §2「`bootstrap/` 承载唯一模块工厂图、provider 与部署 profile 选择、生命周期程序、各薄入口根」、§9.3「`cli/` 与 `bootstrap/`
  不得互相依赖」；前置 [RFC-391](../RFC-391-neutral-daemon-graph/proposal.md)、[RFC-392](../RFC-392-unified-test-entry/proposal.md)（S2b 完成）
- **基线**：HEAD `2845ccb65`（研究基线；行号仅作定位提示，以实施时源码为准）
- **落位**：守护进程的装配机制、启动序列、开发热重载与部署选择点都落在 `bootstrap/`；`cli/` 只剩子命令处理器。

## 1. 背景

S2b 之后，唯一的应用图、会话图与 HTTP 组合都在 `bootstrap/`，但它们依赖的装配机制还在 `cli/`：

- 22 个机制文件：13 个模块组 `cli/daemonModules/*`、生命周期程序 `cli/daemonLifecycleProgram.ts`、6 个 provider 会话运行时文件
  `cli/daemonProvider*.ts`、`cli/daemonRealtimePolicy.ts`、`cli/executionActivation.ts`；
- 启动序列 `cli/start.ts`（含 `StartOptions` 与会话输入类型）、开发热重载 `cli/dev.ts`、部署选择点 `cli/deployment.ts`
  及其单机迁移 `cli/migrate.ts`。

于是两个目录互相依赖：

- `bootstrap/ → cli/` 有 36 条 import（19 条值、17 条类型）；
- `cli/deployment.ts → bootstrap/crewstation.ts` 有 1 条值边；
- `server.ts` 还类型导入 `cli/daemonModules/providerCore.ts`。

RFC-379（生命周期程序暂放 `cli/`）与 RFC-391（会话图值导入 `cli/` 的机制文件）都把它登记为 S2c 要还的债。

现有守卫只按文件路径钉住其中一部分。RFC-391 只禁止 `cli/start.ts`、`cli/dev.ts` 的 import 声明指向 `bootstrap/`。
文件一迁走，这类写死路径的检查会静默失去覆盖，包括：

- RFC-391 那条检查；
- RFC-390 的根清单（缺文件时跳过）；
- G9 部署分支门的作用域；
- t19b 的扫描面。

## 2. 目标

- **G1 目录分离**：26 个文件迁入 `bootstrap/`，`cli/` 只剩 15 个子命令处理器；两个目录之间两个方向都零边。
- **G2 `server.ts` 不依赖 `cli/` 与 `bootstrap/`**：HTTP 用到的 provider core 合同在 `server.ts` 内按结构声明。
- **G3 目录级硬门**：取代按文件写死的检查，覆盖所有 import 语法，并配变异测试。
- **G4 覆盖不丢**：G9 作用域跟随迁入后的启动序列与开发热重载；其余按路径锁定的守卫改指新位置，目标文件缺失即红。
- **G5 纯迁移**：除 import 路径、`server.ts` 的结构类型与会话输入类型落位外，不改任何逻辑。

## 3. 非目标

- 类型化部署 profile、删除 `StartOptions`、去掉启动序列里的 `executionHost` 分支：后继 RFC。
- 执行权端口去掉部署字面量，SPA 标记与生命周期 profile 改由 profile 描述提供：后继 RFC。
- `main.ts` 自行装配的命令依赖迁入 `bootstrap/`，`migrate` / `verify-database-restore` 成为 profile 操作：后继 RFC。
- 改变任何生产行为、路由面或 API。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 目录分离**（结构锁）：
  - `src/cli/**` 与 `src/bootstrap/**` 之间两个方向零边，覆盖值导入、类型导入、行内 `type`、`export … from`、动态 `import()`、
    `require`、`import('x').T` 类型节点；
  - `server.ts` 不导入 `cli/` 与 `bootstrap/`；
  - 迁移清单里的旧路径在 `cli/` 下不再存在；
  - 新门每类语法、每个方向都有会红的变异测试，登记 guard-manifest。
- **AC-2 覆盖不丢**：
  - G9 作用域含迁入后的启动序列与开发热重载；`executionHost` 那处分支以新站点 id 登记，总数仍为 6；
  - RFC-379 / 380 / 390 / 391、t19b / t19c 等守卫指向新路径，目标文件缺失即红。
- **AC-3 行为**：后端全量（SQLite）、PostgreSQL 补跑与双 lane 全部通过，不改断言意图。
- **AC-4 账本**：
  - `architecture/counts.json` 不升；
  - commons-debt 双向精确：`cli/migrate.ts` 的两条 R1 债随文件迁入 `bootstrap/` 销账；
  - `BOOTSTRAP_FILES`、RFC-310 OS 架构清单、workflow 路径过滤同提交修订。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、windows-platform、maintenance-soak、三平台 e2e）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **迁移 26 个文件**：研究清单是 25 个，另加 `cli/migrate.ts`。`deployment.ts` 迁走后，它对 `./migrate` 的动态导入会变成
   `bootstrap → cli` 边；`migrate.ts` 只被这一处与两个测试使用，随行迁入后相对导入不变。
2. **命名**：`start.ts` → `daemonStart.ts`、`dev.ts` → `developmentReload.ts`；其余保持原名，`daemonModules/` 保留子目录。
3. **会话输入类型**：`DaemonProviderSessionComposeInput`、`ComposedDaemonProviderSession`、`DaemonProviderSessionComposer` 迁入只含类型的
   `bootstrap/daemonSessionInput.ts`，避免启动序列与会话图之间形成类型环。`StartOptions` 暂留 `daemonStart.ts`，由后继 RFC 取代。
4. **`main.ts` 继续把 `composeDaemonSession` 注入 `startCommand`**（RFC-391 的写法）。start 的调用形状由类型化 profile 的 RFC 一并改写，
   本 RFC 不碰，以免同一行改两次。
5. **`server.ts` 的 provider core 合同按结构声明**：字段类型取各 owner 的公开类型或应用层类型，`bootstrap/` 传入完整 core 作为结构子类型。
6. **G9 跟随迁移**：
   - 作用域里的 `cli/(start|dev)` 换成迁入后的两个文件；
   - 「作用域内文件指向 `bootstrap/` 即记一处」的 import 规则只对 `bootstrap/` 之外的文件生效，`bootstrap/` 内部互相导入就是装配本身；
   - `executionHost` 那处以新站点 id 登记，由后继 RFC 用 profile 描述消除，不靠换位置让它消失。
7. **新增目录级硬门**（新架构测试）：RFC-391 里只看两个文件的 import 检查删去，由新门承担。
8. **`BOOTSTRAP_FILES` 保持逐条列举**：迁移文件改为新路径，不改成前缀规则。
9. **偏离项**：无。`main.ts` 的注入写法沿用一个 RFC，见第 4 条。

## 7. S2c 后续（预计，逐个研究立项；编号以立项时的索引为准）

1. **类型化部署 profile**：
   - 部署选择点返回判别联合的 profile，单机默认值集中构造；
   - 取代 `StartOptions` 77 个槽及其三层逐字段转发；
   - `admitSelections` / `HOSTED_ONLY_SELECTIONS` 换成一次「托管要求 PostgreSQL」判定；
   - 启动序列的 `executionHost` 分支与 SPA 标记分支改由 profile 描述提供。
2. **执行权端口去部署字面量**：
   - 删除 `ExecutionAuthorityPort.mode`；
   - 生命周期 profile 与公开的 `ExecutionStatus.mode` 改由 profile 描述提供；
   - 定时备份来源移出 provider 适配表。
3. **入口根瘦身**：
   - `main.ts` 自行装配的命令依赖迁入 `bootstrap/`；
   - `migrate` / `verify-database-restore` 成为 profile 操作；
   - 部署不支持的命令统一报错。
