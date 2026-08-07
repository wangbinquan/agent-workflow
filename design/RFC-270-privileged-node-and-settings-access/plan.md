# RFC-270 · 任务分解

> 产品视角见 [`proposal.md`](./proposal.md)，技术设计见 [`design.md`](./design.md)。

单 PR（本仓主干开发，直接在 `main` 上小步提交）。按批次顺序落地，每批自带测试，全部绿了才 push。

## 批次 A · shared 契约层

| 任务 | 内容 | 依赖 |
|---|---|---|
| **RFC-270-T1** | 新建 `packages/shared/src/privilegedNodeRedaction.ts`：`PrivilegedNodeLens` / `PRIVILEGED_LENS_TRANSPARENT` / `lensIsTransparent` / `SCRIPT_REDACTED_FIELDS` / `CODE_HOST_REDACTED_FIELDS` / `redactPrivilegedNodes` / `rehydratePrivilegedNodes`（design §1） | — |
| **RFC-270-T2** | `workflowNodeAncestry.ts` 追加 `ancestryUnchanged(previous, next, nodeIds)`（design §4.5） | — |
| **RFC-270-T3** | `packages/shared/src/index.ts` 导出；`shared/tests/privileged-node-redaction.test.ts` + `workflowNodeAncestry.test.ts` 追加（design §7 shared 全部条目，含脱敏后严格 schema 解析与「脱敏∘回填」不变式） | T1 T2 |

## 批次 B · 后端读镜头

| 任务 | 内容 | 依赖 |
|---|---|---|
| **RFC-270-T4** | 新建 `services/privilegedNodeLens.ts`：`privilegedNodeLensFor(actor)` | T1 |
| **RFC-270-T5** | `services/tokenRedaction.ts`：引入 `WorkflowReadLens` + `workflowReadLensFor`，三个 serializer 换签名并叠加两轴；改写 `:33-41` 的注释（PAT 轴按 source，权限轴按 permissions） | T4 |
| **RFC-270-T6** | 修全部调用点：`routes/workflows.ts` 8 处、`routes/tasks.ts` 7 处（design §2.2 表） | T5 |
| **RFC-270-T7** | `backend/tests/rfc270-privileged-node-read-lens.test.ts`（AC-1 / AC-2 / AC-4 / AC-5 + WS 帧无 `definition` 的源码层断言） | T6 |

## 批次 C · 后端写回填

| 任务 | 内容 | 依赖 |
|---|---|---|
| **RFC-270-T8** | `services/workflow.ts` `prepareWorkflowSave`：两个 gate 之前插回填，下游一律用 `definitionForSave`（design §2.3） | T1 T4 |
| **RFC-270-T9** | `backend/tests/rfc270-privileged-node-rehydrate.test.ts`（AC-6 / AC-7 / AC-8 + `verbatim-copy`·`system` 透明镜头 + 「回填后不再引用 `normalizedSnapshot.definition`」源码层断言） | T8 |

## 批次 D · 前端权限钩子与 palette

| 任务 | 内容 | 依赖 |
|---|---|---|
| **RFC-270-T10** | 新建 `hooks/usePrivilegedNodes.ts`（钩子 + 可单测的纯函数 `privilegedNodeAccessOf`），design §3 | — |
| **RFC-270-T11** | `canvas/EditorSidebar.tsx` 透传 `disabledReason`；`WorkflowCanvas.tsx:3109` 与 `routes/workflows.edit.tsx:1062` 传入 | T10 |
| **RFC-270-T12** | `WorkflowNodePicker.tsx:280`/`:389-390` 补拖拽分支（`draggable={reason === null}` + `onDragStart` 阻止） | T10 |
| **RFC-270-T13** | i18n：`editor.nodePicker.requiresPermission` 等新 key，中英双语 | T11 T12 |
| **RFC-270-T14** | `frontend/tests/rfc270-palette-permission.test.tsx`（AC-9 / AC-10，点击 + 拖拽两分支）；`palette.test.ts` 补条目级 disabled 断言 | T11 T12 T13 |

## 批次 E · 前端 Inspector 与配置页

| 任务 | 内容 | 依赖 |
|---|---|---|
| **RFC-270-T15** | `inspector/ScriptEdit.tsx`：`!canAuthor` 提前返回 `EmptyState` 占位；改写 `:11-15` 注释为 RFC-270 改判；退役 `scriptInspector.noAuthorPermission` | T10 |
| **RFC-270-T16** | `inspector/CodeHostCallEdit.tsx`：同上；并给 `:262-273` 的「管理连接 ↗」加 `usePermission('settings:read')` | T10 |
| **RFC-270-T17** | i18n：`*.noViewPermission.title/body` 中英双语；清理退役 key | T15 T16 |
| **RFC-270-T18** | `lib/query-client.ts` 导出 `appQueryClient` 单例；`main.tsx` 与 `router.tsx` 共用；`createRouter` 加 `context`；`hooks/useActor.ts` 抽 `meQueryOptions` | — |
| **RFC-270-T19** | `routes/settings.tsx` 加 `beforeLoad` 守卫（design §4.4，失败放行 + `replace: true`） | T18 |
| **RFC-270-T20** | `frontend/tests/rfc270-privileged-inspector.test.tsx`（AC-11 / AC-12 + `hasPreview` 前提）与 `rfc270-settings-route-guard.test.tsx`（AC-13 三分支） | T15–T19 |

## 批次 F · 画布保护与 403 分流

| 任务 | 内容 | 依赖 |
|---|---|---|
| **RFC-270-T21** | `WorkflowCanvas.tsx`：受保护节点 `draggable/deletable=false`、受保护边 `deletable=false`、`isValidConnection` 拒绝 | T10 |
| **RFC-270-T22** | `WorkflowCanvas.tsx:2712-2790`：`ancestryUnchanged` 守卫，破坏归属的补丁丢弃并提示 | T2 T21 |
| **RFC-270-T23** | `lib/workflow-editor-draft.ts`：`WorkflowDraftFailure` 加 `code`；`saveFailed`/`reconcileFailed` 前置分流到 `error` 相位 | — |
| **RFC-270-T24** | `hooks/useWorkflowEditorDraft.ts:1017-1031`：`failureFromError` 保留 `ApiError.code` | T23 |
| **RFC-270-T25** | `WorkflowDraftStatus.tsx`：按 `error.code` 分流出专属横幅 + i18n 双语 | T23 T24 |
| **RFC-270-T26** | `frontend/tests/rfc270-canvas-privileged-nodes.test.tsx`（AC-14 / AC-15）与 `rfc270-draft-author-forbidden.test.ts`（AC-16，含「不带 code 的 403 仍是 `inaccessible`」反例） | T21–T25 |

## 批次 G · 文档与记档

| 任务 | 内容 | 依赖 |
|---|---|---|
| **RFC-270-T27** | `design/plan.md` RFC 索引登记 RFC-270；`STATE.md` 顶部「进行中 RFC」→ 完工后置 Done | — |
| **RFC-270-T28** | RFC-253 / RFC-269 文档标注被本 RFC 改判之处（AC-30 与只读横幅设计）；`docs/code-host-calls.md` 更新权限描述 | E 批 |
| **RFC-270-T29** | `docs/dev-gotchas.md` 补两条：①脱敏 YAML 导出→admin 导入会造出 `***` 正文；②新增文件先 `git add -N` 再跑门禁（RFC-269 已踩，本次同样有新文件） | — |
| **RFC-270-T30** | `docs/audit-backlog.md` 登记 `snapshotHash` 镜头不对称（design §2.4） | — |

## 验收清单

实现完成、`bun run gate:local` 全绿之后，逐条对 `proposal.md §6`：

- [ ] AC-1 ~ AC-8（后端，批次 B / C）
- [ ] AC-9 ~ AC-16（前端，批次 D / E / F）
- [ ] `proposal.md §5` 能力影响清单 C1–C8 **每条**都有对应测试
- [ ] 权限目录计数仍为 67，角色矩阵未变
- [ ] 既有 `rfc253-script-author-gate.test.ts` / `rfc269-code-host-authoring.test.ts` 全绿未改判
- [ ] 显式改判的断言（design §7 末节）逐条写明理由
- [ ] Codex 实现门跑过并修完 findings
- [ ] push 后按 exact SHA 查 CI 绿

## 风险与回滚

- **最大风险是「遮了没回填」导致静默丢数据**：批次 B（遮）与批次 C（填）必须**同一次 push**，绝不允许只推 B。T3 的「脱敏∘回填」不变式测试是这条的守门人。
- **第二风险是漏出口**：T5 的换签名是编译期爆破，任何漏改的出口都编译不过；WS 帧靠 T7 的源码层断言。
- 回滚粒度：批次 B+C 一起回滚即恢复今日行为；批次 D/E/F 各自独立可回滚。
