# OpenCode v1.18.3 verified execution contract

> **用途**：说明生产环境如何把 agent、skill、MCP、模型与 session 绑定到同一个
> OpenCode v1.18.3 实例，并列出维护这条边界时必须同步检查的仓内代码。
>
> **权威范围**：本文描述 RFC-224 的 production verified path。显式
> `testOnlyUnverifiedRuntime` 或未品牌化 mock command 仍可进入历史 CLI builder，
> 但那只是依赖注入测试缝，不是产品契约。

## 1. 结论先行

生产执行不再依赖“`OPENCODE_CONFIG_CONTENT` 最后合并，所以平台配置一定获胜”。
这个断言在 v1.18.3 不成立：inline 之后仍可能存在 account、managed、MDM、
legacy mode 与 permission 覆盖。

当前边界是“排除继承面，再验证同一个实例的最终状态”：

1. 只接受 `officialBuilds.ts` 中 OS/arch 对应的 OpenCode **1.18.3 精确二进制
   SHA-256**，复制到 per-run seal 后执行该副本；
2. 只在 Linux `sandboxMode=enforce` 且 root-owned bwrap 可用时允许模型执行；
3. 用 private HOME/XDG/config/store、disable flags 与 source guard 排除用户全局、
   repo、managed、MDM、plugin、external skill 等隐式输入；
4. `buildControlledOpencodeConfig` 构造完整候选配置，inline 只是传输载体；
5. hidden launcher 启动同一个 `opencode serve` 实例，通过 `/config`、
   `/config/providers`、`/agent`、`/skill` 校验最终有效状态；
6. 校验通过后才创建/定位 session，先订阅 SSE，再经 direct API 发 prompt；
7. business session 还必须完成 launcher ↔ runner owner/lease ack，才允许进入模型边界。

所以正确心智模型不是“我们的层优先级最高”，而是：

```text
DB/resource selection
  -> parent-side freeze + identity manifest
  -> official sealed binary + hermetic filesystem/env
  -> FFF capability proof
  -> one loopback server
  -> same-instance config/provider/agent/skill attestation
  -> exact session ownership
  -> SSE first, POST second
  -> strict JSONL codec
```

## 2. 生产启动路径

### 2.1 入口与平台门

`opencodeDriver.buildBusinessSpawn` 与 `opencodeDriver.buildSpawn` 分别调用：

- `buildVerifiedOpencodeBusinessPlan`；
- `buildVerifiedOpencodeSystemPlan`。

两条路径都要求：

- `platform === "linux"`；
- sandbox provider 为 `enforce + available + bwrap`；
- 模型已解析为显式 `providerID/modelID`；
- binary 命中 `OFFICIAL_OPENCODE_BUILDS` 的 v1.18.3 唯一记录。

macOS 的 official build 仍可用于 version/status/model 等诊断，但 secure v1 不在
macOS 上执行模型。未知版本、未知平台、wrapper command、非官方 digest 或 sandbox
不可用都 fail closed。

### 2.2 父进程物化的对象

business plan 在任何模型执行前完成：

- canonical worktree/source fingerprint；
- official binary snapshot；
- private OpenCode store 与全部 private config roots；
- managed skill 全树 seal；
- netless shell 与 local MCP wrapper；
- FFF probe artifacts；
- one-shot `VerifiedLaunchManifest`。

manifest 以 `0600 + O_EXCL + O_NOFOLLOW` 写入普通 run root。hidden launcher
`readAndUnlinkVerifiedLaunchManifest` 读入、closed-schema 校验后立即 unlink；
manifest path 不传给 OpenCode server。

`SpawnPlan.readOnlySubtrees` 把 binary/skill/wrapper seal、三个 config root 与 FFF
只读目录交给 RFC-205 外层 bwrap 做 read-only overlay。session store 单独列在
`SpawnPlan.sessionStore`，作为唯一允许 capture 的 OpenCode DB locator。

### 2.3 不是 `opencode run`

生产路径不会执行：

```text
opencode run ...
opencode --session ...
debug config -> 再启动另一个 run process
```

launcher 对 sealed binary 的实际启动是：

```text
opencode serve --hostname 127.0.0.1 --port 0 --no-mdns
```

server 位于 launcher 独占的 process group。launcher 严格解析唯一 listen line，
使用 manifest 内随机 Basic Auth 凭据连接 loopback API；退出、超时或失败时执行
TERM → KILL、有界 pipe drain 与 store-lock cleanup。

## 3. 资源如何进入 verified instance

### 3.1 Agent 与 final raw config

Agent 的 DB row 仍是业务事实源，但 production 不把散装 frontmatter 直接交给
OpenCode 合并。`buildControlledOpencodeConfig` 生成完整配置：

```json
{
  "share": "disabled",
  "autoupdate": false,
  "snapshot": false,
  "formatter": false,
  "lsp": false,
  "instructions": [],
  "skills": { "paths": [], "urls": [] },
  "compaction": { "auto": false, "prune": false },
  "shell": "<sealed netless shell>",
  "plugin": [],
  "mcp": {},
  "permission": {
    "question": "deny",
    "plan_enter": "deny",
    "plan_exit": "deny"
  },
  "agent": {
    "<selected-name>": {
      "prompt": "<frozen persona>",
      "model": "<provider>/<model>",
      "mode": "primary",
      "hidden": false,
      "permission": "<ordered denied tail>",
      "options": {}
    }
  }
}
```

`OPENCODE_CONFIG_CONTENT` 仍承载这份 JSON，但 `buildHermeticServerEnv` 先做 canonical
JSON 合法性检查，再用 `JSON.stringify` 保留 permission object 的 insertion
order。v1.18.3 会把这个顺序转成 `Agent.Info` rule 顺序，因此不能为了稳定序列化
而排序 key。

平台强制覆盖 permission 尾：

- `read/edit/write/apply_patch/grep/glob/skill/task/webfetch/websearch/lsp` deny；
- `bash` 只按 agent 的 shell policy 决定 allow/deny；
- `external_directory` 先对 private tool-output pattern deny，再 wildcard deny；
- root session 的 `question/plan_enter/plan_exit` deny。

system agent 使用同一 config builder，但 `shell=/bin/false`、无 MCP、所有工具 deny。
business verified v1 不支持 enabled plugin 或 `dependsOn` subagent；命中时分别返回
`execution-identity-plugin-unsupported` /
`execution-identity-dependent-unsupported`。

### 3.2 Skill 与 instruction

生产路径**不自然继承** repo/global skill，也不把选中的 managed skill 注册进
OpenCode 官方 skill registry：

- `scanOpencodeProjectSurface` 从 canonical worktree 一直检查到 filesystem root；
  任一级出现 `opencode.json[c]`、`.opencode`、`reference(s)`、
  `.agents/skills` 或 `.claude/skills` 都拒绝；
- external/project skill 不支持；selected skill 必须为 managed；
- `inspectManagedSkillTree` 与 `snapshotManagedSkillTree` 对完整 skill tree 做
  no-symlink capture，比较 `contentVersion`、canonical relative path、entry
  type/mode、普通文件 bytes 与 tree digest；
- sealed `SKILL.md` 以带 name/digest 的 frozen block 拼进 selected agent persona；
- skill 辅助文件只通过精确 read-only bind 提供给 netless shell/local MCP；
- raw config 固定 `skills.paths=[]`、`skills.urls=[]`，官方 `skill` tool deny；
- launcher 的 `/skill` inventory 必须精确等于 `PINNED_BUILTIN_SKILL`，额外 disk、
  project 或 platform skill 都是 `execution-identity-skill-mismatch`。

worktree 根的 `AGENTS.md` 是唯一显式 instruction 入口。
`readFrozenInstruction` 以 no-follow fd 读取并校验 metadata/size/UTF-8，随后将 sealed
bytes 拼进 persona；不会在模型取得控制后重新打开 live 文件。

### 3.3 MCP、plugin 与 subagent

production MCP 集合只来自当前节点已解析的 `ctx.mcps`，不存在全局/repo MCP
自然继承：

- disabled MCP 被忽略；
- remote MCP 以 closed config 写入 `mcp.<name>`；
- local MCP command 必须以 absolute regular executable 开头；
- local command/args/env 被放入 private wrapper manifest，OpenCode 看到的 command
  只有 sealed wrapper path；
- wrapper 通过 `runNetlessSubprocess` 进入嵌套 bwrap：无 network、受控 env、
  worktree/scratch 可写、selected frozen skill paths 只读；
- `sanitizeNetlessEnvironment` 拒绝 `OPENCODE_*`、loader、dynamic linker、Git exec/
  SSH、shell startup 等危险环境注入。

MCP 工具名仍由 OpenCode 按 `{mcp-name}_{tool-name}` 暴露，因此 agent permission
中点名某个 selected MCP tool 继续使用这一形式。有效 config/agent identity 会
校验“声明的 MCP 集合没有被增删改”，但具体远端服务健康度仍是 MCP 自身运行期语义。

enabled plugin 在 verified v1 一律拒绝；`plugin=[]`。`task` tool deny 且
`dependsOn` 非空直接拒绝，因此 OpenCode 内部 subagent 不是框架的协作通道。

### 3.4 Verified inventory

verified path 不再加载 RFC-029 legacy inventory plugin，因为 production
`plugin=[]`，inventory 也不得为了采集而执行 tool 或访问 `/mcp/status`。

当 `ctx.wantsInventory` 为 true 时，`buildVerifiedInventoryPlan` 把下列非执行元数据
冻结进 business manifest：

- selected managed skill 的 name、skill id、已验证 tree digest；
- enabled selected MCP 的 name 与 local/remote type。

launcher 只有在 `/config`、`/config/providers`、两次 `/agent`、`/skill` 与 source
fingerprint 全部验证后，才调用 `buildVerifiedInventorySnapshot`：

- agent 来自第二次、已证明与第一次同 seal 的 `/agent`；
- OpenCode 内置 skill 标为 `runtime-baseline`；
- selected managed skill 标为 `prompt-injected-frozen`，不伪装成 runtime skill；
- selected MCP 只标为 `configured`，不声称已连接；
- plugins 固定为空。

`writeVerifiedInventorySnapshot` 以有界 `0600 + O_EXCL + O_NOFOLLOW` 写
`runRoot/inventory.json`，随后仍由 driver 的 `readSnapshotFromRunDir` 进入既有消费链。
任何预占文件、schema/size/mode 漂移都 fail closed。

## 4. Hermetic env：明确关闭继承

`buildHermeticServerEnv` 从空对象开始，只转发批准的 locale/proxy/git identity 与
selected provider credential。它不会展开完整 `process.env`。

关键环境约束：

- `HOME`、`TMPDIR`、`XDG_{CONFIG,DATA,CACHE,STATE}_HOME` 全部指向 private store；
- `OPENCODE_CONFIG_DIR`、`OPENCODE_TEST_HOME`、
  `OPENCODE_TEST_MANAGED_CONFIG_DIR` 指向互不 alias 的 private roots；
- 每个 config root no-symlink 创建、预建只读 `.gitignore`，然后 outer ro-bind；
- `OPENCODE_PURE=1`；
- `OPENCODE_DISABLE_PROJECT_CONFIG=1`；
- `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`；
- models fetch/default plugins/Claude compatibility/LSP download/autoupdate/autocompact/
  prune/embedded UI/file watcher 全关闭；
- `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`；
- `OPENCODE_WORKSPACE_ID`、`OPENCODE_CONFIG`、`OPENCODE_PERMISSION` 不设置。

认证也不是继承整个用户 auth store。`buildStrictProviderAuth` 只接受 selected
provider 的单个 `{type:"api",key}`，生成唯一 `OPENCODE_AUTH_CONTENT`；
OAuth/wellknown/额外 provider/额外 key 都拒绝。launcher 随后读取
`/config/providers`，确认 selected model 存在且 implementation npm 命中
`PINNED_BUNDLED_PROVIDER_NPM`。

这套隔离意味着以下旧行为都不是 production feature：

- repo `.opencode/` 自动配置；
- `~/.config/opencode` / `~/.opencode` 配置或 agent；
- `~/.claude/skills` / `~/.agents/skills` skill；
- repo/global MCP；
- remote org/active account/MDM 后置覆盖；
- default/community plugin。

如果这些面被检测到、重新出现于 same-instance inventory，或在 source fence
期间变化，执行会 fail closed，而不是按 merge priority 猜测谁胜出。

## 5. Official build、sandbox 与 FFF proof

### 5.1 Official build manifest

`OFFICIAL_OPENCODE_BUILDS` 是唯一 production binary trust root：

| platform | arch  | version | executable SHA-256                                                 |
| -------- | ----- | ------- | ------------------------------------------------------------------ |
| darwin   | arm64 | 1.18.3  | `43f7083d450567706a80b6441331a25b5ed6d6c9f742826790545b068229cbb2` |
| darwin   | x64   | 1.18.3  | `ba11415d6af7efc9dc0073520d546b869711da5f39076d12e08eeb266ba1279b` |
| linux    | arm64 | 1.18.3  | `915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb` |
| linux    | x64   | 1.18.3  | `fdf58364c969a144fff0ae3a30f2fb6e705ada06864842613de1f9ecc70feb20` |

每条记录同时 pin `codec=1` 与 `fffCapabilityCodec=1`。source executable 只允许单个
PATH token 或 absolute path；resolve 后验证 executable、streaming hash，再以
exclusive copy 写入 private path `0500`，copy 后和每次 exec 前重新 hash。

`withOfficialOpencodeSnapshot` 也让 status/version/model diagnostics 只执行临时
official snapshot，不直接执行 registry/source binary。

### 5.2 两层 bwrap

外层 RFC-205 bwrap 负责整个 launcher/server：

- task worktree 与 session store 是批准的 writable roots；
- identity/config/FFF seal 重新 overlay 为 read-only；
- secure model execution 只接受 Linux enforce mode。

business shell 与 local MCP 再通过 `materializeNetlessWrapper` /
`runNetlessSubprocess` 进入内层 bwrap，获得独立 no-network 与 allowlisted env。
root-owned、非 group/world-writable 的 bwrap 路径由 `requireRootOwnedBwrap` 验证。

### 5.3 FFF capability proof

不能只凭“没设置 `OPENCODE_DISABLE_FFF`”认定 v1.18.3 使用 bundled FFF，因为
`Fff.available()` false 时 upstream 会切到 ripgrep layer。

`materializeFffCapabilityProbe` 为每次 launch 创建：

- no-symlink private cwd；
- cwd 内唯一一个随机 basename 的已知普通文件；
- empty read-only `cache/opencode/bin`；
- empty read-only PATH；
- private HOME/config/data/state/tmp。

launcher 在 real server 前，对**同一个 sealed binary**执行：

```text
opencode debug file search <exact-random-basename>
```

`runFffCapabilityProbe` 用 no-network bwrap、closed env 与有界 stdout/stderr；只有
exit 0、stderr 空、stdout 精确为一次 `<basename>\n` 且 cache/PATH 仍为空才通过。
fallback ripgrep 在这个环境没有 PATH/cache binary，也不能联网下载，因此无法产生
假阳性。任何偏差统一为 `execution-identity-bootstrap-failed`，real server 不启动。

## 6. Same-instance attestation、session 与失败通道

### 6.1 Bootstrap attestation

`launchVerifiedOpencodeManifest` 的顺序是：

1. closed manifest digest/source/binary/FFF proof；
2. acquire store lifecycle lock，scrub fresh/existing store 的 account/auth 状态；
3. binary 紧邻 exec 再验证；
4. 启动一个 loopback server；
5. 从该 server 读取 `/config`、`/config/providers`、`/agent`、`/skill`；
6. `verifyExecutionIdentity` 比较完整 raw config、两次包含 native agent 的完整
   registry canonical seal、selected agent ordered permission 与 identity digest；
7. `verifySelectedProviderInventory` 与 `verifyPinnedSkillInventory` 收口 provider/
   model/skill；
8. source fingerprint 再验证；
9. business inventory 启用时，从已验证数据写 exclusive snapshot；
10. 创建新 session，或分页定位唯一、精确匹配的 resume root session。

在实际模型边界，launcher 再扫一次 source fence，然后先订阅 SSE，验证首帧与消息
history，生成严格晚于历史的 caller message id，最后才 POST prompt。
`DirectSessionCodec` 只把 pinned wire schema 转成 runner 已有 JSONL；未知/越界事件、
permission/question 请求、session/model/agent/path 漂移都失败。

### 6.2 Business session ownership

business new/resume 使用 persistent private store，绝不重新打开用户全局 OpenCode DB。

owner row 冻结：

- `sessionId`、`projectId`、`taskId`、`nodeId`、`createdNodeRunId`；
- `identityDigest`、`officialBuildDigest`、`sessionContractDigest`；
- `sessionStoreKey`、OpenCode version；
- 当前 `nodeRunId + leaseNonceDigest`。

resume 在 store materialize/scrub 前先比较可重建 owner 字段，并由 runner preclaim
lease。launcher 验证 session 后向 stderr 写唯一 `session-ready` control frame；
runner 原子 claim/confirm owner 后以 `O_EXCL` ack `ok`，launcher 收到 ack 才继续
SSE/POST。任一 mismatch/nack/重复 marker 都终止。

runner 只有在 launcher 与 stdout/stderr 完全 reaped、lease 仍持有时，才从
`SpawnPlan.sessionStore.dbPath` 做最终 session capture，随后释放 lease。

system/smoke/distiller invocation 使用 `storeKind=system-ephemeral`：只允许 new、
无 business ack，capture 后删除整个 store。

### 6.3 稳定失败与秘密边界

RFC-224 失败只通过 `execution-identity-*` closed vocabulary 和
`AW_OPENCODE_FAILURE <code>` control line 上报。host path、HTTP body、config value、
credential、MCP header/env 与 upstream stderr 都不得进入错误消息或普通事件。

日志/diagnostics 只记录 model/variant、MCP/plugin 数量等非秘密事实。若新增日志，
不要打印 manifest、`serverEnv`、raw config、provider auth 或 wrapper manifest。

## 7. Test-only legacy seam

以下条件之一会进入旧 `buildOpencodeSpawn` / `buildInlineConfig` / `stageSkills` 路径：

- 显式 `testOnlyUnverifiedRuntime=true`；
- 注入未品牌化 mock `opencodeCmd`。

该路径保留历史 `opencode run`、inline deep merge、config-dir skill staging、
repo/global inheritance 等行为，以维持 mock/recording tests。它不能作为产品语义、
不能由普通 runtime configuration 触发，也不能据此修改本文件的 production 结论。

## 8. 仓内代码锚点

| 主题                              | 文件                                                                                                      | 当前入口                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| official build allowlist/snapshot | `packages/backend/src/services/runtime/opencode/officialBuilds.ts`                                        | `requireOfficialOpencodeBuild`, `snapshotOfficialOpencodeBinary`, `withOfficialOpencodeSnapshot`                      |
| private paths/env/raw config/auth | `packages/backend/src/services/runtime/opencode/hermetic.ts`                                              | `prepareHermeticOpencodeLayout`, `buildHermeticServerEnv`, `buildControlledOpencodeConfig`, `buildStrictProviderAuth` |
| repo/global source exclusion      | `packages/backend/src/services/runtime/opencode/sourceGuard.ts`                                           | `scanOpencodeProjectSurface`, `readFrozenInstruction`                                                                 |
| managed skill tree seal           | `packages/backend/src/services/runtime/opencode/sealedInputs.ts`                                          | `inspectManagedSkillTree`, `snapshotManagedSkillTree`                                                                 |
| shell/local MCP containment       | `packages/backend/src/services/runtime/opencode/sealedSubprocess.ts`                                      | `materializeNetlessWrapper`, `runNetlessSubprocess`                                                                   |
| FFF proof                         | `packages/backend/src/services/runtime/opencode/fffCapability.ts`                                         | `materializeFffCapabilityProbe`, `runFffCapabilityProbe`                                                              |
| verified inventory                | `packages/backend/src/services/runtime/opencode/verifiedInventory.ts`                                     | `buildVerifiedInventoryPlan`, `buildVerifiedInventorySnapshot`, `writeVerifiedInventorySnapshot`                      |
| business/system plan              | `packages/backend/src/services/runtime/opencode/verifiedPlan.ts`, `verifiedSystemPlan.ts`                 | `buildVerifiedOpencodeBusinessPlan`, `buildVerifiedOpencodeSystemPlan`                                                |
| one-shot manifest                 | `packages/backend/src/services/runtime/opencode/verifiedManifest.ts`                                      | `VerifiedLaunchManifestSchema`, `readAndUnlinkVerifiedLaunchManifest`                                                 |
| same-instance launcher            | `packages/backend/src/services/runtime/opencode/verifiedLauncher.ts`                                      | `launchVerifiedOpencodeManifest`, `runVerifiedOpencodeLauncher`                                                       |
| direct schemas/client/codec       | `packages/backend/src/services/runtime/opencode/directApiSchemas.ts`, `directClient.ts`, `directCodec.ts` | strict HTTP/SSE/session/message boundary                                                                              |
| store hygiene                     | `packages/backend/src/services/runtime/opencode/storeHygiene.ts`                                          | `acquireOpencodeStoreLifecycleLock`, `scrubOpencodeStoreAccountState`                                                 |
| runner owner barrier/capture      | `packages/backend/src/services/runner.ts`                                                                 | `requiresVerifiedOpencodeBarrier`, `processRunnerOpencodeControlLine`, `runNode`                                      |

对应设计与回归锁：

- `design/RFC-224-opencode-execution-identity/`；
- `packages/backend/tests/rfc224-*.test.ts`；
- `packages/backend/tests/integration-opencode/`。

## 9. 维护规则

以下变化必须先重新核对 pinned upstream v1.18.3 行为，并同步本文与测试：

- OpenCode version/build hash、FFF capability codec；
- config/agent/permission merge 或 inventory wire shape；
- provider implementation、session/message/SSE schema；
- source discovery、skill registry、MCP/plugin loading surface；
- env/disable flag、private path、store schema；
- `serve` stdout、direct endpoint 或 JSONL codec；
- sandbox/bwrap mount 或 process-group lifecycle。

不要在本文引用个人机器上的 upstream checkout 绝对路径或易漂移行号；引用仓内 wrapper
函数、RFC evidence 与固定版本/tag。升级 OpenCode 必须作为新的 identity audit，
不能只调整最低版本字符串。
