# RFC-224 技术设计：opencode 配置执行身份完整性

> v8，2026-07-24。上游基线固定为官方 `anomalyco/opencode` tag
> `v1.18.3`（commit `127bdb30784d508cc556c71a0f32b508a3061517`）。
> 每增加一个 digest/codec 都必须重跑本文的源码、变异与 sandbox escape 矩阵。

## 0. 裁决摘要

平台不再把 inline config 当最终真相，不运行 `debug config → run` 双进程 probe，
也不调用会 fallback 的 `opencode run --attach`。最终形状是：

```text
runner / distiller / smoke
  └─ parent：resolve/hash/copy official binary + 创建只读 runtime seal
      └─ RFC-205 outer sandbox 中的 agent-workflow __opencode-verified-run
          ├─ hermetic env + source fingerprint
          ├─ sealed opencode serve --hostname 127.0.0.1 --port 0
          ├─ same-instance GET /config + /config/providers + /agent + /skill
          ├─ full compare + Agent.Info second seal
          ├─ create/validate exact root session
          ├─ source fingerprint second check
          ├─ SSE ready
          └─ POST caller messageID + exact selected agent/model + one text part
```

launcher 是外层看到的唯一 process-group leader；server 不 detached。launcher
把 pinned v1.18.3 event stream转换成现有 `run --format json` stdout protocol。
任何校验、HTTP、schema、SSE、server lifecycle 异常都在 accepted model result
之前 fail closed。

## 1. 上游事实与安全裁决

### 1.1 inline 不是最后一层

v1.18.3 `config/config.ts:398-564` 在 inline 后仍合并 active-org、managed、
MDM、legacy mode 与 `OPENCODE_PERMISSION`。Agent registry 按 name 合并；
`disable` 会删除，`mode:subagent` 会让 CLI agent selection fallback。

### 1.2 plugin/custom tool 不能在 bootstrap 后自证

- V1 external plugin 在 `/config` preflight 前 import；`OPENCODE_PURE=1` 才会
  从物理上跳过全部 V1 external。
- V2 `ConfigExternalPlugin` 不遵守 PURE，会从 core V2 `Config.entries()` 的
  `plugins` 与 `{plugin,plugins}/*.{ts,js}` import。
- legacy `ToolRegistry` 还会从 `Config.directories()` 的
  `{tool,tools}/*.{js,ts}` 直接 import，不经过 plugin gate。

所以 v1 不加载任何 platform/user external plugin，也不靠 trusted plugin 做
attestation。launcher 让 legacy directories hermetic，并在 server 前/prompt 前
锁定 V2 project surface。

### 1.3 task 与 attach 不能补丁式修复

官方 task resume 只按 `task_id` 取旧 session；HTTP `SubtaskPartInput` 又能
`bypassAgentCheck`。官方 `run --attach` 的第三次 `/agent` lookup 失败会回退默认
agent。v1 因此：

- 最终 permission 禁止 task，business 非空 `dependsOn` 直接 unsupported；
- launcher 直接调用 pinned API，不启动 `run --attach`；
- POST body 必须带 manifest 中的显式 agent/model，且只准一个 text part。

### 1.4 loopback Basic Auth 不是模型边界

server auth secret 位于 `OPENCODE_SERVER_PASSWORD`；官方 shell、PTY、local MCP
会继承 `process.env`。拿到 secret 后可 PATCH config/dispose、改 session
permission 或 prompt 任意 session。

因此随机 nonce + loopback 只是 host-side defense in depth。真正边界是：

1. 所有模型可控 subprocess env 从 allowlist 重建；
2. shell/local MCP 进入无 network/process-info 的内层 sandbox；
3. webfetch/websearch/task/lsp 等 server-internal 网络/旁路工具最终 deny；
4. built-in file tool 全部 deny，不让 lexical containment 跟随 worktree symlink；
5. runtime/data/config/cache 对模型 subprocess 不可见/不可写。

## 2. 保证与非保证

### 2.1 保证

- business/system 受控 agent 的 raw config、Agent.Info 全 schema 字段和有序
  permission rules 与 manifest 一致；
- selected agent 不缺失、不 native、不 hidden、不 subagent、不 fallback；
- selected model 显式冻结；`config.model` 不得代选，selected provider raw override
  必须等于 manifest；
- MCP key 集与完整字段一致，无额外 MCP；
- V1/V2 external plugin、repo custom tool/config 的 executable surface 为空；
- OpenCode external/project/platform skill discovery 与 `skill` tool 全部关闭；
  选中的平台 skill/`AGENTS.md` 只以 no-symlink copy/re-hash 后的冻结文本注入
  prompt；
- model-reachable filesystem/network/process 不能读取或调用 server/platform
  control plane，也不能替换 runtime artifact；
- root session 的 directory/parent/workspace/agent/model/permission 契约固定；
- official executable 与 API/event codec 精确固定。

### 2.2 不保证

- provider TLS/DNS/credential 的远端真实性；
- local MCP executable 与 remote MCP server 自身是否良性；local MCP 被 containment
  限制，但它的业务输出仍是 TCB 输入；
- repo `AGENTS.md` 与平台 seal 后的 skill Markdown 内容良性；
- 模型显式运行的 worktree build/test artifact 与只读 root-owned OS toolchain 的
  供应链身份；它们属于受 containment 约束的代码，不属于 OpenCode execution
  identity；
- 同 uid 主动宿主进程、root/admin、内核。

## 3. official binary 与只读 runtime seal

`runtime/opencode/officialBuilds.ts` 是唯一 executable allowlist：

| platform | arch  | v1.18.3 executable SHA-256                                         |
| -------- | ----- | ------------------------------------------------------------------ |
| darwin   | arm64 | `43f7083d450567706a80b6441331a25b5ed6d6c9f742826790545b068229cbb2` |
| darwin   | x64   | `ba11415d6af7efc9dc0073520d546b869711da5f39076d12e08eeb266ba1279b` |
| linux    | arm64 | `915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb` |
| linux    | x64   | `fdf58364c969a144fff0ae3a30f2fb6e705ada06864842613de1f9ecc70feb20` |

父进程在 sandbox 外：

1. 只接受单 executable token；PATH resolve 后 `realpath`；
2. streaming SHA-256 命中当前 OS/arch 唯一 build；
3. `COPYFILE_EXCL` 到 per-run identity seal，父目录 `0700`、文件 `0500`；
4. copy 后复算 digest/mode/no-symlink；
5. 同目录生成固定 wrapper artifact 并校验内容 digest。

RFC-205 policy 新增 `readOnlySubtrees`：Linux 在 runRoot RW bind 之后对 seal
`--ro-bind`。只 chmod 0500 不算 seal，因为同 uid 仍可 unlink/replace。launcher
exec server 紧前再次复验 binary。darwin build 仍可用于 version/hash/config
诊断，但 secure v1 的模型执行因缺少 PID namespace 一律 fail closed。

seal 不存 prompt/MCP secret；一次性 manifest 位于普通 runRoot，launcher 启动后
立即读入内存并 unlink，server env 不继承 manifest path。

## 4. hermetic env 与配置面

### 4.1 server env

从 daemon env 建新对象，不原样展开：

- 只保留 selected provider 需要且经过显式分类的 credential/proxy、locale 与
  git identity；由 manifest 生成 `OPENCODE_AUTH_CONTENT`，在本地 Auth.Info
  strict schema 层只接受 selected provider 的 `{type:"api",key}`，拒绝 OAuth、
  `wellknown`、额外 provider 与额外 key（upstream 对该 env 只 `JSON.parse`，
  不会替平台 schema-validate）；selected model 的 implementation npm 另由
  official `/config/providers` allowlist 校验；
- server `PATH` 只含 root-owned、不可由 task/model 写的 system directories；
- `HOME` 本身（不只是 `OPENCODE_TEST_HOME`）指向 per-run private home，避免
  `{file:~/...}`、permission expansion、npm/git/runtime loader 回到真实用户目录；
- 删除全部继承 `OPENCODE_*`、`NODE_OPTIONS/NODE_PATH`、Python/Ruby startup、
  `LD_*`、`DYLD_*`、`BASH_ENV/ENV/ZDOTDIR`、Git exec/config/SSH/askpass、
  editor/pager 与 package-manager script-shell 注入变量；
- 再设置唯一批准的 OpenCode vars：
  `OPENCODE_PURE=1`、`OPENCODE_DISABLE_PROJECT_CONFIG=1`、
  `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`、
  `OPENCODE_DISABLE_MODELS_FETCH=1`、
  `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`、
  `OPENCODE_DISABLE_CLAUDE_CODE=1`、
  `OPENCODE_DISABLE_LSP_DOWNLOAD=1`、
  `OPENCODE_DISABLE_AUTOUPDATE=1`、
  `OPENCODE_DISABLE_AUTOCOMPACT=1`、
  `OPENCODE_DISABLE_PRUNE=1`、
  `OPENCODE_DISABLE_EMBEDDED_WEB_UI=1`、
  `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=1`、
  `OPENCODE_CONFIG_CONTENT`、`OPENCODE_AUTH_CONTENT`、
  `OPENCODE_CONFIG_DIR`、`OPENCODE_TEST_HOME`、
  `OPENCODE_TEST_MANAGED_CONFIG_DIR`（指向 private empty dir）、
  `OPENCODE_SERVER_{USERNAME,PASSWORD}` 与禁用 experimental flags；
- `OPENCODE_WORKSPACE_ID`、`OPENCODE_CONFIG`、`OPENCODE_PERMISSION` 恒缺失；
- XDG cache/state 指向 per-run private dirs。parent 按 pinned
  `ConfigPaths.directories()` 物化**全部**且两两不同的 config roots：
  `Global.Path.config`、`$OPENCODE_TEST_HOME/.opencode`、
  `OPENCODE_CONFIG_DIR`；每个 root 都 no-symlink 创建、预建 `.gitignore`、验证
  realpath 位于 config seal 且互不 alias，再逐个 outer ro-bind。这样
  `ensureGitignore` 无需写，所有 detached `Npm.install` 都因目录不可写而 no-op；
- XDG data 使用 discriminated `sessionStoreKey`：
  - business new chain 为每次 fresh launch 生成不可预测、不可冲突的
    `{kind:"business",chainKey,rootNodeRunId}`，并写入 owner；
  - business resume 只能取 owner 中同一 chain key，session lease 保证同一 chain
    单 writer；不同 fanout/loop 即使 task/node 相同也有不同 store；
  - distiller/smoke/其它不 resume 的 system invocation 使用
    `{kind:"system-ephemeral",invocationId}`，capture 后 cleanup。
    store 启动前用 no-symlink walk 删除 `opencode/auth.json`。v1.18.3 active account
    实际位于同一个 OpenCode SQLite DB：在 server 未运行且 store exclusive
    lock/owner lease 已确认后，平台按 pinned schema 打开 DB，checkpoint WAL，
    在一个事务中依次清空并验证 `account_state`、`account`、
    legacy `control_account`，commit 后 `wal_checkpoint(TRUNCATE)`、close，再验证
    DB/WAL/SHM 均无 symlink、残留三表 row 为 0；DB 不存在仅允许 fresh store，
    existing store 缺表/schema drift 失败。该目录整体不向模型 child 暴露。正常退出
    在 server fully reaped 后重复 scrub；daemon 启动时只对无 live lease/process 的
    persistent store 做 crash recovery scrub，ephemeral crash store 直接删。发现
    symlink/非普通 auth/DB/WAL/SHM artifact 直接 identity mismatch。persistent
    business store 由 owner/task retention GC，ephemeral store 由 awaited
    plan.cleanup 删除。

darwin diagnostic outer sandbox 显式 deny `/Library/Managed Preferences` 与
`/Library/Application Support/opencode`，并用真实 `plutil` exec counter 证明
读取次数为 0；Linux 通过 private `OPENCODE_TEST_MANAGED_CONFIG_DIR` 关闭
`/etc/opencode`。private XDG data 不含 active account，禁止 active-org remote
fetch。即使未来上游新增来源，§4.3 的 same-instance raw gate 仍会拒绝其有效
覆盖；但在 gate 前会 import/spawn 的新来源必须先更新 allowlist，不能只靠
事后比较。

### 4.2 project/V2 surface

core V2 不遵守 `OPENCODE_DISABLE_PROJECT_CONFIG`。launcher 在任何 repo/model
内容进入 OpenCode 前，按 pinned v1.18.3 location 算法从 canonical worktree 向
文件系统根扫描一次，缓存 location，并 fingerprint：

- 任一 `opencode.json` / `opencode.jsonc`；
- 任一 `.opencode` entry；
- 任一 `reference` / `references` entry；
- 任一 `.agents/skills`、`.claude/skills` 或其它 upstream external/project
  skill entry；
- 任一 symlink、parse ambiguity、扫描 race。

以上全部 fail `execution-identity-project-config-unsupported`。这比上游 project
root stop 更保守，避免 V2 agent/provider/policy/plugin 覆盖、custom executable
与 skill symlink 诱导 server-side read。私有 global config 只由 launcher 生成；
OpenCode 的 instruction/skill discovery 不接触 repo。平台在 sandbox 外用
`O_NOFOLLOW`/no-symlink walk 读取明确选中的 repo `AGENTS.md`。managed skill
不能只冻结 `SKILL.md`：resolver 必须携带 frozen `contentVersion`，在任何 model
执行前 no-symlink snapshot **整棵 skill tree**，包含每个 canonical relative
path、entry type、mode 与普通文件内容，copy 到 seal 后计算 canonical tree digest，
再逐项 re-hash并确认 live row 的 `contentVersion` 未变。prompt 只注入 seal 中
`SKILL.md` 的带 digest/来源段；辅助文件只从该 immutable seal 以精确只读路径 bind
给 inner shell，绝不从 live skill path 解析，也不进入 OpenCode skill registry。
skill rename/contentVersion 更新、辅助文件 mutation 或任一 symlink 都在 server 前
fail closed。serve 前与 SSE/POST 前 source/seal fingerprint 必须相等。

该 A-B-A 检查阻止模型通过已授权 worktree 修改 identity surface；它不声称抵御
N3 排除的同 uid 主动宿主进程在两个检查之间换回内容。location 只在模型取得控制
前发现并冻结，后续不得按模型修改后的 cwd 重新发现。

### 4.3 final raw config 强制项

除 agent/permission/MCP/plugin/provider 全字段门外，还要求：

```json
{
  "share": "disabled",
  "autoupdate": false,
  "snapshot": false,
  "formatter": false,
  "lsp": false,
  "compaction": { "auto": false },
  "shell": "<sealed netless shell>"
}
```

remote/managed/MDM 任一后置覆盖都会被 raw gate 拒绝。`snapshot:false` 关闭 legacy
每 step git snapshot；`formatter:false` 与 `lsp:false` 关闭 write/edit/read 的
自动 spawn。core V2 location bootstrap 仍可能用 sanitized system `git` 做
repository discovery；server env 固定
`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`，清空 hooks/exec/SSH/
askpass 等注入变量。该 executable 是显式 OS TCB，项目 config/hook 变异测试必须
证明没有 repo code 执行。

exact official build 的 bootstrap 文件搜索只允许 bundled FFF 路径。源码在
`!Fff.available()` 时会明确选择 ripgrep layer，因此不能只靠“不设置
OPENCODE_DISABLE_FFF”推断安全。official build manifest 同时 pin
`fffCapabilityCodec=1`。real server 前先创建 no-symlink private probe cwd，里面
只有一个随机 basename 的已知普通文件；再用同一个 sealed snapshot 在严格
no-network bwrap、empty read-only cache、无 `rg` 的 sealed PATH 中跑 pinned
`debug file search <exact-basename>`，要求 exit 0、stderr 空且 stdout 精确返回
该 basename 一次。ripgrep layer 的后台 find 在该环境既无 PATH/cache binary 也
不能下载，无法产生命中；FFF 异步扫描尚未完成也只会造成安全的 false-negative。
只有 real fixture 命中才证明该 build/platform 的 `Fff.available()` 为 true，
失败则 `execution-identity-bootstrap-failed`，real server 不启动。
FFF 在执行 probe 前会再次调用同一 production bwrap admission；若该层返回
`execution-identity-sandbox-required`，必须逐码保留，不能被外层 catch 改写成
bootstrap failed。只有其它 artifact、command、stdout/stderr/schema 失败才统一为
`execution-identity-bootstrap-failed`，且 admission 失败后不得 spawn FFF probe。
FFF probe 由 verified-self 原生
`__opencode-fff-capability-supervisor` 作为 direct group leader：它必须先等待
probe direct exit，并把 probe stdout/stderr **两条 pipe 都读到 EOF**，才可发
nonce-bound `RFC224_FFF_RESULT`。parent 在收到精确 RESULT 后、写 ACK 第一字节前
同步放弃 numeric-PGID signal ownership，再写
`RFC224_FFF_ACK <nonce>\n` 并关闭 control stdin；supervisor 只有读到这条
EOF-delimited ACK 才发 `RFC224_FFF_RELEASE`，flush 后向自身负进程组发
`SIGKILL`。成功还要求 supervisor protocol stdout EOF、raw exit 137、stderr 空，
以及在 deadline 内观察到 ESRCH；首个 ESRCH observation 必须单调锁存，之后不再
probe。全部 direct settlement、双 pipe drain、control/protocol EOF 与 release
都受单一 `hrtime.bigint()` absolute deadline
约束；wrong nonce、partial ACK、ACK 未 EOF、额外输出、pipe/release failure 或
watchdog 都 fail closed。进入 releasing 后 parent 只做 bounded control close /
await，绝不再 signal 旧 PGID，也不 fallback 正 PID。
`Fff.create` 后续失败按 pinned 源码只产生 empty service，不回退 rg。

官方 `skill` tool 与 Grep/Glob 一并最终 deny；pinned 源码会先执行 permission
检查，因此 deny 后不会进入 `ripgrep.find`。private cache 仍为空且只读；real
integration 用 exec/network audit 证明 FFF probe + server bootstrap 的
`rg`/`tar`/package install 计数均为 0。

## 5. permission 与模型子进程 containment

### 5.1 有序 permission 尾

`/config` permission object 只比语义 key/value；真正顺序从 `/agent` 的 rules
数组逐项 seal。每个受控 agent 最后的平台 block 为：

1. `read/edit/write/apply_patch/grep/glob: * deny`；
2. `skill/task/webfetch/websearch/lsp: * deny`；
3. `external_directory: <private XDG data>/opencode/tool-output/* deny`，精确覆盖
   upstream `Truncate.GLOB` 自动 allow；
4. `external_directory: * deny`；
5. 不允许 session.permission 再追加 allow，且 Agent.Info 中上述 block 后不得有
   任何 rule。

v1 built-in file tools 的 project-boundary 判断是 lexical；worktree symlink 可令
server 进程读 `/proc/self/environ` 或改 private XDG。因此不设置任何 built-in
file allow，文件读写/搜索全部经 §5.2 的 sealed shell。system/smoke agent 所有
工具 deny。business 最多保留离线 bash、todo、prompt 中的冻结 skill 文本与通过
本 RFC 校验的 MCP tool；没有官方 file/grep/glob/skill tool。

### 5.2 sealed shell wrapper

inline `shell` 指向 seal 中名为 `sh` 的绝对路径。server env 已在父进程侧清掉动态
loader/runtime startup 变量，故 wrapper 解释器启动前没有注入面。wrapper 随后用
`env -i` 只恢复 locale、private HOME、sealed PATH、PWD/private TMPDIR、TERM 与明确
git author 字段。secure v1 仅支持 Linux：nested bwrap 使用
`--unshare-net --unshare-pid --proc /proc`，root ro-bind 只把 root-owned、
不可由 daemon/task uid 写的 system tree 当 OS TCB；随后遮蔽 daemon 真实 HOME、
全部 user-writable executable roots、共享 `/tmp`/`/var/tmp`、platform/seal/XDG
secret paths，再只把精确 worktree/scratch RW 与 skill 辅助文件精确路径 RO bind
回去。sealed PATH 防止普通命令解析落到宿主/user PATH；模型仍可显式执行
worktree artifact 或只读 OS-TCB 绝对路径，这是 §2.2 明示的 containment 范围，
不是 binary-identity 保证。wrapper 的所有 descendant 都位于该 private PID
namespace；macOS 不提供较弱替代路径。

inner sandbox 只能收紧，模型命令不能解除。wrapper 自身所在父目录在 outer
sandbox 中只读。

`bwrap` 的 root ownership、普通文件、可执行、无 group/world-write、无
setuid/setgid 与 realpath 检查只证明 executable provenance，不证明当前 host
允许它创建 user/PID/network namespace。production admission 必须先于 hermetic
store、official snapshot、runtime seal 等任何 filesystem materialization；它在
上述 metadata gate 后，用同一个 root-owned executable 启动独立进程组，并有界执行
与 FFF/inner wrapper 同级的 capability probe：
`--die-with-parent --new-session --unshare-net --unshare-pid --unshare-ipc
--unshare-uts --ro-bind / / --proc /proc --dev /dev --clearenv -- /bin/true`。
非零退出、spawn error 或 timeout 都在 server/store 接触前稳定映射为
`execution-identity-sandbox-required`。

该 probe 不是 shell wrapper：verified-self 原生
`__opencode-bwrap-capability-supervisor` 是 bwrap 的真实 parent 与 direct group
leader，并从启动起持有 control guardian + 10s hard watchdog。bwrap direct exit
settle 后 supervisor 只发
`RFC224_BWRAP_EXIT <nonce> <code>`；parent 必须证明 ACK 前没有 buffered
RELEASE，再在写第一字节前把 ownership 从 `owned` 单调切为 `releasing`，写入
`RFC224_BWRAP_ACK <nonce>\n`、flush 并关闭 stdin。只有 exact EOF-delimited ACK
才能令 supervisor 发 `RFC224_BWRAP_RELEASE`，随后 flush 并向自身负进程组
`SIGKILL`。成功必须同时看到 exact EXIT/RELEASE、protocol stdout EOF、
supervisor raw exit 137，并在 deadline 内观察到 ESRCH；首个 ESRCH observation
必须单调锁存，之后不再 probe。所有 phase 共享 `hrtime.bigint()` absolute
deadline（watchdog + 有界 release margin）；wrong
nonce、ACK 未 EOF、control/protocol EOF 漂移、额外输出、direct 不 settle 或
group 不消失均 fail closed。parent 只在 `owned` 阶段向负 PGID TERM→grace→KILL；
一旦 releasing/released 就只 bounded await，不再 signal，也绝不 fallback 正
PID，避免 old-PGID/PID reuse 误伤。不得以 sysctl、sudo、setuid 或放宽 namespace
参数把不具备产品能力的平台伪装成可用。

### 5.3 local MCP

每个 local MCP command 重写为 seal 中的绝对 wrapper + 原始 argv。OpenCode 会在
wrapper 启动前合并 `mcp.environment`，所以 spawn assembly 必须拒绝 loader/
runtime-startup/Git-exec 等危险 key；server 基线本身也已清空这些 key。

wrapper 进入同样的 netless/pid/filesystem containment 后，用 `env -i` 恢复安全
基线与该 MCP 明确配置的非危险 key。local MCP v1 无网络；remote MCP 不继承本机
env。PTY/API shell 不由 direct codec 暴露，loopback 又对模型 child 不可达。

business/system/smoke 若不是 Linux，或 RFC-205 sandbox 不是
`enforce + available`，或 `bwrap`/所需 namespace probe 失败，均在 server 前返回
`execution-identity-sandbox-required`。

## 6. same-instance preflight

single binary 的 CLI router 只保留四个不出现在 help 的 verified-self hidden
self-command：`__opencode-verified-run`、`__opencode-netless-subprocess`、
`__opencode-bwrap-capability-supervisor` 与
`__opencode-fff-capability-supervisor`。每个入口都对 argv/nonce/deadline/cwd
做 closed validation，畸形直调稳定 fail closed；compiled smoke 必须逐一证明
四个入口不会泄露到 help 且 invalid invocation 不会进入真实工作。

server 命令精确为
`<sealed> serve --hostname 127.0.0.1 --port 0 --no-mdns`，Basic Auth nonce 仅
launcher/server 持有。readiness 总预算 10s、单请求 2s；stdout 只接受一次
`^opencode server listening on http://127\.0\.0\.1:([1-9]\d{0,4})$` 且端口
`<=65535`，任何额外 stdout/重复 line/redirect/early exit 失败；stderr 只留 capped
tail。每个 HTTP request 都带 Basic Auth + canonical `directory` query，禁止
redirect，并有独立 deadline、响应大小上限与 strict schema。

同 canonical directory 依次读取：

1. `/config`：raw agent/global permission/MCP/empty plugin/provider 与 §4.3；
2. `/config/providers`：selected provider/model 必须存在，model.api.npm 必须属于
   official bundled allowlist；该 endpoint 不提供 auth type，OAuth/wellknown 已在
   §4.1 构造 `OPENCODE_AUTH_CONTENT` 前本地拒绝；
3. `/agent`：全部受控 Agent.Info + 仅固定 native set；
4. `/skill`：必须精确等于 v1.18.3 pinned built-in
   `customize-opencode` 的 name/description/`<built-in>` location 与 content
   SHA-256 `6d22eed007626b08113c19a8837e2327e0af0bd3e75bfda9c3bfa07cf122e3eb`；
   不得出现 external/project/platform skill，且 inventory 不触发 executable；
5. 第二次 `/agent`：完整 canonical seal 必须相同；
6. 第二次 project fingerprint 必须相同。

绝不调用 `/mcp/status`。inventory 在门通过后由 launcher 用已验证的 agent、
prompt-injected frozen skill manifest 与 manifest MCP 写出；官方 pinned built-in
skill 只记为 runtime baseline，不冒充 agent 所选 skill，plugins 固定为空。

canonical JSON 仅接受 null/boolean/finite number/string/array/plain object；
object key Unicode code-point 排序，array 保序，poison key/非 JSON 值拒绝。错误只
返回 JSON Pointer，不打印 expected/actual。

## 7. session 与 direct API codec

### 7.1 新 session

POST `/session?directory=<canonical>`，body 固定：

- 非 default title：`agent-workflow:<createdNodeRunId>`；fresh run 的
  `createdNodeRunId` 等于当前 node run，resume 永远复用 owner 表里的
  `created_node_run_id`，不得改用本次 resume run id；
- `parentID` / `workspaceID` 缺失；
- `agent` 等于 manifest；
- `model` 精确为 `{providerID,id,variant?}`（create route 使用 `id`，不是
  `modelID`）；
- permission 精确三条有序 root rule：
  `question:* deny`、`plan_enter:* deny`、`plan_exit:* deny`。

捕获返回 id；directory/title/parent/workspace/share/revert/metadata/agent/model/
permission 再做 strict schema 校验，意外 routing/control 字段拒绝。同时要求
`projectID` 非空、`version=1.18.3`，并把二者加入 session provenance。
非 default title 阻止 upstream title agent 的第二次模型请求。

数据库 migration 新增独立 `opencode_session_owners`：

- `session_id` PRIMARY KEY；
- immutable `task_id`、`node_id`、`created_node_run_id`；
- immutable `identity_digest`、`official_build_digest`、`session_store_key`、
  `project_id`、`opencode_version`、`session_contract_digest`；最后一项对下述
  frozen root-session contract（含明确的字段缺失）做 canonical digest；
- mutable single-writer lease：`lease_node_run_id`、`lease_nonce_digest`、
  `leased_at`。

多个 inline resume `node_runs` 可以合法复用同一 `opencode_session_id`；唯一 owner
只存在于该表，不把历史 node_run 行误当 owner。parent 在 spawn 前把 expected
identity/build/store key 冻结到当前 run。**resume 在任何 store mount/scrub、
SQLite open 或 server spawn 前**，runner 必须在一个事务里按 session PK 复核
owner 全部 immutable 字段、当前 lease 为空，并用
`WHERE session_id=? AND lease_node_run_id IS NULL` CAS 预占
`lease_node_run_id=currentRun` + fresh `lease_nonce_digest`；CAS loser 不得触碰
store。随后 launcher 持同一 nonce 取得生命周期级 store lock，只有二者同时成立
才允许 scrub/open。new run 的 store key 随机且尚无 session id，先持 exclusive
store lock，owner/lease 仍在 session-ready marker 时原子创建。

business `SpawnPlan.control` 带 private ack path + random nonce；launcher 创建或验证
session 后先在 stderr 输出严格、
capped 的单行
`AW_OPENCODE_CONTROL session-ready <base64url(canonical-json)>` marker；JSON
字段精确且仅含
`{kind:"new"|"resume",sessionId,projectId,version,nodeRunId,leaseNonceDigest}`，
其中 digest 为随机 nonce 的 SHA-256，不传 raw nonce。marker 不进 stdout JSONL，
也不作为 stderr event 持久化；随后等待 ack，**还不连接 SSE/POST**。
runner 识别 marker 后：

- new：事务内 insert owner、CAS 当前 run
  `status=running && opencode_session_id IS NULL`，并把 lease 给当前 run；
- resume：只按 marker 的 session/run/nonce 复核 spawn 前已经预占的同一 lease，
  再 CAS 当前 run 的 session id；不得在 marker 阶段首次抢 lease。

成功后 runner 用 `O_EXCL 0600` 写 nonce-bound `ok` ack；DB/CAS/lease/ack 失败写
`nack` 或不应答。launcher 只有读取并验证 `ok + nonce` 才继续，nack/超时则先
abort session 再 fail。这样 provenance/ownership 持久化失败不可能在首个模型请求
后才发现，也不能留下“有 session id、无 owner”的可恢复状态。DB 已提交但 ack
丢失允许留下 owner 完整、未 prompt 的 aborted session；失败 run 不自动 resume，
finally 只能用
`WHERE session_id=? AND lease_node_run_id=? AND lease_nonce_digest=?` compare-and-
clear 自己的 lease；迟到 cleanup 绝不能清掉后来 holder。lifecycle repair 先按
persisted pid/spawn identity 证明 process group dead，再在同一 DB transaction
重读 owner + terminal node_run，按相同 triple compare-and-clear；holder/live
state/nonce 任一变化就 no-op。delayed-finally → repair → reacquire 的 ABA interleave
必须有回归测试。

distiller/smoke 等不复用 session 的 system plan 明确 `control:none`，不伪造 DB
ownership；它们仍在 prompt 前完成全部 identity gate。

### 7.2 resume

不 GET `/session/:id`：该 route 会先按 stored session directory boot foreign
instance。launcher 对当前 canonical instance 分页请求：

```text
GET /experimental/session?directory=<canonical>&roots=true&limit=100&cursor=...
```

请求同时带 frozen title
`search=agent-workflow:<owner.created_node_run_id>`。严格处理
`x-next-cursor`、重复
timestamp/ID/循环 cursor；该 endpoint cursor 只有 `time.updated`，同 timestamp
跨页可能遗漏，所以任一 page 边界等 timestamp ambiguity 都 fail closed。以平台
owner 保存的 exact session id 做唯一匹配，命中后要求：

- canonical directory 精确相等；`path` 精确为 pinned
  `sessionPath(worktree,directory) =
path.relative(path.resolve(worktree),directory).replaceAll("\\","/")`（当前 root
  session 的 canonical worktree=directory，故 wire 值必须是空字符串 `""`，不是
  字段缺失）；
- title 精确为 `agent-workflow:<owner.created_node_run_id>`；
- `parentID` 缺失、`workspaceID` 缺失；
- agent/model/variant 与 manifest 相等；
- permission 精确等于三条 root rules；
- `share`、`revert` 必须缺失；
- metadata 字段必须**缺失**（不是 `{}`）；它连同 path/title/share/revert 等字段进入
  owner 的 `session_contract_digest`，不只是“不含已知 routing key”。

new 与 resume 共用**同一个 strict root-session comparator**，不得维护一份较弱的
恢复 schema；existing legacy session 不满足即显式 migration failure，不自动改
row。`revert` 尤其不能容忍：official prompt 每次调用前会执行 revert cleanup，
带 revert 的 foreign/旧 session 会在首模型请求前删除 transcript parts。

平台在启动 resume 前按 `session_id` 主键读取唯一
`opencode_session_owners` row，要求 task/node、identity digest、official build
digest、session store key 与本次 frozen plan 完全一致；多个历史 `node_runs`
带同一 session id 是正常 transcript linkage，不参与 owner 唯一性判断。随后只
挂载 owner 指向的同一 daemon-private XDG data store。legacy/foreign/missing
owner、目录已丢失、active lease 冲突均返回
`execution-identity-session-mismatch`，不得搜索用户全局 OpenCode 数据库或创建
替代 session。inventory 返回的 session 还须匹配 owner 的 stored
`projectID/version`。

“不 GET `/session/:id`”只禁止会先按 stored foreign directory 路由的 session-info
route。在 §7.2 current-instance inventory 已唯一验证该 session 后，launcher 才可
用同一 canonical directory 调
`GET /session/:id/message?limit=1` 读取最新 message，作为 §7.3 caller-id 排序
下界；返回多条、foreign session 或 schema/排序异常都失败。

### 7.3 SSE 与 prompt

1. 对 `/event?directory=<canonical>` 建立 authenticated SSE；收到 200、
   `text/event-stream` 且**第一个有效事件为 `server.connected`**后才允许 POST。
   parser 支持任意 chunk、CRLF、多行 `data:` 与 heartbeat comment，但对单行、
   单事件、累计 buffer 全部设上限；SSE wire event 必须为 `message`，data 必须是
   `{id:"evt_...",type,properties}`。
2. launcher 先读取当前 session 的 message inventory 并验证 id 单调性。它等待
   wall clock 严格大于已有最大 ascending-id timestamp，生成与 pinned
   `Identifier.ascending("message")` 同 codec 的 caller user id
   （`msg_` + 12 hex 时间/计数 + 14 base62），再等待 clock 进入下一个
   millisecond 才 POST，保证正常 server assistant id 排序在 caller 之后；clock
   future/skew 或返回 id 不满足严格顺序即 fail closed。
3. POST `/session/<id>/message?directory=<canonical>`；body 精确含
   `messageID`、selected agent、`model:{providerID,modelID}`、可选顶层
   `variant`、一个与 manifest byte-equal 的 text part；禁止 `noReply/tools/
format/system`。
4. 只接受恰好一个 caller user `message.updated` 与一个 caller text part；
   session/agent/provider/model/variant/text 必须精确一致，任何其它 user message
   失败。v1.18.3 tool loop 每个 step 都创建新的 assistant，
   所以 launcher 从 `message.updated` 建立**严格递增的有序 assistant-id 集**；
   每个新 id 首次出现都必须满足
   `role=assistant && parentID=<caller messageID> && sessionID=<expected>`，并复核
   agent/provider/model/variant/path。新 assistant 出现前上一个必须 completed；
   后续同 id update 必须保持 identity 字段不变，part/delta 只接受已经绑定的
   assistant id；零个 assistant、重复/逆序 id 或字段漂移均失败。
5. 其它 session/message event 忽略并计数，expected session/已绑定 message 的未知
   event、畸形 JSON、断流、server early exit fail closed。
6. `message.part.updated` 映射为 official v1.18.3 的
   `tool_use/step_start/step_finish/text/reasoning` JSON；`session.error` 失败；
   success 必须同时满足 POST 2xx 返回 strict final WithParts、final assistant id
   等于绑定集合最后一个、expected `session.status=idle` 与至少一个 assistant；
   idle/POST response 顺序不限。
7. unexpected `permission.asked` 或 `question.asked` 立即 abort/fail，不自动
   allow；进入失败态后随后到达的 idle 不能恢复成功。

golden fixture 同一录制事件序列分别经过官方 `run --format json` 与 platform codec，
要求 stdout 顺序/字段/exit code 等价。

## 8. 生命周期、失败与三入口

launcher SIGTERM/SIGINT：

1. abort fetch/SSE；
2. best-effort POST session abort（有 session 时）；
3. TERM server；
4. bounded grace；
5. `kill(-pid, SIGKILL)`；
6. bounded reap/pipe drain。

business、distiller、smoke 外层也把 launcher 设 process-group leader并做相同兜底；
Linux inner bwrap PID namespace 由 namespace init 回收 shell/MCP 后代；取消后还要
验证 namespace 消失。Linux integration 的 real bwrap fixture 必须让
SIGTERM-resistant descendant 先 double-fork + `setsid`，完成 nonce-bound
`READY` → `ARMED` 控制握手并持续持有 stdout。为消除“host 发 TERM 前 target
恰好自退/换组”的假绿窗口，Python anchor 在 `PREPARE_TERM` 阶段对 exact bwrap
child 发 `SIGSTOP`，再用 `waitpid(WUNTRACED)` 确认 stopped 且 PGID 未漂移后签发
`FROZEN` freeze lease；host 只在持有该 lease 时向实际负进程组发送 TERM，再发
`TERM_COMMITTED`。anchor 随即复核 PGID、`SIGCONT` exact child，并用 exact
`waitpid` 证明它由 SIGTERM 退出，依次发 `TERM_RELEASED` /
`TERM_OBSERVED`。最终还要证明 leader 已 reap、原负 PGID 第一次探测即 ESRCH、
fixture stdout EOF；`SURVIVED` / `WATCHDOG` 均是显式失败帧。control pipe 正常
路径保持开放直到 anchor group 自然被 KILL/退出，首次 ESRCH 后不再重探或 signal
旧数值 PGID。macOS 不运行模型，因此不声称仅靠 process group 回收 daemonized
descendant。

`SpawnPlan.control` 是 runtime-neutral discriminated union。runner 的 stderr pump
在持久化普通 stderr event 前先做 exact marker parse；unknown/malformed/重复
control marker 立即 nack/fail，永不把 marker payload 当用户可见错误或 envelope
输入。cleanup 必须删除 ack artifact，并在 spawn 失败、cancel 与正常退出都调用。
verified plan 还返回 runtime-neutral `sessionStore.dbPath` locator；runner 的 live
poller 与 post-run capture 必须显式传该路径，绝不回退
`resolveOpencodeDbPath()` 读取 daemon 真实 HOME。system plan 不需要 capture 时
locator 缺失。

稳定码至少包括：

- `execution-identity-untrusted-binary`
- `execution-identity-sandbox-required`
- `execution-identity-project-config-unsupported`
- `execution-identity-plugin-unsupported`
- `execution-identity-dependent-unsupported`
- `execution-identity-model-unresolved`
- `execution-identity-bootstrap-failed`
- `execution-identity-mismatch`
- `execution-identity-instance-changed`
- `execution-identity-session-mismatch`
- `execution-identity-stream-failed`
- `execution-identity-timeout`

runner marker 只持久化 code/path/非敏感 digest；identity code 永不进 envelope
followup 或相同输入自动 retry。distiller 同样 permanent；smoke 返回明确 identity
outcome。三条入口共享一个 `buildVerifiedOpencodePlan`，source guard 禁止新增
direct opencode spawn。

### 8.1 shared contract、保存门与 UI

上述 identity code 在 `packages/shared` 只有一份 schema/type guard；现有 envelope
followup code 保持窄 union，`followupPolicyForFailure()` 对 identity code 返回
undefined，scheduler/workgroup 看到 identity code 时不消耗普通 retry。SQLite
`failure_code` 是 TEXT，不为失败码本身做 migration；session provenance 按 §7.1
单独 migration。

一个 shared pure execution-policy helper 以**有效运行时**为输入。OpenCode 必须有
显式 model，且 agent 的 plugin/`dependsOn` 必须为空；它在 runtime create/update、
agent create/update、system-runtime config、direct launch、scheduled task
create/update/fire 与最终 runner funnel 全部调用。seeded/legacy OpenCode runtime
可继续以 `model=NULL` 存在，但 operator 保存任何修改时必须同时修复；legacy agent
有不支持资源时 UI 允许删除旧值，却阻止保存其它修改。把 default runtime 切到
OpenCode 前还要预检所有继承 default 的 agent。

`/api/runtimes/status`、probe/smoke 与 `/api/runtime/models` 不再直接执行 registry
里的任意 fork：version/hash diagnosis 与 model inventory 只能来自 official
snapshot；模型 smoke 仍须走完整 verified launcher，故 macOS 返回 sandbox
required。Runtime UI 对 OpenCode 把 model 显示为 required，null row 显示 danger
状态并禁 Test；Agent form/select 对有效 OpenCode 的 plugin/dependsOn/null-model
显示稳定本地化 blocker。API、task failure、首页 status 都按 stable code 渲染，不
展示含 secret 的 raw detail。

## 9. 测试与交付门

### 9.1 变异/协议

- canonical JSON、Agent.Info 全字段、permission rules 顺序、MCP local/remote
  全字段、provider/top-level security config mutation、official provider npm /
  auth-type allowlist；
- agent missing/disable/subagent/native/fallback、model null；
- project config/plugin/custom tool/external skill/`reference/references`/symlink/
  模型可控 TOCTOU，模块执行计数 0；同 uid host race 明确不作为安全证明；
- frozen `AGENTS.md`/`SKILL.md` 注入、辅助文件只读 bind、official `skill` deny；
- session create/resume pagination、DB provenance、persistent XDG store、
  parent/workspace/directory/project/version/agent/model/permission；
- SSE server.connected-before-POST、caller user/text、single 与 multi-step
  ordered assistant parent binding、跨 session/message、unknown/malformed/drop、
  idle/POST response 两种顺序、server early exit；
- official JSON golden 与 secret-not-in-error。

### 9.2 containment

- seal unlink/rename/write、PATH replacement、XDG DB/config/cache read/write；
- shell/local MCP env capture中无 server/config/provider/platform secret；
- loopback/private/public network、process-info、`/proc/self/environ`、daemon real
  HOME、shared `/tmp`/`/var/tmp`；
- worktree symlink 指向 `/proc/self/environ` / private XDG 时，server file tool
  不存在或为 deny，只有 inner-sandbox shell 可见授权视图；
- `LD_PRELOAD`/DYLD/runtime startup/Git exec/package manager env injection；
- formatter/LSP/snapshot/title/compaction/skill/rg/tar/npm-install/task/web tools
  均不可触发；legacy config `.gitignore` 已预建且 install/network count 为 0；
- Linux bwrap 有 gated real escape + SIGTERM-resistant double-fork/setsid orphan
  matrix；nonce-bound READY/ARMED 后必须取得
  SIGSTOP + `waitpid(WUNTRACED)` freeze lease，再锁定实际负组 TERM、SIGCONT 后
  exact SIGTERM exit、leader reap、首个 ESRCH observation 单调锁存与
  descendant-held stdout EOF；
  `SURVIVED`/`WATCHDOG` 必须失败。macOS business/system/smoke 有 fail-closed
  matrix，darwin 仅跑 binary/managed-path diagnostic（含真实 `plutil` exec
  count 0）。

### 9.3 release

1. Codex 设计门无 P0/P1；
2. 定向测试；
3. `bun run typecheck && bun run lint && bun run test && bun run format:check`；
4. depcheck、`bun run build:binary:e2e`、production/e2e artifact 与 compiled
   hidden-command smoke；
5. 官方 1.18.3 no-LLM preflight + pinned integration；
6. Codex 实现门无未关闭 P0/P1/P2；
7. 精确 path commit、核验 co-author trailer、push main；
8. 按 commit SHA 等 CI/integration 终态。

发布 workflow 还必须锁住两类与 production contract 同源的 ratchet：

- `integration-opencode` 使用已资格化的 Linux runner，并在执行 suite 前以普通用户
  运行上文 exact bwrap capability probe；suite 内再跑 real setsid/double-fork
  orphan probe。runner pin 只是可复现基线，不能替代 production admission 或
  integration 的真实行为证据。
- source guard 必须同时读取 `ci.yml`、`visual-regression-nightly.yml`、
  `integration-opencode.yml` 与 `e2e-webkit-nightly.yml`，逐份证明只有一个
  official `1.18.3` pin，所有真实安装目标只能引用该 pin，bare、`@latest` 或额外
  版本都失败。它还枚举六个 `e2e/fixtures/stub-opencode*.sh`，每个 version arm
  必须唯一且输出精确 `stub-opencode 1.18.3`；额外 advertised version 同样失败。
- compiled smoke 除四个 hidden command 的 invalid-invocation ratchet 外，还要对
  bwrap native supervisor 跑三条独立协议试验：valid 路径在 ACK 前不得 buffer
  RELEASE，ACK 内容虽已 flush 但 stdin 未 EOF 时同一个 pending read 在观察窗内
  必须既无 chunk 也无 EOF，关闭 stdin 后才允许 exact RELEASE；wrong nonce ACK
  必须无 RELEASE、protocol EOF、raw 137，并在 deadline 内观察并锁存首个 ESRCH。
  三条路径的 cleanup 都只关闭 control/reader，绝不 signal 已释放的 numeric PGID。

### 9.4 首个 implementation SHA 的失败诊断历史

`b4b3e082c0bf010f123c3e93c7b9abbd1f4f877e` 已进入 remote `main`，但以下三个
exact-SHA workflow 均为 **failure**，只作为诊断历史，绝不是绿色发布证据：

- [`integration-opencode` run 30045245638](https://github.com/wangbinquan/agent-workflow/actions/runs/30045245638)：
  official no-LLM preflight 在 FFF 阶段返回 `execution-identity-bootstrap-failed`。
  该 run 暴露原 admission 只验证 bwrap ownership/mode、没有先证明 namespace
  capability；旧 artifact 未保留 FFF raw stderr，因此 Ubuntu 24.04
  userns/AppArmor 只能作为平台诊断，不能写成已捕获的精确原始报错。
- [`CI` run 30045245623](https://github.com/wangbinquan/agent-workflow/actions/runs/30045245623)：
  Playwright shards 在 daemon startup 明确报
  `opencode 1.14.99 is older than required minimum 1.18.3`。
- [`visual-regression-nightly` run 30045245613](https://github.com/wangbinquan/agent-workflow/actions/runs/30045245613)：
  同样由 visual harness 的 1.14.99 stub 在 daemon startup 被最低版本门拒绝。

前者是 product capability admission 缺口，后两者是 runner/fixture ratchet 漂移，
两者互相独立。因此在该 SHA 上 T32 保持未完成；后续修复链与最终发布证据见
§9.6。

### 9.5 独立复审 follow-up 本地终裁

首轮失败诊断后的独立复审登记 **4 组 P1 / 2 组 P2**；real Linux 探针专项
复审再登记 **5 组 P1 / 3 组 P2**，累计达到 **23 组 P1 / 14 组 P2**：

- P1：capability process 必须有界证明 direct settlement 与负 PGID 消失；FFF
  二次 admission 必须保留 stable sandbox code；bwrap admission 必须先于
  store/snapshot/seal；production mode gate 必须拒绝 setuid/setgid。
- P2：四份 workflow 与六个 stub 必须由 exact 1.18.3 source ratchet 锁住；Linux
  integration 必须提供 real setsid/double-fork orphan 证据，且 follow-up 改动后
  旧 T28 全门数字只能算历史 baseline，必须重跑。
- 探针 P1：固定 delayed-marker 计时无法形成因果 oracle；ready 后 bwrap 自退可
  零 signal 假绿；成功后再次 signal 旧 PGID 可误杀，失败路径又可能遗留孤儿；
  silent watchdog 还可冒充 namespace cancellation EOF。production bwrap 与 FFF
  已分别改由 verified-self 原生 supervisor 执行 nonce-bound
  EXIT/RESULT → ACK+EOF → RELEASE → self negative-group SIGKILL，release 以
  absolute deadline、protocol EOF、raw 137 与首个 ESRCH observation 单调锁存
  共同证明；integration 用 SIGSTOP + `waitpid(WUNTRACED)` freeze lease 把实际
  负组 TERM 与 exact child SIGTERM exit 建成因果链，release 后不再 signal
  旧数值 PGID。
- 探针 P2：所有 deadline 改用单一 `hrtime.bigint()` hard cap；reader/rejection
  必须进入显式 observer failure；official server cleanup 禁止 positive-PID
  fallback，并要求 direct+PGID+bounded pipe drain 三项完成。

对应 resolution 已由 current-tree 行为锁与 source ratchet 复验：sealed
subprocess **23 pass / 90 assertions**、FFF capability
**13 pass / 98 assertions**，RFC-224 定向集合
**322 pass / 1412 assertions**（含 compiled Playwright seam
**5 pass / 30 assertions**）；typecheck、lint、format、depcheck、
`git diff --check`、production/e2e binary build 与上述 compiled smoke 均完成。本地实现门
终裁恢复为 **APPROVED / 0 open**：累计 **23 组 P1 / 14 组 P2** 全部 resolved，
最终未关闭 **0 P0 / 0 P1 / 0 P2**。这在当时只关闭本地 T28/T30、没有提前关闭
发布；后续远端修复链与 T32 完成证据见 §9.6。

### 9.6 远端修复链与最终发布证据

完整提交链为
`b4b3e082c0bf010f123c3e93c7b9abbd1f4f877e` →
`a7f6814e028aa27c082508107d1217029e0e417e` →
`fe96a42ad1e9423d61675d336585e63344f3eb4a` →
`791c433508b1721ced96d900b04128a022f02ff2` →
`c50036ac35a4a87c52b825f280d1afc1a9d54784`。§9.4 的首轮失败之后：

- `a7f6814e028aa27c082508107d1217029e0e417e` 的
  [`integration-opencode` 30057061688](https://github.com/wangbinquan/agent-workflow/actions/runs/30057061688)
  暴露 Python enum/string oracle 漂移；
  [`CI` 30057061665](https://github.com/wangbinquan/agent-workflow/actions/runs/30057061665)
  因 actionlint 与 model-less E2E seed 422 失败；
  [`visual-regression-nightly` 30057061833](https://github.com/wangbinquan/agent-workflow/actions/runs/30057061833)
  因 theme config PUT 422 失败。这三个结果继续只作诊断历史。
- `fe96a42ad1e9423d61675d336585e63344f3eb4a` 的
  [`integration-opencode` 30057707597](https://github.com/wangbinquan/agent-workflow/actions/runs/30057707597)
  首次成功；但
  [`CI` 30057707588](https://github.com/wangbinquan/agent-workflow/actions/runs/30057707588)
  仍因 ShellCheck SC2016 与八个 model-less E2E shard 失败，
  [`visual-regression-nightly` 30057707642](https://github.com/wangbinquan/agent-workflow/actions/runs/30057707642)
  为 **22 pass / 4 fail**，暴露 stub trust/terminal fixture 漂移，因此该 SHA 也
  不是发布点。
- `791c433508b1721ced96d900b04128a022f02ff2` 的
  [`integration-opencode` 30059793133](https://github.com/wangbinquan/agent-workflow/actions/runs/30059793133)、
  [`Visual Regression` 30059793075](https://github.com/wangbinquan/agent-workflow/actions/runs/30059793075)
  与
  [`git-protocols-e2e` 30059793067](https://github.com/wangbinquan/agent-workflow/actions/runs/30059793067)
  均成功；但
  [`CI` 30059793066](https://github.com/wangbinquan/agent-workflow/actions/runs/30059793066)
  在 static actionlint 报 SC1072/SC1073 后被取消，仍不能作为绿色发布点。
- 最终 `c50036ac35a4a87c52b825f280d1afc1a9d54784` 的
  [`CI` 30059969045](https://github.com/wangbinquan/agent-workflow/actions/runs/30059969045)
  **28/28 jobs success**；
  [`integration-opencode` 30059985690](https://github.com/wangbinquan/agent-workflow/actions/runs/30059985690)
  中 RFC-224 official 子集 **3 pass / 15 assertions**，whole workflow
  **5 pass / 5 skip / 0 fail / 19 assertions**；
  [`Visual Regression` 30059987003](https://github.com/wangbinquan/agent-workflow/actions/runs/30059987003)
  与
  [`git-protocols-e2e` 30059988422](https://github.com/wangbinquan/agent-workflow/actions/runs/30059988422)
  也均为 terminal success。

因此 AC10 与 T32 均已满足，proposal/release 状态于 2026-07-24 关闭为 Done。
