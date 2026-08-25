# RFC-327 技术设计 —— 记忆的过滤面与 facets

## 0. 一句话

把「按 scope / 标签找知识」从**只有 REST 一半**补成 REST 与 MCP 同一套参数：多标签 any/all、一个 facets 端点，MCP 侧靠 `resource_read` 的 `query` 透传消费它们。

## 1. 落位与架构对齐（CLAUDE.md §RFC workflow 第 8 条）

RFC-294 的目标架构里，记忆是 `memory` bounded context（`design/RFC-294-.../design.md:90,554`）。本 RFC 的改动量很小（一个只读端点 + 一个过滤参数），**不**承担 memory 模块的搬迁波次，但按目标架构的分层意图落位：

- **domain（纯函数）**：标签匹配与聚合语义没有 I/O，落在 `packages/shared/src/memoryTags.ts` —— REST 路由、service、（将来的）前端筛选器共用同一套判据，先于任何 I/O 可断言。放 shared 而不是 backend 的 modules 层，是因为前端筛选器与 wire schema 也要用它，与 `textOccurrences.ts`（RFC-326 PR-A）同一形态。
- **application / infrastructure**：仍沿用现有的 `services/memory.ts` + `routes/memories.ts`，**不新增** facade、不新增跨 context 依赖。
- **承担的演进 / 留下的债**：本 RFC 只把「标签语义」从 service 内联逻辑提成共享纯函数；`services/memory.ts` 整体搬进 `modules/memory/**` 仍是 RFC-294 memory 波次的工作，本 RFC 不做，也不制造新的阻碍（新逻辑全在纯函数里，搬迁时原样跟着走）。

零偏离项。

## 2. Wire 契约

### 2.1 `packages/shared/src/schemas/memory.ts`

```ts
export const MemoryTagModeSchema = z.enum(['any', 'all'])

export const MemoryListFilterSchema = z.object({
  status: MemoryStatusSchema.optional(),
  scopeType: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  tag: z.string().min(1).max(40).optional(), // legacy，保留
  tags: z.array(z.string().min(1).max(40)).max(16).optional(),
  tagMode: MemoryTagModeSchema.optional(),
})

export const MemoryFacetsQuerySchema = z.object({
  status: MemoryStatusSchema.optional(),
  scopeType: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).optional(),
})

export const MemoryFacetsResponseSchema = z.object({
  status: MemoryStatusSchema, // 实际参与统计的状态（缺省 approved）
  scopeType: MemoryScopeSchema.nullable(),
  scopeId: z.string().nullable(),
  total: z.number().int().nonnegative(), // 参与统计的**记忆**条数，不是标签数
  tags: z.array(z.object({ tag: z.string(), count: z.number().int().positive() })),
})
```

`tagMode` 故意**不给 zod default**：`MemoryListFilterSchema.parse({})` 必须仍然逐字等于 `{}`（既有单测锁着这条），缺省 any 在 `matchesTagFilter` 里兜底。

### 2.2 查询串的拆法（`routes/memories.ts`）

`?tags=a,b` 与重复 `?tags=a&tags=b` 都收：`c.req.queries('tags')?.flatMap(v => v.split(','))` → `normalizeTagList`（trim → 去空 → 保序去重）。空串因此天然等于「没给」，不会变成一条 `min(1)` 校验红。

## 3. 纯函数（`packages/shared/src/memoryTags.ts`）

| 函数                 | 语义                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `normalizeTagList`   | trim → 去空 → **保序**去重（保序是为了错误消息与 facets 之外的调试可读性）   |
| `wantedTags`         | legacy `tag` + `tags` 合并成一个集合                                         |
| `matchesTagFilter`   | 想要的标签为空 ⇒ **恒真**（等于不筛）；否则按 `tagMode` 判 `some` / `every`  |
| `aggregateTagFacets` | 一条记忆里的重复标签只计一次（先 `new Set`）；排序 count 降序 → tag 码元升序 |

排序必须稳定：facets 的输出会进模型上下文，顺序抖动会让缓存与 diff 都失效。

## 4. Service（`services/memory.ts`）

两条读法（summary / 含 body）此前各写了一遍 `tags.includes(needle)`，现在都改成 `matchesTagFilter(tags, filter)`——**同一实现**。

为什么仍在内存里筛而不下推到 SQL：`tags` 是 JSON 列，SQLite 上没有可靠的数组包含谓词，多标签 AND/OR 更做不到；而 `status` / `scopeType` / `scopeId` / `search` 仍在 WHERE 里，先把行数压下来再在内存里判标签。**这是既有形态，本 RFC 没有改变它的复杂度量级**。

## 5. 路由（`routes/memories.ts`）

```
GET /api/memories/facets       permissions: ['memory:read']   tokenAccess: 'allow'
```

**注册位置**：必须在 `GET /api/memories/:id` **之前**——注册顺序决定匹配，反过来 `facets` 会被当成一个 id 走进详情路由并 404。这条有独立测试（AC-10），因为它是「加一行 registerRoute 时最容易踩、且症状看起来像别的 bug」的那类顺序依赖。

**统计面 = 调用者可见面**（不可商量）：

```ts
const rows = await listMemories(db, { ...parsed.data, status }) // status 缺省 approved
const visible = await filterMemoriesByScopeVisibility(db, actor, rows)
const items =
  status === 'candidate' && !hasResourceAclBypass(actor)
    ? visible.filter((r) => r.status !== 'candidate') // RFC-285 B7 Q4
    : visible
return c.json({ status, scopeType, scopeId, total: items.length, tags: aggregateTagFacets(items) })
```

缺省 `approved` 的理由：与注入链路一致（`services/memoryInject.ts:141-206` 只取 approved）。一个外部代理问「有哪些标签」，想要的是**能被注入的事实**，不是未审的候选。

## 6. MCP（`mcp/tools.ts` / `mcp/resourceSchemas.ts`）

- `ResourceRoutes` 新增可选 `facets`；`memory` 填 `{GET, /api/memories/facets}`。没有它的 kind 调 `method:'facets'` 明确抛错（不静默退回 list——静默退回会让模型以为「这个 kind 没有标签」，而真相是「这个工具没做」）。
- `resource_read` 的 `inputSchema` 加 `query: z.record(z.string()).optional()`，直接落到 `DispatchRequest.query`（`mcp/dispatch.ts:45`）。权限面不变：读面对所有 token 开放（RFC-247 D3），过滤不是新能力，只是让同一条读路由可被收窄。
- `describe_resource` 现在同时报 `operations`（含 facets）与 `querySchema`——后者由 `querySchemaFor(kind)` 从**路由自己校验用的** `MemoryListFilterSchema` 生成，和 `bodySchemas` 同一形态：加一个过滤字段，契约自动跟着走，没有第二处需要手抄。

## 7. 失败模式

| 场景                               | 行为                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `tagMode` 非法                     | 422 `invalid-filter`（与 `status` / `scopeType` 同形）          |
| `tags` 超过 16 个 / 单个超 40 字符 | 422（schema 上限，与写入侧的标签上限对齐）                      |
| facets 的 scope 不可见             | 该 scope 的记忆不进统计——不是 403，与列表「不可见即不存在」同形 |
| `method:'facets'` 用在没有的 kind  | 工具层错误 `resource_read: <kind> has no facets`                |
| 记忆一条都没有                     | `{total:0, tags:[]}`，不是 404                                  |

## 8. 测试策略

| 面         | 文件                                                             | 覆盖                                                       |
| ---------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| 纯函数     | `packages/shared/tests/rfc327-memory-tags.test.ts`               | AC-16（含「无标签恒真」「重复标签只计一次」「稳定排序」）  |
| REST + MCP | `packages/backend/tests/rfc327-memory-filter-and-facets.test.ts` | AC-1…AC-15，含 ACL 泄露那条（管理员看得见 / 外人看不见）   |
| 既有回归   | `packages/shared/tests/memory-schema.test.ts`                    | `parse({})` 仍逐字等于 `{}`（tagMode 不给 default 的理由） |
