# RFC-224 实现计划

> 顺序是安全依赖，不是可任选清单。先冻结 upstream/build identity 与纯比较器，
> 再完成 import/file/process 边界，最后接 direct API launcher 和三条生产路径。
> 任一中间状态都不得出现“旧 binary 已放行，但新 gate 尚未接上”的窗口。

## 1. 交付切片

| Slice | 交付                                                                         | 主要证明                                                  |
| ----- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| A     | RFC 三件套、upstream v1.18.3 锚点、Codex design gate                         | findings 全关闭且无 P0/P1                                 |
| B     | official build allowlist、binary copy/re-hash、canonical identity comparator | fake/fork/symlink/mutation table                          |
| C     | hermetic source/env/permission guard、runtime seal、inner sandbox wrapper    | plugin 不执行、file-symlink/secret/network escape matrix  |
| D     | hidden verified launcher、same-instance preflight、session + SSE codec       | fake server protocol、golden codec、取消/超时/无孤儿      |
| E     | opencode builders 与 runner/distiller/smoke 统一接入、稳定错误/UI            | 三入口 source guard、permanent classification、可操作错误 |
| F     | official integration、完整 gates、实现门、文档/STATE、提交上库               | compiled smoke、exact-SHA CI terminal green               |

## 2. 设计与冻结输入

- [x] T0：完成 Codex 设计门；逐条写入 finding、resolution、evidence，最终状态
      `APPROVED` 且 P0/P1 为零后才允许生产接线。
- [x] T1：固定官方 `v1.18.3` 的 darwin/linux × arm64/x64
      executable SHA-256 与 codec 版本；同步 `MIN_OPENCODE_VERSION`、CI 与集成 pin。
- [x] T2：实现 official binary resolve：
      单 token → PATH/realpath → streaming hash → `COPYFILE_EXCL` private copy →
      no-symlink/mode/re-hash；exec 紧前再次验证。
- [x] T3：实现 canonical JSON、首差异 JSON Pointer、raw config /
      `Agent.Info` / MCP / provider / top-level security comparator；plain JSON、
      poison key、finite number、array 顺序与 permission 顺序全部 fail closed。
- [x] T4：冻结显式 model/variant/provider、完整受控 agent 和 root session
      contract；null model、native/hidden/subagent/default fallback 均返回稳定错误。

## 3. hermetic source 与 OS 边界

- [x] T5：构造 server env allowlist；真实 `HOME`、XDG、OpenCode config/data/cache、
      managed config 全部 private；只生成 selected provider 的 strict API auth，
      拒绝 OAuth/wellknown/unknown npm/extra key；server 前后与 daemon recovery
      在 exclusive lock/server-stopped 条件下删除 auth.json、事务清空验证
      `account_state/account/control_account`、checkpoint/close 后验证 DB/WAL/SHM；
      清空 loader/runtime/Git/package-manager 注入变量，禁用 models fetch/default
      plugins/file watcher，按 pinned `ConfigPaths.directories()` 对
      global/test-home/explicit 三个 distinct root 全部 no-symlink 物化
      `.gitignore`、逐个 RO seal，install/network=0。
- [x] T6：实现 source guard：
      server 前/prompt 前扫描 canonical worktree 到 root，拒绝任何 repo config、
      `.opencode`、`reference/references`、external/project skill、plugin/custom tool、
      symlink、parse ambiguity 或模型可控 fingerprint race；location 在模型前只发现
      一次，模块执行计数必须为零。
- [x] T7：强制 final raw config：
      `share=disabled`、`autoupdate=false`、`snapshot=false`、`formatter=false`、`lsp=false`、
      `compaction.auto=false`、sealed shell、selected provider exact、无隐式 model。
- [x] T7a：official build manifest pin `fffCapabilityCodec=1`；real server 前在
      no-network bwrap、empty RO cache、无 rg PATH 与仅含随机已知文件的 private cwd
      用同一 snapshot 运行 pinned `debug file search <exact-basename>`，必须精确命中；
      失败即 bootstrap-failed，exec/network audit 中 rg/tar/install 计数必须为零。
- [x] T8：构造有序 Agent.Info permission：
      deny `read/edit/write/apply_patch/grep/glob/skill/task/webfetch/websearch/lsp`，
      对 OpenCode `Truncate.GLOB` 加精确 `external_directory` deny，再加 wildcard
      deny；system/smoke 全工具 deny；session 不得追加 allow。
- [x] T9：扩展 RFC-205 `readOnlySubtrees`，保护 binary/wrapper/manifest seal；
      secure v1 仅允许 Linux bwrap；macOS model execution fail closed，只保留
      official binary/config/managed-path diagnosis。
- [x] T10：实现 sealed shell/local-MCP wrapper：
      `env -i`、private net+pid namespace、无 loopback/公网/process-info，遮蔽 daemon
      真实 HOME、user-writable executable roots 与共享 temp，仅精确
      worktree/scratch RW；root-owned OS tree 明示为只读 TCB，platform/seal/XDG
      secret 不可见；危险 MCP env key 在解释器启动前拒绝。
- [x] T11：business 要求 `sandboxMode=enforce` 且可用；external plugin、
      dependent agent、external/project skill 直接稳定 unsupported，不静默降级；
      platform `AGENTS.md` no-symlink copy/re-hash；managed skill 按 frozen
      contentVersion no-symlink snapshot 整棵 tree，canonical tree digest +
      copy/re-hash，prompt/aux bind 都只取 immutable seal；OpenCode external/project/
      platform-selected skill registry 为空，official `skill` tool恒 deny，`/skill`
      仅允许 pinned built-in baseline。

## 4. direct API launcher

- [x] T12：实现 dependency-injected launcher core：
      sealed official `serve --hostname 127.0.0.1 --port 0 --no-mdns`、随机 Basic
      Auth、唯一严格 listen parser、每请求 canonical directory/no-redirect/
      deadline/size/schema budget、capped stderr。
- [x] T13：same-instance 读取 `/config`、`/config/providers`、`/agent`、`/skill`；
      endpoint 只校验 selected provider/model 与 `model.api.npm` 命中 official
      bundled allowlist；auth type 由 launcher 在构造 `OPENCODE_AUTH_CONTENT` 前本地
      strict schema 校验；同时校验 pinned `customize-opencode` built-in skill digest，
      拒绝其它 skill，完整 compare，第二次 `Agent.Info` seal 与第二次 source
      fingerprint；绝不 `/mcp/status`。
- [x] T14：新 session 固定非默认 title、显式 agent/model/variant、精确三条 root
      permission（create model 用 `{providerID,id,variant?}`）；resume 经 frozen-title
      `/experimental/session` 分页唯一定位并验证
      directory/parent/workspace/project/version/agent/model/variant/permission/metadata；
      migration 增加 `opencode_session_owners` 单一 owner + single-writer lease，
      owner 还保存完整 frozen root-session contract 的 canonical digest；
      多个 node_run 可复用同一 session id；resume 复用同一 daemon-private XDG store，
      fresh business 用 random chain/root-run key（fanout/loop 不碰撞），不接受
      legacy/foreign owner 或 active lease；resume 在任何 store/scrub/server 前按
      immutable owner + empty lease CAS 预占 run+nonce，并持生命周期 store lock；
      business
      `SpawnPlan.control` 用 strict stderr marker + nonce ack；marker wire 精确携带
      kind/session/project/version/nodeRunId/leaseNonceDigest，令 runner 在 prompt 前
      new 原子写 session owner/lease，resume marker 只复核已预占的同一 nonce并 CAS
      当前 run，不得首次抢 lease；nack/timeout 必须 abort；release/repair
      都按 session+run+nonce triple compare-and-clear，repair 同事务复核 terminal +
      process-group dead，防 delayed-cleanup ABA。
- [x] T15：SSE 200/parser ready 后要求首个有效事件为 `server.connected`，再用
      pinned-compatible ascending codec 生成并时间排序 caller-owned user message id，
      POST `model:{providerID,modelID}` +
      top-level variant + 一个 byte-equal text part；
      用 `message.updated.parentID` 绑定每个 tool-loop step 的严格递增 assistant-id
      集并复核 agent/provider/model/variant/path，旧 assistant completed 后才接受新
      step；恰好一个 caller user/text，只有已绑定 assistant parts/delta 可达；
      caller/assistant id 排序、未知相关事件、畸形/drop、permission/question asked、
      server early exit 全 fail closed。
- [x] T16：把 pinned v1.18.3 SSE 映射为现有 `run --format json` protocol；
      与官方录制 fixture 对 stdout 顺序、字段和 exit code 做 golden 比较。
- [x] T17：SIGTERM/SIGINT/timeout：
      abort fetch/SSE → best-effort session abort → TERM server → bounded grace →
      负进程组 KILL → bounded reap/drain；resistant fixture 无孤儿。
- [x] T18：在 `main.ts` 添加不出现在 help 的
      `__opencode-verified-run`，dev/compiled self-command 均可定位。

## 5. 三条生产入口与产品行为

- [x] T19：两个 opencode builder 共用 `buildVerifiedOpencodePlan`；business/system
      不再拼 direct `opencode run`，nonempty `dependsOn` 先拒绝；plan 暴露 private
      `sessionStore.dbPath` capture locator。
- [x] T20：runner 使用 launcher process group；identity marker 只持久化
      code/path/非敏感 digest，identity failure 为 permanent，不进 envelope
      followup 或相同输入普通 retry；control marker 在普通 stderr persistence 前
      拦截，duplicate/malformed/CAS/ack failure fail closed，所有退出调用 cleanup。
- [x] T21：memory distiller 与 runtime smoke 也只启动 launcher，并补齐
      TERM/KILL/bounded drain、`plan.cleanup` 与 permanent outcome；business live/
      post session capture 显式使用 plan locator，禁止读用户全局 OpenCode DB。
      distiller/smoke 使用 per-invocation ephemeral store，capture 后 cleanup；business
      persistent store 由 owner/task retention GC。
- [x] T22：inventory 仅由通过 same-instance gate 的 `/agent`、pinned built-in
      `/skill` baseline、prompt-injected frozen skill manifest 与 manifest MCP 产生；
      built-in 不冒充 agent 所选 skill，plugins 固定为空。
- [x] T23：协议/数据库/UI/save/probe 暴露稳定错误：
      untrusted binary、sandbox required、project config、plugin/dependent unsupported、
      model unresolved、bootstrap/mismatch/instance/session/stream/timeout；shared
      failure union 是单一事实源，identity failure 不进入 followup policy/retry。
- [x] T24：fresh seed 与现有 `model=NULL` 不补默认；OpenCode UI/save/probe/run
      都明确要求 operator 选择 model。shared effective-runtime policy 同时覆盖
      runtime/agent/system-config save、direct launch、schedule save/fire 与最终
      runner；legacy invalid 可删除旧选择但不能带病保存其它修改。
- [x] T25：source reachability test 禁止 runner、distiller、smoke 或新代码绕过
      verified builder 直接 spawn OpenCode；status/model inventory 也只能用 official
      snapshot，不得执行 registry 中任意 fork。

## 6. 验证、门禁与发布

- [x] T26：完成 proposal AC1–AC10 的 table/golden/attack tests；特别覆盖：
      managed/MDM/active-org/env 覆盖、file symlink → `/proc/self/environ`/XDG、
      plugin/custom-tool/skill/rg/tar/npm-install 不执行、provider auth/npm allowlist、
      loopback secret、real HOME/shared temp、session pagination/provenance、
      resume strict title/path/share/revert/metadata root contract、
      同 task+node 并发 fanout/loop store isolation、system ephemeral key/GC、
      owner lease 双 resume pre-CAS/delayed-finally/repair/reacquire ABA、
      skill rename/contentVersion/aux/symlink mutation race、
      caller-id 时间排序与多-step assistant parent binding、cancellation/double-fork
      orphan。
- [x] T27：运行定向测试与平台 gated sandbox matrix；本机定向/进程组矩阵已绿，
      macOS 按契约 fail closed。Linux real escape/double-fork 的权威平台证据由
      integration workflow 承担，当前仍待本次提交的远端终态。
- [x] T28：运行
      `bun run typecheck && bun run lint && bun run test && bun run format:check`，
      再跑 depcheck、`git diff --check`、`bun run build:binary`、compiled
      hidden-command smoke。
- [x] T29：用官方 1.18.3 做 no-LLM config/session preflight 与 pinned codec
      integration；无官方 binary 的平台只允许显式 skip，不允许 fake 通过 trust gate。
- [x] T30：Codex 实现门；逐条修复，最终无未关闭 P0/P1/P2。
- [x] T31：更正 `CLAUDE.md` inline 优先级断言、更新 `OPENCODE_CONFIG.md`、
      RFC 状态与 `STATE.md`，只记录真实证据。
- [ ] T32：精确 path commit，核验真实 Codex/model co-author trailer，push
      shared `main`，等待该 commit SHA 的 CI/integration 终态。

## 7. 实现与验证证据（2026-07-23）

- **T1–T4**：`officialBuilds.ts`、`executionIdentity.ts`、`directApiSchemas.ts`
  落地四平台/架构 trust root、private executable snapshot、canonical comparator、
  显式 model/provider 与 session contract；对应
  `rfc224-official-builds`、`rfc224-execution-identity`、
  `rfc224-direct-schemas` 为 table-driven 证据。
- **T5–T11**：`hermetic.ts`、`sourceGuard.ts`、`fffCapability.ts`、
  `sealedInputs.ts`、`sealedSubprocess.ts` 与 RFC-205 read-only overlay 接线完成；
  hermetic/source/FFF/seal/sandbox 负测覆盖 symlink、poison env、masked secret root、
  精确 executable bind 与 unsupported resource。
- **T12–T18**：`directClient.ts`、`sse.ts`、`directCodec.ts`、
  `verifiedLauncher.ts` 与两个 hidden self-command 完成；direct client/schema/SSE/
  codec/launcher/control tests 覆盖 same-instance preflight、caller/assistant binding、
  fail-closed event、cancel/timeout 与 bounded drain。compiled binary 的 hidden
  command 不出现在 help，畸形直接调用稳定 fail closed。
- **T19–T25**：business/system 共同调用 `verifiedPlanCore.ts` 的
  `buildVerifiedOpencodePlan`；runner、distiller、smoke、inventory、stable failure
  taxonomy 与 product-boundary policy 已接入。source reachability、runner control、
  permanent routing、store recovery/task-delete 与 product policy tests 锁定生产路径。
- **T26–T27**：阶段性 RFC-224 定向测试 **286/286**、stale/source guards
  **80/80**、需 localhost/进程信号的 17 文件授权矩阵 **109/109**；最终独立复核
  backend focused **94/94**、frontend focused **43/43**、source reachability
  **8/8**。本机为 macOS，secure model execution 按契约 fail closed；Linux
  root-owned bwrap real escape/double-fork 权威结果仍等待远端 integration 终态，
  未冒充本地证据。
- **T29**：本机 official OpenCode **1.18.3 darwin-arm64** no-LLM
  config/provider/agent/skill/root-session preflight **1/1（7 assertions）** 通过；
  workflow 固定 Ubuntu 1.18.3 并安装 root-owned、不可 group/world-write 的 bwrap。
- **T30–T31**：实现门初审与后续对抗复核 finding 均已修复，最终未关闭
  **0 P0 / 0 P1 / 0 P2**；结论与残余平台/发布证据记录于
  `codex-impl-gate-2026-07-23.md`，配置与仓库状态文档同步。
- **T28 已完成**：最终 `bun run test` 三包同轮 **0 fail**（shared
  **1438/1438**、frontend **5257/5257**）；format、typecheck、lint、
  `git diff --check` 均绿；depcheck **1455 modules / 4482 dependencies /
  0 violations**；`build:binary` 与 compiled `version`、`doctor`、help 隐藏性及
  两条 hidden-command fail-closed smoke 均通过。
- **T32 仍 pending**：尚未形成/推送本次精确 commit，未核验该 commit trailer，
  也没有该 exact SHA 的 CI/integration terminal result。

## 8. 完成定义

- proposal AC1–AC10 全有自动化证据；
- unknown/fake binary、identity/source/session/file-symlink 任一攻击都在模型结果
  前 fail closed；
- runner、distiller、smoke 无 direct OpenCode bypass，且取消/超时无 orphan；
- 三入口、UI/probe/save 的 unsupported/null-model 行为一致且可操作；
- full gates、compiled binary、official integration、Codex impl gate 全绿；
- commit trailer 已核验，remote `main` 含该 SHA，exact-SHA CI terminal green；
- `STATE.md` 与 RFC 状态不提前宣称完成。
