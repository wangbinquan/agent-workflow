# RFC-197 — Agent `agent.md` 导入体验重构：实施计划

> 当前状态：Done。用户已于 2026-07-15 明确批准实施；production、测试、真实浏览器与本地提交门禁均已闭环，远端 push / SHA CI 待用户另行授权。

## 1. 任务分解

| 任务       | 内容                                                                                              | 依赖  | 验收                                                  |
| ---------- | ------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------- |
| RFC-197-T1 | 新增 `agent-import-preview.ts`：全字段 → 五分区 view model、类型化摘要、文件扩展名校验            | 无    | full-surface fixture 无漏项；纯函数边界测试绿         |
| RFC-197-T2 | `AgentImportDialog` 改 select/review/result 判别联合；FileDropzone/TextArea；读取 generation 隔离 | T1    | 来源独立、返回/重置正确、reject/迟到结果全覆盖        |
| RFC-197-T3 | Review 卡片化：状态摘要、五分区 Card、warnings/overwrite/orphan/empty 与 Apply gate               | T1,T2 | runtime/resources 漏预览修复；旧 merge/阻断语义零退化 |
| RFC-197-T4 | Result 阶段、trigger focus、`agents.new` activeTab callback；Apply 只写 draft                     | T2,T3 | onApply 一次、稳定 not-created 反馈、详情路由仍无入口 |
| RFC-197-T5 | zh/en i18n + `.agent-import` 响应式 CSS；删除 legacy modal/table/native-control 死样式与旧 key    | T2-T4 | 公共原语守卫、i18n symmetry、grep 零死调用            |
| RFC-197-T6 | component/route/source-guard/e2e；1280 light/dark + 390 三阶段 axe/keyboard/geometry              | T1-T5 | 无水平溢出，footer 可达，焦点合同与长内容压力全绿     |
| RFC-197-T7 | 全门禁、实现 gate、文档/STATE 收口、精确路径本地 commit                                           | T1-T6 | 所有 finding 有处置；本地门禁与提交差异全绿           |
| RFC-197-T8 | 经用户明确授权后 push origin/main，并按最终 SHA 查询 CI                                           | T7    | 远端提交与 SHA CI 全绿                                |

## 2. 实施顺序

1. **批准前只做文档**：当前轮只落 RFC 三件套、RFC 索引与 STATE Draft；不触碰 production / tests。
2. 批准后先跑 T1，把“什么会展示到哪里”从组件里抽成可穷举的纯函数，先用当前漏项
   `runtime / dependsOn / mcp / plugins` 建红测。
3. T2 先完成状态机与来源阶段，保持旧 table review 临时可编译；再由 T3 一次替换 review，避免同时调试 IO、状态与布局。
4. T4 最后改变 Apply 后关闭行为，配套更新路由集成测试；任何时刻 `onApply` 都不得触发 backend create。
5. T5 清理只能在新调用方与 tests 全绿后进行；删除 CSS / i18n key 前先 `rg` 全仓确认零调用。
6. T6 使用真实 `parseAgentMarkdown` fixture 驱动页面，不用静态 mock DOM 冒充完整 preview。
7. 实现 gate finding 单独修复，不 amend / rebase / force-push；shared `main` 保留并发改动。
8. 同日 RFC-198 也处于 Draft；若两者都获批，默认先落 RFC-197，再由 RFC-198 把新 Agent import callsite 纳入全局
   回归。若 RFC-198 已先动公共原语或同一 CSS hunk，开工前按 live code 调和，不照搬旧接口。

## 3. 建议提交结构

默认一个实现 commit：

```text
feat(agents): RFC-197 重构 agent.md 导入任务流
```

若实现 gate 有实质修正，再追加：

```text
fix(agents): RFC-197 折入实现门反馈
```

每个 Codex 创建的 commit 均附当前会话真实 model slug：

```text
Assisted-By: OpenAI Codex (<active-model-slug>)
```

## 4. 自动测试

### 4.1 定向测试

批准实现后，以实际新增文件名为准，至少运行：

```bash
bun run --filter @agent-workflow/frontend test -- \
  tests/agent-import-preview.test.ts \
  tests/agent-import-dialog.test.tsx \
  tests/agent-import-merge.test.tsx \
  tests/agent-import-warnings.test.ts \
  tests/agents-new-import-button.test.tsx \
  tests/agents-split-page.test.tsx \
  tests/data-table-callsite.test.ts \
  tests/dialog-grep.test.ts \
  tests/tabs-retrofit-grep.test.ts

bun test packages/shared/tests/agent-md.test.ts
```

### 4.2 仓库门禁

```bash
bun run typecheck
bun run test
bun run --filter @agent-workflow/frontend test
bun run lint
bun run format:check
bun run build:binary
```

若共享工作树中的并发未提交文件导致全量 format 失败，必须：

1. 记录精确失败路径；
2. 对 RFC-197 精确 path 单独跑 Prettier check；
3. 不替他人格式化、暂存或提交其文件；
4. 仍以 clean commit 的 SHA CI format job 为最终证据。

### 4.3 e2e / a11y

定向命令按实现时 spec 组织确定，至少覆盖 Agent import + 共享键盘 / a11y 路径：

```bash
bun run e2e -- <agent-import-spec> e2e/a11y.spec.ts e2e/keyboard-flows.spec.ts
```

必须用隔离 daemon / 临时 HOME，不连接或污染用户当前 daemon 数据。

## 5. 手工视觉验收

- 1280×800 light：upload empty/selected、full-surface review、overwrite、result；
- 1280×800 dark：paste、blocking warning、non-blocking warnings、result；
- 390×844：upload/paste、五分区 review、orphan ErrorBanner、result；
- 128 字符 name/description/runtime/extra key、长 permission JSON、64 个 dependsOn/mcp/plugins、长 port description；
- 仅正文、仅 extra、空文件、无 frontmatter、坏 YAML、非 md drop、File.text reject；
- keyboard-only：打开、切来源、输入、检查、返回、填入、重新导入、ESC；
- 每阶段 axe；量测 document / panel / body / cards scrollWidth；footer buttons 全部在 viewport 内；
- Apply 后检查页面只变 draft、网络面板没有 `POST /api/agents`，Create 仍需单独点击。

## 6. 回归矩阵

| 既有契约                                      | 锁定方式                                                       |
| --------------------------------------------- | -------------------------------------------------------------- |
| RFC-018 filename fallback / paste no fallback | parser 既有 tests + dialog upload/paste integration            |
| partial overwrite + extra shallow merge       | `agent-import-merge.test.tsx` 原样绿                           |
| YAML warning structured adapter               | `agent-import-warnings.test.ts` 原样绿；Dialog 禁 prefix sniff |
| RFC-194 orphan sidecar fail closed            | dialog + split-page 两层测试                                   |
| duplicate/legacy ports 进入统一 repair gate   | split-page Create disabled 回归                                |
| import 只在 new route                         | source guard detail route negative assertion                   |
| shared Dialog/TabBar                          | grep + component role/focus tests                              |
| no data table/native form controls            | reverse source guards                                          |
| no backend auto-create                        | mocked network / mutation count + result state assertion       |

## 7. 多人工作树处置

批准实现前、每次 commit 前都执行：

```bash
git status --short
git diff -- <RFC-197 paths>
```

当前已知以下 frontend 文件是并发工作，和 RFC-197 无关，必须保留且不得暂存：

- `components/UserMenu.tsx`
- `components/shell/MemoryPendingBadge.tsx`
- `hooks/useActor.ts`
- `lib/{clarify,review}/draftStore.ts`
- `routes/memory.distill-jobs.$jobId.tsx`
- 对应 memory/logout/draft tests
- `design/RFC-198-global-ui-ux-consistency/` 及其 `STATE.md` / RFC index hunk

若实现期间 `styles.css`、zh/en i18n、`STATE.md`、`design/plan.md` 出现他人新 hunk：

- 用 `apply_patch` 在邻近区域最小插入，保留现有内容；
- 同一函数同一行真实冲突时停止并询问，不擅自覆盖；
- 提交使用精确 pathspec，绝不 `git add .` / `git add -A`；
- shared `main` 不 amend / rebase / reset / force-push。

## 8. 审批与完成清单

- [x] 用户明确批准 RFC-197 proposal/design。
- [x] T1 full-surface preview 单源与文件校验完成。
- [x] T2 select/review/result 状态机与迟到读取隔离完成。
- [x] T3 五分区 Card review、warning/overwrite/orphan/empty 完成。
- [x] T4 stable draft result、route/focus wiring 完成。
- [x] T5 i18n/CSS/legacy cleanup 完成。
- [x] T6 unit/integration/e2e/axe/keyboard/responsive/visual 证据闭环。
- [x] Codex 实现门 findings 全处置并复核通过。
- [x] `typecheck`、根级全量、frontend 全量、lint、RFC-197 精确路径 format、binary smoke 全绿。
- [x] RFC index / STATE 标 Done，并记录本地验证。
- [x] RFC-197 精确路径本地 commit。
- [ ] push origin/main；按最终 SHA 查询 CI 全绿（等待用户明确授权）。

## 9. 完成证据（2026-07-15）

- 根级测试：718 files，`5638 pass / 23 skip / 0 fail`；frontend：518 files，`3985 pass / 0 fail`。
- `bun run typecheck`、`bun run lint`、RFC-197 精确路径 Prettier、`bun run build:binary` 均通过；binary `version` smoke 通过。
- Playwright `e2e/agent-import.spec.ts`：`1 passed`，覆盖完整五分区 paste review、390×844 响应式、light/dark axe、仅写 draft、零 `POST /api/agents` 与 trigger focus restore。
- 真实浏览器复核了 select/review/result 三阶段的 1280×720 布局与长内容滚动；实现 gate 额外修复了浅色 info chip 对比度、暗色主按钮对比度、review/result 滚动区键盘可达、动态初始焦点回跳和标题整块 focus ring。
- 工作树全量 `format:check` 仍被并发 RFC-198 的 `ConfirmDialog.tsx`、`card.test.tsx`、`nav-memory-tab.test.tsx` 阻断；RFC-197 精确路径检查为绿色，未改动、未暂存这些并发文件。

## 10. 批准后开工前检查

1. 重读当前 `CLAUDE.md`、`STATE.md` 与本 RFC 三件套；
2. `git status --short --branch`，确认目标 production/tests 没有并发修改；
3. `rg` 复核 AgentImportDialog、parser、merge、AgentForm tabs、i18n、CSS、source guards 的最新形态；
4. 先写 T1 漏字段红测，再开始 production 修改；
5. 不根据本 Draft 之外的假设扩大 parser/backend 范围。
