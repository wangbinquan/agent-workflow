# OpenCode 版本无关 verified execution contract

> 当前合同：RFC-224 的执行身份保证，经 RFC-227 supersede 后改为
> **runtime binary digest + direct API behavior codec + containment capability**。
> OpenCode 版本字符串只作信息展示，不参与准入、恢复或错误分类。

## 1. 三条独立判断轴

OpenCode 是否可用不能再压成一个 “found / not found”：

1. **Executable availability**
   - PATH token 或绝对路径能否解析；
   - 是否为可执行普通文件；
   - 能否复制到本次运行的 private seal。
2. **Protocol behavior**
   - 能否启动 loopback `serve`；
   - direct API endpoint、request/response schema、session、SSE event 与 same-instance
     inventory 是否符合 `opencode-direct-v1`；
   - 判定必须发生在首个模型请求之前。
3. **Containment**
   - 当前 provider 是否满足 host-home isolation、immutable artifact view、
     model-child network deny 等必要能力；
   - `enforce / warn / off` 决定缺少能力时是拒绝还是显式降级。

任何 `--version` 输出（旧、新、极大、非 semver、空）都不会改变上述三条判断。

## 2. Runtime binary 是管理员选择的本机 TCB

`runtimeBinary.ts` 对管理员选择的 executable 做以下处理：

1. 只接受一个 PATH token 或一个绝对 executable path，不接受 wrapper argv；
2. canonical resolve，拒绝不存在、不可执行或非普通文件；
3. 读取 source metadata 与 SHA-256；
4. 以 exclusive create 复制到 caller-owned private seal；
5. 复制后重新计算 digest，并复核 source inode/size/time/digest 没有发生竞态变化；
6. server exec 前再次检查 snapshot 类型、权限与 digest。

SHA-256 只证明“本次执行的是已冻结的这些 bytes”，不是 OpenCode 官方签名，也不会与
任何 release/version allowlist 比较。管理员改变 binary bytes 后，新运行得到新的 digest；
已有 session 只有 digest 与 protocol codec 都相同时才能恢复。

关键实现：

- `packages/backend/src/services/runtime/opencode/runtimeBinary.ts`
- `packages/backend/src/services/runtime/opencode/verifiedPlanCore.ts`
- `packages/backend/src/services/runtime/opencode/verifiedLauncher.ts`

## 3. 行为 codec

当前 codec id 是 `opencode-direct-v1`，由
`packages/backend/src/services/runtime/opencode/directApiSchemas.ts` 所有。

verified launcher 在同一个 byte-frozen server instance 上完成：

- final `/config` 与 selected provider/model 检查；
- ordered `/agent` inventory 双读一致性；
- selected managed skill、MCP 与 source fingerprint 校验；
- fresh/resume session identity 校验；
- SSE 在 prompt POST 之前订阅；
- message/session/event schema 与 monotonic message id 校验；
- control marker/ACK 后才允许业务 prompt。

不兼容时返回稳定的 `execution-identity-protocol-incompatible` 或更具体的 execution
identity code；不得把任意 upstream body、host path 或 secret 放进 wire error。

reported version 可以写入 status/owner 作为 nullable telemetry，但：

- manifest/control 不要求某个版本 literal；
- owner resume 不比较 reported version；
- boot recovery 不查询当前版本或 release 哈希；
- status badge 不按版本大小或是否等于某值改变。

## 4. Hermetic config 与 source identity

生产执行继续保留 RFC-224 的安全保证：

- `HOME`、XDG roots、managed/test/explicit config 与 tmp 都在 private store；
- `OPENCODE_CONFIG_CONTENT` 包含完整受控配置，但不把 inline merge 顺序当信任边界；
- project config、external skills、default plugins、model fetch、file watcher 等隐式来源关闭；
- `scanOpencodeProjectSurface` 拒绝 repo/ancestor 的 `opencode.json[c]`、`.opencode`、
  `reference(s)`、`.agents/skills` 与 `.claude/skills`；
- selected managed skill whole-tree snapshot，无 symlink，正文 digest-tagged 注入，
  auxiliary files 只读；
- selected MCP closure 是唯一进入配置的 MCP 集合；local MCP 与可选 shell 经过
  provider-owned no-network child launcher；
- selected agent/model/provider/skill/MCP 与 source fingerprint 都加入 canonical
  execution identity。

完整配置不是“兼容任意 OpenCode 行为”的承诺；行为 codec 不匹配仍应 fail closed。

## 5. Containment provider

OpenCode core 不读取 `process.platform` 决定准入。它只消费一个开放的 provider plan：

```text
providerId: string
capabilities:
  platformHomeIsolation: strong | best-effort | absent
  immutableArtifactView: strong | best-effort | absent
  modelChildNetworkDeny: strong | best-effort | absent
  descendantLifetimeBound: strong | best-effort | absent
childProviderPlan: provider-owned JSON
```

内置 provider：

| provider         | outer/server                        | shell/local MCP                     | descendant lifetime |
| ---------------- | ----------------------------------- | ----------------------------------- | ------------------- |
| `linux-bwrap`    | private PID/network/mount namespace | nested no-network bwrap             | `strong`            |
| `macos-seatbelt` | Seatbelt appHome/seal allowback     | Seatbelt no-network exact allowback | `best-effort`       |
| `none`           | 无 OS containment                   | sanitized env only                  | `absent`            |

Linux 专属的 root-owned bwrap probe、FFF capability 与 namespace/orphan 证据仍保留，
但只存在于 Linux provider 分支。macOS Seatbelt 的真实 gated test证明：

- appHome secret 不可读；
- 当前 worktree 可写；
- seal artifact 不可写；
- model-reachable child network 被拒。

未来 Windows Job Object/AppContainer provider 注册自己的 capability、outer renderer 与
child renderer；common manifest/schema 使用开放 string/JSON，不需要加入
`platform === "win32"` 的 OpenCode 特判。本合同不表示当前已发布 Windows 产品二进制。

## 6. `enforce / warn / off`

| mode      | provider baseline 完整 | provider 缺失/partial                                    |
| --------- | ---------------------- | -------------------------------------------------------- |
| `enforce` | contained execution    | 拒绝，`containment-blocked` / sandbox-required           |
| `warn`    | contained execution    | 使用 `none` child provider 执行，状态 `degraded`，写告警 |
| `off`     | 使用 `none`            | 使用 `none`；这是管理员显式接受的无 containment 策略     |

`warn/off` 仍保留 binary/config/session identity，但不再保证宿主 secret 与 child network
隔离。UI、日志和 lifecycle alert 不得把这种执行称为安全沙箱。

## 7. Session provenance 与迁移

`opencode_session_owners` 当前不可变 provenance：

- `runtime_binary_digest`
- `protocol_codec`
- `identity_digest`
- `session_contract_digest`
- `session_store_key`
- `project_id`
- nullable `reported_version`

Migration `0121_rfc227_opencode_provenance.sql` 无损 rebuild RFC-224 owner：

- `official_build_digest → runtime_binary_digest`
- 新增 `protocol_codec = opencode-direct-v1`
- `opencode_version → reported_version`
- owner、lease、index、task FK 与 all-or-none lease check 均保留。

Resume 比较 digest + codec + canonical identity，不比较 reported version。Store lock reader
仍能读取 legacy codec 1 的 `officialBuildDigest`，只用于升级兼容；新写入使用
`runtimeBinaryDigest`。

## 8. Status 与用户诊断

`GET /api/runtimes/status` 的 OpenCode 状态：

- `not-found`
- `unlaunchable`
- `available-unverified`
- `protocol-incompatible`
- `containment-blocked`
- `degraded`
- `ready`

轻量 status 的成功 `--version` probe 只能证明 executable 可启动，因此 OpenCode 通常先
显示 `available-unverified`；Runtime Test / models / actual run 执行 byte snapshot 与更深
行为检查。“未找到”只用于真实缺失，不得再承接版本、协议或隔离失败。

## 9. 维护检查清单

修改 OpenCode 接口或 sandbox 时至少运行：

- version-neutral probe 与 runtime status tests；
- runtime binary snapshot/mutation tests；
- direct schemas、manifest、control、launcher tests；
- owner migration/resume/recovery tests；
- containment truth table 与 Windows provider contract test；
- Linux bwrap/FFF gated evidence；
- macOS Seatbelt gated evidence；
- backend/shared/frontend 全量 test、typecheck、lint、format、depcheck 与 binary smoke。

禁止在当前 production graph 重新引入：

- `MIN_OPENCODE_VERSION` / `PINNED_OPENCODE_VERSION`；
- OpenCode admission 的 semver compare；
- 单 release hash allowlist；
- `platform !== "linux"` 的 core admission；
- 把 digest 描述为 vendor authenticity proof；
- 把 `warn/off` 描述为仍具备 host/network containment。

历史合同保存在 RFC-224；RFC-227 是上述版本与平台条款的当前 supersession。
