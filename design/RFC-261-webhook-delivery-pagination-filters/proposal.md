# RFC-261 · Webhook 投递审计:总数、页码分页与事件 / 仓库过滤

状态:Draft(待用户批准)
日期:2026-08-06

## 1. 背景

RFC-257 T9 落地的投递审计面板(`/webhooks` 单页 deliveries tab)目前只显示**最近 50 条**:
后端 `GET /api/webhook-deliveries` 默认 `limit=50`(`routes/webhookDeliveries.ts:33`),前端
`DeliveriesPanel` 不传 `limit` 也没有任何翻页控件。50 条之外的记录留在
`webhook_deliveries` 表里(90 天保留窗,`deliveryStore.ts:130-131` GC),但 UI 无法触达;
API 虽有 `before`(receivedAt 游标)参数,前端从未使用,仓内也零消费。

几百仓共用一个 group/system hook 的目标形态下(RFC-257 D 系决策),50 条在高峰期可能
只覆盖几分钟的事件流,排障(「某仓某类事件到底有没有到达」)只能靠手工拼 API 参数。

**规模基准(用户实测追加,2026-08-06)**:部署侧日投递量可达 **10 万条/天**。
按既有保留策略(30 天 body / 90 天删行)推算稳态 ≈ **900 万行**、含 body 行 ≈ 300 万。
本 RFC 的查询面(分页 / 过滤 / 总数 / distinct 仓库 / 小时级 GC)都必须在该量级下
不退化为全表扫描或全量排序——见 D7'。

## 2. 目标

1. 列表顶部显示**当前过滤条件下的总条数**。
2. **页码分页**(用户拍板,推翻 load-more 备选):上一页 / 下一页 + 第 x / y 页,每页 50 条。
3. **按事件类型过滤**:9 类闭集内部事件(`CODE_HOST_EVENT_TYPES`)下拉。
4. **按仓库过滤**:下拉选择(用户拍板),选项 = 投递表 `repo_path` 的 distinct 值
   (即保留窗内出现过的仓库)。
5. 所有过滤服务端执行且与分页/总数一致(AND 组合)。

## 3. 非目标

- 不做按端点(endpointId)过滤的 UI(API 参数保留,供排障手工使用)。
- 不做文本模糊搜索(用户在两案中选了 distinct 下拉)。
- 不改保留策略(30 天置空 body / 90 天删行不动)。
- 不动详情 Dialog、replay 语义与权限模型(RFC-260 的读写边界原样)。
- 触发器(triggers)/端点(endpoints)两个 tab 不在本 RFC 范围。

## 4. 决策记录

- **D1(用户拍板)**:分页形态 = 页码分页(offset),非 load-more。已知代价:投递持续
  新增时同一行可能在翻页间漂移(第 2 页看到第 1 页挤下来的行),接受。
- **D2(用户拍板)**:仓库过滤 = distinct 下拉,不做 LIKE 模糊输入。
- **D3**:事件过滤只覆盖 9 类闭集枚举 + 「全部」。`event_type IS NULL` 的行(验签拒绝 /
  解析失败)不设专门选项——它们已可经状态过滤(拒绝/失败)触达,不为此引入哨兵值。
- **D4**:列表响应从裸数组改为封套 `{ items, total, page, pageCount }`(tasks 页
  `/api/tasks/page` 同款先例);死参数 `before` 删除(仓内零消费,删除优于 deprecate)。
- **D5**:仓库下拉选项来自新端点 `GET /api/webhook-deliveries/repos`(distinct 非空
  `repo_path`,升序),权限与列表同为 `webhook-endpoints:read`。
- **D6**:分页控件按「新增公共组件」对待:`components/Pagination.tsx` + `.pagination`
  命名空间样式 + `common.pagination.*` i18n + 单测,供后续列表页复用。
- **D7'(按 10 万/天基准修订,原 D7 只补单列 `received_at` 索引)**:迁移 0139 做
  三件事——①**表重建把 `body_json` 挪到末列**(SQLite 大字段走 overflow 链,原布局
  里 `replayed_from_delivery_id`/`received_at` 排在 body 之后,列表投影每行都要走完
  整条链;该表 2026-08-04 才上线、存量极小,这是唯一低成本重排窗口);②**过滤维度
  组合索引组** `(status|event_type|repo_path, received_at)` + 单列 `received_at`
  (过滤前缀 + 时间序游走 + LIMIT 早停,900 万行下杜绝全量排序;单列 status 索引退役);
  ③**body-retention 部分索引**(`received_at WHERE body_json IS NOT NULL`,30 天置空
  GC 只触待清行)。`/repos` 的 distinct 用 **loose index scan**(递归 CTE,K×logN 寻位)
  而非朴素 `SELECT DISTINCT`(全索引扫描)。全部判据以 `EXPLAIN QUERY PLAN` 实证
  (design §2.1)。
- **D8**:深页 OFFSET 成本(O(offset) 索引游走)接受——分页 UI 只有上一页/下一页,
  人工浏览深度有界;不为此引入 cursor 混合方案。
- **D10(用户拍板 2026-08-07:「两个下拉框放右侧太丑了,好歹做下 UX 设计」)**:
  初版把两个裸 Select 靠 `justify-content: space-between` 甩到过滤栏右端,和总数
  挤在一起。三个真实缺陷:①**选中后 Select 只显示值**(`push` / `acme/api`),
  没有可见标签就分不清哪个下拉管哪个维度;②三个筛选被拆成"左一族右一族",
  不成整体;③**整页没有清除筛选入口**,而空态文案却让用户「清除筛选」。
  重做为**卡片式筛选栏**(用户在三案中选定):抽公共原语
  `components/FilterBar.tsx`(`FilterBar` + `FilterField`),视觉母本是既有
  `.user-directory__toolbar`(边框 + panel 底 + 控件成族),改 flex-wrap 以容纳
  可变数量维度;三个筛选左对齐成一族、两个 Select 带可见维度标签、清除筛选
  按钮右对齐(仅在有激活筛选时渲染)、总数降为表格上方的 meta 行、筛选后空态
  也带清除按钮。`user-directory` 视觉等价可后续迁移(记 audit-backlog,本次不动
  它以免掀翻 users 页视觉基线)。
- **D9'(用户拍板 2026-08-06:「是不是可以配置 webhook 的最长保留天数」→ 配置化)**:
  10 万/天 × 30 天 body 保留 ≈ 300 万个 ≤256KiB body,按典型 GitLab payload 5–30KiB
  估算为 **15–90GB** 量级的 SQLite 存储——保留天数从常量改为 config 字段
  `webhookDeliveryBodyRetentionDays`(默认 30)/ `webhookDeliveryRowRetentionDays`
  (默认 90),范围 1–3650;保存门校验 **body ≤ row**(新错误码
  `webhook-retention-invalid`);GC ticker 每次 sweep 热读生效值(免重启);
  管理面落在 设置 → GC tab(与 worktree GC / 事件归档同居)。

## 5. 能力影响清单(wire 形态变更)

本 RFC 无能力收缩,但有一处 **API 响应形态 breaking change**,呈用户确认:

| 面                                       | 变更前                 | 变更后                                                                               | 受影响方                                                                                                                           |
| ---------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/webhook-deliveries` 响应       | 裸数组 `DeliveryRow[]` | 封套 `{ items, total, page, pageCount }`                                             | 仓内:前端 + rfc257/259/260 测试(随本 RFC 同步改);仓外:PAT/token 消费者(该读点 RFC-260 于 2026-08-06 才开放,外部自动化存在窗口极短) |
| `GET /api/webhook-deliveries?before=`    | receivedAt 游标        | 参数删除(改用 `page`)                                                                | 仓内零消费;外部同上                                                                                                                |
| 新增 `GET /api/webhook-deliveries/repos` | —                      | distinct 仓库列表(读权限)                                                            | 纯新增,无收缩                                                                                                                      |
| config 新增两字段(D9')                   | 保留天数为常量 30/90   | `webhookDeliveryBodyRetentionDays` / `webhookDeliveryRowRetentionDays`(默认同 30/90) | 纯新增;默认行为逐字节不变                                                                                                          |

## 6. 用户故事

- 管理员在投递 tab 选「事件 = pipeline_failed、仓库 = group/repo-a」,立刻看到「共 N 条」
  并逐页翻看该仓流水线失败的到达史,而不是只能看全仓混排的最近 50 条。
- 普通成员(只读,RFC-260)用同样的过滤与分页排障自己仓库的事件是否到达(replay 仍不可见)。

## 7. 验收标准(可证伪)

- AC-1:后端 `GET /api/webhook-deliveries` 返回 `{items,total,page,pageCount}`;
  `total`/`pageCount` 与过滤条件一致;`page` 越界返回空 `items` 且 `total` 仍正确。
- AC-2:seed >100 行时,`page=1` 与 `page=2` 按 `(received_at DESC, id DESC)` 无重叠、
  无缺口(含同毫秒 tie 用例)。
- AC-3:`status`、`eventType`、`repoPath`、`endpointId` 四过滤 AND 组合,`total` 随之变化。
- AC-4:`eventType` 非法值忽略(与既有 `status` 的 catch 姿态一致);`page`/`limit`
  非数字或越界被钳制(page≥1,1≤limit≤200),**含负数 / 小数 / ±Infinity——不得
  500、不得放行负 LIMIT 全表 dump**(评审门 P1-① 红例矩阵)。
- AC-5:`GET /api/webhook-deliveries/repos` 返回去重升序、排除 NULL;user 角色可读,
  PAT 可读(`tokenAccess:'allow'`);契约注册表含该新路径。
- AC-6:前端事件/仓库下拉改变后,请求携带对应参数且页码复位为 1;总数展示为过滤后的
  `total`;上一页在第 1 页禁用、下一页在末页禁用。
- AC-7:数据缩水(过滤切换/GC)导致当前页 > pageCount 时,前端钳回末页,不停留在空页。
- AC-8:`isAdmin=false` 只读视图下过滤与分页照常可用(replay 按 RFC-260 继续隐藏)。
- AC-9:迁移 0139 在全新库与存量库上都可应用;索引组七枚齐备(dedupe/endpoint_time/
  received_at/status_time/event_time/repo_time/body_retention)、单列 status 索引退役、
  `body_json` 为末列;快照 parity 守卫(`createindb-snapshot-parity`)全绿。
- AC-10:`bun run typecheck && lint && test && format:check` 全绿;i18n zh/en 双语齐。
- AC-11(D9'):`PUT /api/config` 携带 body>row → 422 `webhook-retention-invalid`;
  合法值落盘且 GET 回读;0 / 负数 / >3650 / 小数被 schema 拒绝;缺省回填 30/90。
- AC-13(D10):筛选栏是一个带可访问名的 `role=group`,三个筛选控件都在其中;
  两个 Select 各有**可见**维度标签;清除按钮在无激活筛选时不渲染、激活后出现、
  点击后三过滤复位且页码回到 1;筛选后空态带清除按钮;总数在筛选栏之外的 meta 行。
- AC-12(D9'):`gcDeliveries` 按传入保留值分层生效(清 body / 删行)且**分批执行**
  (小 batchSize 下跨批清理完整、计数正确——保留期收缩的一次性百万级清理不物化
  id 大数组、不整段持写锁);ticker 走 getter 每 sweep 热读(`runDeliveryGcSweep`
  两次调用间改配置生效)+ `running` 再入闸;设置 → GC tab 修改后保存的 patch 携带
  两个键(gc scope 最小写允许清单已登记);存量 config 手写 body>row 时无关 PUT
  同样 422(修正前不放行任何保存)。
