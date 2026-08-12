# RFC-286 — 前端数据层收敛与死 class 修复（proposal）

状态：Draft（2026-08-12 落档）
来源：`design/system-commons-unification-audit-2026-08-12.md` §5 决策台账
D13-D17（用户已拍板：**本轮不动 UI 层**——Card/新原语/intent 选项 UI 全部登记；
只做真实可见 bug + 数据层）。

## 1. 背景

前端审计结论：六大高危面（modal/tabs/segmented/骨架/WS/chip）100% 归一，
数据层骨架（HTTP/WS/错误/状态）教科书级单点。残留三类可修项不涉 UI 风格：
①**不存在的 class 被引用**导致报错文案无错误视觉（用户可见 bug）；
②数据层三处违反自身契约的漂移；③WS 关联 queryKey 双轨。

## 2. 目标

- **F1 死 class 修复（真实 bug）**：
  `error-text`（`routes/tasks.new.tsx:2235,2259,2385,2420,2449` +
  `components/launch/RepoSourceList.tsx:113`，styles.css 零定义）——6 处
  role="alert" 报错换 `<ErrorBanner>` 或 `Field` 的 `error` prop（RFC-154 既有形态）；
  `checkbox-row`（`routes/intent.detail.tsx:1263`，零定义）——换 `Form.Checkbox`
  既有原语（这是修死 class，不是 D14 禁掉的「新原语」）；
  `form-error`（`components/review/MultiDocReviewView.tsx:662`，顶层无定义仅
  嵌套定义生效于别处）——换既有错误形态。
  `components/ErrorDetails.tsx:110` 的 `join('、')` 硬编码中文顿号——分隔符进
  i18n key（en 用逗号）。
- **F2 bare fetch 收敛**：`lib/worktree-download.ts:26,60`、
  `components/WorktreeFilesPanel.tsx:284`、`components/skills/ImportZipPanel.tsx:982`
  三处 bare fetch 改走 `apiGetBlob`/`fetchOrNetworkError`（统一错误分类自动获得）；
  删 `ImportZipPanel.tsx:963-971` 自写的第二个 error decoder（client.ts:255-257
  明文警告的形态）；`saveBlob` **三份**拷贝合一（WorktreeFilesPanel 私有版、
  worktree-download 镜像版、`routes/reviews.detail.tsx` markdown 导出版——
  worktree-download.ts:8-9 注释自认三处，初稿漏计第三份）。
  **设计门补强（路 2 P1/P2）两条硬约束**：①下载改调时**显式传大预算或不限时
  并接 AbortSignal**——apiGetBlob 默认 300s 硬顶（client.ts:49）会让今天能下的
  GB 级 worktree 产物明天下不了（client.ts 自注 "genuinely large download must
  pass deadlineMs explicitly"）；②`downloadPortArtifact` 的 **404→worktree
  回退链**（worktree-download.ts:60-64 靠 res.status 判断）必须改写为
  `catch ApiError.status===404` 形态——apiGetBlob 对一切 !ok throw，不改写会把
  legacy 行（无 emit-time archive 的存量 node_run）的成功回退变报错 toast。
- **F3 resourcePackages wire 类型下沉 shared**：
  `frontend/api/resourcePackages.ts:13-60+` 的 preview/commit 请求响应形状
  （ImportAction/PackagePreviewCandidate/PackagePreviewEntry/PackageSecretRef 等）
  迁 `packages/shared/src/schemas/resourcePackage.ts`（zod + 类型导出），
  后端 `services/resourcePackage/preview.ts|parse.ts` 与前端双端 import；
  `routes/settings.tsx:2018` 的 `OidcProviderRow` 本地副本一并核对下沉或注明豁免。
- **F4 queryKey WS 关联族工厂化（D16）**：把同时被 WS 规则表
  （`hooks/useTaskSync.ts` 等）与 route 引用的 key（tasks/reviews/clarify 族）
  抽成工厂常量、双端 import 同一符号；其余 inline key **不动**（D16 明确收窄）。
  `tests/task-sync-rules.test.ts` 既有 frame→key 契约锁随迁。

## 3. 非目标（D13-D15/D17 划出，已登记 backlog）

Card 迁移、新原语（CopyButton/MetaGrid/LocalizedDateTime/CollapsibleSection/
MetaDots/gradient token）、intent 选项 UI 复用 QuestionForm、canvas inspector
`form-input` 直落、Checkbox 迁移收尾、死 CSS 清扫、全量 queryKey 工厂化、
polling 间隔常量层。

## 4. 能力影响清单

- V1 六处报错从「无样式纯文本」变为标准错误视觉（ErrorBanner/Field error）——
  若任一点位落在视觉回归快照场景内即产生基线 diff，按仓规刷新并注明（修正初稿
  「零视觉变化」与 V1 自相矛盾的表述）。
- V2 离线/超时时三个下载/上传流的报错从原生 "Failed to fetch" 变为本地化
  network-unreachable 文案（与全站一致）。
- V3（设计门新增）：下载流获得显式超时治理——按 F2 硬约束①传大预算/不限时 +
  AbortSignal；**明示不引入 300s 默认硬顶回归**（配大文件路径测试）。

## 5. 验收标准

- AC-1 全前端 `error-text`/`checkbox-row` 引用归零（grep 锁）；`form-error`
  仅存合法嵌套定义消费点；六处报错场景视觉断言（role="alert" + 错误形态类）。
  **设计门补强（路 2 P2）**：这些点位被 4 个测试文件 + 2 条**源码文本锁**钉着
  （launch-working-branch.test.ts:61-63 / launch-git-identity.test.ts:63 要求
  源文本 `role="alert"` 与 testid 相邻；tasks-new-wizard:964 与
  rfc218-agent-port-launch:249,322 按 testid 取节点）——实现含：按仓规给
  ErrorBanner/Field **最小扩展 `data-testid` 透传 prop**（现无），并附
  5 testid × 4 测试文件 + 2 文本锁的逐条改判表。
- AC-2 前端 src bare fetch 归零锁——grep 口径修正为排除属性调用
  （`(^|[^.\w])fetch\(`，`\bfetch\(` 会把 12 处 `transport.fetch(` 记假阳）
  或改 ESLint no-restricted-globals 规则；第二 decoder 删除；saveBlob 单实现
  （三份合一）。
- AC-3 resourcePackages 前端类型文件不再自定义 wire 形状（import shared）；
  shared schema 与后端产出 parse 对拍（后端现有 preview 输出喂 shared schema
  必须 parse 通过——防下沉时写错形状）。
- AC-4 WS 关联 key 双端同符号（grep：WS 规则表文件内不再出现字符串字面 key
  数组，全部经工厂）；`task-sync-rules` 契约锁绿。
- AC-5 视觉回归：受影响页面（tasks.new / intent.detail / review 多文档 /
  worktree 文件面板 / skills 导入）截图对照；`gate:local` 前端车道全绿 +
  visual-regression CI 绿（如基线漂移按仓规刷新并注明）。
