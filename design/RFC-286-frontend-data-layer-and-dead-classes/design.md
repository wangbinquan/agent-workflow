# RFC-286 — 技术设计（design）

> 锚点基于审计报告（基线 ≈ `e7361b02`），实现前逐锚复核。与 284/285 无代码依赖；
> **与在途 RFC-283 前端批（C5/C5a/C5b：api/client.ts 三条请求流重构 + actor
> query key factory）同域——F2/F4 与其串行（先到先行，后者 rebase），开工前
> 对一次表**（设计门路 1 P2）。F3 的 shared schema 新文件注意与并发 shared 改动对账。

## F1 死 class 修复

- **前置（设计门路 2 P2）**：这些点位被 4 个测试文件 + 2 条源码文本锁钉着——
  `launch-working-branch.test.ts:61-63`、`launch-git-identity.test.ts:63`（源文本
  要求 `role="alert"` 与 data-testid 相邻）、`tasks-new-wizard.test.tsx:964`、
  `rfc218-agent-port-launch.test.tsx:249,322`（getByTestId）。ErrorBanner/Field
  现**无 data-testid 透传**——按仓规（CLAUDE.md 前端原则 2「最小扩展公共组件」）
  给两者加可选 `data-testid` prop，实现时附 5 testid × 4 测试文件 + 2 文本锁的
  逐条改判表。
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
  下载入口；worktree-download.ts 与 WorktreeFilesPanel 的下载改调，**显式传大
  预算/不限时 + AbortSignal**（proposal V3——不引入 300s 默认硬顶回归）；
  `downloadPortArtifact` 的 404→worktree 回退链改写为
  `catch (e) { if (e instanceof ApiError && e.status === 404) fallback(); else throw }`
  形态（apiGetBlob 对 !ok 一律 throw）。ImportZipPanel 上传流改
  `fetchOrNetworkError` + `extractErrorBody`（multipart 上传经 `api.postMultipart`
  ——设计门已核实存在，直接换用）。
- `saveBlobAs` 收敛为 `lib/download.ts` 单实现（a[download] 触发逻辑；三处消费：
  WorktreeFilesPanel / worktree-download / reviews.detail markdown 导出）。
- 测试：离线模拟（fetch reject）断言本地化错误码路径；错误体结构化解码断言
  （后端 code 透传而非 http-<status> 压平）；**404 回退链红→绿对**（legacy 行
  下载走回退成功、非 404 错误浮出）；**大文件路径不撞默认 deadline** 断言。

## F3 shared 下沉

- 新 `packages/shared/src/schemas/resourcePackage.ts`：以后端
  `services/resourcePackage/preview.ts`/`parse.ts` 的**实际产出形状**为源写 zod。
  **设计门定音（路 2 P3）**：shared 建**响应形状**——后端 `PackageRequirementsSchema`
  全字段 `.default([])`（parse.ts:49-63），parse 后数组恒在，故 shared 版对应字段
  **必填**；前端手写副本的全-optional 是历史防御写法，随迁清除（下游无谓 `?.` 一并清）。
  其余字段实测与后端几乎逐字段一致（root/secrets/entries/HumanMemberSlot 同形）。
  后端产出路径接 `satisfies z.infer<...>` 或直接 parse（防漂移锚，AC-3 的对拍）。
- 前端 `api/resourcePackages.ts` 改 import；`importId`/`previewToken` 幂等语义
  注释随迁 shared。
- `OidcProviderRow`（settings.tsx:2018）：`shared/src/schemas/oidcProvider.ts`
  **已存在**（设计门核实）——确定性任务：换用之。

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
