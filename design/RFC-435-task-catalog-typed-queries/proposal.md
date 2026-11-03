# RFC-435 任务目录的 public 查询改为类型化、不接遗留 Actor（RFC-294 W4 E10）

- **状态**：In Progress（2026-11-03 落档）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、设计、
  实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 余项 E10，同时是 W4 B / D 第二步的一部分
- **前序**：[RFC-434](../RFC-434-inbound-adapter-public-contracts/proposal.md)（精确 public 入口与入站路由第一批）
- **落位**：task-catalog 模块（`application/ports`、`public/queries`、`public/types`、`composition/required-ports`）与两个来源适配器
  （task-execution、digital-employee）；入站路由 `routes/taskCatalog.ts` 只改依赖类型与序列化位置。

## 1. 背景

RFC-294 §4.1 对 E10 的要求：task-catalog 的 public 查询接类型化查询、返回类型化页，不接完整 `Actor`、不返回 JSON 字符串，来源经
`TaskCatalogSource` 注入。

现状：

- `TaskCatalogQueries` 定义在 `task-catalog/composition.ts`；`routes/taskCatalog.ts` 为拿到它深引 composition（RFC-434 留下的 7 条之一）。
- 两个查询都接遗留 `Actor`（`@/auth/actor`）：`listSources(actor)` 返回 `string`，`list(query, actor)` 返回 `Promise<string>`。
  实现里先构造好 `TaskCatalogSourcesDocument` 与 `TaskCatalogPageSchema` 校验过的页，再 `JSON.stringify`。
- 来源端口 `TaskCatalogSourceListInput.actor: Actor`。两个来源实际只读用户 id 与权限集合：
  - task-execution 经 `taskListViewerOf({ user: { id }, permissions })`；
  - digital-employee 读 `permissions.has('tasks:read:all')` 与 `user.id`。
- `rfc400` 结构规则禁止 public 导出的签名带遗留 `Actor`，所以 RFC-434 不能把 `TaskCatalogQueries` 从 public 导出。

## 2. 目标

- **G1 类型化查询**：`listSources` 返回 `TaskCatalogSourcesDocument`，`list` 返回 `Promise<TaskCatalogPage>`。序列化移到入站路由，
  HTTP 响应逐字节不变。
- **G2 不接完整 Actor**：
  - task-catalog 在 `public/types` 声明自己的 `TaskCatalogViewer`，只含 `user.id` 与 `permissions`；
  - 查询与来源端口都接它，路由传入的请求 actor 在结构上满足它；
  - 来源端口的字段由 `actor` 改名为 `viewer`。
- **G3 精确 public 入口**：`TaskCatalogQueries` 搬到 `application/ports`，由新的 `public/queries` 导出；路由不再深引 composition。
- **G4 行为不变**：列表、来源文档、权限判定、游标与 facets 不变。

## 3. 非目标

- 来源注册、分页与游标算法的改动；
- 其他 6 个仍深引的路由；
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`TaskCatalogQueries` 位于 task-catalog `application/ports`，由 `public/queries` 导出；签名不含遗留 `Actor`，不返回 JSON 字符串。
- **AC-2**：`routes/taskCatalog.ts` 只经精确 public 入口依赖 task-catalog，`R1-inbound-module-internals` 202 → 201。
- **AC-3**：来源端口接 `TaskCatalogViewer`，两个来源适配器随之更新；`rfc400` 遗留 `Actor` 规则、public surface 与全部架构测试通过。
- **AC-4**：任务目录用例（含 HTTP 面）全部通过，响应体与改前一致。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **task-catalog 自有的查看者类型，不用 identity-access 的权限快照**：E10 只要「谁在看、能看全量吗」两件事。自有的最小类型不给
   task-catalog 新增跨 context 依赖；请求 actor 与 identity-access 快照在结构上都满足它。
2. **序列化留在入站路由**：查询返回模块合同里的类型，HTTP 层决定线上的编码；路由照旧用 `jsonDocumentResponse`，响应头与字节不变。
3. **来源端口字段改名 `viewer`**：名字跟随语义，两个适配器各改一两处，不留旧名。
