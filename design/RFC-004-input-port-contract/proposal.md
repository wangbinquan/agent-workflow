# RFC-004 Proposal — Input 节点端口契约统一 + 自动同步 `definition.inputs[]`

> 状态：Draft（2026-05-15）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)

## 1. 背景

线上实测（daemon 1.15.0 + `coder` agent + workflow `01KRN2AJT8JCPGX40QRGFVR700`）：用户从画布建好"`input(requirement) → agent`"两节点一边的简单工作流，点 Launch 起 task `01KRNJXKNSXR8C1DHSCCCWHDD4`，30s 后失败 `no <workflow-output> envelope found in stdout`。

排查链路：

1. **Launcher 上没有 requirement 输入框** —— `workflows.launch.tsx:86` 从 `workflow.definition.inputs[]` 渲染表单字段；该 workflow 的 `inputs: []` 是空数组。task 因此带 `inputs: {}` 启动。
2. **就算 launcher 填了值也送不到 agent** —— 边定义 `source.portName: 'requirement'`、`target.portName: 'requirement'`；但 scheduler 把 input 节点的产出**硬编码**写到端口 `'out'`（`scheduler.ts:319`），`resolveUpstreamInputs` 按 `portName === 'requirement'` 查 `nodeRunOutputs` 永远拿不到，agent 总是收到空 `## requirement`。
3. **空 prompt 触发 opencode 1.15.0 静默退出** —— `coder` 的 `bodyMd` 为空，user prompt 只剩协议尾巴。手动在 shell 用同样 inline config + 空 requirement prompt 复跑，opencode 进程跑了几分钟 0 字节 stdout 才被手动 kill；线上那次 30s 进程退 0、`node_run_events` 0 行、tokens 全 0。runner 进入"clean exit + 空 stdout"分支 → status=done → envelope=null → 改写为 failed。这是症状不是根因。

整件事是**契约不一致**的连锁失败：

| 层 | 当前实现 | 文件 |
| --- | --- | --- |
| 设计权威 | input 节点产出端口名 = `out`（YAML 样例 `in_1.out → worker_1.requirement`） | `design.md:510` |
| scheduler 运行时 | input 节点产出端口名 = `'out'`（硬编码） | `scheduler.ts:319` |
| backend 测试 fixture | edge source.portName = `'out'` | `scheduler.test.ts:125` |
| validator | input 节点输出端口集合 = `{inputKey}` | `workflow.validator.ts:134` |
| 画布渲染 | input 节点右侧 source handle label = `inputKey` | `WorkflowCanvas.tsx:608` |
| RFC-003 行为 | drop 落 catch-all 时 `target.portName ← source.portName`（=`inputKey`） | `canvas-connect.ts` |

设计文档站在 `out` 一边，运行时和测试也是；但用户能见到的所有 UI（画布、validator、RFC-003 默认 wiring）都站在 `inputKey` 一边。两边都被半实现，导致用户走画布是没法跑通的——这条路径没有任何已有测试覆盖（`scheduler.test.ts` 三处 input 节点全用 `portName: 'out'`，与画布产出形态不符）。

此外，**编辑器在新增 input 节点时只 patch 节点本身，从来不维护 `definition.inputs[]`**。`nodePalette.ts:68-76` 给新 input 节点设了 `inputKey`，但 `definition.inputs` 数组没动；后续用户改 inputKey、删 input 节点也都不会同步。当 launcher 想拉出"需求描述"这种表单字段时只能空手而归。

### 1.1 为什么要现在修

- 这是**从画布走 happy path 直接跑死**的 bug，新用户第一次用 Launch 就撞上（线上案例就是这种）。
- RFC-003 刚把"画布建第一条入边"打通，立即暴露了下游契约不一致。在此之前用户根本拉不出边，相当于被前一道墙挡住没机会撞这道墙。
- v1 路线图已经 81/81 收尾，没有"M2/M3 编辑器后续迭代"这种伞挂这两类修复；走 RFC 是合规路径。

### 1.2 本 RFC 不动哪些地方

- **不动**输入节点 → agent 之外的图结构（agent-multi 的 sourcePort / wrapper-* / output 节点 bindings 全部不在范围内）。
- **不动** RFC-003 落地的 catch-all handle / EdgeInspector / `translateInboundConnection`。
- **不动**协议层 `renderUserPrompt`（`{{port}}` 替换 + 未引用 port 追加章节的语义）。

## 2. 目标

**做**

1. **统一 input 节点端口名 = `inputKey`**：scheduler 把 `portName: 'out'` 改为 `portName: inputKey`；validator 的 `outs.add(inputKey)` 与此对齐；backend 测试 fixture 改为 `source.portName: inputKey`；`design.md:510` YAML 样例同步更新。统一后从画布建的边、validator 校验的端口名、scheduler 写的端口名、edge resolver 读的端口名**完全一致**。
2. **编辑器维护 `definition.inputs[] ↔ input 节点 inputKey` 双向同步**：
   - 新增 input 节点：自动追加一条 `{kind: 'text', key: inputKey, label: inputKey, required: true}` 到 `definition.inputs[]`。
   - 在 NodeInspector 里改 `inputKey`：同步重命名 `definition.inputs[].key` 与该节点所有出边的 `source.portName`（边上 target 那边按用户原 wiring 保留，无连带改写）。
   - 删除 input 节点：从 `definition.inputs[]` 移除对应 entry（出边在原有的"删点级联删边"路径里被回收，不重复实现）。
3. **NodeInspector 让用户编辑 launcher 字段元数据**：input 节点抽屉里在 `inputKey` 之外新增 `kind`（text/files/enum/git 下拉）/ `label`（默认等于 key）/ `required`（开关）/ `description`（textarea）四个字段，落进 `definition.inputs[]` 对应 entry。这是把 launcher 字段的来源显式化、可视化。
4. **Validator 加一条规则 `input-key-not-declared`**：input 节点的 `inputKey` 必须出现在 `definition.inputs[]` 里；反向规则 `input-orphan-declared`（`definition.inputs[]` 有 key 但没 input 节点引用）作为 warning（非阻塞 task 启动）记录但不报错，让用户可以临时禁用某条 input 字段。
5. **回写老 workflow**：用户的既有 DB 行（`inputs: []` + 有 input 节点 + 边按 inputKey 命名）一旦在编辑器里被打开，画布的自动同步逻辑会立刻识别"input 节点存在但 inputs 数组缺 entry"，补齐缺失项并触发 RFC 既有 1s 自动保存，DB 自动迁到正确形态。**不做后端 startup 大扫除迁移**——风险面小、可回滚。

**不做**

- 不引入"端口名与 inputKey 解耦"的额外抽象层。
- 不改 launcher 的字段渲染逻辑（`workflows.launch.tsx` 早已根据 `definition.inputs[].kind` 分支渲染 text/files/enum/git 四种 picker）。
- 不在 YAML 导入路径上做特殊兼容：YAML 是用户写的产物，要求和编辑器一致；导入时 validator 跑新规则，不满足直接给清单提示。
- 不在 daemon 启动时做 DB 扫库迁移；本 RFC 把回写责任放在编辑器一侧。

## 3. 用户故事

**S1（线上 bug 复盘）**：用户在画布上拖一个 input 节点（默认 `inputKey: requirement`），拖一个 coder agent 节点，从 input 右侧 handle 拉一条边到 agent 的 catch-all 区。点 Launch → launcher 页应该自动出现"requirement"文本框；用户填入需求文字 → 点 Start → task 跑起来，agent 收到 `## requirement\n用户填的内容\n...` → 输出 envelope → task done。**当前**这一整条都断在第 2-3 步。

**S2（重命名 inputKey）**：用户已经搭好了上述工作流，决定把 `requirement` 改成 `feature_spec`。在 NodeInspector 改 inputKey → input 节点出边的 source.portName 同步变 `feature_spec`、`definition.inputs[].key` 同步变 `feature_spec`、launcher 表单 label 默认跟着变 `feature_spec`、agent 节点的 target.portName **不动**（用户在 wiring 时显式选了某个名字，这条命名是 agent 侧的事）。改名前后画布 + 校验 + launcher 都自洽。

**S3（自定义 launcher label / 改 kind）**：用户希望把"feature_spec"在 launcher 上显示成"功能描述（中文）"，并把 `kind` 从 `text` 改成 `files`（让用户上传多个 .md）。NodeInspector input 抽屉里有这四个字段；改完保存后 launcher 立刻变多文件 picker。

**S4（删除 input 节点）**：用户改了主意，删掉 input 节点。`definition.inputs[]` 对应 entry 自动消失；launcher 上字段也跟着消失；删点连带删边的既有逻辑回收所有出边。

**S5（YAML 手写 / 导入老仓 YAML）**：用户用 `design.md:510` 旧样例（`source.portName: out`）的 YAML 导入。validator 报 `edge-source-port-missing`（因为新契约下 input 节点的输出端口名就是 inputKey 而不是 `out`），用户根据提示在 YAML 里把 `out` 改成 `requirement` 后导入成功。

## 4. 验收标准

**功能**

- A1 全新 workflow：拖 input(`requirement`) + agent + 一条边 → launcher 出现 requirement 框 → 填值 → task 跑通 → envelope 落库 → status=done。**这是 S1 的 e2e 断言。**
- A2 NodeInspector input 抽屉显示 5 字段（`inputKey / kind / label / required / description`），改任一字段都会触发自动保存。
- A3 改 inputKey：节点出边 source.portName 同步、`definition.inputs[].key` 同步、launcher label 跟着 key 显示（除非用户已显式改过 label）。
- A4 删 input 节点：`definition.inputs[]` 对应 entry 消失。
- A5 Validator 新增 `input-key-not-declared` 规则；老 workflow（`inputs: []` + input 节点）：编辑器一打开就触发 auto-save 修正；下次 GET 拿到的 definition.inputs[] 已经补齐。
- A6 backend `scheduler.test.ts` 三处 input 节点的 fixture 全部改为 `source.portName: inputKey`，并新增**线上 bug 复盘 case**：input(requirement) → agent，task launch 时 inputs={requirement: 'x'}，scheduler 跑完 agent 节点的 promptText 包含 "x"。
- A7 `design.md:510` YAML 样例同步改为 `source: { nodeId: in_1, portName: requirement }`。

**非功能**

- B1 `bun run typecheck && bun run test && bun run format:check` 全绿。
- B2 RFC-003 既有行为不退化：catch-all handle / EdgeInspector / `translateInboundConnection` / `deriveSelection` 四组测试不动。
- B3 frontend test 数从当前 235 至少 +12（input 节点 inspector 4 字段 + syncInputDefs pure helper 4 case + 重命名级联 + 删点级联）。
- B4 backend test 数从当前 340 至少 +6（scheduler 复盘 case + validator 新规则 3 case + workflow PUT 接受新 inputs entry shape 1 case + 旧 fixture 全部调整后维持原校验数）。
- B5 旧 DB workflows 行不需要手动迁移：用户打开一次自动修。

**回归防护**

- C1 `tests/scheduler-input-port-contract.test.ts` 顶部注释链回本 RFC + 标"locks in port-name=inputKey contract; if it goes red, check both scheduler.ts:319 and workflow.validator.ts:134 in lock-step"。
- C2 frontend `tests/input-node-sync.test.ts` 覆盖 syncInputDefs(纯函数) 五种 case：新增节点补 entry / 删节点回收 entry / 改 inputKey 重命名 entry + 出边 source.portName / inputs 数组已有同 key 时不创建重复 / 用户改过 label 后改 inputKey 不覆盖 label。
- C3 frontend `tests/launcher-renders-from-input-node.test.tsx` 1 case 锁住"input 节点 + 同名 inputs entry → launcher 渲染该 field"的契约，防止以后有人把这两条解耦时偷偷把 launcher 改成扫节点（绕过 entry）。
