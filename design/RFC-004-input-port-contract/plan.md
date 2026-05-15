# RFC-004 Plan — 实施任务分解

> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
>
> **PR 拆分建议**：单 PR。改动跨 backend / frontend / docs 三处但都围绕同一契约，拆开易出"backend 改了但前端没跟"的中间态。

## 0. 前置

- 确认用户批准本 RFC（CLAUDE.md RFC 流程要求）。
- 在 `STATE.md` 顶部追加"进行中 RFC：RFC-004 …"一行（落档时同步）。
- `design/plan.md` RFC 索引追加 `RFC-004` 行，状态 `In Progress`。

## 1. 任务清单

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-004-T1 | 把 `syncInputDefs` 写成纯函数 + 5 case 测试（先写测试） | `packages/frontend/src/components/canvas/syncInputDefs.ts`、`tests/sync-input-defs.test.ts` | — |
| RFC-004-T2 | 把 `applyDefinitionPatch` 接到 `WorkflowCanvas` 的 node add / patch / delete 路径上 | `packages/frontend/src/components/canvas/WorkflowCanvas.tsx` | T1 |
| RFC-004-T3 | NodeInspector input 分支新增 4 字段（kind/label/required/description）+ inputKey 改名级联（`renameInputKey` helper）+ 4 case 测试 | `packages/frontend/src/components/canvas/NodeInspector.tsx`、`tests/input-inspector.test.tsx` | T2 |
| RFC-004-T4 | 编辑器打开老 workflow 触发一次 `syncInputDefs` 修复 + 1 case 测试 | `packages/frontend/src/routes/workflows.edit.tsx`、`tests/canvas-edit-old-workflow.test.tsx` | T1 |
| RFC-004-T5 | i18n 中英文各加 5 条 key（`inspector.fieldInputKind` / `fieldInputLabel` / `fieldInputLabelHint` / `fieldInputRequired` / `fieldInputDescription`） | `packages/frontend/src/i18n/zh-CN.ts`、`en-US.ts` | T3 |
| RFC-004-T6 | scheduler input 分支 `portName: 'out'` → `portName: inputKey` + 复盘 case 测试 | `packages/backend/src/services/scheduler.ts`、`tests/input-port-contract.test.ts` | — |
| RFC-004-T7 | 既有 `scheduler.test.ts` 三处 input 节点 fixture 跟随 T6 改 `portName` | `packages/backend/tests/scheduler.test.ts` | T6 |
| RFC-004-T8 | validator 加 `input-key-not-declared` + `input-orphan-declared`（warning）+ `severity` 字段；3 case 测试 | `packages/backend/src/services/workflow.validator.ts`、`packages/backend/src/shared/types.ts`（或 schema 文件，按现状路径选）、`tests/workflow-validator.test.ts` | — |
| RFC-004-T9 | 前端 `ValidationPanel` 渲染 errors / warnings 两栏（warning 黄色 muted，error 红） | `packages/frontend/src/routes/workflows.edit.tsx`（ValidationPanel 在此文件内）、`tests/validation-panel.test.tsx`（已有）+1 case | T8 |
| RFC-004-T10 | launcher 渲染回归测试 | `packages/frontend/tests/launcher-renders-from-input-node.test.tsx` | T2 |
| RFC-004-T11 | `design/design.md` §5 YAML 样例 + §7.3 加段落；`STATE.md` 顶部状态行更新 | docs | — |
| RFC-004-T12 | 终态：`bun run typecheck && bun run test && bun run format:check` 全绿 → 单 PR commit + push → 守 GH Actions（[feedback_post_commit_ci_check]） | — | 所有上游 |

## 2. 执行顺序建议

```
T1（pure helper TDD）
 └─ T2（接到 canvas）
     ├─ T3（inspector + 改名级联）─ T5（i18n）
     ├─ T4（老 workflow 自动修）
     └─ T10（launcher 回归）

T6（scheduler 改约）── T7（fixture 跟随）
T8（validator 新规则）── T9（前端 panel 升级）

汇合 → T11（docs）→ T12（typecheck/test/format + push + 守 CI）
```

T1/T6/T8 三条线**互不依赖**，可以并行起；T6 跟 T1 都不强依赖谁先合。建议三条都先把测试写红，再去填实现，保证不漏 case。

## 3. 验收清单（对齐 proposal §4）

- [ ] A1 全新画布 workflow → launcher → task 跑通（人工 smoke：`bun run dev` 起 daemon + frontend 一遍）。
- [ ] A2 input 抽屉 5 字段渲染（T3 自动测覆盖）。
- [ ] A3 改 inputKey 三件套同步（T3 自动测覆盖）。
- [ ] A4 删 input 节点 entry 同步消失（T1 sync 测覆盖）。
- [ ] A5 validator 新规则 + 老 workflow 编辑器自动修（T4 + T8 自动测覆盖）。
- [ ] A6 scheduler 复盘 case（T6 覆盖）。
- [ ] A7 `design.md:510` 样例对齐（T11 docs 改）。
- [ ] B1 三个命令全绿（T12）。
- [ ] B2 RFC-003 测试不动；diff 在 RFC-003 命名的 4 个文件外（除非顺手清理 import）。
- [ ] B3 frontend test +12（T1=5 + T3=4 + T4=1 + T9=1 + T10=1）。
- [ ] B4 backend test +6（T6=1 + T8=3 + 其它路径调试增量，最低 +6）。
- [ ] B5 老 DB workflow 编辑器一开自动修（T4 覆盖）。
- [ ] C1/C2/C3 三条回归注释 / 文件命名按 proposal §C 落地。

## 4. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 已有的 e2e（P-5-07 `e2e/main.spec.ts`）用的工作流没 input 节点 → 不受冲击；但若维护者扩展 fixture 时复用了 `portName: 'out'` 模式，会失败 | T11 顺手把 e2e fixture 检查一遍：当前 `e2e/main.spec.ts` 用的是 input→agent→output，input 节点 inputKey 在 fixture 里——确保 fixture 用 inputKey 命名 source.portName |
| 用户已有 N 个老 workflow 不打算重新打开 | 接受：DB 里继续坐着等。task launch 时仍然 fail（同 launcher 没框可填），但 validator 报错会指出 root cause，比当前"static envelope missing"信息密度高得多 |
| `severity` 字段加进 ValidationIssue 是 `result.ok` 语义微调 | T8 顺手在 `tests/workflow-validator.test.ts` 加一条断言"既有 error code 不指定 severity 时仍计入 ok=false"，锁住向后兼容 |
| 单 PR diff 较大（预估 +400 / -50 LoC） | T1/T6/T8 三条线测试集中、改动局部，code review 不难 |

回滚：单 PR `git revert` 即可恢复 RFC-003 后的状态。`design.md` 的 YAML 样例改动是文档级，无运行时影响。

## 5. 完工后

- `STATE.md`：把"进行中 RFC"行删掉；在"已完成 RFC"表追加 RFC-004 行（关键产出按 RFC-001/002/003 那种密度写）；保持"最近更新"日期同步。
- `design/plan.md`：RFC-004 索引状态改为 Done。
- 推完 commit 立即按 [feedback_post_commit_ci_check] 查 GH Actions 全绿。
