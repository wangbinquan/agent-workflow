# RFC-253 · 脚本执行节点 —— 技术设计

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。
> 决策编号 D1–D28 引用 proposal §5。

## 0. 既有锚点（本设计要挂上去的承重结构）

写代码前必须先读的现状，全部是本 RFC 的耦合点：

| 机制 | 锚点 | 与本 RFC 的关系 |
|------|------|----------------|
| NodeKind 枚举 | `packages/shared/src/schemas/workflow.ts:33-45` | 加 `'script'` |
| 行为矩阵 | `packages/shared/src/node-kind-behavior.ts:100-177` | `satisfies Record<NodeKind,…>` ⇒ 不填就编译不过 |
| 端口声明矩阵 | `packages/shared/src/nodePorts.ts:151-273` | 同上 |
| 节点引用清单 | `packages/shared/src/workflow-node-references.ts:37-78` | 同上；另需新增 `opaqueFields` 描述符（见 §1.2） |
| 画布组件表 | `packages/frontend/src/components/canvas/WorkflowCanvas.tsx:159-178` | 同上 |
| Inspector 表 | `packages/frontend/src/components/canvas/NodeInspector.tsx:96` | 同上 |
| 调色板表 | `packages/frontend/src/components/canvas/nodePalette.ts:65-197` | 同上 |
| 节点默认尺寸 | `packages/frontend/src/components/canvas/wrapperFit.ts:20` | 同上 |
| 调度分发 | `services/scheduler.ts:3912-4180`（`runOneNode`） | 新增 `script` 分支，落在 RFC-146 穷尽性守卫之前 |
| 上游取值 | `services/scheduler.ts:8438-8500`（`resolveUpstreamInputs`） | **原样复用**：按 `edge.target.portName` 聚合，同名多入以 `\n\n---\n\n` 拼接 |
| iso 工作区 | `services/isolatedAgentRun.ts:57`（`createIsoUnderLock`）/ `:88`（`persistIsoBase`）/ `services/nodeIsolation.ts:928`（`mergeBackNodeIso`）/ `:1252`（`discardNodeIso`） | 原样复用 |
| 信封解析 | `services/envelope.ts:240`（`extractLastEnvelope`）/ `:357`（`parseEnvelope`）/ `:509`（`resolvePortContentDetailed`） | 原样复用（含 RFC-200 nonce） |
| 容器化 | `services/sandbox/index.ts:84`（`wrapSandbox`）/ `policy.ts` / `sandbox/containmentCoordinator.ts:28-43,777` | **复用** `policy.readOnlyAllowSubtrees`（RFC-251 并发提交 `37496943` 已引入）与 `runner-filesystem-v1`；只新增出网围栏能力 + **一个** netless profile |
| daemon 侧 git 收口 | `packages/backend/src/util/gitHardening.ts`（RFC-252 G1，提交 `40535c0e`） | 本 RFC 是它的第二个消费者；`filter.*` / `diff.*.textconv` 残留由它自己登记，不在本 RFC 关闭 |
| 活性证据链 | `services/runLiveness.ts:100`（`livenessSourceOfKind`） | **第 8 处**穷尽点（设计门只列到 7 处，编译器逼出的这处不在其中） |
| 权限目录 | `packages/shared/src/schemas/permission.ts:62-177,351-401` | 新增 `scripts:author` |
| MCP env 校验 | `packages/shared/src/schemas/mcp.ts:47-80` | **原样复用**（键名 / NUL / 动态加载器变量） |
| 密钥脱敏 | `packages/shared/src/intentSecretSlots.ts` | 新增脚本节点 env 的 carrier |
| run 私有目录 | `services/inventory.ts:133`（`runRootFor`） | 脚本正文与输入落盘位置 |
| 流式截断 | `services/runner.ts:2782-2808`（`MAX_STREAM_LINE_CHARS` / `MAX_AGENT_TEXT_CHARS` / `appendBoundedTail` / `pumpLines`） | 抽进受控 spawn 原语共享 |

## 1. 节点模型

### 1.1 Schema

`packages/shared/src/schemas/workflow.ts` 新增（`WorkflowNodeSchema` 是 `.passthrough()`，严格形状按
`CallWorkflowNodeSchema` 的先例单列一个 schema，由服务层写入校验消费）：

```ts
export const SCRIPT_LANGUAGES = ['python', 'bash', 'node'] as const          // D13
export const ScriptLanguageSchema = z.enum(SCRIPT_LANGUAGES)

/** 单端口模式的固定端口名（D22）。 */
export const SCRIPT_DEFAULT_OUTPUT_PORT = 'stdout' as const

/** 依赖条目：仅「名字[比较符版本]」与 npm scope 形态；显式拒绝 flag / URL / 路径 / VCS（D14, AC-19）。 */
export const SCRIPT_DEPENDENCY_RE = /^(@[a-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*(\[[\w,.-]+\])?([=<>!~^]=?[\w.*+-]+)?$/

export const ScriptOutputPortSchema = z.object({
  name: z.string().min(1).max(64),
  /** AgentOutputKind 语法串；缺省即 'string'（D11）。 */
  kind: z.string().min(1).optional(),
}).strict()

export const ScriptNodeSchema = WorkflowNodeSchema.extend({
  kind: z.literal('script'),
  language: ScriptLanguageSchema,
  /** 内联正文（D1）。平台**不做任何模板替换**（D5）。 */
  script: z.string().max(256 * 1024),
  /** 省略/空 ⇒ 单端口模式；非空 ⇒ 信封模式（D3）。 */
  outputs: z.array(ScriptOutputPortSchema).max(32).optional(),
  /** 预装依赖（D9）；language==='bash' 必须为空。 */
  dependencies: z.array(z.string().min(1).max(200)).max(64).optional(),
  /** 进程环境覆盖（D10）；键名校验复用 mcpEnvIssues。 */
  env: z.record(z.string(), z.string()).optional(),
  /** 缺省 'allow'（D4）。 */
  network: z.enum(['allow', 'deny']).optional(),
  /** 缺省 false：可写 + iso + merge-back（D8）。 */
  readonly: z.boolean().optional(),
}).passthrough()
```

`$schema_version` **不 bump**（D28）。

### 1.2 行为矩阵与端口声明

```ts
// node-kind-behavior.ts（D26）
script: { retryCascade: 'mint-placeholder', isProcess: true, isAgent: false, settlesWithoutRow: false }

// nodePorts.ts PORT_DERIVERS
script: ({ node }) => ({
  ...NO_PORTS,
  dataInputs: [],                                  // agent 先例：入参由边推导，不声明
  dataOutputs: readScriptOutputs(node),            // outputs ?? [{ name: 'stdout' }]
})

// workflow-node-references.ts
script: NO_NODE_REFERENCES                          // 无 nodeId / portRef 引用
```

**棘轮（设计门 F1，部分驳回）**：unmanaged-field 棘轮并没有「已知非引用字段」登记表——它只识别**引用形状**
（`/nodeId$/i` 键名、`nodeIds`/`rerunnable` 数组、`PortRef` 形状）。但评审说「脚本的字段都不会告警」也不成立：
`env` 的**键名由用户决定**，一个叫 `FOO_NODEID` 的普通环境变量会命中 `/nodeId$/i`，产生 `action:'abort'` 的
假告警并卡住复制粘贴。正解是给描述符加 `opaqueFields`——声明「此子树是用户数据、按构造不含引用」，
让保证被**写出来**，而不是让启发式去猜用户起的键名。脚本节点声明 `opaqueFields: ['env', 'script']`。

## 2. 数据流

### 2.1 入参（D5）

上游取值**完全复用** `resolveUpstreamInputs`（`scheduler.ts:8438`）：键是**入边的 `target.portName`**，同名多入
以 `\n\n---\n\n` 拼接——与 agent 的 `{{port}}` 变量同一份语义，不新造一套。

端口名 → 环境变量名的规范化：

```
suffix(name) = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')，若首字符是数字则前置 '_'
AW_PORT_<suffix>        端口值（内联档）
AW_PORT_FILE_<suffix>   端口值文件的绝对路径（落盘档）
```

**溢出规则**：单个值的 UTF-8 字节数 > `SCRIPT_ENV_INLINE_LIMIT`（32 KiB）或本次全部内联值累计 > 256 KiB 时，
该值改为落盘：写 `$AW_INPUT_DIR/<原始端口名>`，只设 `AW_PORT_FILE_<suffix>`、**不设** `AW_PORT_<suffix>`
（避免脚本读到被截断的半截值）。`AW_INPUT_DIR` 位于本次运行的 run 私有目录（`runRootFor(taskId, nodeRunId)/inputs`），
不在工作区里——脚本的输入不能污染 `git_diff`。

**名字冲突**：两个入边端口名规范化后撞车（如 `my-port` 与 `my_port`）⇒ 校验器规则 `script-port-env-collision`
在保存期报错，不留到运行期。`AW_PORT_NAMES`（JSON：原始端口名 → suffix）让脚本能精确反查。

### 2.2 出参（D3）

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| 单端口 | `outputs` 缺省 / 空 | **原始 stdout 字节**（按 D27 截断后）写进端口 `stdout` |
| 信封 | `outputs` 非空 | 用 `extractLastEnvelope(stdout, nonce)` + `parseEnvelope` 解析；每个声明端口按其 kind 走 `resolvePortContentDetailed`（RFC-049/080 的同一条校验链） |

信封模式下 nonce 是**强制**的（AC-5）：脚本从 `AW_ENVELOPE_NONCE` 读取，打印
`<workflow-output nonce="$AW_ENVELOPE_NONCE">…</workflow-output>`。理由与 RFC-200 一致，且对脚本更硬——
脚本回显上游内容（`print(os.environ['AW_PORT_DIFF'])`）是常见写法，上游内容里夹带的伪造信封必须打不中。
nonce 直接复用 `node_runs.envelope_nonce` 与 `loadRunEnvelopeNonce`。

**端口值必须与事件流分开累加（设计门 F8）**：现有 `pumpLines` 会丢空行与尾换行（`a\n\nb\n` → `a\nb`），
`appendBoundedTail` 的上限还是 UTF-16 code unit。逐行事件继续走行泵，**端口值走一条独立的原始字节累加器**，
否则单端口模式的「整个 stdout」是假的。

**缺端口不会自动失败（设计门 F9）**：`parseEnvelope` 把缺失的声明端口补成空串、另行报告 `missingDeclared`，
现有 runner 只告警。脚本执行器必须显式把 `missingDeclared` 判成 `script-port-missing`、把 `malformedPorts`
判成 `script-envelope-malformed`。

**缺信封 / 端口缺失 / kind 校验失败** ⇒ 节点失败并进重试（D7）。与 agent 不同的是**没有 same-session
follow-up**（`decideEnvelopeFollowup` 是模型语义），脚本一律 fresh retry。

**`path<…>` 族 kind 在 v1 被校验器拒绝**（proposal §3 非目标）：它的正确性依赖 RFC-193 emit-time 归档链
（`portArtifacts.ts` + `scheduler.ts` 把 `portFilePaths` 并入 merge 快照），少了它端口内容会在 iso 回收后断链。

## 3. 运行时契约（脚本能看到的全部约定）

进程环境是**最小集**（AC-16），不继承 daemon 的 `process.env`：

| 变量 | 值 |
|------|-----|
| `PATH` | 平台构造的最小 PATH（解释器目录 + 系统标准目录） |
| `HOME` | `runRootFor(taskId,nodeRunId)/home`（私有，非真实 `$HOME`） |
| `TMPDIR` | `runRootFor(…)/tmp` |
| `LANG` / `LC_ALL` | `C.UTF-8` |
| `AW_TASK_ID` / `AW_NODE_ID` / `AW_NODE_RUN_ID` | 标识 |
| `AW_ITERATION` / `AW_RETRY_INDEX` / `AW_SHARD_KEY` | loop 迭代号 / 重试序号 / fanout 分片键（无分片时为空） |
| `AW_WORKTREE` | 进程 cwd（本节点的 iso 工作区；`readonly` 档为 canonical 工作区） |
| `AW_REPOS_JSON` | 多仓布局 JSON（`[{name,path}]`），单仓也给 |
| `AW_RUN_DIR` / `AW_INPUT_DIR` | run 私有目录 / 输入落盘目录 |
| `AW_PORT_*` / `AW_PORT_FILE_*` / `AW_PORT_NAMES` | §2.1 |
| `AW_OUTPUT_MODE` | `'stdout'` \| `'envelope'` |
| `AW_ENVELOPE_NONCE` | 信封模式下的 nonce |
| `AW_DEPS_DIR` | 依赖环境目录（只读挂载），无依赖时缺席 |
| `PYTHONPATH` / `NODE_PATH` | 由 `AW_DEPS_DIR` 派生（对应语言才设） |
| `GIT_AUTHOR_*` / `GIT_COMMITTER_*` | RFC-067 任务级身份，条件与 runner 一致（`runner.ts:447-461`） |
| 节点 `env` 映射表 | 只能设**保留集合之外**的键；平台键**最后覆盖**用户键（见下） |

**平台键胜出，不是用户键胜出（设计门 P1 翻转了原设计）**：`mcpEnvIssues` 只拒非法名 / NUL / `LD_*` / `DYLD_*`，
并**显式放行** `PYTHONPATH` 与 `NODE_OPTIONS`（`shared/schemas/mcp.ts:35`）。若让用户键最后覆盖，一条
`PYTHONPATH=/tmp/evil` 就能绕开只读依赖边界，一条 `HOME=…` 就能推翻 AC-16。因此：

1. 键名先过 `mcpEnvIssues`（复用，不复制）；
2. 再过**脚本专属保留表**：`PATH` / `HOME` / `TMPDIR` / `TMP` / `TEMP` / `PYTHONPATH` / `PYTHONHOME` /
   `NODE_PATH` / `NODE_OPTIONS` / `LANG` / `LC_ALL` 与前缀 `AW_` / `GIT_` —— 命中即在**保存期**报
   `script-env-key-reserved`；
3. 装配时平台键最后写入，结构上不可能被用户键盖掉。

argv：

| 语言 | argv |
|------|------|
| python | `[<python>, '-u', <scriptPath>]`（`-u` 保证 stdout 实时可读） |
| bash | `[<bash>, <scriptPath>]` |
| node | `[<node>, <scriptPath>]` |

脚本正文**逐字节**写进 `runRootFor(…)/script.<py\|sh\|mjs>`（**不在工作区里**，否则会进 `git_diff`）。
平台**不注入任何前缀**（不注入 `set -euo pipefail`）——注入等于偷改用户代码；编辑器的 bash **默认模板**里
带 `set -euo pipefail`，选择权留给作者。

## 4. 执行器

### 4.1 受控 spawn 原语（新）

`services/execution/containedSpawn.ts`：

```ts
export interface ContainedSpawnRequest {
  argv: readonly string[]
  cwd: string
  env: Record<string, string>
  timeoutMs?: number
  killEscalationGraceMs?: number
  signal?: AbortSignal
  onStdoutLine?(line: string): void
  onStderrLine?(line: string): void
  containment: PreparedContainmentPlan | undefined
}
export interface ContainedSpawnResult {
  exitCode: number | null
  outcome: 'exited' | 'timeout' | 'aborted' | 'spawn-failed' | 'child-unkillable'
  stdoutTail: string          // 按 MAX_AGENT_TEXT_CHARS 截断
  stderrTail: string
  truncated: { stdout: boolean; stderr: boolean }
  spawnBinaryPath: string
}
```

它把 `runner.ts` 里已经验证过的四块搬成共享实现：`wrapSpawnPlanSandbox` 包 argv、`pumpLines` 行泵 +
`appendBoundedTail` 截断、SIGTERM→宽限→SIGKILL 的 `armKillEscalation` / `killTree` 升级链、以及超时/中断的
终止语义。

> **反「抽一半」棘轮**（架构审视 RC-1）：新增一条源码守卫测试——`packages/backend/src/**` 里的 `Bun.spawn` /
> `Bun.spawnSync` 站点必须出现在登记表里，新增站点不登记即红。runner.ts 的既有站点先入表并标
> `removeWhen: '迁移到 containedSpawn（架构审视 WP-2）'`，让「两套实现」是**被记账的**而不是悄悄长出来的。

### 4.2 节点生命周期

`runOneNode` 的 `script` 分支（放在 RFC-146 穷尽性守卫 `scheduler.ts:4174` 之前）：

```
① 解析入参        resolveUpstreamInputs（复用）
② 铸行            mintNodeRun（复用 pending 行 / retryIndex 语义，与 agent 分支同构）
③ 解释器解析      resolveScriptInterpreter(language) → 绝对路径 + --version 串（失败 ⇒ script-interpreter-missing）
④ 依赖环境        ensureScriptDepsEnv(...)（§6；无依赖直接跳过）
⑤ containment     coordinator.admit(network==='deny' ? 'script-netless-v1' : 'script-node-v1')
⑥ 工作区          readonly ? canonical : createIsoUnderLock + persistIsoBase（复用）
⑦ 物化            写 script.<ext>、写溢出输入文件、建 home/tmp
⑧ 执行            containedSpawn（stdout/stderr 逐行落 node_run_events）
⑨ 收口            单端口 / 信封 → node_run_outputs；status/exit_code/finishedAt
⑩ 合回            非 readonly ⇒ mergeBackNodeIso；失败/取消 ⇒ discardNodeIso
```

**这不是「复用 agent 那段循环体」（设计门 F6 已纠正原文）**：非 `agent-single` 在穷尽守卫处就已 return，
而 `globalSem`/iso/重试循环在它之后，脚本分支结构上到不了。脚本执行器复用的是**同一批原语**——
`globalSem.acquire` / `createIsoUnderLock` / `persistIsoBase` / `mergeBackNodeIso` / `discardNodeIso` /
`mintNodeRun` / `setNodeRunStatus`——并自带一条显式的、与 agent 同形的重试循环。

重试对文件副作用仍然安全（D24），但**只对下列路径成立、必须分别测**（设计门 P1）：普通 fresh retry（本执行器
自己的循环）、wrapper-loop 迭代（走通用 `runScope` 因而继承）、resume（铸 revival 新行）。**fanout 不在其列**——
脚本节点在 fanout 内是非目标（proposal §3）。

`readonly: true` ⇒ 不建 iso、cwd 为 canonical 工作区，且**容器边界把工作区整棵挂成只读**（AC-10）——
「只读」在此处是被强制的，不是靠脚本自觉。

### 4.2b 进程所有权与终态契约（设计门 P0-3 / P1）

三条与 agent 完全同形、必须显式实现的契约：

1. **spawn 后立刻持久化 `pid` + `spawn_binary_path`**。`ContainedSpawnResult` 只在**退出后**返回，中间 daemon 若
   被 `kill -9`，`node_runs.pid` 为 NULL ⇒ 重启后 boot reaper 拿到 `no-pid`（`util/process.ts:111`），遗留脚本
   进程永远收不掉。原语因此提供 `onSpawned({ pid, spawnBinaryPath })` 回执（先例：`systemAgentRun.ts:114`）。
2. **spawn 前 `pending→running` 且 DB 先写、再广播**（先例 `runner.ts:1003`）。
3. **daemon 关停时控制流返回 canceled、持久态写 interrupted**（先例 `runner.ts:2459`）——两者不是一回事。

macOS 的 `setsid()` 后代逃逸（脚本 fork 后自立进程组、父进程退出后继续写工作区）**与今天的 agent 同档**：
两者共用 `killProcessTree` 的进程组语义，Seatbelt 路径没有 PID namespace 也没有 parent-death 信号。本 RFC
不为脚本单造 macOS 机制，如实登记进 `docs/audit-backlog.md`。

### 4.3 事件与可观测

- stdout 行 → `node_run_events.kind='text'`；stderr 行 → `kind='stderr'`（既有枚举足够，无需迁移）。
- 依赖安装阶段的输出同样入流，payload 带 `{phase:'deps-install'}` 标记（AC-34）。
- 截断发生时补一条 `kind='error'` 的显式标记行（D27），不静默吞。
- `node_runs.spawn_binary_path` 记冻结的解释器绝对路径；依赖环境哈希记进 `node_runs` 既有的
  `runtime_params_json`（脚本节点复用该列存 `{ script: { interpreter, interpreterVersion, depsHash } }`，
  避免为此加列）（AC-35）。
- token 列保持 NULL（D25）。
- **读投影**：解释器路径与 `depsHash` 必须出现在任务详情的 NodeRun DTO 里（`shared/schemas/task.ts` 的
  `NodeRunSchema` + `services/task.ts` 的 DTO），否则 AC-35 只是「写进了库」而用户看不见（设计门 P1）。

## 5. Containment 与出网围栏（D4 / D17 / D23）

### 5.1 现状核实

现有外层沙箱**没有任何网络限制**：Seatbelt 侧是 `(allow default)` + 文件 deny（`policy.ts:139-162`），
Linux 侧是 `--bind / /` 且**不带** `--unshare-net`（`policy.ts:176-207`）。因此：

- `network: 'allow'`（默认）**零新增机制**，直接用现有边界。
- `network: 'deny'` 需要新造围栏——这正是 RFC-252 G4 设计中、尚未实现的能力。按 D17，**本 RFC 把通用机制
  建进 containment 体系**，RFC-252 落地时复用同一能力名而不是再造一个。

### 5.2 新增能力与 profile（按设计门 F3 收敛为**一个**新 profile）

`sandbox/containmentCoordinator.ts`：

```ts
// 能力：外层进程完全无网。
'outerNetworkDeny': 'strong' | 'best-effort' | 'absent'

CONTAINMENT_REQUIREMENT_PROFILES 新增 **一** 条：
'outer-netless-v1': { required: ['platformHomeIsolation','immutableArtifactView','outerNetworkDeny'],
                      optional: ['descendantLifetimeBound'], childBoundary: 'none',
                      failClosed: true }   // 见下：策略由 coordinator 拥有
```

`network:'allow'`（默认档）**直接复用 `runner-filesystem-v1`**。原设计想为遥测可分辨而并列一个需求完全相同的
`script-node-v1`，被注册表自己的契约否决（`containmentCoordinator.ts:13-26`：profile 命名 WHAT 不命名 WHO，
「只有需求真正分歧才拆」）。consumer 的可分辨性放在遥测标签里，不放在 profile id 里。

profile id 也刻意**不带 `script-` 前缀**：它描述的是「外层进程无网」这一需求，RFC-252 的 agent 侧若需要同一档
应当复用它而不是再造一个。

渲染：Linux 追加 `--unshare-net` **以及 `--tmpfs /run` `--tmpfs /var/run`**；macOS 在 profile 末尾追加
`(deny network*)`（SBPL 最后匹配优先，必须排在 `(allow default)` 之后）。

> **两个 tmpfs 不是可选项（设计门 P0-2）**：`--unshare-net` 只隔离 **abstract** Unix socket；pathname socket
> 归 mount namespace 管，而现有 `--bind / /` 把 `/run/user/$UID/bus`（D-Bus，可借 systemd 执行命令）和
> `/var/run/docker.sock` 一并带进沙箱——那等于给「无网」的进程留了一条本机 RPC 出口。即便如此这仍是
> **best-effort** 边界（根仍是 RW bind），文档必须这么写，不能宣称完全隔离。

**能力资格证明**沿用既有可注入 trial 钩子体系（`#qualifyBwrap` / `#qualifyBwrapFull` / `#qualifySeatbelt`，
`containmentCoordinator.ts:325-352,457-551`）：新增 `qualifyBwrapNetless` / `qualifySeatbeltNetless`，各跑一次
**结构性**试运行（`bwrap --unshare-net --bind / / -- /bin/true`；`sandbox-exec -p '(version 1)(allow default)(deny network*)' /usr/bin/true`），
成功即 `strong`，被拒/超时即 `absent` 并带既有 reason code。不做真实连外网探针——慢且会在离线 CI 上假红。

**fail closed 由 coordinator 拥有，不由 caller 二次判断（设计门 P1 / RFC-233）**：现状是 `off` 直接返回 none、
缺能力时 `warn` 给 `degraded` 而只有 `enforce` 给 `blocked`，且 `admit` 只对 `blocked` 抛错
（`containmentCoordinator.ts:620,697,777`）。若让 `scriptRun` 自己再解释一次 receipt，就出现第二决策源。
正解：profile 携带 `failClosed: true`，由 coordinator 在 `#evaluate` 里对该档改判——`enforce`/`warn`/`off`
三档在能力缺失时**一律** `blocked`，`admit` 照常抛错。caller 只 `await admit(...)`，不做任何模式判断。
错误码 `script-network-fence-unavailable`。与 RFC-252 D8 同构：此处降级等于提权。

### 5.3 只读根扩展

依赖环境目录要以**只读**挂进边界（AC-20）。现有 `computeSandboxPolicy` 的 `readOnlySubtrees` 要求必须是
某个 `allowSubtrees` 的**严格后代**（`policy.ts:122-124`），而依赖目录在 appHome 下、被整棵 deny，不满足。

**不新造入参（设计门 F5）**：并发提交 `37496943`（RFC-251）已经给 `policy.ts` 加了 `readOnlyAllowSubtrees`，
语义正是「被 deny 的 appHome 之下、只读 allow-back」——正是这里需要的东西。直接复用，不加平行机制。

只挂**本次命中的那一个**环境目录，不挂整棵 `script-envs/`——否则一个脚本能改写别的节点的依赖环境，等于跨节点
代码注入。

**`readonly: true` 还要额外降级 git 公共目录（设计门 P1）**：`computeSandboxPolicy` 恒把 `${appHome}/repos`
放进 RW allow-back。只把工作树叠成只读是不够的——脚本仍可 `git update-ref` / 改 repo config / 写 objects，
与「只读节点不回写」的承诺矛盾。readonly 档把它一并降级为只读。

## 6. 依赖预装子系统（D9 / D14 / D15）

### 6.1 环境标识

```
depsHash = sha256(JSON.stringify({
  language, interpreterPath, interpreterVersion,   // 解释器变了 ⇒ ABI 可能变 ⇒ 换环境
  specs: [...dependencies].sort(),                 // 规范化：排序 + 去重
}))
envDir  = ${appHome}/script-envs/${language}/${depsHash}/
```

`envDir` 下：`lib/`（真正的包目录）+ `manifest.json`（specs / 语言 / 解释器版本 / createdAt / lastUsedAt）。

### 6.2 安装

命中 `manifest.json` 即直接复用，**不联网、不起进程**（AC-17）。未命中时：

```
python : [<python>, '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
          '--only-binary=:all:', '--target', <build>/lib, ...specs]
node   : [<npm>, 'install', '--ignore-scripts', '--no-audit', '--no-fund',
          '--prefix', <build>, ...specs]
bash   : 不适用（schema 层已禁）
```

- 安装进程走**同一个** `containedSpawn` 原语，profile 固定 `script-node-v1`（即允许出网，D15），可写根只有
  `<build>` 临时目录，`HOME`/`TMPDIR` 同样私有。
- `--only-binary=:all:` / `--ignore-scripts` 是 D14 的物化：源码包的 `setup.py`、npm 的 `preinstall/postinstall`
  一律不执行（AC-18）。
- 装完 `rename(<build>, envDir)` 原子上架；并发同哈希由 in-process mutex + rename 幂等兜底（AC-21，
  rename 撞车时后到者删掉自己的 build 目录并复用已上架的）。
- 失败 ⇒ 节点失败，错误码 `script-deps-install-failed`，stderr 尾部进 `errorMessage`；只有源码分发的包会命中
  一条**明确文案**（「该包没有预编译产物，平台不执行源码包构建」）。
- 安装超时独立于节点超时，取 `config.scriptDepsInstallTimeoutMs`（默认 10 分钟）。

### 6.3 依赖条目校验

在**保存期**拒掉 flag（`-r` / `--index-url`）、URL、路径、`git+…`、environment marker、shell 元字符（AC-19）。
这既堵住「用依赖字段偷改索引源」的供应链面，也保证 argv 拼接不会被越权解释（argv 不过 shell，分号本就不构成
命令拼接——设计门已实证这一点）。

**语法按语言分档（设计门 F10）**：pip 与 npm 的版本比较符不是一套。原设计一条正则同时接受两边，结果是
它既匹配不了自己文档里的 npm 正例 `@scope/pkg@1.2.3`，又放行了 `pkg^1.2.3` 这种 pip 不认的形态。改为
`scriptDependencyIssue(language, spec)`，pip 档只认 `name[extras]==x.y.z`，npm 档只认 `[@scope/]name@x.y.z`。

**必须精确钉版本（设计门 P1，AC-19b）**：环境按依赖列表哈希缓存，**冷缓存时才联网解析**——不钉版本意味着同一份
已授权的定义在不同时间会解析到不同的包字节，「授权过的东西」就不是一个确定的东西了。确定性本来就是脚本节点
存在的理由，这条约束与产品定位一致而不是额外负担。解析出的版本与产物摘要写进 `manifest.json` 与运行记录。

### 6.4 回收

daemon 既有的每小时后台任务里加一档：`lastUsedAt` 超过 `config.scriptEnvTtlDays`（默认 30 天）的环境目录整棵
删除。命中即 `touch` `lastUsedAt`。

## 7. 权限门（D6 / D19 / D20 / D21）

### 7.1 点

`permission.ts`：新增 `'scripts:author'`，登记进 `SYSTEM_DOMAIN_POINTS`（⇒ 由既有减法推导，它自动不会进任何
PAT 的授权集合，AC-26）**并**进 `MANAGER_EXTRA`（⇒ 角色基线 = admin + manager，D19）；**不**进
`USER_BASELINE`、**不**进 `MANAGER_DENIED_PERMISSIONS`。

> 两者不冲突：系统域约束的是**令牌面**而非角色面——`account:self` / `users:search` / `intent:read` /
> `intent:write` 同为系统域点且都在 `USER_BASELINE` 里。测试要把这条正交性显式锁住，防止后人把
> 「系统域 ⇒ 仅 admin」当成不变量。它是 handler 直接消费的点（门在服务层、不在某条路由的元数据上），因此按 RFC-247 的规矩
登记进 `HANDLER_CONSUMED_POINTS` 一类的豁免名单并**带上消费处的 file:line**，否则启动期的反向自检会判它是死点。

### 7.2 敏感投影与门位置

```ts
// shared：规范化投影 + 哈希（纯函数，前后端共用）
export function scriptSensitiveProjection(def: WorkflowDefinition): string  // sha256
// 覆盖每个 script 节点的 { id, language, script, outputs, dependencies, env, network, readonly }
// 按 node.id 排序；不含 position / title / 边 / 其他 kind 的节点（D20）
```

门装在**持久化原语**上（设计门 P1）。只枚举 HTTP 入口是不够的：intent 的更新路径走 `prepareWorkflowSave`，
而它的**创建**路径直接调用导出的 `insertWorkflowInTx`（`services/intent/applyChangeset.ts:759` →
`services/workflow.ts:729`）。门落在这两个原子边界上，任何未来的内部 caller 都绕不过去：

| 入口 | 判定 |
|------|------|
| `POST /api/workflows`（新建） | 定义里存在任何脚本节点 ⇒ 需要点 |
| `PUT /api/workflows/:id`（保存） | 新旧投影哈希不同 ⇒ 需要点 |
| `POST /api/workflows/import`（YAML，new / overwrite 两档） | 同上（overwrite 与库中现值比） |
| `POST /api/workflows/:id/copy`（RFC-231） | **不要点**（D21：服务端原样搬运既有修订）——以显式 provenance 参数放行，而不是靠「这条路径碰巧没调门」 |
| RFC-234 intent 应用路径（create 与 update 两个不同原语） | 产出定义里出现脚本节点 ⇒ 需要点（否则模型可代写代码绕过 D6） |

> 投影**不只含脚本节点自身字段**（设计门 P1）：指向脚本节点的**入边**决定 `AW_PORT_*` 的键与值，
> 包含脚本节点的 **wrapper 归属**与 loop 的 `maxIterations` 决定它跑不跑、跑几次。把它们排除在外，
> 一个无点用户就能把已授权脚本的输入改接到自己控制的上游、或把它塞进跑 50 次的循环——正文一字未改、
> 执行语义全变。因此投影 = 脚本节点自身字段 + 其入边（源端口 + 目标端口名）+ 其 wrapper 归属与迭代上限。

拒绝时返回 403 + 错误码 `script-author-forbidden`。

### 7.3 密钥脱敏（D10）

- **写路径**：`env` 的键先过 `mcpEnvIssues`（`shared/schemas/mcp.ts:47-80`）——同一函数，不复制一份。
- **读路径**：脚本节点 env 的值在 workflow 详情响应、列表、YAML 导出、校验器消息、诊断/错误信息里一律脱敏。
  实现落在 `intentSecretSlots.ts` 的 carrier 清单（新增一条 `script-node-env`）+ `services/tokenRedaction.ts`
  的既有读路径投影，**不新造第三套脱敏**。
- **执行期**：进程拿到明文（AC-27）。明文只在 DB 与内存里存在，不进任何响应。

## 8. 前端（D12 / D16）

### 8.1 公共 `<CodeEditor>`

`packages/frontend/src/components/CodeEditor.tsx`，CodeMirror 6：

```tsx
<CodeEditor language="python" | "bash" | "javascript" | "json" | "yaml"
            value={…} onChange={…} readOnly={…} minRows={…} maxRows={…}
            data-testid={…} aria-label={…} />
```

必须满足的既有铁律（CLAUDE.md §Frontend UI consistency）：深浅色双主题跟随平台变量、焦点环与 `.form-input`
一致、`readOnly` 有视觉态、`Tab` 缩进但 `Esc→Tab` 可逃出（键盘可达，AC-29）、错误态与 `<Field>` 的 hint /
必填标记协作。

替换范围（D16）：`JsonField.tsx:79`、`McpFields.tsx:112,146`、`PluginFields.tsx:106`、
`routes/workflows.tsx` 的 YAML 导入框。**不动**散文类：`MarkdownEditor` / `PromptPreview` /
`AgentSingleEdit`（提示词）/ `MemoryFormFields` / `DynamicInput` / `FilesPicker` / `SkillFileTree` /
`AgentImportDialog` / `settings.tsx:1500`。

### 8.2 节点面

- **调色板**：新分区 `scripts`（`PALETTE_SECTIONS` 追加），glyph `▶`，默认字段
  `{ language: 'python', script: <该语言默认模板> }`。
- **画布卡片** `ScriptNode.tsx`：显示语言、依赖数、`deny` / `readonly` 标记（AC-31），端口 handle 由
  `declaredPorts` 驱动。
- **Inspector** `ScriptEdit.tsx`：语言 `.segmented`、`<CodeEditor>`、输出端口编辑（复用 RFC-194 的端口编辑
  交互）、依赖 `<ChipsInput>`、env 表、`network` / `readonly` 开关（`<Switch>`）、以及**入参提示区**——
  按入边实时列出「`port_name` → `AW_PORT_PORT_NAME`」，让作者不必猜变量名。
- **无权者**：整块以 `readOnly` 渲染 + 一条 `<ErrorBanner>` 说明需要脚本编写权限（AC-30），不是「能改存不上」。
- i18n 中英双语齐全。

## 9. 校验器规则

`services/workflow.validator.ts` 新增（全部带稳定 kebab code + `target.nodeField` 定位）：

| code | 触发 |
|------|------|
| `script-body-empty` | 正文为空白 |
| `script-language-invalid` | 语言不在枚举 |
| `script-dependencies-unsupported` | `language==='bash'` 却声明了依赖 |
| `script-dependency-malformed` | 条目不匹配 `SCRIPT_DEPENDENCY_RE` |
| `script-output-name-duplicate` | 声明端口重名 |
| `script-output-kind-invalid` | kind 串解析失败（复用既有 kind 解析器） |
| `script-port-env-collision` | 入边端口名规范化后撞车 |
| `script-env-key-invalid` | `mcpEnvIssues` 报错（逐条透传原文案） |
| `script-network-invalid` | 值不在 `allow`/`deny` |
| `script-signal-port-in-input`（warning） | 入边来自 `signal` kind 端口（值恒为空，多半是接错线） |
| `script-in-fanout-unsupported` | 脚本节点位于 `wrapper-fanout` 内（非目标，fail closed —— 设计门 F7） |
| `script-output-kind-path-unsupported` | 声明了 `path<…>` / `list<path<…>>` 族 kind（非目标，fail closed） |
| `script-env-key-reserved` | env 键命中脚本保留表或 `AW_`/`GIT_` 前缀（§3） |
| `script-dependency-version-unpinned` | 依赖未精确钉版本（AC-19b） |

## 10. 失败模式与错误码

新增 `failure_code`（`shared/schemas/task.ts:254` 的 `FAILURE_CODES` 组合域里加一支
`SCRIPT_FAILURE_CODES`，**只进读域与 emit 域、不进 `FOLLOWUP_FAILURE_CODES`**——脚本没有 same-session 补救）：

| code | 含义 | 是否重试 |
|------|------|---------|
| `script-nonzero-exit` | 退出码非零 | 是（D7） |
| `script-timeout` | 超时被杀 | 是 |
| `script-envelope-missing` | 信封模式下没解析到本次 nonce 的信封 | 是 |
| `script-envelope-malformed` | 信封 framing 破损（parser 的 `malformedPorts`） | 是 |
| `script-port-missing` | 信封里缺声明端口（parser 的 `missingDeclared`，**不会**自动失败，须显式判） | 是 |
| `script-interpreter-missing` | 解释器解析不到 | 否（重试无益，需管理员处理） |
| `script-deps-install-failed` | 依赖预装失败 | 否 |
| `script-network-fence-unavailable` | `deny` 但围栏能力不可用（D23） | 否 |
| `script-spawn-failed` | 进程起不来 | 否 |

> **RFC-251 教训**：删/加 failure code 要分清 **emit 域**与**读域**——任务列表整页用 `z.enum` 解析，读域缺一个
> 历史码会让整页炸。新增码同时进两域即可，但测试要覆盖「历史行 + 新码」的混合分页解析。

**「不可重试」必须接进真实 predicate（设计门 P1）**：`scheduler.ts` 现有的永久失败判定只认 runtime identity 一族，
新增的 `script-*` 码若不登记，四个「重试无益」的码照样会被重试三次。登记点与测试都要有。

## 11. 测试策略

**纯函数优先**（CLAUDE.md 铁律），下列可断言面必须有独立单测：

- `scriptEnvSuffix()` / 冲突检测 / 溢出落盘判定（含 32 KiB、256 KiB 累计两个边界）
- `scriptSensitiveProjection()`：改正文 ⇒ 变；改位置/标题/边/其他节点 ⇒ **不变**（AC-23 的预言）
- 依赖条目正则：正例（`requests`、`requests==2.32.3`、`@scope/pkg@1.2.3`、`pkg[extra]`）+ 反例
  （`-r x.txt`、`--index-url=…`、`git+https://…`、`pkg; rm -rf /`、`../evil`）
- `depsHash` 规范化：顺序无关、去重、解释器版本参与
- 信封/单端口模式选择 + nonce 拒伪（把上游内容里的伪造信封当输入）
- 新 profile 的 requirement digest 与 fail-closed 决策表（`network:'deny'` × 三档 × 能力缺失）

**集成 / e2e**：

- 端到端最小流（AC-1）、大值溢出（AC-3）、信封 → fanout 分片（AC-4）
- 失败/超时/取消三条终态（AC-6/7/8）
- iso 合回与 `git_diff` 包含脚本改动（AC-9）；`readonly` 不合回（AC-10）
- wrapper-git / loop / fanout 三种嵌套（AC-11）
- **平台门测试**：Linux `--unshare-net` 与 macOS `(deny network*)` 各自实测真实拒绝（AC-13）；两平台都要跑，
  不能只在 CI 的一种 OS 上验证
- 依赖：首次装 + 二次命中缓存不联网（AC-17）、源码包拒绝（AC-18）、只读挂载（AC-20）、并发同哈希（AC-21）
- 权限：403 矩阵（AC-22/23/24/25）、PAT 不可达（AC-26）、脱敏（AC-27）
- 前端：Inspector 单测 + 无权只读态 + 存量替换页面的既有 e2e / 视觉回归全绿（AC-32）

**回归防护命名**：测试文件顶部写清「锁的是哪条」，例如
`packages/backend/tests/rfc253-script-network-fence.test.ts` 顶注明「锁 D23：deny × 能力缺失在三档模式下都必须
阻断——降级等于提权」。

## 12. 与并发 RFC 的边界

- **RFC-252**：本 RFC 交付 `outerNetworkDeny` 能力与围栏渲染；RFC-252 的 G4（agent 侧 `network` 声明、
  `model-child-egress-v1`、loopback deny）不在本 RFC。落地时须在 RFC-252 的 design 里登记「外层围栏机制由
  RFC-253 交付」，避免两边各造一套。
- **RFC-250 / RFC-249**：工作树里有它们未提交的改动，按 CLAUDE.md 多人协作原则**不代改、不剥离**。
- **架构审视 WP-2**：`containedSpawn` 是它的第一块料，但 runner 迁移不在本 RFC；棘轮表把这笔债显式记账。
