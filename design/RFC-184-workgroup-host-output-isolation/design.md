# RFC-184 技术设计——工作组 host 轮输出隔离

> 承接 [`proposal.md`](./proposal.md)。任务分解见 [`plan.md`](./plan.md)。

## §1 根因回顾（代码级）

失败链（任务 `01KXFE9668F0TJ7D2P720F42SE`）：

1. `driveLeaderTurn`（`workgroupRunner.ts:947`）→ `resolveMemberAgent`（`:837`）返回**原样** `getAgent('coder')`，`coder.outputs=["software_design","test_design"]`、`coder.outputKinds={software_design:'markdown_file', test_design:'markdown_file'}`。
2. `hooks.runHostNode({ agent: coder, workgroupProtocolBlock: renderWgProtocolBlock('leader', …) })`（`:990`）→ scheduler `runHostNode`（`scheduler.ts:655`）→ `runNode({ agent: req.agent, … })`（`:742`）。
3. leader 按协议只产出 `<workflow-output>` 含 `wg_assignments`+`wg_decision`（node_run_events id 7240 实证）。
4. `parseEnvelope(envelope, coder.outputs)`（`runner.ts:1267`）——`parseEnvelope` 对**声明了但没产出**的端口补空串（`envelope.ts:381-384`：`for (name of declaredOutputs) ports.set(name, collected.get(name) ?? '')`）→ `software_design=''`、`test_design=''`。
5. RFC-049 逐 kind 校验（`runner.ts:1323-1346`）遍历 `parsed.ports`，`kind=outputKinds['software_design']='markdown_file'` → `resolvePortContent({rawContent:'', kind:'markdown_file'})` → `parseKind` 折成 `path<md>` → path handler 空串分支抛 `PortValidationError('port-validation-path-empty-path', 'path port content must be a worktree-relative path, got empty string')`（`shared/outputKinds/path.ts:104-105`）→ `status='failed'`、`failureCode='port-validation-failed'`。
6. `runNode` 返回 failed → `runHostNode` 命中 `if (result.status !== 'done')`（`scheduler.ts:909`）返回 `{status:'failed', errorMessage}` → `driveLeaderTurn` 循环 `throw new Error(msg)`（`workgroupRunner.ts:1034`）→ `driveWakeItem` catch，`item.kind==='leader'` → `reportFatal('workgroup leader turn failed', message)`（`:899-900`）→ 任务 `failed`。

第二层（被第一层掩盖）：`outputs = Object.fromEntries(parsed.ports)`（`runner.ts:1268`）只含声明端口，**未声明的 `wg_*` 端口进不了 `result.outputs`**（`parsed.undeclared` 仅被 `log.warn`，`runner.ts:1275`）。故即便第一层修掉，`result.outputs[WG_PORT_DECISION]` 仍是 `undefined` → workgroupRunner 报 "missing required port wg_decision"（`:1043`）。

## §2 方案：host 轮输出投影（用户选定）

核心：host 轮跑 `runNode` 时，把 agent 的 `outputs` **替换**为该 host 角色的 wg 协议端口、`outputKinds` **清空**。runNode 零改动即同时消解两层：

- `parseEnvelope(envelope, wgPorts)` 把 `wg_*` 当**声明端口**收集 → 进 `result.outputs`（解第二层）。
- `outputKinds` 为空 → RFC-049 逐 kind 校验对每个端口 `kind===undefined → continue`（`runner.ts:1326`）→ 不再有空串 path 校验（解第一层）。
- 成员 agent 自己的 `software_design`/`test_design` 从声明列表里消失 → 不解析、不校验、不入库（用户拍板"完全忽略"）；文件写入仍随 iso worktree 合并保留。

### §2.1 角色 → 端口映射（唯一事实源）

新增纯函数 `wgHostRolePorts(role: WorkgroupProtocolRole): string[]`，与 `WG_PORT_*` 常量同置于 `packages/shared/src/schemas/workgroupRuntime.ts`，**与 `renderWgProtocolBlock`（`workgroupContext.ts:294`）声明的端口逐一对齐**：

| role        | 端口（顺序不敏感）                                            |
|-------------|--------------------------------------------------------------|
| `leader`    | `wg_assignments`, `wg_messages`, `wg_decision`               |
| `worker`    | `wg_result`, `wg_messages`                                   |
| `fc_member` | `wg_result`, `wg_messages`, `wg_tasks_add`                   |

> 约束（源码文本锁 + 注释交叉引用）：这张表是 `renderWgProtocolBlock` 端口清单的机器可读镜像。任何一侧加/删端口，另一侧必须同步，否则"协议让 agent 产出的端口"与"引擎声明去解析的端口"漂移——漂移的端口会被 §2.3 的空串过滤悄悄吞掉。

### §2.2 投影点：`WorkgroupHostRunRequest` + scheduler `runHostNode`

`role` 只有 workgroupRunner 知道（leader / `free_collab?fc_member:worker`，见 `:1200-1202`），而 scheduler `runHostNode` 只拿到 `nodeId`（无法区分 worker vs fc_member）。因此：

1. **`WorkgroupHostRunRequest`（`workgroupRunner.ts` hooks 接口）新增可选字段 `hostOutputPorts?: string[]`**。三个 host 调用点填入 `wgHostRolePorts(role)`：
   - `:990` leader → `wgHostRolePorts('leader')`
   - `:1195` assignment → `wgHostRolePorts(config.mode==='free_collab'?'fc_member':'worker')`
   - `:1350` message → `wgHostRolePorts(role)`（`role` 同上）
2. **scheduler `runHostNode`（`scheduler.ts:655`）在调 `runNode` 前做投影**：
   ```ts
   const hostAgent = req.hostOutputPorts !== undefined
     ? { ...req.agent, outputs: req.hostOutputPorts, outputKinds: undefined }
     : req.agent
   // …runNode({ …, agent: hostAgent })
   ```
   `prepareNodeRunInjection(db, appHome, req.agent, log)`（`:656`）仍用**原** `req.agent`——注入只读 skills/mcp/dependsOn/permission，与 `outputs`/`outputKinds` 无关；投影只影响 `runNode` 的解析/校验侧。
   > `hostOutputPorts===undefined` → 不投影（`dynamicWorkflowRunner` 的编排 host 轮走原路，零回归）。

投影为何不污染 prompt：`renderUserPrompt`（`promptRender.ts:564-582`）当 `workgroupProtocolBlock!==undefined` 时 `trailing = workgroupProtocolBlock`，**替换**掉 `buildProtocolBlock(agentOutputs, agentOutputKinds)`。故 host 轮的 trailing 协议块本就由 wg 块生成，投影后的 `outputs`/`outputKinds` 不参与 prompt——投影只影响 `runNode` 的"解析 + RFC-049 校验"两处。**但**投影让 host 轮首次越过 RFC-049 校验、走到 `runNode` 的 `node_run_outputs` 持久化块——这引入第三处副作用，须由 §2.4 一并封住（Codex 设计门 P1，已独立核对源码确认）。

### §2.3 配套：空串端口过滤（必需，非可选）

投影把 wg 端口变成"声明端口"，于是 agent **漏产的**可选 wg 端口会被 `parseEnvelope` 补成 `''`（`envelope.ts:383`）。而 workgroupRunner 的必填/可选判定全靠 `!== undefined`：

```ts
const decisionRaw = result.outputs[WG_PORT_DECISION]           // :1038
const messagesRaw = result.outputs[WG_PORT_MESSAGES]           // :1040
const dispatches = assignmentsRaw !== undefined ? parse… : {ok:true,value:[]}  // :1045
```

若 `wg_messages` 漏产 → `''`（非 `undefined`）→ `parseWgMessagesPort('')` → `JSON.parse('')` 抛 → `{ok:false}`（`workgroupRuntime.ts:261-266`）→ **可选端口被误判协议违规**（回归）。

故 scheduler `runHostNode` 在成功返回处对 outputs 做空串过滤，还原"漏产 ⇒ undefined"契约：

```ts
const projected = req.hostOutputPorts !== undefined
  ? Object.fromEntries(Object.entries(result.outputs).filter(([, v]) => v !== ''))
  : result.outputs
return { status: 'done', outputs: projected }
```

作用点：`scheduler.ts:930`（discardWrites 早返回）与 `:968`（正常返回）两处 `{status:'done', outputs: result.outputs}`。抽一个局部 `projectOutputs(result.outputs)` 复用，避免两处漂移。

过滤后语义**逐一对齐**当前行为：

| 场景                    | 投影+过滤后 `result.outputs[…]` | workgroupRunner 判定                    |
|-------------------------|--------------------------------|-----------------------------------------|
| leader 产 `wg_decision` | `'{"action":…}'`               | 正常解析                                |
| leader 漏 `wg_decision` | `undefined`                    | `decision===null` → "missing required port wg_decision"（`:1043`，语义不变）|
| 漏 `wg_messages`        | `undefined`                    | `{ok:true,value:[]}`（可选，不报错）    |
| 漏 `wg_assignments`     | `undefined`                    | `{ok:true,value:[]}`（空派发）          |
| agent 产业务端口 `x`    | 不在声明列表 → `undeclared` → 不进 outputs | 忽略（用户拍板）           |

> 空 `<port name="wg_messages"></port>`（显式空）与漏产同归 `''`→过滤→`undefined`→无消息，语义一致、可接受。

### §2.4 host 轮不落 `node_run_outputs`（设计门 P1，必需）

**这是 §2.3 的空串过滤覆盖不到的第三处副作用。** §2.3 只过滤 scheduler 返回的 `result.outputs`（workgroupRunner 的**活**消费面），但 `runNode` 在**返回之前**、成功校验后把每个声明端口写进 `node_run_outputs`（`runner.ts:1382-1398`，`if(status==='done')` 遍历 `parsed.ports` INSERT，**含补出的空串 `wg_messages:''`**）。这是与 `result.outputs` **不同的持久化 sink**，过滤管不着。

**为什么有害**——`node_run_outputs` 是 clarify 老化的判据：`buildClarifyQueueContext` 用 `runIdsWithOutput`（`clarifyQueue.ts:152-158,363-371`：「有 ≥1 output 行 ⇒ 该 run 已产出」）经 `isTargetNodeConsumed` 决定哪些已答 Q&A 该老化。

- **不变式今日成立**：host 轮**从不**写 `node_run_outputs`——今天要么 RFC-049 校验失败（`status='failed'`→不落库），要么走 clarify 分支（不落库）。所以 clarify 老化、RFC-182 房间/抽屉、Outputs 视图等**所有** `node_run_outputs` 消费方，都已隐式假设「host run 零 output 行」。
- **投影打破它**：投影清空 outputKinds → RFC-049 校验对每个端口 `continue`（`runner.ts:1356`）→ `status` 保持 `done` → 持久化块首次对 host 轮生效，写入 `wg_*` 行。
- **具体反例**（Codex 抓、已核）：leader 发**信封合法但 wg 语义非法**的 `wg_decision`（如 JSON 畸形）→ `runNode` 返回 `done` 且**已落** `wg_*` 行 → workgroupRunner 在 `runNode` 之后才做 wg 语义校验（`:1042-1059`）判违规 → 协议重试新 run；但首个违规 run 已带 output 行 → `runIdsWithOutput` 计其「已产出」→ 老化掉重试仍需的已答 Q&A → **丢答案**。

**修法（保持不变式）**：host 轮跳过 `node_run_outputs` 持久化。wg 协议端口是**活**消费（workgroupRunner 读 `result.outputs` 后写入专表 `workgroup_assignments`/`workgroup_messages`），**从不**从 `node_run_outputs` 回读；跳过既安全又恰好复刻今日「host run 零 output 行」不变式。

- `RunNodeOptions` 新增 `persistDeclaredOutputs?: boolean`（默认 `true`，向后兼容）。scheduler `runHostNode` 调 `runNode` 时置 `persistDeclaredOutputs: req.hostOutputPorts !== undefined ? false : undefined`。
- `runner.ts:1382` 持久化块加守卫：`if (status === 'done' && opts.persistDeclaredOutputs !== false)`。**只**跳过 INSERT——`outputs = Object.fromEntries(parsed.ports)`（`:1268`）照算，`result.outputs` 照返回，§2.3 过滤照走。持久化与返回值两条路彻底解耦。
- 这是本 RFC 对 `runNode` 核心的**唯一**改动（一处布尔守卫），不改校验/解析/信封任何逻辑；用户选定的「投影」形态不变（非 option B 的「host 模式改解析」）。

> 边界：`dynamicWorkflowRunner`（`:301`）不传 `hostOutputPorts` → `persistDeclaredOutputs` 为 `undefined`（≠`false`）→ 照常持久化，零回归。

## §3 数据流（修复后）

```
driveLeaderTurn
  └─ leaderAgent = resolveMemberAgent(...)          // 原样 coder（outputs/outputKinds 保留）
  └─ hooks.runHostNode({ agent: leaderAgent,
                         hostOutputPorts: wgHostRolePorts('leader'),   // ← 新
                         workgroupProtocolBlock: renderWgProtocolBlock('leader',…) })
        └─ prepareNodeRunInjection(req.agent)       // 用原 agent：skills/mcp/deps 不变
        └─ hostAgent = {...req.agent, outputs: hostOutputPorts, outputKinds: undefined}  // ← 投影
        └─ runNode({ agent: hostAgent, persistDeclaredOutputs: false, … })   // ← persist 守卫
              └─ parseEnvelope(env, ['wg_assignments','wg_messages','wg_decision'])
                    → ports={wg_assignments:'[…]', wg_messages:'', wg_decision:'{…}'}
              └─ RFC-049 校验：outputKinds===undefined → 全 continue（无 path 校验）
              └─ 持久化块：persistDeclaredOutputs===false → 跳过 node_run_outputs INSERT  // ← §2.4
              └─ outputs = {wg_assignments:'[…]', wg_messages:'', wg_decision:'{…}'}      // 返回值照算
        └─ projectOutputs：过滤 '' → {wg_assignments:'[…]', wg_decision:'{…}'}   // ← 过滤
        └─ return {status:'done', outputs}
  └─ decisionRaw='{…}' ✓  assignmentsRaw='[…]' ✓  messagesRaw=undefined→[] ✓
  └─ 落 assignment、continue
```

## §4 契约变更清单

| 位置 | 变更 | 类型 |
|------|------|------|
| `shared/schemas/workgroupRuntime.ts` | 新增 `wgHostRolePorts(role)` 纯函数 + 导出 | 新增 |
| `workgroupRunner.ts` `WorkgroupHostRunRequest` | 新增 `hostOutputPorts?: string[]` | 向后兼容新增 |
| `workgroupRunner.ts` 三处 `runHostNode` 调用点 | 填 `hostOutputPorts: wgHostRolePorts(role)` | 接线 |
| `runner.ts` `RunNodeOptions` | 新增 `persistDeclaredOutputs?: boolean`（默认 true） | 向后兼容新增 |
| `runner.ts:1382` 持久化块 | 守卫 `&& opts.persistDeclaredOutputs !== false` | 行为（唯一 runNode 核心改动） |
| `scheduler.ts` `runHostNode` | 投影 agent + 传 `persistDeclaredOutputs:false`；成功返回处过滤空串端口 | 行为 |

零 schema / migration / 前端 / 新 WS。runNode 核心仅一处布尔守卫（§2.4），解析/校验/信封逻辑不动。

## §5 失败模式与边界

1. **worker vs fc_member 端口差异**：仅差 `wg_tasks_add`。fc_member 若产 `wg_tasks_add` 而 worker 场景漏产——两者本就走不同 role → 不同端口列表，映射表已区分，无串台。
2. **`wg_messages` 在 directMessages/blackboard 全关时**：协议块提示"omit the port entirely"（`workgroupContext.ts:303`），agent 漏产 → 过滤 → `undefined` → 空消息，正确。声明列表恒含 `wg_messages` 不构成问题（漏产被过滤）。
3. **clarify 轮**：host 轮的 clarify 走 `<workflow-clarify>` 分支（`runner.ts:1238` 起），`status` 保持 `done` 且 `outputs` 为空、不进 §2/§3 的 output 校验路径——投影对 clarify 轮无副作用（投影只改声明列表，clarify 分支根本不读 `parsed.ports`）。RFC-181 的 `clarify-forbidden` 压制、RFC-183 的 `delegated` 语义均不受影响。
4. **malformed 端口守卫**（`runner.ts:1295`）：先于 RFC-049 校验、对所有端口生效、与 outputKinds 无关——投影不改其行为（wg 端口若 `<port>` 不闭合仍会被判 malformed 重试，符合预期）。
5. **`dynamicWorkflowRunner`（RFC-167）host 轮**（`dynamicWorkflowRunner.ts:301`）：不传 `hostOutputPorts` → 不投影 → 保持"用编排 agent 自身 outputs 校验"的原行为。若未来其编排 agent 声明了文件 kind 输出会撞同一堵墙，但那是受控 builtin agent、独立议题，本 RFC 不接线（留可选开关即已铺好路）。
6. **retry_index / 多轮**：投影是 per-run 纯计算，不涉持久态；leader 协议违规重试（`WG_PROTOCOL_RETRIES`）每轮重新投影，幂等。
7. **`node_run_outputs` 不变式**（详见 §2.4）：host 轮经 `persistDeclaredOutputs:false` 保持"零 output 行"，与今日行为一致——clarify 老化（`runIdsWithOutput`）、RFC-182 房间/抽屉、Outputs 视图等所有 `node_run_outputs` 消费方无需改动、无回归。信封合法但 wg 语义非法的违规重试不再因首个 run 的残留 output 行误老化已答 Q&A。

## §6 测试策略（test-with-every-change）

RFC 的 `design.md §测试策略` 必写 case：

**纯函数 / 单元（首选可断言面）**
- `wgHostRolePorts`：`'leader'`→`{wg_assignments,wg_messages,wg_decision}`；`'worker'`→`{wg_result,wg_messages}`；`'fc_member'`→`+wg_tasks_add`。**并加一条"映射表 ⟺ renderWgProtocolBlock"一致性断言**：对每个 role，`wgHostRolePorts(role)` 与从 `renderWgProtocolBlock(role,…)` 文本里 grep 出的 `<port name="…">` 集合相等（锁 §2.1 漂移）。
- 投影函数（抽 `projectWgHostAgent(agent, ports)` 便于测）：`{...agent, outputs:ports, outputKinds:undefined}`，且 `skills`/`mcp`/`dependsOn`/`permission` 逐字段保留。

**runNode 真实路径回归（堵 stub 缺口——本 RFC 的核心锁）**
- **红→绿对照**：构造一段只含 `wg_assignments`+`wg_decision` 的 stdout envelope，喂 `runNode`：
  - (红/根因锁) agent = 声明 `outputKinds:{software_design:'markdown_file'}` 的原样 agent → 断言 `status==='failed'` 且 `errorMessage` 前缀 `port-validation-path-empty-path`（锁住"不投影就挂"的机制，未来若有人误删投影立刻红）。
  - (绿/修复) agent = 投影后（`outputs=[wg 端口], outputKinds:undefined`）→ 断言 `status==='done'`、`outputs` 含 `wg_decision`/`wg_assignments`、**无** `port-validation-*`。
- **可选端口语义**：投影 agent 只产 `wg_decision`（漏 `wg_messages`/`wg_assignments`）→ runNode `done`，配合 runHostNode 过滤后 `outputs` 不含空串键（在能触到 runHostNode 的集成层断言，或对 `projectOutputs` 纯函数单测）。
- **§2.4 持久化守卫（设计门 P1 回归锁）**：投影 agent 产 `wg_assignments`+`wg_decision`（漏 `wg_messages`）经 `runNode({persistDeclaredOutputs:false})` → 断言 (a) `status==='done'`、`outputs` 含两非空端口；(b) **`node_run_outputs` 该 run 零行**（`SELECT count(*)==0`）——锁住"host 轮不落库"不变式，直击 clarify 老化误吞。再补一条对照：`persistDeclaredOutputs` 缺省（普通节点）时同 envelope **落库**行数>0，证明守卫只作用于 host 轮。
- **普通节点零回归**：非工作组 agent（有 `markdown_file` 输出）漏产该端口 → 仍 `port-validation-path-empty-path`（既有 RFC-049 测试若已覆盖则复用/引用，勿重复）。

**源码文本锁（兜底，运行时组件难直接覆盖时）**
- 断言 `workgroupRunner.ts` 三处 `runHostNode(` 调用均带 `hostOutputPorts`（grep 计数 == 3，或 `hostOutputPorts:` 出现 ≥3）。
- 断言 `scheduler.ts` `runHostNode` 内出现投影（`outputKinds: undefined`）、`persistDeclaredOutputs: false` 与过滤（`filter(([, v]) => v !== '')` 或抽出的 `projectOutputs`）。
- 断言 `runner.ts` 持久化块带 `persistDeclaredOutputs !== false` 守卫（防未来重构悄悄恢复 host 轮落库）。

测试文件命名体现所锁回归，如 `workgroup-host-output-isolation.test.ts`，顶部注释链接本 RFC 与 F42SE 事故。
