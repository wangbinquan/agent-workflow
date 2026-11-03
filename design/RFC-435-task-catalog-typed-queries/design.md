# RFC-435 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`TC` = `S/modules/task-catalog`。以 RFC-434 收尾后的源码（`309cf83c7`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：task-catalog（`application/ports` 放查询合同，`public/queries` / `public/types` 导出，`composition/required-ports`
  的来源端口）；task-execution 与 digital-employee 的 task-catalog 适配器只改字段名；入站路由 `routes/taskCatalog.ts` 只改依赖类型与序列化位置。
- **承担的演进**：W4 E10 的 public 合同部分，同时是 W4 B / D 第二步：路由深引 7 → 6，`R1` 202 → 201。
- **不新增**跨 context 依赖：查看者类型由 task-catalog 自有，只依赖 shared 的 `Permission`。

## 1. 合同

```ts
// TC/public/types.ts
/** The caller the catalog lists for: its user id and effective permissions, never a full actor. */
export interface TaskCatalogViewer {
  readonly user: Readonly<{ id: string }>
  readonly permissions: ReadonlySet<Permission>
}

// TC/application/ports/taskCatalogQueries.ts（public/queries 导出）
export interface TaskCatalogQueries {
  listSources(viewer: TaskCatalogViewer): TaskCatalogSourcesDocument
  list(query: TaskCatalogListQuery, viewer: TaskCatalogViewer): Promise<TaskCatalogPage>
}

// TC/composition/required-ports.ts
export interface TaskCatalogSourceListInput {
  readonly viewer: TaskCatalogViewer // 原 actor: Actor
  // 其余字段不变
}
```

- `TaskCatalogSourcesDocument`、`TaskCatalogPage` 是 shared 里已有的 schema 推断类型（`z.infer<typeof TaskCatalogPageSchema>`）。
- 请求 actor（`actorOf(c)`）的 `user.id` 与 `permissions: ReadonlySet<Permission>` 在结构上满足 `TaskCatalogViewer`，路由不做转换。

## 2. 改动点

| 位置                                                                      | 改动                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `TC/application/taskCatalogQueryService.ts`                               | 实现 `TaskCatalogQueries`：参数改为 `viewer`，`listSources` 返回文档、`list` 返回页，去掉 `JSON.stringify` |
| `TC/composition.ts`                                                       | `TaskCatalogQueries` 改从 `application/ports` 导入                                                         |
| `TC/public/queries.ts`（新）、`TC/public/types.ts`                        | 导出查询合同；声明 `TaskCatalogViewer`                                                                     |
| `TC/composition/required-ports.ts`                                        | 来源输入字段 `actor: Actor` → `viewer: TaskCatalogViewer`                                                  |
| `S/modules/task-execution/infrastructure/taskExecutionCatalogSources.ts`  | `taskListViewerOf(input.viewer)`                                                                           |
| `S/modules/digital-employee/application/adapters/task-catalog-adapter.ts` | `input.viewer.permissions` / `input.viewer.user.id`                                                        |
| `S/routes/taskCatalog.ts`                                                 | 依赖 `{ queries: TaskCatalogQueries }`（public）；`jsonDocumentResponse(JSON.stringify(…))`                |

## 3. 账本

- `architecture/commons-debt.json`：删去 `routes/taskCatalog.ts -> @/modules/task-catalog/composition`，`inboundEdges` 202 → 201。
- 其余账本（public surface、跨 context 边、RFC-305 identity-access 消费者等）按实测核对；预期不新增条目。
- guard-manifest：刷新改动过的锁的行数。

## 4. 失败模式

- 序列化差异：`JSON.stringify` 从查询服务移到路由，同一对象、同一调用，字节不变。用例断言响应体。
- 来源仍用旧字段：typecheck 报出。

## 5. 测试策略

- **用例更新**：直接调用查询的用例改为断言类型化结果（不再 `JSON.parse`）；构造来源输入的用例改用 `viewer`。
- **回归**：
  - 任务目录 HTTP 用例（`rfc310-task-catalog` 等）；
  - 两个来源的分页 / 权限用例；
  - 全部架构测试。
- **集中验证**：全部实现与用例写完后一次进行：
  - 静态检查；
  - 全量 SQLite；
  - 受影响用例的 PostgreSQL lane；
  - 在导出仓库里跑按已提交源码出报告的用例；
  - P0 变异 lane。
