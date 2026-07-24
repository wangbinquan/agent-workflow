# RFC-224 实现计划

> 顺序是安全依赖，不是可任选清单。先冻结 upstream/build identity 与纯比较器，
> 再完成 import/file/process 边界，最后接 direct API launcher 和三条生产路径。
> 任一中间状态都不得出现“旧 binary 已放行，但新 gate 尚未接上”的窗口。

> **RFC-227 supersession（2026-07-24）**：本文已完成的 official `1.18.3` 与
> Linux-only 任务是 RFC-224 的历史交付记录，不再构成当前准入规则。RFC-227 保留
> snapshot/re-hash、same-instance identity 与 session 安全边界，并以管理员选择的 binary
> digest、行为 codec 和跨平台 containment provider 取代旧版本/OS allowlist。

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
- [x] T18：在 `main.ts` 添加四个不出现在 help 的 verified-self hidden
      self-command：`__opencode-verified-run`、`__opencode-netless-subprocess`、
      `__opencode-bwrap-capability-supervisor`、
      `__opencode-fff-capability-supervisor`；dev/compiled 形态均可定位，畸形 argv
      全部 fail closed。

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
      macOS 按契约 fail closed。Linux integration 已接线真实
      SIGTERM-resistant setsid/double-fork orphan probe，要求 nonce-bound
      READY/ARMED，再由 SIGSTOP + `waitpid(WUNTRACED)` freeze lease 锁住 exact
      child/PGID，证明实际负组 TERM、SIGCONT 后 exact SIGTERM exit、leader reap、
      首个 ESRCH observation 单调锁存与后代持有的 stdout EOF；
      SURVIVED/WATCHDOG 均失败。最终 SHA 的
      [`integration-opencode` 30059985690](https://github.com/wangbinquan/agent-workflow/actions/runs/30059985690)
      为 terminal success，提供该 Linux 权威结果；首个失败 run 只保留为诊断历史。
- [x] T28：运行
      `bun run typecheck && bun run lint && bun run test && bun run format:check`，
      再跑 depcheck、`git diff --check`、`bun run build:binary:e2e`、compiled
      hidden-command smoke；全量为 backend **7295 pass / 24 skip / 0 fail**、
      shared **1438 pass**、frontend **5257 pass**，完整 Chromium E2E
      **142 pass / 31 skip / 0 fail**，depcheck
      **1455 modules / 4484 dependencies / 0 violations**；current-tree RFC-224 定向集合
      **322 pass / 1412 assertions**，其中 compiled Playwright seam
      **5 pass / 30 assertions**、sealed subprocess
      **23 pass / 90 assertions**、FFF capability
      **13 pass / 98 assertions**。compiled smoke 同时锁四个 hidden command
      invalid invocation，以及 bwrap protocol 的 pre-ACK zero buffer、ACK 必须以
      EOF 提交、wrong nonce fail closed。
- [x] T29：用官方 1.18.3 做 no-LLM config/session preflight 与 pinned codec
      integration；最终
      [`integration-opencode` 30059985690](https://github.com/wangbinquan/agent-workflow/actions/runs/30059985690)
      中 RFC-224 official 子集为 **3 pass / 15 assertions**，whole workflow 为
      **5 pass / 5 skip / 0 fail / 19 assertions**；无官方 binary 的平台只允许显式
      skip，不允许 fake 通过 trust gate。
- [x] T30：两轮独立复审累计 23 组 P1 / 14 组 P2；逐条核验 resolution 与对应
      行为锁/source ratchet 后全部 resolved，最终未关闭
      **0 P0 / 0 P1 / 0 P2**，实现门 **APPROVED / 0 open**。
- [x] T31：更正 `CLAUDE.md` inline 优先级断言、更新 `OPENCODE_CONFIG.md`、
      RFC 状态与 `STATE.md`，只记录真实证据。
- [x] T32：精确 path commit 链
      `b4b3e082c0bf010f123c3e93c7b9abbd1f4f877e` →
      `a7f6814e028aa27c082508107d1217029e0e417e` →
      `fe96a42ad1e9423d61675d336585e63344f3eb4a` →
      `791c433508b1721ced96d900b04128a022f02ff2` →
      `c50036ac35a4a87c52b825f280d1afc1a9d54784` 的真实 Codex/model co-author
      trailer 均已核验并 push shared `main`；最终 exact SHA 的 CI、
      integration-opencode、Visual Regression 与 git-protocols-e2e 均 terminal green。

## 7. 实现与验证证据（2026-07-23）

- **T1–T4**：`officialBuilds.ts`、`executionIdentity.ts`、`directApiSchemas.ts`
  落地四平台/架构 trust root、private executable snapshot、canonical comparator、
  显式 model/provider 与 session contract；对应
  `rfc224-official-builds`、`rfc224-execution-identity`、
  `rfc224-direct-schemas` 为 table-driven 证据。
- **T5–T11**：`hermetic.ts`、`sourceGuard.ts`、`fffCapability.ts`、
  `sealedInputs.ts`、`sealedSubprocess.ts` 与 RFC-205 read-only overlay 接线完成；
  hermetic/source/FFF/seal/sandbox 负测覆盖 symlink、poison env、masked secret root、
  精确 executable bind 与 unsupported resource。首个 Linux integration 进一步证明
  bwrap metadata 不是 capability；follow-up 在 production admission 增加有界的真实
  namespace/mount probe，失败稳定返回 `execution-identity-sandbox-required`。
  bwrap 与 FFF 分别由 verified-self 原生 supervisor 按 nonce-bound
  EXIT/RESULT → ACK+EOF → RELEASE → self negative-group SIGKILL 释放；single
  absolute deadline、protocol EOF、raw 137 与首个 ESRCH observation 单调锁存
  共同证明完成，FFF 还要求 probe stdout/stderr 双 EOF，release 后 parent 不再
  signal numeric PGID。
- **T12–T18**：`directClient.ts`、`sse.ts`、`directCodec.ts`、
  `verifiedLauncher.ts` 与四个 hidden self-command 完成；direct
  client/schema/SSE/codec/launcher/control tests 覆盖 same-instance preflight、
  caller/assistant binding、fail-closed event、cancel/timeout 与 bounded drain。
  compiled binary 的 hidden command 不出现在 help，畸形直接调用稳定 fail closed。
- **T19–T25**：business/system 共同调用 `verifiedPlanCore.ts` 的
  `buildVerifiedOpencodePlan`；runner、distiller、smoke、inventory、stable failure
  taxonomy 与 product-boundary policy 已接入。source reachability、runner control、
  permanent routing、store recovery/task-delete 与 product policy tests 锁定生产路径。
- **T26–T27**：首个 implementation SHA 前的阶段性 RFC-224 定向
  **286/286**、stale/source guards **80/80**、授权矩阵 **109/109**、backend
  focused **94/94**、frontend focused **43/43** 与 source reachability **8/8**
  仅保留为历史 baseline。current-tree RFC-224 定向集合为
  **322 pass / 1412 assertions**，其中最终 compiled Playwright seam
  **5 pass / 30 assertions**；follow-up 已接线 real bwrap
  SIGTERM-resistant setsid/double-fork orphan probe，并以 SIGSTOP /
  `waitpid(WUNTRACED)` freeze lease 消除 TERM 前 target 自退/换组窗口；本机 macOS
  无法提供其权威结果，最终由
  [`integration-opencode` 30059985690](https://github.com/wangbinquan/agent-workflow/actions/runs/30059985690)
  的 terminal success 提供远端 Linux 权威证据。
- **T29**：本机 official OpenCode **1.18.3 darwin-arm64** no-LLM
  config/provider/agent/skill/root-session preflight **1/1（7 assertions）** 通过；
  follow-up workflow 固定已资格化 Ubuntu runner 与 official 1.18.3，并在 suite 前
  以普通用户运行和 production 同级的 exact bwrap capability smoke；不得用
  sudo/sysctl/setuid 绕过平台能力。最终远端 official 子集为
  **3 pass / 15 assertions**，whole workflow 为
  **5 pass / 5 skip / 0 fail / 19 assertions**。
- **T30–T31**：首轮独立复审新增 **4 组 P1 / 2 组 P2**，real Linux 探针专项
  复审再新增 **5 组 P1 / 3 组 P2**，累计 **23 组 P1 / 14 组 P2**。实现门已补
  登记 bounded direct+negative-PGID reap、FFF stable code、pre-store admission、
  suid/sgid mode gate、四 workflow/六 stub exact ratchet，以及 nonce-bound
  READY/ARMED + freeze lease、actual TERM、descendant-held stdout EOF、
  SURVIVED/WATCHDOG failure 与 old-PGID no-resignal；resolution/测试已复验，
  实现门终裁 **APPROVED / 0 open**，最终未关闭
  **0 P0 / 0 P1 / 0 P2**。
- **T28 完成**：current-tree sealed subprocess
  **23 pass / 90 assertions**、FFF capability
  **13 pass / 98 assertions**、RFC-224 定向集合
  **322 pass / 1412 assertions**（含 compiled Playwright seam
  **5 pass / 30 assertions**）；format/typecheck/lint、depcheck、
  `git diff --check`、`build:binary:e2e` 与 compiled smoke 均完成。compiled smoke
  除四个 hidden command invalid-invocation ratchet 外，还证明 bwrap RELEASE
  不得在 ACK 前缓冲、ACK 未 EOF 时 pending read 不得推进、wrong nonce 不得
  release，成功/失败路径均以 raw 137、stdout EOF 与首个 ESRCH observation
  单调锁存收口。
- **T32 完成（2026-07-24）**：完整提交链为
  `b4b3e082c0bf010f123c3e93c7b9abbd1f4f877e` →
  `a7f6814e028aa27c082508107d1217029e0e417e` →
  `fe96a42ad1e9423d61675d336585e63344f3eb4a` →
  `791c433508b1721ced96d900b04128a022f02ff2` →
  `c50036ac35a4a87c52b825f280d1afc1a9d54784`；各轮真实结果如下：
  - `b4b3e082`：
    [`integration-opencode` 30045245638](https://github.com/wangbinquan/agent-workflow/actions/runs/30045245638)
    暴露 metadata-only bwrap admission；
    [`CI` 30045245623](https://github.com/wangbinquan/agent-workflow/actions/runs/30045245623)
    与
    [`visual-regression-nightly` 30045245613](https://github.com/wangbinquan/agent-workflow/actions/runs/30045245613)
    均被 1.14.99 E2E stub 在 daemon startup 拒绝，三个 failure 只作诊断历史。
  - `a7f6814e`：
    [`integration-opencode` 30057061688](https://github.com/wangbinquan/agent-workflow/actions/runs/30057061688)
    暴露 Python enum/string oracle 漂移；
    [`CI` 30057061665](https://github.com/wangbinquan/agent-workflow/actions/runs/30057061665)
    因 actionlint 与 model-less E2E seed 422 失败；
    [`visual-regression-nightly` 30057061833](https://github.com/wangbinquan/agent-workflow/actions/runs/30057061833)
    因 theme config PUT 422 失败。
  - `fe96a42a`：
    [`integration-opencode` 30057707597](https://github.com/wangbinquan/agent-workflow/actions/runs/30057707597)
    首次成功；但
    [`CI` 30057707588](https://github.com/wangbinquan/agent-workflow/actions/runs/30057707588)
    仍因 ShellCheck SC2016 与八个 model-less E2E shard 失败，
    [`visual-regression-nightly` 30057707642](https://github.com/wangbinquan/agent-workflow/actions/runs/30057707642)
    为 **22 pass / 4 fail**，暴露 stub trust/terminal fixture 漂移。
  - `791c4335`：
    [`integration-opencode` 30059793133](https://github.com/wangbinquan/agent-workflow/actions/runs/30059793133)、
    [`Visual Regression` 30059793075](https://github.com/wangbinquan/agent-workflow/actions/runs/30059793075)
    与
    [`git-protocols-e2e` 30059793067](https://github.com/wangbinquan/agent-workflow/actions/runs/30059793067)
    均成功；但
    [`CI` 30059793066](https://github.com/wangbinquan/agent-workflow/actions/runs/30059793066)
    在 static actionlint 报 SC1072/SC1073 后被取消，因此仍不是发布点。
  - 最终 `c50036ac35a4a87c52b825f280d1afc1a9d54784`：
    [`CI` 30059969045](https://github.com/wangbinquan/agent-workflow/actions/runs/30059969045)
    **28/28 jobs success**；
    [`integration-opencode` 30059985690](https://github.com/wangbinquan/agent-workflow/actions/runs/30059985690)
    **3 pass / 15 assertions**（whole workflow **5 pass / 5 skip / 0 fail /
    19 assertions**）；
    [`Visual Regression` 30059987003](https://github.com/wangbinquan/agent-workflow/actions/runs/30059987003)
    与
    [`git-protocols-e2e` 30059988422](https://github.com/wangbinquan/agent-workflow/actions/runs/30059988422)
    均为 terminal success。该 SHA 是关闭 T32 的绿色发布证据。

## 8. 完成定义

- [x] proposal AC1–AC10 全有自动化证据；
- [x] unknown/fake binary、identity/source/session/file-symlink 任一攻击都在模型结果
      前 fail closed；
- [x] runner、distiller、smoke 无 direct OpenCode bypass，且取消/超时无 orphan；
- [x] 三入口、UI/probe/save 的 unsupported/null-model 行为一致且可操作；
- [x] full gates、compiled binary、official integration、Codex impl gate 全绿；
- [x] commit trailer 已核验，remote `main` 含该 SHA，exact-SHA CI terminal green；
- [x] `STATE.md` 与 RFC 状态仅在发布证据完成后宣称 Done。
