# RFC-197 — Agent `agent.md` 导入体验重构：技术设计

> 状态：Done（用户批准后已完成实现与本地验收）
> 关联：[产品提案](./proposal.md) · [实施计划](./plan.md)

## 1. 现状与不变量

### 1.1 当前调用链

```text
/agents/new
  └─ AgentImportDialog
      ├─ File.text() / paste raw string
      ├─ parseAgentMarkdown(raw, { filenameStem })
      ├─ structureImportWarnings(result.warnings)
      ├─ fieldsOverwrittenByImport(currentDraft, result, emptyAgent())
      ├─ importOrphanSidecarConflicts(currentDraft, result)
      └─ onApply(result)
          └─ mergeAgentImport(previousDraft, result)
```

`parseAgentMarkdown` 在 shared 内同步、纯函数、no-throw；`onApply` 只修改 React draft，真正创建仍由页面
`POST /api/agents` 完成。本 RFC 只重构 `AgentImportDialog` 内部任务流和展示，不改变这条数据链。

### 1.2 必须保持的行为

- 入口只在 `/agents/new`，详情 / 编辑页不出现。
- name 优先级仍是 `frontmatter.name > upload filename stem > undefined`；粘贴不从任何虚构文件名补 name。
- partial 中有值的字段覆盖当前 draft；未出现字段保留；`frontmatterExtra` 浅合并。
- blocking YAML warning 继续禁止应用；warning 的 `{code,message,blocking}` 结构化适配继续由
  `structureImportWarnings` 单源负责。
- RFC-194 orphan sidecar conflict 继续 fail closed；不允许 outputs-only import 暗中认领旧 orphan mapping。
- 导入出的 duplicate / legacy 端口仍进入 AgentForm 的统一 repair / Create 门禁，不在 dialog 私造第二套端口 validator。
- 不发 backend 请求、不自动创建、不改变 dirty baseline；写入 draft 后页面 dirty guard 自然生效。

## 2. 组件结构

```text
AgentCreatePage
├─ Import trigger (explicit ref)
├─ AgentForm (controlled activeTab)
└─ AgentImportDialog
   ├─ Dialog (shared chrome/focus trap/footer)
   ├─ SelectPhase
   │  ├─ TabBar<upload|paste>
   │  ├─ FileDropzone | Field + TextArea
   │  └─ source facts + Check action
   ├─ ReviewPhase
   │  ├─ source summary + Back/replace
   │  ├─ StatusChip summary
   │  ├─ ErrorBanner / warning Card / overwrite Card
   │  ├─ EmptyState | PreviewSection Card[]
   │  └─ Back + Apply-to-draft footer
   └─ ResultPhase
      ├─ stable result heading
      ├─ count chips + affected-section list
      └─ Import another + View form footer
```

沿用 shared `Dialog size="lg"`，移除 `panelClassName="agent-import__panel"`；panel 宽高、滚动 body、固定
footer、ESC、overlay click 与 focus trap 全由公共组件负责。业务根只保留 `.agent-import` 命名空间。

## 3. 状态模型

### 3.1 类型

```ts
type AgentImportSourceTab = 'upload' | 'paste'

interface AgentImportSourceDraft {
  active: AgentImportSourceTab
  uploadFile: File | null
  pasteText: string
  selectionError: string | null
}

interface AgentImportSourceSnapshot {
  kind: AgentImportSourceTab
  label: string
  rawText: string
  filenameStem?: string
}

type AgentImportPhase =
  | {
      kind: 'select'
      source: AgentImportSourceDraft
      busy: 'read-file' | null
    }
  | {
      kind: 'review'
      source: AgentImportSourceSnapshot
      sourceDraft: AgentImportSourceDraft
      parse: AgentMarkdownParseResult
      preview: AgentImportPreview
    }
  | {
      kind: 'result'
      sourceLabel: string
      appliedItemCount: number
      affectedSections: Array<{ tab: AgentTab; count: number }>
      firstAffectedTab: AgentTab
    }
```

`sourceDraft` 保留上传 File 与粘贴文本，让 review 返回 select 时输入仍在；`source` 是本次解析的不可变快照，
review 不会随着后台 prop 或 tab 改动偷偷换内容。result 只冻结用户需要的结果摘要，不继续持有大段 raw text。

### 3.2 转移表

| 当前          | 事件                       | 下一状态                  | 约束                                                                                           |
| ------------- | -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| select        | 切 upload / paste          | select(active changed)    | 两种来源内容各自保留；清当前 selectionError                                                    |
| select/upload | choose/drop valid          | select(file replaced)     | `.md/.markdown` 大小写不敏感；input accept 不是安全边界                                        |
| select/upload | choose/drop invalid        | select(file null + error) | 不调用 `File.text()`                                                                           |
| select/upload | check                      | busy=read-file → review   | 读文件、提 filename stem、parse；读取期间 dropzone / tabs / close-action 外的业务按钮 disabled |
| select/paste  | check                      | review                    | `pasteText.trim()` 为空时按钮 disabled；filenameStem 不传                                      |
| select        | file read reject           | select(same file + error) | catch unknown，不产生 unhandled rejection，可原文件重试或替换                                  |
| review        | back / replace source      | select(sourceDraft)       | 旧 parse / preview 不再可 Apply                                                                |
| review        | apply, allowed             | result                    | 先冻结 summary，再且只调用一次 `onApply(parse)`                                                |
| review        | apply, blocked/empty       | review                    | 按钮 disabled；handler 仍二次 guard                                                            |
| result        | view form / X / ESC        | dialog closed             | 已应用 draft 保留，不回滚；result 没有“取消”措辞                                               |
| result        | import another             | fresh select(upload)      | 清 file/text/error/parse/result，聚焦 file choose                                              |
| 任意          | external close then reopen | fresh select(upload)      | reset + 读取 generation 失效                                                                   |

### 3.3 异步文件读取隔离

`File.text()` 不能 Abort，使用单调 generation：

```ts
const readGenerationRef = useRef(0)

async function checkUpload(file: File) {
  const generation = ++readGenerationRef.current
  setBusy('read-file')
  try {
    const rawText = await file.text()
    if (generation !== readGenerationRef.current || !open) return
    enterReview(rawText, filenameStem(file.name))
  } catch (error) {
    if (generation !== readGenerationRef.current || !open) return
    setSelectionError(readableMessage(error))
  }
}

function invalidateRead() {
  readGenerationRef.current += 1
}
```

close、replace、remove、reset 与组件 effect cleanup 都调用 `invalidateRead()`。即使旧 Promise 在关闭后 resolve，
也不能把 phase 从 fresh select 改回旧 review。

## 4. 来源选择阶段

### 4.1 Upload

复用 `FileDropzone`：

```tsx
<FileDropzone
  file={source.uploadFile}
  onFileChange={handleFileChange}
  accept=".md,.markdown,text/markdown,text/plain"
  disabled={phase.busy !== null}
  title={t('agentForm.importDialog.uploadTitle')}
  description={t('agentForm.importDialog.uploadDescription')}
  chooseLabel={t('agentForm.importDialog.chooseFile')}
  replaceLabel={t('agentForm.importDialog.replaceFile')}
  removeLabel={t('agentForm.importDialog.removeFile')}
  error={source.selectionError ?? undefined}
  buttonRef={sourceControlRef}
  data-testid="agent-import-file"
/>
```

feature 层纯函数：

```ts
type AgentMarkdownFileCheck = { ok: true; file: File } | { ok: false; reason: 'extension' }

function validateAgentMarkdownFile(file: File): AgentMarkdownFileCheck
```

- 文件名以 `.md` 或 `.markdown` 结尾，大小写不敏感；MIME 可能为空，不作为拒绝依据。
- 不新增大小上限；dropzone 仍显示 size，让异常大文件可被用户识别。
- filename stem 只在成功读取后进入 parser；`.markdown` 必须整段剥离，不能只去最后三个字符。

### 4.2 Paste

```tsx
<Field label={t('agentForm.importDialog.pasteLabel')} hint={...}>
  <TextArea
    value={source.pasteText}
    onChange={setPasteText}
    rows={10}
    monospace
    data-testid="agent-import-textarea"
  />
</Field>
```

不再直接渲染 `<textarea className="form-input">`。示例把已废弃为 agent 一等字段的 `model` 改成当前有效的
`runtime`，避免 UI 教用户制造 `frontmatterExtra.model`。

### 4.3 Footer

- secondary：取消；
- primary：`检查内容`，upload 无 file / paste trim 后为空 / busy 时 disabled；
- 读取中：primary 文案 `正在读取…` + `aria-busy=true`，按钮高度不变；
- “只填入草稿，仍需创建”从和按钮挤成一行的 hint，移到来源区的 compact fact / note，首屏始终可读。

## 5. Preview 单一派生层

新增 `packages/frontend/src/lib/agent-import-preview.ts`，组件不再在 render 内手拼路由表。

### 5.1 类型

```ts
export type AgentImportPreviewKind = 'text' | 'body' | 'list' | 'map' | 'json' | 'extra'

export interface AgentImportPreviewItem {
  id: string
  field: string
  kind: AgentImportPreviewKind
  summary: string
  detail?: string
}

export interface AgentImportPreviewSection {
  tab: AgentTab
  items: AgentImportPreviewItem[]
}

export interface AgentImportPreview {
  sections: AgentImportPreviewSection[]
  itemCount: number
  sectionCount: number
  firstTab: AgentTab | null
}

export function describeAgentImport(result: AgentMarkdownParseResult): AgentImportPreview
```

helper 不依赖 i18n；它产出结构化事实和稳定字段 id，组件用 i18n 映射 section / field labels。摘要中不写
“→ Ports”等展示词，去向由 section 结构本身表达。

### 5.2 路由表

```ts
const IMPORT_FIELD_TAB = {
  name: 'basics',
  description: 'basics',
  runtime: 'basics',
  bodyMd: 'prompt',
  inputs: 'ports',
  outputs: 'ports',
  outputKinds: 'ports',
  outputWrapperPortNames: 'ports',
  dependsOn: 'resources',
  mcp: 'resources',
  plugins: 'resources',
  role: 'advanced',
  permission: 'advanced',
} as const satisfies Record<AgentImportFirstClassField, AgentTab>
```

`frontmatterExtra` 特判为 Advanced，每个 own key 生成一项；空 object 不生成假项。section 顺序固定为 AgentForm
顺序：basics → prompt → ports → resources → advanced，空 section 不渲染。

parser 不支持 `skills` 作为一等 `agent.md` key，本 RFC 不擅自加入；现有 draft.skills 在 merge 时继续保留。

### 5.3 类型化摘要

| 类型                                | 摘要                   | 详情                                                      |
| ----------------------------------- | ---------------------- | --------------------------------------------------------- |
| name / description / runtime / role | 原字符串；视觉最多两行 | 完整字符串放 title                                        |
| bodyMd                              | `N bytes · M lines`    | 首个非空内容摘录，最多 160 字符；完整正文不塞 title       |
| inputs                              | `N input ports`        | `name · kind`，有 description 时追加短摘录                |
| outputs / dependsOn / mcp / plugins | `N items`              | 按原顺序 join，保留 parser 去重后的顺序                   |
| outputKinds / wrapper names         | `N mappings`           | `key → value` 列表                                        |
| permission                          | `N rules`              | 稳定 JSON（object insertion order）                       |
| frontmatterExtra key                | key + value type       | 该 key 的稳定 JSON / scalar；不能 stringify 时回落 String |

所有展示值均是只读摘要，不参与 Apply；Apply 永远用原始 `parse` 对象，避免把 UI 格式化结果反写数据。

## 6. Review 阶段

### 6.1 顶部摘要

- source identity：上传显示文件名 + size，粘贴显示“粘贴文本 · N bytes”；
- `StatusChip info`：识别 `itemCount` 项；
- `StatusChip neutral`：涉及 `sectionCount` 个分区；
- 有 warning 时 `StatusChip warn`；有 overwrite 时 `StatusChip warn`；
- “返回修改”是普通按钮，回 select 并保留输入。

### 6.2 错误与警告顺序

1. **blocking YAML**：共享 `ErrorBanner message={blocking.message}`；Apply disabled。
2. **orphan sidecar**：共享 `ErrorBanner`，message 列出 `source:key`；action 为“关闭并前往端口分区”，调用
   route callback 切换 `activeTab='ports'`。若 YAML 已 blocking，不重复渲染 orphan（保持当前优先级）。
3. **overwrite impact**：warning Card，显示 `fieldsOverwrittenByImport` 的 count 与字段 chips；不是系统错误，不用 danger。
4. **non-blocking warnings**：warning Card + 语义 `<ul>`，每条完整可折行；blocking 条目不重复进入列表。
5. **empty**：`preview.itemCount===0` 时渲染 `EmptyState`，提示返回补充来源；Apply disabled。

### 6.3 分组卡

每个非空 section 一张共享 `Card`：

```tsx
<Card
  className="agent-import__section"
  header={
    <>
      <h3>{sectionLabel}</h3>
      <StatusChip kind="neutral" size="sm">
        {count}
      </StatusChip>
    </>
  }
>
  <ul className="agent-import__items">...</ul>
</Card>
```

- field label 使用 monospace，value 是独立块；不再用 table column 表达路由。
- desktop 每项为 `minmax(140px, 0.34fr) minmax(0, 1fr)`；`<=560px` 改一列上下堆叠。
- section header 直接使用 AgentForm 的既有 tab i18n key，避免两套分区名称漂移。
- testid：`agent-import-section-${tab}` / `agent-import-item-${field-or-id}`，不得依赖 `<tr>/<td>` 结构。

### 6.4 Apply gate

```ts
const canApply =
  preview.itemCount > 0 && blockingWarning === undefined && orphanConflicts.length === 0
```

footer：secondary `返回修改`，primary `填入草稿（N）`。handler 再次检查 `canApply` 和 phase.kind，冻结
affected section summary 后调用 `onApply(parse)` 一次，再进入 result；不调用 `onClose`。

## 7. Result 阶段

### 7.1 内容

- focusable heading：`已填入 Agent 草稿`；
- description：`已从 {source} 填入 {N} 项，涉及 {M} 个分区。Agent 尚未创建。`；
- `StatusChip success` 显示 N 项，section chips 按 AgentForm 顺序列出各自 count；
- compact Card 提醒下一步：返回表单，检查端口 / 依赖校验，再点击页面「创建」。

这里的 success 只描述“写入 draft 这一步成功”，文案禁止出现“Agent 创建成功”。

### 7.2 动作与关闭语义

- secondary `重新导入`：fresh select，窗口保持打开，聚焦 FileDropzone choose；
- primary `查看并完成表单`：关闭 dialog，并由 parent 把 `activeTab` 切到 `firstAffectedTab`；
- X / ESC / overlay：关闭 dialog，保留 draft，Dialog 通过显式 `triggerRef` 把焦点还给导入按钮；
- result footer 不出现 `取消`，避免暗示关闭会撤销已应用内容。

`AgentImportDialog` 新增可选 callback：

```ts
interface AgentImportDialogProps {
  // existing
  onApply: (result: AgentMarkdownParseResult) => void
  // new
  triggerRef?: RefObject<HTMLButtonElement | null>
  onViewForm?: (tab: AgentTab) => void
}
```

`agents.new.tsx` 给 trigger 挂 `useRef`，`onViewForm` 先设置 `activeTab` 再关闭。Dialog 的 trigger focus restore 仍是
最终键盘焦点合同；切 tab 只改变下一屏内容，不用 querySelector 操纵 DOM。

## 8. 焦点与可访问性

- open/select/upload：`initialFocusRef` 指向 FileDropzone 真实 choose / replace button；
- 切 paste：TabBar 点击后不强抢焦点；键盘用户从 tab 自然前进到 textarea；
- select → review：effect 聚焦 review `<h3 tabIndex={-1}>`；
- review → select：聚焦当前来源的 choose button 或 textarea；
- review → result：聚焦 result heading；
- import another：聚焦新的 choose button；
- close：共享 Dialog `triggerRef` 恢复导入按钮；
- warning / result count 只在阶段转移时通过 heading / `aria-live=polite` 宣告，避免每次 currentValue render 重播；
- ErrorBanner 保持唯一 live alert；同一 blocking 信息不在 Field / list 重复 `role=alert`。

## 9. CSS 与响应式

删除 RFC-018 已退役样式：

- `.agent-import__overlay / __panel / __header / __close / __footer`；
- `.agent-import__tabs / __tab`；
- `.agent-import__upload / __filename / __textarea / __actions-row / __hint`；
- `.agent-import__warning / __overwrite / __warnings / __table / __field / __value / __route / __empty`。

新业务样式只负责内部布局：

```css
.agent-import,
.agent-import__phase,
.agent-import__sections,
.agent-import__items {
  min-width: 0;
}

.agent-import__item {
  display: grid;
  grid-template-columns: minmax(140px, 0.34fr) minmax(0, 1fr);
}

.agent-import__item-value,
.agent-import__warning-list li {
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .agent-import__item {
    grid-template-columns: minmax(0, 1fr);
  }

  .agent-import__source-summary,
  .agent-import__result-actions {
    align-items: stretch;
    flex-direction: column;
  }
}
```

- Dialog footer 在窄屏按钮可满宽 / 纵向，但 DOM 顺序保持 secondary → primary。
- paste textarea 使用 `min-height` + `max-height:min(36dvh, 280px)`，不再固定 14 rows 吃掉首屏；用户仍可 resize vertical。
- Card / StatusChip 的颜色沿用公共 token；不复制 RFC-196 的 Skill scoped palette，实际 axe 若发现对比度问题再做
  `.agent-import` 最小 scoped 修正并用 light/dark 证据锁定。
- 不需要像 `/skills/new` 隐藏 split rail：Agent 导入是 viewport portal Dialog，壳层不压缩弹窗；只验证 overlay/panel 自身几何。

## 10. i18n

重组 `agentForm.importDialog` zh/en 对称 key，保留仍有意义的稳定 key / test 文案，新增：

- phase/source：`selectTitle / selectDescription / tabUpload / tabPaste / uploadTitle / uploadDescription /
chooseFile / replaceFile / removeFile / invalidExtension / fileReadFailed / pasteLabel / pasteHint / checkButton /
checkingFile`；
- review：`reviewTitle / sourceUpload / sourcePaste / itemCount / sectionCount / warningCount / overwriteTitle /
overwriteDescription / warningTitle / previewEmptyTitle / previewEmptyDescription / backButton / applyDraftButton /
fixPortsButton`；
- section：复用 `agentForm.tabBasics / tabPrompt / tabPorts / tabResources / tabAdvanced`；
- values：`bodySummary / listSummary / mapSummary / inputSummary / ruleSummary / extraLabel`；
- result：`resultTitle / resultDescription / resultNextStep / importAnother / viewForm / notCreated`；
- common：`cancelButton`。

删除不再调用的 `selectedFile / parseButton / applyButton / previewEmpty / footerHint / bodySizeHint / routedTo.*`，并由
i18n symmetry test 锁 zh/en key 集一致。placeholder 的 `model:` 改为 `runtime:`。

## 11. 测试策略

### 11.1 纯函数

新增 `packages/frontend/tests/agent-import-preview.test.ts`：

1. full-surface parser fixture 覆盖 name/description/runtime/body/ports/resources/role/permission/extra，断言五 section
   顺序与每个字段唯一出现；
2. 显式锁 `runtime / dependsOn / mcp / plugins`，防当前漏预览回归；
3. body bytes/lines/excerpt，unicode 走 UTF-8 bytes；
4. arrays/maps/permission/extras 摘要与顺序；
5. empty partial → 0 item / null firstTab；
6. empty extra object 不造项，无法 stringify 的防御回落；
7. `validateAgentMarkdownFile`：md/markdown/大小写接受，txt/zip/无扩展拒绝。

### 11.2 Dialog 组件

扩写 `agent-import-dialog.test.tsx`：

- default upload 渲 FileDropzone；paste 渲共享 TextArea；源码 guard 禁 raw file/textarea/table；
- upload/paste 独立保留，当前来源才参与 parse；filename stem 规则不退化；
- File.text resolve/reject；close/replace 后迟到 resolve 不进入 review；
- select → review → back 保留输入；empty result Apply disabled；
- full-surface fixture 五 section 与 item 可见；不再依赖 role=row；
- YAML blocking、non-blocking warning、overwrite、orphan conflict 与 fix-ports callback；
- Apply 调用一次，保持 dialog open 并进入 result；result 明示 not created；
- import another reset；view form 带 first tab callback；close 后 fresh reopen；
- review / result heading focus，Dialog trigger focus restore。

### 11.3 路由与守卫

- `agents-split-page.test.tsx`：真实 merge 后 result → view form；duplicate ports 仍阻断 Create；orphan flow 零退化；
- `agents-new-import-button.test.tsx`：新 route 仍是唯一入口，triggerRef / onViewForm wiring；detail route 反向锁；
- `data-table-callsite.test.ts`：旧“AgentImportDialog 必须使用 data-table”正向锁改成“不得出现 table/data-table”；
- `dialog-grep.test.ts`：保留共享 Dialog 正向锁，新增旧 panelClassName / modal chrome 反向锁；
- `tabs-retrofit-grep.test.ts`：保留共享 TabBar 锁，更新已过期的“其余 agent-import CSS 等 cleanup PR”注释；
- `agent-import-warnings.test.ts` 与 shared parser tests 原样绿。

### 11.4 真浏览器

新增或扩展 Agent import Playwright 路径，至少覆盖：

- 1280×800 light：upload select、full review、overwrite warning、result；
- 1280×800 dark：full review、blocking error、result；
- 390×844：paste select、五 section review、long values、result；
- axe：select/review/result；
- keyboard：trigger → dialog initial focus → paste/parse → review back/apply → result → close，ESC 恢复 trigger；
- geometry：`document.scrollWidth===innerWidth`、panel/body/section `scrollWidth<=clientWidth`、footer buttons viewport 内；
- 迟到 file read 仍以 component test 为主，Playwright 不伪造 File.text timing。

## 12. 文件清单

预计新增：

- `packages/frontend/src/lib/agent-import-preview.ts`
- `packages/frontend/tests/agent-import-preview.test.ts`
- 可选独立 e2e spec（以实现时现有 fixture 组织为准）

预计修改：

- `packages/frontend/src/components/AgentImportDialog.tsx`
- `packages/frontend/src/routes/agents.new.tsx`
- `packages/frontend/src/i18n/{zh-CN,en-US}.ts`
- `packages/frontend/src/styles.css`
- `packages/frontend/tests/{agent-import-dialog,agents-split-page,agents-new-import-button}.test.*`
- `packages/frontend/tests/{data-table-callsite,dialog-grep,tabs-retrofit-grep}.test.ts`
- `design/RFC-197-agent-import-ux/{proposal,design,plan}.md`
- `design/plan.md`
- `STATE.md`

明确不修改：`packages/shared/src/agent-md.ts`、shared schema、backend、migration、API contract。

## 13. 失败模式

| 失败                             | UI / 状态                                           | 可恢复性              |
| -------------------------------- | --------------------------------------------------- | --------------------- |
| 非 md/markdown 文件              | dropzone inline alert；file 不保留                  | 重新选择              |
| File.text reject                 | select 原文件保留 + 可读错误                        | 重试检查或替换        |
| YAML parse failed                | review ErrorBanner；Apply disabled                  | 返回修改来源          |
| parser 只产 warning / 空 partial | warning + EmptyState；Apply disabled                | 返回修改来源          |
| orphan sidecar                   | review ErrorBanner；Apply disabled                  | 关闭并前往 Ports 修复 |
| legacy duplicate/invalid port    | 可填入 draft；AgentForm 统一 validation 阻断 Create | 在 Ports 修复         |
| 用户关闭 select/review           | 本次 import session 丢弃，draft 不变                | 重新打开              |
| 用户关闭 result                  | 已填入 draft 保留，尚未创建                         | 页面继续编辑 / 创建   |
| 读取 Promise 迟到                | generation 不匹配，静默忽略                         | 当前会话不受影响      |

## 14. 与并行 RFC-198 的落地顺序

RFC-198 同日以 Draft 形式提出全局 Dialog / TabBar / Form / responsive 基础收敛，并明确保持 RFC-190–197 的业务
语义。两者同时获批时默认 **RFC-197 先落**：本 RFC 先把 AgentImportDialog 变成纯公共原语消费方，RFC-198 再把它
纳入全局视觉 / mobile regression 矩阵。RFC-198 不吸收或改写本 RFC 的 parser、merge、三阶段与 not-created
语义。

如果 RFC-198 的 production work 已先触碰 `Dialog / TabBar / styles.css / agents.new`，RFC-197 开工前必须重读
live code 并调和到新公共 API；同一函数同一行冲突时暂停询问，不用旧 Draft 覆盖新实现。
