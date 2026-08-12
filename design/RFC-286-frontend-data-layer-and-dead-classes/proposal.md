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
  三处 bare fetch 改走 `apiGetBlob`/`fetchOrNetworkError`（RFC-208 deadline 预算
  - 统一错误分类自动获得）；删 `ImportZipPanel.tsx:963-971` 自写的第二个
    error decoder（client.ts:255-257 明文警告的形态）；`saveBlob` 两份拷贝合一
    （`lib/worktree-download.ts` 自认 mirrors WorktreeFilesPanel）。
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

无能力变化。用户可见变化仅两类（均为修复方向）：

- V1 六处报错从「无样式纯文本」变为标准错误视觉（ErrorBanner/Field error）。
- V2 离线/超时时三个下载/上传流的报错从原生 "Failed to fetch" 变为本地化
  network-unreachable 文案（与全站一致）。

## 5. 验收标准

- AC-1 全前端 `error-text`/`checkbox-row` 引用归零（grep 锁）；`form-error`
  仅存合法嵌套定义消费点；六处报错场景视觉断言（role="alert" + 错误形态类）。
- AC-2 `rg '\bfetch\('` 在前端 src 命中仅 `api/client.ts` 内部（豁免清单归零）；
  第二 decoder 删除；saveBlob 单实现。
- AC-3 resourcePackages 前端类型文件不再自定义 wire 形状（import shared）；
  shared schema 与后端产出 parse 对拍（后端现有 preview 输出喂 shared schema
  必须 parse 通过——防下沉时写错形状）。
- AC-4 WS 关联 key 双端同符号（grep：WS 规则表文件内不再出现字符串字面 key
  数组，全部经工厂）；`task-sync-rules` 契约锁绿。
- AC-5 视觉回归：受影响页面（tasks.new / intent.detail / review 多文档 /
  worktree 文件面板 / skills 导入）截图对照；`gate:local` 前端车道全绿 +
  visual-regression CI 绿（如基线漂移按仓规刷新并注明）。
