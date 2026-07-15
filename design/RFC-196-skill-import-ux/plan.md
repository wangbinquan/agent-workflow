# RFC-196 — Skill ZIP 导入体验重构：实施计划

> 当前状态：Done。2026-07-15 用户批准「ok」后完成实现与验证。

## 1. 任务分解

| 任务       | 内容                                                                                                              | 依赖  | 验收                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------- |
| RFC-196-T1 | shared 导出 `SKILL_ZIP_LIMITS`；backend `ZIP_LIMITS` 改兼容 alias；补常量同源测试                                 | 无    | 数值 / decode 行为逐字保持，shared+backend tests 绿 |
| RFC-196-T2 | 新公共 `FileDropzone` + CSS + component tests（pick/drop/reselect/disabled/error/focus）                          | 无    | API 不含 Skill 文案；单文件与 a11y 合同全绿         |
| RFC-196-T3 | 扩充 `skill-zip-import.ts`：file check、review/submit/result 纯函数与边界测试                                     | T1    | action / rename 旧矩阵零退化，新状态真值表全绿      |
| RFC-196-T4 | `ImportZipPanel` 落 select / review / result 状态机；Card 候选、shared errors/status/form、结果链接与 reset focus | T2,T3 | 网络/HTTP/部分失败/全成功/换包/重复提交全覆盖       |
| RFC-196-T5 | `skills.new.tsx` ZIP 动态 title/subtitle；zh/en i18n 与 CSS 收口，删除旧 table / private chrome 死样式            | T4    | managed 创建零回归；i18n 对称、grep 零死调用        |
| RFC-196-T6 | route/integration/a11y/keyboard/responsive tests；dev 1280 light/dark + 390 三阶段视觉量测                        | T4,T5 | feature 无水平 overflow，焦点与 axe 通过            |
| RFC-196-T7 | 全门禁、实现 gate、文档/STATE 收口、精确路径 commit + push + SHA CI                                               | T1-T6 | 五门 + binary smoke + CI 全绿                       |

## 2. 实施顺序

1. T1/T2/T3 可分别落小步，但同一 shared `main` 上线性提交；不创建 feature branch。
2. T4 先用现有 i18n key 完成结构与测试，再由 T5 一次性整理 key / CSS，避免巨型组件与大翻译 diff 同时排错。
3. T6 必须拿真实 parse response 驱动 review / result，不用静态假 DOM 截图代替。
4. 实现 gate findings 另起修复 commit，不 amend / rebase / force-push。

## 3. 建议提交结构

1. `feat(skills): RFC-196 重构 ZIP 导入任务流`
2. 若实现 gate 有修正：`fix(skills): RFC-196 折入实现门反馈`

每个 Codex 创建的 commit 均附当前会话真实模型 slug：

```text
Assisted-By: OpenAI Codex (<active-model-slug>)
```

## 4. 测试命令

先跑专属：

```bash
bun run --filter @agent-workflow/frontend test -- \
  tests/file-dropzone.test.tsx \
  tests/skill-zip-import-helpers.test.ts \
  tests/import-zip-panel.test.tsx \
  tests/skills-new-zip-tab.test.ts \
  tests/skills-split-page.test.tsx

bun test packages/shared/tests/skill-zip.test.ts \
  packages/backend/tests/skill-zip-decode.test.ts \
  packages/backend/tests/skill-zip-commit.test.ts \
  packages/backend/tests/skills-import-zip-http.test.ts
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

e2e 定向路径以实现时新增 / 更新的 spec 为准，至少覆盖：

```bash
bun run e2e -- e2e/a11y.spec.ts e2e/keyboard-flows.spec.ts <skill-import-spec>
```

## 5. 手工视觉验收

使用隔离 daemon + 当前 Vite，至少检查：

- 1280×800 light：select / one-candidate / multi-candidate-conflict / full success / partial failure；
- 1280×800 dark：multi-candidate-conflict / result；
- 390×844：select / long candidate + rename error / archive errors + action bar / result；
- 30 candidates：滚动到首尾、sticky action 不遮最后一项、Select portal 未被 scroll container 裁剪；
- 128 字符 name/description/warning/message：卡片与 detail 不横向溢出；
- keyboard：文件按钮 → 检查 → action Select → rename → import → result → continue；
- 失败恢复：parse network fail 重试、commit 5xx 保留决策、existing names query fail 后 retry；
- managed tab 往返：ZIP file / rows 保留，managed create button 与表单不变。

## 6. 多人工作树处置

- 当前 `STATE.md`、`design/plan.md`、`styles.css`、zh/en i18n 已含 RFC-194/195 等并发改动；实现时只对
  RFC-196 邻近 hunk 做 `apply_patch`，不格式化整个共享文件制造噪声。
- `ImportZipPanel.tsx`、`skills.new.tsx`、ZIP tests 当前无未提交改动；批准后开工前再次 `git status` +
  `git diff -- <paths>`。若同一函数同一行变脏，停下询问，不覆盖。
- 提交按精确 pathspec `git add`，绝不 `git add .` / `git add -A`；未追踪 RFC-194/195 与 inbox / agent-port
  文件不纳入 RFC-196 commit。
- 共享 `main` 上不 amend / rebase / reset / force-push；push 前重读 `CLAUDE.md` / `STATE.md` 并确认最新 CI 基线。

## 7. 完成清单

- [x] 用户明确批准 RFC-196。
- [x] T1 limits 单源且 backend 行为零变化。
- [x] T2 FileDropzone 公共原语与测试完成。
- [x] T3 纯函数真值表完成，旧安全矩阵零退化。
- [x] T4/T5 三阶段 UI、i18n、CSS 与死样式清理完成。
- [x] T6 unit / integration / a11y / keyboard / responsive / visual 证据闭环。
- [x] Codex 实现门 findings 全处置并复核通过。
- [x] typecheck / test / frontend / lint / RFC-196 路径 format / binary smoke 全绿；工作树全量 format 例外已记档。
- [x] `STATE.md` / RFC index 标 Done，记录验证结果。
- [ ] 精确路径 commit + push origin/main；按最终 SHA 查 CI。

## 8. 实现与验证记录

- 实现门自查并修复：异常响应体为 `null` 时的错误归一、浅/深色紧凑状态 chip 与主按钮对比度、
  390px 下两个桌面 rail 把内容压到 138px 的假响应式。
- 真实浏览器：1280px 下任务根宽 712px；390×844 下 route-scoped 专注布局根宽 358px，feature/document
  均无水平 overflow，所有表单控件落在根边界内。
- 自动验证：backend/shared 全量 718 files / 5638 pass / 23 skip / 0 fail；frontend 全量 517 files /
  3961 tests；真实 daemon + ZIP 的 Playwright/axe/focus/390px E2E 1/1；workspace typecheck、lint、binary
  smoke 与 RFC-196 精确路径 Prettier 通过。
- `bun run format:check` 唯一失败路径为 RFC-196 范围外、并发未提交的
  `packages/frontend/tests/nav-memory-tab.test.tsx`；按共享工作树规则未替他人改写，也不纳入本 RFC commit。
