# RFC-327 任务分解 —— 记忆的过滤面与 facets

## 1. 子任务

| 编号 | 内容                                                                                                                                           | 依赖  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| T1   | `packages/shared/src/memoryTags.ts`：`normalizeTagList` / `wantedTags` / `matchesTagFilter` / `aggregateTagFacets` + index 导出                | —     |
| T2   | shared schema：`MemoryTagModeSchema`、`MemoryListFilterSchema` 加 `tags` / `tagMode`、`MemoryFacetsQuerySchema` / `MemoryFacetsResponseSchema` | T1    |
| T3   | `services/memory.ts` 两条读法改用 `matchesTagFilter`                                                                                           | T1    |
| T4   | `routes/memories.ts`：list 解析 `tags` / `tagMode`；新增 `GET /api/memories/facets`（注册在 `:id` 之前）                                       | T2/T3 |
| T5   | `mcp/tools.ts`：`ResourceRoutes.facets`、`resource_read` 的 `query` 与 `method:'facets'`、`describeResource` 报出 facets                       | T4    |
| T6   | `mcp/resourceSchemas.ts`：`querySchemaFor(kind)`，memory → `MemoryListFilterSchema`                                                            | T5    |
| T7   | 测试：shared 纯函数 + backend REST/MCP（AC-1…AC-16）                                                                                           | T1–T6 |
| T8   | 文档：三件套、`design/plan.md` 索引、`STATE.md`                                                                                                | T7    |

## 2. PR 拆分建议

单 PR（一个只读端点 + 一个可选过滤参数 + MCP 透传，拆开反而让契约测试跨 PR 悬空）。

## 3. 变更记录

### 单笔（2026-08-25，T1–T8）

**新增**：`packages/shared/src/memoryTags.ts`；`GET /api/memories/facets`；`resource_read` 的 `query` 与 `method:'facets'`；`describe_resource` 的 `querySchema`；`packages/shared/tests/rfc327-memory-tags.test.ts`（16 例）、`packages/backend/tests/rfc327-memory-filter-and-facets.test.ts`（13 例）。

**改动**：`MemoryListFilterSchema` 加 `tags` / `tagMode`（都可选，`parse({})` 仍逐字等于 `{}`）；`services/memory.ts` 两条读法共用 `matchesTagFilter`；`routes/memories.ts` 的 list 解析 `tags`（逗号或重复参数）与 `tagMode`（非法值 422）。

**复跑**：shared 38 例绿；backend `rfc327-*` 13 例、`rfc247-mcp-server` / `rfc247-api-docs` / `rfc247-route-registry` / `rfc247-route-coverage` / `routes-memories-patch` / `rfc285-b7-memory-matrix` / `memory-inject-snapshot` 109 例全绿。

**没做的（已在 proposal §3 列为非目标）**：前端标签筛选器 UI、标签规范化/建议、分页、独立的「所有 scope」端点（MCP 上已能列出四类 scope 资源）。

## 4. 验收清单（对照 proposal §7）

| AC    | 证据                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------- |
| AC-1  | `rfc327-memory-filter-and-facets.test.ts` › tags=a,b 缺省 any                                                       |
| AC-2  | 同上 › tagMode=all                                                                                                  |
| AC-3  | 同上 › 重复 ?tags= 与逗号写法等价，空串等于没给                                                                     |
| AC-4  | 同上 › legacy 单值 tag 仍然工作，并与 tags 合并                                                                     |
| AC-5  | 同上 › tagMode 只收 any / all，别的值 422                                                                           |
| AC-6  | 同上 › 标签计数按 count 降序、同数按标签升序                                                                        |
| AC-7  | 同上（同一例）：candidate 不进缺省统计面                                                                            |
| AC-8  | 同上 › 按 scope 收窄                                                                                                |
| AC-9  | 同上 › 看不见的 scope 的标签不出现在 facets 里                                                                      |
| AC-10 | 同上 › facets 路由排在 /api/memories/:id 之前                                                                       |
| AC-11 | 同上 › 非法 status / scopeType ⇒ 422                                                                                |
| AC-12 | 同上 › list 带 query：过滤真的到达路由                                                                              |
| AC-13 | 同上 › method:facets 打到 facets 端点                                                                               |
| AC-14 | 同上 › 没有 facets 的 kind 明确报错                                                                                 |
| AC-15 | 同上 › describe_resource 报出 facets 操作与 query 契约                                                              |
| AC-16 | `packages/shared/tests/rfc327-memory-tags.test.ts`（normalizeTagList / matchesTagFilter / aggregateTagFacets 各条） |
