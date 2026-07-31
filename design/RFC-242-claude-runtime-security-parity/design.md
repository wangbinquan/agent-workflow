# RFC-242 Claude Code 运行时安全姿态对齐（design）

状态：Draft。锚点基于 2026-07-31 的 main（RFC-237 收口批之后）。

## §0 现状锚点

| 关注点                          | 锚点                                                                                                                                                       | 现状                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| claude 业务 spawn               | `runtime/claudeCode/driver.ts` `buildBusinessSpawn` → `spawn.ts` legacy 分支                                                                               | 无封印、`bypassPermissions`、`inherit: 'full'`                   |
| claude 受控 spawn（已达标样板） | 同文件 `buildSpawn` 的 `intent-read-v1` 分支                                                                                                               | 封印 + `preSpawnVerify` + `controlled` env + `--tools` 门        |
| env / argv 单点原语             | `spawn.ts` `assembleClaudeEnv` / `claudeDeclaredControlArgv`                                                                                               | RFC-237 收口，含 uid-0 `IS_SANDBOX` 断言与 ratchet               |
| agent 权限模型                  | `packages/shared/src/schemas/agent.ts:196-197`                                                                                                             | **`z.record(z.string(), z.unknown())` —— opencode 词汇原样透传** |
| opencode 如何消费               | `runtime/opencode/inlineConfig.ts`（顶层 `permission` 注入受控 config）                                                                                    | 运行时原生理解该词汇                                             |
| claude 如何消费                 | `runtime/claudeCode/inject.ts`                                                                                                                             | **完全不消费 permission**；只转 MCP / subagents                  |
| containment 需求声明            | `opencode/driver.ts` `businessContainmentProfile`（bash≠deny 或有 local MCP → `opencode-verified-v1`）；`claudeCode/driver.ts` 固定 `runner-filesystem-v1` | claude 从不申请网络级边界                                        |
| `all-deny` 名实差               | `runtime/types.ts` `SYSTEM_PERMISSION_PROFILES` 注释                                                                                                       | 已如实记录"claude 上以 bypass 语义运行"                          |
| 业务 argv 断言面                | `tests/rfc143-business-spawn.test.ts`、`tests/runtime-claude-e2e.test.ts`、`tests/runtime-buildspawn.test.ts`                                              | golden 形状锁                                                    |

## §1 核心矛盾：权限词汇不通用

平台的 `agent.permission` **就是 opencode 的 permission map**（verbatim 透传，RFC-073）。
claude 的权限面是另一套词汇：工具名白/黑名单（`--tools` 装载集、`--allowedTools` /
`--disallowedTools` 规则、`--permission-mode`）。两者不存在自然双射：

- opencode：`{bash: 'deny', edit: 'ask', webfetch: 'allow'}`——按**动作类**分级三态；
- claude：`Bash` / `Edit` / `Read` / `WebFetch` … 是**具体工具名**，且规则支持
  `Bash(git *)` 这种带模式的粒度；`ask` 在 headless 下无意义（无人应答）。

因此 §A（业务节点工具门由声明驱动）不是"接线"，而要求一个**显式映射契约**。三种可选形态：

- **方案 1（映射表，推荐）**：定义 `opencode-permission → claude tool set` 的冻结映射
  （`deny` → 该类工具移出 `--tools`；`ask` → 在 headless 下按 `deny` 处理并在保存期
  告警；`allow`/缺省 → 保留）。优点：用户已有的 agent 声明立即生效、跨运行时语义一致；
  代价：映射是我们的断言，需要逐条列举 + 测试锁，且 opencode 词汇未来扩展要同步。
- **方案 2（per-runtime 声明）**：给 agent 增加可选的 claude 原生权限字段，未声明时
  claude 节点保持现状。优点：无翻译失真；代价：产品面出现"两套权限"，用户须为同一
  agent 维护两份声明，且默认仍不安全。
- **方案 3（保守收窄）**：不做映射，claude 业务节点一律收窄为固定安全集
  （读 + 编辑 + 受控 Bash），忽略 agent 声明。优点：实现最小；代价：**破坏既有工作流**
  （今天靠 bypass 全权跑通的节点会突然缺工具），且 agent 声明在 claude 上依然失效。

**本设计推荐方案 1**，并按 §2 分阶段实施；方案 3 作为映射未覆盖时的 fail-closed 兜底。

## §2 §A 业务节点受控化

### 2.1 spawn 形状（目标）

```
<sealedBinary> -p --output-format stream-json --verbose
  --permission-mode dontAsk
  --tools <由 agent.permission 映射推导的装载集>
  [--disallowedTools <映射产出的否定规则>]
  [--mcp-config <inline JSON> --strict-mcp-config]     ← 现状保留
  [--agents <inline JSON>]                              ← 现状保留
  [--model X] --append-system-prompt-file <persona>
  [--resume <id>]
```

- 复用 `claudeDeclaredControlArgv`（RFC-237 单点）+ 业务特有的 mcp/agents 尾部；
  `--setting-sources ""` / `--disable-slash-commands` 在业务面**需单独决策**：业务节点
  今天允许 repo 内 `.claude/` 自发现 skills（RFC-111 `stageSkills` bestEffort 语义），
  一刀切禁用会改变既有行为——本设计取「保留自发现，但 settings 三源仍切断」，理由是
  settings 可改权限而 skills 不能。
- env：`assembleClaudeEnv({inherit: 'controlled', hardening: true, …})`——与 intent 同；
  uid-0 `IS_SANDBOX` 断言自动获得。
- 二进制：`snapshotRuntimeBinary` + `preSpawnVerify`，与 intent 同一 TOCTOU 围栏。

### 2.2 迁移与 golden

既有 golden 断言（§0 三个测试文件）**改形不删项**：新增"受控形状"golden，旧 bypass
golden 改为"仅在 §2.3 逃生阀开启时"的断言。回归判据：同一 agent 定义下，工具可用面
只减不增，且减少项与映射表逐条对应。

### 2.3 逃生阀（必要）

存量工作流可能依赖今天的全权。提供 agent 级显式声明（如 `permission: {'*': 'allow'}`
或独立 `unconstrained: true`）→ 保留 bypass 形状，**但**：保存期在 UI 给出明确告警、
运行时在 node_run 诊断里标注 `unconstrained`。不允许"什么都不声明就是全权"。

## §3 §B `all-deny` 名实一致

`all-deny` 在 claude 上物化为 `--tools ""`（RFC-238 的 MCP 试跑已证明该形态可用：
空装载集 + 仅 MCP 白名单）。影响面：

- **distiller**：只需模型推理 + stdout，无工具需求 → 直接受益，行为不变。
- **runtime smoke**：靠"实际跑通"证明可用性。空工具集下 smoke 仍能完成
  prompt→envelope 往返（它本就不调工具），故**诊断力不降**；需以 smoke 定向测试确认。

若确认无回退，则删除 `SYSTEM_PERMISSION_PROFILES` 里的"名实不符"注释，改为两运行时
一致的语义描述。

## §4 §C 网络围栏

现实约束：**claude 必须出网**（模型 API 直连），因此不能对 claude 主进程施加 no-network。
opencode 侧的等价保证也不是"opencode 不出网"，而是"**模型控制的子进程**（local MCP /
shell）在无网边界内"。对 claude 的可达路径：

- **C-1（可行）**：local MCP 子进程——平台不再让 claude 自己 spawn，而是由平台以
  sealed no-network 子进程承载、以 stdio 代理给 claude（复用 `sealedSubprocess.ts` 的
  provider 能力）。代价：需要一层 MCP stdio 代理，且要处理 claude 侧 `--mcp-config`
  只接受它自己启动的命令这一约束（**需先验证 claude 是否支持"已连接的 stdio 传输"或
  只能由它 fork**；若只能 fork，则平台可提供一个 wrapper 命令，由 claude fork 我们的
  wrapper，wrapper 再在无网边界内起真 MCP——这条更可行）。
- **C-2（可行）**：模型自控 shell（Bash 工具）——若 §2 的工具门把 Bash 移出装载集，
  该面自然消失；保留 Bash 的 agent 则需 wrapper 同款处理。
- **C-3（声明不可达）**：若 C-1/C-2 验证受阻，则在 `businessContainmentProfile` 层面
  显式声明 claude 无法提供子进程网络边界，并在 UI（agent 编辑器选 claude 运行时且
  声明了网络限制时）与 docs 标注——**显式声明优于静默失效**。

### 4.1 T0b 实测结论（2026-07-31，claude 2.1.220 / macOS）——**定档 C-1**

`--mcp-config` 的 `command`/`args` 由 claude **fork 执行**，且平台可以放自己的命令：

- 配置 `{"mcpServers":{"probe":{"command":"<平台 wrapper.sh>","args":[]}}}`；
- wrapper 记录到自己被 fork（`WRAPPER_FORKED pid=89624 ppid=89611`），随后 `exec`
  真 MCP server；
- claude 以 `--tools "" --allowedTools "mcp__probe__*"` 成功完成 initialize →
  tools/list → tools/call，拿回 `pong-from-wrapped-mcp`，`is_error=false`。

因此 **C-1 可落地**：平台在 `--mcp-config` 里只写自己的 wrapper，wrapper 在
`sealedSubprocess.ts` 的 no-network 边界内起真 MCP（与 opencode local MCP 复用同一
provider 能力），claude 全程只与 wrapper 的 stdio 对话，不需要它支持"已连接传输"。

**边界侧同日验证（macOS Seatbelt）**：`(version 1)(allow default)(deny network*)` 下
`curl https://example.com` 返回 `000`（对照组无 profile 返回 `200`），同一 profile 下
本地文件读正常——即 stdio + 本地 IO 不受影响，MCP server 可正常服务。Linux 侧复用
`sealedSubprocess.ts` 既有 bwrap `--unshare-net`（opencode local MCP 已在用）。两端
证据齐备：**C-1 全链可行**。

### 4.2 实现路径（已探明，零新机制）

平台**已有**这条链的全部零件（opencode local MCP 在用），claude 只需接线：

- `sealedSubprocess.ts` `materializeNetlessWrapper({wrapperPath, manifestPath, manifest})`
  写出 0500 的 shell wrapper（内容 = `exec <平台二进制> __opencode-netless-subprocess
--manifest <path> "$@"`）+ 0400 manifest；
- `main.ts` 的隐藏命令 `__opencode-netless-subprocess` → `runNetlessSubprocess`
  读 manifest → `renderNetlessInvocation` 施加 provider 的无网边界 → spawn 真命令，
  **stdio 全 inherit**（正是 MCP stdio 直通所需）；
- 因此 claude 侧只需把 `toClaudeMcpConfig` 里 `type==='local'` 条目的 `command`
  指向该 wrapperPath（原 command/args 进 manifest），claude fork wrapper 即落入边界。

**唯一新增依赖**：manifest 需要 provider child plan，它来自 containment 准入；claude
driver 现固定申请 `runner-filesystem-v1`（无 child plan）。因此 T5 必须先让 claude
driver 声明 `businessContainmentProfile`——有启用的 local MCP（且该节点受控）时申请带
child provider 的 profile，与 opencode driver 的同名方法同构。这一步是 T5 的真正
工作量，wrapper 本身是复用。

C-3 降级为兜底：仅当某平台缺 provider 能力（如未来 Windows 无对应实现）时，按
`warn/off` 语义显式声明该保证不可达，而不是静默失效。

### 4.3 T5 实施纪要（2026-07-31 落地，PR-3）

实现与 §4.2 的探明路径一致（零新机制）。落地时另做了三处判断（真 claude 实测另抓到两条行为，见 §4.4）：

1. **profile id：重命名而非新增**。原计划新增一个运行时中立 id 与
   `opencode-verified-v1` 并存。实施时改为把该条目**整体重命名**为
   `model-child-netless-v1`，理由：
   - profile 是「需求包」，命名 WHAT 而非 WHO；两个 required 完全相同的 bundle 并存
     等于埋一个漂移点（改一个忘一个），单一事实源优先；
   - 这个 id 会**露给用户**——`task.ts` 的 `sandbox-unavailable` 报错、
     `doctor` / `sandbox` CLI、`/api/runtimes/status` 都带它。claude 工作流报
     "containment profile 'opencode-verified-v1' 不可用" 是误导；
   - 它**不进任何持久物**：`businessOpencodeIdentityDigest`（resume 归属）不含
     profileId，verified launch manifest 是同一次 run 内写读，故零迁移。
   - 同时把 `verifiedManifest.ts` 里对 profile id 字面量的两处判断改为从
     `CONTAINMENT_REQUIREMENT_PROFILES[...].childBoundary` 推导（RFC-227：id 是身份，
     不是能力判据），profileId 的 zod enum 也改为从注册表 key 派生。
   - `claudeCodeDriver.mcpTest.containmentProfile`（RFC-238 已在申请该 profile）随之
     自动获得中立命名，无需另立 id。
2. **触发条件 = 受控 ∧ 有启用 local MCP ∧ 工具门未放行 Bash**。判据单点是
   `netlessMcp.ts` 的 `claudeLocalMcpFenceDecision()`——`businessContainmentProfile`
   （决定**需求**，在 spawn 之前）与 `buildBusinessSpawn`（决定**物化**）必须同源，
   否则要么多拦一次启动、要么承诺一个没建出来的边界。**四条**排除各有理由
   （`test-runtime-head` 是 §4.5-9 补齐的第四条：初版只给需求侧喂了两个输入）：
   - `unconstrained`（未声明权限）：存量零破坏（§7 决策 2），抬高 profile 会让
     `sandboxMode=enforce` 拦住今天能跑的任务；
   - `no-local-mcp`：remote MCP 没有子进程可关；
   - `test-runtime-head`（注入了多 token 的测试 head）：它的假 claude 不 fork MCP，
     抬高需求等于白白降级外层沙箱；
   - `unfenced-shell`（放行了 Bash）：**实测约束**。2026-07-31 本机实测 macOS
     **嵌套 `sandbox-exec` 不可行**——`sandbox-exec: sandbox_apply: Operation not
permitted`。因此 RFC-227 的 `provider-child-only` 是必然而非偏好：在 Seatbelt
     provider 上申请 `childBoundary: 'model-controlled'` 会让平台边界**整体下移到子
     进程层**，runner 的 outer sandbox 被丢弃（`wrapSpawnPlanSandbox` 直接返回裸
     cmd）。这笔交易只有在「所有模型可控子进程都走 child launcher」时才划算——
     verified opencode 路径成立（shell 与 local MCP 都经 `materializeNetlessWrapper`），
     claude 尚不成立（§4 C-2「Bash 走同一 wrapper」仍未做）。若对放行 Bash 的节点也
     下这道围栏，等于用「claude 自身 + 其 shell 子进程失去文件系统边界」换「MCP 子进程
     获得网络边界」，**净亏**。故这类节点保留今天的 outer sandbox，并在 spawn 期打
     `claude-mcp-netless-skipped` 告警（不静默）。Linux 上本可两者兼得（
     `runner-outer-and-child`），但 driver 不得按 provider/OS 分叉（RFC-227），故统一
     按此规则；C-2 落地后该排除项即可移除，Linux 与 macOS 一起受益。

   **行为变化**：满足上述三条的 claude 节点在 `sandboxMode=enforce` 且宿主无 provider
   时会在启动期被拦（与 opencode 同级）。

   **macOS 上的边界交换（措辞更正，2026-07-31 对抗复核 P1-2）**：本节初版写的
   「runner outer sandbox **由 child Seatbelt 取代**」**不准确**，容易读成"边界只是换了
   一层"。准确表述是：

   - child Seatbelt **只包住 local MCP 子进程**（wrapper 里那一个 `sandbox-exec`）；
   - claude **主进程**（持 Read/Edit/Write/WebFetch 等**进程内**工具）在
     `provider-child-only` 拓扑下**没有任何平台文件系统边界**——`wrapSpawnPlanSandbox`
     对该拓扑直接返回裸 cmd。它此时只剩 claude 自身的 `--tools` 装载集 + `dontAsk`
     的 cwd 自动判定这层**运行时内**约束；
   - 因此这是一笔**交换**（MCP 拿到网络边界 + 自己的文件系统 jail，claude 主进程失去
     平台文件系统 jail），不是纯增益。Linux 上不存在这笔交换：bwrap 可嵌套，拓扑是
     `runner-outer-and-child`，两层同时成立。

   **为何仍然保留这笔交换（复核给的 (b) 案未采纳，理由）**：

   - 这个姿态**不是 claude 独有的新缺口，而是 RFC-227 对 verified opencode 早已成立的
     同一笔交易**：opencode 的 write/edit/read 工具同样跑在 server **进程内**
     （`opencode/packages/opencode/src/tool/write.ts` 用 `FileSystem`/`FSUtil` 服务，
     不 fork），而 `sandbox/index.ts:114-131` 的注释正是说 verified opencode business
     plan 在 macOS 上把 server 留在 runner wrapper **之外**。若只给 claude 收紧，
     claude 会比 opencode **更严**，与本 RFC「姿态对齐」的目标背道而驰。
   - (b) 的字面做法「C-2 落地前不申请该 profile」在 driver 层不可实现：
     `businessContainmentProfile` 只吃 `(agent, mcps, runtimeCmd)`，且 RFC-227 明令
     driver 不得按 provider/OS 分叉。要"按 provider 能力区分"就必须在 RFC-233
     coordinator 里新增一档 `childBoundary`（"要 child 但**不得**牺牲 outer"）：在
     macOS 上它只有两种收场——把 receipt 报成 `contained` 却不施加 child 边界（RFC-227
     明令禁止的"静默承诺"），或在 `enforce` 下判 `blocked`（**直接拦死** macOS 上今天
     能跑的任务）。二者都比现状差，且改的是单一准入权威的核心判定。
   - 代价对比：被围栏的是**用户配置的第三方 MCP server 代码**（真正的外来代码），换来的
     是 claude 自身少一层纵深防御——而 claude 自身仍受工具门约束。

   **补偿措施（本轮已落）**：这笔交换不再只存在于文档里——`buildBusinessSpawn` 在拓扑
   确实降为 `provider-child-only` 时打 `claude-mcp-netless-outer-dropped` 告警（与
   `claude-mcp-netless-skipped` 同级），把"哪一层被换掉了"写进 node_run 日志。彻底解除
   靠 C-2（Bash 走同一 wrapper），届时 macOS 也能把**全部**模型可控子进程收进 child
   边界，交换消失。已在 `docs/audit-backlog.md` 登记为未决项。

3. **顺带修一个死围栏**：`SpawnPlan.preSpawnVerify` 在 `systemAgentRun` 侧自 RFC-237
   起就被 await，但**业务侧 `runner.ts` 从未调用**——即 T2 封印二进制的 TOCTOU 复检
   一直是空转。T5 在 `Bun.spawn` 前补上 `await plan.preSpawnVerify?.()`，并让
   preSpawnVerify 抛出的 identity code 走 `executionIdentityFailureCodeOf` 保真上报。
   T5 自己的 wrapper/manifest 摘要复检与二进制封印复检合成同一道围栏。

### 4.4 T5 真实 claude 端到端实测（2026-07-31，claude 2.1.220 / macOS）

用**平台自己产出的 argv + wrapper**（非简化复现）跑真 claude，拿到两条此前未知的行为，
并各自落成修复 + 测试锁：

1. **`dontAsk` 下 MCP 工具默认被拒**。受控业务节点（PR-2 的工具门形状）连上 MCP 后调用
   `mcp__probe__netprobe`，claude 返回
   `Permission to use mcp__probe__netprobe has been denied because Claude Code is
running in don't ask mode`。即 `--tools` 只管**内置**装载集，MCP 工具另受
   `--allowedTools` 管辖（RFC-238 playground 早就在传 `--allowedTools`，业务面漏了）。
   **这不是 T5 引入的**：存量 `bypassPermissions` 形状放行一切，所以只有 PR-2 之后的
   受控节点会中招——受控 claude 节点的 MCP **一个都调不动**。
   修复：受控业务形状按节点自己的 MCP 名字下发
   `--allowedTools mcp__<name>__*,…`（不用宽泛 `mcp__*`；`--strict-mcp-config` 已经把
   服务器集合钉死）。同一次实测确认**内置工具不受影响**：加了 allowlist 之后
   `Read` 仍按 cwd 自动放行，同回合 MCP 调用与 `Read` 双双成功。
2. **claude 在 init 事件上冻结 MCP 可用性**。`initialize` 应答慢的 server 在 init 时为
   `status: 'pending'`，其工具**整回合都不会出现**在模型的工具表里。用裸 server 加
   `sleep` 对照：`0s → connected`、`0.3s → pending`、`1.0s → pending`。
   平台 wrapper 的首答延迟：**dev 模式（`bun run main.ts`，全量 import graph）≈ 210ms
   → 与阈值同量级，实测会闪**；**生产单二进制热态 ≈ 140ms → 连续多次 `connected`**，
   但**冷态（二进制刚落盘 / 页缓存未热）首次 ≈ 646ms，实测即 `pending`**。裸 bun 启动
   仅 ≈ 10ms，可见这 140-210ms 几乎全是 import graph / 二进制加载成本。
   **运维含义**：升级或首次部署后的**第一个** claude 受控 MCP 节点可能整回合拿不到
   MCP 工具（后续节点正常）。
   最终端到端（生产 wrapper + 平台受控 argv + 真 claude）：`TOOL_USE mcp__probe__netprobe`
   → `NETPROBE_RESULT net=000 home=<私有 scratch home>`，同回合 `Read` 正常——
   **围栏生效 + MCP 工具可调用 + 内置工具不受损**三条同时成立。
   **残留**：dev 模式常态、生产冷启首次会丢 MCP 工具，根因是隐藏子命令与 daemon 共用
   `main.ts` 的顶层 import graph；正解是把 CLI 子命令改成惰性 `await import`，让
   `__opencode-netless-subprocess` 不为整个 daemon 付启动成本（同样惠及 opencode
   local MCP 与 RFC-238 playground）。已登记 audit-backlog，未在本切片动。
   （flag 顺序无关：平台实际产出的 argv 顺序——`--allowedTools` 在
   `--append-system-prompt-file` 之前、`--mcp-config` 在其后——已按原样对真 claude
   验过，热态 `connected` + `net=000`。）

MCP-authored env 顺带收益：包进 0400 manifest 后不再随 `--mcp-config` 的 inline JSON
进 argv（即不再对宿主上任何 `ps` 可见）。remote MCP 两条路径都零改动。

### 4.5 T5 复核修复批（2026-07-31，对抗性安全复核 + Codex 实现门）

PR-3（`e050d792`）上库后各跑了一轮：一次**对抗性安全复核**、一次外部 **Codex 实现门**
（pin 在 `bcc5dcaf..e050d792`）。两边**各自独立**命中同两条（git 外部 common dir 缺注册
校验、npx PATH 丢失），另各有独有发现。处置如下。

**逃逸类（P0，同一类缺陷的两个入口：攻击者可影响的路径 → 可写 allow-back）**

1. **伪造 `.git` 指针劫持 git allow-back**。`<worktree>/.git` 是 agent 工作区内的普通
   可写文件（对任务内每个节点、以及被围栏的 MCP 子进程本身都可写——worktree 就是
   manifest 的可写 allow-back 之一）。把它改成 `gitdir: <另一个仓>/.git`，git 会**如实
   报告**那个 common dir，初版原样规范化后作为**可写子树**写进 manifest；由于可写
   allow-back 在 realHome/appHome 掩码**之后**施加，真实 Seatbelt/bwrap 子边界内的进程
   即可写入例如 `<appHome>/repos/<other>/.git/hooks/post-commit`——该 hook 之后以
   **daemon 身份、在所有沙箱之外**执行。
   根因是**代码重复**：初版在 `claudeCode/netlessMcp.ts` 里私抄了一份 opencode 的投影，
   漏掉三道检查（对报告路径 `lstat` 拒 symlink/非目录、`realpath(reported) === reported`、
   外部 common dir 时 `assertRegisteredGitWorktree`）。
   **修法（取"提取共用"而非再补一份）**：新增 `services/runtime/netlessProjection.ts` 为
   **唯一**投影权威，`verifiedPlan.ts` 与 `netlessMcp.ts` 同时消费；两处语义差用一个显式
   参数表达（`undescribableRepo: 'fail-closed' | 'skip-projection'`——opencode 的业务
   worktree 必是真仓库故 fail-closed，claude 允许非 git 的 scratch worktree 只丢投影）。
   **注意这不是宽容 git 的报告**：一旦 git **报出**了 common dir，两条运行时走完全相同的
   全套校验。实测复现（git 2.50.1）：伪造后 `git rev-parse --git-common-dir` 确实指向外
   仓，而该外仓的 `git worktree list` 不含本 worktree → fail closed。
2. **scratch 子目录被 symlink 重入劫持**。inline-clarify 重入复用同一 runRoot，上一轮
   被围栏的子进程对 `claude-mcp-scratch` 有写权限，可把 `home`/`tmp` 换成 symlink；
   `mkdir(...,{recursive:true})` 接受该 link、`realpath` 忠实跟随，于是下一轮 manifest
   的 HOME/TMPDIR 指向外部目标并被授予**可写** allow-back。
   **修法**：同一模块的 `ensurePrivateNetlessDirectory(root, ...segments)`——逐级
   非递归 `mkdir` + `lstat` 拒 symlink/非目录 + 全路径 `realpath === self`，seal 根、
   scratch 根、home、tmp 全部改走它。
   两条均有**红/绿变异实证**（去掉对应检查即红）。

**功能回归 / 静默降级类**

3. **`npx` 型 local MCP 被围栏后静默失效**（两边同时命中）。`/opt/homebrew/bin/npx`
   realpath 到 `.../npm/bin/npx-cli.js`（`#!/usr/bin/env node`），而该 dirname 里没有
   `node` → wrapper `exit 127`；claude 侧表现为 `mcp_servers:[{status:"failed"}]`、
   工具表缺失、**节点照常 `is_error:false` 成功结束**。
   **修法（两半都要）**：(a) 解析 `#!` 解释器链（`env` 形式取其后的工具名），把解释器的
   canonical 路径加入 `bindReadOnly`、其目录加入围栏 PATH——已在固定 netless PATH 内的
   解释器（`/bin/sh`）不重复投影；解析不出解释器则 fail closed（否则必 127）。
   **真边界实测（macOS Seatbelt，2026-07-31 本轮）**：`#!/usr/bin/env fakenode` 的
   launcher 经平台 wrapper 起在真 Seatbelt 子边界内 → `exit 0` +
   `interp-ok net=000 home=<私有 scratch home>`（修复前同一输入 exit 127）。
   (b) **静默降级变显式失败**：`SpawnPlan.fencedMcpServers` 声明平台围栏了哪些 server，
   `RuntimeDriver.parseUnusableMcpServers` 解析 claude init 事件的 `mcp_servers`，runner
   在**任一被围栏 server 不是 `connected`** 时 kill 并把节点判 `failed`
   （`mcp-unavailable: …`）。按 §4.4 的实测，`pending` 与 `failed` 对模型是同一后果
   （整回合无该 server 工具），故同等对待；不设 `failureCode`，节点按重试语义再来一次
   （冷启 `pending` 可自愈）。**只对被围栏的 server 生效**，存量/未围栏 MCP 行为不变。
4. **合法 MCP `env` key 现在硬失败**。初版把 MCP 作者写的 env 丢进**daemon env**
   的允许名单（要求 SCREAMING_CASE）再按数量差 fail——实测 `{token}` / `{apiKey}` /
   `{PYTHONPATH}` / `{NODE_OPTIONS}` 全部抛错，而这些此前可用。同一名单在 opencode 侧
   是**静默丢弃**（更糟：server 少了凭据却无任何日志）。
   **修法**：区分两类环境——daemon env 仍走原名单；**MCP 作者写的 env** 走新的
   `sanitizeMcpAuthoredEnvironment`：名字合法（POSIX identifier，大小写不限）即**转发**，
   只拒**动态链接器族**（`LD_*` / `DYLD_*`，因为 `bwrap`/`sandbox-exec` **本身**先读到
   这份环境，边界尚未建立），失败消息带 `/mcp/<name>/env/<KEY>` 定位。同一规则前移到
   **保存期**（`McpLocalConfigWriteSchema`，只挂写路径——读路径不动，存量行仍可读）。
   claude / opencode / RFC-238 playground 三处 MCP env 消费点统一到这一个函数。
5. **相对路径 MCP 命令解析基准错了**。`./tools/server` 此前由 claude 以任务 worktree 为
   cwd 启动；初版交给 `Bun.which`，它对含斜杠 token 相对 **daemon cwd** 解析 → 要么失败、
   要么执行安装目录里同名的无关文件。**修法**：含分隔符的相对 token 相对
   `canonicalWorktree` 解析；PATH 查找只留给裸名字。
6. **RFC-067 任务级 git 身份在被围栏的 MCP 里丢失**。`runNetlessSubprocess` **替换**而非
   继承子进程环境，manifest 里没带身份 → 围栏内 commit 用错身份或在私有 scratch HOME 下
   失败。**修法**：`buildBusinessSpawn` 把 `gitUserName/gitUserEmail` 传进物化，
   manifest env 带上四个 `GIT_AUTHOR_*`/`GIT_COMMITTER_*`（与 opencode wrapper 同形）。

**其余（P2）**

7. **MCP 密钥仍进 argv（Linux）**。`inject.ts` 声称密钥不再走 argv，但 bwrap 渲染用
   `--setenv NAME VALUE`，于是密钥落进 `/proc/<bwrap-pid>/cmdline`（**全局可读**）。
   **取正解而非收窄声明**：`renderNetlessBwrapArgs` 不再渲染 env，改由
   `renderNetlessInvocation` 把 `manifest.env` 交给 **bwrap 进程本身**——bwrap 此处没有
   `--clearenv`，其环境原样传给子进程，子进程 env 逐字不变，而 argv 里一个字节都没有。
   （remote MCP 的 header 仍在业务 argv 里，属另一条链，见 backlog。）
8. **preSpawnVerify 只验形状不验身份**。注释说"必须仍是计划时那个确切文件"，实现只有
   `lstat` + 非 symlink + isFile，换成另一个普通文件也能过。**修法**：记录并比对
   dev/ino。
9. **需求 / 物化判据漂移**。`businessContainmentProfile`（需求）只看 `(agent, mcps)`，
   物化还要 `runtimeCmd === undefined` → 注入 mock head 时会"降级了外层沙箱却没有围栏"。
   **修法**：把 `runtimeCmd` 并入**同一个** `claudeLocalMcpFenceDecision`，两侧喂同一
   seam（新增 `test-runtime-head` skipReason），runner 调用处补传。
10. **P1-2（macOS 外层沙箱）** 见 §4.3 的措辞更正 + 新增 `claude-mcp-netless-outer-dropped`
    告警；未采纳"暂不申请 profile"的理由同处，残留登记进 backlog。
11. **预览 / 准入的 MCP 集合不一致**（`task.ts` 用 `agent.mcp`、`runner.ts` 用 dependsOn
    闭包并集）：opencode 同形、属**既有**问题，claude 只是新可达。**未修，落档到
    `docs/audit-backlog.md`**——正解是让两侧共用同一个闭包解析，属独立切片。

## §5 失败模式与兼容性

| 场景                         | 处置                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 映射表未覆盖的 permission 键 | fail-closed：该类工具不装载 + 保存期告警（不静默放行）                                                        |
| 存量 agent 未声明权限        | 走 §2.3 逃生阀语义前的默认：按"最小可用集"装载并在诊断标注（**需用户拍板：默认收窄 vs 默认保持全权 + 告警**） |
| claude 版本不识新 flag       | 非零退出 fail-closed（RFC-237 既有语义）                                                                      |
| smoke 在空工具集下失败       | 视为回归，回退 §3 或调整 smoke 探针                                                                           |

零 migration、零 schema 变化（除非采纳方案 2 的 per-runtime 字段）。

## §6 测试策略

- 映射表逐条单测（opencode 词汇 × 三态 → claude 装载集/否定规则）；
- 业务 spawn 新 golden + 逃生阀 golden；
- `all-deny` 在两运行时的等价断言（claude `--tools ""`）；
- smoke 在收窄后的三态诊断断言；
- 网络围栏：按选定方案给实测（wrapper 内 `curl` 应失败）或声明面断言（UI/docs/能力）；
- ratchet 扩展：业务分支若重新出现 `bypassPermissions` 而无逃生阀声明 → 红。

## §7 决策记录（用户 2026-07-31 拍板）

1. **权限映射形态 = 方案 1 冻结映射表**：`deny` → 该类工具移出装载集；headless 下的
   `ask` 按 `deny` 处理并在保存期告警；`allow`/缺省保留；映射未覆盖的键 fail-closed。
2. **存量默认 = 保持全权 + 显著告警**：未声明权限的 agent 在 claude 上行为不变（升级
   零破坏），但设置页/agent 编辑器给出 `unconstrained` 告警、node_run 诊断标注同名字段，
   用户按自己节奏逐个收窄。**不允许静默全权**——告警是这条路径的硬要求。
3. **网络围栏 = 先验证再定档 → 实测通过，定档 C-1**（见 §4.1）。
