# 审计 backlog 与未决项（多人协作）

> 全仓各专项审计的**索引 + 未决项**，从个人 memory 汇入代码仓供全体可见。大多数审计有独立报告在 `design/*-audit.md`；本文件是总览 + 承载**没有独立报告的发现**（尤其权限/安全审计）。改动前重读对应 `file:line` 确认未被并发 session 动过。

## 审计报告索引（`design/`）

| 报告                                                              | 主题             | 状态 / 未决                                                                                |
| ----------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `design/scheduler-audit-2026-06-10.md`                            | 调度专项深查     | 2 P0 + 9 P1；WP-1~10 路线；重构走 RFC                                                      |
| `design/dedup-audit-2026-06-13.md`                                | 全仓重复实现     | 68 确认 + 4 伪重复；9 处已漂成 bug；路线 §5                                                |
| `design/flag-audit-2026-07-07.md`                                 | 标志位控流       | 六大 P0 + ≥12 真 bug + RFC-G1~G10；**§8 有 3 决策点待用户拍板**                            |
| `design/frontend-primitive-audit-2026-07-21.md`                   | 前端公共原语     | 160 确认 / 91 驳回；头号=三态闸门 + ErrorBanner 缺 onRetry；5-RFC 路线（部分已落 RFC-214） |
| `design/test-guard-audit-2026-07-21/`                             | 测试防护缺口     | 131 缺口 / 9 逃逸机制 / 15 结构守卫；加固批已落 + RFC-212（WS 授权撤销，方案 D）           |
| `design/ux-audit.md` · `design/ux-functional-audit-2026-07-16.md` | UX / 功能        | 见报告                                                                                     |
| `design/workgroup-e2e-audit.md`                                   | 工作组 e2e       | 见报告                                                                                     |
| `design/codex-impl-gate-misc-2026-07-22.md`                       | Codex 实现门杂项 | 见报告                                                                                     |

## 运行时 / 沙箱能力收口盘点（2026-07-31，RFC-237 root 事故后自查）

> 问题背景：root 部署事故暴露「claude env 三处手拼、生存性注入漂移」。本节回答「opencode / claude-code 的运行时与沙箱能力是否已完全收口」——**核心执行链已单点化 + 防漂移锁；剩余豁口均为已知、已登记、有意分期，非静默漂移**。

**已收口（单一权威点 + 锁）**：spawn 入口 = `RuntimeDriver.buildSpawn/buildBusinessSpawn`（RFC-143，runner/smoke/distiller/systemAgentRun 零手搭）；运行时判别 = `narrowedSystemPermissionProfiles` 能力声明 + rfc143 强化源码锁（`!==`/`kind`/`defaultRuntime` 形态全盖，allowlist 显式）；二进制封印 = `runtime/binarySnapshot.ts` 单模块（opencode 旧名 re-export、claude intent 分支、claude mcpTest、opencode mcpTest verified 链全部经它，rfc224 callSites 锁）；claude env = `assembleClaudeEnv` 单装配点（uid 依赖注入可测 root 行为、目录级 env-surface ratchet 禁第四份变体）；会话捕获 = driver 能力方法三件（captureSessions / captureSessionsToSink / startLiveCapture）；containment 准入 = `ContainmentCoordinator.admit()` 单一事实源（RFC-233，driver 只声明 profile，bwrap/Seatbelt 渲染 `sandbox/policy.ts` 单点）；opencode verified 执行身份全套（单 builder / serve 单 owner / hermetic env / store owner-lease，`rfc224-source-reachability` 整卷锁）；claude 凭据桥 = `prepareClaudeConfigDir` 单点（仅 credentials 文件）。

### ✅ 已收口（2026-07-31 批）

- **claude argv 双拼** → `claudeDeclaredControlArgv` + `CLAUDE_HEADLESS_BASE_ARGV` 单点（`runtime/claudeCode/spawn.ts`）；`mcpTest.ts` 改经它，字节等价已锁；env-surface ratchet 扩展到 argv 控制面。
- **models 列举 opencode 分支在路由层** → 搬进 `runtime/opencode/models.ts`（hermetic 快照 + source guard + cache fence 原样内聚），路由变 kind-blind，rfc143 allowlist 中 `routes/runtime.ts` 条目已摘除；测试注入 seam 显式化为 `ListModelsOpts.testOnlySnapshot`。
- **`validateBinaryPath` 弱校验** → 保存期对齐 exec 期封印契约（单一绝对规范路径 或 无分隔符 PATH token；拒相对片段/`..`/尾斜杠/带参数串），仍不做文件系统存在性检查（TOCTOU 假象 + 阻断「先配置后安装」）。
- **bwrap 祖先链诊断** → `RootOwnedBwrapQualificationError.finding` 结构化定位（level/path/uid/mode/violation），判定本身未放松；runner 镜像漂移这类事件可一眼归因。

### ⏳ 未决（→ RFC-242 三件套已落档，待用户拍板三个决策点）

- ✅ **`all-deny` 名实不符** 已收口（RFC-242 T4 / PR-1）：claude 系统面（distiller / smoke / intent）物化为 `--tools ""`，并引入显式 `surface: 'system' | 'business'` 分流——业务面刻意保持 RFC-111 形状（用户决策：存量零破坏），泄漏由测试锁防复发。
- ✅ **无平台级网络围栏** 已收口（RFC-242 T5 / PR-3）：**受控** claude 业务节点（agent 声明了 permission）的**启用 local MCP** 现在落入平台无网边界——`claudeCode/netlessMcp.ts` 复用 opencode 既有的 `materializeNetlessWrapper`（0500 wrapper + 0400 manifest）+ `__opencode-netless-subprocess`（stdio 全 inherit），`--mcp-config` 的 local 条目改指 wrapper；containment profile `opencode-verified-v1` **重命名**为运行时中立的 `model-child-netless-v1`（单一 bundle，两 driver 各按需申请；`verifiedManifest` 的 id 字面量判断改为从注册表 `childBoundary` 派生）。macOS 实测：fenced 子进程 `curl` = 000、worktree 写入正常、`$HOME` 落在私有 scratch（gated 测试 `RUN_SANDBOX_ITEST=1`）。**残留（有意）**：未声明权限的存量节点仍不设围栏（用户决策：存量零破坏，收窄靠 `unconstrained` 告警驱动）；**放行 Bash 的受控节点也不设围栏**——实测 macOS 嵌套 `sandbox-exec` 不可行（`sandbox_apply: Operation not permitted`），故 child boundary 会顶掉 runner outer sandbox；claude 的 Bash 子进程尚未走 wrapper（design §4 C-2 未做），此时下围栏等于用 shell 的文件系统边界换 MCP 的网络边界，净亏，故保留 outer 并打 `claude-mcp-netless-skipped` 告警。**C-2 是解除该排除项的唯一前提**。
- 🔁 **RFC-242 T5 复核修复批已上库**（对抗性安全复核 + Codex 实现门各一轮，两边独立命中同两条）：2 个逃逸（伪造 `.git` 指针劫持 git 可写 allow-back；scratch 子目录 symlink 重入劫持 HOME/TMPDIR）+ 6 个功能回归/静默降级（npx 解释器丢失且失败静默、合法 env key 硬失败、相对命令解析基准、git 身份丢失、密钥仍进 bwrap argv、preSpawnVerify 只验形状、需求↔物化判据漂移）。逐条与红/绿证据见 `design/RFC-242-.../design.md §4.5`。**路径投影已提取为单一权威** `services/runtime/netlessProjection.ts`（两运行时共用，差异用显式参数表达）——重复实现正是那条逃逸的根因。
- ✅ **受控 claude 节点的 MCP 工具全被拒** 已修（随 RFC-242 T5，实测发现）：`--permission-mode dontAsk` 下 MCP 工具必须命中 `--allowedTools` 才可调用（claude 2.1.220 实测：`Permission to use mcp__x__y has been denied because Claude Code is running in don't ask mode`）——`--tools` 只管内置装载集。PR-2 的受控业务形状没下发 allowlist，等于**声明了 permission 的 claude 节点一个 MCP 工具都调不动**（存量 `bypassPermissions` 形状放行一切，故只有受控节点中招）。现按节点自己的 MCP 名字下发 `mcp__<name>__*`（不用宽泛 `mcp__*`）；同一次实测确认内置工具的 cwd 自动放行不受影响。
- ⏳ **macOS 上被围栏的 claude 节点失去 runner outer sandbox**（RFC-242 T5 复核 P1-2，**已澄清、未消除**）：`model-child-netless-v1` 在 Seatbelt provider 上是 `provider-child-only` 拓扑（嵌套 `sandbox-exec` 不可行），child 边界**只包 local MCP 子进程**，claude 主进程（Read/Edit/Write/WebFetch **进程内**执行）此时无任何平台文件系统边界，只剩 `--tools` + `dontAsk` cwd 判定这层运行时内约束。**这不是 claude 独有**：verified opencode 的 write/edit 同样在 server 进程内（`opencode/packages/opencode/src/tool/write.ts` 用 FileSystem 服务不 fork），RFC-227 早已对它做同一笔交易（`sandbox/index.ts:114-131` 注释即此）。Linux 无此问题（`runner-outer-and-child` 两层共存）。**本轮已做**：design §4.3 措辞更正（原文"outer 由 child Seatbelt 取代"不准确）+ 每节点打 `claude-mcp-netless-outer-dropped` 告警。**未采纳"暂不申请该 profile"**：driver 不得按 provider/OS 分叉（RFC-227），要按能力区分就得在 RFC-233 coordinator 新增一档 childBoundary，而它在 macOS 上只能收场为「receipt 报 contained 却不施加 child 边界」（RFC-227 明令禁止）或「`enforce` 下 blocked」（拦死今天能跑的任务）——都比现状差。**正解 = C-2（Bash 走同一 wrapper）**，届时 macOS 也能把全部模型可控子进程收进 child 边界，交换消失。
- ⏳ **预览与准入的 MCP 集合不一致**（RFC-242 T5 复核 P2-8，**未修，仅登记**）：`services/task.ts:1394-1400` 的启动期 containment 预览按 `agent.mcp` 取 MCP，`services/runner.ts:1049-1053` 的实际准入按 **dependsOn 闭包并集**取 → 两边可能算出不同的 containment profile，`enforce` 下会「放过 launch 再在 dispatch 拦住」。opencode 同形（**既有**问题，非本切片引入），claude 因新申请 profile 而**新可达**。正解是两侧共用同一个闭包解析函数（`scheduler.ts` 的 MCP 预载已有闭包逻辑可复用），属独立切片：预览是 UX 早拦、准入是权威，二者输入必须同源。
- ⏳ **remote MCP 的 header 仍在业务 argv 里**（RFC-242 T5 复核 P2-5 的另一半）：local MCP 的密钥已随本轮改动完全离开 argv（manifest + bwrap 进程 env），但 remote 条目的 `headers`（含 `Authorization`）仍随 `--mcp-config` 的 inline JSON 进 claude 的 argv，宿主上任何 `ps` 可见。remote 没有子进程可包，故不能复用 wrapper 那条路；正解是给 claude 走**配置文件**而非 inline JSON（需确认 claude 的 `--mcp-config` 是否接受文件路径——**须读 claude 实测**，不靠记忆）。
- ⏳ **隐藏子命令与 daemon 共用 `main.ts` 顶层 import graph**（RFC-242 T5 实测登记，未修）：`__opencode-netless-subprocess` 每次被 fork 都要付整个 daemon 的 import 成本——dev 模式（`bun run src/main.ts`）首答 ≈ **210ms**，裸 bun ≈ 10ms，生产单二进制热态 ≈ **140ms**、**冷态首次 ≈ 646ms**。而 claude **在 init 事件冻结 MCP 可用性**（裸 server 加 sleep 对照：`0s → connected` / `0.3s → pending` / `1.0s → pending`，pending 的工具整回合不出现），于是：dev 模式常态偶发丢 MCP 工具；生产热态稳定 connected，但**升级/首次部署后的第一个受控 MCP 节点**实测会 `pending`。正解：把 CLI 子命令改成惰性 `await import`，让隐藏子命令只加载自己需要的模块；同样惠及 opencode local MCP 与 RFC-238 playground。
- ✅ **业务侧 `preSpawnVerify` 空转** 已修（随 RFC-242 T5）：`SpawnPlan.preSpawnVerify` 自 RFC-237 起只有 `systemAgentRun` 会 await，`runner.ts` 业务路径从未调用——T2 的封印二进制 TOCTOU 复检一直没生效。现在 `Bun.spawn` 前 await，identity code 经 `executionIdentityFailureCodeOf` 保真上报（runner 级红绿锁：`rfc242-claude-netless-mcp.test.ts`）。
- ✅ **claude 业务节点世代差** 已收口（RFC-242 T1-T3 + T6，`design/RFC-242-claude-runtime-security-parity/`）：声明了 `permission` 的业务节点现在执行封印副本（`preSpawnVerify` 边界再验）、controlled env、以及由 `claudeCode/permissionMap.ts` 冻结映射表推导的 `--tools` 工具门；核心矛盾（`agent.permission` 是 opencode 词汇的 verbatim 透传、claude 无等价词汇，`shared/schemas/agent.ts:196`）由该映射表显式回答，`ask`→deny+告警、未知键 fail-closed、模式规则保守收敛并披露粒度损失。**未声明权限的存量节点按用户决策（2026-07-31）保持全权 + `claude-business-unconstrained` 告警**——这是有意保留的逃生阀，不是漏网：T6 的防复辟 ratchet（`rfc237-claude-env-assembly.test.ts`，含变异实证）锁死「已声明权限的节点绝不退回 bypassPermissions」，且「只有空声明 `{}` 才走非受控形状」，任何把逃生阀扩大的改动都会红。
- 设计接受项（已声明差异、非漂移）：claude 无 same-instance attestation（docs + 设置页附注已标）。

## 权限 / 安全审计（2026-07-15，7 路并行）——**无独立报告，全文在此**

RFC-099 资源 ACL + 任务成员制 + auth 层全面审计。骨架扎实（单一事实源 `services/resourceAcl.ts`、admin 按 identity 不按 permission、RFC-170 OCC CAS 无 check-then-write 缝、prompt 归属隔离双锁、五资源 detail 404 同形防探测、禁用/降权每请求即时收敛）；缝集中在**非 HTTP 旁路 + 后备旧路由 + 前后端门漂移**。多项被 2-3 路 agent 独立命中（可信度高）。

### ✅ 已修复并推送（origin/main 硬验证）

- 后端 `bda0d4fb`：worktree-files 缺门 + symlink 逃逸、OIDC 开放重定向、repos 任意路径、retryNode 先 CAS 后校验、workgroup addMembers 不落 collaborator（均带红→绿回归）。
- 前端 `fb7ccda3`：memory 门 `usePermission→useIsAdmin`、登出 `queryClient.clear` + IDB 草稿清理 + draftStore 改名（前端 4296 测试绿）。

### ⏳ 未决 P0（**安全，待用户拍板**）

- **cached_repos 明文 URL 含 git 凭据跨用户泄漏**：`services/gitRepoCache.ts:182` `rowToCached` 同时上 `url`(明文)+`urlRedacted`；wire schema `shared/schemas/cachedRepo.ts:7-8` 自注 "may contain credentials"；`GET /api/cached-repos`（`repos:read`=全体登录用户）返回明文。私有仓 PAT 塞 URL 是既定接入方式 → **任意登录用户可拉全体凭据**。
  修复触及 launch 复用契约（前端 `RepoSourceRow` 用明文 url 作 repoUrl 回填、后端按 `url_hash` 复用）——正解需**凭据移出 URL** 或 **launch 改按 `cachedRepoId` 复用**，非纯 bug 修复，故待决策。

### ⏳ 未决 P2（一致性 / least-privilege / 审计）

- ✅ **workgroup 六资源中唯一无 method 权限点** 已收口（RFC-247 T2）：`workgroups:read/create/update/delete/execute` 五点落地，等价照搬现状（全给 user 基线）。
- ⏳ **插件安装在 containment 之外、继承完整 daemon env**（RFC-247 设计门 P0 的**残留**一半）：`services/pluginInstaller.ts:600-602` 用 `spawn(bin, args, { env: process.env })` 跑 npm，不经任何 RFC-205/227/233 provider。RFC-247 已加 `--ignore-scripts` 堵掉生命周期脚本这条最直接的 RCE，但「npm 自身 + 被安装包在宿主上以 daemon 身份运行且能读全部 env」仍在。正解是把 npm 安装纳入 provider 边界，属独立切片。
- ⏳ **`shared/schemas/mcp.ts:88-91` 的注释断言已过期**：它写「opencode `McpLocalConfig` 没有 `cwd` 字段，所以我们故意不做」，但 opencode 现在的 `Local` schema **有 `cwd`**（`core/src/v1/config/mcp.ts:11-13`，"Relative paths resolve from the workspace directory"）。不影响当前行为（我们不下发 `cwd`，opencode 用进程 cwd = worktree），但基于过期断言做决策有风险。
- ⏳ **`/ws/repo-imports/:batchId` 是一条完全无 gate 的频道**（`ws/registry.ts:653-670`，spec 自陈 "no gate of any kind (RFC-152 D4)"、"Batch-ownership validation is a registered leftover"）：任何持有效凭据者猜到 `batchId` 即可看他人仓库导入进度。RFC-247 只把 **PAT** 挡在门外（避免把它降格成「一枚泄漏令牌即可远程利用」），**session 侧的洞未修**——补 batch-ownership gate 需重放 RFC-152 D4 的设计讨论。
- ✅ **空 PAT scopes = 全量 role 权限** 已收口（RFC-247 T5）：`auth/actor.ts` 的 `patScopes.length>0` 短路删除，PAT 分支恒走 `resolveTokenPermissions`，空矩阵 = 只读。
- ✅ **任务操作面无写权限点 / `tasks:cancel:own|all` 零引用死点** 已收口（RFC-247 T2）：两个死点从目录删除；cancel/resume/retry 归 `tasks:execute`，范围仍由 `canViewTask` 承担（这正是代码一直以来的真实行为）。
- ✅ **`GET /api/mcps/:id` 明文返回 `config.env` / `headers` / `oauth.clientSecret`** 已收口（RFC-247 PR-3）：`redactMcpRecord` 此前只写了规则、没有任何调用方（PR-2 的「已接两条出口」只对 `redactGitUrl` 那半成立）；现补 `serializeMcpFor(record, source)` 作为唯一出口，接在 `routes/mcps.ts` 五个序列化点。仅对 PAT 通道脱敏，session 读原值（人能打开编辑器，藏字节只是 UX 退步）。**发现路径**：写 MCP 工具测试时意识到 `resource_read(kind='mcps')` 会把它直接送进模型上下文。
- ⏳ **`redactSensitiveString` 漏掉带前缀的环境变量名**（RFC-247 实现门顺带发现）：`SENSITIVE_KV_RE` 是 `\b(token|api_key|…)\b`，而 `_` 是词字符 ⇒ `\bapi_key\b` **不匹配** `OPENAI_API_KEY=…`。而「agent stdout 回显环境变量」正是它要防的主场景。未在 RFC-247 内放宽：该正则同时被 RFC-030 的 MCP 探针持久化与 daemon 日志共用，松词边界会连带影响它们的过度遮蔽风险，属那两处 owner 的决定。缺口已在 `rfc247-token-redaction.test.ts` 里用一条**显式断言**锁住（写明是 KNOWN GAP），改动时会立刻看见。
- ⏳ **`RFC-227 REAL macOS Seatbelt provider (gated)` 在 hosted macOS runner 上间歇性红**（2026-08-02 观测）：commit `1e87b6a1` 的 `Backend tests (macos-latest shard 2/4)` 挂在「denies app secrets, seal writes, and child network while preserving worktree writes」；**同一 shard 在严格包含它的 `f67db859` 上是 success**，且该轮改动完全没触及 containment。登记而非当噪音略过，是因为 CLAUDE.md 禁止「重跑就过了」作通过依据——需要它的 owner 判定是真时序缺陷（真实 `sandbox-exec` 子进程 + 网络探测本就时序敏感）还是 runner 环境抖动。复现线索：失败耗时 5034.88ms，接近某个 5s 超时。
- ⏳ **MCP 收敛工具只覆盖 CRUD**（RFC-247 实现门 P2）：`resource_read`/`resource_write` 的 `method` 枚举只有 list/get/create/update/delete，因此 workflow copy·export、workgroup rename、repo refresh、memory archive·unarchive 这些**已对令牌开放**的路由，MCP-only 客户端够不着。要么扩 method 枚举，要么给它们具名工具——属 v2 的「MCP 面做多宽」范围，本轮未做。
- ⏳ **MCP 缺 review 逐文档操作与 clarify 子集/延后**（RFC-247 实现门 P1/P2）：`submit_review` 只有整轮决策，PATCH 选择与 POST 锚定评论够不着；`answer_clarify` 表达不了 `defer` / `questionIds` / `resubmitQuestionIds`。多文档评审与逐题分派在 MCP 上因此不完整。
- ⏳ **令牌审计查询未下推 SQL**（RFC-247 实现门 P2）：`listTokenAudit` / `listTokenAuditForUser` 全表 select 后在内存里 filter+sort+slice。90 天保留期下调用量一大就是无界延迟与内存，`(user_id, created_at)` 索引白建。应改 `WHERE`/`ORDER BY`/`LIMIT` 下推。
- ⏳ **`/api/docs/api` 与 `/.well-known/mcp` 用请求 URL 推导 origin**（RFC-247 实现门 P2）：TLS 终止或反代重写 host/proto 时，`c.req.url` 拿到的是 daemon 内网 origin，生成的客户端片段与 discovery URL 不可用。应走 `publicBaseUrl` / forwarded 头，或前端用 `window.location.origin` 渲染。
- ⏳ **生成文档未含请求体 schema 与错误码**（RFC-247 实现门 P2）：`buildApiDocs` 丢掉了每个工具的 `inputSchema`，路由侧也没有 body/query/错误码，读者无法只看 wiki 就构造请求。`describe_resource` 已在实现门修复中补上派生 JSON Schema，同一套派生可以接进 wiki。
- ⏳ **`/.well-known/mcp` 不反映开关状态**（RFC-247 实现门 P2）：`mcpSurfaceEnabled=false` 时该文档内容不变，客户端照着接过来每次都被拒。应把实时开关状态发布进 discovery。
- review 评论 PATCH/DELETE 不验作者不留痕 + delete 无 decided 冻结（对照 update 有）。
- `updateTaskMembers` 缺 OCC + in-tx active（`resourceAcl` RFC-170 已修、成员面没跟）；`buildLaunchCollabRows` 不排除 `__system__`。
- WS 连接 actor 升级期钉死：撤销/降权/移出成员不断开在连，clarify 帧含全量问答（→ RFC-212 方案 D 处理）。
- 导入单向放宽 visibility：`workflow.ts:54` / `skill-zip.ts:430` 硬编码 public → 私有资源导出再导入静默转公开。
- memory admin 门谓词漂移：前端 `usePermission('memory:approve')`（`memory.distill-jobs.$jobId.tsx:43` / `MemoryPendingBadge.tsx:35`）因 D12 并入 `USER_BASELINE` 恒 true → 普通用户 WS 无限重连 + badge 拉全体候选；对照 `memory.tsx:47` role 判定正确。
- 前端详情页(agents/skills/mcps/plugins/workgroups.detail)不按 owner 做写门 → 非 owner 可编辑、编辑器拖动即撞 403；`acl-*` 错误码全无 i18n（英文裸串）；`AclPanel` 409 后知情整表覆盖；builtin 前端零感知。
- workgroup confirm/dw-confirm 门决策不落决策人归属（对照 review D7）。

### ⏳ 未决 P3（选摘）

`sweepExpiredSessions` WHERE 重复谓词(`sessionStore.ts:139`)；`resource_grants` 无删除清理(孤儿累积，ULID 不复用故无越权)；`searchUsersPublic` disabled 过滤 `|| excluded.size===0` 语义耦合；403 回带 `actorPermissions`；token 可 `?token=` query；OIDC allowlist `endsWith` 后缀混淆(`provisioning.ts:62`)；邮箱大小写不归一；运行时子进程继承全 `process.env`；403 vs 404 存在性口径混杂；协作草稿 PUT catch-all 吞错；401 不自动跳登录。
前端抽取机会：`AclPanel`↔`TaskMembersPanel` ~150 行复制且漂移(后者缺 onError refetch)、`useIsAdmin()` 身份门 hook、`RoleBadge`(admin 配色三处矛盾)、表单命名空间清剿(4 套平行 input)、`UserPicker` 键盘/ARIA 照抄 `MultiSelect`、`ConfirmButton` 铺到破坏性单击。

> ⚠️ 此环境曾持续污染工具输出回显（幻觉/自相矛盾）。只信 git 硬命令 / 单整数 grep / 测试 pass-fail 计数 / exit code；提交后用 `git cat-file` / `git log origin/main` 验真落地。

## 其他 backlog

- **`worktreeFiles.ts` symlink TOCTOU（RFC-239 设计门二轮 Codex 发现,P0 级模式)**:`packages/backend/src/services/worktreeFiles.ts:184-215` 是 check-then-reopen——先 realpath containment 检查、随后按原路径重新 open;非终态任务的 agent 可在两步之间把路径换成 symlink 实现越界读。RFC-239 T7 会引入句柄内检查的 `openContainedFile`(open 后在同一 fd 上 fstat/containment/size/NUL 再读)供新端点使用;**存量 `worktreeFiles.ts` 迁移到该 helper 待办**(含检查后换链的 seam 测试)。
- **依赖漏洞门禁「无数据放行」**（RFC-230 期间发现并修）：`scripts/audit-gate.ts` 取不到可解析的 audit 报告时（registry 返回空 / 请求失败 / bun 解压失败且救不回来），**重试 3 次后放行并打 `::warning::`**。bun 不给结构化信号，无法区分「真的没有公告」与「请求没成功」，若改成 fail-closed，一次 registry 抖动就会卡住所有合并。代价：那一次构建等于没扫。**正解**是换一个能明确区分二者的数据源（GitHub Dependabot alerts API / osv-scanner），届时改成 fail-closed。
- **CI 提速**：macOS `check`(870s) 是瓶颈且 gate 一切；backend 738 文件串行（`--parallel` 死锁全套，daemon flock）；安全赢 = 跨 runner 分片 + lint/typecheck 移出 macOS。
- **前端 i18n**：~134 硬编码串已抽 bundle；deferred = 4 RFC-087 结构项 + 4 基建缺口。
- **node_run id 单调性是全仓 freshest-run 前提（RFC-245 设计门 2026-08-01 发现）**：`services/freshness.ts:155-161` 的 `isFresherNodeRun` 是纯 ULID id 比较（RFC-074 PR-C 明定，`isfresher-noderun-baseline.test.ts` 锁等价性），调度器 `latestPerNode`、上游输入选取、`deriveReviewNodeNav` / `deriveClarifyNodeNav` 全部依赖它。但仓内用的是普通 `ulid()`——同毫秒内随机后缀不保证递增，时钟回拨 / daemon 重启也会破坏顺序，理论上可让「更旧的行」比出更大 id。上库前审计另确认任务画布通用状态投影仍按 `startedAt`；RFC-245 只把两个 call kind 改为与导航共用 id freshness（否则新 placeholder 的 `startedAt=null` 会让颜色停在旧代），其余 kind 的状态/抽屉投影也应纳入系统级收口。正解是持久严格递增的 node-run generation/sequence，scheduler 与所有前端消费方共用，不是逐处打补丁。
- **retryNode cascade 不取消下游 call 行的存活子任务（RFC-243 后端缺口，RFC-245 设计门 2026-08-01 发现）**：`services/task.ts:2982-3000` 只读取并取消**被直接重试那一行**的 `childTaskId`；`:3050-3093` 的 cascade 给下游 process kind（含两个 call kind，`node-kind-behavior.ts:161-175` 的 `retryCascade: 'mint-placeholder'`）mint `retryIndex+1` 空行时，不枚举它们仍存活的子任务。可能留下孤儿子任务，甚至随后再起第二个 child 争同一份继承工作区。正解：cascade mint 前枚举受影响 call 行并级联取消，或在存在下游 live child 时拒绝 retry；需配 side-entry 测试。
- **Demo 资产（非仓库代码）**：daemon DB 里有 2026-07-20 建的 11 个 agent + 5 个工作组（三模式全覆盖）；勿误删/重复建。
- **结构化 diff 用字符串前缀承载 repo 身份（RFC-248 设计门 2026-08-02 发现，已定为 deferred）**：`services/structuralDiff/assemble.ts:147` 的 `prefixPath` 把 repo 身份拼进 filePath / symbol id / edge 端点 / impact refs / classEdge / card id / hunkAnchor 七类字段，前端 `lib/changeReview.ts:168-180` 反过来靠路径字符串相等 join 文本 diff 与结构化 diff。RFC-248 只做了最小修复（根成员前缀为空，让两侧逐字符相等），**没有**采纳「给结构化实体加独立 `repoKey` 字段、彻底不用字符串前缀」的正解——那是跨 RFC-089/239/240/241 的承重结构大重构。当前之所以安全，靠的是一条**构造性不变量**：容器仓不可能产出落在某个挂载点前缀下的路径（启动期 `git worktree add` 到已存在非空目录会 fatal ⇒ `repo-group-mount-occupied`，之后又被 `.gitignore` 预置 commit 排除）。若未来放宽挂载点占用校验、或引入允许路径重映射的挂载语义（如 RFC-248 否决过的 symlink 方案），这条不变量即失效，届时必须先做 `repoKey` 字段化。
