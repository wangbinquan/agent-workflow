# RFC-237 意图构建器支持 Claude Code 运行时（design）

状态：Draft。所有 `文件:行号` 锚点基于 2026-07-30 的 main（`9cbd9a52` 后工作树）。

## §0 现状锚点速查

| 关注点 | 锚点 | 现状 |
|---|---|---|
| profile 枚举 + 「仅 opencode 可证」文档 | `packages/backend/src/services/runtime/types.ts:255-274` | `SYSTEM_PERMISSION_PROFILES = ['all-deny','intent-read-v1']`，注释写明 other drivers must fail closed |
| 保存门 | `packages/backend/src/routes/config.ts:79-91` | `resolved.protocol !== 'opencode'` → 422 |
| 启动门 | `packages/backend/src/services/intent/turnEngine.ts:649-676` | `runtime.protocol !== 'opencode'` → ConflictError |
| claude driver fail-closed | `packages/backend/src/services/runtime/claudeCode/driver.ts:79-105` | 非 `all-deny` profile → throw |
| claude spawn 装配 | `packages/backend/src/services/runtime/claudeCode/spawn.ts:81-155` | `-p --output-format stream-json --verbose --permission-mode bypassPermissions`，stdin prompt，私有 `CLAUDE_CONFIG_DIR`，继承 `process.env` |
| claude configDir 预备（skills + 凭据桥） | `packages/backend/src/services/runtime/claudeCode/config.ts:31-85` | 仅桥接 credentials 文件；env 鉴权时跳过 |
| opencode 只读 profile 物化 | `packages/backend/src/services/runtime/opencode/verifiedSystemPlan.ts:166-181`、`hermetic.ts:565`（`SYSTEM_READ_ONLY_TOOLS = ['read','grep','glob']`） | verified 链专属 |
| opencode 二进制封印 | `packages/backend/src/services/runtime/opencode/runtimeBinary.ts` 全文 | 实现本身运行时无关（见 §3） |
| system agent 运行原语 | `packages/backend/src/services/systemAgentRun.ts:231-705`；spawn 调用 `:380-392`；子会话补捞 `driver.kind === 'opencode'` 特判 `:622-637`；`identityFailureCode` `:144` | 捕获特判是 RFC-143 锁的逃逸旁路 |
| turnEngine 调 runSystemAgent | `packages/backend/src/services/intent/turnEngine.ts:442-474` | 已传 `protocol` / `runtimeBinary` / `systemPermissionProfile: 'intent-read-v1'` / `eventSink`；`opencodeCmd` 无条件品牌传参（claude driver 不消费该字段，无害） |
| RFC-143 源码锁 | `packages/backend/tests/rfc143-runtime-driver-capability.test.ts:214-247` | 正则只盖 `(?:runtime\|protocol)\s*===`，`!==` / `kind` / `defaultRuntime` 逃逸 |
| 已知逃逸旁路 | `routes/config.ts:85`（`!==`）、`intent/turnEngine.ts:671`（`!==`）、`systemAgentRun.ts:626`（`kind ===`）、`cli/start.ts:194`（`defaultRuntime ===`） | 前三处本 RFC 消除；start.ts 入白名单 |
| 前端 hint 文案 | `packages/frontend/src/i18n/en-US.ts:976-981`、`zh-CN.ts:5141`（`intentRuntimeHint`；另有 `intentHint` 尾句） | 「仅可选 opencode 协议」 |
| 设置页 intent 卡 | `packages/frontend/src/routes/settings.tsx:1368-1437`（`RuntimeSelect`） | 无协议过滤，约束仅文案 + 保存 422 |
| claude probe 下限 | `packages/backend/src/services/runtime/claudeCode/probe.ts:18` | `MIN_CLAUDE_CODE_VERSION = '2.0.0'`（advisory，不阻塞保存/运行） |

## §1 能力模型：narrowed profile 由 driver 声明

### 1.1 接口

`RuntimeDriver`（`packages/backend/src/services/runtime/types.ts`）新增**只读能力字段**：

```ts
/**
 * RFC-237 — narrowed system-permission profiles this driver can MATERIALIZE
 * (turn into an enforced spawn shape), beyond the 'all-deny' default.
 * Admission gates (config save / intent turn launch) consult this set instead
 * of discriminating on protocol literals; a driver that omits a profile stays
 * fail-closed exactly like today. 'all-deny' is deliberately NOT part of this
 * set — its per-driver semantics are documented on SYSTEM_PERMISSION_PROFILES.
 */
readonly narrowedSystemPermissionProfiles: readonly Exclude<SystemPermissionProfile, 'all-deny'>[]
```

- `opencodeDriver`：`['intent-read-v1']`（物化 = verified system plan，
  `verifiedSystemPlan.ts:166-181`，不变）。
- `claudeCodeDriver`：`['intent-read-v1']`（物化 = §2 的受控 spawn）。
- 未来 driver 缺省声明 `[]` → 两道门继续 422 / Conflict，fail-closed 不放松。

不做成方法（`supportsProfile()`）而做成数据字段：admission 在路由层是同步上下文
（`routes/config.ts` 的校验循环），字段可直接读；且与 `containmentProfile` /
`minVersion` 等既有只读能力字段形制一致。

### 1.2 admission 门重构

**保存门** `routes/config.ts:79-91`：

```ts
if (nextConfig.intentBuilderRuntime !== undefined) {
  const resolved = await resolveInternalAgentRuntime(deps.db, { … })
  assertResolvedExecutionPolicy(resolved)
  if (!getRuntimeDriver(resolved.protocol).narrowedSystemPermissionProfiles.includes('intent-read-v1')) {
    throw new ValidationError('intent-runtime-unsupported',
      `runtime '${…}' (protocol '${resolved.protocol}') cannot enforce the intent-read-v1 permission profile`)
  }
}
```

错误码 `intent-runtime-unsupported` 保留（对未声明协议语义不变）；消息去掉
「select an opencode runtime」尾句。**启动门** `turnEngine.ts:671-676` 同构改写，
`ConflictError` 语义不变。注释里「FAIL-CLOSED twice」的双门结构原样保留
（`turnEngine.ts:649-652` 注释同步改措辞：门从 protocol 判别改为 driver 能力判别）。

**继承态保存门（设计门 P2-3，修一个现状就有的洞）**：`intentBuilderRuntime` 未设时保存
门整段跳过，而 launch 按 `defaultRuntime` 继承——现状下就存在「default 换成不合格协议 +
intent 留空 → PUT 成功、每次 launch Conflict」的错位（对 opencode/claude 放行后不再触发，
但对未来未声明协议依旧）。修法：`routes/config.ts:94-102` 已有的「defaultRuntime 变更 →
fan-out 校验」区内补一条——若 `intentBuilderRuntime` 未设（含本次 PUT 后仍未设），按新
default 解析**有效** intent 运行时并做同一能力检查，422 文案指明是继承路径命中。显式
设置分支行为不变。T-C 增继承态用例（unsupported default + intent 留空 → 422）。

`packages/shared/src/schemas/config.ts:221-229` 的 `intentBuilderRuntime` 注释同步改为
「only runtimes whose driver declares the 'intent-read-v1' narrowed profile are admitted
(v1: opencode via the verified system path; claude-code via the RFC-237 declared-control
spawn)」。

`turnEngine.ts:453-457` 的 `markProductionOpencodeCommand` 品牌传参**保持无条件**：该
seam 只被 opencode driver 消费（`runtime/opencode/driver.ts:94-99` 判定 verified vs
legacy），claude driver 不读 `opencodeCmd`（`SystemAgentSpawnContext` 文档已注明），对
claude head 品牌是纯 no-op——保持无条件即保持 turnEngine 零协议分支。

### 1.3 `all-deny` 的诚实记录（行为不变）

`SYSTEM_PERMISSION_PROFILES` 文档（`types.ts:255-268`）改写为按 driver 记录物化事实：

- `all-deny`：opencode verified 链物化为全拒工具；**claude driver 接受该 profile 但以
  RFC-117 的 legacy 语义运行（`bypassPermissions`，无工具门）**——这是本 RFC 之前就存在
  的语义空洞，距离叙述为已知差异；收窄它（例如 `--tools ""`）会改变 distiller / smoke 在
  claude 上的诊断面与既有 argv 锁，列为后续演进项，不在本 RFC 范围。
- `intent-read-v1`：opencode = verified 链 `read/grep/glob`；claude = §2 受控 spawn
  `Read/Grep/Glob`。「only the opencode verified path implements it」一句删除。

claude driver 的 fail-closed 判定从字面量改为查自身声明：

```ts
if (ctx.systemPermissionProfile !== undefined && ctx.systemPermissionProfile !== 'all-deny'
    && !claudeCodeDriver.narrowedSystemPermissionProfiles.includes(ctx.systemPermissionProfile)) {
  throw new Error(…)  // 未知/未声明 profile 仍 fail-closed
}
```

## §2 claude `intent-read-v1` 的受控 spawn 契约

### 2.1 实测记录（v2.1.220，2026-07-30，darwin）

一次性验证命令（scratch 空目录、haiku、`--max-budget-usd 0.5`）：

```
claude -p "<read seed.txt then try Write/Bash>" \
  --tools "Read,Grep,Glob" --permission-mode dontAsk --strict-mcp-config \
  --setting-sources "" --no-session-persistence --output-format json
```

观察到的**全部关键事实**：

1. init 事件 `"tools":["Glob","Grep","Read"]`——`--tools` 是装载面裁剪，非权限包装。
2. 模型调用 `Write` → tool_result `is_error`：`No such tool available: Write. Write exists
   but is not enabled in this context`；**进程继续运行**至正常 result，无挂起、无崩溃。
3. `Bash` 完全不在装载集，模型自报 "no shell/bash tool available"。
4. `--strict-mcp-config` 且无 `--mcp-config` → `"mcp_servers":[]`。
5. `--setting-sources ""` 被接受（exit 0）。
6. `"permissionMode":"dontAsk"`，`"permission_denials":[]`——read-only 集自动放行，headless
   下无提示挂起风险。
7. result 事件：`is_error:false`、`terminal_reason:"completed"`、`num_turns`、
   `total_cost_usd`、`session_id`——与 `claudeCode/events.ts` 既有归一化兼容。
8. 退出码 0。
9. **反面发现**：该实验未迁 `CLAUDE_CONFIG_DIR`，init 里 skills / slash_commands / agents
   仍从真实 `~/.claude` 装载——证明 settings 三源之外还有 config-dir 装载面。生产路径
   私有 configDir 使其自然为空，`--disable-slash-commands` 作为纵深防御仍要加。
10. subagent 面：内置 agents 列表虽在 init 里出现，但 `Task` 不在 `--tools` 白名单 →
    不可调用，subagent 面闭合（同时系统代理路径本就不注入 `--agents`）。

**逃逸负向实测**（同日第二轮，设计门 P1-4 的 qualification；同一 flag 组合）：

11. `Read /etc/hosts`（cwd 外绝对路径）→ **拒**：`Permission to use Read has been denied
    because Claude Code is running in don't ask mode`（is_error tool_result，进程继续）。
12. `Read ./link-to-hosts.txt`（cwd 内 symlink → `/etc/hosts`）→ **拒**（同上）——
    Claude Code 按 realpath 解析后的目标路径判定，symlink 不构成逃逸通道。
13. `Read ../outside-secret.txt`（相对路径逃逸）→ **拒**（`permission_denials` 里以解析后
    绝对路径记录）。
14. `Read seed.txt`（cwd 内）→ 成功。final result 的 `permission_denials` 数组完整列出
    全部拒绝（tool_name + tool_input），可作诊断/审计面。
15. 拒绝消息会提示模型「可尝试其他工具」，但白名单内（Read/Grep/Glob）无任何写入 /
    shell / 网络工具，无可乘之隙。

**结论**：`dontAsk` 的 read-only 自动放行范围就是会话 cwd；cwd 外读一律拒。凭据文件
`.credentials.json` 位于 `<runDir>/<leaf>/`——`runDir` 与 cwd（`worktreeDir`）是 scratch
下的**兄弟目录**（`systemAgentRun.ts:240-241`），天然落在 cwd 外拒绝面内，模型不可读。
CLI 行为属外部依赖：CI 用 mock 锁 argv 形状（dontAsk + `--tools` 不漂移），行为本身由
本节实测 + §10 真机验证清单（逃逸三连）承载。

### 2.2 spawn 形状（driver `buildSpawn` 的 `intent-read-v1` 分支）

`claudeCode/spawn.ts` 扩展 `ClaudeSpawnContext`，新增可选
`systemPermissionProfile?: SystemPermissionProfile`（driver 透传）。`buildClaudeSpawn` 在
`profile === 'intent-read-v1'` 时装配（其余调用方 byte-unchanged）：

> **设计门 P1-2**：`SystemAgentSpawnContext` 同步新增可选 `configDirEnv?` /
> `configDirName?`（RFC-154 自定义 fork 的 config-dir 键/叶名）；`turnEngine` 从
> `deps.config.runtime` 行透传，claude driver 转交 `buildClaudeSpawn`（该 ctx 字段
> `spawn.ts:46-47` 早已存在，只是系统路径此前未线程化——RFC-154 §2.3 当时明确让系统
> 路径停留在协议默认，本 RFC 在 intent 场景推翻该限制：自定义 fork 若改了发现键而我们
> 仍设默认键，受控隔离整体失效）。opencode driver 忽略这两个字段；distiller / smoke
> 调用方不传（all-deny 路径 byte-unchanged）。含默认键 scrub 语义（`spawn.ts:142-144`）
> 的自定义键用例进 T-A。

```
<sealedBinary> -p --output-format stream-json --verbose \
  --permission-mode dontAsk \
  --tools Read,Grep,Glob \
  --strict-mcp-config \
  --setting-sources "" \
  --disable-slash-commands \
  [--model <runtime.model>] \
  --append-system-prompt-file <attemptDir>/system.md
```

- prompt 照旧走 stdin（`stdin: {mode:'pipe'}`，E2BIG 规避不变）。
- **不出现** `bypassPermissions` / `--dangerously-skip-permissions`；相应地该分支**不注入**
  `IS_SANDBOX=1`（root gate 只针对 bypass；非 bypass 下注入等于虚假宣告沙箱，
  `spawn.ts:68-79` 的 `claudeSandboxEnv` 仅保留在 bypass 分支）。
- 不加 `--mcp-config`（intent 系统代理零 MCP；`--strict-mcp-config` 单独出现即拒绝其他
  来源，实测 #4）。
- 不加 `--agents`（系统代理无 dependsOn）。不加 `--resume`（intent 每轮 ephemeral、全量
  上下文重放，`turnEngine` 不传 resumeSessionId）。
- 不加 `--no-session-persistence`：transcript 落在 scratch 内私有 configDir，成功随
  scratch 删除、失败随 `scratchRetained` 保留供排障——与 opencode 失败留 store 的语义
  对齐。
- `--max-turns` 不加：预算护栏沿用 intent 已有的 turn timeout + stdout cap
  （`turnEngine.ts:680-681`），与 opencode 路径对齐。
- managed settings（IT 管控面，不属于 user/project/local 三源）仍会加载——那是宿主机
  管理员的意志，明确接受并记录于此。

### 2.3 受控 env（该分支专用，替代全量继承）

现状 `spawn.ts:124-137` 以 `...process.env` 全量继承。`intent-read-v1` 分支改为
「继承 - 黑名单剥离 + 受控注入」（**不做全量白名单**——鉴权变量族开放且多样：
`ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、Bedrock/Vertex 的 `AWS_*`/`GOOGLE_*`、代理
`HTTP(S)_PROXY`，白名单必漏；黑名单针对确定有害项）：

剥离（child 误认嵌套会话 / 继承父传输的内部标记；multica `server/pkg/agent/claude.go`
`isFilteredChildEnvKey` 同一清单，本机验证同版本语义。**设计门 P2-2**：`IS_SANDBOX` 一并
剥离——本分支非 bypass、契约要求该变量缺席，daemon 自身环境若带它，继承会让 child 误认
沙箱态；T-A 覆盖「daemon env 预置 IS_SANDBOX=1 → plan env 无此键」）：

```
CLAUDECODE、CLAUDE_CODE_ENTRYPOINT、CLAUDE_CODE_EXECPATH、
CLAUDE_CODE_SESSION_ID、CLAUDE_CODE_SSE_PORT、前缀 CLAUDECODE_*、IS_SANDBOX
```

注入：

```
DISABLE_AUTOUPDATER=1  DISABLE_TELEMETRY=1  DISABLE_ERROR_REPORTING=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

既有键保留：`PWD`、`[configDirEnv]=<attemptDir>/<leaf>`（含 RFC-154 自定义键 scrub 逻辑
`spawn.ts:142-144`）、git identity。用户配置命名空间 `CLAUDE_CODE_*`（非上述内部标记）
全部放行——`CLAUDE_CODE_GIT_BASH_PATH` 类变量是用户刻意设置（multica 曾因整前缀剥离
把 Windows 打崩，引以为鉴）。

### 2.4 二进制封印（该分支强制）

- driver `buildSpawn`（async，可 IO）在装配 argv 前：
  1. source = `ctx.runtimeBinary` 非空取之；否则 `defaultBinary(config)`（`['claude']`
     PATH token 或 `config.claudeCodePath`）。封印函数原生支持单 PATH token / 单绝对路径
     （§3 `resolveSingleExecutable`）。
  2. `snapshotRuntimeBinary({ command:[source], snapshotPath: join(ctx.runDir,'bin','claude-sealed') })`
     —— 0700 私有目录、`COPYFILE_EXCL` 独占复制、0500、复制前后双 hash + source
     inode/size/mtime/ctime 复核（TOCTOU 围栏语义与 opencode 逐条相同，§3）。
  3. argv head = 快照路径；`verify`（exec 前再验）由 snapshot 内部完成后返回。
  4. 快照生命周期 = scratch（`systemAgentRun` 成功删 scratch / 失败保留，无需新 GC）。
- 失败 → 抛 `RuntimeBinarySnapshotError`（`code = 'execution-identity-untrusted-binary'`，
  §3 别名保证同一性）→ `systemAgentRun.ts:400-402` 的 `identityFailureCode` 既有链路
  捕获 → `identity-failed` + failureCode 上浮为 turn error。链路零新代码。
- **spawn 边界再验（设计门 P1-3）**：snapshot 内部 verify 发生在 `buildSpawn` 返回前，
  与 `Bun.spawn` 之间仍有窗口。`SpawnPlan` 新增可选钩子
  `preSpawnVerify?: () => Promise<void>`；`systemAgentRun` 在 `Bun.spawn` 前（
  `:410-423` 的 spawn try 块头部）`await plan.preSpawnVerify?.()`，抛错走同一
  `identityFailureCode` → `identity-failed`。claude `intent-read-v1` 分支提供闭包 =
  `verifyRuntimeBinarySnapshot(sealPath, digest)`（0500 + digest 复核）。窗口由此缩至
  fork+exec 前一刻——与 opencode 的差异如实记录：opencode 的 exec 前再验发生在其
  launcher 子进程内（verify 与 exec 同进程、窗口更小），claude 无 launcher 中间层，为
  此造一个专用 launcher 进程收益不成比例，declared-control 档接受父进程再验。T-A 增
  「plan 构造后替换 seal 字节 → spawn 拒绝」用例。钩子字段协议无关，opencode plan 不设
  （其再验已在 launcher 内，语义不重复）。
- 测试 seam：`ctx.testOnlyUnverifiedRuntime === true` 时跳过封印、直接用
  `ctx.runtimeBinary` 头（与 opencode legacy test spawn seam 同构；生产调用方从不设置，
  `SystemAgentSpawnContext:325-326` 既有文档）。mock-claude 用单文件可执行脚本时也可走
  真封印路径（脚本字节可封印），T2 里按既有 mock 形态择一。
- SHA-256 语义沿用 RFC-227 §2：byte/TOCTOU 围栏，**不是** vendor 签名，永不比对版本
  allowlist；`--version` 报告值不参与任何门（`MIN_CLAUDE_CODE_VERSION` 仍 advisory）。

### 2.5 configDir 与凭据

`prepareClaudeConfigDir`（`claudeCode/config.ts:31-40`）照旧：skills 注入对 intent 恒为
空数组；凭据桥接（macOS keychain / Linux credentials 文件，仅该文件，`config.ts:9-10`
信任边界不变）照旧——`--setting-sources ""` 只砍 settings 三源，不影响 configDir 内
`.credentials.json` 的鉴权读取。env 鉴权（`ANTHROPIC_API_KEY` 等）经 §2.3 受控 env
继承放行，优先级语义不变（`config.ts:49-56`）。

**桥接的触发接线（设计门 P1-1）**：现状 `turnEngine` 不传 `bridgeCredentials`，driver 只
转发显式值（`claudeCode/driver.ts:100`）——照抄会让 keychain / 订阅登录的用户在真实
intent turn 上一律 "Not logged in"。修法与业务节点同构（`buildBusinessSpawn` 以
「test-only head 缺席 = 真实运行」内化桥接决策，`driver.ts:143-144`）：claude driver 在
`intent-read-v1` 分支**内部**决定 `bridgeCredentials = (ctx.testOnlyUnverifiedRuntime !== true)`，
调用方（turnEngine）保持零 claude 细节；mock 测试因 seam 缺省不触碰 keychain（CI 约束
不变）。all-deny 系统路径的桥接现状（调用方显式传值）不动。T-A 断言两态。

## §3 二进制封印模块通用化

`opencode/runtimeBinary.ts` 的实现（resolve→hash→独占复制→re-hash→竞态复核→exec 前
再验）已是运行时无关（全文无 opencode 特有逻辑，仅命名遗留）。搬移方案：

1. 新建 `packages/backend/src/services/runtime/binarySnapshot.ts`：整体搬入实现，通用
   命名——`RuntimeBinarySnapshotError`、`inspectRuntimeBinary`、`snapshotRuntimeBinary`、
   `verifyRuntimeBinarySnapshot`、`withRuntimeBinarySnapshot`、
   `RUNTIME_BINARY_SNAPSHOT_ERROR_CODE = 'execution-identity-untrusted-binary'`（值不变）。
2. `opencode/runtimeBinary.ts` 变 thin re-export：旧名 = 新名 alias
   （`export { RuntimeBinarySnapshotError as RuntimeOpencodeBinaryError, … }`）。既有
   import 面（`verifiedPlan` / `verifiedLauncher` / `routes/runtimes.ts` / RFC-224 测试群）
   **零改动**；类同一性保证 instanceof / `error.code` 判定不漂移。
3. claude driver 从通用模块 import。`OPENCODE_BINARY_IDENTITY_CODEC` 常量留在 opencode
   侧（它进 session owner 行，是 opencode 专属身份编解码）。

不改 `runtimeRegistry.ts:423` `validateBinaryPath` 的保存期弱校验（研究另录的已知项，
非本 RFC 范围）。

## §4 systemAgentRun 子会话补捞能力化

`systemAgentRun.ts:622-637` 的 `driver.kind === 'opencode'` 特判改为 driver 可选能力
方法（`readInventory?` / `startLiveCapture?` 同款 null-object 形制，
`runtime/types.ts:456-518`）：

```ts
/** RFC-237 — post-exit child-session sweep into a system-agent event sink.
 *  opencode: SQLite store sweep (captureOpencodeSessionsToSink, moved in).
 *  claude: omitted — a system-agent spawn has no subagents (--agents never
 *  passed) and the FULL main session already streams through stdout parseEvent
 *  into the sink; there is nothing to sweep. */
captureSessionsToSink?: (ctx: SystemAgentSessionSweepContext) => Promise<SweepOutcome>
```

- opencode driver 实现搬入现逻辑（含 `plan.sessionStore.dbPath` 线程），行为字节不变。
- claude driver 省略 → `systemAgentRun` 对 undefined 直接跳过（现有 `sinkFailed` /
  `markSinkTerminal` 收尾不变）——claude intent turn 的 RFC-235 视图由 stdout 泵事件
  （`:531-568` 的 stream sink）+ `parseSessionTree` 的 claude 方言
  （`packages/shared/src/sessionView.ts:170-204`）承载，测试锁 §10-T5。

### 4.1 终态 `is_error` 结果的失败归一（设计门 P2-4）

claude 可能以 exit 0 携带终态 `result` 事件 `is_error: true`（API / 鉴权类失败）。现状
`systemAgentRun` 只按退出码定成败，`parseResultError`（`claudeCode/events.ts` 既有导出）
生产无人消费，错误文本也不进 `eventText` → 这类失败会伪装成 `intent-envelope-missing`，
根因被吞。修法（系统路径通用，业务 runner 不动）：

- claude `parseEvent` 对 `type==='result' && is_error===true` 产出归一化终态错误事件
  （携带 masked 后的 result 文本）；
- `SystemAgentRunResult` 增 `resultError?: string`；`runSystemAgent` 捕获该事件，exit 0
  但 `resultError` 非空 → 新终态 `status: 'result-error'`（fail 语义同 `exit-nonzero`，
  `stderrTail` 带该文本）；
- `turnEngine` 既有 `intent-run-${result.status}` 模板自动得到
  `intent-run-result-error`；status 联合类型扩展由 TS 穷尽检查带动 distiller / smoke
  调用方顺修。该归一对全部系统路径生效（all-deny 含）——这是修正性行为变更（此前
  同场景是 ok + 下游解析失败的误导链），在 §9 兼容性中如实登记。
- opencode driver 无此事件形态，不受影响。T-D 增「mock 输出 is_error result + exit 0 →
  turn error `intent-run-result-error`」用例。

## §5 RFC-143 源码锁强化

`rfc143-runtime-driver-capability.test.ts:229-230` 正则升级：

```ts
const kindDiscrimination =
  /\b(?:runtime|protocol|kind|defaultRuntime)\s*[!=]==\s*['"](?:opencode|claude-code)['"]|\bisClaude\b/
```

- 本 RFC 消除三处逃逸旁路（`routes/config.ts:85`、`turnEngine.ts:671` → §1.2 能力门；
  `systemAgentRun.ts:626` → §4 能力方法）。
- `cli/start.ts:194`（`config.defaultRuntime === 'claude-code'` 启动软探）加入既有
  `rfc224SecurityBoundaries` 同款白名单集合（更名为通用 allowlist），注释理由：boot
  概率优化（默认运行时是 claude 时预热 probe），非 spawn 装配旁路；消除它需要 driver
  boot-probe 声明,收益不成比例。
- **`routes/runtime.ts:83`（设计门 P2-1）**：models 路由的 `kind !== 'opencode'` 分支
  会命中新正则，此前未被任何清单覆盖。T-F 收口时优先能力化消除（models 列举的沙箱化
  差异本应内聚在 `driver.listModels`；claude 侧已是静态表直返）；如实现期确认该分支属
  RFC-224 的 opencode 专属安全列举边界而非装配旁路，则改为显式 allowlist 登记 + 注释
  理由。两种收口都必须让「全树清零」断言真实成立——不允许留下未登记命中。
- 词边界说明：`\bruntime\b` 不匹配标识符 `defaultRuntime` 内部（`\b` 在词内不成立)，故
  `defaultRuntime` 需显式列入；`.protocol !==` / `.kind ===` 属性访问均命中。

## §6 前端

1. **i18n 四处**（`en-US.ts:976-981` 的 `intentHint` 尾句 + `intentRuntimeHint`；
   `zh-CN.ts` 对应两 key）：
   - `intentHint` 尾句 → "requires a runtime whose driver declares the read-only build
     profile" / 「需选择声明了只读构建 profile 的运行时」。
   - `intentRuntimeHint` → "Only runtimes that can enforce the read-only intent profile
     are admissible; empty inherits the global default (which must also qualify)." /
     「仅可选能实施只读意图构建 profile 的运行时；留空继承全局默认（默认值同样须满足）。」
2. **差异标注**（新 i18n key `intentRuntimeClaudeNote` en/zh）：设置页 intent 卡在
   **有效协议**为 `claude-code` 时渲染一行附注（`.settings-hint` 既有样式，无新 chrome）：
   "Claude Code enforces the read-only profile via declared CLI permissions (sealed
   binary, tool allow-list); unlike opencode there is no post-launch config attestation."
   / 「Claude Code 通过声明式 CLI 权限实施只读（封印二进制 + 工具白名单），与 opencode
   不同：启动后无配置验证（attestation）。」
   - 有效协议解析：选中值非空 → `useRuntimesList` 缓存里查该名字的 protocol；为空 →
     以 `config.defaultRuntime` 同样查询；再为空 → 平台默认 opencode（与
     `resolveInternalAgentRuntime` 的三级回落 `runtimeRegistry.ts:370-394` 一致）。纯
     draft 态派生（`settings-drafts.ts` 切片已含两字段），零新 API。
3. 不给 `RuntimeSelect` 加协议过滤（保持 422 兜底 + 文案引导；未来第三协议不满足时的
   拦截语义由后端唯一持有——与 RFC-118 enabled 过滤「picker 隐藏只是 UX、resolve 才是
   门」的分层一致）。

## §7 安全模型对比（结论表，docs 级事实）

| 维度 | opencode verified（现状不变） | claude-code（本 RFC） |
|---|---|---|
| 二进制 | copy-seal + 双 hash + exec 前再验 | **同**（§3 通用模块） |
| 工具面 | 受控 config `read/grep/glob` + `/config`,`/agent` 双读 attestation | `--tools Read,Grep,Glob` 装载裁剪（init 回显，实测）+ `dontAsk` 兜底；**无 attestation** |
| 配置面 | hermetic：私有 HOME/XDG + `OPENCODE_CONFIG_CONTENT` + 项目面扫描拒绝 | 私有 `CLAUDE_CONFIG_DIR` + `--setting-sources ""` + `--strict-mcp-config` + `--disable-slash-commands`；managed settings（IT 面）保留 |
| env | 全 sanitize（hermetic env 白名单） | 继承 - 内部标记黑名单 + 禁流量注入（鉴权族保留） |
| 会话 | 私有 ephemeral store + owner 行 | 私有 configDir 内 transcript（ephemeral，随 scratch 生命周期） |
| OS 沙箱 | `runner-filesystem-v1` containment | **同**（`systemAgentRun.ts:263`，协议无关） |
| 失败语义 | fail-closed（identity 失败码族） | fail-closed（封印失败同码；老版本 CLI 未知 flag → 非零退出 → turn error；未登录 → is_error result → turn error） |

UI/文档措辞纪律沿用 `docs/OPENCODE_CONFIG.md` §6：不得把声明式受控称为「已验证」。

## §8 失败模式

| 场景 | 表现 | 处置 |
|---|---|---|
| claude 二进制不存在 / 不可执行 / 封印竞态 | `RuntimeBinarySnapshotError` | `identity-failed` + `execution-identity-untrusted-binary`，scratch 保留 |
| 旧版 claude 不识 `--tools` / `--setting-sources` | argv 解析错误、非零退出 | `exit-nonzero` turn error（fail-closed，不降级）；probe 卡片 advisory 提示版本 |
| 未登录 / 凭据桥接失败 | claude 输出 "Not logged in" 类 is_error result | §4.1 归一为 `result-error` → turn error `intent-run-result-error`（不再伪装 envelope-missing）；`config.ts:79-84` 桥接失败仅告警的现状不变 |
| 终态 `is_error` + exit 0 | §4.1 | `result-error` 终态，`stderrTail` 带 masked result 文本 |
| seal 在 plan 构造后被替换 | `preSpawnVerify` 拒绝（§2.4） | `identity-failed` + `execution-identity-untrusted-binary` |
| 安装形态不是自包含单可执行（如某些平台的 npm shim/JS 入口） | 封印副本运行失败（副本脱离原目录资产） | 非零退出 → turn error，fail-closed 不静默；管理员应把 runtime 指向原生单二进制（本机实测：`claude.exe` 为 Mach-O arm64 自包含单二进制，realpath 解析 symlink 后封印副本 `--version` 正常，2.1.220，2026-07-30） |
| 白名单外工具被模型调用 | is_error tool_result，进程继续（实测 #2） | 无需处置；不构成失败 |
| turn 超时 / 取消 | 既有 TERM→KILL→reap 升级链（`systemAgentRun.ts:441-460`） | 不变 |
| stdout 超 cap | 既有 `maxEventTextBytes` 链 | 不变 |

## §9 兼容性

- 零 DB migration、零 schema_version 变化、零新 API 端点。
- opencode intent 路径 byte-unchanged（唯一触碰是 re-export 搬移与 admission 门表达式）。
- claude 业务节点 / distiller / smoke 的 **spawn 形状** byte-unchanged（新分支仅由
  `systemPermissionProfile === 'intent-read-v1'` 进入）。两处**修正性**行为变更如实登记：
  ①§4.1 的 `result-error` 归一对全部系统路径生效（此前 exit 0 + is_error 伪装成 ok +
  下游解析失败）；②§1.2 的继承态保存门对「default 换成未声明协议 + intent 留空」开始
  422（此前 PUT 成功、launch 必败）。
- 前端仅 i18n 与一行条件 hint；无组件新增。

## §10 测试策略（Test-with-every-change 清单）

- **T-A driver/spawn 单测**（`packages/backend/tests/`，新文件
  `rfc237-claude-intent-readonly-spawn.test.ts`）：
  1. `intent-read-v1` plan：argv 全量断言（§2.2 清单逐项 + head=封印路径 + 无
     `bypassPermissions`、无 `IS_SANDBOX`）；env 断言（剥离清单不在——含 daemon env 预置
     `IS_SANDBOX=1` 的继承剥离态、注入四变量在、`ANTHROPIC_API_KEY` /
     `CLAUDE_CODE_GIT_BASH_PATH` 类保留、configDir 键正确 + RFC-154 自定义键透传与
     默认键 scrub）。
  2. `all-deny`/undefined profile：plan 与现状 byte 兼容（bypass 分支回归锁）。
  3. 未知 profile（构造超集值）仍 throw（fail-closed 回归）。
  4. 封印:成功（digest 复核、0500）、source 竞态替换失败（mock deps，复用
     `runtimeBinary` 既有测试模式）、`testOnlyUnverifiedRuntime` 跳过 seam、
     **plan 构造后替换 seal 字节 → `preSpawnVerify` 拒绝**（P1-3）。
  5. 凭据桥接两态：真实态（seam 缺省）触发 bridge 决策、mock 态不触碰 keychain（P1-1，
     以注入 spy/依赖倒置断言决策位，CI 不碰真实 keychain 的约束不变）。
- **T-B 封印搬移**：opencode 侧既有 RFC-224/227 二进制测试零改动通过；re-export 别名
  同一性（`instanceof` 跨旧新名）断言。
- **T-C admission**：`rfc234-config-intent-runtime.test.ts` 422 用例反转为接受
  claude-code；新增「driver 未声明 → 仍 422」（以临时超集 profile 或断言 opencode/claude
  声明集合的源码级完备性守卫表达);`resolveIntentTurnConfig` 放行 claude + 对未声明
  协议 Conflict 保留；**继承态**：unsupported default + intent 留空 → 保存 422（P2-3）。
- **T-D turnEngine mock-claude 全链**：mock 单文件可执行输出合法 envelope → turn 结算
  `changeset`、draft 铸造、`intent_turn_events` 有主会话事件、capture 终态 complete；
  **is_error 终态**：mock 输出 `is_error:true` result + exit 0 → turn error
  `intent-run-result-error`（P2-4，不再是 envelope-missing）。
- **T-E systemAgentRun 能力化回归**：opencode 补捞行为不变（既有 intent/distiller 用例）;
  claude 无 `captureSessionsToSink` 时 sink 正常 complete、无 `child-capture-failed`。
- **T-F 源码锁**：新正则下全树清零；白名单精确到 `cli/start.ts`；恶意样例
  （`x.protocol !== 'opencode'`）自检命中。
- **T-G 前端渲染**（新文件，不触碰他人未提交的 `settings-system-agents-render.test.tsx`）：
  intent 卡 hint 新文案；选中 claude 协议 runtime → 差异附注出现；选中 opencode → 不出现；
  留空 + defaultRuntime=claude → 出现（继承链解析）。
- **T-H i18n 完备**：en/zh key 对齐既有 i18n 完备性测试自动覆盖。
- 真机验证（非 CI）：真实 claude 2.1.220 跑一轮 intent 会话（生成 + 提交）+ 逃逸三连
  复测（cwd 外绝对路径 / symlink / `../`，预期全拒，§2.1 #11-13），设置页截图对齐。
