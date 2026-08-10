# RFC-276 · 运行期安全加固废弃化与自然执行恢复

状态：In Progress（2026-08-10 实现与本地门禁完成，等待发布 CI）

## 1. 背景

本 RFC 由用户在 2026-08-10 直接发起：系统内的运行期安全加固已多次造成生产能力回退，
要求识别并清理这条加固链，让 runtime 恢复自然执行。

这不是抽象担忧。仓库自己的
[`RFC-224 能力回退全面审计`](../RFC-224-opencode-execution-identity/capability-regression-audit-2026-08-04.md)
记录了六件已证实事故：

1. 用三条错误或误读的上游行为断言关闭 RFC-022 / RFC-031 已交付能力；
2. 静默切断自定义 baseURL / OpenAI-compatible 私有网关，生产全部失败；
3. 内置 skill 只认一个正文 digest，OpenCode 1.18.8 更新后每次运行必挂；
4. 落地当天钉死 OpenCode 版本、同日又撤销；
5. 原生 `opencode auth login` API key 一度不被接受；
6. attestation 证明链成本高但没有证明到承诺的边界，后来整层移除。

同一审计还记录了 16 条收尾修复。继续在 verified / hermetic / containment 链上逐洞打补丁，
已经不能给出可接受的维护成本与可用性。

当前生产路径同时叠加：

- OS sandbox / containment provider 与 enforce / warn / off 准入；
- OpenCode verified launcher、binary/source/config/store/session identity；
- HOME/XDG/private store 重定向与受控 env；
- local MCP / shell / script 的 netless wrapper；
- system / intent / Claude 的平台强制 tool profile；
- 对应 config、CLI、status API、Settings UI、告警、错误码、DB provenance 与大量测试。

这些机制互相引用，不能靠把 `sandboxMode` 改成 `off` 完成废弃：那会留下双路径、数据列、
错误分支和未来再次启用的入口。本 RFC 选择一次性收口为单一自然路径。

## 2. 已确认的边界

### 2.1 本 RFC 要废弃的运行期加固

| 类别                  | 包含内容                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS 隔离与准入         | Seatbelt / bwrap / containment profile、provider 资格、enforce/warn/off、netless、loopback/network deny、sandbox 状态与降级告警                                             |
| verified 执行身份     | runtime binary byte snapshot/digest、source fingerprint、manifest/launcher/control frame、identity codec、resume provenance 匹配、FFF capability                            |
| hermetic 配置与 store | 私有 HOME/XDG/config/data/cache/state、受控 env 白名单、私有 session DB、store lock/hygiene/cleanup、机器配置的受控镜像                                                     |
| 平台强制能力围栏      | system/intent all-deny/read-only profile、非用户声明的 tool load-set、项目/机器 runtime 配置与 instruction/plugin/skill/MCP 的强制屏蔽                                      |
| 产品残留              | `sandboxMode`、`businessToolchainPaths`、`inheritMachineOpencodeConfig`、sandbox CLI/UI/status、execution-identity/sandbox/netless 错误与事件、只为上述链服务的 DB 列和测试 |

### 2.2 必须保留的机制

| 类别                 | 保留原因                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 账号认证与资源授权   | login/OIDC/session/PAT、角色、资源 ACL、owner fence、授权后再提交仍是平台边界                                          |
| 秘密的存储与输出保护 | secretBox、凭据静态加密、wire/log/error redaction、Git askpass 租约与 URL 脱敏继续存在                                 |
| 输入与路径防御       | schema/大小上限、prompt 与 envelope 边界、safe path、symlink/no-follow、zip-slip/zip-bomb、上传/导入校验               |
| DB 正确性            | transaction/CAS、migration、schema admission、备份恢复、幂等 receipt、单写租约、崩溃修复                               |
| 进程生命周期         | bounded stdout/stderr、PID receipt、process-group kill、timeout/cancel、SIGTERM→SIGKILL、pipe drain 与 orphan recovery |
| 用户显式语义         | agent 自己声明的 permission、用户显式 readonly、runtime/agent/MCP/skill/plugin 选择与资源类型边界                      |
| 平台命令正确性       | Git argv/config hardening、`--` 参数分隔、PWD 修正、prompt 字节上限、Windows 原生进程树回收                            |

这里的“保留秘密保护”不再表示“同 UID runtime 进程读不到平台目录”。OS sandbox 移除后，
runtime 能访问宿主账号本来可访问的文件、环境、socket 与网络。保留的是平台 API、落盘和日志
边界，不再承诺把本地子进程当成敌对租户隔离。

### 2.3 自然执行的定义

自然执行指：

1. 直接运行注册的 OpenCode / Claude Code CLI，不经 verified launcher 或 platform sandbox wrapper；
2. 继承 daemon 的机器环境与 runtime 自己的默认 HOME/config/data/store 语义；
3. 允许 runtime 按上游规则发现机器和项目配置、instructions、plugins、skills 与 MCP；
4. 平台只追加完成产品功能所需的 agent prompt、模型参数、已选资源、Git 身份、事件格式与 session id；
5. 用户显式 permission 仍下发；没有用户声明时，不由平台另造强制能力 profile；
6. runtime 的普通失败按 spawn / exit / protocol / MCP 诊断处理，不再升级为安全身份失败。
7. `IS_SANDBOX=1` 仅作为 `claude-code` runtime profile 的显式 CLI 兼容选项，默认关闭；
   关闭时剥离 daemon 的同名继承值，开启时只注入该变量，不启用任何 OS sandbox 或平台防护。

## 3. 目标

1. 所有业务节点、system agent、intent、memory distiller、MCP playground、runtime smoke/model listing
   只走自然 runtime 路径。
2. 删除 sandbox/containment、verified identity、hermetic store、netless 与 forced capability 的生产实现。
3. 删除对应配置、API、CLI、UI、状态、告警、错误码、DB provenance 与非历史文档残留。
4. 把混在“contained”文件里的进程可靠性能力提取为中性 managed-process 原语并保留。
5. 保留用户显式 permission 与 readonly；readonly 改为“在一次性工作区执行、永不合回”，
   不再承诺子进程收到只读文件系统错误。
6. 删除无法在无 containment 前提下诚实兑现的 `agent.network` 与 script `network`。
7. 保留 RFC-272 的 runtime-independent 用户目标：已选 MCP 真实可用/可诊断、managed skill
   辅助文件可达；废弃其 verified launcher / identity / seal 实现。
8. 用前向 migration 清掉现行 schema 残留，不修改任何已应用 migration。
9. 最终代码中不存在可重新开启旧加固链的 feature flag 或备用生产路径。

## 4. 非目标

- 不移除账号认证、ACL、secret encryption/redaction、输入/path/zip 防御或 DB recovery。
- 不降低 `scripts:author`、管理员 runtime 管理、资源 owner 等产品授权要求。
- 不把 runtime 进程迁入 Docker/VM/远端 worker；若未来需要隔离，必须以新 RFC 从零定义。
- 不保证恶意 runtime 不能读取同一 OS 账号可读的内容；本 RFC 明确撤销这项保证。
- 不删除历史 RFC/审计记录；历史文件会标注被 RFC-276 supersede，但继续作为事故证据。
- 不借机改变 workflow、intent、workgroup、resource bundle 的业务协议。
- 实施批准前不修改生产代码、测试或数据库；该门禁已履行。

## 5. 能力与兼容性影响清单

以下影响由第 2 节已确认范围推导；实施批准时必须作为一个整体再次确认。

### C1 · runtime 获得宿主同 UID 可达面

OpenCode、Claude、script 与 local MCP 不再被 Seatbelt/bwrap/netless 限制。它们可以访问宿主
账号可读写的文件、环境、local socket 和网络。受影响部署：所有本地 daemon，尤其是把多个
不互信用户放在同一 OS 账号下的部署。

### C2 · 机器/项目 runtime 配置重新生效

OpenCode/Claude 按上游规则发现机器和项目的 config、instructions、plugin、skill、MCP 与凭据。
同名平台注入项仍按上游 merge 规则覆盖，但未同名的额外能力会进入模型工具面。仓库内
`AGENTS.md` / `CLAUDE.md` 等也可能影响 runtime。

### C3 · 不再证明 binary/source/config 字节身份

runtime path 仍由 registry 选择，但文件在两次运行之间变化不会被 digest/attestation 拒绝。
版本不兼容由普通 probe、CLI parse 或运行失败暴露。

### C4 · 平台强制 system/intent tool profile 消失

system/intent 等 output-only 调用不再靠 all-deny/read-only tool list 自限。为保持产品副作用语义，
它们在一次性工作区运行，平台只消费结构化输出，不合回任意文件改动。用户显式 permission 不受影响。

### C5 · network 字段删除

`agent.network` 当前已经是“可持久化但不强制”的假能力，直接删除。script
`network:'deny'` 当前依赖 containment，删除后也删除 schema/UI/YAML/config-package 表达。
新输入若仍声明该字段必须报“已移除且不会生效”，不能静默假装隔离；存量数据由前向 migration 清除。

### C6 · readonly 的失败形态变化

readonly 继续保证 canonical workspace 无改动，但实现从“OS 拒绝写”变成“允许写一次性副本并丢弃”。
依赖写操作失败来控制流程的脚本会观察到变化；依赖“任务结束后仓库不变”的脚本保持语义。

### C7 · 切换点重置既有 runtime-native session

verified OpenCode 与当前 Claude 路径把 transcript/store 放在私有目录；自然路径改用 runtime 自己的
store，不能只凭旧 session id 声称可恢复。升级时所有既有 business resume 与 MCP playground
native session 明确失效；历史事件保留，下一轮创建新 session。不会做版本绑定的 SQLite 搬运。

### C8 · sandbox 产品面整体消失

Settings 不再展示 sandbox card；config 不再接受三项加固键；`agent-workflow sandbox` 与 doctor
中的 sandbox 指引移除；runtime status 不再返回 configured/effective mechanism。

### C9 · MCP readiness 从安全准入改为能力可观测

RFC-272 的 `GET /mcp` verified control-frame gate 被删除。真实 runtime 能提供标准 startup
inventory/status 时继续记录；working MCP 必须有真实调用 E2E。runtime 未提供同实例 readiness
接口时，不为保留 fail-before-prompt 而重建私有 launcher。

### C10 · managed skill 与 dependent agent 改走自然可达

OpenCode 继续把已选 managed skill 整棵树放进本次 config dir，由上游 skill discovery 加载；
Claude 同时使用非密封 attachment 与 worktree 项目 config 投影：前者公布当前根/文件清单，后者把
整棵树临时放到 `<worktree>/<configDir.name>/skills/<name>`，供只认原生 discovery 的兼容 fork
读取。平台不改 Claude 的用户 config env，因此自然认证/设置仍来自 operator 的持久目录；投影在
runtime 完全退出后、node snapshot/merge 前清理，且不覆盖项目已有同名 skill。无 tree digest、
seal root 或 resume identity；资源类型边界仍禁止“选 skill 等于暗中选 plugin”。每个 dependent
agent 除保留标准 `--agents` registry 外，还独立写入
`<worktree>/<configDir.name>/agents/<agent.name>.md`：一 agent 一文件、一 system prompt，绝不把多个
persona 拼成 root 或同一 subagent 的提示词。项目已有同名文件时同样拒绝覆盖并显式失败。

### C11 · 错误与诊断收缩

`execution-identity-*`、`sandbox-*`、containment/netless failure code 与 degraded alert 删除。
保留 bounded/redacted 的 `runtime-spawn-failed`、runtime exit、session、MCP 与 protocol 诊断。

### C12 · 回滚需要恢复备份

前向 migration 会删除 provenance/store 列并重置 runtime-native session。旧 binary 不能直接读取
新 schema；回滚必须同时恢复升级前 DB/config 备份，不能只替换可执行文件。

## 6. 用户故事

- 作为 operator，我本机 OpenCode/Claude 已配置好的 provider、OAuth、PATH、plugin、skill 与项目
  instructions 在平台任务里按原 runtime 规则工作，不再被一条私有 launcher 重新解释。
- 作为 workflow 作者，我选择的 agent/MCP/skill/plugin 仍会注入，显式 deny/readonly 仍有产品语义。
- 作为 script 作者，我能使用宿主自然工具链和网络，不再遇到 sandbox/provider/namespace 准入失败。
- 作为运维者，我不再看到 sandbox 状态、identity mismatch 或 hermetic store 恢复分支；失败直接指向
  runtime CLI、provider、MCP 或输入协议。
- 作为管理员，我清楚知道本地 runtime 是可信进程：平台认证与 ACL 保护 API，但不再隔离同 UID 子进程。
- 作为 Claude 兼容 fork 的管理员，我可按 runtime 开启 `IS_SANDBOX=1` 兼容标记；默认运行不携带它，
  UI 明确说明该选项不是安全隔离。
- 作为升级操作者，我在切换前拿到备份，并明确知道旧 native sessions 会结束、下一轮从新 session 开始。

## 7. 验收标准

### 单一路径与自然行为

- **AC-1** production OpenCode business/system/MCP-test/model-listing 均不调用 verified launcher、
  manifest、identity、hermetic store 或 containment。
- **AC-2** production Claude business/system/MCP-test 均不做 binary snapshot、controlled env、
  private config-store relocation、netless wrapper 或 platform system tool profile；`isSandbox` 只作为
  `claude-code` runtime profile 的默认关闭兼容选项，关闭时剥离 ambient 值，开启时精确注入 `1`，
  API/UI/文档均不得把它描述为 sandbox 或安全防护。
- **AC-3** OpenCode 真实运行证明机器 config、项目 config、项目 instruction、自然凭据与平台 inline
  overlay 同时生效；merge 顺序固定到支持版本的上游源码与 E2E。
- **AC-4** Claude 真实运行证明机器/项目配置与平台 agent/MCP/dependent 注入可共存；至少两个
  dependent 同时注册为独立 subagent/context，argv registry 与 worktree 一 agent 一文件逐项一致，
  任一文件均不含另一 agent 的 prompt。
- **AC-5** OpenCode `--auto` 下显式 deny 仍拒绝，未显式 deny 的权限不等待交互；mutation
  删除 deny 后测试必须改变结果。

### 用户显式语义与能力

- **AC-6** OpenCode/Claude agent permission 的允许/拒绝矩阵保留；没有 permission 的节点不被平台
  自动套 all-deny/read-only profile。
- **AC-7** readonly script/system output-only 运行即使写文件，canonical workspace 仍逐字节无变化；
  mutation 把 discard 改成 merge 后测试必红。
- **AC-8** 新 schema/API/UI/YAML 不再提供 agent/script `network`；旧输入明确报 removed，
  存量字段迁移后为零。
- **AC-9** 已选 local MCP 在 OpenCode 与 Claude 各有一次真实 tool-call E2E；不可用状态若上游可观测，
  进入 redacted 诊断而非 identity failure。
- **AC-10** 已选 managed skill 的 `SKILL.md` 与一个 sibling `reference.md` 在两种 runtime
  各有真实读取 E2E；Claude 同时覆盖默认/自定义 `configDir.name`、自然认证 env 保留、同名冲突
  不覆盖、cleanup 后 worktree snapshot 不含投影；不需要 seal/digest。

### 正确性保留

- **AC-11** managed-process 原语继续覆盖 bounded stream、raw stdout、PID receipt、timeout/cancel、
  process group、SIGKILL escalation、pipe-drain deadline 与 ENOENT 诊断。
- **AC-12** 同一 native session 的并发 writer 仍由 DB lease 阻断；lease 崩溃恢复测试与 mutation 必红。
- **AC-13** 历史 native session 在升级时得到明确 reset/end 语义，历史事件仍可读，下一轮创建新 session，
  绝不把“session not found”冒充 resume 成功。
- **AC-14** `node_runs.opencode_session_id` 等历史观测字段可以保留；任何 security provenance、
  store path/digest/control marker 列不得留在 live schema/API。
- **AC-15** fresh migration replay、存量升级 fixture、RFC-275 physical-schema admission 与升级前备份流程全绿。

### 产品残留清理

- **AC-16** production/shared/frontend 源码中无 `sandboxMode`、`businessToolchainPaths`、
  `inheritMachineOpencodeConfig`、SandboxCard、sandbox CLI/status 或 degraded lifecycle alert。
- **AC-17** production 源码中无 verified/hermetic/sealed/netless/containment runtime import，
  无 `execution-identity-*` 或 sandbox admission code；历史 RFC 与迁移文件除外。
- **AC-18** 只为旧链服务的测试、fixture、snapshot 与 docs 删除；混合测试拆分后只保留自然能力或正确性断言。
- **AC-19** 不存在 `runtimeHardening=false`、legacy production fallback 或其他可重新开启旧链的开关。

### 被确认保留的边界

- **AC-20** auth/OIDC/session/PAT、resource ACL/owner fencing 全量回归绿。
- **AC-21** secretBox、URL/token/log/error redaction、Git askpass 租约回归绿。
- **AC-22** safe path、symlink/no-follow、zip/upload/import、prompt/envelope 输入边界回归绿。
- **AC-23** DB transaction/CAS/recovery/schema admission/backup 与 process orphan recovery 回归绿。
- **AC-24** daemon-side Git hooks/fsmonitor/ext-diff hardening 与 skill→plugin 资源类型边界保留并有测试，
  因为它们属于平台命令/输入正确性，不是本 RFC 废弃的 runtime 隔离。

## 8. RFC 状态关系

- RFC-205、216、224、227、233：RFC-276 实施完成时标记 Superseded。
- RFC-272：已于 2026-08-10 完成；RFC-276 获批准并完成自然能力 E2E 后再标记 Superseded，
  其已交付的 MCP/skill 用户目标由本 RFC 吸收，Draft 阶段不改其终态。
- RFC-237、238、242、252、253、254、256：保留各自非加固产品能力，在索引注明相关运行期安全部分
  被 RFC-276 部分 supersede。
- RFC-204 的凭据静态保护/askpass、RFC-223 的多租户身份与 ACL、RFC-252 G1 Git hardening 不在清理范围。

## 9. 批准门

本文件、`design.md` 与 `plan.md` 完成后，需要用户显式批准 RFC-276 才能改生产代码。
用户已于 2026-08-10 显式回复“批准”，RFC-276 进入实施。
