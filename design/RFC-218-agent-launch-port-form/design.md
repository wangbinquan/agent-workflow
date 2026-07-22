# RFC-218 单 agent 启动端口化表单与启动上传控件收敛 — design

状态：Draft（2026-07-22）。产品语境见 `proposal.md`；任务分解见 `plan.md`。

## 1. 现状锚点（全部已核实）

| 事实 | 位置 |
| --- | --- |
| 宿主快照写死单一 `description` 端口 + `promptTemplate:'{{description}}'` | `packages/backend/src/services/agentLaunch.ts:88-104` |
| 启动时 `inputs: { description }` 走与工作流同一个 `startTask` | `agentLaunch.ts:207-231` |
| agent 声明式输入端口（RFC-166，元数据-only） | `packages/shared/src/schemas/agent.ts:37-60` |
| kind 文法 string \| markdown \| signal \| path\<ext\> \| list\<K\>（递归），注册基 kind 集 | `packages/shared/src/kindParser.ts:8-11,175-179`；`review.ts:51-68` |
| 向导只为 workflow 取端口定义 | `packages/frontend/src/routes/tasks.new.tsx:678` |
| 向导 agent 分支只有描述框（`wizard-description`）| `tasks.new.tsx:1331-1335` |
| agent 启动 body 组装（**显式 strip `inputs`**）| `packages/frontend/src/lib/task-wizard.ts:139-164`（strip 在 `:158-159`） |
| agent relaunch payload（stamp `description`）| `task-wizard.ts:321,390-393` |
| agent 启动路由 JSON-only | `packages/backend/src/routes/agents.ts:188-213` |
| workflow 启动路由 multipart 分支 + 解析器 | `packages/backend/src/routes/tasks.ts:191-201,798-929` |
| 上传落盘 + 端口值 = 换行拼接 repo 相对路径 | `packages/backend/src/services/upload.ts:331-377`；`tasks.ts:1007-1015` |
| input 节点把 `inputsMap[inputKey]` 原样发到同名端口 | `packages/backend/src/services/scheduler.ts:2768-2789` |
| 模板展开单遍替换，token 正则 `\w+`，值经 `<aw-input>` 围栏 | `packages/shared/src/prompt.ts:365,453-552`；`promptFencing.ts:103-110` |
| 多端口模板合成先例（fusion `intent`+`memories`）| `packages/backend/src/services/fusion.ts:197-205,297-322` |
| StartAgentTask wire schema | `packages/shared/src/schemas/task.ts:1175-1207` |
| scheduled agent payload = StartAgentTaskSchema.extend | `packages/shared/src/schemas/scheduledTask.ts:73-76` |
| RFC-165 快照锁测试 | `packages/backend/tests/rfc165-agent-launch.test.ts`（A1 `:108-139` 等） |
| `FileDropzone` 公共原语（单文件）| `packages/frontend/src/components/FileDropzone.tsx`；样式 `styles.css:9430-9544` |
| `UploadPicker` 手搓上传（待收敛）| `packages/frontend/src/components/launch/UploadPicker.tsx`；样式 `styles.css:5501-5560` |
| ChipsInput 契约（value:string[]、Enter/逗号 commit、validate、testidPrefix）| `packages/frontend/src/components/ChipsInput.tsx:91-123` |

## 2. 总体设计

一句话：**新增一层纯函数「派生层」把 `agent.inputs` 确定性翻译成宿主快照的 workflow inputs +
promptTemplate，前后端共用；引擎、调度器、校验器、模板引擎零改动。**

```
agent.inputs (AgentInputPort[])
      │  deriveAgentLaunchForm()          ← shared 纯函数，唯一事实源
      ▼
{ inputs: WorkflowInput[],               → 前端：DynamicInput 动态表单（复用 workflow 启动路径）
  promptTemplate: string,                → 后端：buildAgentHostSnapshot 的端口/边/模板
  blockers: LaunchBlocker[] }            → 两端：signal / 非法端口名的启动拦截
```

### 2.1 shared 派生层（新文件 `packages/shared/src/agentLaunchForm.ts`）

```ts
export interface AgentLaunchForm {
  /** 宿主快照的 inputs[]（每端口一条；零端口 agent 返回 null 走旧路径） */
  inputs: DerivedLaunchInput[]
  /** 合成的 XML 端口块模板（见 §3） */
  promptTemplate: string
  /** 非空 ⇒ 该 agent 不可手动启动（signal 端口 / 非法端口名 / 保留名撞车） */
  blockers: AgentLaunchBlocker[]
}
export function deriveAgentLaunchForm(ports: AgentInputPort[]): AgentLaunchForm | null
```

- `ports.length === 0`（或字段缺省）→ 返回 `null`，调用方走 RFC-165 原路径——**零端口
  byte-compat 由此结构性保证**（旧代码路径原封不动，而非「新路径恰好生成旧字节」）。
- `DerivedLaunchInput` 就是 `WorkflowInput`（passthrough schema），额外携带两个透传字段：
  `presentation?: 'chips'`（前端控件选择）与 `agentKind: string`（原始 kind 字符串，hint 展示 +
  调试）。快照持久化这两个字段无害（`WorkflowInputSchema` 本就 `.passthrough()`，
  `workflow.ts:140-148`）。
- **顺序 = 声明顺序**（数组序），两端一致。

### 2.2 kind → 表单/端口映射（D3）

用 `tryParseKind`（`kindParser.ts:129`）解析后按结构映射；解析失败按理论上不可达处理（写路径
schema 已拒绝），实际防御性落文本兜底：

| agent kind | WorkflowInput | 前端控件 | 端口 wire 值 |
| --- | --- | --- | --- |
| `string` | `kind:'text'` multiline | TextArea | 原文 |
| `markdown` | `kind:'text'` multiline | TextArea（monospace）| 原文 |
| `path<ext>` | `kind:'upload'`，`targetDir:'.agent-inputs/{port}'`，`accept:['.{ext}']`（`*`→省略），`maxCount:1`，`minCount:required?1:0` | FilesDropzone（PR-1）| 单个 repo 相对路径 |
| `list<path<ext>>` | 同上但无 `maxCount` | FilesDropzone 多文件 | 换行拼接相对路径（=workflow upload 既有约定，`upload.ts:5`）|
| `list<string>` / `list<markdown>` | `kind:'text'` + `presentation:'chips'` | ChipsInput | 换行拼接（chips 单行项，无歧义）|
| 其余合法组合（如 `list<list<…>>`）| `kind:'text'` multiline | TextArea + kind hint | 原文透传 |
| 含 `signal`（任意嵌套）| —— | —— | blocker：`signal-port` |

- `required` 语义（D5）：`required !== false` ⇒ 必填（声明即需要是更安全的默认）；显式
  `required:false` ⇒ 可空，空值照常入模板（空端口块）。映射到 `WorkflowInput.required` 供前端
  复用既有 canProceed 必填检查（`tasks.new.tsx:684-700` 一带）。
- label = 端口名；`WorkflowInput.description` = 端口 `description`（hint 展示）。

### 2.3 端口名合法性门（D8，启动期拦截）

模板 token 正则是 `\w+`（`prompt.ts:365`），而 `AgentInputPortSchema.name` 只有 min/max 约束
（`agent.ts:38`）。派生层对每个端口名检查：

1. 必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`（可作 token）；
2. **保留命名空间整体拒绝**（设计门 P2-1 修订）：`/^__.*__$/` 的名字一律 blocker——一条规则
   覆盖内建 token（`__repo_path__` 等，内建**先于**端口解析会静默遮蔽端口值，
   `prompt.ts:501-539`）、deprecated token（替换为空串，`prompt.ts:547`）、系统通道端口名
   （`__clarify_response__` 等，合成数据边会被通道处理规则干掉）以及未来新增的运行时特殊名，
   不需要逐注册表枚举、不会随注册表演进漂移；
3. record 毒键拒绝：`__proto__`（已含于 2）、`constructor`、`prototype`——zod record/普通对象
   管线会静默丢弃或污染这类键；
4. `description` **不**保留：零端口路径与端口化路径互斥，端口名叫 `description` 只是普通键，
   快照里不会同时存在两套。

违规 → blocker `invalid-port-name`（携端口名与原因）。前端禁用启动按钮并展示原因；后端
`startAgentTask` 在任何副作用之前抛 `ValidationError('agent-launch-invalid', …)`。**作者侧
提示走前端编辑器**（设计门 P2-3 修订）：`createAgent`/`updateAgent` 返回值只有 `Agent`、无
警告通道，不为此扩 API 信封——shared blocker 函数直接接入既有
`validateAgentPortState`/`AgentPortValidationSummary`（`packages/frontend/src/lib/agent-ports.ts`），
在端口编辑器里实时展示「该端口名将导致无法手动启动」警告（不阻断保存——存量读路径宽容原则）。

## 3. promptTemplate 合成（D2）

固定字节（golden 锁定），端口按声明序：

```
Your task inputs are provided in the XML port blocks below.

<workflow-input>
<port name="report">
{{report}}
</port>
<port name="style_guide">
{{style_guide}}
</port>
</workflow-input>
```

- 单端口同样走信封（用户拍板：规则无分支）。
- 运行期每个 token 的值再经 `fenceUntrusted` 包一层 `<aw-input name=… id={nonce}>`
  （`prompt.ts:473-474`、`promptFencing.ts:103-110`）：行首锚点中和 + `</aw-input>` 闭合中和已
  由围栏层完成，所以**值里出现 `</port>` 不构成注入面**——`<port>` 块只是给 agent 的语义分界，
  不是机器解析协议；真正的信任边界是 `<aw-input>` 围栏（值内伪造的 `</port>` 落在围栏内部，
  agent 可分辨）。设计上不再对值做第二层 XML 转义（避免 agent 看到被改写的内容）。
- 端口名进 `name="…"` 属性无需转义——D8 已保证名字是 `\w+` 子集。
- 零端口 agent 模板维持字节 `{{description}}`（旧路径，A1 锁不变）。

## 4. 宿主快照合成（backend）

`buildAgentHostSnapshot(agentName, allowClarify)` → `buildAgentHostSnapshot(agent, allowClarify)`
（需要 `agent.inputs`；调用点 `agentLaunch.ts:183` 本就持有完整 agent row）：

- **零端口**：现有字节原样（inputs/nodes/edges/模板全部不变）。
- **端口化**：
  - `inputs[]` = 派生层输出（含 upload 端口的 targetDir/accept/minCount/maxCount）。
  - 节点：每端口一个 input 节点，id `__agent_input_{i}__`（**按声明序取下标**，不从端口名派生
    ——端口名虽已限 `\w+`，下标 id 更短且天然无碰撞）、`inputKey` = 端口名；agent 节点 /
    clarify 节点 / 节点 id 常量不变。
  - 边：`e_input_{i}` 每端口一条，source `(input_i, 端口名)` → target `(__agent_main__, 端口名)`
    （scheduler 的 input 节点在 `inputKey` 同名端口上发值，`scheduler.ts:2768-2789`；runner 按
    target portName 键入 `input.inputs`，token 即端口名——与现有 `{{description}}` 链路同构）。
  - `promptTemplate` = §3 合成串。
- 快照照旧走 `WorkflowDefinitionSchema.parse` + `validateWorkflowDef` 全量静态校验（F14 语义
  不变，`agentLaunch.ts:183-202`）。

## 5. wire 契约变化

### 5.1 `StartAgentTaskSchema`（`task.ts:1175`）

```ts
description: z.string().trim().min(1).max(65536).optional(),   // 原 required → optional
inputs: z.record(z.string(), z.string().max(65536)).optional(), // 新增
```

条件必选在**服务层**判定（schema 不知道 agent 形态）：

| agent 形态 | 合法 body | 违规处理（均 `ValidationError('agent-launch-invalid')`，issue 指明字段）|
| --- | --- | --- |
| 零端口 | `description` 必有、`inputs` 必无 | 缺 description / 带 inputs → 400 |
| 端口化 | `inputs` 必有、`description` 必无 | 反之 → 400；`inputs` 含未声明键 → 400；必填端口缺失或全空白 → 400 |

- `applySpaceFields` 组装点改为按形态二选一注入 `inputs` map（零端口仍
  `{ [AGENT_HOST_INPUT_KEY]: description }`，`agentLaunch.ts:211` 一带）。
- `rejectRetiredStartTaskKeys`（`agents.ts:198`）不收录 `inputs`（它现在是合法键）——需检查该
  gate 的键清单确认无冲突。
- **前端 body 组装是白名单制**：`buildAgentStartBody` 今天显式 strip `inputs`
  （`task-wizard.ts:158-159`），必须改为按形态 stamp `inputs` / `description` 二选一——漏改会被
  静默丢弃（[feedback_launch_body_helper_whitelist] 前科），plan.md 单列任务 + 测试锁 body 字段。

### 5.2 multipart（上传端口）

`POST /api/agents/:name/tasks` 增加 multipart 分支，与 `/api/tasks` **共用抽取后的解析器**：

- 从 `handleMultipartTaskStart`（`tasks.ts:800`）抽出与「解析 form / `files[key][]` 绑定 /
  上传校验（accept、maxFileSize、min/maxCount、MIME 嗅探）/ `applyUploadsToWorktree` / 回写
  `inputs[key]`」相关的公共骨架为 `services/launchMultipart.ts`（参数化 defs 来源与
  start 回调），两路由各自传入 `collectUploadInputDefs(workflow)` / 派生层 upload defs 与
  `startTask` / `startAgentTask`。**不复制第二份**（dedup 原则；这是本 RFC 唯一的非新增重构面）。
- **预检先于一切副作用，预约罩住全程**（设计门 P1-2 修订）：agent 分支的执行序固定为——
  ①路由解析 multipart 到内存（零文件系统副作用）→ ②`startAgentTask` 既有预检链完整前置
  （ACL-404 → builtin 403 → `expectedAgentId` OCC → `acquireAgentLaunch` 预约 → post-acquire
  recheck → 派生 blockers → F14 快照静态校验 → §5.1 形态矩阵 + 上传字段校验
  〔count/accept/size，仍未落盘〕）→ ③进入 `startTask`，在与 workflow 路径相同的生命周期点
  （task row + worktree 就绪后）经共用骨架 `applyUploadsToWorktree` 落盘 → ④`finally` 释放
  预约。任何校验失败发生在落盘之前；delete/rename 在整个上传+启动窗口内被预约 409 挡住
  （`agentLaunch.ts:161-176` 语义外延到含上传的launch）。落地形态：`startAgentTask` 增加可选
  `uploads` 参数（内存态文件集），路由不再各自持有生命周期逻辑。
- **upload 端口只认 multipart**（设计门 P1-3 修订）：派生 defs 含 upload 端口时，纯 JSON body
  在 `inputs` 里为这些键提供任意字符串 → 400（`agent-launch-invalid`，issue 指明「path 端口
  必须以文件上传绑定」）；multipart 时这些键的值由服务端落盘结果**覆写**、客户端提供的同名
  文本一律忽略。这封死「JSON 直传伪造路径 / 指向 worktree 外或不存在文件」的旁路（scheduled
  火时走 JSON，端口漂移出 upload 键会在此被同一条规则拒绝，与 §5.3 呼应）。
- 落盘目录 `.agent-inputs/{port}`（D7）：点前缀避开仓库真实内容碰撞；`applyUploadsToWorktree`
  的 worktree 逃逸 / symlink / 唯一名护栏原样生效（`upload.ts:348-371`）。
- 无上传端口的端口化 agent 走纯 JSON（`inputs` 全文本）。

### 5.3 scheduled（D10）

- `ScheduledAgentPayloadSchema = StartAgentTaskSchema.extend(...)`（`scheduledTask.ts:73-76`）
  自动获得 `inputs`。
- **保存期跑完整形态校验**（设计门 P2-2 修订）：description/inputs 双 optional 之后，schema
  自身拦不住「两者皆无 / 未知键 / 缺必填 / blocker agent」的 payload——把 §5.1 的条件形态
  矩阵（含 blocker 检查与「含上传端口不可定时」）抽成独立校验函数
  `validateAgentLaunchShape(agent, payload)`，`startAgentTask` 与 scheduled create/update
  （`scheduledTasks.ts` 既有 target-usable 门旁）共用——一个必然每次火失败的定时任务不允许
  被保存。
- 触发路径本就走 `startAgentTask`（rfc165-scheduled-kinds K4），火时按**当时**的 agent 定义重新
  派生与校验：agent 端口集已漂移 → 火失败并按既有 scheduled 失败面记录（不静默兜底；漂移出
  upload 端口时由 §5.2 的 multipart-only 规则拒绝）。

### 5.4 relaunch（D9）

`taskToLaunchPayload` agent 分支（`task-wizard.ts:390-393`）：

- 快照含端口化输入的判别（设计门 P1-1 修订）：**精确匹配下标形态**
  `/^__agent_input_\d+__$/`——遗留零端口节点 id `__agent_input__` 本身就以 `__agent_input_`
  开头，前缀判别会把**全部存量 RFC-165 任务**误判为端口化（relaunch 丢 description，破
  AC-2/AC-9）；回归测试必须用真实 HEAD 版零端口快照做反例。判定端口化 → stamp `inputs` =
  `task.inputs` 中**文本类端口**原值；upload 端口键剔除（旧 worktree 相对路径无意义）。
- 向导侧对 relaunch 预填做交集：以**当前** agent 派生的端口集为准，快照里多余的键丢弃、缺的留空。
- 零端口老任务：现状 stamp `description` 不变。

## 6. 前端

### 6.1 向导（`tasks.new.tsx`）

- agent 选中后需要 `inputs`：优先直接用列表 DTO（`rowToAgent` 恒填 `inputs`，`agent.ts:122` 注释
  ——落地时验证 `GET /api/agents` 列表行确实携带；若列表被瘦身则加 per-agent detail query，
  对齐 `workflowQ` 先例 `tasks.new.tsx:272-284`）。
- **数据就绪屏障**（设计门 P1-5 修订）：深链 `?kind=agent&agent=…` 下 `agentsQ` 尚在加载/失败
  时，「查无该行」与「零端口 agent」不可区分——不得默认渲染描述框。对齐 workflow 的
  detail-success 屏障（`:727-737` 「Require a SUCCESSFUL detail load」同精神）：agent kind 的
  第 3 步在 `agentsQ` 成功且命中选中行之前渲染 LoadingState / 失败渲染 ErrorBanner，
  canProceed 恒 false；表单形态只在拿到真实 `agent.inputs` 后决定。
- `inputDefs` 来源改为三元：workflow → `definition.inputs`；agent 端口化 → 派生层输出；agent
  零端口 → `[]` + 描述框。第 3 步渲染直接复用现有 `DynamicInput` 循环（`:1379-1400`）与
  uploads 平行 state（`:203`）、必填检查（`:684-700`）、multipart 判定（`:703-713`）——这些
  逻辑从「workflow 专属」提升为「有端口定义即生效」。
- **端口 state 随选择目标收敛**（设计门 P1-4 修订）：现有 seed/prune effect 被 `kind ===
  'workflow'` 门住（`:517-570`），切换 agent A→B、workflow↔agent 会把 A 的键残留在
  `inputs`/`uploads` state 里；而 §5.1 的未知键 400 会让正常的「换个对象再启动」直接不可用。
  两层修复：①把 seed/prune effect 泛化为「以当前 `inputDefs` 为准」（含 uploads 键同步清理，
  `:567-570` 同款）；②提交 body 组装时再按当前派生 defs 过滤一次（防御纵深，state 泄漏也
  不上 wire）。
- `DynamicInput` 增加 `presentation:'chips'` 分支 → `ChipsInput`（value 与换行 wire 互转在
  分支内完成；`testidPrefix` = `wizard-input-{key}`）。
- **长度上限贯通**（设计门 P2-4 修订）：`StartAgentTaskSchema` 每值 65536 上限要带到控件层
  （TextArea `maxLength`、chips 以合成后换行串长度校验），并纳入 canProceed——不允许「前端
  全绿、提交才 422」。派生 def 透传 `maxLength` 字段。
- blocker 非空：第 3 步渲染 ErrorBanner 说明原因（i18n），启动按钮禁用。
- 摘要步（`:1551-1563`）端口化 agent 走既有 inputs 摘要列表分支，不再显示 description 行。

### 6.2 PR-1：上传控件收敛（独立先行）

- `FileDropzone.tsx` 内新增 sibling `FilesDropzone`（多文件形态），复用 `.file-dropzone` 样式
  命名空间与 `formatShortBytes`：多选 input、拖拽 enter/leave 深度计数与 `--active` 高亮同款、
  已选文件列表（每行 名字+大小+删除，样式扩展 `.file-dropzone__list`）、`accept` / `maxCount` /
  重复跳过（name+size）沿用 `UploadPicker` 现逻辑、错误槽 role=alert。**不改单文件 API**
  （AgentImportDialog / ImportZipPanel / WorkflowImportDialog 三个调用方零涟漪）。
- `UploadPicker` 重写为薄适配层：解析 def（targetDir/accept/min/max/maxFileSize）→ 渲染
  `FilesDropzone` + 既有 hint 行（targetDir / accept / maxSize / min/max 计数，i18n 键
  `launch.upload.*` 保留，`en-US.ts:2580-2590`；新增 dropzone 标题/描述键）。
- 删除 `.upload-picker__drop` 手搓 drag 面（`styles.css:5501-5560` 相应收缩）；保留
  `.upload-picker` 外层布局类或并入 `.file-dropzone` 扩展，以实际收敛后最小 CSS 为准。
- 视觉自查：最小 repro + chrome 截图 light/dark，与 skills 导入 side-by-side
  （[feedback_frontend_visual_verify_repro]）。

## 7. 失败模式

| 场景 | 行为 |
| --- | --- |
| agent 在表单填写期间被作者改端口（加/删/改 kind）| 服务端以**当前** agent 派生校验：未知键 / 缺必填 → 400，前端提示后重新拉取表单。不做端口集 OCC（`expectedAgentId` 只防换体，D11——端口漂移是内容漂移，400 + 重填是正确 UX）|
| agent 在启动瞬间被删/重建同名 | 既有 `expectedAgentId` + 启动预约闭环不变（`agentLaunch.ts:154-176`）|
| signal 端口 agent 手动启动 | 前端禁用；后端 blocker → 400（AC-4）|
| 端口名非 `\w+` / 撞内建 token | 启动 400 指明端口；保存警告（§2.3）|
| 上传端口 multipart 缺文件 / 超限 / MIME 不符 | 与 workflow 上传同一套校验错误面（共用解析器）|
| upload 端口值以纯 JSON 直传（伪造/悬空路径）| 400，multipart-only（§5.2；multipart 下同名文本键被服务端落盘结果覆写）|
| 切换 agent / workflow↔agent 后旧端口键残留 | 前端 seed/prune 泛化 + body 组装按当前 defs 过滤双层收敛（§6.1）|
| 深链进向导时 agent 列表未加载/失败 | 数据就绪屏障：LoadingState/ErrorBanner，不猜表单形态（§6.1）|
| 必填文本端口全空白 | 400（trim 后判空；与 description `.trim().min(1)` 同标准）|
| 可选端口留空 | 空端口块入模板（agent 可见「该输入为空」，不歧义）|
| 端口值含 `{{…}}` / `</port>` / 行首指令 | 单遍替换不二次展开 + `<aw-input>` 围栏中和（§3；继承既有性质，新增回归锁）|
| scheduled agent 火时端口集已漂移 | 火失败走既有 scheduled 失败记录面（§5.3）|
| relaunch 时 agent 已端口化/去端口化 | 表单按当前 agent 形态渲染，预填取交集（§5.4）|

## 8. 决策记录

- **D1 完全替换**（用户 2026-07-22）：端口化 agent 无描述框；description 不作为隐藏附加端口。
- **D2 XML 端口块**（用户 2026-07-22）：统一信封无单/多端口分支；名义分界靠 `<port>`，信任边界
  靠既有 `<aw-input>` 围栏，不做二层转义。
- **D3 kind 映射**（用户 2026-07-22：path 接上传、list 逐项）：映射表见 §2.2；嵌套 list 文本兜底。
- **D4 signal 禁手动启动**（用户 2026-07-22）。
- **D5 默认必填**：`required !== false` ⇒ 必填。声明即契约；宽松默认会让 agent 在缺输入下静默跑偏。
- **D6 派生层放 shared 单一事实源**：前端表单与后端快照若各写一份必然漂移（本仓 dedup 审计惯犯
  模式）；纯函数 + golden 测试。
- **D7 上传落盘 `.agent-inputs/{port}`**：agent 端口无 targetDir 概念，取平台保留点前缀目录避免
  与仓库内容撞名；沿用 upload.ts 全部护栏。
- **D8 端口名启动期拦截而非 schema 收紧**：存量读路径宽容（RFC-166 读 lenient 原则）；作者侧
  提示走前端端口编辑器（`validateAgentPortState` 接入 shared blocker），不扩后端保存 API 的
  警告信封，不加硬约束，避免存量 agent 无法保存的回归（设计门 P2-3 修订）。
- **D9 relaunch 上传端口不复用旧路径**：旧 worktree 已灭，路径悬空；要求重选是唯一诚实行为。
- **D10 v1 含上传端口不可定时**：定时任务无文件持久化面；明确拒绝优于静默丢文件。
- **D11 不做端口集 OCC**：内容漂移用 400+重填收敛，复杂度不值（对比 `expectedWorkflowVersion`
  ——工作流场景是编辑器并发热改，agent 端口漂移频率低一个量级）。
- **D12 多文件上传做成 FileDropzone sibling 而非 `multiple` 布尔开关**：单/多文件的受控 props
  形态不同（`file: File|null` vs `files: File[]`），布尔开关会让两套契约在一个组件里互踩；
  sibling 共享样式与内部件，公共原语家族化（RFC-196 精神）。
- **D13 保留命名空间用 `/^__.*__$/` 整族拒绝**（设计门 P2-1）：逐注册表枚举（内建/
  deprecated/系统通道）会随注册表演进漂移；dunder 命名空间本就是运行时专用约定，整族拒绝
  一劳永逸，另加 `constructor`/`prototype` 毒键两枚。
- **D14 upload 端口 multipart-only**（设计门 P1-3）：路径值只能由服务端落盘产生，客户端字符串
  一律不信；这是把 RFC-020 upload 的服务端权威语义原样带进 agent 路径，不是新约束。

## 9. 测试策略（必写清单）

**shared（`packages/shared/tests/agent-launch-form.test.ts`）**

1. kind 映射矩阵逐行（§2.2 表全 kind 一条不少，含 `path<*>`、嵌套 list 兜底）。
2. promptTemplate golden（多端口字节锁 + 单端口也走信封 + 零端口返回 null）。
3. blocker：signal（顶层/嵌套）、非 `\w` 端口名、内建 token 撞名逐条。
4. required 默认必填 / 显式 false 可选的映射。

**backend（`packages/backend/tests/rfc218-agent-launch-ports.test.ts`）**

5. 端口化快照 golden：inputs/节点/边/模板与派生层一致，且过 `validateWorkflowDef` 全量上下文。
6. 零端口 byte-compat：`buildAgentHostSnapshot` 输出与 HEAD 现值深等（rfc165 A1 保持绿即锁）。
7. 启动校验矩阵：零端口带 inputs / 端口化带 description / 未知键 / 缺必填 / signal → 各 400。
8. multipart：agents 路由上传端落 `.agent-inputs/{port}`、端口值换行拼接、护栏（逃逸/accept/
   大小）与 `/api/tasks` 同套（共用解析器的回归锁：两路由对同一违规 fixture 报同一错误码）。
9. `task.inputs` 落库 = 各端口值；prompt 展开含围栏后的端口值、`{{…}}` 不二次展开。
10. scheduled：文本端口 payload 带 inputs 可保存可触发；含上传端口保存 400；火时端口漂移失败面。
11. relaunch 服务端视角：端口化任务再启动走 inputs 校验（不受旧快照影响）。

**frontend（vitest）**

12. 向导：端口化 agent 渲染端口表单（无 `wizard-description`）、零端口 agent 有描述框；
    chips / 上传 / 文本控件按 kind 出现；必填门控 canProceed；blocker 禁用启动。
13. 提交 body：端口化 stamp `inputs` 无 `description`，零端口反之（锁 `buildAgentStartBody`
    白名单——[feedback_launch_body_helper_whitelist] 回归防护）。
14. relaunch 预填交集 + upload 键剔除。
15. PR-1：FilesDropzone 多选/拖拽/去重/maxCount/删除/a11y（role 断言）；UploadPicker 不再含
    手搓 drag（源码层文本断言：`upload-picker__drop` 与 `onDragOver` 不得出现在 UploadPicker.tsx）。

**e2e（`e2e/task-wizard.spec.ts` 扩展）**

16. 声明两个文本端口的 stub agent：深链进向导 → 出现两个端口字段 → 填写 → 启动 → API 断言
    `task.inputs` 两键俱在；既有零端口用例不动。

**设计门修订新增（编号接续）**

18. relaunch 判别回归：真实 HEAD 版零端口快照（节点 id `__agent_input__`）判为**非**端口化
    （P1-1 反例锁）；`__agent_input_0__` 判为端口化。
19. 预检顺序锁：含上传的 agent 启动在 ACL 404 / `expectedAgentId` 409 / blocker 400 各失败
    分支下，断言 worktree 与 `.agent-inputs` 零文件落盘；delete/rename 在上传窗口内 409
    （预约罩全程）。
20. upload 端口 JSON 直传 → 400；multipart 下客户端同名文本键被落盘结果覆写。
21. 前端：切 agent A→B / workflow↔agent 后提交 body 只含当前 defs 键（state 残留不泄漏）；
    uploads state 同步清空。
22. 前端：深链 + agentsQ pending/error 时不渲染描述框、canProceed false（P1-5 屏障）。
23. 保留名矩阵：`__anything__` 整族、`constructor`/`prototype` → blocker；编辑器
    `validateAgentPortState` 对同名端口出警告（vitest）。
24. scheduled 保存期：两者皆无 / 未知键 / 缺必填 / blocker agent / 含上传端口 → 保存 400
    （`validateAgentLaunchShape` 与启动路径共用的回归锁）。
25. 长度边界：65536 字符处控件拦截 + 65537 提交被 schema 拒（前后端各一条）。

**守卫**

17. 源码锁：`tasks.new.tsx` 不得再出现 `kind === 'workflow' ?` 形态的 inputDefs 限定
    （表级 grep 锁，配合 12 的行为断言双保险）。

## 10. 设计门修订账（Codex review 2026-07-22，abadee24 → v2）

| # | finding | 处置 |
| --- | --- | --- |
| P1-1 | 遗留节点 id `__agent_input__` 命中 `__agent_input_` 前缀判别，全部存量任务被误判端口化、relaunch 丢 description | §5.4 改精确 `/^__agent_input_\d+__$/` + 测试 18 反例锁 |
| P1-2 | multipart 在 ACL/OCC/预约/F14 之前落文件，副作用先于校验、预约罩不住上传窗口 | §5.2 执行序固定：内存解析→完整预检链→worktree 就绪后落盘→finally 释放；测试 19 |
| P1-3 | JSON 分支可为 path 端口直传任意字符串 | §5.2 multipart-only + 服务端覆写；D14；测试 20 |
| P1-4 | seed/prune effect 被 `kind==='workflow'` 门住，切换对象后残留键撞未知键 400 | §6.1 effect 泛化 + body 按当前 defs 过滤双层；测试 21 |
| P1-5 | 深链下 agentsQ 未就绪时「查无行」≠「零端口」，误渲染描述框 | §6.1 数据就绪屏障（对齐 workflow detail-success 先例）；测试 22 |
| P2-1 | 只拦内建 token 漏 deprecated/系统通道/`__proto__` | §2.3 D13 dunder 整族 + 毒键；测试 23 |
| P2-2 | description/inputs 双 optional 后 scheduled 可存必死 payload | §5.3 抽 `validateAgentLaunchShape` 保存期共用；测试 24 |
| P2-3 | 后端保存警告无返回通道，AC-8 落空 | §2.3/D8 改前端编辑器 `validateAgentPortState` 接入；proposal AC-8 措辞同步 |
| P2-4 | 65536 上限不在控件层，前端全绿提交才 422 | §6.1 maxLength 贯通 + canProceed；测试 25 |
