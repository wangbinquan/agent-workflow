# RFC-261 · 技术设计

## 1. 后端列表端点(`packages/backend/src/routes/webhookDeliveries.ts`)

### 1.1 查询参数

| 参数         | 语义                                | 校验姿态                                                                                                                                                                                             |
| ------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`     | 既有,六态枚举                       | `.catch(undefined)` 忽略非法值(不动)                                                                                                                                                                 |
| `eventType`  | 新增,`CodeHostEventTypeSchema` 九类 | 同 `status` 的 catch 姿态(D3/AC-4)                                                                                                                                                                   |
| `repoPath`   | 新增,精确 eq 匹配 `repo_path`       | 空串视为未过滤                                                                                                                                                                                       |
| `endpointId` | 既有                                | 不动                                                                                                                                                                                                 |
| `page`       | 新增,1-based                        | `Number.isFinite` 守门 + `Math.trunc`,≤0/NaN/±Infinity → 1(评审门 P1-①)                                                                                                                              |
| `limit`      | 既有                                | `Number.isFinite` 守门 + `Math.trunc`,≤0/NaN/±Infinity → 50、上限 200——RFC-257 原式 `Math.min(200,...\|\|50)` 对 `-1` 会放行负 LIMIT(drizzle 吞掉 → 全表 dump),对小数/Infinity 直接 500(评审门 P1-①) |
| `before`     | **删除**(D4)                        | 仓内零消费(前端/测试均未用),不留兼容层                                                                                                                                                               |

### 1.2 查询与响应

- WHERE:四过滤 AND 组合(沿用现有 `conds` 数组拼装)。
- 总数:同 WHERE 的 `count(*)`(drizzle `$count` / `sql<number>\`count(\*)\``),先 count
  后取页;两查询间新插入造成的 ±1 偏差接受(10s 轮询自愈),不开显式事务。
- 排序:`ORDER BY received_at DESC, id DESC`——id(ULID)tie-break 保证同毫秒行的
  跨页确定性(AC-2);现状裸 `received_at DESC` 在 tie 上顺序未定义,OFFSET 分页会重/漏。
- 取页:`LIMIT limit OFFSET (page-1)*limit`;**offset ≥ total 时短路**(不发行查询,
  直接空 `items`)——空页探测(`?page=180000`)零成本。total 以内的深 offset 保持
  O(offset) 索引游走,作为**已接受成本**记档:该端点是鉴权读面(`webhook-endpoints:read`),
  UI 只有上一页/下一页,API 侧刻意深翻页者按 count 上界自担时延(评审门 P2-①)。
- 带过滤的 `count(*)` 走 covering index,成本 O(选择性×N)(实测 23ms/100 万行,
  900 万行大选择性过滤 ~200ms/次)——10s 轮询下的已接受成本,记档(评审门 P2-②)。
- 响应:`{ items, total, page, pageCount }`;`pageCount = max(1, ceil(total/limit))`;
  `page` 原样回显(不做服务端钳制——客户端负责钳回,见 §3.3)。
- 列表投影继续**不带 `body_json`**(≤256KiB/行,详情页单独取,注释语义不变)。

### 1.3 distinct 仓库端点

```
GET /api/webhook-deliveries/repos → string[]
```

- 实现 = **loose index scan**(递归 CTE:`min(repo_path)` 起步、`repo_path > p` 逐个
  寻位下一个 distinct 值,吃 `idx_webhook_deliveries_repo_time` 前缀)。K 个仓库 =
  K×logN 次索引 seek;朴素 `SELECT DISTINCT` 在 900 万行上是每 30s 一次的全索引扫描。
- 权限 `['webhook-endpoints:read']`、`tokenAccess:'allow'`(与列表读面一致,RFC-260 D2)。
- **挂载顺序**:必须注册在 `GET /api/webhook-deliveries/:id` 之前,防止字面量 `repos`
  被吃进 `:id`(`/api/tasks/page` 同款先例,`routes/tasks.ts:217` 注释)。
- 无新错误码(route-error-code-coverage 锁零新增)。

## 2. 迁移 0139 `0139_rfc261_webhook_delivery_scale.sql`(D7',10 万/天基准)

三段:

1. **表重建**(create `webhook_deliveries_v2` → INSERT..SELECT → DROP → RENAME):
   唯一改动是 `body_json` 挪到**末列**。SQLite 行内只存前几 KB,大 body 走 overflow
   链;原 0138 布局里 `replayed_from_delivery_id`/`received_at` 排在 body 之后,列表
   投影(不取 body)每行也要走完整条链(≤256KiB ≈ 64 页)。该表 2026-08-04 上线、
   存量极小,重建是一次性低成本。`webhook_deliveries` 无 FK 进出(fires.delivery_id
   是软链),DROP+RENAME 安全;快照 parity 守卫两侧都走迁移链,不受影响。
2. **查询索引组**:`(received_at)`、`(status,received_at)`、`(event_type,received_at)`、
   `(repo_path,received_at)`;0138 的单列 `(status)` 索引随重建退役(被组合索引取代);
   `(endpoint_id,received_at)` 与去重 partial unique 原样重建。
3. **body-retention 部分索引**:`(received_at) WHERE body_json IS NOT NULL`——30 天
   置空 GC 只触未清行,置空后行自动退出索引(否则小时级 ticker 每次扫全部 30 天外行)。

### 2.1 EXPLAIN QUERY PLAN 实证(迁移后实测)

| 查询                   | 计划                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| 默认列表(order+offset) | `SCAN ... USING INDEX idx_..._received_at` + TEMP B-TREE **仅末项**(id tie-break 块内排序,非全量) |
| status/event/repo 过滤 | `SEARCH ... USING INDEX idx_..._{status,event,repo}_time (=?)` + 末项块排序                       |
| 过滤 count(\*)         | `COVERING INDEX`                                                                                  |
| 30 天 body GC          | `SEARCH ... USING INDEX idx_..._body_retention (received_at<?)`                                   |
| 90 天删行 GC           | `SEARCH ... USING INDEX idx_..._received_at (received_at<?)`                                      |
| /repos loose scan      | 每步 `SEARCH ... USING COVERING INDEX idx_..._repo_time (repo_path>?)`                            |

- journal 追加 idx=138 / tag=`0139_rfc261_webhook_delivery_scale`。
- `db/schema.ts` 同步:`bodyJson` 移至定义末尾 + 四枚普通索引声明(两枚 partial
  沿 0138 先例在迁移手写并注释)。

## 3. 前端

### 3.1 公共组件 `components/Pagination.tsx`(D6)

```tsx
<Pagination page={n} pageCount={m} onPageChange={fn} disabled?={bool} data-testid?={s} />
```

- `<nav aria-label={t('common.pagination.aria')}>` + 上一页/下一页(`.btn .btn--sm`)+
  「第 x / y 页」文案(`common.pagination.pageOf`,插值 `{page, pageCount}`)。
- 第 1 页禁用上一页、末页禁用下一页;`pageCount<=1` 时仍渲染(禁用态)保持布局稳定。
- 样式 `.pagination` 命名空间(flex + gap,贴既有 `.btn` 体系,无自造 chrome)。
- i18n:`common.pagination.{aria,prev,next,pageOf}` zh/en 双语。

### 3.1b 公共组件 `components/FilterBar.tsx`(D10)

```tsx
<FilterBar ariaLabel={...} trailing={hasFilter ? <清除筛选按钮/> : undefined} data-testid=...>
  <Segmented .../>                               {/* 状态 */}
  <FilterField label="事件"><Select .../></FilterField>
  <FilterField label="仓库"><Select .../></FilterField>
</FilterBar>
```

- `role="group"` + `aria-label`;`.filter-bar`(卡片:边框 + `--panel` 底 + 圆角)
  内分两栏:`__controls`(左,flex-wrap)与 `__actions`(右,`margin-left:auto`)。
- `FilterField` 渲染 `.filter-bar__label`(`<span>` 而非 `<label>`——Select 是自定义
  `role=combobox` 且已带 `ariaLabel`,套 `<label>` 会双重标注;`.changes__toolbar-label`
  同款分工)。
- `.filter-bar__field > .select` 覆写基础 `width:100%` 为 `width:auto; min-width:10rem`
  ——`.select` 的满宽是为表单栅格设计的,放进 inline-flex 会被压扁。
- 视觉母本 `.user-directory__toolbar` 是同一件东西的私有实现;本组件是它的公共化,
  users 页可后续迁移(不在本次改动内,避免掀翻其视觉基线)。

### 3.2 `DeliveriesPanel` 接线

- 状态:`status`(既有 Segmented)+ `eventType`/`repoPath`(两个 `Select`,RFC-036
  组件,`ariaLabel` 走新 i18n key)+ `page`。
- 任一过滤变更 → `setPage(1)`(AC-6)。
- 列表 query:key `['webhook-deliveries', {status, eventType, repoPath, page}]`,
  `refetchInterval: 10_000` 保持——只有当前页参与轮询(页码在 key 里,离开的页自然失活)。
- 仓库下拉 query:`['webhook-deliveries','repos']`,`refetchInterval: 30_000`;
  选项 = `[全部, ...repos]`;`Select` value 用 `'all'` 哨兵(仅前端,不进 API)。
- 事件下拉:`[全部, ...CODE_HOST_EVENT_TYPES]`,label 复用 `webhookTriggers.events.*`。
- 计数:`resultCount`(「{{count}} 条记录」)改为 `totalCount`(「共 {{total}} 条」),
  数据源从 `rows.length` 改为 `data.total`;D10 后它是筛选栏**之外**、表格上方的
  `.webhook-deliveries__meta` 行(不再与下拉挤在一起)。
- 底部 `<Pagination>`;空态判定从 `status === 'all'` 扩为「三过滤均为 all/空」,
  且筛选态空态带清除按钮(`user-directory` 空态同款出路)。
- 过滤栏布局(D10):走 `FilterBar`/`FilterField`;RFC-261 初版的
  `.webhook-filterbar` / `.webhook-filterbar__selects` 及其媒体查询块**删除**
  (仅本面板使用,删除优于留死 CSS)。

### 3.3 页码钳制(AC-7)

`useEffect`:`data && page > data.pageCount → setPage(data.pageCount)`。覆盖两个来源:
过滤切换后 total 缩水(通常直接复位 1,不触发)与 GC/数据删除导致末页消失。服务端对
越界 page 返回空 items + 正确 total,钳制后立即重取,无死循环(pageCount≥1 恒成立)。

## 4. 耦合点

- **契约注册表**(`packages/backend/tests/contracts/registry.ts:143` 附近):新增
  `{ method:'GET', path:'/api/webhook-deliveries/repos' }` 一行。
- **既有测试的裸数组断言**:rfc257-webhook-management / rfc260-webhook-read-visibility
  中对 GET 列表的断言改读 `.items`(逐处显式改判,不改语义;勘误:rfc259-github-ingress
  只消费 replay 面、不读列表,初稿误列——评审门 P2-⑦)。
- **i18n key resolution 守卫**:删除 `resultCount`、新增 `totalCount` 与下拉/分页 keys,
  zh/en/类型三处同步,否则守卫红。
- **RFC-260 只读视图**:过滤与分页不区分 isAdmin(读面能力,AC-8);replay 分支不动。
- `docs/webhook-triggers.md` 若有「最近 50 条」措辞随手更正(文档增删豁免范围)。

## 5. 失败模式

| 场景                                    | 行为                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| page 越界(手工 API / 数据缩水)          | 空 items + 正确 total(offset ≥ total 短路,不发行查询);前端钳回末页                 |
| `limit=-1` / 小数 / ±Infinity(手工 API) | `Number.isFinite`+trunc 钳制 → 默认/边界值,零 500、零全表 dump(P1-①)               |
| 保留期大幅收缩后的首次 sweep            | 分批删除(每批独立事务),百万级清理不冻结事件环、不物化 id 大数组(P1-②)              |
| 存量 config 手写 body>row 后的任意 PUT  | 422 `webhook-retention-invalid` 直至修正(合并后全量校验,RFC-255 同款姿势;有测试锁) |
| repos 端点返回空(无投递)                | 下拉只有「全部」;列表空态照常                                                      |
| `repo_path IS NULL` 的行                | 仓库过滤不可选中(distinct 排除 NULL),「全部」可见——记入 docs 排障行                |
| eventType 非法值(手工 API)              | 忽略该过滤(catch 姿态),不 422                                                      |
| count 与取页间并发插入                  | total ±1 瞬时偏差,10s 轮询自愈                                                     |

## 6. 保留天数配置化(D9')

- **shared**(`schemas/config.ts`):`webhookDeliveryBodyRetentionDays` /
  `webhookDeliveryRowRetentionDays`,`int().min(1).max(3650).default(30|90)` +
  `DEFAULT_CONFIG` 同步。跨字段校验**不放 schema**——`ConfigPatchSchema =
ConfigSchema.partial()` 要求基 schema 保持纯 ZodObject(`.refine` 会破坏 partial)。
- **保存门**(`routes/config.ts` PUT):合并后完整 config 上校验 body ≤ row,不满足
  抛 `webhook-retention-invalid`(422)——校验完整合并结果而非 patch 本身,无关 PUT
  也过闸(RFC-255 P0 同款姿势)。手改 config.json 绕过保存门的畸形组合在运行期无害:
  行先删,body 段自然空转(`gcDeliveries` 注释)。
- **消费面**:`gcDeliveries(db, now, retention?, batchSize?)` 参数化(缺省回落既有
  常量)。**分批执行**(评审门 P1-②):两段各按 `rowid IN (SELECT rowid ... LIMIT
batch)` 循环,单批默认 10000——D9' 让「保留期收缩」成为一等操作(90→7 天 =
  一次性清理 ~890 万行),原 `.returning({id})` 会物化百万级 id 数组(数百 MB 堆)
  且单事务写锁/WAL 膨胀分钟级;分批后每批独立事务,ingress 插入可穿插,计数来自
  逐批 RETURNING(单批有界)。
  `runDeliveryGcSweep(db, getConfig?)` 是 ticker 的单次 sweep 体(独立导出可测:
  两次调用间改 getter 返回值 → cutoff 跟随,锁热读);`startWebhookDeliveryGc`
  只做 setInterval 接线 + **`running` 再入闸**(services/gc.ts 同款——sweep 超一小时
  不叠加);`retentionFromConfig` 做天→ms 换算;`cli/start.ts` 传
  `() => loadConfig(Paths.config)`。
- **前端**:设置 → GC tab 两个 `NumberInput`(1–3650,与 worktree GC / 归档阈值同居);
  `settings-drafts.ts` gc scope 登记两键(**最小写允许清单——漏登记 = 保存时静默丢弃**);
  i18n `settingsForm.webhook{Body,Row}Retention{,Hint}` zh/en。

## 7. 测试策略

后端(新 `rfc261-webhook-delivery-pagination.test.ts` + 存量三文件改判):

1. 封套形状 + 默认 page=1/limit=50(AC-1)。
2. 120 行 seed(含同毫秒 tie)翻页无重/漏(AC-2)。
3. 四过滤 AND + total 一致(AC-3)。
4. 参数钳制矩阵(AC-4)。
5. `/repos` distinct/排序/NULL 排除/user 与 PAT 可读(AC-5);注册表守卫自动覆盖新路径。
6. 迁移 0139 索引存在(sqlite_master 断言,AC-9)。

前端:

1. `pagination.test.tsx`:组件禁用边界 / onPageChange / nav role 与 aria(D6)。
   1b. `filter-bar.test.tsx`(D10):role=group + 可访问名、控件落在 `__controls`、
   trailing 缺省时连 `__actions` 容器都不渲染、FilterField 可见标签与控件同 field。
   面板侧断言(rfc261 前端测试)锁:筛选栏含三控件、两标签可见、总数在栏外、
   清除按钮的出现/消失与复位效果(AC-13)。视觉自查:本地 dev server + Chrome
   实拍空闲态与激活态两张(CLAUDE.md 前端一致性规程第 4 条)。
2. `rfc261-webhook-delivery-pagination.test.tsx`:mock api——下拉改变请求参数与页码
   复位、repos 选项渲染、总数展示、翻页请求 page=2、越界钳回、isAdmin=false 照常
   (AC-6/7/8)。
3. 既有 rfc257-pages-inline / rfc260-readonly-view 中受 `resultCount`/数组形状影响的
   断言逐处改判。

保留配置(D9'):

1. shared `config-rfc261.test.ts`:默认回填 30/90、bounds 拒绝矩阵、patch 携带。
2. backend rfc261 新 describe:`gcDeliveries` 分层生效(删行/清 body/不动 + 段序
   语义 bodiesCleared 计数)、**小 batchSize 跨批清理完整性**(P1-② 回归)、
   `retentionFromConfig` 换算、`runDeliveryGcSweep` 两次调用间改 getter → cutoff
   跟随(P2-④ 热读回归)、PUT 保存门 422 与合法值落盘回读、**存量非法组合下无关
   PUT 也 422**(P2-⑤;configHarness 需 `seedBuiltinRuntimes` 打底,否则 RFC-224
   校验环节任何 PUT 都 422)。
3. frontend `rfc261-settings-webhook-retention.test.tsx`:GcTab 渲染 config 值、
   保存 patch 携带两键(BackupCard 内嵌要求 mock `/api/restore/pending` 形状)。

源代码层文本断言兜底(CLAUDE.md 姿势,行为等价面无法黑盒锁定的两处):
`/repos` 的 `WITH RECURSIVE repo_walk`(换回朴素 DISTINCT 行为等价、只有性能塌方,
P2-③)与 ticker 的 `if (running) return` 再入闸(P1-② 附带)。
