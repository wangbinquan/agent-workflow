# RFC-264 · 技术设计

关联 proposal：[proposal.md](./proposal.md)

## 1. 规则定义（单一事实源）

新模块 `packages/shared/src/schemas/resourceName.ts` 承载**唯一**的人类可读名规则。既有导出名 `WORKGROUP_NAME_RE` / `WORKFLOW_NAME_RE` 保留为它的再导出别名（`packages/frontend/tests/workflows-pages.test.tsx:235` 的同一对象锁继续成立，且所有既有 import 站点零改动）。

### 1.1 归一化管线（顺序即语义）

```ts
export function normalizeResourceDisplayName(raw: string): string {
  return raw
    .normalize('NFC')          // ① 等价码点统一（纯汉字为恒等变换）
    .replace(/\p{Zs}/gu, ' ')  // ② NBSP U+00A0 / 全角空格 U+3000 等统一成半角空格
    .replace(/ {2,}/g, ' ')    // ③ 连续空格折叠
    .trim()                    // ④ 去首尾空白（含粘贴带来的首尾 \n / \t）
}
```

四步都是幂等的，`normalize(normalize(x)) === normalize(x)`（测试断言）。

- ① 只做 **NFC**，不做 NFKC——NFKC 会把「（重构）」的全角括号折成半角，属于对用户输入的实质改写（proposal §3 非目标）。
- ② 放在 ③ 之前：否则「审计　　流程」（两个全角空格）折不掉。
- ④ 在 ② 之后：`\t` / `\n` 是 `\p{Cc}` 而非 `\p{Zs}`，不会被 ② 换成空格，因此**内部**换行会活到校验期并被拒绝；只有**首尾**的换行被 `trim()` 吃掉（粘贴场景，友好）。

### 1.2 校验（作用于归一化后的值）

```ts
export const RESOURCE_DISPLAY_NAME_RE =
  /^(?!_)[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]{1,128}$/u
```

| 片段 | 拒绝什么 | 为什么 |
| --- | --- | --- |
| `(?!_)` | 以 `_` 开头 | 保留 `__agent_host__`（`services/agentLaunch.ts:56`）/ `__workgroup_host__`（`services/workgroup/constants.ts:16`）这一族框架内建形态，避免用户行在 UI 里混进系统行 |
| `\p{Cc}` | 控制符（含 `\t` `\n` `\r`） | 多行粘贴不该被静默拼成一行；控制符进日志 / 终端有转义风险 |
| `\p{Cf}` | 格式符（零宽 U+200B、RTL override U+202E 等） | 不可见字符做的"同名"是纯粹的迷惑面 |
| `\p{Cs}` | 孤立代理项 | 只能来自按 UTF-16 单元截断的 bug（§4.2 修的正是它） |
| `\p{Co}` | 私用区 | 无跨环境含义，渲染取决于装了什么字体 |
| `\p{Zl}` `\p{Zp}` | 行 / 段分隔符 | 同 `\p{Cc}` 的理由 |
| `{1,128}` + `u` flag | 空名、超 128 | **`u` flag 下量词按码点计数**，所以上限是 128 个**字符**（纯汉字即 128 字），而不是 128 个 UTF-16 单元 |

未在黑名单里的一律放行：汉字、假名、谚文、拉丁字母（含大写）、数字、半角空格、`-_.·/（）：，、` 等标点、emoji。

### 1.3 zod 入口

```ts
export const ResourceDisplayNameSchema = z.preprocess(
  (v) => (typeof v === 'string' ? normalizeResourceDisplayName(v) : v),
  z.string().min(1, 'name is required').regex(RESOURCE_DISPLAY_NAME_RE, RESOURCE_DISPLAY_NAME_MSG),
)
```

- `z.preprocess` 在 zod 3.23.8 上返回 `ZodEffects<ZodString>`，`.optional()` 可链——`packages/shared/src/schemas/scheduledTask.ts:103` 的 `WorkgroupNameSchema.optional()` 继续编译。
- 归一化在 **parse 时**发生，所以每一条走 schema 的写入路径自动拿到归一化后的值，无须在各 service 里手动调用。
- 长度上限交给正则（码点计数），不再叠一层 UTF-16 的 `.max(128)`——两套判据对 emoji 名会给出矛盾结论。

`WorkgroupNameSchema` / `WorkflowNameSchema` 改为 `ResourceDisplayNameSchema` 的别名，保留原导出名。

## 2. 改动面清单

### 2.1 shared

| 位置 | 改动 |
| --- | --- |
| `schemas/resourceName.ts`（新） | §1 全部内容 + `RESOURCE_DISPLAY_NAME_MAX = 128` |
| `schemas/workgroup.ts:63-69` | `WORKGROUP_NAME_RE` / `WorkgroupNameSchema` 改为再导出别名；删掉本地正则与旧文案 |
| `schemas/workflow.ts:360-365` | 同上；`:351-359` 的注释块更新为 RFC-264 语义（别名关系与 grandfather 规则保持） |
| `index.ts` | 导出新模块（保持既有导出名不变） |

**不动** `WorkflowDraftSnapshotSchema.name`（`schemas/workflow.ts:325`）：它是 `.min(1).max(256)` 的宽松存量通道，注释明说"Preserve grandfathered names during autosave"。在它上面加归一化会改变 `workflowSnapshotHashOf` 对**存量行**的哈希（`services/workflow.ts:866-872`），进而影响 OCC 比对——归一化只应发生在名字被**新建 / 改动**时（§2.2）。

### 2.2 backend

| 位置 | 现状 | 改动 |
| --- | --- | --- |
| `services/workflow.ts:345` | `normalizeWorkflowSnapshot(parsed.data.snapshot)` | 在此处对 `snapshot.name` 应用 `normalizeResourceDisplayName`，**先于** `:347` 的 `serializeWorkflowEditableSnapshotV1` 取字节——否则落库名与 receipt 哈希不一致 |
| `services/workflow.ts:961-971` | `assertChangedWorkflowName` 文案写死"must start with [a-z0-9]" | 文案改为新规则描述；判据不变（`current === submitted` 早退，只校验改动过的名） |
| `services/workflow.yaml.ts:104-114` | 导入名校验 + 同一段旧文案 | 同上；`WorkflowNameSchema` 自带归一化，导入的中文名落库前即归一 |
| `services/workgroups.ts:277-278` | `nextResourceCopyName` + `WorkgroupNameSchema.parse` | 无需改（复制名生成由 §2.2 的 `resourceCopyName` 修好后自然合法） |
| `services/resourceCopyName.ts` 全文 | `normalizeCopyBase` 用 `toLowerCase()` + `[^a-z0-9_-]+ → '-'`；`copyCandidate` 用 `base.slice()` | ①`normalizeCopyBase` 换成 RFC-264 归一化 + 去首尾 `-_` + 去前导 `_`（保底 fallback 逻辑不变）；②截断改 `[...base].slice(0, max).join('')` |
| `services/intent/intentDoc.ts:139` | 通用规则写死 `name` 必须是 `^[a-z0-9][a-z0-9_-]*$` | 拆成两条：workflow / workgroup 可用任意可读文本（中文优先跟随用户语言）；agent / skill / mcp / plugin 仍 slug |
| `schemas/intentChangeset.ts` 的 `IntentWorkflowPayloadSchema` / `IntentWorkgroupPayloadSchema` / `validateFinalNameForType` | **第三套**私有名称规则（`z.string().min(1).max(200)` + 只禁控制符） | 接进 `ResourceDisplayNameSchema` / 共享判据。这些 op 直写行（`applyChangeset.ts` 的 `insertWorkflowInTx` 不经 `CreateWorkflowSchema`），更松的语法能铸出产品其它地方表达不了的名字（`_` 前缀的框架行形态、超 128 码点）|

**`resourceCopyName` 的截断是本 RFC 顺带修的既有 bug**：`base.slice(0, maxBaseLength)` 按 UTF-16 单元切，遇到代理对（emoji / 扩展汉字）会切出**孤立代理项**。今天 ASCII-only 的名字掩盖了它；放宽后它会产出被 §1.2 `\p{Cs}` 拒绝的名字，让"复制"直接 500。实测确认：`[...s].slice()` 正确，`s.slice()` 产出的尾串被新正则拒绝。

**不改**：`services/intent/applyChangeset.ts:227` 与 `resolveChangeset.ts:482` 的占位判重用 `name.toLowerCase()`。对汉字是恒等；对新放行的大写字母它会把 `MyFlow` 判成与既有 `myflow` 冲突——方向保守（宁可不建近重复），且它只是 AI 生成路径的护栏，不是 DB 约束。登记在此，不动。

### 2.3 frontend

| 位置 | 改动 |
| --- | --- |
| `lib/workflow-form.ts:31-35` | `workflowNameError` 先归一化再判：归一后为空 → `nameRequired`；正则不过 → `nameInvalid` |
| `lib/workgroup-form.ts:56-59` | 同构改动 |
| `routes/workgroups.detail.tsx:625,1041` | 改名 / 复制的 `canSave` 判据改用共享校验（去掉本地 `length <= 128 && RE.test()` 的手写组合） |
| `routes/workgroups.detail.tsx:997,1030` | **删除** `namePattern={WORKGROUP_NAME_RE.source}`（proposal B-3） |
| `components/NameDescriptionFields.tsx:28,44,59` · `components/RenameDialog.tsx:29,54,99` | 删除随之失去唯一调用方的 `namePattern` prop（CLAUDE.md：删除优于 deprecate） |
| `lib/workflow-draft-export.ts:21,38` | 文件名 sanitizer 改为只替换文件系统敌意字符，保留中文（§3） |
| `lib/resource-option-label.ts` | 新增 `buildResourceOptionLabels`（§4） |
| 五处选择器 | 接入 §4：`routes/tasks.new.tsx:778-813`、`canvas/inspector/CallWorkflowEdit.tsx`、`canvas/inspector/CallWorkgroupEdit.tsx:134-140`、`workflow-editor/WorkflowStarterDialog.tsx:334`、`webhooks/TriggersPanel.tsx:781-790` |
| `i18n/zh-CN.ts` · `i18n/en-US.ts` | `workflows.fieldNameHint` / `workgroups.fieldNameHint`（两者必须逐字一致，既有 parity 测试锁）、两处 `errors.nameInvalid`、`errors['workflow-name-invalid']` |

## 3. 派生文件名

`lib/workflow-draft-export.ts` 今天用 `replace(/[^a-zA-Z0-9_-]+/g, '-')`，中文名整段被折成 `-`、再被 `^-+|-+$` 剥光，最终落到 `'workflow'` 兜底——中文名工作流下载下来全叫 `workflow.yaml`。改为**只**剔除文件系统敌意字符：

```ts
function safeDownloadBaseName(name: string): string {
  const cleaned = normalizeResourceDisplayName(name)
    .replace(/[/\\:*?"<>|]/g, '-') // POSIX 路径分隔 + Windows 非法字符
    .replace(/\p{Cc}/gu, '-') // 控制符（归一化只 trim 首尾，内部由此兜底）
    .replace(/[. ]+$/, '') // Windows 不允许尾部点 / 空格
  return cleaned === '' ? 'workflow' : cleaned
}
```

`<a download>` 属性对 UTF-8 文件名在 Chrome / Firefox / Safari 均正常（本路径不经 HTTP 头，所以没有 RFC 5987 编码问题）。服务端导出走的是 `content-disposition: filename="<ULID>.yaml"`（`routes/workflows.ts:411`），本 RFC 不动。

Windows 保留设备名（`CON` / `PRN` / `NUL` …）不处理——需要用户刻意把工作流命名成 `CON` 才会撞上，且后果只是浏览器保存失败，登记不做。

## 4. 选择器 ID 后缀消歧

`lib/resource-option-label.ts` 今天是四行的单一事实源，注释即目标——"Keep duplicate resource names distinguishable without making names identity"，当前手段是追加 ` · owner`。本 RFC 在**同一模块**里加第二层：

```ts
export interface ResourceOptionRow { id: string; name: string; owner?: string }

/** 同一下拉内 `name · owner` 撞车时，给撞车的每一行追加 ID 后 6 位。 */
export function buildResourceOptionLabels(
  rows: readonly ResourceOptionRow[],
): ReadonlyMap<string, string>
```

规则：

1. `base = resourceOptionLabel(name, owner)`（既有函数，不改）。
2. 统计 `base` 的出现次数；只出现一次 → label 就是 `base`（**绝大多数下拉一个后缀都不会多出来**）。
3. 出现 ≥2 次 → 这些行各自变成 `` `${base} · #${id.slice(-6)}` ``。

ID 后 6 位取 ULID 尾段——ULID 是 10 位时间戳 + 16 位随机（80 bit），末 6 位落在随机段（30 bit），同一下拉的候选量级下重复概率可忽略。定长 6 位，不做"撞了再扩位"的自适应（过度设计）。

纯函数、无 React 依赖，单测直接覆盖三种形态：无撞车 / owner 能区分 / owner 也相同。

## 5. 失败模式

| 场景 | 行为 |
| --- | --- |
| 名字归一后为空（全空白 / 只有零宽字符 + 空格） | `nameRequired`（前端）/ `name is required`（后端 422） |
| 内部含换行、制表符、零宽、RTL override | `nameInvalid` / `workflow-name-invalid` 422。**不静默清洗**——静默清洗会让"我明明粘了三行"变成一行还不报错 |
| 129 个汉字 | `nameInvalid`（正则码点计数） |
| 以 `_` 开头 | `nameInvalid`。存量内建行（`__agent_host__` / `__workgroup_host__`）是绕过 schema 直插的（`services/agentLaunch.ts:75`、`services/workgroup/launch.ts:142`），不受影响 |
| 同 owner 建重名工作组 | 既有 `workgroups_owner_name_unique` 冲突路径不变（`services/workgroups.ts:299` `isOwnerNameUniqueViolation`）。归一化让"多打一个空格就绕过唯一约束"不再可能 |
| 工作流重名（合法） | 既有确定性解析不变：最老 ULID first-wins（`services/workflow.validator.ts:216-220`）。UI 侧由 §4 的 ID 后缀让用户看清选中的是哪一个 |
| YAML 里写了未归一化的名字（如 macOS 编辑器产出的 NFD 拉丁字母） | 导入时 `WorkflowNameSchema` 归一化后落库；`call-workflow` 的 `workflowName` 选择器仍按字节比对，若 YAML 里的引用名与被引用行的归一化名不一致 → 既有 `call-workflow-ref-missing` 失败闭合（不是新失败模式，且导入 / 编辑器下拉写入的名字都来自归一化后的行） |
| 带首尾空格的存量名（2026-07-10 前遗留） | 下次保存被归一（proposal B-2）。归一前它在 `deleteConfirm.ts:60` 的逐字节比对下**无法删除**（UI 会 trim 用户输入），归一化是净修复 |

## 6. 测试策略

按 CLAUDE.md「Test-with-every-change」，下列 case 必写、必绿。

### shared —— `packages/shared/tests/resource-display-name.test.ts`（新）

- **字符集矩阵**：`代码审计流水线` / `审计 Pipeline v2` / `Code Review（重构专用）` / `my-workflow` / `emoji🎯名` → 通过；`''` / `'   '` / `_foo` / `__workgroup_host__` / `a\nb` / `a\tb` / 含 U+200B / 含 U+202E / 含孤立代理项 / 129 汉字 → 拒绝。
- **归一化矩阵**：`'代码审计 '`→`'代码审计'`；`'审计　Pipeline'`（U+3000）→`'审计 Pipeline'`；`'审计  流程'`→`'审计 流程'`；`'审计\n'`→`'审计'`；纯汉字 NFC 恒等。
- **幂等**：`normalize(normalize(x)) === normalize(x)` 覆盖上述全部输入。
- **码点计数**：128 汉字通过、129 汉字拒绝；128 个 emoji（256 UTF-16 单元）通过——锁死"上限按码点不按 UTF-16 单元"。
- **别名不许漂移**：`WORKFLOW_NAME_RE === WORKGROUP_NAME_RE === RESOURCE_DISPLAY_NAME_RE`（既有 `workflows-pages.test.tsx:235` 之外再加一条在 shared 侧）。
- **schema 归一化生效**：`WorkgroupNameSchema.parse('代码审计 ')` 返回 `'代码审计'`；`.optional()` 可链（编译期即锁 `scheduledTask.ts:103`）。

### backend

- `resourceCopyName`：中文名 → `代码审计流水线-copy` / `-copy-2`；**代理对截断回归**（128 上限附近的 emoji 名，断言结果不含孤立代理项且能通过 `RESOURCE_DISPLAY_NAME_RE`）——顶部注释写明这条锁的是 §2.2 的 `slice` bug。
- `workflows.test.ts`：中文名 create 成功；改名成中文成功；**未改动的存量自由格式名照常保存**（grandfather，既有断言不改判）；非法名 422 且 code 为 `workflow-name-invalid`。
- `workflow.yaml`：中文 `name` 导入成功；含换行的 `name` 422。
- `workgroups`：中文名 create / rename / copy 成功；同 owner 重名 409；`'代码审计 '` 与 `'代码审计'` 视为同名（归一后撞唯一索引）。
- `intentDoc`：源码文本断言——提示词含工作流 / 工作组可用中文名的表述，且仍对 agent/skill/mcp/plugin 声明 slug 规则。

### frontend

- `workflow-form` / `workgroup-form`：与 shared 同一矩阵的 `nameRequired` / `nameInvalid` 判定；`'   '` → `nameRequired`（不是 `nameInvalid`）。
- `workflow-draft-export`：中文名 → `代码审计流水线-unsaved.yaml`；含 `/` 的名 → 被换成 `-`；空兜底 → `workflow.yaml`。
- `resource-option-label`：无撞车不加后缀；owner 可区分不加后缀；name+owner 全同 → 两行各带自己的 ID 后 6 位。
- **源码层兜底断言**：`namePattern` 不得再出现在 `workgroups.detail.tsx` / `RenameDialog.tsx` / `NameDescriptionFields.tsx`（锁 B-3 不被回退）。
- i18n：既有 hint parity 测试（`workflows-pages.test.tsx:826-830`）继续绿；新文案不含 "URL" / "小写" / "lowercase" 字样。

### e2e

- `e2e/workflow-editor.spec.ts`（或新 spec）：UI 里用中文名建工作流 → 重命名弹窗改成另一个中文名 → 列表与画布标题显示中文名。

## 7. 与既有机制的耦合点复核

| 机制 | 是否受影响 | 依据 |
| --- | --- | --- |
| REST / 前端路由 / 导出响应头 | 否 | 全用 ULID（proposal §1 表） |
| worktree 路径 / git 分支名 | 否 | `util/git.ts:941,969` 用 repo-slug + task ULID |
| 内建行识别与只读锁 | 否 | `systemResources.ts:45-48` 键在 `builtin` 列 |
| 工作组成员 → 代理绑定 | 否 | RFC-223 已 ID 化（`schemas/workgroup.ts:114`） |
| `call-workflow` / `call-workgroup` 选择语义 | 否 | 名字仍是权威选择器，只是字符集变宽；解析与冻结闭包逻辑不变 |
| 定时任务 `workgroupName` | 否 | 由服务端从组行回填（`services/scheduledTasks.ts:322,392`），不是用户输入 |
| 脚本节点 env / prompt 变量 | 否 | 名字不进 `AW_*` env，也不是 `{{}}` 变量 |
| 备份 / 恢复 | 否 | 按行搬运，无名字解析 |
| YAML 序列化 | 否 | `stringifyYaml`（`shared/workflow-yaml.ts:81`）对 UTF-8 原样输出，必要时自动加引号 |
