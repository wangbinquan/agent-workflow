# RFC-262 · 技术设计

## 1. 决策记录

| 编号 | 决策                                                                                                   | 来源 / 理由                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 策略是**作者级**字段，写在工作流定义的 upload 输入上；启动者不可改                                     | 用户拍板。随定义版本固定、YAML 可携带、可静态校验；不引入新的 wire 参数，MCP / webhook / 定时等无 UI 启动面无需定义默认值                                                           |
| D2   | 字段形状：`onConflict?: 'rename' \| 'overwrite'`，缺省 = `'rename'`                                    | 枚举而非 `overwrite: boolean`：一是默认行为（改名）在 UI 上必须能被显式看见——布尔开关的"关"读起来像"什么都不做"；二是将来若要加 `'error'`（同名直接拒）不必再破坏一次 wire        |
| D3   | 冲突目标是符号链接 → 删链接换真实文件；是目录 → 报错                                                   | 用户拍板。`unlinkSync` / `renameSync` 都作用于链接本体、不跟随，保住 RFC-107"绝不写穿已存在路径"的性质；覆盖一个目录无合理语义                                                     |
| D4   | 同批同名 → **启动校验期报错**（`upload-duplicate-filename`），对所有 upload 输入生效，跨 input key 判重 | 用户拍板（两问）。判重放进 `validateUploadPlan`，它在 `routes/tasks.ts:1435` 于 clone / worktree 物化**之前**被调用（RFC-107 既定次序）                                             |
| D5   | 覆盖**不做备份、不做内容回滚**                                                                         | 用户拍板 +代码事实：上传写盘抛错 → `routes/tasks.ts:1510` / `agentLaunch.ts:488` 调 `cleanupMaterializedSpace(space)` 删掉整棵 worktree 且不建任务行（返回 4xx）。被覆盖的是那棵注定要被删的 worktree 里的副本，源仓工作区从不被触碰 |
| D6   | 判重 key = 规范化 targetDir + sanitized 文件名，**整条路径大小写折叠**                                  | proposal §6 C2 **方案 A（用户已拍板）**。目录段同折叠：`Docs/` 与 `docs/` 两个输入在大小写不敏感 FS 上落进同一目录，是同一条静默丢文件的路径，只是高了一层                             |
| D7   | 判重逻辑落在 `@agent-workflow/shared` 的纯函数里，前后端共用                                           | CLAUDE.md「首选可断言面：抽出纯函数」；前端提交前即可提示，避免 200MiB 字节白跑一趟才 422                                                                                           |
| D8   | `$schema_version` 不变（保持 4）                                                                       | 新字段是 upload 输入上的可选项，旧文档原样读、旧读面不受影响；本仓既往同类字段（`accept` / `maxFileSize`）也未升版                                                                  |

## 2. 数据模型

`packages/shared/src/schemas/workflow.ts:192` `UploadInputSchema` 增一个可选字段：

```ts
export const UPLOAD_ON_CONFLICT = ['rename', 'overwrite'] as const
export const UploadOnConflictSchema = z.enum(UPLOAD_ON_CONFLICT)
export type UploadOnConflict = (typeof UPLOAD_ON_CONFLICT)[number]

export const UploadInputSchema = WorkflowInputSchema.extend({
  kind: z.literal('upload'),
  targetDir: /* 不变 */,
  accept: /* 不变 */,
  maxFileSize: /* 不变 */,
  minCount: /* 不变 */,
  maxCount: /* 不变 */,
  /** RFC-262：同名冲突策略。缺省 'rename'（RFC-020 既有行为）。 */
  onConflict: UploadOnConflictSchema.optional(),
})
```

写面：`services/workflow.ts` 保存工作流时已对每个 upload 条目跑 `UploadInputSchema`（strict-on-write），非法值自动被拒；读面继续走宽松的 `WorkflowInputSchema.passthrough()`，旧文档零改动往返。

YAML 导入导出对 `definition.inputs` 是整体 passthrough（`packages/shared/src/workflow-yaml.ts` 不逐字段枚举 input），新字段自动往返，只需补文档。

## 3. shared 纯函数（新文件 `packages/shared/src/uploadNaming.ts`）

把文件名净化 + 落点判重收成一个**前后端唯一事实源**：

```ts
/** RFC-020 的 sanitizeFilename 原样迁入（逐字节等价），backend 改为从此处导入。*/
export function sanitizeUploadFilename(raw: string, fallbackIndex = 0): string

/** 'inputs//refs/' → 'inputs/refs'；'.' / '' → ''；反斜杠归一为 '/'。不依赖 node:path（浏览器可用）。*/
export function normalizeUploadDir(dir: string): string

/** 落点判重 key：规范化目录 + '/' + 折叠大小写的 sanitized 名（D6）。*/
export function uploadLandingKey(targetDir: string, filename: string, fallbackIndex: number): string

/** 返回首个重复落点（含两条记录的 inputKey / 原始文件名），无重复返回 null。*/
export function findDuplicateUploadTarget(
  entries: readonly { inputKey: string; filename: string; targetDir: string }[],
): { key: string; first: { inputKey: string; filename: string }; second: { inputKey: string; filename: string } } | null
```

`fallbackIndex` 语义与写盘侧一致（`applyUploadsToWorktree` 里 `idx` 从 1 开始按 `files` 顺序递增），保证"空文件名"两侧算出同一个 `upload-N.bin`。前端按各 input 桶内序号传入；浏览器 `File.name` 恒非空，差异不可观测。

`sanitizeUploadFilename` 从 `packages/backend/src/services/upload.ts:99` 整体迁走（不留 re-export——CLAUDE.md「删除优于 deprecate」），backend 与既有测试改为从 shared 导入。

## 4. 后端改动

### 4.1 `services/upload.ts`

**类型**：`UploadInputDef` 增 `onConflict?: UploadOnConflict`。

**判重（`validateUploadPlan`）**：在既有 count / size / accept / min-max 检查之后追加一段——

```ts
const dup = findDuplicateUploadTarget(
  files.map((f, i) => ({
    inputKey: f.inputKey,
    filename: f.filename,
    targetDir: defs.get(f.inputKey)!.targetDir,   // 未声明的 key 上面已拒
    fallbackIndex: i + 1,
  })),
)
if (dup !== null) throw new ValidationError('upload-duplicate-filename', `...`, { detail })
```

`inputsSubdir`（RFC-248 多仓固定前缀）对所有 def 是同一个常量前缀，判重按相对 `targetDir` 比较与加前缀后完全等价，因此 `validateUploadPlan` 不需要知道它——这也是判重能在 worktree 物化前跑的前提。

**写盘（`applyUploadsToWorktree`）**：只在选名那一步分叉，其余（`assertInsideWorktree` → `assertTargetDirInsideWorktree` → `mkdirSync` → `dirname` 二次守卫 → `writeFileSync(..., {flag:'wx'})` → `written.push`）逐字不动：

```ts
const mode = def.onConflict ?? 'rename'
let finalName: string
if (mode === 'overwrite') {
  finalName = safeName                       // 覆盖模式必须保持原名，这正是它的价值
  const abs = resolve(targetAbs, finalName)
  const st = lstatOrNull(abs)                // lstat：不跟随符号链接
  if (st !== null) {
    if (st.isDirectory()) {
      throw new ValidationError('upload-target-is-dir', `...`)
    }
    unlinkSync(abs)                          // 删的是链接/文件本体，绝不跟随
  }
} else {
  finalName = resolveUniqueName(targetAbs, safeName)   // 今天的行为，一字不改
}
```

安全性质保持的逐条论证：

| RFC-107 性质                       | 覆盖分支为何仍成立                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 不写穿已存在的符号链接             | `unlinkSync` 作用于链接本体（不跟随），写入时目标已不存在；`writeFileSync` 仍带 `wx`（`O_CREAT\|O_EXCL`）                  |
| unlink 与 create 之间的 TOCTOU     | 若此窗口内被塞入新链接，`O_EXCL` 直接 `EEXIST` 失败关闭——不会跟随，也不会覆盖                                             |
| targetDir / 祖先是软链导致写出仓外 | `assertTargetDirInsideWorktree`（`upload.ts:27`）在 `mkdirSync` 前跑，与今天完全一致，与冲突策略正交                        |
| 文件名带分隔符导致越界             | `sanitizeUploadFilename` + `dirname(absPath) !== targetAbs` 二次守卫仍在覆盖分支之后执行                                   |
| 悬空链接被误判为"不存在"           | 用 `lstat`（`entryExists` / `lstatOrNull` 同源），悬空链接照样被识别为占用并 unlink 掉                                     |

**回滚**：`written` 数组与 catch 里的 unlink 循环保持不变（覆盖后写下的新文件失败时同样被删除，原内容不恢复——D5）。

### 4.2 `services/launchMultipart.ts`

`collectUploadInputDefs`（`:166`）在透传 `accept` / `maxFileSize` / `minCount` / `maxCount` 之后，同款透传 `onConflict`。RFC-218 派生的 agent 端口输入不产出该字段（`agentLaunchForm.ts:119`），因此恒走 `rename`。

### 4.3 `services/workflow.validator.ts`

`4d. upload-input-targetDir`（`:1628`）段内追加：`onConflict` 存在但不属于枚举 → `upload-input-on-conflict-invalid` error。与既有 `targetDir` 的"schema 写面 + validator 静态面各校验一次"保持同构，让画布校验面板能直接指出问题节点。

### 4.4 错误码

| 码                                  | 时机                                        | HTTP    |
| ----------------------------------- | ------------------------------------------- | ------- |
| `upload-duplicate-filename`         | `validateUploadPlan`（clone / 物化之前）    | 422     |
| `upload-target-is-dir`              | 覆盖分支发现目标是目录（写盘期）            | 422     |
| `upload-input-on-conflict-invalid`  | 工作流静态校验（保存 / 启动前）             | 422     |

三者都落在 `upload-` 前缀分组里（`packages/frontend/src/i18n/errors.ts:74`），只需补 zh/en 文案；`upload-input-` 前缀已在细分表 `:292`。

## 5. 前端改动

### 5.1 画布 Input 节点 inspector（`components/canvas/inspector/InputEdit.tsx:184`）

在 `targetDir` 字段之后插入冲突策略选择，走 CLAUDE.md 指定的公共原语：`<Field>` + `.segmented`（2 选项互斥、与 LanguageSwitch / NodeInspector `sessionMode` 同款），**不**新写 radio 组、**不**落原生 `<select>`。patch 走既有 `onPatch({...def, onConflict}, meta)` + `continuousNodeInspectorChange` 撤销栈边界，与其它字段同构。

i18n 新键：`inspector.upload.onConflict` / `.onConflictHint` / `.onConflictRename` / `.onConflictOverwrite`（zh-CN + en-US 同步；本仓 i18n 是带类型的对象，两边形状必须一致）。

> 附带（非本 RFC 必须，但同文件同一屏）：该编辑器现有三个数字字段直接落了原生 `<input className="form-input" type="number">`（`:267` / `:289` / `:304`），与 CLAUDE.md「表单字段一律走 Form 原语」相悖。改成公共 `<NumberInput>` 是一处纯收敛，放在 plan 的可选任务 T8 里，由你决定是否顺手做。

### 5.2 启动表单

- `components/launch/UploadPicker.tsx`：`overwrite` 输入在 targetDir 提示行下方多一行醒目提示——"同名文件将被覆盖"（`launch.upload.overwriteHint`）。
- `routes/tasks.new.tsx:890` 的 gating：`missingRequired` 旁增一条 `uploadDuplicate` 阻塞项，调 shared 的 `findDuplicateUploadTarget`（把 `uploads: Record<key, File[]>` 摊平 + 各 def 的 targetDir），命中则禁用 Start 并在对应 picker 上显示 `<ErrorBanner>` / 内联错误文案（复用既有错误展示组件，不自拼 div）。

## 6. 与既有模块的耦合点

| 模块                            | 影响                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wrapper-git                     | 上传发生在 `pre_snapshot` 之前（RFC-020 design §耦合）。覆盖一个**已跟踪**文件 ⇒ `git_diff` 里如实出现一条 modification（而不是今天的 untracked 新增），下游审计能看见 |
| 多仓 / workgroup（RFC-248 D12） | 上传落任务根 `.agent-workflow-inputs/<targetDir>`，那是保留目录、不属于任何成员仓 ⇒ 覆盖策略语法上可配，但**不可能**碰到成员仓文件。文档需写明                          |
| RFC-218 agent 端口              | 派生输入不带 `onConflict` ⇒ 恒 `rename`；但 C1 判重对它同样生效（同批同名照样 422）                                                                                     |
| `call-workflow`                 | 本就拒 upload 输入（`workflow.validator.ts:2501`），零影响                                                                                                              |
| MCP / 定时任务 / webhook 启动   | 本就拒含 upload 输入的工作流，零影响                                                                                                                                    |
| RFC-213 任务恢复                | 上传物本就不参与恢复（"为保护凭据与本地文件，这些内容不会恢复"），零影响                                                                                                |
| 意图构建（`intentDoc.ts:154`）  | supported input forms 一行需补 `onConflict?`，否则模型不会生成该字段                                                                                                    |
| `docs/workflow-yaml.md:101`     | upload 行的字段列需补                                                                                                                                                  |

## 7. 失败模式

| 场景                                        | 行为                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 同批同名（同 key / 跨 key）                 | 422 `upload-duplicate-filename`，无 clone、无 worktree、无任务行；前端提前拦在 Start 之前   |
| 覆盖模式命中目录                            | 422 `upload-target-is-dir`；已写下的本次文件被 unlink，worktree 整棵清理，无任务行          |
| 覆盖模式命中符号链接                        | 链接被 unlink，落真实文件；链接指向的外部文件内容不变                                      |
| 覆盖后第 N 个文件超限 / 磁盘满              | 抛错 → 本次写下的文件被 unlink → `cleanupMaterializedSpace` 删整棵 worktree → 4xx，无任务行 |
| unlink 与 create 之间被塞入链接（TOCTOU）   | `O_EXCL` EEXIST 失败关闭，同上清理                                                          |
| 存量工作流（无 `onConflict`）               | 一律 `rename`，与今天字节级一致                                                            |

## 8. 测试策略

**shared**（新 `packages/shared/tests/upload-naming.test.ts`）

1. `sanitizeUploadFilename` 迁移后逐条等价（把 backend 现有 4 条断言搬过来）
2. `normalizeUploadDir`：`.` / `''` / `a//b` / `a/b/` / 反斜杠
3. `findDuplicateUploadTarget`：无重复 → null；同 key 同名 → 命中；跨 key 同 targetDir 同名 → 命中（AC-7）；同名但 targetDir 不同 → 不命中；大小写不同 → 命中（D6 方案 A；若改方案 B 则改判为不命中）；空文件名 + 不同 fallbackIndex → 不命中
4. `UploadInputSchema`：`onConflict` 合法值通过、非法值拒、缺省字段仍通过

**backend**（扩 `tests/upload-apply-to-worktree.test.ts` + 新 `tests/rfc262-upload-overwrite.test.ts`）

5. AC-2 存量断言（`:166` renames on collision）保持不改判
6. 覆盖普通文件：内容被替换、packed 路径无 ` (n)` 后缀（AC-3）
7. 覆盖符号链接：worktree 内落真实文件、链接指向的**外部**文件内容不变（AC-4 / AC-10，RFC-107 同款夹具）
8. 覆盖悬空符号链接：同样被替换为真实文件，不残留链接
9. 覆盖目录 → `upload-target-is-dir`，且目录内容不受损（AC-5）
10. `validateUploadPlan` 同批同名 → `upload-duplicate-filename`，且**未创建任何文件**（AC-6）
11. 跨 input key 同落点同名 → 同错误（AC-7）
12. `collectUploadInputDefs` 透传 `onConflict`；派生 agent 端口不带该字段
13. `workflow.validator` 非法 `onConflict` → `upload-input-on-conflict-invalid`
14. 多仓 `inputsSubdir` + 覆盖：落点仍在 `.agent-workflow-inputs/` 下（路径不回归）

**frontend**

15. `InputEdit` 渲染冲突策略分段控件、切换后 patch 出正确 `onConflict`（`getByRole` 断言）
16. `UploadPicker` 在 overwrite 定义下渲染覆盖提示
17. `tasks.new` gating：同名文件选中后 Start 禁用 + 提示（AC-9）
18. 源码层锚：`InputEdit.tsx` 里不得出现自写 radio / 原生 `<select>`（贴合 CLAUDE.md 前端一致性硬规则）

**e2e**（`e2e/workflow-matrix.spec.ts` + 新夹具 `upload-input-overwrite.yaml`）

19. 预置仓内同名文件 → 上传同名文件 → 断言 prompt 里的 packed 路径是原路径、worktree 内容是上传版本（AC-11）

## 9. 兼容性

- **DB**：无迁移。`onConflict` 只是 `definition` JSON 里的可选字段。
- **wire**：无新参数。multipart 表单形状不变。
- **回退**：把工作流该字段删掉即回到今天行为；旧版二进制读到带 `onConflict` 的定义时，宽松 read schema 原样保留字段、行为回落 `rename`（不会崩）。
- **breaking**：仅 proposal §6 的 C1 / C2 两条（同批同名从"自动改名"变"启动报错"）。
