# 审计 backlog 与未决项（多人协作）

> 全仓各专项审计的**索引 + 未决项**，从个人 memory 汇入代码仓供全体可见。大多数审计有独立报告在 `design/*-audit.md`；本文件是总览 + 承载**没有独立报告的发现**（尤其权限/安全审计）。改动前重读对应 `file:line` 确认未被并发 session 动过。

## 审计报告索引（`design/`）

| 报告                                                              | 主题                 | 状态 / 未决                                                                                                     |
| ----------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `design/scheduler-audit-2026-06-10.md`                            | 调度专项深查         | 2 P0 + 9 P1；WP-1~10 路线；重构走 RFC                                                                           |
| `design/task-execution-architecture-audit-2026-08-03.md`          | 任务执行**架构**审视 | 7 维 + 对抗复核；72 存活 → 12 issue（2 P0）+ 5 根因 + WP-0~10 路线；**WP-0 是一行配置修依赖门禁失明，必须先做** |
| `design/dedup-audit-2026-06-13.md`                                | 全仓重复实现         | 68 确认 + 4 伪重复；9 处已漂成 bug；路线 §5                                                                     |
| `design/flag-audit-2026-07-07.md`                                 | 标志位控流           | 六大 P0 + ≥12 真 bug + RFC-G1~G10；**§8 有 3 决策点待用户拍板**                                                 |
| `design/frontend-primitive-audit-2026-07-21.md`                   | 前端公共原语         | 160 确认 / 91 驳回；头号=三态闸门 + ErrorBanner 缺 onRetry；5-RFC 路线（部分已落 RFC-214）                      |
| `design/test-guard-audit-2026-07-21/`                             | 测试防护缺口         | 131 缺口 / 9 逃逸机制 / 15 结构守卫；加固批已落 + RFC-212（WS 授权撤销，方案 D）                                |
| `design/ux-audit.md` · `design/ux-functional-audit-2026-07-16.md` | UX / 功能            | 见报告                                                                                                          |
| `design/workgroup-e2e-audit.md`                                   | 工作组 e2e           | 见报告                                                                                                          |
| `design/codex-impl-gate-misc-2026-07-22.md`                       | Codex 实现门杂项     | 见报告                                                                                                          |
| `design/RFC-224-opencode-execution-identity/capability-regression-audit-2026-08-04.md` | RFC-224 能力回退全量裁决 | 6 实锤事故史 + 16 收尾修复；裁决 A/B/C 三栏；4 条 B 候选挂本文末节；RFC-255 进行中 |

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
- ⏳ **RFC-253 有四条验收标准从未实现，而文档一度声称已交付**（2026-08-04 第二轮实现门抓出，proposal 已逐条订正为未交付）：**AC-27 env 值脱敏**——详情/列表直接返回定义、YAML 导出直接序列化、前端明文 `TextInput`，**在它落地前节点 env 不应存放真实密钥**；**AC-32 存量 JSON/YAML 输入框迁移**——`JsonField`/`McpFields`/`PluginFields`/YAML 导入框全部仍是 `TextArea`，只有脚本节点用了 `<CodeEditor>`；**AC-35 读投影**——解释器路径与 depsHash 写进了 `runtime_params_json` 但 `NodeRunSchema` 无字段、DTO 不读，设计门 P1 要求的恰是「光写库不算」；**AC-33 事件同形**——脚本事件 payload 是 `{"line":…}` 包装而 agent 写裸行，导致详情抽屉 pretty-print 成对象、`/stdout` 端点拼出 JSON。另有两处「说了没做」已在代码注释里订正为事实：`containedSpawnRegistry.ts`（Bun.spawn 站点棘轮，plan T11）从未存在、`collectScriptDepsEnvs`（依赖缓存 GC，plan T25）零调用方且接上前需先跳过在途 `.build-*` 目录。
- ⏳ **RFC-253 的 `scripts:author` 只治理执行的「形状」，不治理流入的「内容」**：敏感投影已覆盖节点自身字段、入边形状与完整 wrapper 祖先链及其循环退出项，但**上游节点的输出内容**天然不在其中——改写上游 agent 的提示词即可改变流进 `AW_PORT_*` 的字节而投影不变。这是结构性的（把内容纳入投影等于让该权限点治理整张图）。因此一个把输入喂进 shell 的脚本，其信任边界等同于它的上游。已在 `scriptNode.ts` 的投影文档里显式声明该范围，不再宣称「覆盖一切改变宿主执行内容的输入」。
- ⏳ **RFC-253 脚本节点是 `filter.*` / `diff.*.textconv` 侧入口的第二个消费者**：`util/gitHardening.ts:29-33` 自陈 `-c` 压不住这族通配名，留作 RFC-252 的独立切片。脚本节点因此存在一条**围栏外**路径——脚本往工作区写 `.gitattributes` + repo-local `filter.<n>.clean`，随后 daemon 侧快照 / merge-back 的 `git add -A` 会在沙箱外以 daemon 身份执行它，这会绕过节点声明的 `network: 'deny'`。**威胁模型差异**：脚本作者按 RFC-253 D19 是 admin/manager（本就具备宿主权限），所以这条链的现实价值是防**依赖供应链**（三方包做坏事），不是防作者。RFC-253 已在 AC-13 显式声明该边界而非宣称覆盖。修复归 RFC-252 的通配名切片。
- ⏳ **RFC-253 脚本进程与 agent 同档地不受「写 appHome 之外」限制**：外层沙箱不是 jail（`services/sandbox/policy.ts`：Linux `--bind / /` 可写、macOS `(allow default)` 只限制 appHome）。脚本节点继承这一姿态，未新增缺口，但也未收紧；收紧属 RFC-252 G2/G3 范围。
- ⏳ **RFC-253 脚本进程在 macOS 上存在 `setsid()` 后代逃逸**：与今天的 agent 完全同档（共用 `killProcessTree` 的进程组语义，Seatbelt 路径无 PID namespace / parent-death）。脚本 fork 后自立进程组即可在父进程退出后继续写工作区。未为脚本单造 macOS 机制，需要 containment owner 决定是否给 `descendantLifetimeBound` 补强保证。
- ⏳ **`shared/schemas/mcp.ts:88-91` 的注释断言已过期**：它写「opencode `McpLocalConfig` 没有 `cwd` 字段，所以我们故意不做」，但 opencode 现在的 `Local` schema **有 `cwd`**（`core/src/v1/config/mcp.ts:11-13`，"Relative paths resolve from the workspace directory"）。不影响当前行为（我们不下发 `cwd`，opencode 用进程 cwd = worktree），但基于过期断言做决策有风险。
- ⏳ **`/ws/repo-imports/:batchId` 是一条完全无 gate 的频道**（`ws/registry.ts:653-670`，spec 自陈 "no gate of any kind (RFC-152 D4)"、"Batch-ownership validation is a registered leftover"）：任何持有效凭据者猜到 `batchId` 即可看他人仓库导入进度。RFC-247 只把 **PAT** 挡在门外（避免把它降格成「一枚泄漏令牌即可远程利用」），**session 侧的洞未修**——补 batch-ownership gate 需重放 RFC-152 D4 的设计讨论。
- ✅ **空 PAT scopes = 全量 role 权限** 已收口（RFC-247 T5）：`auth/actor.ts` 的 `patScopes.length>0` 短路删除，PAT 分支恒走 `resolveTokenPermissions`，空矩阵 = 只读。
- ✅ **任务操作面无写权限点 / `tasks:cancel:own|all` 零引用死点** 已收口（RFC-247 T2）：两个死点从目录删除；cancel/resume/retry 归 `tasks:execute`，范围仍由 `canViewTask` 承担（这正是代码一直以来的真实行为）。
- ✅ **`GET /api/mcps/:id` 明文返回 `config.env` / `headers` / `oauth.clientSecret`** 已收口（RFC-247 PR-3）：`redactMcpRecord` 此前只写了规则、没有任何调用方（PR-2 的「已接两条出口」只对 `redactGitUrl` 那半成立）；现补 `serializeMcpFor(record, source)` 作为唯一出口，接在 `routes/mcps.ts` 五个序列化点。仅对 PAT 通道脱敏，session 读原值（人能打开编辑器，藏字节只是 UX 退步）。**发现路径**：写 MCP 工具测试时意识到 `resource_read(kind='mcps')` 会把它直接送进模型上下文。
- ⏳ **`redactSensitiveString` 漏掉带前缀的环境变量名**（RFC-247 实现门顺带发现）：`SENSITIVE_KV_RE` 是 `\b(token|api_key|…)\b`，而 `_` 是词字符 ⇒ `\bapi_key\b` **不匹配** `OPENAI_API_KEY=…`。而「agent stdout 回显环境变量」正是它要防的主场景。未在 RFC-247 内放宽：该正则同时被 RFC-030 的 MCP 探针持久化与 daemon 日志共用，松词边界会连带影响它们的过度遮蔽风险，属那两处 owner 的决定。缺口已在 `rfc247-token-redaction.test.ts` 里用一条**显式断言**锁住（写明是 KNOWN GAP），改动时会立刻看见。
- ⏳ **`mobile-task-detail` 视觉场景非确定性（2026-08-04 取证）**：RFC-253 推送后 `visual-regression-nightly` 该场景红，1090 像素（1% ）差异，形态是**画布节点整体上移约 30px、横向与页面其余部分逐像素不变**。**同一 SHA `f864d30c` 重跑 attempt 2 直接 success** —— 同样字节两种结果，故属场景不稳而非某次改动引入。排查过程排除了三个候选：RFC-253 新增的 CSS 全部带命名空间（`.code-editor` / `.canvas-node__script-*` / `.script-*`）+ 纯 `--code-*` 变量，命不中只含 input/agent/output 的画布；中间两个提交一个纯文档、一个只碰 shared schema（`agents.network`）。**待验证的成因假设**：`canvas/wrapperFit.ts` 的 `DEFAULT_NODE_SIZE_BY_KIND` 自陈是「xyflow 尚未测量时」的兜底尺寸，若 `fitView` 在测量前跑就会得到不同的垂直居中——这与「只垂直位移、横向不变」的形态吻合。**按 CLAUDE.md「重跑就过了不能当通过依据」登记而非略过**；owner 是视觉门禁那条线（RFC-054 场景 / RFC-250 近期连续在修 Linux 与跨平台视觉门禁）。修法方向：让该场景在断言前显式等待节点测量完成（而非等固定时长），或把相机固定成不依赖测量的确定值。
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

## 沙箱 / containment 功能性审计（2026-08-04，8 路 fan-out + 主 session 逐条复核）

> 触发：用户报「沙箱 RFC 之后引入了一堆功能问题」。按切片切 8 路（策略渲染器 / 准入协调器 / 进程治理 /
> 工作区×git / opencode 受控链 / claude 驱动与系统 agent / 脚本节点 / 前端与测试覆盖）并行审计，
> 主 session 对每条 P0/P1 独立复核（含真实 `git worktree` 复现、`claude --help` 实测、纯函数重建 bwrap argv）。
> **前提**：`sandboxMode` 默认 `warn`（`packages/shared/src/schemas/config.ts:172`），warn 只在机制**不可用**时降级
> ——Linux 装了 bubblewrap 即全量包裹。故以下每条都命中默认部署形态。

**四条根因**（逐条修复挂在下面各 finding）：

1. **放行集是从 cwd 的路径形状「猜」出来的**，不是从本次运行的真实事实推导的（`buildRunSandboxCtx` 的
   「父目录名 == taskId」与「`scratch/{taskId}/.git` 存不存在」两条启发式）。派生 4 条缺陷。
2. **能力收缩没有「影响清单」**（`CLAUDE.md` §RFC 工作流第 7 条今日新增的规则要防的正是这个）：
   收窄动作打掉了自己目标用户的功能，且无告警、无文档。派生 6 条。
3. **沙箱自己出的错记到别人头上**：全仓无一处识别 bwrap 1/125/126/127 与 `sandbox-exec` 64/65；
   包装失败在四条链路给出四种互相矛盾且都错的分类。派生 6 条。
4. **测试落点在纯函数层，真实 bwrap 在主 CI 上零覆盖**：`RUN_SANDBOX_ITEST=1` 只在 macOS shard 设，
   唯一装 bubblewrap 的 workflow 其 push path filter 不含 `services/sandbox/**`。

### 根因 1 —— 放行集靠猜

- ⏳ **(P0) 多仓 / 仓库组任务在沙箱下只放行 `repos[0]`**（三路独立命中）：`isoWorktreePathFor`
  （`services/nodeIsolation.ts:167-176`）对多仓生成 `iso/{taskId}/{nodeRunId}/{挂载路径}`，父目录名是
  **nodeRunId**，永不等于 taskId ⇒ `buildRunSandboxCtx`（`services/sandbox/index.ts:186-189`）只放行第一个仓；
  而 prompt 的 `{{__repos__}}`（`services/scheduler.ts:5583-5592`）照旧把全部成员 iso 路径喂给 agent。
  **后果不对称且 Linux 更糟**：macOS EPERM（响亮）；Linux 上 appHome 是 tmpfs，sibling 路径不存在但 tmpfs
  可写 ⇒ agent `mkdir -p` + 写入全部「成功」、退出即蒸发、merge-back 静默 no-op = 「报告已改完、推上去空空如也」。
  挂根成员作 `repos[0]` 的组因路径少一层恰好蒙对，故存活至今。既有测试
  `tests/rfc205-sandbox-scratch-allowback.test.ts:60-63` 锁的是 canonical 形状 `worktrees/multi/{taskId}/repoA`
  （父目录名确实等于 taskId），**iso × 多仓这一格零覆盖**。
- ⏳ **(P1) 基仓在 appHome 内的另两类任务 git 全废**：同处只写了 `scratch/{taskId}/.git` 一个特例
  （2026-07-22 QGENNV 事故补丁）。未覆盖：①**技能融合引擎任务**基仓在 `fusions/{id}/iter{n}/work`
  （`services/fusion.ts:418,570`），iso 的 `.git` 指向 `fusions/.../work/.git/worktrees/{runId}`，遮蔽后
  `git status`/`rev-parse` 一律 `fatal: not a git repository`（本机真实 git 已复现）；
  ②**scratch 父任务的 call-workflow 子任务** common dir 是 `scratch/{父taskId}/.git`，而 allow-back 按**子**
  taskId 拼路径必然查不到。反证：`tests/rfc205-sandbox-policy.test.ts:57` 专门断言 `fusions` 必须被 deny，
  却没人问过融合任务自己还用不用 git。
- ⏳ **(P1) 脚本节点 `AW_REPOS_JSON` 恒发 canonical 路径**：`services/scheduler.ts:4357` 传
  `r.worktreePath`，而非 readonly 脚本 cwd 在 iso。agent 路径在同文件 `:5583-5592` 就做对了（换成
  `isoWorktreePath`，注释写「otherwise the agent would be told to edit a path outside its isolation」）。
  按 `design/RFC-253-*/design.md:164` 文档使用该变量的脚本，Linux 静默蒸发 / macOS EPERM。
- ⏳ **(P0) `readonly:true` 脚本节点在 wrapper 内跑在错误工作树**：`services/scheduler.ts:4214` 是
  `a.isoHandle?.repos[0]?.isoWorktreePath ?? task.worktreePath`，readonly 档 `isoHandle` 恒 null（`:4046`）
  ⇒ 回落顶层 `task.worktreePath`；而同文件 `:418-427` 明文规定 wrapper 内 canonical 是 `state.scopeRoot`
  并称用 `task.worktreePath` 是「the exact bug this RFC roots out」。wrapper 内先跑节点写的东西只读脚本
  看不见，无报错，静默产出错误结论。
- ⏳ **(P2) 四个 `SandboxCtx` 装配点是四份手抄，三份丢字段**：只有 `services/runner.ts:1392` 消费
  `plan.readOnlyAllowSubtrees`；`runtimeSmoke.ts:240` / `systemAgentRun.ts:222` / `memoryDistiller.ts:972`
  静默丢弃它（及 `networkDeny`/`readOnlyWorktrees`）。今天不炸只因系统计划暂不带插件——一旦带上就原样
  复现 RFC-251 的 Linux 插件 ENOENT，且无任何断言会红。

### 根因 2 —— 能力收缩无影响清单

- ⏳ **(P0) claude 受控节点的 skills 被整体关闭**：`runtime/claudeCode/spawn.ts:230` 无条件发
  `--disable-slash-commands`，而 `claude --help`（本机 2.x 实测）该 flag 的官方释义就是 **"Disable all skills"**
  ——不是注释写的「defense-in-depth against config-dir skills」。同一次 spawn 里还照常 stage skill 整树
  （`spawn.ts:245`）并把 `skill:'allow'` 翻成 `--tools …,Skill`（`permissionMap.ts:72`）。三者互相矛盾。
- ⏳ **(P0) claude 的部分 permission 声明 ⇒ 零工具且无告警**：`permissionMap.ts:110-155` 无 `'*'` 键时
  baseline 为 deny，且纯 deny 声明**不产生任何 warning**。一份从 opencode 直译的 `{bash:'deny'}` 变成
  `--tools ""`（help 原文 "Use \"\" to disable all tools"）。opencode 侧内置 defaults 是 `{"*":"allow",…}`
  后再 merge 用户声明，同一份定义两个运行时语义相反。
- ⏳ **(P1) opencode netless wrapper 丢弃模型给的 `workdir`**：`runtime/opencode/sealedSubprocess.ts:1052`
  硬钉 `--chdir parsed.worktreePath`。opencode 的系统提示明确指示模型用 `workdir` 而非 `cd &&`
  （opencode 源码 `tool/shell/prompt.ts:112`），并据此设置子进程 cwd（`tool/shell.ts:611-613`）——平台把它
  扔掉 ⇒ 命令跑在仓根、相对路径全错、**静默产出错误结论**。monorepo / 多仓任务必中。
- ⏳ **(P1) opencode 本地 MCP 拒绝 PATH token 且不解析解释器链**：`runtime/opencode/verifiedPlan.ts:264-271`
  对非绝对路径直接 `execution-identity-mismatch`；`:153` 固定 `FIXED_NETLESS_PATH='/usr/bin:/bin'` 且只绑
  可执行文件那一个 inode。官方文档形态 `npx -y @modelcontextprotocol/server-*` 保存成功、运行必失败；
  绝对路径的 `#!/usr/bin/env node` 启动器 exit 127。**claude 侧 RFC-242 已修**（`claudeCode/netlessMcp.ts:205-269`
  有 `Bun.which` + shebang 链解析并绑进边界），opencode 侧没跟——且 `verifiedPlan.ts:230-236` 的注释声称
  「opencode 的 `snapshotBusinessToolchain` 做了等价的事」不成立（那只封印 `bun`）。
- ⏳ **(P1，需产品决策 → 建议独立 RFC) opencode 业务 shell 的 PATH = `/usr/bin:/bin`**：
  `runtime/opencode/hermetic.ts:547` + `verifiedPlan.ts:153`，唯一补充是从 daemon PATH 找 `bun` 封一份
  （找不到只 warn）。生产机上 `node`/`npm`/`npx`/`cargo`/`go` 全部 command not found，Code→Audit→Fix 的
  「Code」段大面积失效，且模型只看到 127、无任何提示说明是平台换掉了 PATH。**修它需要新增「管理员声明
  可暴露给业务 shell 的工具链路径」的配置面 + 封印投影**，属能力面而非 bug，走独立 RFC。
- ⏳ **(P1) `agent.network` 半落地**：schema/service 可写可存可导出
  （`packages/shared/src/schemas/agent.ts:252-267`、`services/agent.ts:284,444-445`），但其承诺依赖的
  `model-child-egress-v1` 在 profile 注册表里**不存在**（`services/sandbox/containmentCoordinator.ts:28-78`），
  `networkDeny` 的唯一消费方是脚本节点。写 `network:'allow'` 的 agent 拿不到网、写 deny 的也没围栏，
  而 UI/保存路径零提示。归 RFC-252 G4；**G4 落地前应在保存/导入路径对非空 `network` 显式告警**。
- ⏳ **(P1) `sourceGuard` 祖先黑名单一路扫到文件系统根**：`runtime/opencode/sourceGuard.ts:74-99` 从 canonical
  worktree 逐级 `dirname` 到 `parse(x).root`，`FORBIDDEN_AT_EACH_LEVEL`（`:8-16`）含 `.opencode` / `reference` /
  `references` / `.claude/skills`。worktree 在 `~/.agent-workflow/` 下 ⇒ **`$HOME` 必被扫**。daemon 用户只要
  有 `~/.claude/skills` 或 `~/.opencode`，所有 verified 节点永久 `execution-identity-project-config-unsupported`，
  运维几乎不可能想到是家目录。**收窄扫描范围是安全决策**（需与 RFC-224 owner 确认）；**错误里带上命中的
  具体绝对路径是纯诊断改进，应立即做**。另 `existsUnsafe`（`:43-53`）把 EACCES 也翻成失败。

### 根因 3 —— 沙箱的错记到别人头上

- ⏳ **(P0) `appHome/repos` 不存在时 Linux 每次沙箱 spawn 都硬挂**（三路独立命中）：
  `services/sandbox/policy.ts:299-302` 无条件 `--bind appHome/repos`（`:149` 还把它放进 `allowSubtrees`，
  于是 argv 里出现两对相同 bind），而该目录**只在首次 clone 时创建**（`services/gitRepoCache.ts:617` 是全仓
  唯一 mkdir 点）。全新装机跑 Runtime Test、纯 scratch 部署、记忆蒸馏、脚本依赖安装全都没有它。
  仓内自己的注释就写着「bwrap `--bind` of a missing source path errors the spawn」
  （`services/sandbox/index.ts:200-202`，scratch `.git` 为此加了 `existsSync` 门），镜像目录没加。
- ⏳ **(P1) 包装器失败的退出码分类四路互斥且都错**：全仓无一处识别 bwrap 1/125/126/127 或 `sandbox-exec`
  64/65。verified 路径 → `execution-identity-control-failed`（**永久**失败、不重试、语义指向「控制协议被篡改」）；
  claude/unverified → `${runtime} exited with code 1` 且烧满重试；脚本 → `script-nonzero-exit`；
  冒烟 → `stream-nonconforming`（「二进制不讲协议」）。
- ⏳ **(P1) claude 的 `is_error` 终局结果业务路径零消费**：`parseTerminalResultError`（driver 已实现，
  `runtime/claudeCode/driver.ts:81`）全仓只有 `services/systemAgentRun.ts:680` 一个调用点。生产上鉴权失败 /
  订阅额度 / 网关错误被报成 `envelope-missing`（「没有输出信封」）并**先烧满重试**。这是 2026-08-04 事故
  「错误被吞成裸 nonce missing」的另一半——冒烟侧当天修了，业务侧没修。
- ⏳ **(P1) 脚本节点的 `spawnError` 零读取方**：`services/execution/containedSpawn.ts:89,212,242` 产出，
  全仓 0 处消费；scheduler 只取 `stderrTail`（spawn 失败时恒空串）⇒ 用户看到「脚本进程无法启动」+**空详情**。
  且 `containedSpawn` **未接** 2026-08-04 新增的 `util/spawnDiagnostics.ts:explainSpawnEnoent`
  （wiring 锁 `tests/workspace-missing-fail-fast.test.ts:121-134` 只覆盖 runner/runtimeSmoke/systemAgentRun），
  所以同款「怪罪 bwrap」事故能在脚本节点原样复发，且这次连误导信息都没有。
- ⏳ **(P2) 三档 profile 的准入失败一律报 `script-network-fence-unavailable`**：
  `services/scheduler.ts:4262-4273`——`readonly` 节点被拦时被告知「网络围栏不可用」，用户根本没勾网络。
- ⏳ **(P2) `/api/runtimes/status` 的 containment 状态只算 opencode 行**：`routes/runtimes.ts:234-243` 带
  `row.protocol === 'opencode'` 前置，而 `sandboxEnforceBlocked` 与 containment 准入对所有运行时生效
  ⇒ **claude 行永远不显示被拦**（正是生产机型），首页说可用、任务却接连失败。
- ⏳ **(P1) macOS 脚本节点的 `spawn_binary_path` 记的是沙箱壳，收割器永远杀不掉真实进程**：
  `services/execution/containedSpawn.ts:216` 记**包装后**的 `cmd[0]`，而 `services/runner.ts:1587` 记**未包装**的
  （注释明写是为了让 reaper 能匹配）。macOS 上该值 = `/usr/bin/sandbox-exec`，而 sandbox-exec 是 exec-in-place、
  `ps` 里根本没有它 ⇒ `pidCommandContainsBinary` 恒 false ⇒ `killStaleRunProcessTree` 返回 `command-mismatch`
  一个信号都不发（`util/process.ts:133-145`）。boot reaper 照样把行翻 `interrupted` 并放行启动
  （`services/orphans.ts:147-159`），resume/retry 的「先杀活写者再回滚」前置被静默绕过。**沙箱越健全越杀不掉**。
- ⏳ **(P2) Linux bwrap 下取消的 SIGTERM 宽限塌缩为即时 SIGKILL**：组杀同时送达 bwrap monitor 与 namespace
  内进程，monitor 对 TERM 取默认处置即退出，`--die-with-parent` 随即对 COMMAND 直接 SIGKILL ⇒
  `KILL_ESCALATION_GRACE_MS=10s`（`services/runner.ts:2685`）在 Linux 沙箱运行上名存实亡，内层
  abortSession / 会话库 flush / stdout 尾段只有毫秒级窗口。macOS 无中间层，两 OS 取消语义不一致。**需 Linux 实测复核**。

### 根因 4 —— 自救链断头 + 测试/CI 缺口

- ⏳ **(P1) `sandbox-degraded` 告警点「修复」必然 500**：`services/lifecycleRepair.ts:78-93` 的 `REPAIR_OPTIONS`
  只有 `R1 R2 C1 T1 T2 T3 U1 S1–S6` 十四键，`:137` 是无校验强转 ⇒ 取到 `undefined`，下一行
  `for (const def of defs)` TypeError。而前端对每行**无条件**渲染修复按钮
  （`components/tasks/TaskDiagnosePanel.tsx:183-191`）。
- ⏳ **(P1) 同一告警的 rule/severity 都不在 canonical 枚举里**：`services/runner.ts:152-154` 写
  `rule:'sandbox-degraded'` + `severity:'warn'`，而 `packages/shared/src/lifecycle-alerts.ts:7-32` 的枚举无此 rule、
  severity 只有 `'warning'|'error'` ⇒ UI 逐字显示 `tasks.diagnose.rule.sandbox-degraded` 这样的裸键路径。
- ⏳ **(P1) 该告警永不 resolve**：`services/lifecycleInvariants.ts:531-543` 的 reconcile 只处理 `ownedRules`
  内的行，两组 owner 都不含它；runner 侧只查重不 resolve。沙箱修好后横幅仍在，已完成的任务也仍在。
- ⏳ **(P1) 脚本节点与依赖安装器的降级完全静默**：`alertSandboxDegradedOnce` 全仓只有
  `services/runner.ts:1414` 一个调用点。
- ⏳ **(P2) claude 的四个 containment 告警码只进 daemon 日志**：`runtime/claudeCode/driver.ts:217,223,267,293`
  全是 `ctx.log.warn`，lifecycle_alerts / node_run 事件 / WS / 前端全链零命中。而本文件 §35/§38 正是靠
  「`unconstrained` 告警驱动收窄」——不看日志的管理员永远收不到。
- ⏳ **(P2) 启动期 409 `sandbox-unavailable` 无 i18n**：`services/task.ts:1867-1876` 英文裸串，
  `DOMAIN_PREFIXES` 无 `sandbox-` 前缀。
- ⏳ **(P2) 设置页不展示 reasonCodes；CLI 修复指引从 UI 不可达**：`SandboxCard.tsx:56` 只做 length 判断；
  `services/sandbox/guidance.ts:92-129` 的安装/userns 指引只有 SSH 上机的人看得到。
- ⏳ **(P2) Linux 真 bwrap 行为在主 CI 零覆盖**：`.github/workflows/ci.yml:143-155` 只在 macOS shard 设
  `RUN_SANDBOX_ITEST=1`（注释明写 "ubuntu has no bwrap"）；唯一装 bubblewrap 的 `integration-opencode.yml`
  其 push path filter（`:42-58`）**不含** `services/sandbox/**`、`services/execution/**`、
  `services/runtime/netlessProjection.ts` ⇒ 这些文件的 Linux 行为回归窗口最长 24h（nightly 才红）。
- ⏳ **(P2) runner 层沙箱接线变异不红**：`services/runner.ts:1375-1398`（sessionStore/readOnly*/下传）与
  `:1406-1420`（warn 降级告警触发）整段删掉，现有测试零红。前者一断，RFC-251 的 Linux 插件 ENOENT
  原样复发且无预警。
- ⏳ **(P2) 脚本节点 `network:'deny'` 的真围栏两 OS 均无 real-mechanism 测试**：只有 argv/渲染层断言。

### 附：本轮已求证**不成立**的假设（勿重复挖）

`readonly` 档的 `git status`/`diff`/`log` 实测正常（git 拿不到 index 锁不致命，`add`/`stash` 如期失败）；
opencode 的 HOME/XDG/TMPDIR/store 全在 storeRoot 下且被并进放行集，**session resume 不会因 tmpfs 丢失**；
`--unshare-pid` 不破坏组杀（monitor argv 含内层命令，shape gate 命中）；32 仓的 Seatbelt profile 与 bwrap argv
离 `ARG_MAX` 还差三个数量级；`--unshare-net` 的 netns 有 lo（Linux 侧默认 down，需实测）；
`maskDiagnosticsText` 不会误屏蔽沙箱错误文本（反而欠屏蔽 `NAME=value` 形态）；
Seatbelt 的 appHome deny 不影响 allow 子树内的目录枚举 / `realpath` / `getcwd`（只影响逐级 stat 路径前缀的实现）；
`limits.ts` 不统计进程树（只算时长与 token），与沙箱拓扑无关；沙箱多一跳不造成 stdout 缓冲丢尾。

## 其他 backlog

- ⏳ **存量任务的 canonical worktree 指向 `iso/` 的成因未定（2026-08-04 Linux 部署事故）**：真实
  部署日志显示某任务的 `tasks.worktree_path` 落在 `~/.agent-workflow/iso/{taskId}/{nodeRunId}`
  （每次运行后清理的临时隔离空间），目录消失后节点以误导性的
  `posix_spawn '/usr/bin/bwrap'` ENOENT 风暴式失败。**当前 HEAD 无任何代码把 iso 路径写回
  canonical 列**（已 grep 证实只读不写），成因待部署侧确认（DB 是否从旧机器/旧版本迁移、repo
  是否直接登记了 iso 路径、或旧版本 bug）。防线已落：`createNodeIso` 对缺失 canonical 抛
  `CanonicalWorktreeMissingError` fail-fast（`workspace-missing-fail-fast.test.ts` 锁定），存量坏行
  的处置是 cancel 后重建任务。若部署侧证据指向仍在产的写入路径，需回溯补修。
- ⏳ **runNode 内的确定性 spawn 失败仍按节点配置烧满重试**：iso-setup 类失败已在重试循环**之前**
  fail-fast（2026-08-04 修复），但「runtime 二进制被删 / binaryPath 配错」这类发生在 runNode
  **内部**的 spawn 失败位于 mainline 重试循环里，每次重试都重新 admission + spawn 再失败（事故中
  为 ~1.4s/发）。如需收敛，应在重试决策处识别确定性失败形态（spawn ENOENT 且探针证实可执行文件
  缺失）提前终止；注意别把瞬态（NFS 抖动、二进制正在替换）误判为确定性。
- **`worktreeFiles.ts` symlink TOCTOU（RFC-239 设计门二轮 Codex 发现,P0 级模式)**:`packages/backend/src/services/worktreeFiles.ts:184-215` 是 check-then-reopen——先 realpath containment 检查、随后按原路径重新 open;非终态任务的 agent 可在两步之间把路径换成 symlink 实现越界读。RFC-239 T7 会引入句柄内检查的 `openContainedFile`(open 后在同一 fd 上 fstat/containment/size/NUL 再读)供新端点使用;**存量 `worktreeFiles.ts` 迁移到该 helper 待办**(含检查后换链的 seam 测试)。
- **依赖漏洞门禁「无数据放行」**（RFC-230 期间发现并修）：`scripts/audit-gate.ts` 取不到可解析的 audit 报告时（registry 返回空 / 请求失败 / bun 解压失败且救不回来），**重试 3 次后放行并打 `::warning::`**。bun 不给结构化信号，无法区分「真的没有公告」与「请求没成功」，若改成 fail-closed，一次 registry 抖动就会卡住所有合并。代价：那一次构建等于没扫。**正解**是换一个能明确区分二者的数据源（GitHub Dependabot alerts API / osv-scanner），届时改成 fail-closed。
- **CI 提速**：macOS `check`(870s) 是瓶颈且 gate 一切；backend 738 文件串行（`--parallel` 死锁全套，daemon flock）；安全赢 = 跨 runner 分片 + lint/typecheck 移出 macOS。
- **前端 i18n**：~134 硬编码串已抽 bundle；deferred = 4 RFC-087 结构项 + 4 基建缺口。
- **node_run id 单调性是全仓 freshest-run 前提（RFC-245 设计门 2026-08-01 发现）**：`services/freshness.ts:155-161` 的 `isFresherNodeRun` 是纯 ULID id 比较（RFC-074 PR-C 明定，`isfresher-noderun-baseline.test.ts` 锁等价性），调度器 `latestPerNode`、上游输入选取、`deriveReviewNodeNav` / `deriveClarifyNodeNav` 全部依赖它。但仓内用的是普通 `ulid()`——同毫秒内随机后缀不保证递增，时钟回拨 / daemon 重启也会破坏顺序，理论上可让「更旧的行」比出更大 id。上库前审计另确认任务画布通用状态投影仍按 `startedAt`；RFC-245 只把两个 call kind 改为与导航共用 id freshness（否则新 placeholder 的 `startedAt=null` 会让颜色停在旧代），其余 kind 的状态/抽屉投影也应纳入系统级收口。正解是持久严格递增的 node-run generation/sequence，scheduler 与所有前端消费方共用，不是逐处打补丁。
- **retryNode cascade 不取消下游 call 行的存活子任务（RFC-243 后端缺口，RFC-245 设计门 2026-08-01 发现）**：`services/task.ts:2982-3000` 只读取并取消**被直接重试那一行**的 `childTaskId`；`:3050-3093` 的 cascade 给下游 process kind（含两个 call kind，`node-kind-behavior.ts:161-175` 的 `retryCascade: 'mint-placeholder'`）mint `retryIndex+1` 空行时，不枚举它们仍存活的子任务。可能留下孤儿子任务，甚至随后再起第二个 child 争同一份继承工作区。正解：cascade mint 前枚举受影响 call 行并级联取消，或在存在下游 live child 时拒绝 retry；需配 side-entry 测试。
- **Demo 资产（非仓库代码）**：daemon DB 里有 2026-07-20 建的 11 个 agent + 5 个工作组（三模式全覆盖）；勿误删/重复建。
- **结构化 diff 用字符串前缀承载 repo 身份（RFC-248 设计门 2026-08-02 发现，已定为 deferred）**：`services/structuralDiff/assemble.ts:147` 的 `prefixPath` 把 repo 身份拼进 filePath / symbol id / edge 端点 / impact refs / classEdge / card id / hunkAnchor 七类字段，前端 `lib/changeReview.ts:168-180` 反过来靠路径字符串相等 join 文本 diff 与结构化 diff。RFC-248 只做了最小修复（根成员前缀为空，让两侧逐字符相等），**没有**采纳「给结构化实体加独立 `repoKey` 字段、彻底不用字符串前缀」的正解——那是跨 RFC-089/239/240/241 的承重结构大重构。当前之所以安全，靠的是一条**构造性不变量**：容器仓不可能产出落在某个挂载点前缀下的路径（启动期 `git worktree add` 到已存在非空目录会 fatal ⇒ `repo-group-mount-occupied`，之后又被 `.gitignore` 预置 commit 排除）。若未来放宽挂载点占用校验、或引入允许路径重映射的挂载语义（如 RFC-248 否决过的 symlink 方案），这条不变量即失效，届时必须先做 `repoKey` 字段化。

- **`dynamic-workflow-preview` 的 **darwin** 视觉基线漂移（RFC-248 实现期实测发现，非本 RFC 引入）**：本地 `bun run test:visual` 跑 `RFC-199 deterministic dynamic-workflow preview (light)` 稳定差 **8652 px（ratio 0.01 > 阈值 0.002）**。已用「pin 到 RFC-248 之前的父提交 `ad5d2963` 的分离 worktree + 独立 `bun install` + 独立 `build:binary --include-e2e`」实测过：**改动前后像素差完全相同**，且同一份代码在 **CI ubuntu 的全量视觉跑里 26 passed / 只有 `/repos` 一条红**（`/repos` 那条是 RFC-248 新增分段控件的预期变更，已刷两平台基线）。所以这条是 **darwin 基线自身的漂移**，最后一次刷新它的是 `48eb3df7`（他人的移动端导航改动），推测在字体栈 / OS 版本不同的机器上生成。**未扫进 RFC-248 的 commit**——它不是本 RFC 的改动，按多人协作原则不替他人刷基线。谁下次动这个场景时顺手在自己机器上刷一次 darwin 基线即可；在那之前本地跑全量 `test:visual` 会看到这一条红，**不是回归**。
  - 顺带记一个刷基线的真坑：`bun run build:binary` **不产** e2e 二进制，必须 `-- --include-e2e`（e2e harness 用的是 `dist/agent-workflow-e2e-*`，不是 `dist/agent-workflow-macos-arm64`）。不加这个 flag 就是拿**旧** e2e 二进制刷图——测试会「通过」，但刷出来的基线是旧页面（本次实测踩到：删掉 png 重生成后与旧图**字节完全相同**，才发现渲染的根本不是新代码）。

- **插件与 containment 的关系从未被设计过（RFC-251 Codex 实现门 2026-08-03，P0+P1 各一条，未修）**：RFC-251 按产品决定恢复了 OpenCode 插件支持，Codex 实现门随即指出两条互为表里的问题，**均已核实属实、均未在该 RFC 内修**。
  - **(P0) 插件代码不受任何 containment 约束**：插件由 OpenCode 在 **server 进程内** `import` 并拿到 `Bun.$`；而 server 在 macOS 明确不过 Seatbelt（`services/sandbox/index.ts:117`）、Linux 侧亦未隔离网络（`services/sandbox/policy.ts:184`）。shell / local-MCP 的 no-network child wrapper 完全不介入 ⇒ 恶意或被攻陷的插件可读工作区、起进程、联网外传，`sandboxMode=enforce` 也拦不住。这不是 RFC-251 引入的缺陷，而是「支持插件」这一产品决定的固有代价（插件按定义就是宿主进程内执行的代码，RFC-224 当年禁它的理由之一正是这个）。用户在知情下要求恢复该功能，故未擅自加回限制。
  - ✅ **(P1，已修复 2026-08-03) 反过来，Linux + `enforce` 下插件根本加载不了**：插件装在 `appHome/plugins`，而 `policy.ts` 对整个 `appHome` 打 `--tmpfs` 后只显式 bind 回 `repos`；`allowSubtrees` 是 RFC-205 impl-gate P0-3 刻意的「deny 全部 appHome、只放行本次运行所需」白名单，插件目录不在其中 ⇒ `file://<cachedPath>` 在 server 内不存在，动态 import 得 `ENOENT`。**即插件功能目前在 Linux 上等于没交付。\*\***已实证，非推断**：`computeSandboxPolicy`/`renderBwrapArgs` 是纯函数，Linux 的 bwrap argv 可在任意平台确定性重建；按 argv 顺序还原挂载后，插件路径的最深挂载仍是那层 tmpfs（`visible=false`），而 `repos`/`runDir` 为 `visible=true` 作对照。**修法**：新增 `SandboxPolicyInput.readOnlyAllowSubtrees`——位于被 deny 子树内、不与任何 RW allow 重叠的**只读**放行（两条约束 fail-closed 校验）；bwrap 在 appHome tmpfs 之后追加 `--ro-bind`，Seatbelt 只补 `(allow file-read* …)` 不发 write allow；`verifiedPlan` 只放行**被选中插件\*\*各自的私有根 `plugins/<id>`（最小权限）。真容器复验：`read: OK` / `write: Read-only file system` / repos·runDir 仍可写 / 宿主文件未被篡改。回归锁 `packages/backend/tests/rfc251-linux-plugin-visibility.test.ts`。
  - **为什么合并处理**：修 (P1) 要动 bwrap 的 RW/RO 叠加次序（`readOnlySubtrees` 必须是某个 `allowSubtrees` 的**严格后代**）与 Seatbelt 侧 deny-list 语义，正是 (P0) 所指的那条边界。正解是一次独立设计：插件目录该 RO bind 还是 RW、插件是否应移进 child 边界、以及在 (P0) 无法根除时产品上如何呈现「装插件 = 放弃该层隔离」。**在此之前，Linux 部署上的插件选择应视为不可用。**
  - **⚠️ 与 [RFC-252](../design/RFC-252-agent-containment-hardening-and-egress/proposal.md) 的交叉影响（两个 RFC 同日并发落地，务必一起看）**：RFC-252 的审计实证结论之一是「verified OpenCode 业务 agent **没有** read/edit/write/webfetch 等**进程内**工具」，据此把唯一可直接利用的完整逃逸链收敛到 `bash → gitCommonDirs → git hook → daemon 侧 runGit`。**该结论成立的前提是插件被 RFC-224 禁用**——而 RFC-251 已把插件恢复。插件由 OpenCode 在同一 server 进程内 `import` 且被授予 `Bun.$`，等于在 agent permission 层**之下**多了一个进程内 shell，完全绕过「工具被 deny 即被摘出模型工具列表」这条机制。RFC-252 的 proposal / design 目前**零处**提到插件（已确认），故其威胁模型需要显式纳入「已安装且被选中的插件」这一主体，否则加固后的结论会偏乐观。
- ✅ **（已修复 2026-08-03）多代理的 skill 面是打折的（RFC-251 Codex 实现门 2026-08-03，P1，未修）**：`services/scheduler.ts` 已正确合并 `dependsOn` 闭包的 skills，但 `runtime/opencode/verifiedPlan.ts` 只把冻结的 `SKILL.md` 追加进 **root** persona，闭包成员拿到的是原始 `dep.bodyMd`，而 `skill` 工具本身在受控 permission 里是 deny ⇒ `auditor` 依赖的审计 skill，root 看得到、真正执行审计的 `auditor` 看不到。**已修（2026-08-03）**：密封时按 `skillId` 给冻结块建索引，成员 prompt 追加**它自己声明的** managed skill 冻结块；**只增不减**——root 仍收整个并集（收窄它会改变现有行为，属独立产品决策）。成员声明了并集里没有的 skill ⇒ `execution-identity-skill-mismatch` fail-closed，不静默给无 skill 的 prompt。**没有扩大密封面**（`ctx.skills` 集合未变，只是把已密封的块按归属分发），故原先「需独立设计」的顾虑不适用。回归锁见 `rfc224-verified-plan.test.ts` 的「closure members receive their own frozen skills」。

## RFC-252 残留与旁证（2026-08-03）

- ⏳ **`commit` 子命令豁免 hooksPath 压制**（RFC-252 G1，用户 2026-08-03 拍板的功能优先取舍）：
  daemon 侧自动 commit&push 仍会以 daemon 身份、在沙箱外执行仓库的 `pre-commit` /
  `commit-msg` / `post-commit`。豁免的理由是本仓**有意**依赖该交互——
  `rfc210-publish-failure-hard-fails.test.ts` 用「钩子拒绝自动提交」当触发源锁「发布失败必须
  硬失败，否则 agent 工作的唯一副本会被删」，注释称之为 _an everyday setup_；
  `rfc165-scratch-space.test.ts` S4b 同理。**这是本模块唯一留下的口子，且可达**（agent 写
  `.git/hooks/pre-commit`，等一次自动 commit&push）。根治办法是把自动提交挪进沙箱内执行
  （钩子照跑但在边界内），属独立切片。其余子命令（含 `worktree add` 的 `post-checkout`）
  已压制。

- ⏳ **git 通配名族配置未覆盖**（RFC-252 G1 显式非目标）：`filter.<n>.clean/smudge/process`、
  `diff.<n>.textconv`、local 作用域的 `credential.helper` 都能让 daemon 侧 git 执行外部命令，
  但它们是**通配名**，命令行 `-c` 压不住。无差别关闭会打断用户全局 git-lfs 与凭据助手
  （真实功能损害），正确形态是「先枚举 local/worktree 作用域条目再逐名覆盖，system/global 不动」，
  属独立切片。已覆盖的固定名键见 `util/gitHardening.ts`。
- ⏳ **非 agent 触发的 daemon 侧无沙箱执行面**（RFC-252 设计门 P0-1，已从「恶意 agent」
  威胁模型中剥离、单独登记）：runtime `--version`/models 枚举（`util/opencode.ts`、
  `util/opencode-models.ts`）、local MCP probe（`services/mcpProbe.ts`）、插件安装
  （`services/pluginInstaller.ts`）都在 coordinator 之外以 daemon 身份裸执行。它们需要人经 API
  触发，agent 无法直接驱动，故不属于 RFC-252 的目标；但确实是 daemon 身份的执行面。
- ❗ **`docs/audit-backlog.md` 上文关于 `--ignore-scripts` 的记载与源码不符**（2026-08-03 实测）：
  `services/pluginInstaller.ts:222` 的实际 argv 是
  `npm install --prefix <dir> --no-audit --no-fund --silent <spec>`，**全仓 grep `ignore-scripts` 零命中**，
  且 `runCommand`（`:594-603`）用 `env: process.env` 且不经任何 containment ⇒ 被安装包的生命周期
  脚本会以 daemon 身份执行。上文「RFC-247 已加 `--ignore-scripts` 堵掉这条最直接的 RCE」是错误记载，
  按此判断风险已消除会误导后来人。
- ❗ **RFC-251 的 containment 空洞**（2026-08-03 RFC-252 设计门复核期间发现，属 RFC-251 在飞代码）：
  `driver.businessContainmentProfile`（`runtime/types.ts:643-645`）的入参只有
  `'agent' | 'mcps' | 'runtimeCmd'`，**看不见 `dependsOn` 闭包**。若 root `permission.bash = 'deny'`
  而闭包成员 `bash: 'allow'`，profile 落 `runner-filesystem-v1` ⇒ `childBoundary:'none'` ⇒
  netless wrapper 以 `providerId:'none'` 渲染（`sealedSubprocess.ts:1187-1193`）⇒ **模型可控的 shell
  完全拿不到 netless 边界**（无网变有网、私有 HOME 变弱外层）。RFC-252 的 G4 会把 profile 判定提升为
  closure 级并顺带修掉它；若 RFC-251 先上库，这条就变成存量问题。

## RFC-224 能力回退审计未决项（2026-08-04）

裁决全文：`design/RFC-224-opencode-execution-identity/capability-regression-audit-2026-08-04.md`。
以下 4 条为「受控恢复候选」，按需求触发立项，每条须独立 RFC 且受 `CLAUDE.md` RFC workflow
第 7 条（能力影响清单）约束：

- ⏳ **(P2) OAuth / 订阅凭据受控恢复**：strict 契约现拒一切 `type:'oauth'`（openai ChatGPT
  Plus/Pro、github-copilot、opencode Console、xai 等有完整流；anthropic 流在当前 opencode
  源码未找到——见审计 §3 存疑）。恢复形态 = refresh token 写回密封 store + 内置 auth 插件
  受控加载（现被 `OPENCODE_DISABLE_DEFAULT_PLUGINS` 一刀切）。
- ⏳ **(P2) api+`metadata` 凭据条目受控放行**：provider 插件 callback 会写 `metadata`
  （opencode `provider/auth.ts:203-209`），strictApiEntry 多一键即拒。最小修 = 已知形状校验
  且不透传（或逐 provider 白名单）。
- ⏳ **(P2) 云凭据链 provider（bedrock / vertex / azure / gitlab / cloudflare）**：
  `SAFE_FORWARD_ENV` 15 键白名单 + HOME 重定向使 `AWS_*`、ADC、`AZURE_RESOURCE_NAME` 等
  全部不可达。恢复 = 受控 env 透传白名单 + 逐 provider 行为资格。
- ⏳ **(P3) wellknown 凭据**：并入 OAuth RFC。
