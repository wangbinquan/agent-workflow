# RFC-020 设计：Input 节点本地文件上传

> 实施前提：先读 [proposal.md](./proposal.md) 与 [plan.md](./plan.md)。本文件聚焦数据流 / 接口 / 失败模式 / 测试策略，不重述目标动机。

## 1. Schema 变更

### 1.1 `packages/shared/src/schemas/workflow.ts`

`WORKFLOW_INPUT_KIND` 追加 `'upload'`：

```ts
export const WORKFLOW_INPUT_KIND = ['text', 'files', 'enum', 'git', 'upload'] as const
```

`WorkflowInputSchema` 保持 `.passthrough()`（M1 permissive 决策延续），新字段以 zod refinement 在保存路径上单独校验：

```ts
// 同文件下追加一个 strict-on-write 的 narrow schema：
export const UploadInputSchema = WorkflowInputSchema.extend({
  kind: z.literal('upload'),
  targetDir: z
    .string()
    .min(1)
    .max(256)
    .refine((s) => !s.includes('..') && !s.startsWith('/'), {
      message: 'targetDir must be repo-relative and free of "..".',
    }),
  accept: z.array(z.string().min(1)).optional(), // .pdf, image/*, text/csv …
  maxFileSize: z.number().int().positive().optional(),
  minCount: z.number().int().min(0).optional(),
  maxCount: z.number().int().min(1).optional(),
})
```

`UploadInputSchema` 不替换 `WorkflowInputSchema`：写 workflow 的服务 (`services/workflow.ts`) 在保存前遍历 `definition.inputs[]`，对 `kind === 'upload'` 的项额外用 `UploadInputSchema.safeParse` 跑一次；失败抛 `workflow-invalid`（沿用现有路径）。读路径不强制，保持向前兼容。

> **schema_version 不动**：v2 已是当前；新 kind 是 `WORKFLOW_INPUT_KIND` 的水平扩展，旧 v2 文档不含 `upload`，新文档含 `upload` 也仍然是 v2。

### 1.2 `WorkflowInput` 与 `StartTask`

`StartTask`（`schemas/task.ts`）现状是 `inputs: z.record(z.string(), z.string())`。这一点**不变** —— upload 在线传输用 multipart，落库的 `tasks.inputs` 仍是 `key → newline-joined-paths` 字符串。换言之 server 端处理 multipart 后构造的 `StartTask.inputs[key]` 就是文件落盘后的 repo-relative path 列表（join `\n`）。

### 1.3 Settings

`packages/backend/src/config.ts` 追加：

```ts
uploadLimits?: {
  perFile?: number     // default 50 * 1024 * 1024
  perRequest?: number  // default 200 * 1024 * 1024
  perCount?: number    // default 20
}
```

启动时读到 `loadConfig()` 出来后向后端 multipart 处理入口注入；用户可在 `~/.agent-workflow/settings.json` 覆盖。

## 2. 后端：multipart 分支

### 2.1 `POST /api/tasks` 改造

`packages/backend/src/routes/tasks.ts` 当前用 `safeJson(c.req.raw)` 解析。改为：

```ts
const ct = c.req.header('content-type') ?? ''
if (ct.startsWith('multipart/form-data')) {
  // multipart 分支：见 §2.2
} else {
  // 原 JSON 分支（向前兼容）：保持原状
}
```

### 2.2 multipart 解析与文件落盘

新模块 `packages/backend/src/services/upload.ts` 暴露 `applyUploadsToWorktree`：

```ts
export interface UploadFile {
  inputKey: string
  filename: string
  mime: string
  bytes: Uint8Array
}

export interface UploadPlan {
  worktreePath: string
  defs: Map<string, UploadInputDef>  // key → 该 input 的 targetDir / accept / limit
  files: UploadFile[]
  limits: { perFile: number; perRequest: number; perCount: number }
}

export interface UploadResult {
  // 写入成功后每个 inputKey 对应的 repo-relative paths（顺序与上传顺序一致）
  packedByKey: Map<string, string[]>
}

export async function applyUploadsToWorktree(plan: UploadPlan): Promise<UploadResult>
```

落盘步骤（同步、按 `files[]` 顺序）：

1. **预校验**（不写盘）
   - 文件数 ≤ `perCount`；累计字节 ≤ `perRequest`；单文件 ≤ `min(perFile, def.maxFileSize ?? perFile)`
   - `accept` 白名单：扩展名（lower-case，匹配 `.pdf`）+ MIME（用 `file-type` npm 包嗅探 bytes 头部，不信任 client）
   - filename 清洗：剥 `\\` `/`、Unicode NFC、移除控制字符；为空 → 用 `upload-${idx}.bin`
2. **路径分配**
   - 解析 `def.targetDir` → `path.resolve(worktreePath, def.targetDir)`，再断言 prefix 命中 `worktreePath`（防 zip-slip 类逃逸）
   - `mkdir -p` 该目录
   - 解决重名：若 `<finalDir>/<name>` 已存在，stem 后插入 ` (1)` ` (2)` … 直到不冲突
3. **写盘**
   - 用 `Bun.write(path, bytes)` 或 `fs.writeFile`；写完按 `dirname/filename` push 进 `packedByKey`
4. **失败回滚**
   - 任一文件写盘抛错 → 之前在本次 multipart 调用内成功写入的新文件 `fs.unlink` 掉（不动旧的重名占位文件 —— 重名通过 stem (n) 已经避开），抛错给上层

`POST /api/tasks` multipart handler 调用顺序：

1. 取 `payload` 字段反序列化为 JSON → `StartTaskSchema.safeParse`（但允许 `inputs[uploadKey]` 为 `''`，由 multipart 接管）
2. resolveWorkflow → 校验所有 `kind: 'upload'` 的 input 在 multipart 中至少有 minCount 个文件、不超 maxCount
3. **先建 worktree**（沿用 `startTask` 内的 `createWorktree`）
4. `applyUploadsToWorktree` 写文件；返回的 `packedByKey` 用 `\n` join 后覆盖到 `input.inputs[key]`
5. 调 `startTask` —— 但要拆开来：当前 `startTask` 自己建 worktree。重构为 `startTask({ ...input, worktreePath? })`：若调用方已传 `worktreePath`，跳过创建直接复用（不复用代码不行，否则文件已落到第一次创建的 wt，第二次 wt 把它孤立掉）。详见 §2.3。

### 2.3 `startTask` 重构

抽出 `materializeWorktree({ input, appHome })` 内部函数返回 `{worktreePath, branch, baseCommit, earlyError}`；`startTask` 外部签名新增可选 `preCreatedWorktree?: { worktreePath; branch; baseCommit }`。

multipart 分支自己 call `materializeWorktree` → `applyUploadsToWorktree` → `startTask({..., preCreatedWorktree})`。JSON 分支保持现状（`startTask` 内部 call `materializeWorktree`）。

> 这是本 RFC 唯一一处对现有调用链的真正改动；其它都是新增模块 / 新增分支。

### 2.4 multipart 字段约定

| 字段                          | 必选 | 内容                                                            |
| ----------------------------- | ---- | --------------------------------------------------------------- |
| `payload`                     | ✅   | `application/json`，反序列化为 `StartTask`（`inputs[uploadKey]` 可空字符串） |
| `files[<inputKey>][]`         | 条件 | 任意 `upload` 类型 input 的二进制文件，0..N 条；前端按 input 单独的 `<input multiple>` 收集 |

字段名约束：`<inputKey>` 与 `WorkflowInputSchema.key` 一致，按原字符串值保留任意非空
Unicode 字符串。multipart 解析器只剥离固定的 `files[` / `][]` envelope；随后必须在读取文件
字节前，按 exact key 校验它属于目标工作流声明的 upload input。空 key、畸形 envelope 或未声明
key 仍拒绝整次请求。

## 3. 前端

### 3.1 `UploadPicker.tsx`（新组件）

`packages/frontend/src/components/launch/UploadPicker.tsx`：

```tsx
interface Props {
  def: WorkflowInput              // kind === 'upload'
  files: File[]                   // 已选 File[]（live state，与 packed value 解耦）
  onChange: (next: File[]) => void
}
```

UI：
- 一个 `<input type="file" multiple accept={def.accept?.join(',')} hidden ref={ref}>` + label-style button "选择文件"
- 已选文件表：name / size（friendly） / mime / 删除按钮
- min / max / accept / per-file size 提示行
- 拖拽进画面区域支持（HTML5 drop event）

### 3.2 launcher state

`workflows.launch.tsx` 当前 `values: Record<string, string>` 不变 —— `upload` 输入用一个**平行** state `uploads: Record<string, File[]>`。Start 按钮 disabled 规则加：

- `def.required === true && (uploads[def.key]?.length ?? 0) === 0` → disabled
- `(uploads[def.key]?.length ?? 0) < (def.minCount ?? 0)` → disabled

提交时构造 `FormData`：

```ts
const fd = new FormData()
fd.append('payload', new Blob([JSON.stringify({
  workflowId, repoPath, baseBranch,
  inputs: { ...values, ...Object.fromEntries(Object.keys(uploads).map(k => [k, ''])) },
})], { type: 'application/json' }))
for (const [k, fs] of Object.entries(uploads)) {
  for (const f of fs) fd.append(`files[${k}][]`, f, f.name)
}
fetch('/api/tasks', { method: 'POST', body: fd })
```

注意：`fetch` 不要手动设 `Content-Type`，让浏览器带 boundary。

`api/client.ts` 加一个 `postMultipart` 助手，统一错误反序列化为 `ApiError`。

### 3.3 editor 表单（`NodeInspector` input editor）

`packages/frontend/src/components/canvas/NodeInspector.tsx` 现有 input-kind 下拉里加 `<option value="upload">upload</option>`；展开 upload 分支的字段表单：

- `targetDir` 文本框（必填，`..` 红字）
- `accept` 多 token 输入（split by `,` 或 enter，存数组）
- `maxFileSize` 数字（字节，默认提示走 settings 全局）
- `minCount` / `maxCount`（复用 `files` 同字段）

### 3.4 i18n

中英各加：

- `launch.upload.chooseFiles` / `selectedCount` / `removeFile` / `targetDirHint` / `acceptHint` / `maxSizeHint`
- `inspector.input.kind.upload` / `targetDir` / `targetDirError` / `accept` / `maxFileSize`

## 4. 与运行期的耦合点

- **scheduler / runner**：零改动。upload kind 的 `tasks.inputs[key]` 落库后就是 newline string，与 `files` 同构，scheduler 用 portName=inputKey 注入下游即可。
- **wrapper-git**：零改动。`createWorktree → applyUploadsToWorktree` 在 wrapper-git 的 `pre_snapshot`（首次包装器 enter 时取）**之前** 完成；多出来的文件是 worktree 内的 untracked，自然出现在 `git_diff` 输出里。如果业务上某些场景不希望 upload 出现在 diff，让用户把 `targetDir` 设到 `.gitignore` 已覆盖的路径即可，框架不强加。
- **validator**（`services/workflow.validator.ts`）：扩 1 条规则 — 当 `definition.inputs[]` 含 `upload` 时校验它的 `targetDir` 非空、不含 `..`、不以 `/` 起头（与 `UploadInputSchema` 同步）。其它现有规则透传。

## 5. 安全模型

- **路径逃逸**：双闸门 — schema 拒掉含 `..` 的 `targetDir`；落盘时 `path.resolve` 后断言 prefix 命中 `worktreePath`。两层都炸才能写出 worktree 外。
- **MIME 嗅探**：服务端用 `file-type` 包读文件头 64 字节嗅探，不信任 client `file.type`。`accept` 白名单同时按扩展名 + 嗅探出的 MIME 比对，命中任一即放行（兼容奇怪扩展名）。
- **DoS 防护**：`perCount` / `perFile` / `perRequest` 三个上限同时启用。Hono / Bun multipart 解析失败 → 直接 400，不进 `startTask`。
- **文件名注入**：清洗剥 `\\` `/`、移除控制字符、Unicode NFC；保留空格 / 中文。
- **重名占位**：始终是"加 (n) 起新名"，**绝不覆盖** 已经存在的文件（即使是 untracked 用户文件）。
  > **勘误（RFC-262，2026-08-07）**：本条已被显式改判为**默认行为**而非绝对约束。upload 输入新增
  > 作者级字段 `onConflict: 'rename' | 'overwrite'`，缺省 `rename` 即本条描述的行为（字节级不变）；
  > 作者显式选 `overwrite` 时用上传文件替换同名条目（`unlinkSync` 只删链接/文件本体，不跟随符号
  > 链接，写入仍带 `wx`，RFC-107 的"绝不写穿已存在路径"性质不变）。另：同一次上传内两个文件落到
  > 同一路径，现在在启动校验期即被拒（`upload-duplicate-filename`），不再自动改名——见
  > `design/RFC-262-upload-input-overwrite/`。

## 6. 测试策略

### shared

- `packages/shared/tests/workflow-input-upload.test.ts`
  - `UploadInputSchema` happy 路径
  - `..` `/abs` 被拒
  - `accept` 数组为空 / undefined / 含奇怪 token 的边界
  - `maxFileSize` 负数 / 0 被拒

### backend

- `packages/backend/tests/upload-apply-to-worktree.test.ts`（纯函数 `applyUploadsToWorktree`）
  - happy：3 文件落到 `inputs/` 子目录，返回 packed paths
  - 重名：第二次写 `report.pdf` → 落 `report (1).pdf`
  - filename 清洗：`../etc/passwd` → 剥成 `passwd`
  - accept whitelist 拒绝 mime 不符
  - 单文件超 `perFile` → 抛错、零文件落盘
  - 总和超 `perRequest` → 抛错、零文件落盘
  - 写第 2 文件时 throw → 第 1 文件被 unlink、目录保留（mkdir -p 后不强制 cleanup）
  - `targetDir` 含 `..` 即使 schema 漏了也被拦（`path.resolve` 断言）
- `packages/backend/tests/tasks-multipart.test.ts`（HTTP 层）
  - multipart POST 1 upload kind + 1 text kind：task 进 pending，worktree 下能 read 到文件，`inputs[uploadKey]` 是 newline-joined paths
  - 没文件但 minCount=1 → 400
  - 文件存在但 multipart 字段名错（`files[wrongKey][]`）→ 400
  - workflow 不存在 → 404 且不写文件（前置校验）
  - createWorktree 失败 → task 失败、文件不留外部（实际上甚至没写过，因为顺序是先 wt 再 upload）
  - applyUploadsToWorktree 抛错 → task 进 failed + earlyError 说明上传失败，不调 scheduler
- `packages/backend/tests/workflow-validator-upload-input.test.ts`（validator）
  - `kind: 'upload'` 缺 `targetDir` → error severity issue
  - `targetDir` 含 `..` → error severity issue
  - happy → ok

### frontend

- `packages/frontend/tests/upload-picker.test.tsx`
  - 选 3 文件 → 列表渲染 3 行 + count；删第 2 → 剩 2
  - 超 maxCount → 选不进去 + 红字
  - mime 不在 accept → 拒收
- `packages/frontend/tests/launch-upload-form-data.test.ts`（纯函数）
  - 抽出 `buildLaunchFormData({ payload, uploads })` 纯函数；断言生成的 FormData 含 `payload` JSON + `files[<key>][]` 顺序与文件数一致
- `packages/frontend/tests/launch-upload-disabled.test.tsx`
  - required upload 0 文件 → Start disabled
  - minCount=2 但只选 1 → disabled
- `packages/frontend/tests/node-inspector-upload-input.test.tsx`
  - 在 NodeInspector 切换 input kind 为 upload → 出现 targetDir 字段；填 `..` → 红字 + 保存阻断（源码层断言保留以兜底）
- 源码层兜底：`packages/frontend/tests/launch-route-upload-wiring.test.ts` — grep `workflows.launch.tsx` 确认 `kind === 'upload'` 分支接 `UploadPicker`、Start 按钮 disabled 表达式含 uploads 长度引用（防回归）

### e2e（Playwright，可选追加）

- 现有 e2e flow：拖 input upload kind 的 workflow → 进 launcher → 选一个本地 `.txt` → 启动 → 等 task pending → 通过 `/api/tasks/:id/diff` 或文件系统断言 worktree 下 `inputs/<file>.txt` 存在

## 7. 性能与边界

- 默认上限 200MiB / req 足够覆盖典型 PDF / 截图场景；超大文件场景另起需求。
- 服务端 multipart 解析在 Bun / Hono 里走流式（`req.formData()`），但每个 File 仍会进内存才能嗅探 + 写盘 —— 在 50MiB/文件 × 20 文件下峰值内存可达 1GB+，必要时未来改为流式 sniff（前 64B）+ 流式写盘（`Bun.write(stream)`）。v1 简洁优先，先一次性 buffer。
- 上传失败的 partial 文件会在 §2.2 rollback 里清理；磁盘满或权限错时回滚也可能失败 → log warn 不阻断错误返回。

## 8. 兼容性

- 旧 workflow（不含 `upload` 输入）零改动。
- 旧 `POST /api/tasks` JSON 调用路径保留，前端只在含 `upload` kind 的 launch 表单切到 multipart。
- 数据库 schema 无 migration。

## 9. 验收门槛

`bun run typecheck && bun run test && bun run format:check` 全绿；CI（macos + ubuntu）Lint+Typecheck+Test、Build single-binary、Playwright e2e 全绿。
