# RFC-150 · 前端 Segmented/TabBar 公共原语 + W0 收口补做（proposal）

- **状态**：Draft（G3-G10 批量授权第 6 弹，设计门后直接实现）
- **来源**：`design/flag-audit-2026-07-07.md` §4.6（RFC-G8）
- **前期调研**：单路 fan-out 全景（W0 核对 + 11+2 segmented / 12+5 tabs / ConfirmButton
  16 调用点 / 组件规程样板 / 测试锁矩阵 / 分批风险评估）。**W0 核对结论**：
  noderunTone 与任务终态集合已收口 ✅；裸 status-chip span（15 处）与
  TaskStatusChip/describeStatus 双 i18n 键族仍未修 → 本 RFC 补做。

## 1. 背景

`.segmented` 与 `.tabs` 只有 CSS 没有组件：11 处手搓 segmented（AclPanel 已漂移出
role=group 无 aria-checked 的 a11y 病；LanguageSwitch 整块 CSS fork）+ 12 处规范
tabs 手搓（其中 5 处无 role=tab/aria-selected）+ ≥5 个 fork 命名空间
（inbox-drawer/auth-tabs/worktree-diff/structure 文件树/diff-mode-segmented）
= 视觉参数多个平行真相源，新页面必然再抄一份。ConfirmButton 的 `danger` 布尔
16 调用点 14 处传字面量。另有 §4.6 两项 W0 未完成：裸
`status-chip status-chip--X` span 15 处绕过 `<StatusChip>`；home/task-row 的
describeStatus 与 TaskStatusChip 是同枚举两套 i18n 键族。

## 2. 目标

1. **`<Segmented>` 原语**（components/Segmented.tsx）：options 表驱动
   `{value,label,disabled?,title?,shortcut?,testid?}`、固化
   radiogroup/radio/aria-checked（10/11 现场的既有正确形态）、`data-*` 透传、
   ChipsInput 式可选 `testidPrefix`、kbd shortcut slot（clarify.detail 需要）。
2. **`<TabBar>` 原语**（components/TabBar.tsx）：tabs 表驱动
   `{key,label,badge?,testid?}`、tablist/tab/aria-selected 内建（迁移即免费补齐
   5 处缺失 a11y）、`variant: 'default'|'inline'|'inspector'|'segment'`（对应既有
   CSS modifier）、badge slot（tasks.detail 问题数徽标）。
3. **分批迁移**：PR-2 纯机械批（Segmented 8 + TabBar 7，含 memory-all `tabs--pills`
   幽灵 modifier 顺带修正）；PR-3 中风险族（NodeInspector/NodeDetailDrawer/
   RepoSourceRow/tasks.detail 主 tab + AclPanel a11y 修正 + ClarifyDirectiveToggle
   - clarify.detail shortcut 场景）——受影响源码级 grep 锁改写为组件断言。
4. **W0 补做**：15 处裸 status-chip span → `<StatusChip>`；describeStatus 键族并入
   `tasks.status.*` 单键族。
5. **ConfirmButton**：`danger` 布尔 → `variant?: 'danger'|'default'`（对齐 .btn--\*
   枚举；16 调用点机械迁移）。

## 3. 非目标

- **高风险长尾不入本 RFC**：roving-tabindex 文件树 tab（WorktreeDiffPanel/
  StructuralDiffView——vertical roving 是另一原语形态）、InboxDrawer（焦点 ref）、
  auth-tabs（含 tabpanel 配对）、diff-mode-segmented（tab 语义/segmented 视觉的
  定性冲突）、LanguageSwitch（乐观 mutation 强锁、纯样式 fork 收益低）——登记
  遗留清单，随后续需要单独迁。
- listbox 族（TaskOutputPanel/Select/UserPicker）非 tab，排除。
- 不动 .tabs/.segmented CSS 视觉参数（原语复用既有 class，不内联化）。
- fusions.detail 手抄状态集合非 TaskStatus 族，不属终态收口。

## 4. 验收标准

1. 两原语落地（规程对齐：BEM 命名空间 + testidPrefix + 单测 + a11y 完备），
   迁移面 role/aria 行为锁（clarify-directive radio / structure-view 等真行为锁）
   零改动全绿；受影响 grep 锁改写为组件断言。
2. 纯机械批 + 中风险批合计 Segmented 10/11、TabBar 11/12 迁移完成（遗留清单
   显式登记）；AclPanel a11y 漂移修正（group→radiogroup+aria-checked）。
3. W0 补做：裸 span 清零（status-chip-grep 棘轮扩展）；`home.taskRow.status*`
   键族删除、describeStatus 改读 `tasks.status.*`。
4. ConfirmButton variant 化 + 16 调用点迁移。
5. 门禁 + CI conclusion=success + Codex 双门收敛。
