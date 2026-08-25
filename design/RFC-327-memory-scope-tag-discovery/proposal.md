# RFC-327 按 scope 与标签检索知识：记忆的过滤面与 facets

> 状态：Done（2026-08-25）｜前置：RFC-041（长期记忆）、RFC-045（人工建/改记忆）、RFC-099 / RFC-285（记忆 ACL 与 candidate 读面）、RFC-247（MCP 面）、RFC-248（repo_group scope）

## 1. 背景

用户问：「现在有增加知识的 MCP 和 API 吗，还有按照 scope、标签来过滤知识的 MCP 和 API 吗」。按源码对账，答案是**写有、筛半有**：

| 能力               | REST                                                                        | MCP                                                              |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 增加知识           | ✅ `POST /api/memories`（`MemoryCreateRequestSchema`）                      | ✅ `resource_write { kind:'memory', method:'create' }`           |
| 按 scope 过滤      | ✅ `GET /api/memories?scopeType=&scopeId=`                                  | ❌ `resource_read` 只收 `{kind, method, id}`，一个查询参数都不收 |
| 按标签过滤         | ⚠️ 只有**单个** `tag`，service 层内存里精确匹配（`services/memory.ts:249`） | ❌ 同上                                                          |
| 「有哪些标签可选」 | ❌ 全仓没有任何 distinct/facets 端点                                        | ❌                                                               |

后果有三条，都指向同一个形态——**本地代理只能全量拉回来自己筛**：

1. MCP 客户端要按 scope / 标签找知识，只能 `resource_read(list)` 拉全部可见记忆，再逐条 `get` 取正文。库一大，这条路直接把上下文吃光——正是产品立项要避免的事（`proposal/init.md` 的初衷）。
2. 「有哪些标签」无处可问。标签是自由文本（`tags` ≤16 × ≤40 字符），代理写记忆时只能凭空造一个新词，久了标签空间碎成一地，过滤本身失去意义。
3. 单值 `tag` 表达不了「api 且 db」或「api 或 db」，而这正是按主题收窄的常用形态。

## 2. 目标

- **G1** REST 的记忆列表支持多标签过滤，语义可选 `any`（缺省）/ `all`，且不破坏既有单值 `tag`。
- **G2** 新增 `GET /api/memories/facets`：在**调用者可见的**记忆上聚合标签与计数，可按 scope 收窄。
- **G3** MCP `resource_read` 支持 `query` 透传与 `method:'facets'`，让本地代理能用与 REST 同一套参数检索知识。
- **G4** `describe_resource` 报出这套查询契约（模型不用猜参数名再读 422）。

## 3. 非目标

- **不做**「获取所有 scope」的独立端点。用户拍板：这些信息 MCP 上**已经有了**——`resource_read` 对 `agents / workflows / repos / repo-groups` 都能 list（`mcp/tools.ts` RESOURCE_KINDS，四条路由均 `tokenAccess:'allow'`），scope 类型本身是固定五值枚举；facets 再按 scope 收窄即可回答「这个 scope 下有哪些标签」。
- 不做前端筛选器 UI（记忆页今天没有标签筛选，属独立的界面工作）。
- 不做标签规范化 / 建议 / 合并（标签仍是自由文本）。
- 不改记忆的 ACL 语义（本 RFC 只**消费** `canViewMemory` / `filterMemoriesByScopeVisibility`）。
- 不做分页（记忆列表今天本来就是全量返回，分页要单独立项）。

## 4. 用户故事

- **US1**：本地代理拿 PAT 问「repo `aw` 这个 scope 下有哪些知识标签」→ `resource_read {kind:'memory', method:'facets', query:{scopeType:'repo', scopeId:'…'}}` → 标签 + 计数，按 count 降序。
- **US2**：代理按主题收窄 → `resource_read {kind:'memory', method:'list', query:{tags:'api,db', tagMode:'all', status:'approved'}}`。
- **US3**：代理写入新知识前先看已有标签，复用既有词而不是造新词（US1 的直接用途）。
- **US4**：普通用户调 facets，**看不见**私有 scope 的标签——标签名本身不泄露「那儿有记忆存在」。

## 5. 已拍板决策

| #   | 决策                        | 取值                                                                                |
| --- | --------------------------- | ----------------------------------------------------------------------------------- |
| D1  | 「获取所有 scope」要不要做  | **不做**——MCP 上已能列出四类 scope 资源，facets 负责「这个 scope 下有什么」         |
| D2  | facets 的形态与缺省统计范围 | **统一 facets 端点**，缺省只统计 `approved`（与注入链路一致），可按 `status` 显式改 |
| D3  | 多标签语义                  | **`tags` + `tagMode=any\|all`，缺省 any**；保留 legacy 单值 `tag` 向后兼容          |
| D4  | MCP 形态                    | **扩 `resource_read`**：加 `query` 透传 + `method:'facets'`（不新开专门工具）       |

**不可商量的约束（不作为选项呈报）**：facets 与列表一样，统计面**恰好是调用者的可见面**——先过 `filterMemoriesByScopeVisibility` + candidate 收紧，再聚合。否则标签名本身就成了私有 scope 的存在性泄露。

## 6. 能力影响清单

本 RFC **不关闭任何既有能力**（不属于 CLAUDE.md §RFC workflow 第 7 条的收缩型 RFC）：

- 单值 `tag` 参数保留，语义不变（与 `tags` 同时给时合并成一个集合再按 `tagMode` 判）。
- `resource_read` 的 `query` 是**可选**参数，不给时与今天逐字等价。
- `method` 枚举新增 `'facets'`，`'list' | 'get'` 不变。
- 唯一的行为变化：`GET /api/memories?tagMode=<非法值>` 现在 422，而不是被忽略——与该路由其它过滤参数（`status` / `scopeType`）的既有形态一致。

## 7. 验收标准

### REST

- **AC-1** `GET /api/memories?tags=a,b` 缺省 any：任一命中即返回。
- **AC-2** `tagMode=all` 要求全部命中。
- **AC-3** 重复 `?tags=a&tags=b` 与逗号写法等价；`?tags=` 空串等于没给。
- **AC-4** legacy `?tag=x` 语义不变，且与 `tags` 合并后按 `tagMode` 判。
- **AC-5** `tagMode` 非法值 ⇒ 422（不是静默忽略）。
- **AC-6** `GET /api/memories/facets` 返回 `{status, scopeType, scopeId, total, tags:[{tag,count}]}`，count 降序、同数按 tag 升序，一条记忆里的重复标签只计一次。
- **AC-7** facets 缺省只统计 `approved`；未审 candidate 不进缺省统计面。
- **AC-8** facets 可按 `scopeType` / `scopeId` 收窄。
- **AC-9** 不可见 scope 的标签不出现在 facets 里，`total` 也不含它。
- **AC-10** facets 路由注册在 `/api/memories/:id` **之前**（否则 `facets` 会被当成一个 id 走进详情路由）。
- **AC-11** facets 的非法 `status` / `scopeType` ⇒ 422。

### MCP

- **AC-12** `resource_read` 的 `query` 原样到达路由的查询串。
- **AC-13** `method:'facets'` 打到 `/api/memories/facets`。
- **AC-14** 没有 facets 的 kind 调 `method:'facets'` 明确报错，不静默退回 list。
- **AC-15** `describe_resource('memory')` 报出 facets 操作与 `querySchema`（取自路由自己校验用的 `MemoryListFilterSchema`）；没有查询契约的 kind 不长出 `querySchema`。

### 纯函数

- **AC-16** `normalizeTagList` / `matchesTagFilter` / `aggregateTagFacets` 的语义（trim+去空+保序去重、无标签恒真、any/all、重复标签只计一次、稳定排序）有独立单测。
