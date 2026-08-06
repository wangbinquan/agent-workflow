# RFC-261 · 任务分解

单 RFC 单 commit(`feat(webhooks): RFC-261 投递审计总数/页码分页/事件与仓库过滤`),
直接 main 提交推送(仓规:主干开发,不建分支)。

## T1 — 后端

- 迁移 0139 `0139_rfc261_webhook_delivery_scale.sql`(D7' 三段:表重建 body_json
  末列 / 组合索引组 + 单列 status 退役 / body-retention 部分索引)+ journal +
  `db/schema.ts` 列序与索引声明同步;EXPLAIN QUERY PLAN 实证(design §2.1)。
- `routes/webhookDeliveries.ts`:列表封套化(`{items,total,page,pageCount}`)、
  `eventType`/`repoPath`/`page` 参数、`(received_at DESC, id DESC)` tie-break、
  删 `before`;新增 `/repos` 端点(loose index scan,挂在 `/:id` 之前)。
- 契约注册表新增 `/repos` 行。
- 新测试 `rfc261-webhook-delivery-pagination.test.ts`(design §6 后端 1–6,
  含索引组/末列断言与 /repos 空库分支)。
- 存量 rfc257/259/260 后端测试裸数组断言改读 `.items`。

依赖:无。

## T2 — 前端

- 新公共组件 `components/Pagination.tsx` + `.pagination` 样式 + `common.pagination.*`
  i18n(zh/en/类型)+ `pagination.test.tsx`。
- `DeliveriesPanel`:两个 Select 过滤 + 总数展示(`totalCount` 替换 `resultCount`)+
  `<Pagination>` + 页码复位/钳制;`.webhook-filterbar__selects` 样式加法。
- i18n 新 keys(事件/仓库下拉 label 与 aria、totalCount)zh/en/类型同步。
- 新测试 `rfc261-webhook-delivery-pagination.test.tsx`(design §6 前端 2)。
- 存量 rfc257-pages-inline / rfc260-readonly-view 受影响断言改判。

依赖:T1 的响应形状(可并行写,联调以 shared 无新 schema——响应形状仅在前后端测试各自锁)。

## T4 — 保留天数配置化(D9',用户追加拍板)

- shared:config 两字段(默认 30/90,1–3650)+ DEFAULT_CONFIG + `config-rfc261.test.ts`。
- backend:`gcDeliveries` 参数化、`webhookGc` getter 热读 + `retentionFromConfig`、
  `cli/start.ts` 接线、`routes/config.ts` PUT 语义门(`webhook-retention-invalid`)、
  rfc261 测试新 describe。
- frontend:设置 → GC tab 两个 NumberInput + gc scope 登记 + i18n zh/en +
  `rfc261-settings-webhook-retention.test.tsx`(GcTab 随之 export)。

## T3 — 收口

- `docs/webhook-triggers.md` 保留策略/过滤分页段落更新。
- `design/plan.md` RFC 索引登记 + `STATE.md` 状态行更新为 Done。
- 全套门禁 `typecheck / lint / test / format:check`;push 后按 exact SHA 查 CI。
- 对抗评审门(设计+实现合并一次跑,RFC-259/260 先例;本机 Codex 处不可用组合)
  findings 逐条核实折入。**已跑:needs-changes,2 P1 + 8 P2 全部属实零驳回折入**——
  P1-① limit/page 钳制洞(负数全表 dump / 小数与 Infinity 500)→ isFinite+trunc
  钳制 + offset≥total 短路 + 红例矩阵;P1-② GC `.returning()` 在保留期收缩时物化
  百万级 id + 无再入闸 → 分批删除 + `running` 闸 + sweep 独立导出可测;P2 覆盖
  缺口(loose-scan 文本锁 / 热读回归 / 非法存量组合无关 PUT)补测试,成本声明
  (深 offset / 过滤 count)记档,repoOptions 排序修复,文档勘误(rfc259 误列)。

## 验收清单

proposal.md AC-1 … AC-10 逐条打勾;新增测试全绿;存量 webhook 测试(改判处除外)
不改断言全绿。
