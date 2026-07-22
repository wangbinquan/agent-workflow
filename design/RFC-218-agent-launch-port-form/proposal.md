# RFC-218 单 agent 启动端口化表单与启动上传控件收敛 — proposal

状态：Draft（2026-07-22）
发起：用户（「启动任务时，agent 定义了输入端口就该按端口填写，而不是任务描述」+「工作流启动里的上传文件太丑，改成创建 skill/agent 那种上传体验」）

## 1. 背景

### 1.1 输入端口不驱动启动表单

RFC-165 的单 agent 启动本来就是「合成宿主工作流 → 走正常 runScope 引擎」——描述框的值经由一个写死的
`description` 输入端口注入 agent（`agentLaunch.ts:88-104`），引擎层零分支。RFC-166 又给 agent 加了
声明式输入端口（`agent.inputs`），但当时定位是**纯元数据**：只进能力卡与 RFC-167 动态编排的接线匹配，
「do NOT enter the spawn path」（`packages/shared/src/schemas/agent.ts:26-35`）。

结果是割裂：工作流启动第 3 步会按 `definition.inputs[]` 渲染动态表单（text/enum/files/git/upload），
而单 agent 启动无论 agent 声明了什么端口，一律只有一个「任务描述」框
（`tasks.new.tsx:678` 明确 `inputDefs = kind === 'workflow' ? … : []`）。一个声明了
`report` + `style_guide` 两个输入端口的审稿 agent，用户只能把两样东西手工揉进一段描述里。

### 1.2 启动上传控件是视觉孤岛

启动页 `kind:'upload'` 输入用的是 RFC-020 手搓的 `UploadPicker`（小按钮 + 裸列表 + 自写 drag
处理、无拖拽视觉反馈、无 a11y），而 skill 导入 / agent 导入 / workflow 导入早已收敛到 RFC-196 公共
`FileDropzone`（拖拽高亮 / 已选文件卡片 / 替换删除 / focus 与 role=alert 完整）。按
CLAUDE.md「Frontend UI consistency」原则这是遗留回归面。

## 2. 目标

1. **端口化启动表单**：agent 声明了 ≥1 个输入端口时，启动向导第 3 步按声明渲染端口表单
   （每端口一个控件，label=端口名、hint=端口 description），**替换**任务描述框；每个端口值
   经宿主快照的对应输入端口注入 agent prompt。
2. **零端口 agent 完全不变**：未声明输入端口的 agent，界面、线上契约、宿主快照字节级维持现状。
3. **kind 感知控件**：string/markdown → 多行文本；path\<ext\> → 文件上传（落 worktree，端口值=
   路径）；list\<string|markdown\> → 逐项输入（ChipsInput）；list\<path\<ext\>\> → 多文件上传；
   signal → 该 agent 禁止手动启动（前端禁用 + 后端 400）。
4. **上传体验收敛**：启动页上传控件重建在 `FileDropzone` 家族上（最小扩展出多文件形态），
   workflow 与 agent 两条启动路径共用；删除手搓 drag 代码。

## 3. 非目标

- 不改工作流启动路径的端口语义（它已经是端口化表单）；不改引擎 / 调度器 / 校验器。
- 不给 workflow 的 `inputs[]` 增加新 kind（enum/git 等不反向映射到 agent 端口）。
- 不做「agent 端口 → 定时任务上传文件持久化」：v1 含上传端口的 agent 不可保存为定时任务（明确报错）。
- 不做跨端口条件显隐、端口级默认值等表单高级能力。
- 不改 RFC-167 动态编排对 `agent.inputs` 的既有消费（能力卡 / 接线匹配语义不动）。

## 4. 用户故事

- **US-1**：作为运营同学，我启动「周报审稿」agent（声明 `report`、`style_guide` 两个端口）时，
  看到两个独立字段而不是一个描述框；分别粘贴后启动，agent 的 prompt 里两块内容边界清晰。
- **US-2**：作为 agent 作者，我声明 `attachments: list<path<pdf>>`，用户启动时直接拖 PDF 进
  上传框；文件落进任务 worktree，agent 拿到的是逐行的相对路径。
- **US-3**：作为老用户，我启动一个从未声明端口的 agent，一切与今天完全一样（包括 relaunch 老任务）。
- **US-4**：作为任何用户，我在启动页遇到的上传控件与导入 skill/agent 时的体验一致：可拖拽、有
  高亮反馈、已选文件成卡片、可逐个删除。

## 5. 验收标准

- **AC-1** 声明 ≥1 输入端口的 agent：启动第 3 步按声明顺序渲染端口表单，无「任务描述」框；
  提交 body 携带 `inputs` map、不携带 `description`。
- **AC-2** 零端口 agent：宿主快照、启动 body、界面与现状字节级一致（`rfc165-agent-launch.test.ts`
  既有断言不改语义地保持绿）。
- **AC-3** kind 映射逐条生效：string/markdown → 多行文本（markdown monospace）；path\<ext\> →
  单文件上传（按 ext 过滤，`*` 不过滤）；list\<path\<ext\>\> → 多文件上传；list\<string|markdown\>
  → ChipsInput 逐项；其余合法 kind（如嵌套 list）→ 多行文本兜底、原文透传。
- **AC-4** 端口 kind 含 `signal`（任意嵌套层）：前端启动按钮禁用并给出原因；后端 400
  （`agent-launch-invalid`，issue 指明端口）。
- **AC-5** required 语义：`required !== false` 的端口必填（前端拦 + 后端拦）；`required:false`
  可空，空值以空端口块进入 prompt。
- **AC-6** 端口值以统一 XML 端口块（`<workflow-input><port name="…">…</port></workflow-input>`）
  进入 agent prompt；单端口也走信封；用户文本中的 `{{…}}` 不被二次展开（继承 RFC-165 性质）。
- **AC-7** 上传端口：文件落 worktree `.agent-inputs/{port}/`，端口值 = 换行拼接的 repo 相对路径
  （与 workflow upload/files 端口的既有 wire 约定一致）；`POST /api/agents/:name/tasks` 支持
  multipart，与 `/api/tasks` 共用同一套解析 / 落盘 / 安全护栏（路径逃逸、MIME 嗅探、大小限制）；
  upload 端口**只认 multipart**——纯 JSON 为其直传路径字符串被 400 拒绝，multipart 下服务端
  落盘结果覆写客户端同名文本；校验全部通过之前零文件落盘，启动预约罩住整个上传+启动窗口。
- **AC-8** 端口名不能作模板 token（非 `\w+`、`/^__.*__$/` 保留族、record 毒键）时：启动被明确
  拒绝，错误信息指出端口名与原因；agent 端口编辑器对这类名字实时警告（不阻断保存）。
- **AC-9** relaunch：文本类端口预填原值；上传类端口要求重选（旧路径不复用）；零端口老任务
  relaunch 行为不变。
- **AC-10** scheduled：纯文本端口 agent 可定时（payload 携带 `inputs`，触发时按当时的 agent 定义
  重新校验）；保存期跑与启动同一套形态校验（两者皆无 / 未知键 / 缺必填 / blocker / 含上传端口
  → 保存即 400，不允许存下必然每次火失败的定时任务）。
- **AC-11** 上传控件收敛：启动页 upload 输入呈现 FileDropzone 家族体验（拖拽高亮 / 已选卡片 /
  逐文件删除 / a11y），`UploadPicker` 手搓 drag 处理删除；与 skill/agent 导入对话框视觉对齐
  （截图自查，light + dark）。
- **AC-12** 门槛：`typecheck + lint + test + format:check` 全绿，前端 vitest 全绿，Playwright e2e
  更新并绿，`build:binary` smoke 通过。

## 6. 风险与迁移说明

- **行为变化（有意）**：已存在的、此前仅作为元数据声明了 `inputs` 的 agent，下次启动起将看到
  端口表单而非描述框，且所有默认必填端口必须填写。这正是本 RFC 的目的，但需要在 release note
  里明示。老任务的 relaunch 若 agent 已端口化，原 `description` 不再预填（表单形态已变）。
- **端口名合法性**：RFC-166 未约束端口名字符集，存量数据可能有非 `\w` 名字；本 RFC 采取
  「启动期拦截 + 保存期警告」而非收紧 schema（避免存量读路径破坏），见 design.md D8。
