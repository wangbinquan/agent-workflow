# RFC-194 任务分解

状态：Done（2026-07-15）

实施结果：T1–T7 全部完成；UX 与实现两道 Codex 复核均 APPROVE。端口编辑已切换为语义分区、
Card 摘要与事务 Dialog，导入/保存/角色切换共用 fail-closed 校验；rename/delete/orphan cleanup
原子维护三份 output 状态，clean-follow refetch 以完整目标快照和确认值身份拒绝陈旧覆盖。能力卡
description 预算、390px 响应式、axe、焦点与两级 Escape 合同均有回归锁。

默认单 PR，主体是 frontend + shared（端口导入与能力卡投影），另有两个 backend prompt option 调用点；无
migration、无 backend route/持久化改动。每个生产改动随同对应测试落地。commit 前缀：
`feat(frontend): RFC-194 …`。

## 任务

### RFC-194-T1 — 端口纯 helper 与 sidecar 不变量

- 新 `packages/frontend/src/lib/agent-ports.ts`：
  - `AGENT_PORT_NAME_RE` + direction-aware `validatePortName`（input 128、legacy unchanged pass-through、
    duplicate repair）；
  - input add/replace/remove + compact；
  - output add/replace/remove（add/replace 显式接收 role，wrapper 唯一仅 aggregator 强制）；
  - add/replace 返回显式 `PortMutationResult` failure union（index/name/kind/orphan/wrapper），失败不 mutate、
    不产生半更新 state，Dialog 留在原地；
  - rename/delete 按剩余同名引用原子维护 `outputs/outputKinds/outputWrapperPortNames`；
  - effective wrapper name 唯一校验；两类 orphan 在任意 role 检测，以 `{source,key}` 逐项显式清理
    （同 key 双来源互不误删）；add/rename 占 orphan key fail closed；
  - `validateAgentPortState(draft)` 单源：duplicate/schema/invalid kind/reserved-extra/effective-wrapper
    error + orphan warning；
  - 默认 string、同名 wrapper、最后 mapping 用 `{}` tombstone，untouched absent 才保留 undefined。
- 新 `packages/frontend/tests/agent-ports.test.ts` 覆盖 design §11.1 全矩阵，尤其三份状态迁移、
  duplicate/legacy/orphan/invalid kind/reserved extra、collision fail closed、PUT JSON clear 与
  immutability；backend service test 再锁 seed 非空 → 两份 `{}` 落盘/返回且无关 extra 保留。
- 依赖：无。

### RFC-194-T2 — KindSelect / Form 最小兼容扩展

- `TextInput` 透传 `aria-invalid` / `aria-describedby` 与可选 `inputRef`；`Field` 增加 optional
  label/error id 与 labelled group；不改现有调用方默认 DOM。
- `Select` 的 listbox Escape 阻止继续冒泡到 Dialog：第一次只关下拉并回 combobox，第二次才关
  Dialog；补共享 Select-in-Dialog 回归。
- `KindSelect` 加可选 `className/onValidityChange/contextLabel`：
  - guided/advanced validity；
  - advanced error aria + sole-owned role=alert（父 Dialog 只收 boolean，不复制 parse 文案）；
  - 多端口时 ext/list/advanced accessible name 带上下文；
  - wrapper 真实 class。
- `OUTPUT_KIND_UI` 加必填 `descriptionKey`；zh/en 类型说明；`KindSelect` 传
  `SelectOption.description`。
- 更新 kind catalog / KindSelect / Select 相关测试，完整 grammar round-trip 不变。
- 依赖：无（可与 T1 并行）。

### RFC-194-T3 — 公共端口卡与 Dialog

- 新 `components/agent-ports/AgentPortCard.tsx`：复用 `Card`，摘要槽、Edit、`ConfirmButton`、
  refs/focus 所需 props。
- 新 `components/agent-ports/AgentPortDialog.tsx`：add/edit input/output，复用
  `Dialog/Field/TextInput/TextArea/Switch/KindSelect`；初始 focus、取消零写入、校验禁 Save、
  aggregator wrapper 字段、最终 wrapper 唯一校验、legacy warning/repair。
- 新 `AgentPortValidationSummary.tsx`：同一 issues 的 header compact / Ports detail 两种密度；
  header 明示为何 Create/Save disabled 以及去哪个页签修复。
- 组件单测：inputRef 初始 focus、稳定 trigger snapshot、save/cancel/两级 ESC、错误关联、KindSelect
  invalid、trigger focus restore、nested-label 守卫、同一 issue 仅一个 live alert。
- 依赖：T1、T2。

### RFC-194-T4 — 重写 InputsEditor / OutputsEditor + AgentForm 接线

- 两 editor 改 `FormSection + 关系说明 + 数量 + Add + EmptyState + Card list + Dialog`；退役
  `useChipsCommit`/隐式 Enter-only composer/Backspace 删除。
- `InputsEditor` 接线 description/required/kind/name rename。
- `OutputsEditor` onChange 扩为三份状态；rename/delete 用 T1 helper；aggregator 就近编辑 wrapper
  映射；输出区在任意 role 增加两类 orphan sidecar repair alert，有效 wrapper 映射仍仅 aggregator
  可编辑；占用 orphan key 必须先显式修复。
- `AgentForm` Ports 面板去默认 Field 嵌套；Advanced 原始 `outputWrapperPortNames` JSON 块退役；
  五 tab、keep-mounted、badge 不动。
- `AgentForm` 显示 T1 detailed repair summary；`agents.new.tsx` / `agents.detail.tsx` 同步调用 T1 纯
  函数禁用 Create/Save，并在 header 下显示 compact 原因；锁 import 与 normal→aggregator 旁路，
  修复后即时恢复。
- `agent-md.ts` 将既有 `inputs/outputs/outputKinds/role/outputWrapperPortNames` 按共享 schema 路由到
  一等 partial；`AgentImportDialog` 补 Ports/Advanced 预览与 overwrite；bad shape 保留 extra + warning，
  reserved extra 由 T1 页面门禁阻断，避免 backend 保存后再提升。
- focus handoff：以 index refs 完成 add/edit save、cancel、删除 next/prev/add，兼容 duplicate name。
- 适配 `AgentForm-inputs`、`OutputsEditor`、`AgentForm-outputs-kind`、roundtrip、tab 与 import
  parser/preview/merge tests（特别锁 duplicate inputs 进入 partial 而非 extra、Create disabled/可 repair）；
  把旧 Backspace/源码实现锁改为行为锁。
- 依赖：T3。

### RFC-194-T5 — 输入 description 能力卡闭环

- shared `CapabilityInputPort.description` + `inputDescriptionBudget`（默认 600，总预算；单项最多
  160；0 兼容旧 Markdown 格式）；专用 clip 为省略号预留字符，返回长度严格不超剩余预算；
  `perCardInputDescriptionBudget` 公平分配 roster 总预算。
- workgroup 现有 card renderer 传总 2,400/单卡 240；orchestrator 传总 4,800/单卡 600；只改 option，
  不丢 card、不改 bodyMd promptBudget/ACL/执行路径。
- Markdown renderer 加有界 description，端口 name/kind/required 永不因预算消失。
- frontend `AgentCapabilityCard` full 显示、compact 隐藏 description。
- 测试：model/trim/budget/compact/prompt isolation；既有 leader/orchestrator/workgroup 能力卡测试
  全绿；64 卡 description 总量硬上界且所有 card 身份/type 保留。
- 依赖：T4（数据编辑面先成立；代码可并行开发但同 PR 合并顺序在后）。

### RFC-194-T6 — 样式、i18n、响应式与死选择器清理

- `.agent-port-*` namespace；复用 card/form/dialog/button tokens；desktop 多卡可扫读、<=720px
  单列、长名称/path+list 不溢出、44px 窄屏操作目标。
- 删除无 DOM 调用方的 `.inputs-editor__kind/.outputs-editor__kind` 等旧规则；重写
  `outputs-editor-overflow.test`，不再只匹配死 CSS。
- zh/en section/add/edit/delete/empty/legacy/duplicate/orphan/warning/wrapper/description/kind 文案；
  修正数字与首字符校验文案；删除旧 composer placeholder key；跑 i18n symmetry。
- 注意保留当前工作树已有的 styles/i18n hunks，按最小邻域编辑。
- 依赖：T4、T5。

### RFC-194-T7 — e2e、视觉验证与总门禁

- Playwright keyboard：Add/Edit/ESC/Save/Delete/focus handoff。
- Ports tab + Dialog axe。
- 390px 2 input + 2 path/list output 压力态：无 horizontal overflow，操作全可见。
- dev server 实景 light/dark/desktop/narrow，与 Basics/Resources tab 对齐；按需刷新 agents visual
  baseline。
- 全门禁与 binary smoke；实现后再做一次 Codex 对抗实现门，finding 折入再重跑。
- 依赖：T6。

## 验收映射

| AC | 任务 | 主要测试 |
|---|---|---|
| AC-1 语义分区 | T4/T6 | AgentForm DOM + a11y |
| AC-2 卡片摘要 | T3/T4/T6 | PortCard render + visual |
| AC-3 显式添加/空态 | T3/T4 | Inputs/Outputs behavior |
| AC-4 Dialog 编辑 | T3/T4 | dialog focus/save/cancel/validation |
| AC-5 安全重命名 | T1/T4 | pure helper + integration |
| AC-6 安全删除 | T1/T3/T4 | sidecar cleanup + focus + backend clear persistence |
| AC-7 description 闭环 | T4/T5 | roundtrip + shared renderer + UI |
| AC-8 aggregator 映射 | T1/T3/T4 | aggregator/normal + old raw editor absent |
| AC-9 KindSelect | T1/T2/T3 | grammar + descriptions + local/global validity |
| AC-10 a11y | T2/T3/T7 | role/name/error/focus/two-level Escape + axe |
| AC-11 响应式 | T6/T7 | 390px overflow + screenshots |
| AC-12 wire 兼容 | T1/T4/T5 | draft/PUT/service/import/badge/legacy fixtures |

## PR 与提交

默认单 PR，建议按任务形成可审 commit：

1. T1 + T2：纯 helper / 共享控件兼容扩展；
2. T3 + T4：端口 UI 主体；
3. T5：能力卡 description；
4. T6 + T7：样式/i18n/e2e/视觉收口。

若评审要求拆 PR，只能拆成 PR-A（T1/T2/T3 原语，不接生产入口）与 PR-B（T4-T7 接线）；PR-A
不得单独宣称用户功能完成。

## 实施门槛

批准后实施，完成前至少运行：

```bash
bun run typecheck
bun run lint
bun run test
bun test packages/shared/tests
bun run --filter @agent-workflow/frontend test
bun run format:check
bun run build:binary
```

此外运行聚焦 frontend 测试与 Playwright Ports 用例。任何红 case 必须定位，不能以“重跑通过”
替代分析；push 后按 SHA 查 CI。

## 用户批准门

本 RFC 三件套落档后停止在设计门。只有用户明确批准 RFC-194 后，才开始 T1 生产代码。
