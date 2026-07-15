# RFC-195 — 实施计划

> 当前状态：Done。T1-T7 全部完成；实现 SHA `6225130d` 的主 CI 与 Linux visual nightly 均已通过。

## 1. 任务分解

| 任务       | 内容                                                                                                                      | 依赖  | 验收                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------- |
| RFC-195-T1 | 新建 `lib/inbox-view.ts`：item projection、stable sort、counts、selected-feed state machine                               | 无    | 纯函数真值表与 filter/sort/count 测试全绿             |
| RFC-195-T2 | 公共原语最小扩展：`Segmented.activeOptionRef`、`ErrorBanner.message/action/role=alert`                                    | 无    | optional 路径零回归；新契约测试全绿                   |
| RFC-195-T3 | `InboxFooterButton` forwardRef + root trigger ref；`InboxDrawer` 迁共享 Dialog/Segmented/Empty/Loading/Error/RelativeTime | T1,T2 | 无自建 portal/ESC/outside/modal chrome；三源/路由不变 |
| RFC-195-T4 | 重写 inbox 业务 CSS 与 i18n；桌面 420×≤680 side dialog、<=720 full-screen sheet、长文案约束                               | T3    | light/dark/390px 无溢出；zh/en key 对称               |
| RFC-195-T5 | 更新 `inbox-drawer.test.tsx`，新增 navigation-close、focus restore、三态、partial error、workgroup、长文案与 RFC-121 锁   | T3,T4 | 专属 frontend suite 全绿                              |
| RFC-195-T6 | 更新 nav e2e、opened-dialog axe 与 visual regression empty/populated baselines                                            | T4,T5 | 桌面/窄屏/a11y/visual 证据闭环                        |
| RFC-195-T7 | 全门禁、实现 gate、文档/STATE 收口、精确路径提交与 push/CI                                                                | T1-T6 | 五门 + binary smoke + SHA CI 全绿                     |

## 2. 建议提交结构

单 PR，建议两次提交后在 push 前 squash **不做**（共享 main 禁 amend/rebase）；直接保持清晰线性历史：

1. `feat(inbox): RFC-195 重构收件箱弹窗交互与响应式`
2. 若实现 gate 有修正：`fix(inbox): RFC-195 折入实现门反馈`

每个 Codex 创建的 commit 均附当前会话真实模型 slug 的
`Assisted-By: OpenAI Codex (<active-model-slug>)` trailer。

## 3. 测试命令

先跑专属：

```bash
bun run --filter @agent-workflow/frontend test -- \
  tests/inbox-view.test.ts \
  tests/inbox-drawer.test.tsx \
  tests/inbox-footer-button.test.tsx \
  tests/segmented.test.tsx \
  tests/error-banner.test.tsx
```

再跑仓库门禁：

```bash
bun run typecheck
bun run test
bun run --filter @agent-workflow/frontend test
bun run lint
bun run format:check
bun run build:binary
```

e2e 定向：

```bash
bun run e2e -- e2e/nav-redesign.spec.ts e2e/a11y.spec.ts
RUN_VISUAL_REGRESSION=1 bun run e2e -- e2e/visual-regression.spec.ts --update-snapshots
```

## 4. 手工视觉验收

起隔离 dev daemon + 当前 Vite，逐项截图/量测：

- desktop 1280×800：empty / populated / partial error；
- dark desktop 1280×800：populated；
- narrow 390×844：empty / populated；
- 128 字符标题 + 128 字符 task name + clarify detail 长文案；
- 30+ rows：header/footer 固定、仅 body 滚动；
- keyboard：trigger Enter → selected filter focus → Tab 不逃逸 → ESC → trigger focus；
- 点击 review/clarify/workgroup：弹窗消失且 URL 正确。

## 5. 多人工作树处置

- 当前 `styles.css` 与 zh/en i18n 有其他 RFC 未提交改动；T4 只 patch inbox 邻近块与
  `nav.inbox` key，修改前后分别看 `git diff -- <path>`，不格式化整个文件制造噪声。
- `InboxDrawer.tsx`、`InboxFooterButton.tsx`、inbox tests、RFC 索引当前无他人修改；若批准后开工时
  已变脏，先逐 hunk 查归属；同一函数同一行冲突则停下询问。
- 提交只精确 `git add` RFC-195 归属路径，绝不 `git add .`。

## 6. 完成清单

- [x] 用户明确批准 RFC-195（2026-07-15「ok」）。
- [x] T1 纯派生模型与真值表完成。
- [x] T2 公共原语兼容扩展完成。
- [x] T3/T4 弹窗、响应式、i18n 完成。
- [x] T5 组件回归锁完成。
- [x] T6 e2e/a11y 与 Darwin/Linux visual baseline 完成；Linux 由 Option B CI artifact 回填。
- [x] Codex 实现门 findings 全处置；最终复核 APPROVE。
- [x] typecheck / backend+shared test / frontend test / lint / format / binary smoke 全绿。
- [x] STATE / RFC index 标 Done，记录 commit 与验证结果。
- [x] 精确路径 commit + push origin/main；`6225130d` 的 SHA CI run `29407388716` 全绿。
