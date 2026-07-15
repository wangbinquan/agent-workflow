# RFC-198 — 全局界面 UX 一致性与响应式基础：实施计划

> 当前状态：Done（2026-07-16）。2026-07-15 用户已回复「ok」批准实施；全界面实现门复核 APPROVE，
> 最终实现/基线 SHA `e48ba3e7a354073f3f995fbd5e9873b1f5904650` 的主 CI 与 Linux 视觉门均全绿。

完成证据：

- 提交链：`e1fbd025` → `fb2d7cd3` → `a2a64fc0` → `42d1666a` → `3bfe476c` → `a1bfac98` →
  `75b825fb` → `fa2cee3e` → `4de8074b` → `e21bec78` → `e48ba3e7`。
- 全界面清单：45 个注册 route AST 双向盘点；40 个 Dialog 调用文件 / 46 个 render point；原生 dialog、裸输入、
  未包 TableViewport 的 table 与旧 shell hack 均由 source ratchet 锁定。
- 本地门禁：frontend 555 files / 4296 tests、shared 118 files / 1269 tests、定向 12 files / 94 tests；
  Chromium 全量 108 passed / 22 skipped、命名 UX 65/65、Agent import 1/1、WebKit UX/keyboard 21/21；
  workspace typecheck、lint、format、binary smoke 全绿，Darwin visual 17/17 并逐张人工检查。
- SHA 门禁：主 CI run `29456210494`（双平台 test + binary、8/8 Playwright shards、static/perf/link 全绿）；
  Linux visual run `29456210555`（17/17，18 张变更/新增基线逐张人工检查）。

## 1. 任务分解

| 任务       | 内容                                                                                                            | 依赖  | 验收                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| RFC-198-T1 | 主题 token 拆 text/fill；迁完 text-bearing fill/未定义 `--warning`；修 explicit-vs-system；focus/contrast tests | 批准  | light/dark AA，旧 foreground alias 不再承载文字 fill，反向主题正确 |
| RFC-198-T2 | 新 `PageHeader`/`NoticeBanner`/`ConfirmDialog`；扩 Form/Card/Dialog API；交互尺寸与 mobile CSS                  | T1    | h1/h2、refs、target size、a11y/focus/pending/reject tests 全绿     |
| RFC-198-T3 | 抽 `AppShell/ShellNavigation/CompactTopBar/MobileNavDialog`；导航文案/icon；root transition gate                | T2    | 901/900、768、390、admin/regular/daemon、Inbox/focus/route close   |
| RFC-198-T4 | TabBar disabled/roving/panel ids；filters→Segmented；TableViewport；Split mobile list/detail                    | T1,T2 | roving/panel/scroll/dirty guard/CTA/back 唯一合同全绿              |
| RFC-198-T5 | 迁 gallery、标准 list/detail、真实 URL tabs、Account/diagnose/dialog tables 与 resource detail                  | T3,T4 | PageHeader/state/table；Task async tab resolver；近期 RFC 零回归   |
| RFC-198-T6 | 迁 Auth/Account/Users/OIDC forms/cards；native dialog 清零；Workflow import dialog；Homepage deep actions       | T2,T5 | payload/cancel/error/focus 对拍，production native dialog grep=0   |
| RFC-198-T7 | Skill history/Memory jobs 等次级 table；核实并删 dead CSS；全局 ratchet                                         | T5,T6 | 零误删 selector、source guard 有明确 allowlist                     |
| RFC-198-T8 | Playwright canonical viewport、隔离 visual fixtures、UX E2E、反向主题、root scripts/README/workflow             | T3-T7 | 浏览器矩阵与 darwin/linux baseline、非 packages gate 闭环          |
| RFC-198-T9 | 全门禁、Codex 实现 gate、findings 修复、STATE/RFC index 收口                                                    | T1-T8 | backend+shared+frontend+lint/format/binary/E2E/visual/SHA CI 全绿  |

## 2. 实施顺序与批次边界

本 RFC 明确拆成 **6 个有序独立 PR**，不在实施阶段临时合成单 PR。每个 PR 都包含同批 production、tests、
文档/截图（如适用），先过自己的 gate 再合入；后续 PR 只依赖已合入前序 PR。某批失败可在下一批开始前
单独 revert；若依赖批已合入，则按 PR6→PR1 逆序回滚，不能只撤底层 API 留上层调用。

### PR 1 — Foundation

依赖：用户批准，无代码 PR 依赖。范围：T8a gate 校准 + T1 + T2，不迁业务 route TSX。

1. 先用独立 test-only commit 落 T8a：canonical 1280×800、统一 `test:visual`、root/non-package gate、visual
   workflow paths 与显式 shared CI；同时创建可执行的 `e2e/ux-consistency.spec.ts` foundation 场景（反向主题
   computed style、基础 target size），只刷新 viewport baseline 并人工看 diff，不能把 missing path 写进 gate。
   root script 固定为
   `RUN_VISUAL_REGRESSION=1 playwright test e2e/visual-regression.spec.ts --project=chromium`，确保 opt-in spec
   不会以全 skip 假绿；retries 由调用方/config 传入。
2. T1 token/theme/focus；production CSS undefined-token ratchet 收敛 `--warning/--fg/--mono*/--surface-*`。
3. T2 public primitive API 与单测。
4. 在改变暗色 foreground 前迁完 `styles.css` 全部 text-bearing accent/danger/semantic fill；不把对比度修复
   延期给 route PR。
5. 新 API 全部向后兼容并保留并发 `inputRef/textareaRef/TabDef.disabled/Dialog.bodyTabIndex`；旧调用点行为
   逐字保持。

PR gate：T1/T2 定向测试、frontend full test、typecheck、lint/format、显式 shared test、`test:visual`；token
computed contrast browser smoke。theme/primitive 导致的像素 diff 与 viewport-only commit 分开人工审查并更新双平台 baseline。
回滚：revert PR1 恢复旧 token/primitive，因尚无新 route 调用可独立编译。

建议 commit：

```text
feat(frontend): RFC-198 统一主题与 UX 原语
```

### PR 2 — Responsive shell

依赖：PR1。范围：T3。

1. T3 抽 shell/nav；desktop 先与旧 DOM 对拍。
2. 增加 compact bar/sheet；901/900 锁 shell，768 锁 compact shell + tablet content，721/720 只锁内容 stack。
3. root token-null transition gate。
4. 全局 shell 测试绿后只删除 Skill route-scoped sidebar hide；RFC-196 的 page-local back 暂留到 PR3。

PR gate：shell unit/render tests、901/900/768/390 Chromium、keyboard/focus、Account/Users/Settings footer route、
mobile dirty guard Stay/Discard、compact→desktop resize/zoom 后 activeElement=main、Inbox 三段 placement、
frontend full test、typecheck、`test:visual`；命中的
existing scenes 当批人工审 diff/更新双平台 baseline，不留红门给 PR6。
回滚：revert PR2 回到旧 desktop shell；PR1 的兼容 primitives 可闲置。

建议 commit：

```text
feat(frontend): RFC-198 落地响应式应用壳层
```

### PR 3 — Layout primitives

依赖：PR1、PR2。范围：T4，不迁标准业务 routes。

1. T4 TabBar/TabPanels ids + keyboard，保留 disabled 并跳过 disabled；filter/view mode 迁 Segmented 的公共准备。
2. TableViewport，类型只接受原生 table ReactElement。
3. ResourceSplitPage mobile list/detail。
4. shared split back 通过后迁 RFC-196 accessible label/testid/focus，再删除 `.skill-import__mobile-back` DOM/CSS；
   同屏不出现两个 back。
5. 每个 primitive 都先有 component test，再迁 route。

PR gate：T4 component tests、rendered app shell regression、720/390 keyboard/table/split browser smoke、typecheck、
`test:visual`；命中的 existing scenes 当批更新。
回滚：revert PR3 后 PR2 shell 仍独立工作。

建议 commit：

```text
feat(frontend): RFC-198 完成 tabs 表格与 split 响应式
```

### PR 4 — Standard pages

依赖：PR1–PR3，且 RFC-197 feature 改动/suite 已收口；stable id/panel 已由 owner 补好，或由 PR4 第一个
隔离 hunk 补完并移除临时例外后，才继续其他 route migration。范围：T5。

1. T5 按 shape 迁移，不按文件名随机穿插：gallery → lists/tables → page tabs → resource details；每个 route
   明确“迁移/专用例外/并发延后”。
2. 每完成一类就跑对应 route tests；保持 query/payload/testid。
3. Settings 先迁 shell/tab/state，再迁 Authentication，避免一次 diff 混合全部逻辑。
4. Task detail 先落纯 resolver tests，再把所有 `setTab` 收敛成 push/replace helper；不在异步分类稳定前
   canonicalize。
5. reviews/clarify list、MemoryAllList 与 review detail diff mode 迁 Segmented；true tabs 补 idPrefix + tabpanel。

PR gate：T5 route tests、Task plain/turn-engine/dynamic+late-config/room-error-retry、table/split E2E、
RFC-191/192 更新后的 empty visual/source locks、frontend full test/typecheck、`test:visual`；gallery/tasks 等
受影响 baseline 当批更新。
回滚：revert PR4 退回旧 route chrome，PR1–PR3 的兼容 primitives 可继续存在但未强制使用。

建议 commit：

```text
refactor(frontend): RFC-198 统一标准页面体验
```

### PR 5 — Forms and transactional UX

依赖：PR1–PR4。范围：T6。

1. T6 Auth/Account/Users/OIDC。
2. WorkflowImportDialog 与其他 native dialog 替代。
3. Homepage typed links/deep create。
4. 最后开启 native-dialog ratchet，避免中途被 source guard 阻断。

PR gate：7 个 native callsite 的适用行为矩阵、Auth 三方式/OIDC late provider/首次 focus/Arrow 后 tab focus、
workflow deep-create one-shot、Dialog WebKit focus、frontend full test/typecheck、`test:visual`；Auth/Dialog/
Homepage 受影响 baseline 当批更新。
回滚：revert PR5 恢复旧 transactional flows，PR1–PR4 的页面/primitive 不依赖新 feature dialogs。

建议 commit：

```text
refactor(frontend): RFC-198 收敛表单与确认流程
```

### PR 6 — Cleanup and browser evidence

依赖：PR1–PR5。范围：T7 + T8 + T9。

1. T7 dead CSS 每个 selector 先 `rg` 证伪再删除。
2. T8b 在 PR1 已固定的 1280×800 上补隔离 fixture、mobile/dark/反向主题 scenes；不再混入第二次 canonical
   viewport churn。
3. Codex 实现 gate findings 另起修复 commit，不 amend。
4. 每个 visual scene 独立建立 theme/data fixture，单独 grep 与整套运行一致；CI/local 统一 `test:visual`。
5. 扩 root lint/format 到 touched non-package files，跑完整 backend/shared/frontend/browser/visual 门并收口索引。

PR gate：§4.4 全门、darwin/linux 人工 diff、Codex live-diff gate APPROVE、PR head SHA CI 全绿。
回滚：revert PR6 只恢复 cleanup/test/CI baseline，不撤 PR1–PR5 用户功能；若需全功能回滚再按 PR5→PR1 逆序。

建议 commit：

```text
test(frontend): RFC-198 补齐跨视口 UX 回归
fix(frontend): RFC-198 折入实现门反馈
```

所有 Codex 创建的 commit 使用当前会话真实 model slug：

```text
Co-Authored-By: OpenAI Codex GPT-5 <noreply@openai.com>
```

## 3. 关键路径与测试文件

### T1/T2 — Foundation

Production：

- `packages/frontend/src/styles.css`
- `packages/frontend/src/components/PageHeader.tsx`
- `packages/frontend/src/components/NoticeBanner.tsx`
- `packages/frontend/src/components/ErrorBanner.tsx`
- `packages/frontend/src/components/ConfirmDialog.tsx`
- `packages/frontend/src/components/Form.tsx`
- `packages/frontend/src/components/Card.tsx`
- `packages/frontend/src/components/Dialog.tsx`（仅必要 API/CSS contract，不重写 focus engine）

Tests：

- `packages/frontend/tests/theme-contrast.test.ts`
- 新 undefined-token/source ratchet + computed-style browser test
- `packages/frontend/tests/theme.test.ts`
- `packages/frontend/tests/page-header.test.tsx`
- `packages/frontend/tests/notice-banner.test.tsx`
- `packages/frontend/tests/error-banner.test.tsx`
- `packages/frontend/tests/confirm-dialog.test.tsx`
- `packages/frontend/tests/form.test.tsx`
- 新 compact-target source test + 390px/200% bounding-box browser assertions
- 既有 Dialog focus/nested/portal/scroll tests

### T3 — Shell

Production：

- `packages/frontend/src/routes/__root.tsx`
- `packages/frontend/src/lib/nav.ts`
- `packages/frontend/src/components/shell/NavGroup.tsx`
- 新 shell components
- `packages/frontend/src/components/icons/resourceIcons.tsx`
- zh/en nav i18n

Tests：

- `packages/frontend/tests/nav.test.ts`
- `packages/frontend/tests/shell-nav-wiring.test.ts`
- `packages/frontend/tests/app-shell-layout.test.ts`
- 新 `packages/frontend/tests/app-shell-layout.test.tsx`（rendered auth/token-null/authenticated contract）
- 新 `shell-navigation.test.tsx` / `mobile-nav-dialog.test.tsx`
- `e2e/nav-redesign.spec.ts`
- `e2e/keyboard-flows.spec.ts`

### T4 — Tabs/Table/Split

Production：

- `components/TabBar.tsx`
- `components/split/TabPanels.tsx`
- 新 `components/TableViewport.tsx`
- `components/split/ResourceSplitPage.tsx`
- 对应 base CSS

Tests：

- `tab-bar.test.tsx`
- `tab-panels.test.tsx`
- 新 `tab-callsite-contract.test.ts`（filter 不得 role=tab；true tabs 必有 stable idPrefix + panel）
- 新 `table-viewport.test.tsx`
- `resource-split-page.test.tsx`
- `app-shell-layout.test.ts`
- `app-shell-layout.test.tsx`
- `page-fills-content-width.test.ts`

### T5/T6 — Routes

至少覆盖：

- `routes/workflows.tsx` / `workflows.edit.tsx`
- `routes/tasks.tsx` / `tasks.detail.tsx`
- `routes/scheduled.tsx` / `scheduled.$id.tsx`
- `routes/repos.tsx`
- `routes/reviews.tsx` / `reviews.detail.tsx`
- `routes/clarify.tsx` / `clarify.detail.tsx`
- `routes/memory.tsx`
- `routes/settings.tsx`
- `routes/auth.tsx` / `account.tsx` / `users.tsx`
- `routes/tasks.new.tsx` / `routes/fusions.detail.tsx` / `routes/memory.distill-jobs.$jobId.tsx`
- Agent/MCP/Plugin/Skill detail routes 与 `AgentForm`
- `components/gallery/ResourceGalleryPage.tsx`
- `components/home/HomepageGreeting.tsx` / `TaskFeed.tsx`
- `components/SkillFileTree.tsx`
- `components/repos/BatchImportDialog.tsx`
- `components/canvas/WorkflowCanvas.tsx`
- `components/review/MultiDocReviewView.tsx`

保持各 route 既有测试，并新增 URL-tab、deep-create、native-dialog、state/action tests。以上与 standard-header
source ratchet 的每个命中必须逐项标记“迁移 / 专用 viewport 例外 / 因 live 并发延后”，不能漏页即宣称完成。

### T8 — Browser/visual/CI

- root `package.json` / `bun.lock`
- `bunfig.toml`（注释改成 root Bun test 只发现 backend，shared 必须 package-filter）
- `playwright.config.ts`
- `e2e/ux-consistency.spec.ts` / `e2e/visual-regression.spec.ts`
- `e2e/harness.ts` / `e2e/inbox-fixtures.ts`（visual spec 直接依赖，纳入 workflow paths）
- `e2e/README.md` / `e2e/visual-regression.README.md`
- `.github/workflows/ci.yml`（新增显式 shared test；不把 frontend Vitest 混进 root Bun discovery）
- `.github/workflows/visual-regression-nightly.yml`
- darwin/linux visual snapshots（只在人工看 diff 后更新）
- `lint:repo-ui` 只列实际 TS：Playwright config、UX/visual/nav/keyboard/a11y specs、harness/fixtures；
  `format:check:repo-ui` 再加 root `package.json`、两个 README 与 CI/visual YAML。`bun.lock`（Prettier 无 parser）
  与 `bunfig.toml` 不进 ESLint/Prettier，只进 install/CI/path-filter 与各自定点 diff。T8a 同批创建
  `ux-consistency.spec.ts`，并先格式化 `inbox-fixtures.ts`、修 `nav-redesign.spec.ts` type-import warning；不泛扫
  无关 `e2e/**`
- `agent-import.spec.ts` 只在 RFC-197 handoff 文件已合入时由 PR4 原子加入 fixed list；不能让 PR1 引用未合入路径
- visual path filters 覆盖 spec/config/root scripts 及 `harness.ts`/`inbox-fixtures.ts`，CI/local 统一
  `test:visual` 入口

T8a 的初始脚本必须是两套可执行清单，不能把 JSON/MD/YAML 喂给 ESLint，也不能把 lock/TOML 喂给
Prettier：

```text
lint:repo-ui = eslint playwright.config.ts e2e/ux-consistency.spec.ts e2e/visual-regression.spec.ts e2e/nav-redesign.spec.ts e2e/keyboard-flows.spec.ts e2e/a11y.spec.ts e2e/harness.ts e2e/inbox-fixtures.ts --max-warnings=0
format:check:repo-ui = prettier --check package.json playwright.config.ts e2e/ux-consistency.spec.ts e2e/visual-regression.spec.ts e2e/nav-redesign.spec.ts e2e/keyboard-flows.spec.ts e2e/a11y.spec.ts e2e/harness.ts e2e/inbox-fixtures.ts e2e/README.md e2e/visual-regression.README.md .github/workflows/ci.yml .github/workflows/visual-regression-nightly.yml
```

并把它们链入既有组合入口：root `lint` 在 workspace lint 后执行 `lint:repo-ui`；root `format:check` 在
packages Prettier 后执行 `format:check:repo-ui`。这样 §4.4 与 CI 继续调用原命令也不会漏 non-package files。

### T7 — Source ratchets

- 新 `packages/frontend/tests/ux-source-ratchets.test.ts`：逐项枚举 native dialog/modal、bare text input、
  standard PageHeader、top-level TableViewport、dark-media precedence、foreground-as-fill、undefined token 的
  allowlist；失败输出 offending `path:line`
- 既有 `tabs-retrofit-grep.test.ts` + 新 tab callsite contract，证明 filter/view mode 与 true panel 全站分类完成

## 4. 定向验证命令

### 4.1 Public primitives

```bash
bun run --filter @agent-workflow/frontend test -- \
  tests/theme.test.ts \
  tests/theme-contrast.test.ts \
  tests/styles-tokens.test.ts \
  tests/btn-variants-styles.test.ts \
  tests/card.test.tsx \
  tests/form.test.tsx \
  tests/dialog.test.tsx \
  tests/dialog-nested.test.tsx \
  tests/dialog-portal-focus.test.tsx \
  tests/dialog-scroll-layout.test.ts \
  tests/confirm-dialog.test.tsx \
  tests/page-header.test.tsx \
  tests/notice-banner.test.tsx \
  tests/error-banner.test.tsx \
  tests/empty-state.test.tsx \
  tests/loading-state.test.tsx \
  tests/tab-bar.test.tsx \
  tests/tab-panels.test.tsx \
  tests/tabs-retrofit-grep.test.ts \
  tests/tab-callsite-contract.test.ts \
  tests/table-viewport.test.tsx \
  tests/resource-split-page.test.tsx \
  tests/ux-source-ratchets.test.ts
```

### 4.2 Shell/routes

实际文件名以开工时 `rg --files packages/frontend/tests` 为准，至少包含：

```bash
bun run --filter @agent-workflow/frontend test -- \
  tests/nav.test.ts \
  tests/shell-nav-wiring.test.ts \
  tests/app-shell-layout.test.ts \
  tests/app-shell-layout.test.tsx \
  tests/gallery-page.test.tsx \
  tests/tasks-list-surgery.test.tsx \
  tests/scheduled-list-inline.test.tsx \
  tests/repos-page.test.tsx \
  tests/memory-tab-deeplink.test.ts \
  tests/task-detail-tabs.test.ts \
  tests/oidc-dialog-strategy.test.ts \
  tests/oidc-confirm-dialog.test.tsx \
  tests/skill-file-tree-canonical-token.test.tsx \
  tests/skill-file-tree-discard.test.tsx \
  tests/batch-import-dialog.test.tsx \
  tests/reviews-detail-readonly-source.test.ts \
  tests/review-canonical-warning.test.tsx \
  tests/multidoc-historical-round.test.tsx \
  tests/wrapper-context-menu.test.ts \
  tests/wrapper-delete-confirm-dialog.test.tsx \
  tests/workflows-pages.test.tsx \
  tests/workflow-import-dialog.test.tsx \
  tests/homepage.test.tsx
```

### 4.3 Browser

先构建：

```bash
bun run build:binary
```

Chromium 定向：

```bash
bunx playwright test \
  e2e/ux-consistency.spec.ts \
  e2e/nav-redesign.spec.ts \
  e2e/keyboard-flows.spec.ts \
  e2e/a11y.spec.ts \
  e2e/main.spec.ts \
  e2e/workflow-editor.spec.ts \
  e2e/task-wizard.spec.ts \
  e2e/agent-port-editor.spec.ts \
  e2e/skill-import.spec.ts \
  --project=chromium \
  --retries=0
```

PR4 的 RFC-197 handoff 必须使 `e2e/agent-import.spec.ts` 进入 HEAD；完成 handoff 后另跑（不是 PR1–PR3 的
missing-path 条件命令）：

```bash
bunx playwright test e2e/agent-import.spec.ts --project=chromium --retries=0
```

Dialog/focus WebKit：

```bash
PLAYWRIGHT_WEBKIT=1 bunx playwright test \
  e2e/ux-consistency.spec.ts \
  e2e/keyboard-flows.spec.ts \
  --project=webkit \
  --retries=0
```

Visual：

```bash
bun run test:visual -- --retries=0
```

只有人工检查 diff 符合 RFC 后才更新 baseline，再立即复跑。Linux baseline 通过仓库既有 visual workflow/artifact
流程生成，不复制 darwin PNG 冒充。

### 4.4 完整门禁

```bash
bun run typecheck
bun run test
bun run --filter @agent-workflow/shared test
bun run --filter @agent-workflow/frontend test
bun run lint
bun run format:check
bun run build:binary
bun run e2e
bun run test:visual
```

## 5. 手工视觉验收清单

- 1280×800 light/dark：首页、gallery、split detail、tasks、settings、workflow editor、dialog。
- 1024×768：sidebar 保留时标题/actions/table 不被挤出。
- 901px/900px：desktop/compact shell 唯一切换边界；两者均无隐藏副本、tab-order/body overflow。
- 768×1024：compact shell + tablet content，字段与 action bounding width 可用。
- 721px/720px：只验 content/form/split stack 边界，不再当 shell breakpoint。
- 390×844 light/dark：menu、Inbox、账号/语言/设置、列表→detail、table、tabs、form、confirm/import dialog。
- 200% zoom：mobile 等价重排；导航与主操作仍可达。
- 长中英文 resource name、path、error、button label：wrap/ellipsis/title 语义正确。
- 键盘：menu→route→focus restore，TabBar arrows/Home/End，table region，Dialog/Select 两级 ESC。
- 主题反向：OS dark + app light、OS light + app dark；diff/primary/status 不能串色。
- loading/error/stale/empty/no-match：页面不跳高、不吞旧数据、retry/clear/new 动作明确。

## 6. 当前共享工作树处置

RFC 起草时以下 RFC-198 范围附近已有他人未提交改动：

- `packages/frontend/src/components/UserMenu.tsx`
- `packages/frontend/src/components/shell/MemoryPendingBadge.tsx`
- `packages/frontend/src/hooks/useActor.ts`
- `packages/frontend/src/routes/memory.distill-jobs.$jobId.tsx`
- `packages/frontend/tests/nav-memory-tab.test.tsx`
- 以及 clarify/review draft store 与相关测试。

同时 `design/RFC-197-agent-import-ux/` 已在 shared worktree 出现实现改动（不能只按 STATE 的 Draft 文案推断
状态），独占 `AgentImportDialog` 三阶段、`agent-import-preview`、读取隔离、result、`agents.new` import
callback、feature CSS/i18n/tests。当前共同 ownership 路径至少包括：

- `packages/frontend/src/components/AgentImportDialog.tsx`
- `packages/frontend/src/components/Form.tsx`
- `packages/frontend/src/components/TabBar.tsx`
- `packages/frontend/src/components/Dialog.tsx`
- `packages/frontend/src/lib/agent-import-preview.ts`
- `packages/frontend/src/routes/agents.new.tsx`
- `packages/frontend/src/styles.css` 与 Agent import i18n keys
- `packages/frontend/tests/agent-import-dialog.test.tsx`
- `packages/frontend/tests/agent-import-preview.test.ts`
- `packages/frontend/tests/dialog.test.tsx`
- `packages/frontend/tests/tab-bar.test.tsx`
- Agent import source/route/i18n guards

RFC-198 不得提前套 Agent import TableViewport、清理 selector、改写状态机或接管 AgentForm import tab。PR1/T2
与 PR3/T4 开工前先逐路径 diff 并重跑 RFC-197 定向 tests，不整体重写 Form/TabBar/Dialog tests；若其中任一
红灯，交回 RFC-197 owner 处置，RFC-198 不放宽或覆盖其断言。

AgentImportDialog true-tab a11y 是显式 handoff：RFC-197 可自行补 stable id/panel；否则在 owner 完成且文件
无重叠 hunk 后，由 RFC-198 只加 id/role/labelledby。handoff 还要求 `e2e/agent-import.spec.ts` 进入 HEAD。
PR1–PR3 可独立推进，但 PR4 合入前必须移除这一具名临时例外、跑绿 RFC-197 suite/E2E 并把该 spec 原子加入
repo-ui fixed list；RFC-198 不得在例外未闭合时标 Done。

批准后开工前必须重新 `git status --short` 与逐路径 `git diff -- <path>`：

- 能通过新增组件/import 邻近 hunk 避开时直接避开；
- 若同一函数/同一断言发生重叠，停止该子任务并询问，不覆盖、不格式化他人文件；
- 只用 `apply_patch` 做定点编辑；不对 `styles.css`/i18n/route 做 bulk rewrite；
- 精确 pathspec stage/commit，绝不 `git add .` / `git add -A`；
- shared `main` 不 amend/rebase/reset/force-push。

## 7. Gate 与完成条件

- [x] 用户明确批准 RFC-198（2026-07-15「ok」）。
- [x] T1–T9 分批完成，每批定向测试先绿。
- [x] native dialog 与旧 shell hack 清零，source ratchet 有明确例外。
- [x] light/dark/explicit-vs-system contrast 通过。
- [x] 901/900 shell、768 tablet、721/720 content、390 mobile 的 table/tabs/split/dialog 浏览器证据闭环。
- [x] 视觉 diff 经人工检查，darwin/linux baseline 与 README 同步。
- [x] Codex 实现 gate 对 live diff 审查，所有 P1/P2 处置后复核 APPROVE。
- [x] typecheck/backend+shared/frontend/lint/format/binary/e2e/visual 全绿。
- [x] `STATE.md` 与 RFC index 标 Done，记录 commits、测试、CI SHA。
- [x] 精确路径 commit + push origin/main；按最终实现/基线 SHA 查 CI。
