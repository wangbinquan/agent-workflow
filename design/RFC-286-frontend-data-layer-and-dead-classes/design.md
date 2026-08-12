# RFC-286 — 技术设计（design）

> 锚点基于审计报告（基线 ≈ `e7361b02`），实现前逐锚复核。与 284/285 无代码依赖，
> 可并行实现；唯 F3 的 shared schema 新文件注意与并发 session 的 shared 改动对账。

## F1 死 class 修复

- 替换形态逐点：
  - tasks.new 五处：均在向导校验错误场景，形态取 `Field` 的 `error` prop
    （字段级）或 `<ErrorBanner compact>`（区块级）——按各点位上下文选择，
    以「与同页既有错误形态一致」为准；不新增 CSS。
  - RepoSourceList.tsx:113：同上。
  - intent.detail.tsx:1263 waiver 复选：`Form.Checkbox`（`components/Form.tsx:394`
    RFC-247 原语，5 个既有采用文件为形态参照）。
  - MultiDocReviewView.tsx:662：`<ErrorBanner>` 或该组件邻近已用的错误形态。
  - ErrorDetails.tsx:110：`t('errorDetails.namesSeparator')` 进 join（zh='、'，
    en=', '）。
- 测试：每点位 RTL 断言（`getByRole('alert')` + class 断言换成公共组件角色/类）；
  grep 锁三个死 class 名在 src 归零。

## F2 bare fetch 收敛

- `apiGetBlob`（client.ts:348-375 既有，带 auth+decoder+deadline）为唯一 blob
  下载入口；worktree-download.ts 与 WorktreeFilesPanel 的下载改调；
  ImportZipPanel 上传流改 `fetchOrNetworkError` + `extractErrorBody`
  （multipart 上传若 `api.postMultipart` 已覆盖则直接换用——实现时核对
  client.ts:386-404 的现有面）。
- `saveBlobAs` 收敛为 `lib/download.ts` 单实现（a[download] 触发逻辑）。
- 测试：离线模拟（fetch reject）断言本地化错误码路径；错误体结构化解码断言
  （后端 code 透传而非 http-<status> 压平）。

## F3 shared 下沉

- 新 `packages/shared/src/schemas/resourcePackage.ts`：以后端
  `services/resourcePackage/preview.ts`/`parse.ts` 的**实际产出形状**为源写 zod
  （不是照抄前端手写副本——两者若有出入以后端为准，出入点列进 plan 对照表）；
  后端产出路径接 `satisfies z.infer<...>` 或直接 parse（防漂移锚，AC-3 的对拍）。
- 前端 `api/resourcePackages.ts` 改 import；`importId`/`previewToken` 幂等语义
  注释随迁 shared。
- `OidcProviderRow`（settings.tsx:2018）：核对 shared 是否已有对应 schema，
  有则换用，无则同批下沉（小）。

## F4 queryKey 工厂

- 新 `lib/query-keys.ts`（或扩展既有工厂文件）：`TASK_QUERY_KEYS`
  （detail/list/nodeRuns/alerts…按 WS 规则表实际引用面枚举）、
  `REVIEW_QUERY_KEYS`、`CLARIFY_QUERY_KEYS`。
- 迁移面：`hooks/useTaskSync.ts:34` 等规则表 + `routes/tasks.detail.tsx:204` 等
  route 侧 inline（**仅 WS 关联 key**；同文件其它 inline key 不动——D16）。
- 测试：`task-sync-rules.test.ts` 契约锁改断言工厂符号；新增 grep 锁
  「WS 规则表文件零字符串字面 queryKey」。

## 测试策略

- 每组独立批次 + AC 对应测试；前端车道 `bun run test`（frontend）+ gate 全绿；
  visual CI 观察（本 RFC 预期零视觉基线变化——错误形态用既有组件，若 diff
  出现即审查是否引入了非预期样式）。
- 实现门：独立子代理对抗评审。
