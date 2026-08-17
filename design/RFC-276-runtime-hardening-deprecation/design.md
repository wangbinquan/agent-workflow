# RFC-276 · 技术设计

状态：Done（2026-08-10；自然 runtime 与默认关闭的 `IS_SANDBOX` 兼容开关已发布，exact-SHA CI/visual 终态成功）。先读 [`proposal.md`](./proposal.md) 的边界、C1–C12 与 AC-1–24。

## 1. 当前事实与源码锚点

| 事实                                                | 当前源码                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode production 选择 verified、测试才走自然 CLI | `packages/backend/src/services/runtime/opencode/driver.ts`                                                                                            |
| 自然 OpenCode argv/env 仍完整存在                   | `runtime/opencode/spawn.ts`、`inlineConfig.ts`、`runtime/stageSkills.ts`                                                                              |
| verified plan/launcher/config/store/identity        | `runtime/opencode/{verifiedPlan,verifiedSystemPlan,verifiedMcpTestPlan,verifiedLauncher,verifiedManifest,hermetic,storeHygiene,executionIdentity}.ts` |
| binary/source/seal/netless                          | `runtime/{binarySnapshot,netlessProjection}.ts`、`runtime/opencode/{sourceGuard,sealedInputs,sealedSubprocess,fffCapability}.ts`                      |
| OS sandbox 与统一准入                               | `services/sandbox/*`、`services/containmentComposition.ts`                                                                                            |
| Claude controlled/system/netless 路径               | `runtime/claudeCode/{driver,spawn,mcpTest,netlessMcp,permissionMap}.ts`                                                                               |
| 混合了 sandbox 与进程可靠性的执行器                 | `services/execution/containedSpawn.ts`                                                                                                                |
| business session provenance + lease                 | `services/opencodeSessionOwner.ts`、`db/schema.ts#opencodeSessionOwners`                                                                              |
| MCP playground identity/store + lease               | `services/mcpRuntimeTest.ts`、`mcpRuntimeTestOwner.ts`、`db/schema.ts#mcpRuntimeTestSessions`                                                         |
| sandbox config/status/UI                            | `shared/schemas/{config,runtime}.ts`、`routes/{config,runtimes}.ts`、`components/settings/SandboxCard.tsx`                                            |
| script network/readonly                             | `shared/scriptNode.ts`、`shared/schemas/workflow.ts`、`services/scriptRun.ts`                                                                         |

`containedSpawn.ts` 证明了本 RFC 必须按职责拆分，不能按文件名删除：它前半有 sandbox admission/
wrapper，后半同时承载 bounded stream、PID receipt、process-group kill、timeout/cancel、kill escalation、
pipe drain 和 ENOENT 诊断。后者是崩溃恢复正确性，必须保留。

`opencode_session_owners` 与 `opencode_mcp_test_session_owners` 也同样混合了两类职责：
identity/binary/store provenance 要删，single-writer lease 与 task/test-session ownership 要保留。

## 2. 上游自然路径的固定依据

实现开始时必须按实际支持版本重验；本 RFC 的当前基线固定为 OpenCode 1.18.14：

- `run --auto` 的定义（`cli/cmd/run.ts:120-148`）：
  自动批准“未被显式 deny”的权限；因此平台可保留用户显式 deny 而不建权限应答通道。
- 非交互 `run` 自己给 session 加 `question/plan_enter/plan_exit` deny（`cli/cmd/run.ts:412-430`）：
  自然路径不需要平台再注入一份 `AW_GLOBAL_PERMISSION` 来处理 headless 问答死锁。
- global → project → config directories → `OPENCODE_CONFIG_CONTENT` 的加载顺序（`config/config.ts:370-440`）：
  平台 inline overlay 可以与机器/项目配置共存，并在后加载。
- skill discovery（`skill/index.ts:238-280`）：
  上游扫描机器/项目的 `.claude/.agents` skills、config directories 的 `{skill,skills}/**/SKILL.md`
  以及显式 `skills.paths/urls`。
- permission last-match 规则（`permission/index.ts:25-34`）
  与 config → ruleset/disabled tools（`permission/index.ts:169-198`）：
  显式 permission 的顺序与覆盖必须用真实 E2E/变异锁住。

外部链接只是设计依据，不替代实现时的 vendored/source probe。版本升级若改变这些行为，走普通
runtime compatibility 修复，不重建 verified identity。

## 3. 目标架构

### 3.1 单一运行流

```text
platform resolves product inputs
  ├─ runtime registry: executable + model/params
  ├─ platform resources: agent + dependents + MCP + skill + plugin
  ├─ explicit permission / readonly
  └─ task/worktree/session context
          ↓
natural runtime adapter
  ├─ OpenCode CLI
  ├─ Claude Code CLI
  └─ script interpreter
          ↓
managed process lifecycle
  ├─ bounded event/stdout/stderr
  ├─ pid + timeout/cancel + process-tree reap
  └─ normal spawn/exit/protocol diagnostics
```

不存在 sandbox coordinator、verified launcher、identity control barrier、private runtime store 或
netless child wrapper。

### 3.2 仍由平台拥有的职责

自然执行不等于“平台不组装任何东西”。以下仍是产品适配：

- 选择 runtime executable、agent、model/params 与 resume id；
- 把平台 agent/dependent/MCP/plugin/skill 追加到 runtime 支持的 config/argv/prompt；
- 设置准确 `PWD`、工作目录、Git author/committer identity；
- 处理 prompt 大小、`--` 分隔、JSON event codec 与 envelope；
- 执行 explicit permission/readonly；
- 记录 session ownership/lease、PID、events、token/cost 与 inventory；
- 对任何进入平台日志/DB/API 的 runtime 文本做上限和 secret redaction。

### 3.3 不再由平台拥有的职责

- 证明 executable/config/source/store 的字节身份；
- 替 runtime 选择一套“安全”的机器配置、PATH、HOME、凭据或 plugin 集；
- 阻止 runtime 访问宿主文件、网络或 socket；
- 对没有用户 permission 的运行强加 tool deny profile；
- 解释一个 sandbox/containment provider 是否“够安全”。

## 4. OpenCode 自然执行

### 4.1 production dispatch

删除 `usesLegacyTestOpencodePath` / `legacyTestPath` 的生产分叉。当前自然分支提升为唯一分支：

1. `stageSkills(runConfigDir, selectedSkills)`；
2. `buildInlineConfig(agent, dependents, mcps, plugins)`；
3. 追加 inventory plugin 与 memory block（若产品调用方要求）；
4. `buildOpencodeSpawn` 生成 `opencode run --agent … --format json --thinking --auto -- <prompt>`；
5. 由 managed process/runner 消费 JSON events。

保留：

- prompt 120 KiB 字节上限；
- `--` end-of-options；
- `--session` resume；
- `PWD=worktree`；
- config-dir profile 对 custom fork 的 env 名兼容；
- `OPENCODE_CONFIG_CONTENT`、inventory output、Git identity；
- runtime 版本只用于 CLI flag 拼写兼容，不做 admission。

删除：

- `buildVerifiedOpencodeBusinessPlan` / `buildVerifiedOpencodeSystemPlan`；
- direct server/launcher/listen/control ACK；
- manifest/source/binary/config/store/identity 校验；
- private HOME/XDG/session DB；
- source guard 与 project/global discovery disable flags；
- `AW_GLOBAL_PERMISSION {'*':'allow',question:'deny'}` 及 agent `question` sanitize。

### 4.2 env 与配置

env 从 `process.env` 全量继承，平台只覆盖运行正确性键：

- `PWD`；
- 当前 runtime 的 config-dir env 与 `OPENCODE_CONFIG_CONTENT`；
- 可选 inventory output；
- Git author/committer identity。

唯一 permission 例外：清除 ambient `OPENCODE_PERMISSION`，避免 daemon 环境在 inline overlay 之后
抹掉 agent 自己显式声明的 deny；这是“保留用户 permission”的产品不变量，不是平台默认围栏。
custom fork 使用非默认 config-dir env 时，继续清掉重复的默认 key，避免一次运行同时出现两个 config root。

不改写 HOME/XDG/PATH/TMP，不设置 `OPENCODE_DISABLE_*`、`OPENCODE_PURE` 或 Git global-config
屏蔽变量。`inheritMachineOpencodeConfig` 失去意义：机器/项目配置始终按上游规则参与。

### 4.3 agent permission

`buildInlineAgentEntry` 继续原样下发每个 agent 的 permission。顶层不再放平台 `* allow`；
`--auto` 负责不询问未显式 deny 的动作，上游非交互 session 自己禁用 question/plan 交互。

必须有三层测试：

1. 纯 config 顺序；
2. 真实 OpenCode：一个显式 deny 被拒，一个未 deny 的动作不等待；
3. mutation 删除 deny 后结果变化。

### 4.4 skills/plugins/MCP/instructions

- managed skill 继续把选中的 immutable resource version 整棵树复制到 run config dir；
- 不生成 seal、tree digest、logical root 或 resume identity；
- `.claude-plugin` exclusion 保留：skill 与 plugin 是两个显式资源类型，选 skill 不能暗中执行 plugin hook；
- project/global skills、plugins、MCP 与 instructions 不再屏蔽；
- 平台 inline 同名项按上游 merge 规则覆盖，额外机器/项目项自然可见；
- inventory plugin 可保留为产品 observability，但不得参与执行准入。

### 4.5 system、MCP playground 与 model listing

- system agent 使用同一自然 CLI builder，只注入本次 persona/model/prompt；
- output-only system/intent/memory 调用在 disposable workspace 中运行，任何文件变化不合回；
- MCP playground 使用普通 CLI session + DB lease，不用 verified server/store；
- model listing 调用普通 runtime probe/list 能力，继承自然 env/config；删除 byte snapshot/source guard；
- runtime smoke 只证明“CLI 可执行且协议能往返”，不证明隔离或身份。

### 4.6 RFC-272 能力吸收

删除 `mcpReadiness.ts`、`GET /mcp` direct client/control frame 与 identity v3/sealed skill path。

保留的产品判据：

- working selected MCP 必须能在真实 runtime 中完成一次 tool call；
- runtime 标准事件/startup inventory 能报告 unavailable 时，平台记录 bounded/redacted 状态；
- 无标准同实例状态时不伪造“已证明 ready”，也不为了 gate 重建 server launcher；
- selected managed skill 的 sibling file 由上游原生 skill root 读取。

## 5. Claude Code 自然执行

### 5.1 config/store/env

不再为每次运行设置私有 `CLAUDE_CONFIG_DIR`。Claude 使用 operator 的自然 config/transcript/store，
机器/项目 settings、skills、plugins/MCP 与 subscription auth 按 CLI 自身规则生效。

env 为 `process.env` 全量继承，只覆盖 `PWD`、可选 Git identity，以及 runtime profile 明确开启时的
`IS_SANDBOX=1`。组装时先大小写不敏感地剥离 daemon 的同名继承值：`isSandbox=false`（默认）时
子进程无该键，`isSandbox=true` 时才精确注入字符串 `1`。该字段只允许 `claude-code` runtime，
是 CLI 兼容选项，不启用或证明任何 OS sandbox / 平台防护，也不按 uid 或调用面隐式开启。
`configDir.env` 不再被平台改写到 runRoot；若 operator 已在 daemon env 中配置该键，则按普通环境
继承。`configDir.name` 仍是冻结契约，但在 Claude 路径上表示 worktree 项目 config 的叶子名，
从而兼容固定扫描 `.claude` / 自定义目录名的 fork，又不把认证迁到一次性目录。
删除：

- `claudeControlledInheritEnv` 与 hardening env；
- binary snapshot/verify；
- config credential bridge（自然 store 已直接可达）。

### 5.2 argv 与资源注入

保留：

- stream-json/verbose、stdin prompt、prompt 上限；
- `--append-system-prompt-file`；
- model、resume、runtime-specific extraArgs；
- 平台选中的 `--mcp-config` 与 `--agents`；
- 用户 permission 存在时的 `permissionMap.ts`、`--tools` / `--allowedTools` / `dontAsk` 映射。

删除：

- 非用户声明的 all-deny / intent-read system profile；
- `--setting-sources ""` / `--disable-slash-commands` 等平台 discovery fence；
- 为隔离项目 MCP 而使用的 `--strict-mcp-config`；
- netless local MCP wrapper、fenced MCP admission 与 containment demand。

无用户 permission 的业务或 system 调用使用现有非交互 bypass 形状。用户 permission 的映射继续是
显式产品契约，未知/无法表达的规则仍必须在保存或运行诊断中说明，不能静默放大用户授权。

### 5.3 managed skill attachment + worktree project resource projection

Claude 不再靠私有用户 config dir staging 平台 managed skill。adapter 对选中 skill 的当前版本
同时生成两种非密封表示：

1. runRoot attachment：inline `SKILL.md` 正文，写明 immutable version source root，并给出经过
   safe-path 校验的相对文件清单；
2. worktree project projection：把已经排除 `.claude-plugin` 的整棵树复制到
   `<worktree>/<configDir.name>/skills/<skill.name>`，让 Claude/兼容 fork 的原生 skill discovery
   能直接加载并解析 sibling 文件。

投影只写本次创建的同名目录：目标已存在、config/skills 父路径是 symlink 或不是目录时，spawn
assembly 明确失败，不覆盖/合并用户文件。`SpawnPlan.cleanup` 在子进程完全回收后删除精确创建的
目录并尝试收缩空父目录；删除前核对父/目标 inode，路径被 runtime 替换时停止而不是跟随 symlink。
真实 node 位于 RFC-130 一次性 iso worktree，cleanup 在 node snapshot/merge 前完成，因此投影不会
成为任务输出；无法回收的 live child 保留其 iso/runtime 状态，由既有 orphan/iso GC 处理。

dependent agent 使用双通道，但身份始终逐成员：标准 Claude 的 authoritative channel 是一次
`--agents` 携带的 name→definition registry；这只是批量传输容器，每个 entry 都是独立 subagent、
独立 prompt/context。为兼容只扫描 project config 的 fork，同一 registry 还逐项序列化到
`<worktree>/<configDir.name>/agents/<name>.md`。每个文件只含自己的 YAML frontmatter 与 prompt；
同名文件、config/agents symlink 或非目录均 fail closed，cleanup 逐文件核对 inode。标准 Claude 中
CLI scope 优先于 project scope，因此两个通道不会把多个 prompt 合并。

机器/项目 Claude skills/agents 同时自然加载。attachment/project projection 只表达平台“选中了
什么”，不屏蔽额外自然能力，也不含 digest/seal/identity。MCP 继续只走 `--mcp-config`：Claude 的
project MCP 文件是 worktree 根 `.mcp.json` 而不是 config-dir resource，且带项目 trust approval、
secret 与同名优先级语义；adapter 不把 secret-bearing 临时 MCP 再落一份项目文件。

### 5.4 output-only system 调用

system/intent profile 不再靠 tool deny 保证无副作用。所有只应返回文本/changeset 的调用统一在
disposable workspace 运行：

- 允许 runtime 自己写；
- 不把该 workspace 合回 canonical repo；
- 只解析并提交既有结构化输出；
- apply/commit 仍经过 ACL、revision/CAS 与 transaction。

这保留产品副作用语义，但不承诺 runtime 内部观察到 EACCES。

## 6. script 与中性 managed process

### 6.1 `containedSpawn` 拆分

重命名为 `services/execution/managedProcess.ts`：

- `runContainedProcess` → `runManagedProcess`；
- `ContainedSpawn*` → `ManagedProcess*`；
- 删除 `SandboxCtx`、`sandboxTopology`、`sandboxEnforceBlocked`、`wrapSpawnPlanSandbox`；
- `Bun.spawn` 直接使用 caller argv；
- 保留文件现有 stream/pid/timeout/cancel/kill/drain/diagnostic 全部逻辑。

Windows Job Object / native process tree kill 仍属于 lifecycle，不得因名字含“job/contain”而删除。

### 6.2 script env 与 network

script env 改为：

1. 继承 `process.env`；
2. 应用作者 env；
3. 平台最后覆盖 `PWD`、`AW_*`、port/input/envelope、Git identity 与依赖解释器所需键。

输入校验继续拒绝非法 key、NUL、动态加载器注入与覆盖平台保留键；依赖版本钉死、
`--ignore-scripts` / prebuilt-only、缓存并发等确定性边界不属于本 RFC。

删除 agent/script network schema、解析、序列化、敏感投影、UI badge/control、runtime profile 与测试。
历史输入带 `network` 时给稳定的 unsupported diagnostic，不能显示一个实际上不执行的开关。

### 6.3 readonly

readonly script 不再直接指向 canonical worktree：

1. 从 canonical snapshot 创建一次性 iso worktree；
2. script 可在副本内自然读写；
3. 成功/失败/取消后均不执行 merge-back；
4. 按现有 pin/orphan recovery 清理或恢复清理；
5. canonical tree/index/refs 在前后保持一致。

普通可写 script 保持 RFC-130 iso + merge-back。repo-group/task 其他显式 readonly 也用同一“副本可写、
结果不回写”产品定义，禁止悄悄退化成 canonical 直跑。

## 7. 配置、API、UI 与错误面

### 7.1 config migration

从 shared `ConfigSchema` / `DEFAULT_CONFIG` 删除：

- `sandboxMode`；
- `businessToolchainPaths`；
- `inheritMachineOpencodeConfig`。

首次由新 binary 成功读取旧 config 后，用既有 atomic writer：

1. 保存时间戳备份；
2. 移除这三个已知 key；
3. 保留所有未知/并发新字段；
4. fsync + rename；
5. 失败则保持原文件并拒绝宣称迁移完成。

不新增 schema 版本开关或 `hardening:false`。

`runtimes.is_sandbox` 是唯一保留 sandbox 字样的新字段，但它不是旧加固链的 feature flag：boolean
默认 `false`，只控制 Claude CLI 环境标记。它进入 RuntimeProfile、node-run 冻结参数、MCP session
snapshot 与 smoke target fingerprint；修改会清空旧 probe receipt 并结束依赖旧 profile 的 playground
session。Runtime Settings 仅在 `claude-code` 表单展示，并固定提示“不会启用 OS sandbox”。

### 7.2 删除产品面

- 删除 `agent-workflow sandbox` 子命令与 doctor sandbox 小节；
- runtime status schema/route 删除 sandbox/containment fields；
- Settings 删除 `SandboxCard` 与中英 i18n；
- config route 不再热更新 coordinator；
- 删除 `sandbox-degraded` lifecycle alert、repair option、event 与 docs；
- 删除所有 execution-identity/sandbox/containment/netless failure code 与 UI translation。

自然 runtime 文本仍先过 bounded redaction，再进入日志、events、DB 或 API。

## 8. 数据模型与前向迁移

### 8.1 迁移纪律

- 不修改 `0119` / `0120` / `0121` / `0125` 等历史 SQL 或 meta；
- RFC-275 已于 2026-08-10 完成；实施开工时重读其 live schema/journal，分配下一个可用 migration；
- migration 前使用现有启动备份，并把精确识别出的 private runtime store roots 纳入可恢复备份清单；
- migration 后由 RFC-275 history + physical manifest 验证。

### 8.2 business native-session lease

用中性表替换 `opencode_session_owners`：

```ts
runtime_session_leases {
  protocol: 'opencode' | 'claude-code'
  sessionId: string
  taskId: string
  nodeId: string
  createdNodeRunId: string
  leaseNodeRunId: string | null
  leaseNonceDigest: string | null
  leasedAt: number | null
  primaryKey(protocol, sessionId)
  allOrNone(leaseNodeRunId, leaseNonceDigest, leasedAt)
}
```

删除 identity/binary/session-contract/store/project/codec/reported-version provenance。保留 task/node ownership、
CAS claim/release、terminal-run recovery 与 lease mutation tests。

旧 owner 行不复制：其 session data 位于即将删除的 private store，复制 id 会造成假恢复。历史
`node_runs.opencode_session_id` 与 events 保留作观测；只有新表存在 owner 的 session 才允许 resume，
否则下一轮明确创建 fresh session。

### 8.3 MCP playground

重建 `mcp_runtime_test_sessions`，保留：

- owner/MCP、idempotency、status/turn/session version、idle deadline；
- runtime row/name/protocol、secret-free runtime snapshot、binary path 字符串；
- MCP config hash、scratch root、cleanup state；
- native session id 与 in-flight/current turn。

删除：

- runtime fingerprint/binary digest/MCP execution digest/session contract digest；
- private session store root/db path；
- identity/store/root mismatch reason。

新增中性 `mcp_runtime_test_session_leases`，只存 protocol/native session/test session/current turn/lease。
升级时所有 active/ending playground session 以 `runtime-session-reset` 结束、事件历史保留，新消息要求
创建新 playground session。

### 8.4 private store 清理

只清理由旧 DB 行或 app-owned manifest 精确指向、且通过下列验证的目录：

- 位于固定 app-owned runtime-store 根下；
- absolute/realpath 一致、无 symlink；
- 不等于 appHome、workspace、HOME、`/` 或其祖先；
- 对应进程已由 boot reaper 证明退出；
- 备份已成功。

任何目标不明确即停止清理并拒绝完成 migration；禁止 glob/宽目录递归删除。成功删除后在升级日志中
只报告数量与受控相对 id，不输出用户路径/secret。scratch/run 临时目录继续走既有精确 cleanup。

## 9. 删除、转换与保留清单

### 9.1 预计整文件删除

- `packages/backend/src/services/sandbox/*`；
- `packages/backend/src/services/containmentComposition.ts`；
- `runtime/opencode/{verifiedPlan,verifiedSystemPlan,verifiedMcpTestPlan,verifiedPlanCore}.ts`；
- `runtime/opencode/{verifiedLauncher,verifiedManifest,verifiedInventory}.ts`；
- `runtime/opencode/{hermetic,storeHygiene,sourceGuard,sealedInputs,sealedSubprocess,fffCapability}.ts`；
- `runtime/opencode/{executionIdentity,containment,failure,machineConfig,mcpReadiness}.ts`；
- verified launcher 专用且无自然调用方后的 `directClient/directApiSchemas/directCodec/sse/controlProtocol/runtimeBinary`；
- `runtime/{binarySnapshot,netlessProjection,mcpTestExecutionMaterial}.ts` 中只服务加固的实现；
- `runtime/claudeCode/netlessMcp.ts`；
- `cli/sandbox.ts`、`frontend/components/settings/SandboxCard.tsx`；
- sandbox/identity/netless 专属测试、fixture、snapshot 与 `docs/sandbox.md`。

实现前必须用 import graph 重验“专属”；若文件还含产品协议，先把产品部分迁入中性模块再删旧文件。

### 9.2 预计转换

- OpenCode `driver/spawn/inlineConfig/models/mcpTest`；
- Claude `driver/spawn/config/inject/mcpTest/permissionMap`；
- `runner/systemAgentRun/runtimeSmoke/mcpRuntimeTest/scriptRun`；
- runtime types/registry、server/start/routes；
- config/runtime/workflow/agent shared schema；
- DB schema、session owner/lease/recovery；
- Settings/runtime status/AgentForm/script inspector/i18n；
- docs/OPENCODE_CONFIG、runtime/MCP/script/troubleshooting 文档。

### 9.3 明确保留

- `util/{safePath,fileTrust,win32Acl,windowsJobObject,process,gitHardening}.ts` 的非 runtime-seal 调用；
- `gitCredential.ts`、secretBox/redaction；
- auth/OIDC/PAT/ACL/owner fences；
- node isolation、snapshot/merge-back、DB tx/recovery/schema admission；
- stageSkills 的 whole-tree copy 与 skill→plugin 类型排除；
- script dependency determinism/input validation；
- prompt/envelope/zip/upload/import 防御。

## 10. RFC 与文档状态

历史 RFC 不物理删除。RFC-276 完成时：

- 把 205/216/224/227/233/272 的 proposal 与索引状态标为 Superseded by RFC-276；
- 在 237/238/242/252/253/254/256 标出“运行期安全部分被 RFC-276 部分 supersede”；
- 保留 224 capability regression audit 原文；
- active docs 不再教用户配置 sandbox/identity/hermetic store；
- release/upgrade 文档明确 session reset、host trust 与 rollback 备份要求。

RFC-272 已是 Done；RFC-276 已获批准，但在自然能力 E2E 完成前保持该终态，避免实施中途覆盖已交付工作。

## 11. 失败、恢复与回滚

| 失败                          | 新语义                                                    |
| ----------------------------- | --------------------------------------------------------- |
| binary 不存在/不可执行        | `runtime-spawn-failed` + bounded ENOENT 诊断              |
| runtime config 无效           | runtime 普通非零退出；redacted stderr tail                |
| provider/auth 失败            | runtime protocol/terminal error，不映射 identity          |
| selected MCP 不可用           | 上游可观测则记录 MCP diagnostic；不建安全 control barrier |
| resume id 在自然 store 不存在 | 明确 fresh-session/reset 事件，不冒充 resume              |
| process timeout/cancel        | 保持 process-tree terminate/escalate/reap                 |
| config migration 失败         | 原文件保留，boot 不宣称清理完成                           |
| DB migration/physical drift   | 复用 RFC-275 fail-fast 与恢复指引                         |

rollback：

1. 停止新 binary；
2. 恢复升级前 DB、config 与 private-store 备份；
3. 再启动旧 binary；
4. 只回滚 binary 而不回滚 schema 明确不支持。

## 12. 测试策略

### 12.1 自然 runtime

- OpenCode real fixture：global/project/config-dir/inline merge、instructions、natural auth/provider、plugin、
  managed/project skill、MCP、resume；
- Claude real fixture：machine/project settings/skills/MCP + platform append/agents/MCP、natural auth/store；
- 默认/自定义 `configDir.name` 的 worktree skill/agent discovery；至少两个 dependent 的 argv entry、
  独立 agent 文件与 prompt/context 对应；继承 auth env 不改写；同名冲突、父路径 symlink、
  cleanup/iso snapshot 无投影；
- explicit permission allow/deny + mutation；
- system/intent disposable workspace 不回写；
- working local MCP tool-call、managed skill sibling-file read。

### 12.2 lifecycle 与 session

- managed process 的 stream cap/raw bytes/PID/timeout/cancel/SIGTERM→SIGKILL/drain/orphan/Windows tree；
- runtime session lease new/claim/conflict/release/crash recovery；
- pre-cutover business/playground session reset；
- historical events 保留且 API 可读。

### 12.3 migration/config/UI

- fresh DB full replay与存量 fixture upgrade；
- migration 后 live schema 不含 security provenance/store path；
- RFC-275 physical manifest parity；
- config 三键精确删除、并发字段保留、atomic failure recovery；
- routes/schema/OpenAPI/frontend/i18n 无旧 sandbox mode/status/components；唯一 `isSandbox` 字段必须保持
  默认关闭、Claude-only、纯 CLI 兼容说明。

### 12.4 preservation gate

分别运行 auth/ACL、secret/redaction/Git credential、safe-path/symlink/zip/import、DB transaction/recovery、
Git hardening、readonly discard 与 script authorization 测试。不能用“全量绿”替代这些点名证明。

### 12.5 reverse guard

architecture test 扫 production import graph，禁止重新引入 sandbox/verified/hermetic/sealed/netless/
execution-identity 模块与旧 config/API 字段；只允许 runtime profile 的 `isSandbox` 兼容标记及其
“不启用 sandbox”说明，历史 RFC/migration 路径显式排除。实施门再做：

- 删除 lease CAS → 并发测试必红；
- readonly discard 改 merge → canonical-diff 测试必红；
- explicit permission deny 删除 → runtime E2E 必红；
- 恢复任一 forbidden production import → architecture guard 必红。

## 13. 并发与实施顺序约束

RFC-272～275 已在 2026-08-10 更新为 Done；它们刚落地且与本 RFC 有重叠，实施仍须按 live tree
重新取证：

1. RFC-276 获批准前不改任何 production/test；
2. 实施前重读 RFC-272 已交付代码与测试；独立 MCP/skill 能力不得被覆盖；
3. 重读 RFC-275 完成后的 `schema.ts`、journal 与 migration 编号；
4. RFC-273/274 已交付的 intent/workgroup 业务改动原样保留；
5. 在隔离 worktree/branch 完成所有批次和 full gate 后原子集成，不在 shared main 发布半条自然/
   半条 verified 路径；
6. 最终产物无 transition flag、无 production fallback。
