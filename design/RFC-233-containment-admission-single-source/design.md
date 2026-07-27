# RFC-233 平台隔离准入单一事实源与在线策略一致性 — design

状态：Done（2026-07-27；设计门与实现门均 APPROVED / 0 open P0-P2，待 exact-SHA 远端门禁）。

## 1. 当前事实链

### 1.1 “绿色”不是生产资格

`services/sandbox/probe.ts:40-83` 的 boot cache 只记录：

```ts
interface SandboxStatus {
  mechanism: string | null
  available: boolean
  detail: string | null
}
```

Linux trial 是 `bwrap --bind / / -- /bin/true`。随后
`runtime/opencode/containment.ts:75-99` 仅凭 `mechanism === 'bwrap' && available`
合成：

```text
platformHomeIsolation   strong
immutableArtifactView  strong
modelChildNetworkDeny  strong
descendantLifetimeBound strong
```

真正的 OpenCode admission 却在 `sealedSubprocess.ts:594-695` 额外要求：

- PATH candidate 必须可解析为 canonical absolute path；
- canonical target 是 root-owned regular executable；
- 无 setuid/setgid、无 group/other write、至少一个 execute bit；
- `--die-with-parent --new-session --unshare-net --unshare-pid --unshare-ipc
--unshare-uts --ro-bind / / --proc /proc --dev /dev --clearenv -- /bin/true`
  返回 0；
- bounded supervisor、PGID ownership 与 cleanup 都得到证明。

`verifiedPlanCore.ts:92-98` 在 `admitRuntimeContainment()` 已经返回“可用”后才调用该严格检查。
因此它的失败绕过 `warn` 真值表，直接抛 legacy
`execution-identity-sandbox-required`。现有回归只覆盖
`SandboxStatus.available=false`，没有覆盖“弱探测 true、严格资格 false”。

### 1.2 saved intent 不是 effective policy

`cli/start.ts:210-217` 从启动时 config 构造一次 `SandboxProvider`。
`routes/config.ts:29-98` 的在线 PUT 只原子替换配置文件，没有更新该 provider。
前端 `SandboxCard` 以 `/api/config.sandboxMode` 控制 radio，runner 和 OpenCode core 却以旧
module-global provider 决策。二者都各自“正确读取”了不同事实，所以 cache invalidation
无法修复。

### 1.3 一次 spawn 多次读取全局状态

当前生产读取点至少包括：

- OpenCode verified plan：`runtime/opencode/verifiedPlan.ts:455-462`；
- business runner outer wrapper：`runner.ts:1284-1382`；
- Runtime Test build 与 wrapper：`runtimeSmoke.ts:197-243`；
- memory distiller build 与 wrapper：`memoryDistiller.ts:956-971,1126-1145`；
- status：`routes/runtimes.ts:149-246`；
- task launch preflight：`task.ts:1335-1355`。

OpenCode plan 可能先按 `warn` 选择 child none，runner 随后按另一个时点的 provider 选择 outer；
反向变化同样成立。`SpawnPlan` 只携带 `sandboxTopology` 和 `readOnlySubtrees`
（`runtime/types.ts:128-167`），没有携带权威 admission。

### 1.4 provider 边界仍不完整

`SandboxProvider` 同时暴露 generic status、可选 capability、可选 child plan 和可选 outer
renderer，但 built-in 仍散落在 core 分支：

- generic outer：`sandbox/index.ts:57-84` 按 `mechanism` 选择 renderer；
- OpenCode child：`sealedSubprocess.ts:925-971` 按 `providerId` 分支；
- Linux strict admission：`verifiedPlanCore.ts:95-98`；
- FFF launcher 再 admission：`fffCapability.ts:1033-1067`。

尤其 generic outer 仍执行 PATH 中的字符串 `bwrap`，OpenCode child 执行严格检查得到的 canonical
path；同一 spawn 的两层并不保证是同一个 executable。

## 2. 不变量

1. **事实与策略分离**：provider 只报告资格事实；coordinator 单独把当前 mode 与 requirement
   profile 映射为 decision。
2. **能力不得推断**：core 不得从 OS、mechanism 名称、二进制存在或弱 trial 推断 strong。
3. **一次准入**：每个 spawn 只有一个不可变 admission receipt；所有后续层只消费它。
4. **原子 topology**：required capability 全满足才选择 provider topology；否则 `warn`
   明确选择 none，`enforce` 阻断。
5. **副作用前判定**：provider qualification 与 policy decision 在 runtime 私有 layout、
   binary seal、FFF materialization 和 Bun.spawn 前完成。
6. **不做不确定重试**：一旦包装 spawn 被尝试，不能因 `warn` 再执行 raw argv。
7. **热更新只影响未来**：mode 更新完成前已提交的 admission 保持不变；更新完成后的 admission
   必须看到新 generation。
8. **status 是同源快照**：status 与执行调用同一个 provider qualification；status 的历史绿色
   带 checkedAt，最终安全边界仍是 per-spawn qualification。
9. **安全降级可见**：degraded receipt、结构化日志与 task alert 使用稳定 reason codes，不泄露
   provider 原始输出。
10. **显式依赖**：生产服务通过构造参数获得 coordinator；删除 `get/setSandboxProvider` 的生产
    module-global service locator。

## 3. 领域模型

### 3.1 requirement profile

capability 名称保持开放字符串；内建 profile 由 shared/backend 常量登记：

```ts
interface ContainmentRequirementProfile {
  id: string
  revision: string
  required: readonly string[]
  optional: readonly string[]
  childBoundary: 'none' | 'model-controlled'
}
```

首批 profile：

| profile                | required capability                                                       | optional                  |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------- |
| `runner-filesystem-v1` | `platformHomeIsolation`, `immutableArtifactView`                          | `descendantLifetimeBound` |
| `opencode-verified-v1` | `platformHomeIsolation`, `immutableArtifactView`, `modelChildNetworkDeny` | `descendantLifetimeBound` |

Claude Code 与其它只使用 runner outer 的路径使用 `runner-filesystem-v1`。verified OpenCode
business/system 路径使用 `opencode-verified-v1`。如果未来一个 runtime 能证明不存在
model-controlled child，可选择 filesystem profile；该选择由 runtime driver 从同一个 frozen
spawn descriptor 给出，不由 coordinator 猜 runtime 名称。profile 的 canonical
`requirementDigest` 会进入 admission/manifest，防止 driver 在 admission 后悄悄扩大 child
surface。

### 3.2 provider qualification receipt

```ts
type CapabilityStrength = 'strong' | 'best-effort' | 'absent'
type ContainmentProbeState = 'probing' | 'ready' | 'partial' | 'unavailable'

interface ContainmentProbeReceipt {
  coordinatorBootId: string
  providerId: string | null
  providerRevision: string
  probeGeneration: number
  state: Exclude<ContainmentProbeState, 'probing'>
  capabilities: Readonly<Record<string, CapabilityStrength>>
  qualifiedTopologies: readonly string[]
  reasonCodes: readonly ContainmentReasonCode[]
  checkedAt: number
  evidenceDigest: string
}
```

`evidenceDigest` 只覆盖 canonical、无 secret 的 receipt 字段，不包含原始 stderr、用户路径或
provider 私有配置。`probeGeneration` 是 daemon 内单调递增值；CLI 独立进程不承诺与 daemon
共用 generation。

资格 receipt 不包含 mode、decision 或 runtime 名称。只有 provider 能声明 capability 和
`qualifiedTopologies`；coordinator 只验证 schema、闭集 strength、atomic topology evidence
与 receipt 自洽性。`partial` 表示 provider 只通过一部分 capability/topology，例如 Linux
filesystem outer 可用而 model-child network namespace 不可用；最终能否显示绿色由具体
profile preview 决定。

### 3.3 admission receipt

```ts
type ContainmentDecision = 'contained' | 'degraded' | 'off' | 'blocked'

interface ContainmentAdmissionReceipt {
  coordinatorBootId: string
  admissionGeneration: number
  policyGeneration: number
  probeGeneration: number | null
  providerId: string | null
  profileId: string
  requirementDigest: string
  mode: 'enforce' | 'warn' | 'off'
  decision: ContainmentDecision
  requiredCapabilities: readonly string[]
  capabilities: Readonly<Record<string, CapabilityStrength>>
  reasonCodes: readonly ContainmentReasonCode[]
  admittedAt: number
}
```

receipt 不带 executable path、renderer closure、policy path 或 secret，可以进入 structured
log/status/alert。`coordinatorBootId + generation` 使 daemon 重启后的代际不混淆。
`blocked` receipt 用于 status/preflight 和抛错诊断，不会进入 SpawnPlan。

### 3.4 backend-only prepared plan

```ts
interface PreparedContainmentPlan {
  receipt: ContainmentAdmissionReceipt
  topology: 'none' | 'runner-outer' | 'provider-child-only' | 'runner-outer-and-child'
  childProvider: PreparedChildContainmentPlan
  renderOuter(argv: readonly string[], scope: ContainmentScope): readonly string[]
  attestBootstrap?(input: ProviderBootstrapInput): Promise<void>
}
```

`PreparedChildContainmentPlan` 是 sandbox/provider 域的通用 `{ providerId, config }`
closed schema，不再定义在 OpenCode 模块；OpenCode manifest 只是它的一个消费者。

`PreparedContainmentPlan` 是纯进程内对象，不进入 API/DB。`none` plan 的 renderer 是明确 no-op，child provider 固定
`{ providerId:'none', config:{} }`；不再用 `undefined` 同时表达 tests、off、unavailable
和编程漏接线。

`ContainmentScope` 只包含本次 appHome、task worktrees、run dir、session store 和
read-only subtree。scope 在 driver 产出 artifact 后一次性 seal，runner 不再重建 provider
事实。

## 4. ContainmentProvider contract

```ts
interface ContainmentProvider {
  readonly id: string
  readonly revision: string
  readonly legacyMechanism: string | null

  qualify(input: { signal: AbortSignal; deadlineMs: number }): Promise<ProviderQualification>

  prepare(input: {
    qualification: ProviderQualification
    profile: ContainmentRequirementProfile
  }): PreparedProviderTopology
}
```

`ProviderQualification` 是 `ready/partial/unavailable` discriminated union，可携带
backend-only opaque evidence（例如 canonical bwrap path、完整 ancestor/stat identity 以及
各 atomic topology 的 trial 结果），public receipt 由 provider 同时给出。capability 分项
通过不等于任意组合都安全；`prepare` 只能选择 qualification 明确列出的 atomic topology。
它必须同步、无 IO、无副作用，只能把刚才的 opaque evidence 转成 topology。schema
不自洽、renderer 缺失或 provider throw 都由 coordinator 归一为稳定 `provider-contract-invalid`/
`provider-internal-error`：

- `enforce` → blocked；
- `warn` → degraded none；
- `off` → provider 根本不被调用。

core 不再有 `if (providerId === 'linux-bwrap')` 或 `if (process.platform === ...)`。
platform 选择只存在于 daemon composition root 的 provider registry。registry 只接受随可信
发行物编译/注册的 provider descriptor；它同时拥有 qualification、outer renderer、
child-config schema 与 hidden-launcher renderer。它不是用户可注入代码面。future Windows
provider 注册完整 descriptor 后，无需修改 OpenCode admission。

### 4.1 LinuxBwrapContainmentProvider

把当前 `requireRootOwnedBwrap()` 的证明提升为 Linux provider 唯一资格实现，但不再用一个
最大化 trial 把所有 capability 同时折成 available/unavailable：

1. `Bun.which('bwrap')` 仅作为 candidate discovery；
2. realpath/lstat/stat 检查 canonical regular root-owned executable 与安全 mode，并逐级检查
   canonical parent chain 到 `/` 都是 root-owned、非 group/other writable directory；否则
   同 UID 可在 admission 后替换路径；
3. 分别执行 filesystem outer trial 与包含 network/PID/IPC/UTS/control 的 full OpenCode
   atomic-topology trial，二者都 bounded 且证明 supervisor/PGID cleanup；
4. filesystem 通过、full trial 失败时返回 partial：filesystem capabilities 可为 strong，
   `modelChildNetworkDeny` 为 absent，不能把 Claude 等 filesystem profile 一并误杀；
5. 只有 full trial 通过才登记 `linux-outer-and-child-v1` atomic topology；
6. canonical path、每级 stat identity 和 topology evidence 保存在 opaque qualification；
7. outer renderer 和 OpenCode child plan 都只使用该 canonical path。

原 `probeSandboxMechanism()` 的 `--bind / /` 结果不再参与 readiness，可保留为
`discoveryHint` 帮助区分“未安装”与“内核/容器策略拒绝”，但不能产生 capability。

稳定 reason code 至少包括：

```text
platform-unsupported
provider-not-found
provider-path-not-canonical
provider-owner-unsafe
provider-mode-unsafe
provider-parent-unsafe
provider-trial-rejected
provider-trial-timeout
provider-lifecycle-unproven
provider-contract-invalid
provider-internal-error
required-capability-missing
```

raw errno/stdout/stderr 只进受控 debug log，且需经过长度和 secret scrub；API 使用本地化的安全
说明。

### 4.2 MacSeatbeltContainmentProvider

Seatbelt provider 同样拥有 canonical executable/profile acceptance qualification 与能力声明，
不再由 generic probe 的 `(allow default)` 直接推导 strong。它根据 profile 的
`childBoundary` 返回 RFC-227 T14 topology：

- model-controlled child 存在：`provider-child-only`；
- 不存在：`runner-outer`。

`descendantLifetimeBound=best-effort` 仍是 optional，不阻断 baseline。provider contract test
和真实 macOS integration 必须证明不会生成嵌套 `sandbox-exec`。

### 4.3 FFF 的边界

Linux FFF 仍是 verified OpenCode server 启动前对实际 child boundary 的 attestation，不能删除。
但它不再是第二个策略 oracle：

- private manifest 消费 admission 选出的 canonical path、完整 expected path/stat identity 与
  provider evidence digest；public receipt 的 digest 只用于关联，安全校验依赖 private
  provider evidence；
- launcher 验证 prepared path/ancestor/stat identity 后运行 FFF；
- drift 或 FFF 失败统一为 `execution-identity-bootstrap-failed`；
- launcher 不再抛 `execution-identity-*-containment-required`，也不根据当前 mode 改 topology。

root/admin 在 admission 后替换系统 executable 属于 post-admission privileged drift；同 UID
攻击者不能修改 root-owned safe-mode target。该 drift 必须失败关闭，不能在 `warn` 下裸跑。

`VerifiedLaunchManifest` codec 升级，并在 hidden-launcher schema 中验证跨字段不变量：

- receipt `decision=contained`、profile/requirement digest 与 child provider/topology 一致；
- `degraded/off` 只允许 child provider none，且不允许 FFF artifact；
- `blocked` 永远不能进入 manifest；
- 只有 admission 选中的 Linux child topology 才必须且只能携带 FFF；
- child config 必须由同一 trusted provider descriptor 的 closed schema 重验。

不能只相信 parent 进程已经做过 coordinator validation。

## 5. ContainmentCoordinator

daemon 启动时构造一个 coordinator，并通过明确依赖传给 server、scheduler/runner、Runtime
Test 和 distiller。它拥有：

- provider registry 中本平台的 provider；
- 每次 daemon 启动生成的非敏感 `coordinatorBootId`；
- `effectiveMode` 与单调 `policyGeneration`；
- 最后一次精确 probe snapshot；
- in-flight qualification single-flight；
- 单调 `probeGeneration` / `admissionGeneration`。

不再导出可被业务代码任意读写的 `getSandboxProvider()` / `setSandboxProvider()`。
启动时的 exact probe 无论成功或失败都只更新 snapshot，绝不阻断 daemon/server 启动；
`enforce` 的阻断发生在 task preview/final spawn admission，Settings 始终可达。

### 5.1 exact probe single-flight

安全 admission 的 `refreshProbe()` 每次新的调用波次都执行精确资格；只合并仍在运行的并发
请求，不设置跨波次安全 TTL。这样：

- 并发 fanout 的首批 spawn 不重复启动几十个 capability supervisor；
- 后续 spawn 仍会重新观察 sysctl/container/provider drift；
- status refresh 与同时发生的 spawn 可共享同一个 in-flight proof；
- admission 完成的 probe receipt 会原子替换 last public snapshot。

qualification 有固定上限、生命周期清理和 daemon shutdown signal。单个 waiter 取消只停止等待，
不能取消仍被其它 waiter 使用的 shared probe；底层 probe 自身始终在 deadline 内收口。

高频只读 status poll 不成为安全边界：它返回 last exact snapshot，并可在一个短、明确的
observability max-age 内复用；超过 max-age 时触发/等待同一个 exact single-flight。无论 status
缓存多新，per-spawn admission 都不使用该 TTL。`off` admission 本身零 probe；管理员显式点击
“重新检查”或调用 CLI 时仍可执行诊断 probe，但必须标为 diagnostic，不改变 mode/plan。

### 5.2 admission 算法与线性化

```text
admit(profile):
  if current effectiveMode == off:
    synchronously commit off receipt + none plan
    return

  qualification = await refreshProbeSingleFlight()

  // 线性化点：无 await 地重新读取当前 mode/policyGeneration，
  // 校验 qualification，生成 receipt 和 plan。
  mode = effectiveMode
  generation = policyGeneration

  if mode == off:
    commit off receipt + none plan
  else if qualification satisfies every required capability strongly:
    commit contained receipt + provider atomic topology
  else if mode == warn:
    commit degraded receipt + none plan
  else:
    commit blocked receipt; throw containment-required
```

mode 在异步 probe 期间变化时，先完成的 config update 会被此次 admission 看见。receipt
一旦 commit，后续 mode 更新不追改它。

`prepare()` 输出还要经 coordinator schema/一致性验证：providerId、opaque evidence、
capabilities、topology 和 renderer 必须来自同一 qualification；验证失败按 provider
unavailable 进入同一真值表。

### 5.3 online config update

`ContainmentCoordinator.setMode(next)` 是同步、无失败的操作；只有 `next !== effectiveMode`
时才更新 mode 并递增 generation，无关 config PUT 不制造虚假 policy 代际。
`PUT /api/config` 在所有异步 validation 完成后：

1. 同步 `applyConfigPatch()` 原子替换文件；
2. 同一 JS turn、无 `await` 地调用 `coordinator.setMode(updated.sandboxMode)`；
3. 返回 response。

若文件写失败，内存不变；`setMode` 不做 IO，因此文件已成功而内存更新失败没有合法分支。响应完成
后的新 admission 必然看到新 mode。GET status 返回：

```ts
{
  configuredMode,
  effectiveMode,
  policyGeneration,
  restartRequired: configuredMode !== effectiveMode,
  probe: { state, providerId, capabilities, reasonCodes, checkedAt, probeGeneration },
  preview: { profileId, decision, reasonCodes }
}
```

正常 Settings PUT 后两者相等、`restartRequired=false`。离线 CLI 直接写文件时，若 daemon 正在
运行则 CLI 明示需要重启；status 诚实显示 mismatch。Settings 在 mismatch 下以
`effectiveMode` 控制 radio，另显 `configuredMode`，并提供“立即应用 configured mode”按钮；
该按钮即使配置文件值未变化也调用 PUT，使 coordinator 收敛到 desired value。

## 6. admitted-spawn 装配

### 6.1 RuntimeDriver 扩展

driver 先从本次已冻结的执行输入生成无副作用 `RuntimeSpawnDescriptor`：

```ts
interface RuntimeSpawnDescriptor {
  containmentProfile: ContainmentRequirementProfile
  containmentDemandDigest: string
  // driver-private frozen assembly inputs
}
```

descriptor 明确记录是否会暴露 model-controlled shell/local MCP 等 child surface。driver
materialization 不得新增 descriptor 未声明的 child；最终 SpawnPlan/manifest 必须回显并匹配
`containmentDemandDigest`。业务、smoke 和 distiller 共用一个 `buildAdmittedSpawn()`：

```text
descriptor = driver.describeSpawn(ctx)
prepared = await coordinator.admit(descriptor.profile + demandDigest)  // runtime FS 副作用前
plan = await driver.materializeSpawn(descriptor + prepared)             // child 消费同一 plan
return sealSpawnContainment(plan, prepared, descriptor, scope)
```

OpenCode verified builder 不再调用 `admitRuntimeContainment()` 或
`requireRootOwnedBwrap()`；只从 `prepared.childProvider` 构建 manifest/FFF artifact。
Claude Code 无 child renderer，但 outer 仍来自同一个 prepared plan。

`sealSpawnContainment` 重验 descriptor demand、receipt requirement digest、child provider、
topology 和最终 scope；任何不一致均在 spawn 前归为 bootstrap failure。`SpawnPlan` 新增
mandatory-in-production 的 backend-only `containment` 字段，取代
`sandboxTopology` / `readOnlySubtrees` 与 runner-global provider 的松散组合。测试可显式注入
test coordinator；production guard 要求所有 model-controlled spawn 都带 admission，不允许
用 `undefined` 静默裸跑。

admission receipt 是本次进程的**易变运行事实**，不得进入持久 OpenCode
`identityDigest`、`sessionContractDigest` 或 session-owner equality。否则
policy/probe generation、mode 或 daemon boot id 一变，合法 resume 就会被误判
`session-mismatch`。每次 new/resume process 都重新 admission，并把本次 receipt 放进 private
launch manifest；binary/config/source/model/session identity 继续按 RFC-224 独立冻结。

### 6.2 runner

runner 的最后一刻包装原则保留，但输入改为：

```text
spawnCmd = plan.containment.renderOuter(plan.cmd, sealedScope)
```

runner 不再：

- 调用 `getSandboxProvider()`；
- 重算 enforce block；
- 按 status/mechanism 选择 renderer；
- 从 diagnostics 字符串反推 degraded；
- 独立决定 topology。

它只根据同一 receipt：

- `blocked` 不可能进入 runner（装配已失败）；
- `degraded` 创建/去重 task alert；
- `contained/off/degraded` 写结构化 spawn log；
- 调用 receipt 已选 renderer。

`opts.sandbox` 的旧测试旁路迁移为显式 fake coordinator/prepared plan，避免测试绿而生产判据零覆盖。

### 6.3 Runtime Test、distiller 与 task preflight

- Runtime Test 和 distiller 必须调用同一个 `buildAdmittedSpawn()`，不再 build 前后各读一次
  provider。
- task launch preflight 不能保留在当前 `startTask()` 读取 workflow 之前的位置，因为那里尚不
  知道实际 runtime/profile。它移到 workflow snapshot + effective runtime policy closure
  解析之后，复用将被 dispatcher 冻结的 canonical runtime-resolution helper，对本次定义中
  去重后的全部 profile 调用 fresh preview；不得另写一套 default/override 推导。
  multipart/pre-created
  ownership try 仍包住它，失败必须清理已物化 workspace。它只为用户提供早期 409，不是安全
  边界；最终 spawn admission 必须重新 qualification。
- launch/resume/retry/boot auto-resume 都经 runner 的 admitted-spawn 装配，不能旁路。

## 7. status、wire 与失败码

### 7.1 shared schema

新增 additive schema：

- `ContainmentProbeReceiptSchema`；
- `ContainmentAdmissionReceiptSchema` 的 public projection；
- `configuredMode/effectiveMode/policyGeneration/restartRequired`；
- `probe.state/probeGeneration/checkedAt/reasonCodes`；
- profile preview decision。

旧 `SandboxStatus.mode/available/mechanism` 和旧 runtime containment shape 保留一轮，由新 snapshot
派生：

- legacy `mode = effectiveMode`；
- legacy `available = probe.state === 'ready'`；
- legacy `mechanism = provider.legacyMechanism`，内建继续精确返回 `bwrap`/`seatbelt`，不拿
  `linux-bwrap`/`macos-seatbelt` providerId 冒充旧 wire。

新前端不得再用 `/api/config` 的 saved intent 冒充 effective mode。

### 7.2 failure taxonomy

在 `EXECUTION_IDENTITY_FAILURE_CODES` 增加：

```text
execution-identity-containment-required
```

新生产 admission 只写该 code。旧
`execution-identity-sandbox-required` 继续留在 closed vocabulary、i18n 和历史解析器中，
但加 source guard，禁止 production throw site 新增或保留。provider post-admission/FFF/spawn
失败使用 `execution-identity-bootstrap-failed`，与“策略要求但资格不满足”分开。

### 7.3 observability

每次 spawn 日志记录：

```text
containmentProfile
containmentDecision
containmentProviderId
containmentPolicyGeneration
containmentProbeGeneration
containmentAdmissionGeneration
containmentReasonCodes
containmentTopology
```

不记录 executable path、原始 provider detail、env 或 policy 内容。`warn/degraded` 继续使用
每 task 一个 open `sandbox-degraded` alert，detail 改为 receipt 的安全 projection；每个 spawn
仍有独立结构化日志，避免 alert dedupe 丢失代际证据。

## 8. 失败模式

| 失败点                                    | `enforce`                            | `warn`                               | `off`            |
| ----------------------------------------- | ------------------------------------ | ------------------------------------ | ---------------- |
| provider 未注册/平台不支持                | pre-spawn containment-required       | pre-spawn degraded none + alert      | 不探测           |
| bwrap 不存在/owner/mode 不安全            | pre-spawn containment-required       | pre-spawn degraded none + alert      | 不探测           |
| namespace trial 非零/超时/cleanup 未证明  | pre-spawn containment-required       | pre-spawn degraded none + alert      | 不探测           |
| provider schema/renderer 自相矛盾         | pre-spawn containment-required       | pre-spawn degraded none + alert      | 不调用           |
| config file write 失败                    | old effective mode 保持              | old effective mode 保持              | 同左             |
| mode 在 probe 中切换                      | receipt commit 时读取最新 generation | receipt commit 时读取最新 generation | 同左             |
| runtime layout/binary/source/session 失败 | 原 execution-identity code           | 原 execution-identity code           | 原 code          |
| FFF/prepared evidence 在 admission 后漂移 | bootstrap-failed，不重试             | bootstrap-failed，不裸跑重试         | 无 FFF           |
| 包装 argv 的 Bun.spawn 抛错/结果不确定    | bootstrap-failed                     | bootstrap-failed，不裸跑重试         | 原 spawn failure |
| alert 写入失败                            | 不影响原 decision，记录 warn log     | 不影响执行，记录 warn log            | n/a              |

## 9. 测试策略

### 9.1 先红回归

先增加能稳定复现本次事故的测试：

```text
effectiveMode=warn
weakDiscovery.available=true
exactProviderQualification=provider-owner-unsafe / provider-trial-rejected
```

旧实现会抛 `execution-identity-sandbox-required`；新实现必须返回
`decision=degraded, topology=none, childProvider=none`，继续构建/执行并只产生一个 open alert。
测试注释必须写明 RFC-233 与事故形态。

### 9.2 pure/coordinator matrix

- mode × probe state × required/optional capability 全矩阵；
- filesystem trial strong + full OpenCode trial red 时，filesystem profile contained 而
  OpenCode profile degraded/blocked；
- off 零 `qualify()` 调用；
- warn 任一 required 非 strong → atomic none；
- enforce 任一 required 非 strong → blocked；
- provider malformed/throw 的归一化；
- reason code 排序/dedupe/evidence digest 稳定；
- concurrent callers single-flight；
- sequential admission 重新 probe；
- probe 中 mode 热切换、receipt 后 mode 热切换的线性化；
- coordinator boot id/generation 不进入 persistent session identity，跨 daemon resume 重新
  admission 但保持原 session identity；
- waiter abort 与 daemon shutdown 的 bounded cleanup；
- post-spawn failure 没有 raw retry。

### 9.3 provider contract

Linux injected tests覆盖：

- not found / relative / symlink drift / non-regular；
- uid 非 0；
- 任一 canonical ancestor 非 root-owned 或 group/other writable；
- setuid/setgid、group/other writable、不可执行；
- full namespace exit 非 0、timeout；
- supervisor/PGID cleanup 未证明；
- outer 与 child 精确使用同一 canonical path；
- weak discovery pass 不影响 exact receipt。

macOS injected tests覆盖 profile→topology，不允许嵌套 Seatbelt。
custom fake trusted provider 证明 OpenCode core 无 providerId/platform 分支；未登记/用户输入的
providerId/config 不能进入 hidden renderer。manifest codec tests 穷尽
decision/profile-demand/topology/child/FFF 的非法笛卡尔组合。

### 9.4 wiring

- Settings PUT `enforce→warn→off→enforce` 无重启，config/effective generation 一致；
- 文件写失败不改变 effective mode；
- 离线 config mismatch 的 status/UI；
- business launch/resume/retry/auto-resume；
- Runtime Test 与 memory distiller；
- mixed-runtime workflow preflight 在 workflow/runtime closure 解析后 preview 全部 distinct
  profile，且与 dispatcher 复用同一 resolver；cleanup ownership 不回归；最终 admission
  仍执行；
- 一个 SpawnPlan 从 build 到 runner 始终是同一 admission object；
- source guard 禁止生产 `getSandboxProvider`、built-in mechanism branch 和 legacy failure writer。

### 9.5 status/UI/CLI

- status green 只由 exact provider receipt 产生；
- probing/unavailable/ready、checkedAt、reason localization；
- warn unavailable 显示降级不阻断，enforce unavailable 显示阻断；
- radio 使用 effective mode，configured/effective mismatch 明示；
- CLI sandbox/doctor 与 API 对相同 injected/real provider 得到同 reason code；
- CLI 不改 config/app data。

### 9.6 real integration

- Linux hosted runner 执行 root-owned bwrap/full namespace/lifecycle qualification，并验证实际
  outer+child topology；
- Linux 通过 fake PATH 或 provider seam 制造“弱 trial pass、strict qualification fail”，
  验证 warn 真执行、enforce 真阻断；
- macOS gated Seatbelt 单层 topology、secret deny、worktree allow、seal write deny、child
  network deny；
- production binary smoke 中运行 sandbox/status CLI，证明 bundled module graph 无循环。

### 9.7 全量门禁

```text
bun run typecheck
bun run lint
bun run test
bun run format:check
bun run depcheck
bun run build:binary
```

再执行相关 frontend package tests、Playwright Settings 流与 Linux/macOS capability integration。
环境 gate/skip 必须单列，不能把 injected green 冒充真实 provider green。

## 10. 实施与回滚

单 RFC、单 PR，按可编译批次推进但不发布中间的双事实状态：

1. shared receipt/reason/failure schema + provider/coordinator 与红回归；
2. built-in providers 迁移精确 qualification/renderer；
3. admitted-spawn 装配接 business/smoke/distiller，迁移 OpenCode child/FFF；
4. config hot update、status/UI/CLI；
5. 删除 module-global provider、弱 readiness 和 legacy production failure writers；
6. integration/full gates/实现门。

如果实现需要回滚，必须整体回到旧版本；不能只回滚 coordinator 而保留新 SpawnPlan，或只回滚
provider 而保留新绿色语义。配置文件 schema 不变，因此整体代码回滚不需要数据回滚。

## 11. 设计裁决

- **D1**：选择 daemon-scoped coordinator + explicit dependency injection，不在旧 global getter
  上继续加锁或 setter。
- **D2**：选择 provider-owned capability/atomic-topology qualification，不让 generic core
  从 mechanism 推能力，也不让一个最大化 trial 误杀较弱 profile。
- **D3**：选择 required capability 原子 topology；warn baseline 不完整时明确 none，不保留
  outer/child 混合半隔离。
- **D4**：选择 per-spawn fresh qualification + concurrent single-flight，不以 boot cache 作为
  安全边界。
- **D5**：选择 receipt commit 时读取最新 policy generation；不追改已提交 receipt。
- **D6**：选择 Settings/API 热更新，离线 CLI 明示 next-boot；不引入 config file watcher。
- **D7**：保留 FFF 作为 bootstrap attestation，但取消其第二次策略 admission 身份。
- **D8**：warn 不对已尝试 spawn 做 raw fallback，避免重复副作用。
- **D9**：新写 `execution-identity-containment-required`，旧 sandbox code 只读兼容。
- **D10**：零 DB migration；逐 spawn receipt 进结构化日志，degraded projection 进现有 task alert。
- **D11**：trusted provider descriptor 随发行物注册；generic child plan 移出 OpenCode 域，
  hidden manifest 对 receipt/topology/child/FFF 再做 closed cross-field validation。
- **D12**：provider executable 的安全身份包含整条 canonical ancestor chain；只检查 target
  owner/mode 不足以支撑 admission→spawn 的同 UID 稳定性。
- **D13**：admission receipt 不进入持久 session identity；resume 的身份连续性与每次进程的
  containment policy 独立，后者始终重新准入。
