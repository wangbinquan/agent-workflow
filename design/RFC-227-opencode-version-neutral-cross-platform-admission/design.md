# RFC-227 技术设计：OpenCode 版本无关与跨平台能力准入

状态：Done（2026-07-24；用户已批准；本地实现门 APPROVED / 0 open）。

## 0. Supersession 与不变量

本 RFC 精确 supersede：

- RFC-224 §3 的 official `1.18.3` exact allowlist 作为 admission trust root；
- RFC-224 §5/§8 的 `platform === linux + enforce + bwrap` 唯一执行入口；
- RFC-226 中“版本门只是后移而非删除”的当前态说明；
- RFC-112 顶部关于 custom OpenCode fork 被 RFC-224 禁止的修订。

不 supersede：

- hermetic config/source 与 no-dynamic-import surface；
- same-instance `/config`、`/agent`、`/skill`、provider、MCP、model identity；
- direct API caller-owned message、SSE parent binding 与 session provenance；
- private store、owner/lease、resume mismatch、identity failure permanent；
- executable snapshot、copy re-hash、只读 seal 与 launch 前复验。

核心拆分为三个正交判断：

```text
ExecutableSnapshot  --bytes identity-->  RuntimeBinaryIdentity
ProtocolQualifier   --behavior-------->  ProtocolReceipt
ContainmentProvider --host capability->  ContainmentReceipt
                                   \      /
                                    AdmissionDecision
```

任何一层都不得借 reported version 或 OS 名称替另一层下结论。

## 1. 类型与模块边界

### 1.1 Binary identity

```ts
interface RuntimeBinaryIdentity {
  sourceCommand: readonly string[]
  resolvedPath: string
  snapshotPath: string
  binaryDigest: string
  reportedVersion: string | null
}
```

`reportedVersion` 不进入 identity digest、session equality 或 admission。它只进入
bounded diagnostics。`binaryDigest` 是 snapshot bytes 的 SHA-256，不叫
`officialBuildDigest`，也不表示签名或来源。

`officialBuilds.ts` 拆为：

- `runtimeExecutable.ts`：command resolve、平台文件类型检查、exclusive snapshot、
  copy 后 re-hash、launch re-hash；
- `runtimeBinaryIdentity.ts`：canonical identity 与错误映射；
- provider-owned executable adapter：POSIX mode/no-symlink 与未来 Windows
  executable/path 规则，避免 core 直接判断 mode bit、`/` 或 signal。

管理员是 runtime write ACL 的唯一主体，故其选择的 executable 是 TCB。若未来需要
“只允许供应商签名”，应作为可选 provenance policy 另立 RFC，不能重新借 version
字符串实现。

### 1.2 Protocol codec 与 receipt

```ts
type OpencodeProtocolCodecId = string

interface OpencodeProtocolReceipt {
  codec: OpencodeProtocolCodecId
  binaryDigest: string
  qualifiedAt: number
  endpoints: readonly string[]
  contractDigest: string
}

interface OpencodeProtocolCodec {
  readonly id: OpencodeProtocolCodecId
  qualify(client: DirectApiClient): Promise<OpencodeProtocolReceipt>
  parseConfig(value: unknown): ParsedConfig
  parseAgents(value: unknown): ParsedAgent[]
  parseSkills(value: unknown): ParsedSkill[]
  parseSession(value: unknown): ParsedSession
  parseEvent(value: unknown): ParsedEvent
}
```

codec registry 按本平台支持的行为合同排序尝试，首个实现是
`opencode-direct-v1`。registry 不含 version range；同一 upstream release、旧 release
或 fork 只要响应满足同一合同就选择同一 codec。

### 1.3 Containment provider 与 receipt

```ts
type RuntimeContainmentCapability =
  | 'platformHomeIsolation'
  | 'immutableArtifactView'
  | 'modelChildNetworkDeny'
  | 'descendantLifetimeBound'

type CapabilityStrength = 'strong' | 'best-effort' | 'absent'

interface RuntimeContainmentReceipt {
  providerId: string | null
  mode: 'enforce' | 'warn' | 'off'
  capabilities: Readonly<Record<RuntimeContainmentCapability, CapabilityStrength>>
  available: boolean
  degradedReasons: readonly string[]
}

interface RuntimeContainmentProvider {
  readonly id: string
  probe(): Promise<RuntimeContainmentReceipt>
  wrapServer(plan: ServerContainmentPlan): Promise<WrappedProcess>
  materializeModelChildLauncher(plan: ChildContainmentPlan): Promise<SealedArtifact>
  terminate(handle: ContainedProcessHandle): Promise<TerminationReceipt>
}
```

provider id 与 capabilities 都是可扩展 schema；不能再用
`z.enum(['seatbelt', 'bwrap'])` 表示完整世界。core 只调用 interface，不接收
`platform`、`bwrapPath` 或 `/usr/bin/sandbox-exec`。

## 2. Binary admission 数据流

1. 从 runtime registry 冻结的 command 解析一个 executable target；
2. provider executable adapter 做 no-NUL、absolute/canonical、regular executable
   与平台权限检查；PATH lookup 结果马上转绝对路径；
3. streaming hash source；
4. `COPYFILE_EXCL` / Windows 等价 primitive 复制到 private per-run seal；
5. snapshot 重新 lstat/hash，必须与 source digest 一致；
6. source 在 copy 前后 metadata/digest 发生变化则整个 admission 失败并删除 snapshot；
7. manifest 只携带 snapshot path + digest；launcher exec 前再复验；
8. provider 把 seal 映射为不可写。只 chmod/read-only attribute 不能单独作为
   `immutableArtifactView=strong`；
9. `--version` 对 snapshot 执行有界 probe。成功时保存去控制字符、限长后的原始版本；
   失败时保存 null，不改变后续 qualifier。

不再存在：

- `OFFICIAL_OPENCODE_BUILDS`；
- `requireOfficialOpencodeBuild(version, platform, arch)`；
- `expectedOfficialBuildDigest`；
- version → codec / FFF capability 的查表。

### 2.1 Script 与动态依赖

若平台 adapter 允许脚本 executable，digest 只覆盖入口文件，不证明 interpreter 或依赖。
这与管理员 TCB/OS toolchain 非目标一致，status 必须把 executable kind 记入 diagnostics。
不得把脚本误标为供应链已验证。脚本与 provider 无法证明为 self-contained 的 executable
不得复用跨运行 full protocol receipt；每次 execution 都重跑 non-model qualifier，避免入口
digest 未变而 interpreter/依赖已漂移时命中陈旧 cache。

## 3. 行为 qualifier 与 schema 兼容

### 3.1 两级 probe

**轻量 status**

- resolve/snapshot binary；
- 有界执行 `--version`，仅收 telemetry；
- 不消费模型额度；
- 没有 cached full receipt 时返回 `available-unverified`。

**协议 Test / 首次真实执行**

1. 用 snapshot binary、private HOME/XDG/store 启动临时 `serve`；
2. 等待同 instance health ready；
3. 验证 config/provider/agent/skill endpoint 与完整 JSON 基本形状；
4. 创建一个无模型请求的临时 session，验证 id/project/directory/title/permission shape，
   随后删除；
5. 选择一个支持的 codec，生成绑定 binary digest 的 receipt；
6. full smoke 或真实 run 再做 RFC-224 的 selected
   config/agent/model/MCP/source/session exact attestation；
7. 首个模型 POST 前任一步失败都返回
   `execution-identity-protocol-incompatible` 或既有更具体 identity code。

cached receipt key：

```text
runtimeId + binaryDigest + protocolCodec + runtime.probeFence
```

status 不可只按 binary path 命中 cache。每次执行都重新 snapshot/hash；cache 只省去
non-model qualifier，不能省 same-instance attestation。

### 3.2 Strictness 规则

- 所有输入先通过 finite/acyclic/no-poison JSON guard；
- id、role、model、permission、MCP、provider、session parent/message/event binding 等
  安全关键字段继续逐字段严格校验；
- codec 可以显式列出“允许但不影响身份”的 additive keys，并忽略其值；
- config/agent/MCP/plugin/tool/provider 中未知、可能扩大 executable surface 的 key
  一律拒绝；
- 不允许为了兼容新版本把顶层或安全对象统一改成 `.passthrough()`；
- codec selection 只能来自观察到的 endpoint/shape，不能读取 reported version 分支。

`directApiSchemas.ts` 删除 `PINNED_OPENCODE_VERSION`，改为 codec-owned schemas。
control marker/manifest 携带 `protocolCodec` 和 `binaryDigest`；若 upstream response
包含 version，它作为 nullable telemetry 单独解析。

## 4. Admission 真值表

基线 required capabilities：

```ts
const BASELINE = [
  'platformHomeIsolation',
  'immutableArtifactView',
  'modelChildNetworkDeny',
] as const
```

| mode    | provider / baseline               | decision            | observability               |
| ------- | --------------------------------- | ------------------- | --------------------------- |
| enforce | available + baseline strong       | run                 | ready                       |
| enforce | missing / 任一 baseline 非 strong | refuse              | containment-blocked         |
| warn    | available + baseline strong       | run                 | ready                       |
| warn    | missing / partial                 | run                 | degraded + persistent alert |
| off     | 任意                              | run without wrapper | off（管理员显式关闭）       |

warn 的 degraded 分支与 off 仍执行 binary/config/session identity gate，但不再提供
platformHomeIsolation、immutableArtifactView 或 modelChildNetworkDeny。任务告警必须列出
缺失能力并说明模型可接触宿主资源；不得把“协议验证通过”混写成“安全隔离通过”。

`descendantLifetimeBound` 不属于跨平台 baseline：

- Linux bwrap：strong，保留 private PID namespace + verified supervisor + real orphan probe；
- macOS Seatbelt：best-effort，继承 sandbox 限制 + detached process group TERM/KILL，
  但不声称 setsid/double-fork 后代必然被 namespace 回收；
- future Windows Job Object：设计目标 strong，Job handle kill-on-close。

这一差异进入 `ContainmentReceipt`、run diagnostics 与 Settings，不得藏在日志。

## 5. Provider 设计

### 5.1 Linux bwrap

现有 `requireRootOwnedBwrap`、真实 namespace/mount capability probe、
`__opencode-bwrap-capability-supervisor`、FFF proof、outer/inner bwrap renderer 和
orphan integration 保留，但移入 `LinuxBwrapContainmentProvider`。

FFF 不再是某个 OpenCode 版本的 build metadata；它成为
`opencode-direct-v1` 在 Linux provider 下的 file-fallback 行为 probe。失败映射协议或
provider 能力，不再通过 `OFFICIAL_OPENCODE_BUILDS.fffCapabilityCodec` 查表。

### 5.2 macOS Seatbelt

`MacSeatbeltContainmentProvider`：

1. outer profile 沿用 RFC-205 appHome deny + exact worktree/run allow-back；
2. binary/config/skill seal 在所有 RW allow-back 之后追加 write deny/read allow；
3. server 需要 provider 网络，因此 outer 不做全局 network deny；
4. shell/local MCP launcher 追加更窄 Seatbelt profile：deny network、只允许 exact
   worktree/scratch/selected read-only skill 与必要 OS toolchain；
5. child env 继续 `env -i` 重建，不继承 server/provider/platform secret；
6. provider probe 必须真实证明 secret deny、worktree allow、seal write deny 和 child
   network deny，不能只检查 `/usr/bin/sandbox-exec` 存在；
7. termination 使用 detached process group bounded TERM→KILL，并把
   `descendantLifetimeBound=best-effort` 写入 receipt。

macOS 不再在 `assertVerifiedOpencodePlanBoundary` 因平台名称失败。

### 5.3 Windows future seam

本 RFC 不交付 Windows product support，但 interface 必须允许后续 provider：

- Job Object `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 管 descendant lifetime；
- restricted token/AppContainer/ACL view 管 platform home、worktree 与 network；
- read-only seal 由 Windows ACL/provider-owned staging 实现；
- `.exe/.cmd` resolution、drive/UNC/case rules、process creation 与 termination 全在
  adapter/provider 内；
- core schema 只看 provider receipt，不能出现 POSIX mode、negative PGID 或 path
  separator 假设。

纯 contract test 注入 `providerId='windows-job-object'` 与 `win32` executable adapter，
必须通过与 Linux/macOS 相同的 admission core。真实 Windows CI/发布由后续平台 RFC
负责。

## 6. Manifest、control、owner 与 recovery

### 6.1 Manifest/control

`VerifiedLaunchManifest` codec bump，替换字段：

```diff
- version: "1.18.3"
- officialBuildDigest: sha256
- fffCapabilityCodec: 1
- fffProbe: { bwrapPath, ... }
+ reportedVersion?: string | null
+ binaryDigest: sha256
+ protocolCodec: string
+ protocolReceiptDigest: sha256
+ containment: RuntimeContainmentReceipt
+ providerPlan: finite no-poison JSON, then exact provider-owned schema parse
```

common manifest 只验证 provider plan 是 finite/no-poison JSON；随后必须按已注册
`providerId` 选择唯一 provider-owned strict schema 二次解析，unknown provider fail closed。
core 不展开 bwrap/seatbelt/Windows 参数，也不维护一个阻止未来扩展的中央 closed union。
control `session-ready` marker 返回 `binaryDigest + protocolCodec`；runner 与 manifest、
owner exact 比较。

### 6.2 Session owner migration

预计使用下一个可用 migration（当前预计 `0121`）原子 rebuild
`opencode_session_owners`：

```diff
- official_build_digest TEXT NOT NULL
- opencode_version TEXT NOT NULL
+ runtime_binary_digest TEXT NOT NULL
+ protocol_codec TEXT NOT NULL
+ reported_version TEXT
```

旧行 backfill：

- `runtime_binary_digest = official_build_digest`；
- `protocol_codec = 'opencode-direct-v1'`；
- `reported_version = opencode_version`。

所有 index、FK 与 lease all-or-none CHECK 原样重建；migration 有旧库 fixture、FK
检查与 rollback/失败原子性测试。应用代码不保留双读过渡。

owner immutable equality 使用 binary digest、protocol codec、identity/session
contract digest；reported version 不参与 equality。

### 6.3 Recovery

`opencodeStoreRecovery` 不再从当前 OS/arch 的 allowlist计算 expected digest，而从
owner/server marker 读取并交叉验证：

1. server marker digest/codec == owner；
2. live process executable == sealed snapshot digest；
3. provider termination receipt 证明当前可证明的 cleanup；
4. mismatch fail closed，不猜版本、不自动改写 owner；
5. legacy owner 已由 migration backfill，行为与新行相同。

Linux 的 namespace/PGID recovery 留在 provider；macOS 的 process-group recovery
留在 Seatbelt provider。core 不出现 bwrap-specific comment 或 state。

## 7. Status API 与 UI

shared additive schema：

```ts
interface RuntimeStatusEntry {
  // legacy
  ok: boolean
  version: string | null
  // RFC-227
  state:
    | 'not-found'
    | 'unlaunchable'
    | 'available-unverified'
    | 'protocol-incompatible'
    | 'containment-blocked'
    | 'degraded'
    | 'ready'
  reportedVersion: string | null
  protocolCodec?: string
  failureCode?: string
}

interface ContainmentStatus {
  providerId: string | null
  mode: 'enforce' | 'warn' | 'off'
  available: boolean
  capabilities: Record<string, 'strong' | 'best-effort' | 'absent'>
  degradedReasons: string[]
}
```

`mechanism` 旧字段可在一个 wire 兼容周期保留，但新 UI 读 provider/capabilities。
backend 必须按失败阶段填 state，不用 catch-all `ok=false`。

首页与 Settings 映射：

- 仅 `not-found` → “未找到”；
- `unlaunchable` → “无法启动”；
- `available-unverified` → “可执行，尚未测试协议”；
- `protocol-incompatible` → “协议不兼容”；
- `containment-blocked` → “隔离策略阻止执行”；
- `degraded` → “可运行，隔离已降级”；
- `ready` → “可运行”。

版本显示为中性次要文本；不得按大小、是否等于 `1.18.3` 改 badge。

## 8. 失败码

新增/改义：

- `execution-identity-binary-unavailable`
- `execution-identity-binary-snapshot-failed`
- `execution-identity-binary-changed`
- `execution-identity-protocol-incompatible`
- `execution-identity-containment-required`

旧 `execution-identity-untrusted-binary`、`execution-identity-sandbox-required` 仅用于
读取历史 event/兼容旧 client，不再由新生产 admission 发出。错误 payload 继续只含
stable code/path label/non-secret digest，不包含 binary bytes、secret 或任意 upstream
body。

## 9. 影响面

- backend runtime: `util/opencode.ts`、driver interface、status/models/smoke；
- verified path: official builds、direct schemas、manifest/control/launcher、
  verified business/system plan、FFF、sealed subprocess；
- sandbox: provider registry、probe/policy/guidance、Linux/macOS provider；
- persistence: session owner schema/service、store marker/recovery、migration；
- shared/frontend: runtime/containment schemas、status state mapping、i18n；
- docs/current contracts: `CLAUDE.md`、`STATE.md`、`design/plan.md`,
  `design/design.md`、README、`docs/OPENCODE_CONFIG.md`、sandbox/troubleshooting，
  并给 RFC-112/224/226 加 supersession 注记。

## 10. 测试策略

### 10.1 版本与行为矩阵

同一个 conforming fixture 分别报告旧/当前/新/极大/非 semver/null version，所有
admission receipt 除 telemetry 外 byte-equivalent。另一个 fixture 精确报告
`1.18.3` 但 mutation endpoint/schema/event，必须失败。

source ratchet 禁止生产依赖图出现：

- `MIN_OPENCODE_VERSION` / `PINNED_OPENCODE_VERSION`；
- OpenCode admission 的 semver compare；
- 单版本 `OFFICIAL_OPENCODE_BUILDS`；
- exact version 的 CI 唯一 pin 守卫。

历史 RFC/fixture 文本可出现版本号，ratchet 必须限定 production/current docs，不能
误伤历史证据。

### 10.2 Binary/session

- symlink/path/multi-token/non-regular/permission；
- source before/after copy mutation、snapshot after-copy mutation、launch mutation；
- digest-bound probe cache invalidation；
- new/resume owner digest/codec equality；
- migration legacy backfill、foreign key/index/check；
- recovery server/owner/snapshot 三方 mismatch。

### 10.3 Provider matrix

纯函数真值表覆盖三种 mode × ready/missing/partial provider；同一 admission fixture
分别注入 Linux/macOS/future Windows provider，证明 core 不看 OS。

gated integration：

- Linux：保留 real bwrap namespace/FFF/orphan/protocol supervisor；
- macOS：real Seatbelt secret/worktree/seal/inner-network + model execution
  no-platform-block；
- Windows：本 RFC 仅 contract test；future RFC 再加真实 Job/AppContainer CI。

### 10.4 前端与全入口

- status 七态与中英 i18n；
- 首页绝不把非 missing 映射成“未找到”；
- Settings 显示 provider capability strength 与 mode；
- business/system/distill/smoke/models/status source reachability，无 raw spawn；
- typecheck、lint、format、depcheck、全量 test、binary smoke、设计/实现门。

## 11. 发布与回滚

实现按单 RFC / 单 PR 原子发布：migration、backend 与 frontend 不拆成可观察的半状态。
首次启动使旧 OpenCode probe receipt 全失效；不主动运行 binary，仍遵守 RFC-226 的
daemon startup 解耦。

回滚演练必须先验证旧 binary 对新 owner schema 的行为。若不能安全 downgrade，应由
版本 gate 明确拒绝旧 binary 启动，不能让旧代码把任意 digest 当官方 `1.18.3` 继续运行。

## 12. 设计自审修订账（2026-07-24）

| Finding                                                        | 风险                                | 裁决                                                                                        |
| -------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| R1 只删 version compare 仍保留 strict `1.18.3` manifest/schema | 形成隐蔽版本门                      | codec、manifest、control、owner、recovery 全链同时去 literal，source ratchet 覆盖生产依赖图 |
| R2 SHA-256 被继续称为 official proof                           | custom fork 获得虚假供应链背书      | 信任边界明确改为 admin TCB；digest 只证明 snapshot bytes identity                           |
| R3 脚本入口 digest 不覆盖 interpreter/dependencies             | 旧 receipt 可在依赖漂移后误命中     | 非 self-contained executable 禁止跨运行复用 full receipt，每次重跑 qualifier                |
| R4 `warn/off` 只写“降级”未说明丢失何种保证                     | 用户误以为仍保护宿主 secret/network | proposal、真值表、UI 合同明确列出缺失 capability，禁止称为安全隔离                          |
| R5 把 macOS process group 描述成 Linux PID namespace 等价      | orphan guarantee 失实               | `descendantLifetimeBound` 独立为 best-effort/strong，状态与 run receipt 必显                |
| R6 中央 provider closed union                                  | 加 Windows 仍需修改 OpenCode core   | common 只做 no-poison JSON，注册 provider 用自己的 strict schema 二次解析                   |
| R7 “支持 Windows”措辞可能被理解为本 RFC 完成 Windows 产品移植  | 交付范围虚报                        | 明确本 RFC 交付 core seam/contract test；真实 Job/AppContainer 与 Windows CI 属后续平台 RFC |
| R8 owner migration 直接删 legacy provenance                    | 存量 session 无法 resume            | table rebuild 精确 backfill digest/codec/version，约束与旧库 fixture 必测                   |

自审后仍需用户确认的产品取舍只有两项：macOS lifecycle 为 best-effort，以及
`warn/off` 允许在缺少宿主 secret/network containment 时执行。用户批准 RFC 即批准这两项
显式取舍；若不同意，应在实现前改为更严格的 mode 真值表。
