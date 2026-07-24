# RFC-227 OpenCode 版本无关与跨平台能力准入 — proposal

状态：Done（2026-07-24；用户以“ok”批准；实现、门禁与本地实现门完成，随后授权提交/推送）。

## 1. 背景与现状证据

OpenCode 当前存在两套互相冲突的合同：

1. RFC-112 的运行时注册表允许管理员登记遵循 OpenCode 协议的自定义 binary / fork，
   兼容性由深度冒烟证明，明确不依赖版本号；
2. RFC-224 为修复执行身份与配置漂移问题，把生产路径收紧为官方 OpenCode
   `1.18.3` 的 OS/arch exact-hash allowlist，并进一步把 verified execution 固定为
   Linux `sandboxMode=enforce + bwrap`；
3. 通用 `probeOpencode()` 表面上只声明最低版本且无上限，但 status、models、smoke、
   business/system execution 会先进入 RFC-224 exact snapshot，所以小于或大于
   `1.18.3` 的 executable 都会在真实能力检查之前被拒；
4. `/api/runtimes/status` 只返回粗粒度 `ok`，首页把所有 `ok=false` 统一渲染成
   “OpenCode 未找到”。因此“binary 不存在”“版本未在 allowlist”“协议不兼容”和
   “隔离能力不足”在 UI 中被错误合并；
5. 通用 RFC-205 sandbox 已有 macOS Seatbelt 与 Linux bwrap 两个 provider，
   但 RFC-224 的 verified plan、FFF probe、launcher/control marker、session owner
   与 recovery 又直接写入了 `platform === linux`、`bwrapPath`、
   `PINNED_OPENCODE_VERSION` 和 `officialBuildDigest`，所以只删最外层判断并不能恢复
   macOS 执行。

本机安装的 OpenCode `1.18.4` 因 bytes 不属于唯一的 `1.18.3` allowlist 而被报告为
“未找到”，这不是已证实的协议不兼容，而是平台自己设置的静态版本/供应链策略。

## 2. 目标

1. **版本无关**：OpenCode 的 reported version 只用于展示和诊断，不作为最低版本、
   最高版本、精确版本或 semver range 的执行门。
2. **行为准入**：能否执行由当前 binary 的实际 OpenCode 协议能力、same-instance
   identity attestation 与所选隔离策略决定；较旧、较新、改名 binary 或自定义 fork
   只要行为合同满足就可以运行。
3. **执行身份不退化**：继续把实际 executable 复制到 per-run seal、复算 SHA-256，
   server 只执行 seal 内副本；摘要用于冻结与 TOCTOU 防护，但不再冒充“官方来源证明”。
4. **跨平台核心**：verified OpenCode core 不出现 Linux-only admission；只依赖
   `RuntimeContainmentProvider` 声明的能力。Linux 与 macOS 在本 RFC 中成为真实执行
   路径，Windows 可在未来接入同一接口，不需要再次改 OpenCode identity core。
5. **恢复 RFC-205 策略语义**：`enforce` 要求当前 provider 满足基线能力；
   `warn` 在能力不足时允许执行并产生持久、可见的 degraded 告警；`off` 是管理员显式
   选择不使用 OS containment。OpenCode 不再偷偷把三种模式都覆盖成 Linux enforce。
6. **准确状态**：前后端区分 binary missing、不可启动、尚未做协议测试、协议不兼容、
   containment blocked、degraded 与 ready，只有真实路径不存在时才显示“未找到”。

## 3. 非目标

- 不承诺任意 OpenCode 版本必然兼容。若 executable 缺少必需 endpoint、请求/事件语义
  或安全关键字段，仍以稳定 `protocol-incompatible` 失败；区别是结论来自行为，不来自
  版本字符串。
- 不把 `--version`、文件名或 SHA-256 解释为官方签名。管理员选择的 runtime binary
  属于本机 TCB；平台只证明“执行的是已冻结的这些 bytes”。
- 不放宽 RFC-224 的 config/agent/model/MCP/source/session same-instance 比较、私有
  store、lease、SSE/message provenance 或失败后不自动 retry 的规则。
- 不自动下载、升级或替换 OpenCode，不联网维护“最新版本哈希表”。
- 不在本 RFC 中完成 agent-workflow 的完整 Windows 产品移植。Windows 当前仍是产品级
  future work；本 RFC 的硬要求是 OpenCode core 与 schema 不再写死 POSIX/Linux，
  并以注入的 Windows provider contract 测试证明未来无需改 identity core。
- 不声称 macOS Seatbelt 拥有 Linux private PID namespace 的同级后代回收保证。能力差异
  必须被 API/UI/运行记录如实呈现，不能伪装成完全等价。

## 4. 产品合同

### 4.1 Binary 与版本

- 管理员选择的 runtime command 在每次显式 status/Test/models/执行时重新 resolve；
  binary 缺失与不可执行分别返回稳定状态；
- parent 在 server 启动前对 resolved executable 做 no-symlink snapshot 和 copy 后
  re-hash，server/launcher 只接收 seal path；
- `reportedVersion: string | null` 是有界、非敏感 telemetry。它可以是旧版本、新版本、
  非 semver 或无法读取；任何比较函数都不得把它用于 admission；
- authoritative runtime identity 是
  `{ binaryDigest, protocolCodec, identityDigest, sessionContractDigest }`，不再是
  `{ officialBuildDigest, version === "1.18.3" }`；
- runtime 路径上的 bytes 发生变化时，旧 probe receipt 立即失效；新 run 使用新摘要并
  重做能力准入。resume 只允许与 session owner 已冻结摘要一致的 binary。

### 4.2 协议能力

- 平台维护按**行为合同**编号的 codec（首个为 `opencode-direct-v1`），codec 不映射到
  OpenCode 版本；
- non-model qualifier 使用 seal 后 binary 启动临时 `serve` instance，验证必需
  endpoint、请求/响应 JSON、session id、config/agent/skill inventory 与可控退出；
- full Test 和真实执行继续在同一 server instance 上做 config/agent/model/MCP/session
  attestation，并在第一个模型请求前失败；
- 新增无安全含义字段可以由 codec 明确容忍；会扩大 plugin/tool/MCP/config/model/session
  执行面的未知字段必须 fail closed。兼容性不能通过全局 `.passthrough()` 获得；
- fake binary 即使打印 `1.18.3` 也不能通过协议 qualifier；相反，`1.18.4`、旧版本或
  custom version 只要行为满足就不会因版本号被拒。

### 4.3 平台与隔离

verified core 只请求能力，不读取 `process.platform`：

| Provider                                           | 本 RFC 交付         | 基线隔离                                                         | 强后代生命周期                              |
| -------------------------------------------------- | ------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Linux bwrap                                        | 是                  | appHome 隐藏、seal 只读、inner shell/MCP 无网络                  | private PID namespace，强                   |
| macOS Seatbelt                                     | 是                  | appHome deny/allow-back、seal 只读、inner shell/MCP 更窄 profile | process group best-effort，无 PID namespace |
| Windows Job Object + restricted token/AppContainer | 否，future provider | 接口已定义并有 contract test                                     | 目标为 Job kill-on-close                    |

基线能力为 `platformHomeIsolation`、`immutableArtifactView` 和
`modelChildNetworkDeny`。`enforce` 缺任一基线时 fail closed；Linux 和 macOS provider
通过各自真实 probe 后都可满足基线。`descendantLifetimeBound` 是独立能力：
Linux 为 strong，macOS 为 best-effort，状态与运行记录必须显示差异。

`warn` 下 provider 缺失或缺基线仍可启动，但必须在任务、runtime status 与 Settings
产生 `sandbox-degraded`；`off` 不包装且明确显示“管理员已关闭”。这些策略在
business、system、memory distill、runtime smoke 和 resume 上完全一致。
`warn` 的 degraded 分支与 `off` **不提供** RFC-224 的宿主 secret / 模型子进程网络
containment 保证；告警必须明确写出这一点，不能只显示泛化黄色图标。

### 4.4 状态与错误呈现

runtime status 增加结构化 `state`：

- `not-found`：command 无法 resolve；
- `unlaunchable`：存在但无法执行/快照；
- `available-unverified`：binary 可启动，仅完成轻量 probe，尚未完成协议 Test；
- `protocol-incompatible`：行为 qualifier 失败；
- `containment-blocked`：`enforce` 所需 provider 能力不足；
- `degraded`：`warn` 下允许运行但隔离能力不足；
- `ready`：binary、protocol 与当前 containment policy 均通过。

`ok` 暂时保留作 wire compatibility，由 `ready` 或策略允许的 `degraded` 投影得到；
新 UI 只读 `state`。reported version 可以同时展示，但不参与颜色或按钮 enablement。
任何非 `not-found` 状态都不得渲染成“未找到”。

### 4.5 安全取舍

RFC-224 的 official-only 与 Linux-only 条款被本 RFC supersede，以下保证继续保留：

- binary snapshot/digest、只读 seal 与 launch 前复验；
- hermetic config/source、selected agent/model/MCP exact identity；
- same-instance direct API、SSE/message/session provenance；
- session owner/lease、私有 store、取消/超时有界；
- identity failure 不进入普通 retry/followup。

变化是：binary 来源信任回到 admin-managed runtime TCB；containment 从“一种 Linux
机制”改为可审计的 provider capability receipt。macOS 的后代生命周期能力弱于 Linux，
但文件/密钥/只读 artifact/模型子进程网络基线仍必须由真实 Seatbelt probe 证明。
当管理员选择 `warn` 降级或 `off` 时，只保留 bytes/config/session identity，宿主
secret 与 child network 隔离不再成立；这是显式策略取舍，不得在文档或 UI 中称为安全执行。

## 5. 用户故事

1. 本机 OpenCode 从 `1.18.3` 升级到 `1.18.4` 后，runtime 不再显示“未找到”；Test
   按实际协议行为给出 ready 或具体不兼容点。
2. 管理员登记一个改名且使用自定义版本字符串的 OpenCode fork；其 direct API 合同满足时
   可以被 business/system/smoke 共用，版本字符串不会阻断。
3. macOS 用户使用可用 Seatbelt 时可以执行 OpenCode；Settings 明示 Seatbelt 基线已生效、
   后代生命周期为 best-effort，而不是提示“只能在 Linux/虚拟机运行”。
4. Linux 主机缺少/禁用 bwrap 且配置为默认 `warn` 时，OpenCode 可以降级运行并持续告警；
   配置为 `enforce` 时才以 containment blocked 拒绝。
5. 未来 Windows provider 接入 Job Object/AppContainer 时，只注册 provider 与 renderer，
   不修改 OpenCode version、manifest、session 或 identity 业务逻辑。

## 6. 验收标准

- **AC-1 版本零门禁**：`0.9.0`、`1.18.3`、`1.18.4`、`999.0.0`、非 semver 与
  `--version` 失败 fixture，在协议行为相同的前提下得到相同 admission；源码生产路径
  不存在 `MIN_OPENCODE_VERSION`、`PINNED_OPENCODE_VERSION`、semver compare 或单版本
  allowlist。
- **AC-2 行为判定**：错误 endpoint/schema/session/event 的 binary 即使报告
  `1.18.3` 也以稳定 `execution-identity-protocol-incompatible` 失败；错误发生在首个
  模型请求前。
- **AC-3 bytes 冻结**：path resolve、snapshot、copy re-hash、launch re-hash 与
  runtime mutation race 均有变异测试；实际 server 只能执行 manifest 记录摘要的副本。
- **AC-4 resume/recovery**：owner row 持久化 binary digest + protocol codec；旧
  RFC-224 owner 正确 backfill；resume digest/codec 不同 fail closed，recovery 不再查询
  当前平台的 `1.18.3` 哈希。
- **AC-5 跨平台 core**：verified core、manifest、control protocol、status schema 与
  recovery 不含 `platform !== "linux"` 或 `bwrapPath` 必填合同；Linux/macOS provider
  均通过 contract test，注入 `win32` provider 也能走完整纯逻辑 admission。
- **AC-6 策略语义**：`enforce/warn/off × provider ready/missing/partial` 真值表逐格有测试；
  warn 的 degraded 告警覆盖 launch/resume/system/distill/smoke，off 不伪装成安全。
- **AC-7 macOS 实证**：gated real Seatbelt 测试证明 appHome secret 不可读、worktree
  可用、seal 不可写、inner shell/MCP 网络被拒；模型执行不再因 OS 名称直接失败。
- **AC-8 Linux 实证**：现有 real bwrap capability、FFF 与 orphan probe 保留；适配为
  provider receipt 后仍证明 private PID/network/mount 与 bounded reap。
- **AC-9 准确 UI**：status/Test/首页/Settings 对七种状态有中英对称测试；
  `ok=false` 不再统一落到“未找到”，版本只作中性 telemetry。
- **AC-10 Windows 可扩展性**：provider id/capability 使用开放 string/schema，而非
  `seatbelt|bwrap` 闭集；Windows path/executable/process renderer 由 provider 所有，
  OpenCode core 无 POSIX path/mode/signal 假设的源码守卫。
- **AC-11 全入口与门禁**：business/system/memory distill/runtime smoke/models/status
  无 raw binary bypass；typecheck、lint、format、depcheck、backend/shared/frontend
  全量测试、binary smoke、Linux/macOS integration 与实现门全绿。

## 7. 兼容、迁移与回滚

- status API 是 additive wire change，旧 `ok/version/failureCode` 暂留；新 client 使用
  `state/reportedVersion/protocolCodec/containment`。
- `opencode_session_owners` 以新 migration 把 legacy `official_build_digest` 重命名为
  `runtime_binary_digest`，把 `opencode_version` 改为 nullable `reported_version`，
  并新增 `protocol_codec`；已有 `1.18.3` 行 backfill 为
  `opencode-direct-v1`，无需丢弃 session。
- 本 RFC 实现前不修改现有任务或 runtime row。实现发布后，已有 runtime 的 cached probe
  receipt 失效并在下次 status/Test 重建。
- 回滚到 RFC-224 代码会重新拒绝非 `1.18.3`/非 Linux 执行；数据库 migration 必须提供
  明确 downgrade 或让旧 binary 拒启而非误读新 provenance。
