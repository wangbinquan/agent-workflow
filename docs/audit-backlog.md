# 审计 backlog 与未决项（多人协作）

> 全仓各专项审计的**索引 + 未决项**，从个人 memory 汇入代码仓供全体可见。大多数审计有独立报告在 `design/*-audit.md`；本文件是总览 + 承载**没有独立报告的发现**（尤其权限/安全审计）。改动前重读对应 `file:line` 确认未被并发 session 动过。

## 本文件的写法规范（2026-08-15 实撞后立）

1. **登记前先按「症状关键词」搜本文件，不是只搜 `flaky` / `间歇` 这类分类词。** 实撞：一条 `intent-builder` e2e 红被当成新发现登记，而 08-14 的 webkit nightly 条目里**早已一字不差记着同一形态**（「按钮从未出现，不是 detach」）——登记者 grep 的是 `flaky|间歇`,没 grep `intent-builder`。**判据**:用**失败用例的文件名 / 症状原文**搜一遍再动笔;命中既有条目就**补进那条**,不另起——同一件事散成两条，下一个人只会读到其中一条，而那条可能恰好是写错的那条。
2. **「说明还有 X 未解」「疑似还有 Y」「未追」这类措辞是待办，不是免责声明。** 要么**当场追一步给出结论**,要么显式写成一条带 owner 的待办;不允许只留一句观察就翻篇。实撞：08-14 写下「说明该 spec 至少还有第二个竞态未解」后没往下追——而当时查明它**只需要看一眼那个按钮的渲染条件**;代价是 08-15 撞上时从零重建全部上下文（拉 trace、逐条比对 actionability 日志、翻前端条件渲染),外加一条写错方向的 backlog 又返工。**悬案的成本从来不是「留着不管」，是下次撞上时重建上下文，而重建的人未必是当初写下线索的人。**

## 审计报告索引（`design/`）

| 报告                                                                                   | 主题                     | 状态 / 未决                                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `design/scheduler-audit-2026-06-10.md`                                                 | 调度专项深查             | 2 P0 + 9 P1；WP-1~10 路线；重构走 RFC                                                                           |
| `design/task-execution-architecture-audit-2026-08-03.md`                               | 任务执行**架构**审视     | 7 维 + 对抗复核；72 存活 → 12 issue（2 P0）+ 5 根因 + WP-0~10 路线；**WP-0 是一行配置修依赖门禁失明，必须先做** |
| `design/dedup-audit-2026-06-13.md`                                                     | 全仓重复实现             | 68 确认 + 4 伪重复；9 处已漂成 bug；路线 §5                                                                     |
| `design/flag-audit-2026-07-07.md`                                                      | 标志位控流               | 六大 P0 + ≥12 真 bug + RFC-G1~G10；**§8 有 3 决策点待用户拍板**                                                 |
| `design/frontend-primitive-audit-2026-07-21.md`                                        | 前端公共原语             | 160 确认 / 91 驳回；头号=三态闸门 + ErrorBanner 缺 onRetry；5-RFC 路线（部分已落 RFC-214）                      |
| `design/test-guard-audit-2026-07-21/`                                                  | 测试防护缺口             | 131 缺口 / 9 逃逸机制 / 15 结构守卫；加固批已落 + RFC-212（WS 授权撤销，方案 D）                                |
| `design/ux-audit.md` · `design/ux-functional-audit-2026-07-16.md`                      | UX / 功能                | 见报告                                                                                                          |
| `design/workgroup-e2e-audit.md`                                                        | 工作组 e2e               | 见报告                                                                                                          |
| `design/codex-impl-gate-misc-2026-07-22.md`                                            | Codex 实现门杂项         | 见报告                                                                                                          |
| `design/RFC-224-opencode-execution-identity/capability-regression-audit-2026-08-04.md` | RFC-224 能力回退全量裁决 | 6 实锤事故史 + 16 收尾修复；裁决 A/B/C 三栏；4 条 B 候选挂本文末节；RFC-255 进行中                              |
| `design/system-commons-unification-audit-2026-08-12.md`                                | 系统公共功能全局归一审计 | 11 路并行审计；31 新发现 + 9 处登记面失真对账 + 22 条决策台账（D1-D22）；处置=包①随批落地 + RFC-284…289 路线    |

## 运行时 / 沙箱能力收口盘点（2026-07-31，RFC-237 root 事故后自查）

> 问题背景：root 部署事故暴露「claude env 三处手拼、生存性注入漂移」。本节回答「opencode / claude-code 的运行时与沙箱能力是否已完全收口」——**核心执行链已单点化 + 防漂移锁；剩余豁口均为已知、已登记、有意分期，非静默漂移**。
>
> ⚠️ **2026-08-12 对账注记**：RFC-276（2026-08-10）已物理删除 sandbox/containment/netless/verified 机制体系（`services/sandbox/`、`runtime/opencode/verifiedPlan.ts`、`runtime/binarySnapshot.ts` 等均不复存在）。本节条目中依赖这些机制的部分（binarySnapshot 封印、ContainmentCoordinator、verified 执行身份、bwrap/Seatbelt）已失去载体；与机制无关的部分（claude env 装配、会话捕获、models 列举归位等）仍有效。引用前先对照 `docs/OPENCODE_CONFIG.md` 现行契约；逐条重定性已登记为独立欠账（见 `design/system-commons-unification-audit-2026-08-12.md` §7）。

**已收口（单一权威点 + 锁）**：spawn 入口 = `RuntimeDriver.buildSpawn/buildBusinessSpawn`（RFC-143，runner/smoke/distiller/systemAgentRun 零手搭）；运行时判别 = `narrowedSystemPermissionProfiles` 能力声明 + rfc143 强化源码锁（`!==`/`kind`/`defaultRuntime` 形态全盖，allowlist 显式）；二进制封印 = `runtime/binarySnapshot.ts` 单模块（opencode 旧名 re-export、claude intent 分支、claude mcpTest、opencode mcpTest verified 链全部经它，rfc224 callSites 锁）；claude env = `assembleClaudeEnv` 单装配点（uid 依赖注入可测 root 行为、目录级 env-surface ratchet 禁第四份变体）；会话捕获 = driver 能力方法三件（captureSessions / captureSessionsToSink / startLiveCapture）；containment 准入 = `ContainmentCoordinator.admit()` 单一事实源（RFC-233，driver 只声明 profile，bwrap/Seatbelt 渲染 `sandbox/policy.ts` 单点）；opencode verified 执行身份全套（单 builder / serve 单 owner / hermetic env / store owner-lease，`rfc224-source-reachability` 整卷锁）；claude 凭据桥 = `prepareClaudeConfigDir` 单点（仅 credentials 文件）。

### ✅ 已收口（2026-07-31 批）

- **claude argv 双拼** → `claudeDeclaredControlArgv` + `CLAUDE_HEADLESS_BASE_ARGV` 单点（`runtime/claudeCode/spawn.ts`）；`mcpTest.ts` 改经它，字节等价已锁；env-surface ratchet 扩展到 argv 控制面。
- **models 列举 opencode 分支在路由层** → 搬进 `runtime/opencode/models.ts`（hermetic 快照 + source guard + cache fence 原样内聚），路由变 kind-blind，rfc143 allowlist 中 `routes/runtime.ts` 条目已摘除；测试注入 seam 显式化为 `ListModelsOpts.testOnlySnapshot`。
- **`validateBinaryPath` 弱校验** → 保存期对齐 exec 期封印契约（单一绝对规范路径 或 无分隔符 PATH token；拒相对片段/`..`/尾斜杠/带参数串），仍不做文件系统存在性检查（TOCTOU 假象 + 阻断「先配置后安装」）。
- **bwrap 祖先链诊断** → `RootOwnedBwrapQualificationError.finding` 结构化定位（level/path/uid/mode/violation），判定本身未放松；runner 镜像漂移这类事件可一眼归因。

### ⏳ 未决（→ RFC-242 三件套已落档，待用户拍板三个决策点）

- ✅ **`all-deny` 名实不符** 已收口（RFC-242 T4 / PR-1）：claude 系统面（distiller / smoke / intent）物化为 `--tools ""`，并引入显式 `surface: 'system' | 'business'` 分流——业务面刻意保持 RFC-111 形状（用户决策：存量零破坏），泄漏由测试锁防复发。**2026-08-06 探测面按规则 7 显式回退（`probeDispatchShape`）**：冒烟收紧后探测测的是业务节点**从不运行**的形态——fork（CodeAgent/GLM 网关）的网关/模型映射在自家 settings 里，`--setting-sources ""` 把配置层切掉 ⇒ 业务全绿而探测必红（显式传 `--model` 也救不回）。conformance probe 的职责是**预测 dispatch 行为**，现改为构建业务 unconstrained 形状（bypassPermissions + 完整 env/settings）；能力影响：探测子进程回到宽形态——admin-only 路由、二进制本就管理员所选、cwd 为一次性临时目录，风险增量极小。**distiller / intent / commit-push 等系统面保持 declared-control 不变**（锁：`runtime-buildspawn` 探测形态用例 + `rfc237-claude-env-assembly` surface 泄漏锁 + `runtime-smoke` argv 捕获集成锁）。
- ✅ **无平台级网络围栏** 已收口（RFC-242 T5 / PR-3）：**受控** claude 业务节点（agent 声明了 permission）的**启用 local MCP** 现在落入平台无网边界——`claudeCode/netlessMcp.ts` 复用 opencode 既有的 `materializeNetlessWrapper`（0500 wrapper + 0400 manifest）+ `__opencode-netless-subprocess`（stdio 全 inherit），`--mcp-config` 的 local 条目改指 wrapper；containment profile `opencode-verified-v1` **重命名**为运行时中立的 `model-child-netless-v1`（单一 bundle，两 driver 各按需申请；`verifiedManifest` 的 id 字面量判断改为从注册表 `childBoundary` 派生）。macOS 实测：fenced 子进程 `curl` = 000、worktree 写入正常、`$HOME` 落在私有 scratch（gated 测试 `RUN_SANDBOX_ITEST=1`）。**残留（有意）**：未声明权限的存量节点仍不设围栏（用户决策：存量零破坏，收窄靠 `unconstrained` 告警驱动）；**放行 Bash 的受控节点也不设围栏**——实测 macOS 嵌套 `sandbox-exec` 不可行（`sandbox_apply: Operation not permitted`），故 child boundary 会顶掉 runner outer sandbox；claude 的 Bash 子进程尚未走 wrapper（design §4 C-2 未做），此时下围栏等于用 shell 的文件系统边界换 MCP 的网络边界，净亏，故保留 outer 并打 `claude-mcp-netless-skipped` 告警。**C-2 是解除该排除项的唯一前提**。
- 🔁 **RFC-242 T5 复核修复批已上库**（对抗性安全复核 + Codex 实现门各一轮，两边独立命中同两条）：2 个逃逸（伪造 `.git` 指针劫持 git 可写 allow-back；scratch 子目录 symlink 重入劫持 HOME/TMPDIR）+ 6 个功能回归/静默降级（npx 解释器丢失且失败静默、合法 env key 硬失败、相对命令解析基准、git 身份丢失、密钥仍进 bwrap argv、preSpawnVerify 只验形状、需求↔物化判据漂移）。逐条与红/绿证据见 `design/RFC-242-.../design.md §4.5`。**路径投影已提取为单一权威** `services/runtime/netlessProjection.ts`（两运行时共用，差异用显式参数表达）——重复实现正是那条逃逸的根因。
- ✅ **受控 claude 节点的 MCP 工具全被拒** 已修（随 RFC-242 T5，实测发现）：`--permission-mode dontAsk` 下 MCP 工具必须命中 `--allowedTools` 才可调用（claude 2.1.220 实测：`Permission to use mcp__x__y has been denied because Claude Code is running in don't ask mode`）——`--tools` 只管内置装载集。PR-2 的受控业务形状没下发 allowlist，等于**声明了 permission 的 claude 节点一个 MCP 工具都调不动**（存量 `bypassPermissions` 形状放行一切，故只有受控节点中招）。现按节点自己的 MCP 名字下发 `mcp__<name>__*`（不用宽泛 `mcp__*`）；同一次实测确认内置工具的 cwd 自动放行不受影响。
- ⏳ **macOS 上被围栏的 claude 节点失去 runner outer sandbox**（RFC-242 T5 复核 P1-2，**已澄清、未消除**）：`model-child-netless-v1` 在 Seatbelt provider 上是 `provider-child-only` 拓扑（嵌套 `sandbox-exec` 不可行），child 边界**只包 local MCP 子进程**，claude 主进程（Read/Edit/Write/WebFetch **进程内**执行）此时无任何平台文件系统边界，只剩 `--tools` + `dontAsk` cwd 判定这层运行时内约束。**这不是 claude 独有**：verified opencode 的 write/edit 同样在 server 进程内（`opencode/packages/opencode/src/tool/write.ts` 用 FileSystem 服务不 fork），RFC-227 早已对它做同一笔交易（`sandbox/index.ts:114-131` 注释即此）。Linux 无此问题（`runner-outer-and-child` 两层共存）。**本轮已做**：design §4.3 措辞更正（原文"outer 由 child Seatbelt 取代"不准确）+ 每节点打 `claude-mcp-netless-outer-dropped` 告警。**未采纳"暂不申请该 profile"**：driver 不得按 provider/OS 分叉（RFC-227），要按能力区分就得在 RFC-233 coordinator 新增一档 childBoundary，而它在 macOS 上只能收场为「receipt 报 contained 却不施加 child 边界」（RFC-227 明令禁止）或「`enforce` 下 blocked」（拦死今天能跑的任务）——都比现状差。**正解 = C-2（Bash 走同一 wrapper）**，届时 macOS 也能把全部模型可控子进程收进 child 边界，交换消失。
- ⏳ **预览与准入的 MCP 集合不一致**（RFC-242 T5 复核 P2-8，**未修，仅登记**）：`services/task.ts:1394-1400` 的启动期 containment 预览按 `agent.mcp` 取 MCP，`services/runner.ts:1049-1053` 的实际准入按 **dependsOn 闭包并集**取 → 两边可能算出不同的 containment profile，`enforce` 下会「放过 launch 再在 dispatch 拦住」。opencode 同形（**既有**问题，非本切片引入），claude 因新申请 profile 而**新可达**。正解是两侧共用同一个闭包解析函数（`scheduler.ts` 的 MCP 预载已有闭包逻辑可复用），属独立切片：预览是 UX 早拦、准入是权威，二者输入必须同源。
- ✅ **已修（RFC-280 §7.1，2026-08-12 对账销账）：remote MCP 的 header 曾随 `--mcp-config` inline JSON 进 claude argv**——三条 claude 路径（业务/系统 agent/测试台）已统一改为写 `0600` 的 `mcp-config.json` 文件传路径（`runtime/claudeCode/driver.ts:64-73` "THE mcp-config write"），argv 不再携带 header；当年存疑的「`--mcp-config` 是否接受文件路径」已实测成立。at-rest 半边（`mcps.config.headers` 明文入库待 secretBox）仍未决，见下文凭据 at-rest 节。
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

- ✅ **已修（RFC-204，2026-08-12 对账销账）：cached_repos 明文 URL 含 git 凭据跨用户泄漏**——wire schema 已删除明文 `url` 字段（`shared/schemas/cachedRepo.ts:5-15` 注明 "the plaintext `url` field is GONE from the wire"，仅上 `urlRedacted` + 脱敏 `localPath`），launch 改按 `cachedRepoId` 复用、daemon 侧解析真实 URL（即当年登记的正解第二案）。内部结构 `services/gitRepoCache.ts` 仍持原 url 供 daemon 侧 git 操作，不出 wire。

### ⏳ 未决 P2（一致性 / least-privilege / 审计）

- ✅ **workgroup 六资源中唯一无 method 权限点** 已收口（RFC-247 T2）：`workgroups:read/create/update/delete/execute` 五点落地，等价照搬现状（全给 user 基线）。
- ⏳ **插件安装继承完整 daemon env，且生命周期脚本 RCE 面仍开**（RFC-247 设计门 P0 的**残留**；2026-08-12 对账修正记载）：`services/pluginInstaller.ts` 用 `spawn(bin, args, { env: process.env })` 跑 npm。**本条此前记载「RFC-247 已加 `--ignore-scripts`」与源码不符**——pluginInstaller 从未有该 flag（grep 零命中；有的是脚本节点依赖安装 `scriptDepsEnv.ts:165`），npm 生命周期脚本这条最直接的 RCE 仍在。另 2026-08-12 审计补充：其 `runCommand`（`pluginInstaller.ts:766-806`）超时仅单 pid SIGKILL、无树杀无 drain 界，npm 孙进程会泄漏——**该半条已销账（2026-08-14 对账）**：RFC-284 的 `runManagedProcess` 收编已落地，`pluginInstaller.ts:775-790` 现在走树 TERM→宽限→KILL + 有界 drain，孙进程泄漏面已闭。**仍开的是 `--ignore-scripts` 与 env 两件**（`:277-289` 的 install 参数无该 flag、`:781-787` 仍转发 daemon 全量 `process.env`），即 RFC-247 的 AC-36。**2026-08-14：RFC-247 已终结，其 AC-36 经用户决定不做**（呈报后的知情决策，非遗漏），本条不再挂靠任何 RFC，作为存量条目留档。若日后要做，落位按 RFC-294（pin `be31dd62`）§2 归 `resource-catalog/plugin`（§18 owner 表无此条 ⇒ 不受 W4 串行门约束）。
- ⏳ **RFC-253 有四条验收标准从未实现，而文档一度声称已交付**（2026-08-04 第二轮实现门抓出，proposal 已逐条订正为未交付）：**AC-27 env 值脱敏**——详情/列表直接返回定义、YAML 导出直接序列化、前端明文 `TextInput`，**在它落地前节点 env 不应存放真实密钥**；**AC-32 存量 JSON/YAML 输入框迁移**——`JsonField`/`McpFields`/`PluginFields`/YAML 导入框全部仍是 `TextArea`，只有脚本节点用了 `<CodeEditor>`；**AC-35 读投影**——解释器路径与 depsHash 写进了 `runtime_params_json` 但 `NodeRunSchema` 无字段、DTO 不读，设计门 P1 要求的恰是「光写库不算」；**AC-33 事件同形**——脚本事件 payload 是 `{"line":…}` 包装而 agent 写裸行，导致详情抽屉 pretty-print 成对象、`/stdout` 端点拼出 JSON。另有两处「说了没做」已在代码注释里订正为事实：`containedSpawnRegistry.ts`（Bun.spawn 站点棘轮，plan T11）从未存在、`collectScriptDepsEnvs`（依赖缓存 GC，plan T25）零调用方且接上前需先跳过在途 `.build-*` 目录。
- ⏳ **RFC-253 的 `scripts:author` 只治理执行的「形状」，不治理流入的「内容」**：敏感投影已覆盖节点自身字段、入边形状与完整 wrapper 祖先链及其循环退出项，但**上游节点的输出内容**天然不在其中——改写上游 agent 的提示词即可改变流进 `AW_PORT_*` 的字节而投影不变。这是结构性的（把内容纳入投影等于让该权限点治理整张图）。因此一个把输入喂进 shell 的脚本，其信任边界等同于它的上游。已在 `scriptNode.ts` 的投影文档里显式声明该范围，不再宣称「覆盖一切改变宿主执行内容的输入」。
- ⏳ **RFC-253 脚本节点是 `filter.*` / `diff.*.textconv` 侧入口的第二个消费者**：`util/gitHardening.ts:29-33` 自陈 `-c` 压不住这族通配名，留作 RFC-252 的独立切片。脚本节点因此存在一条**围栏外**路径——脚本往工作区写 `.gitattributes` + repo-local `filter.<n>.clean`，随后 daemon 侧快照 / merge-back 的 `git add -A` 会在沙箱外以 daemon 身份执行它，这会绕过节点声明的 `network: 'deny'`。**威胁模型差异**：脚本作者按 RFC-253 D19 是 admin/manager（本就具备宿主权限），所以这条链的现实价值是防**依赖供应链**（三方包做坏事），不是防作者。RFC-253 已在 AC-13 显式声明该边界而非宣称覆盖。修复归 RFC-252 的通配名切片。
- ⏳ **RFC-253 脚本进程与 agent 同档地不受「写 appHome 之外」限制**：外层沙箱不是 jail（`services/sandbox/policy.ts`：Linux `--bind / /` 可写、macOS `(allow default)` 只限制 appHome）。脚本节点继承这一姿态，未新增缺口，但也未收紧；收紧属 RFC-252 G2/G3 范围。
- ⏳ **RFC-253 脚本进程在 macOS 上存在 `setsid()` 后代逃逸**：与今天的 agent 完全同档（共用 `killProcessTree` 的进程组语义，Seatbelt 路径无 PID namespace / parent-death）。脚本 fork 后自立进程组即可在父进程退出后继续写工作区。未为脚本单造 macOS 机制，需要 containment owner 决定是否给 `descendantLifetimeBound` 补强保证。
- ⏳ **RFC-254（v1 无害，未来 Windows containment 前必修）：`services/sandbox/policy.ts` 的 `validatePolicyPath` 规范化闸 `normalize(path) !== path` 对 Windows 是 `/`-only**——`path.normalize('/home/aw')` 在 Windows 把 `/` 改写成 `\`，于是任何正斜杠路径都被判「invalid sandbox … path」抛错。**v1 无害**：Windows 无隔离 provider，该策略计算路径在生产从不触达（core 在 bootstrap 前 fail-closed）；仅 `rfc233-containment-coordinator` 的 bwrap 用例以 POSIX fixture 路径触到、已 `skipIf(win32)`（续十四诊断时发现）。但**一旦落地 Windows containment provider（RFC-254 提到的 Job Object/AppContainer 未来向）**，该闸须改成平台感知规范化（先 `resolve` 再比、或按 sep 归一），否则会拒绝一切合法 Windows sandbox 路径。
- ⏳ **RFC-254（v1 edge-only，未来必修）：`services/runtime/opencode/sealedInputs.ts` 的 `removeSealedTree` symlink 分支在 Windows 上 `rm(symlink, {force:true})` 抛 EFAULT**（Bun-Windows symlink rm 怪癖）。v1 edge-only：生产 hermetic layout 不含 symlink（`prepareHermeticOpencodeLayout` 直接拒绝 symlinked root——该拒绝在 Windows 真机验证**有效**，见 `rfc224-hermetic` 的 store-unsafe 用例），故该分支只被测试 afterEach 清理触到（已在测试内 `unlink(link)` 规避）。但若未来某受封树在 Windows 上含 symlink 子项，清理会 EFAULT ⇒ symlink 分支宜改用 `unlink`（不 follow）而非 `rm`（续十六诊断时发现）。
- ✅ **RFC-254 已修（`d6fdb0a3`，真机 Windows 11 ARM64 确证）：verified 业务 plan 在 Windows 两处真生产缺陷（Code→Audit→Fix 主线整条曾坏）**。bug#1 `netlessProjection.ts:resolveNetlessGitCommonDirs`（被 `verifiedPlan.ts` 无条件调）拒 git-for-Windows 正斜杠 `--git-common-dir`（`C:/repo/.git`），因 `isLexicallyCanonical` 用真 OS path 编解码（win32 反斜杠）⇒ 每次 plan abort `source-changed`。修：git 输出 `.split('/').join(sep)` 归一 host 分隔符（POSIX 恒等）。bug#2 `sealedInputs.ts:snapshotManagedSkillTree` 断言封根 POSIX mode `0o500`，但 win32 chmod 由只读属性合成（只读目录读回 `0o444` 且不真正封目录）⇒ 每 managed-skill plan `store-unsafe`。修：mode 断言用 `statMetadataIsAuthoritative(process.platform)` 门控（仅 POSIX），win32 改用既有 `sealDirectoryOwnerOnly` DACL 封根。**确证方式**：真机用**真 git+真 fs 调生产函数（非强制平台）** probe，两 bug 修前 FAIL/修后 OK；`rfc254-verified-plan-win32.test.ts` 双层锁（源码锚跑每条 POSIX CI 腿 + win32-gated 运行时真机 4/4 pass）。**为何验收+套件都漏**：VM `C:\aw` 非 git overlay + `rfc224-verified-plan` 强制 `process.platform='darwin'` 做 POSIX 模拟 ⇒ 真 win32 路径零覆盖。
- ✅ **RFC-254 已修（`6458aac2`）+ 完整 plan 真机端到端确证：bug#3 `netlessProjection.ts:assertRegisteredGitWorktree`（linked-worktree 注册路径正斜杠）**。加了「完整 `buildVerifiedOpencodeBusinessPlan` 在真 win32」win32-gated 测试（真 git **linked worktree** + `mode:'off'` 无-containment admission = Windows v1 真实形态，`ContainmentCoordinator` mode off → 'none' plan）扫 bug#3+，**当即扫出 bug#3**：仅当 common dir 在 worktree 外（linked worktree，**每个真实任务都用** `git worktree add`）才走 `assertRegisteredGitWorktree`；`git worktree list --porcelain` win32 同样正斜杠 ⇒ `registeredPath` 过不了 `isLexicallyCanonical` ⇒ store-unsafe。bug#1/#2 子函数 probe 用 plain clone（`.git` 在内）从不经过，唯完整 plan（真 linked worktree）暴露。修：同 bug#1 `.split('/').join(sep)`。**真机 5/5 pass（含完整 plan build）⇒ verified Code→Audit→Fix 主线在 Windows 现已跑通**；CI 进 `windows-platform.yml`。**killGroup 纪律第三次奏效**：不满足「两子函数已修」就 skipIf 收工，逐层深挖才挖出 bug#3。**bug#4 补记**（`fa5bb21d`）：`verifiedPlan.ts:989` RFC-256 machine-config 计数用 `sourceEnv.HOME`（原生 Windows 不置 HOME）⇒ store-unsafe 拖垮整条 plan build（T11b 回归），改用 `realHome`。是 x64 `windows-platform` CI 腿（干净 checkout）挖出的——**VM overlay 缺 `machineConfig.ts` 陈旧掩盖了它**（记 `docs/dev-gotchas.md`）。
- ✅/⏳ **RFC-254 full-plan 覆盖推进（`rfc254-verified-plan-win32.test.ts`，真机 7/7 pass）**：完整 plan 用例现覆盖 **CORE**（`bash:'deny'`、无 skills/MCP/plugins、`mode:'off'` 无-containment、删 HOME 模拟原生 Windows）**+ skills-in-plan**（一个 managed skill 走完 `inspect`+`snapshotManagedSkillTree`+注入 frozen prompt，真机断言 skill body 落进 manifest ✅ 已证，不再是「大概率」）。**扫时发现 local MCP 在 verified 路径的架构约束（非 win32 bug，平台无关）**：`executionIdentity.ts:businessOpencodeIdentityDigest` 要求 local MCP 的 `command[0]` 必须是 **sealRoot 内的封装 wrapper**（`contained(sealRoot, command[0])`），而该 wrapper 由 containment provider 的 netless 边界产出；**Windows v1 无 provider（RFC-254 D1）⇒ `mode:'off'` 不产 wrapper ⇒ 带 local MCP 的 agent 在 Windows verified plan build 会 `execution-identity-mismatch`**（POSIX `mode:'off'` 同理，故非 win32 特有）。这是「local MCP 需 containment provider」的既有设计约束在 Windows 的体现，**属未来 Windows containment provider（Job Object/AppContainer）的范畴**，非 T31 plan-build 缺陷。**`bash:'allow'` 已扫（真机 7/7）**：Windows 无 sealed shell（`SEALED_SHELL_SUPPORTED=false`）时完整 plan build 干净通过（null shell 路径被正确处理，非假设），未发现 bug#5。**仍未扫**：plugins closure（受 `pluginInstaller.ts:295` 并发方阻塞）。
- ✅ **RFC-254 容器簇尾部 2 文件已处置（`feb80ae0`/`da5d6813`，真机确证）**：①`rfc238-mcp-test-execution-material`——2 个 local-material 用例经真机诊断确认根因是 `containment()` 强制 seatbelt/bwrap provider 物化 netless wrapper、Windows v1 无 provider ⇒ wrapper ENOENT（+ POSIX fixture），`test.skipIf(win32)` 2 用例（remote 仍跑）。②`rfc238-mcp-runtime-test-real-e2e`——`ConflictError` 根因确认是 mock runtime（`.js` 拷无扩展名 `bin/mock-claude`）在 win32 不可 spawn（turn1 不应答），测试 fixture 局限非产品缺陷（生产走 `snapshotExecutableExtension` 真 `.exe`），`test.skipIf(win32)`。**均非真 win32 bug**（provider-依赖 / test-fixture 局限）。**至此 RFC-224/227 verified-path + containment 簇 win32 全清（0 fail 全簇），task#3 完成。** 待未来 Windows containment provider 落地时，local-MCP/netless 相关 skip 用例需补 win32-canonical fixtures 重新激活。
- ✅ **RFC-254 已修（续三十五，真机 Windows 11 ARM64 + opencode 1.18.13 + glm-5.2 端到端确证 `STATUS=done`）：verified **执行**路径（不止构建）在 Windows 跑通，修 3 处 win32 生产缺陷**。用 `runNode`（生产 verified 路径）跑整条业务节点，逐层挖出（每层修完才现下一层）：**bug#5（关键）`GIT_CONFIG_GLOBAL=NUL` 打死 git-for-Windows**——git-for-Windows（MSYS2）只认 `/dev/null`、把 `NUL` 当文件名 `access` 失败 ⇒ opencode worktree 探测失败落 `global`/worktree=`/` ⇒ session `path` 非 `""` ⇒ `validateSessionIdentity` `/path` 拒（**Windows verified 路径彻底不可用的元凶**）；修＝`platformExec.ts:GIT_NULL_CONFIG_PATH='/dev/null'`（host 无关）用于 3 个 `GIT_CONFIG_GLOBAL` 站点（hermetic/models/fffCapability），`git diff --no-index -- NUL` 两处保留 `nullDevice()`（git 特判 diff 空侧）。**bug#6** bootstrap 逐请求 `Math.min(2_000,…)` 太紧（opencode 首个 `/config/providers` 冷初始化 ~1.86s，越 2s 被 abort → `DirectHttpError(request-aborted)` → 被 `stableFailureCode` 兜底成 `mismatch`）；修＝逐请求用 `bootstrapTimeoutMs`（phase 级 `runWithDeadline` 已限）。**bug#7** `verifiedInventory.ts:writeVerifiedInventorySnapshot` 的 `(mode&0o777)===0o600` 断言 win32 恒假（新文件读回 0o666/0o444）；修＝同 bug#2 用 `statMetadataIsAuthoritative` 门。**诊断法教训**：`stableFailureCode` 对任何未识别异常兜底 `execution-identity-mismatch`，故续三十四「bug#8=inventory mismatch」是假象（真因是上述 DirectHttpError/DirectApiValidationError 被折叠，inventory 形状实际匹配 1.18.13）——win32 verified 调试须在 launcher child 唯一顶层 catch 抓**真实异常类型+stack**，勿信兜底码。测试：`rfc224-hermetic`/`rfc254-platform-exec`/`rfc254-verified-plan-win32`（T31b 三源码锚）；qualification 1033/0（100 文件）。`WINDOWS_SYSTEM_FORWARD_ENV`/SystemRoot 曾疑为因，实测证伪已回退（git 无 SystemRoot 也跑、Bun `process.env` 大小写不敏感）。
- ⏳ **RFC-254 唯一已知 win32 可靠性缺陷（续三十七 T41 真机定论：代码侧无可靠解，唯一确定解＝部署侧 Defender 排除）：verified 服务端 flaky 冷启动 ~⅕–⅓ 失败**。RFC-224/227 每次运行把 **175MB** 的 opencode.exe 新拷进私有密封目录再 exec；Windows Defender（真机默认 ON）在拷贝落盘瞬开始扫描并短暂持锁，exec 撞进扫描窗口 ⇒ 服务端进程零输出瞬退（exit code **5=ACCESS_DENIED**/段错误，`Bun.spawn` 有 pid 但进程瞬死）⇒ launcher 见 stdout 流关闭无 listen 行 → `bootstrap-failed`（`verifiedLauncher.ts:monitorServerStdout` 的 `!sawListen`；易误判慢启动/超时）。**续三十七 T41 真机定论（ARM64 + 1.18.13 + glm-5.2，证伪续三十五两条旧假设）**：①**内容寻址缓存复用密封二进制**（按源 digest、每次 exec 前 + launcher spawn 前重哈希＝安全等价）已实现四门全绿（POSIX 逐字零影响、win32-gated）并**已撤销**——**对本缺陷无效**：把同一份已落盘缓存 `.exe` **反复 exec** 仍 ~⅕–⅓ 零输出秒退（30s 窗口 8 次探针：5 listen / 3 `EXITED-NO-LISTEN lines=0`；**密封目录 vs 未密封目录 4/5 vs 4/5 完全同率** ⇒ DACL/位置/文件名皆非因；先前「reuse 版 bootstrap-failed ×2 vs disable 版 done ×1」实为同一 ~⅓ flaky 抽样噪声），故续三十五「Defender 首次扫净后缓存 clean ⇒ 后续 exec 免扫」**被证伪**（那句的 12/12 是 image-map 层孤立探针、不代表整条 serve）；②**有界 respawn 重试**（4 次/launch）实测 10 launch 9 成、仍有「连杀一簇」漏网，非可靠解（印证 exec 层 ~50% 老结论）。即 Defender 在**每次进程加载期**拦杀镜像、不因「扫过一次」放行后续 exec。**唯一确定解＝ops：对 appHome/密封根加 Windows Defender 排除**（operator 执行需管理员：`Add-MpPreference -ExclusionPath '<appHome/密封根>'`，可加 `-ExclusionProcess 'opencode.exe'`），应写进 Windows 部署文档作装机必备；**代码侧不再堆 exec 层重试/内容缓存**（治标、脏 RFC-227 信任核心）。详见 `dev-gotchas.md` §跨平台 RFC-254 T41 条。
- ⏳ **RFC-254 收尾跟进（2026-08-07 拆为独立跟进项；核心已 Done）**：RFC-254 核心（Windows 原生执行 + verified 路径 + 7 处 win32 生产缺陷 + flaky 冷启动定论）已交付并真机验收、`design/plan.md` 索引标 Done；以下 D3 in-scope 但需 **CI 基建 + 人工基线评审**、与核心交付可分离的项拆出独立跟进：**① T32 A 类残留**——(a) e2e 的 `.sh` 假二进制照 T29 姿势编译为参数化原生产物（win32 不能执行 `.sh`）；(b) 拆卸期 `EBUSY`（bun:sqlite 句柄 GC 才释放，走 `tests/fixtures/tempDir.ts:removeTempDirSync` 的 `Bun.gc(true)` 姿势）；(c) `spawn('npm')` 撞 `.cmd` 垫片（win32 需 `npm.cmd` 或经 shell）。**② T33** 工作流 windows 视觉腿 + 第三套 win32 视觉基线（46 张/40 场景，需人工确认基线）。**③ T34** `e2e-webkit-nightly` 加 windows 腿。**④ T35** 全矩阵收敛（连续 3 push windows 腿零未登记红）。判据：均为 CI-pipeline / 视觉基线产物，需 CI 环境执行 + 人工基线评审，不在核心可靠性关键路径上。Job Object/AppContainer、DPAPI、windows-arm64 隔离另属**显式非目标**（后续独立 RFC）。**⚠️ 2026-08-07 补记：`.github/workflows/windows-survey.yml` 已按用户指示删除**（它自己的文件头就写了「Deleted once the matrix legs in ci.yml take over (T35)」，但删除发生在 T35 收敛之前）。后果：**T33 与 T34 失去执行载体**——T33 的 46 张 win32 视觉基线原本由该 workflow 的 `--update-snapshots` 步骤产出并上传为 artifact 供人工评审，T34 的 webkit 测量也在其中。重启这两项时须**先重建一个非门禁的 `workflow_dispatch` 勘测作业**（关键约束照抄原文件：`continue-on-error: true`、per-job `concurrency` 且 `cancel-in-progress: false`——放进 `windows-platform.yml` 的取消组里必然跑不完、backend 腿需 240 分钟预算而门禁分片只有 15 分钟；「要产出的步骤排在要测量的步骤之前」，否则一截断就什么产物都没有）。删除前的完整实现见 `ca4acfd9` 的该路径。
- ⏳ **RFC-254 纵深健壮性（低优先，生产当前免疫）：`netlessProjection` 的 `realpath`（fs/promises）在 Windows 不展开 8.3 短名**。`realpathSync`/`realpath`（JS 版）对 `C:\OPENCO~1\...` 原样返回短名且 `resolve(p)===p` 为真，而 git（`--git-common-dir`/`worktree list`）恒返回长名 ⇒ 若输入 worktree 路径是短名形，短↔长不一致会踩 canonicality/containment ⇒ source-changed/store-unsafe（真机短名探针复现；`realpathSync.native` 走 `GetFinalPathNameByHandle` 才展开长名）。**当前生产免疫**：worktree 根出自 `os.homedir()`（长名）。**风险面**：admin 把 appHome 配在短名目录下、或任何把短名路径喂进 verified 链路的入口。**若要纵深加固**：verified 链路 win32 上统一用 `realpath.native` 展开（敏感核心，需重跑 qualification + 全平台核 native 行为）。测试侧已用 `longTemp`（`realpathSync.native`）规避（GitHub tmpdir 是 `RUNNER~1` 短名，见 `docs/dev-gotchas.md`）。
- ✅ **`shared/schemas/mcp.ts` 的过期注释断言已订正（2026-08-14，RFC-247 收口档 3）**：原注释写「opencode `McpLocalConfig` 没有 `cwd` 字段，所以我们故意不做」。本次重新对本机 checkout 核实：`packages/core/src/v1/config/mcp.ts:11-13` 与 `packages/core/src/config/mcp.ts:18` **都有 `cwd: optional(String)`**（"Relative paths resolve from the workspace directory"）。注释已改写为陈述**行为**而非不可能性：我们仍不下发 `cwd`，故 stdio 子进程继承 opencode 进程目录 = 任务 worktree。**是否开放 `cwd` 是个没人做过的产品决策**（开放等于给 MCP 作者一个把子进程指出 worktree 的旋钮），保留为待决而不在注释里自行裁决。零行为变化。⏳ 剩余待决：要不要开放 `cwd`。
- ✅→⏳ **`/ws/repo-imports/:batchId` 无 gate 频道——WS 半边已修，REST 半边待拍板**（RFC-285 B6②，2026-08-13）：BatchRecord 自创建携 `ownerUserId`（发起路由 actor 注入，绝不来自请求体），WS 升级门=发起者 ∨ 资源管理员，缺行/非发起者**同形拒绝**（batch-not-found；矩阵锁 ws-repo-imports.test.ts）。**剩余待拍板**：同数据的 REST 面 `GET /api/cached-repos/imports/:batchId`（getBatchSnapshot）与 `POST .../rows/:rowId/retry` 仍是 token-only、任何持凭据者可读/可重试他人批次——收紧属能力收缩、不在 RFC-285 已批准的 E 清单内，按 CLAUDE.md 收缩门槛呈用户逐项确认后另行落地（判定读点 `batchOwnerUserId` 已就位，接线是小改）。
- ✅ **空 PAT scopes = 全量 role 权限** 已收口（RFC-247 T5）：`auth/actor.ts` 的 `patScopes.length>0` 短路删除，PAT 分支恒走 `resolveTokenPermissions`，空矩阵 = 只读。
- ✅ **任务操作面无写权限点 / `tasks:cancel:own|all` 零引用死点** 已收口（RFC-247 T2）：两个死点从目录删除；cancel/resume/retry 归 `tasks:execute`，范围仍由 `canViewTask` 承担（这正是代码一直以来的真实行为）。
- ✅ **`GET /api/mcps/:id` 明文返回 `config.env` / `headers` / `oauth.clientSecret`** 已收口（RFC-247 PR-3）：`redactMcpRecord` 此前只写了规则、没有任何调用方（PR-2 的「已接两条出口」只对 `redactGitUrl` 那半成立）；现补 `serializeMcpFor(record, source)` 作为唯一出口，接在 `routes/mcps.ts` 五个序列化点。仅对 PAT 通道脱敏，session 读原值（人能打开编辑器，藏字节只是 UX 退步）。**发现路径**：写 MCP 工具测试时意识到 `resource_read(kind='mcps')` 会把它直接送进模型上下文。
- ⏳ **`redactSensitiveString` 漏掉带前缀的环境变量名**（RFC-247 实现门顺带发现）：`SENSITIVE_KV_RE` 是 `\b(token|api_key|…)\b`，而 `_` 是词字符 ⇒ `\bapi_key\b` **不匹配** `OPENAI_API_KEY=…`。而「agent stdout 回显环境变量」正是它要防的主场景。未在 RFC-247 内放宽：该正则同时被 RFC-030 的 MCP 探针持久化与 daemon 日志共用，松词边界会连带影响它们的过度遮蔽风险，属那两处 owner 的决定。缺口已在 `rfc247-token-redaction.test.ts` 里用一条**显式断言**锁住（写明是 KNOWN GAP），改动时会立刻看见。**2026-08-14 收口方向（对齐 RFC-294 pin `be31dd62`）：别去松这条正则的词边界。** `design.md` §15.3 要求 W0 建 **secret canary 与 serializer/logger capture 负测**、logger fields 服从 key registry + data class——正解是把 `OPENAI_API_KEY=…` 这类带前缀的形态登记成 canary 的一条负测，由 data-class 机制统一覆盖三个消费方，而不是在共用正则上放宽词边界去连带影响 RFC-030 的 MCP 探针持久化与 daemon 日志。
- ⏳ **`mobile-task-detail` 视觉场景非确定性（2026-08-04 取证）**：RFC-253 推送后 `visual-regression-nightly` 该场景红，1090 像素（1% ）差异，形态是**画布节点整体上移约 30px、横向与页面其余部分逐像素不变**。**同一 SHA `f864d30c` 重跑 attempt 2 直接 success** —— 同样字节两种结果，故属场景不稳而非某次改动引入。排查过程排除了三个候选：RFC-253 新增的 CSS 全部带命名空间（`.code-editor` / `.canvas-node__script-*` / `.script-*`）+ 纯 `--code-*` 变量，命不中只含 input/agent/output 的画布；中间两个提交一个纯文档、一个只碰 shared schema（`agents.network`）。**待验证的成因假设**：`canvas/wrapperFit.ts` 的 `DEFAULT_NODE_SIZE_BY_KIND` 自陈是「xyflow 尚未测量时」的兜底尺寸，若 `fitView` 在测量前跑就会得到不同的垂直居中——这与「只垂直位移、横向不变」的形态吻合。**按 CLAUDE.md「重跑就过了不能当通过依据」登记而非略过**；owner 是视觉门禁那条线（RFC-054 场景 / RFC-250 近期连续在修 Linux 与跨平台视觉门禁）。修法方向：让该场景在断言前显式等待节点测量完成（而非等固定时长），或把相机固定成不依赖测量的确定值。
- ⏳ **`local backend shard wall-clock timeout > timeout still kills the process group when its TERM-compliant leader exits first` 在 hosted macOS runner 上红**（2026-08-11 观测，RFC-281 推送时撞上）：`local-gate-runner.test.ts`（测 `scripts/test-backend-sharded.ts` 自身的分片超时治理，owning commit `a48c18a0` / `6750165e`）在 `9b1a2fde` 的 `Backend tests (macos-latest shard 3/4)` 挂——期望 stdout 含 `term-compliant-parent-ready`，实收只有 `TIMEOUT after 100ms; sent SIGTERM…`：**子进程还没来得及打印就绪标记就被超时杀了**。用例的窗口是 100ms timeout + 50ms grace，在 hosted runner 上过紧。**与 RFC-281 无关**（该轮改动是 runner 的 boundaryMounts + 纯函数 + 测试，完全没碰分片脚本或该测试文件）；**同 commit 的本机 macOS 全绿**（`gate:local` 四分片 9439 pass，该文件单跑 13 pass），CI 前一版 `2262df76` 同一 shard 也是绿。登记而非当噪音略过（CLAUDE.md 禁「重跑就过了」）：需要分片基础设施的 owner 判定是放宽窗口（如 leader ready 后再起算超时、或 200ms/100ms）还是标记为环境敏感。
- ⏳ **`RFC-210 ref naming safety > ref names pass git check-ref-format for hostile paths` 在满载机器上超时**（2026-08-14 观测，RFC-247 收口档 3 跑本地门禁时撞上）：该用例串行 spawn **12 次** `git check-ref-format` 子进程（6 条 hostile path × pool/worktree 两个 ref 函数，`rfc210-submodule-topology.test.ts:132-139`），用的是 bun test 的 **5s 默认超时**。撞上时本机同时压着三份测试负载（一份被 kill 但留下孤儿分片的 gate + 新起的 gate + 另一 session 的 vitest），该用例耗 5005ms 超时；**清掉负载后单独跑同文件 15 pass / 320 ms**——差一个数量级以上，且失败形态是超时而非断言失败。归因：与当轮改动（docs 路由 / publicOrigin / tokenAudit / mcp schema 注释）零交集，也不是被别人的 `gitSubmodule.ts`/`util/git.ts` WIP 改红（那会是断言失败）。**登记而非当噪音略过**（CLAUDE.md 禁「重跑就过了」）：本仓 `gate:local` 自身就是 4 分片并发，多人并发跑门禁是常态，所以「12 次子进程 spawn 挤不进 5s」在正常协作节奏下还会复发。修法方向留给该测试 owner：给这一条显式放宽超时（它的成本是 12 次 spawn 而非逻辑慢），或把 12 次调用收敛成一次批量校验。
- ⏳ **`RFC-227 REAL macOS Seatbelt provider (gated)` 在 hosted macOS runner 上间歇性红**（2026-08-02 观测）：commit `1e87b6a1` 的 `Backend tests (macos-latest shard 2/4)` 挂在「denies app secrets, seal writes, and child network while preserving worktree writes」；**同一 shard 在严格包含它的 `f67db859` 上是 success**，且该轮改动完全没触及 containment。登记而非当噪音略过，是因为 CLAUDE.md 禁止「重跑就过了」作通过依据——需要它的 owner 判定是真时序缺陷（真实 `sandbox-exec` 子进程 + 网络探测本就时序敏感）还是 runner 环境抖动。复现线索：失败耗时 5034.88ms，接近某个 5s 超时。
- ⏳ **MCP 收敛工具只覆盖 CRUD**（RFC-247 实现门 P2）：`resource_read`/`resource_write` 的 `method` 枚举只有 list/get/create/update/delete，因此 workflow copy·export、workgroup rename、repo refresh、memory archive·unarchive 这些**已对令牌开放**的路由，MCP-only 客户端够不着。要么扩 method 枚举，要么给它们具名工具——属 v2 的「MCP 面做多宽」范围，本轮未做。**2026-08-14 收口方向（对齐 RFC-294 pin `be31dd62`；按 `6e8c4f9f` 仓规只引小节号）：不要扩 `method` 枚举。** `McpBinding = {operationId, toolName}`（`design.md` §13.1）是 operation↔tool 一对一，`plan.md` **W4-A** 要求「HTTP RouteMeta 与 MCP tool 映射引用同一 operation id/handler」，§13.1 结尾又明禁 catalog 导出 generic invoker——扩枚举正是往 generic invoker 方向加固。等 W4-A 落地时这条自动消解。
- ⏳ **MCP 缺 review 逐文档操作与 clarify 子集/延后**（RFC-247 实现门 P1/P2）：`submit_review` 只有整轮决策，PATCH 选择与 POST 锚定评论够不着；`answer_clarify` 表达不了 `defer` / `questionIds` / `resubmitQuestionIds`。多文档评审与逐题分派在 MCP 上因此不完整。**2026-08-14 收口方向**：与上一条同 owner——补法是各操作在 W4-A 的 operation catalog 里各拿一个 `McpBinding`，不是给现有收敛工具加参数。
- ✅ **令牌审计查询未下推 SQL 已修（2026-08-14，RFC-247 收口档 3）**（原 RFC-247 实现门 P2）：`listTokenAudit` / `listTokenAuditForUser` 曾全表 select 后在内存里 filter+sort+slice，90 天保留期下调用量一大就是无界延迟与内存、`(user_id, created_at)` 索引白建。现已改为 `WHERE`/`ORDER BY`/`LIMIT` 全下推（`services/tokenAudit.ts`）。**关键点**：排序补了 `id ASC` 二级键——JS `sort()` 稳定、裸 `ORDER BY created_at DESC` 不稳定，同毫秒两行会在两次调用间换位；ULID 在同毫秒内单调，故 `id ASC` 恰好复原插入顺序，使下推后行为与被替换的内存版逐字一致。锁：`rfc247-token-audit.test.ts` §「the audit listings are pushed into SQL」（过滤/排序/limit 行为 + 同毫秒稳定性 + 一条源码断言禁止 `.filter(`/`.sort(`/`.slice(` 复辟）。终局 owner 仍按 RFC-294 §18 归 `identity-access`（W4/W9），本次就地修未造新债。
- ✅ **`/api/docs/api` 与 `/.well-known/mcp` 用请求 URL 推导 origin 已修（2026-08-14，RFC-247 收口档 3）**（原 RFC-247 实现门 P2）：TLS 终止或反代重写 host/proto 时 `c.req.url` 是 daemon 内网 origin，生成的客户端片段与 discovery URL 因此不可用。**未新增配置项**——RFC-036 早已有 `publicBaseUrl`，连同它的 forwarded 头回退一起被抽成纯函数 `routes/publicOrigin.ts:derivePublicOrigin`（优先级逐字不变：config → `X-Forwarded-*` → `Host` → 请求 URL），docs 两条路由与 OIDC 的 `resolveRedirectUri` 现在共用它，不再各写一份。顺带修了两处：代理链头（`X-Forwarded-Host: a, b` 取原始客户端那一跳）与「无 Host 头时 RFC-036 版会拼出字面量 `http://undefined/...`」。**与 webhook ingress URL 的规则差异是有意的**（那条只认 `publicBaseUrl`、缺了返回 null，因为那个 URL 要交给代码平台长期存活；这里读者正连着本 origin，回退才是正确答案），已写进源码注释以免被当成不一致。锁：`rfc247-public-origin.test.ts`（12 条纯函数矩阵）+ `rfc247-api-docs.test.ts` §「the published origin survives a reverse proxy」（HTTP 层四条）。落位按 RFC-294 §2 记在 inbound-HTTP transport 层（随 W4 迁 `adapters/inbound/http/`），未落 `services/`。
- ⏳ **生成文档未含请求体 schema 与错误码**（RFC-247 实现门 P2）：`buildApiDocs` 丢掉了每个工具的 `inputSchema`，路由侧也没有 body/query/错误码，读者无法只看 wiki 就构造请求。`describe_resource` 已在实现门修复中补上派生 JSON Schema，同一套派生可以接进 wiki。**2026-08-14 收口方向：先别手写第二套派生。** RFC-294（pin `be31dd62`）`plan.md` **W4-A** 要求「API docs 从 transport descriptor 派生」，而 descriptor 自带 `inputCodec`/`outputCodec`/`publicErrorCodes`（`design.md` §13.1）——请求体 schema 与错误码是 W4-A 的自然产出，现在另起一套会在 W4 被推倒。
- ✅ **`/.well-known/mcp` 不反映开关状态已修（2026-08-14，RFC-247 收口档 3）**（原 RFC-247 实现门 P2）：`mcpSurfaceEnabled=false` 时该文档曾与开启态逐字节相同，客户端照着接过来每次被拒、且拒绝表现为「认证问题」而非「这个部署不提供 MCP」。现 `wellKnownMcp()` 收 `{ enabled }` 并由路由从既有单一读点 `isMcpSurfaceEnabled(configPath)` 注入（未新造 config reader）。开关状态是 operator 姿态不是秘密（对端点发一次请求即可观测），故公开无碍。锁：`rfc247-api-docs.test.ts` §D18 两条（纯函数双向 + HTTP 层随真实 config 文件变化）。
- ✅ review 评论 PATCH/DELETE 不验作者——**RFC-285 T7 已修（2026-08-13）**：作者校验三层判定（owner/资源管理员旁路、协作者仅本人行、LOCAL_DECIDER 兜底行 owner/admin-only），矩阵锁 reviews-comment-patch.test.ts；「delete 无 decided 冻结」半句是 v1 过期记载（现状对称冻结，锁同文件「冻结优先于作者校验」用例）。
- `updateTaskMembers` 缺 OCC + in-tx active（`resourceAcl` RFC-170 已修、成员面没跟）；`buildLaunchCollabRows` 不排除 `__system__`。
- WS 连接 actor 升级期钉死：撤销/降权/移出成员不断开在连，clarify 帧含全量问答（→ RFC-212 方案 D 处理）。
- ✅ 导入单向放宽 visibility——**已被 RFC-231 修复（2026-08-12 RFC-285 设计门对账销账）**：skill zip 导入走 `initialPrivateResourceAcl`（`skill-zip.ts:198,327`，:622 注释明写 owner+private）、workflow YAML 导入经 `createWorkflow` 同走单点（`workflow.ts:844`）；原登记两锚（workflow.ts:54 / skill-zip.ts:430）在 HEAD 均已不含 public 字面量。RFC-285 T8 补三路回归锁——**已落（2026-08-13）**：rfc285-b6-import-visibility-locks.test.ts（三路装配路径在场锁）。
- memory 前端门与后端不一致——**2026-08-12 RFC-285 设计门对账改写（原记载方向反了）**：原文的 `usePermission('memory:approve') 恒 true` 用法在 HEAD 已不存在（实调用为零）；现状是 `memory.tsx:85` / `memory.distill-jobs.$jobId.tsx:47` 用 `useIsAdmin()`（仅 admin），**窄于**后端 `canManageMemory` 的 admin+manager（`memory.ts:764-782` 首行 `isResourceAdminActor`）。修法=前端换 admin+manager 谓词——**RFC-285 T9 已修（2026-08-13）**：新 useIsResourceAdmin 两点换用，锁 memory-admin-gate-role.test.ts。
- ~~前端详情页(agents/skills/mcps/plugins/workgroups.detail)不按 owner 做写门 → 非 owner 可编辑、编辑器拖动即撞 403~~ **✅ RFC-324 已修（2026-08-25）**：这七个详情页的 `canUpdate` 从「只看方法级权限点」改为「权限点 ∧ 行级授权档」（`usePermission('X:update') && useResourceAccess(...).canEdit`），`canDelete` 挂 `canManage`；页面里所有 `canUpdate &&` 分支（表单 disabled、保存/删除/改名入口）随之一并收敛。根因是 `workflows:update` 这类点在 user 预设里人人都有，只看它等于「看得见 = 编辑得动」。**其余三项仍未做**：`acl-*` 错误码 i18n（RFC-324 只补了自己新增的三条 `resource-*` 码，`acl-invalid` 等旧码仍是英文裸串）、`AclPanel` 409 后知情整表覆盖、builtin 前端零感知。
- workgroup confirm/dw-confirm 门决策不落决策人归属（对照 review D7）。

### ⏳ 未决 P3（选摘）

- ⏳ **B1 边界内的写门存在性探测残留（RFC-285 实现门路 1 P3-4 登记）**：不可见陌生人打**写**端点（clarify answers / review decision 等 requireTaskMember/ensureClarifyMember 门）仍收 403 not-task-member——可借写路径探测 run/session 存在性。系 proposal「成员制写门 403 保留」拍板边界内的已知残留（读面 404 同形不受影响）；若未来要收，须按能力影响单独立项呈批。

`sweepExpiredSessions` WHERE 重复谓词(`sessionStore.ts:139`)；`resource_grants` 无删除清理(孤儿累积，ULID 不复用故无越权)；`searchUsersPublic` disabled 过滤 `|| excluded.size===0` 语义耦合；403 回带 `actorPermissions`；token 可 `?token=` query；OIDC allowlist `endsWith` 后缀混淆(`provisioning.ts:62`)；邮箱大小写不归一；运行时子进程继承全 `process.env`；403 vs 404 存在性口径混杂；协作草稿 PUT catch-all 吞错；401 不自动跳登录。
前端抽取机会：`AclPanel`↔`TaskMembersPanel` ~150 行复制且漂移(后者缺 onError refetch)、`useIsAdmin()` 身份门 hook、`RoleBadge`(admin 配色三处矛盾)、表单命名空间清剿(4 套平行 input)、`UserPicker` 键盘/ARIA 照抄 `MultiSelect`、`ConfirmButton` 铺到破坏性单击。

> ⚠️ 此环境曾持续污染工具输出回显（幻觉/自相矛盾）。只信 git 硬命令 / 单整数 grep / 测试 pass-fail 计数 / exit code；提交后用 `git cat-file` / `git log origin/main` 验真落地。

## 沙箱 / containment 功能性审计（2026-08-04，8 路 fan-out + 主 session 逐条复核）

> ⚠️ **2026-08-12 对账注记：本节整体已被 RFC-276（2026-08-10）取代**——sandbox/containment/netless/verified 体系已物理删除，业务 agent 回到自然 runtime 执行。本节全部条目（含「仍未修」尾表——其中业务 shell PATH / 本地 MCP PATH token / sourceGuard 收窄三项在本节 ✅ 清单里本就已落地、尾表当时未同步）仅存历史价值，**不要**据此排期修复；逐条重定性登记为独立欠账（见 `design/system-commons-unification-audit-2026-08-12.md` §7）。
>
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

- ✅ **(P0，已修 2026-08-04) 多仓 / 仓库组任务在沙箱下只放行 `repos[0]`**（三路独立命中）：`isoWorktreePathFor`
  （`services/nodeIsolation.ts:167-176`）对多仓生成 `iso/{taskId}/{nodeRunId}/{挂载路径}`，父目录名是
  **nodeRunId**，永不等于 taskId ⇒ `buildRunSandboxCtx`（`services/sandbox/index.ts:186-189`）只放行第一个仓；
  而 prompt 的 `{{__repos__}}`（`services/scheduler.ts:5583-5592`）照旧把全部成员 iso 路径喂给 agent。
  **后果不对称且 Linux 更糟**：macOS EPERM（响亮）；Linux 上 appHome 是 tmpfs，sibling 路径不存在但 tmpfs
  可写 ⇒ agent `mkdir -p` + 写入全部「成功」、退出即蒸发、merge-back 静默 no-op = 「报告已改完、推上去空空如也」。
  挂根成员作 `repos[0]` 的组因路径少一层恰好蒙对，故存活至今。既有测试
  `tests/rfc205-sandbox-scratch-allowback.test.ts:60-63` 锁的是 canonical 形状 `worktrees/multi/{taskId}/repoA`
  （父目录名确实等于 taskId），**iso × 多仓这一格零覆盖**。
- ✅ **(P1，已修 2026-08-04) 基仓在 appHome 内的另两类任务 git 全废**：同处只写了 `scratch/{taskId}/.git` 一个特例
  （2026-07-22 QGENNV 事故补丁）。未覆盖：①**技能融合引擎任务**基仓在 `fusions/{id}/iter{n}/work`
  （`services/fusion.ts:418,570`），iso 的 `.git` 指向 `fusions/.../work/.git/worktrees/{runId}`，遮蔽后
  `git status`/`rev-parse` 一律 `fatal: not a git repository`（本机真实 git 已复现）；
  ②**scratch 父任务的 call-workflow 子任务** common dir 是 `scratch/{父taskId}/.git`，而 allow-back 按**子**
  taskId 拼路径必然查不到。反证：`tests/rfc205-sandbox-policy.test.ts:57` 专门断言 `fusions` 必须被 deny，
  却没人问过融合任务自己还用不用 git。
- ✅ **(P1，已修 2026-08-04) 脚本节点 `AW_REPOS_JSON` 恒发 canonical 路径**：`services/scheduler.ts:4357` 传
  `r.worktreePath`，而非 readonly 脚本 cwd 在 iso。agent 路径在同文件 `:5583-5592` 就做对了（换成
  `isoWorktreePath`，注释写「otherwise the agent would be told to edit a path outside its isolation」）。
  按 `design/RFC-253-*/design.md:164` 文档使用该变量的脚本，Linux 静默蒸发 / macOS EPERM。
- ✅ **(P0，已修 2026-08-04) `readonly:true` 脚本节点在 wrapper 内跑在错误工作树**：`services/scheduler.ts:4214` 是
  `a.isoHandle?.repos[0]?.isoWorktreePath ?? task.worktreePath`，readonly 档 `isoHandle` 恒 null（`:4046`）
  ⇒ 回落顶层 `task.worktreePath`；而同文件 `:418-427` 明文规定 wrapper 内 canonical 是 `state.scopeRoot`
  并称用 `task.worktreePath` 是「the exact bug this RFC roots out」。wrapper 内先跑节点写的东西只读脚本
  看不见，无报错，静默产出错误结论。
- ✅ **(P2，已修 2026-08-04) 四个 `SandboxCtx` 装配点是四份手抄，三份丢字段**：只有 `services/runner.ts:1392` 消费
  `plan.readOnlyAllowSubtrees`；`runtimeSmoke.ts:240` / `systemAgentRun.ts:222` / `memoryDistiller.ts:972`
  静默丢弃它（及 `networkDeny`/`readOnlyWorktrees`）。今天不炸只因系统计划暂不带插件——一旦带上就原样
  复现 RFC-251 的 Linux 插件 ENOENT，且无任何断言会红。

### 根因 2 —— 能力收缩无影响清单

- ✅ **(P0，已修 2026-08-04) claude 受控节点的 skills 被整体关闭**：`runtime/claudeCode/spawn.ts:230` 无条件发
  `--disable-slash-commands`，而 `claude --help`（本机 2.x 实测）该 flag 的官方释义就是 **"Disable all skills"**
  ——不是注释写的「defense-in-depth against config-dir skills」。同一次 spawn 里还照常 stage skill 整树
  （`spawn.ts:245`）并把 `skill:'allow'` 翻成 `--tools …,Skill`（`permissionMap.ts:72`）。三者互相矛盾。
- ✅ **(P0，已修 2026-08-09) 同一处的下一层：`--setting-sources ""` 让技能目录根本不被扫描**。上一条修完，
  技能**仍然一个都进不去**——用户报「agent 依赖里配了 skill，运行时报找不到 skill」。受控 argv 无条件发
  `--setting-sources ""`，而 CLI 的用户级技能扫描是 `Tg("userSettings") && Y0r(join(Hn(),"skills"), …)`
  （`Hn()` = `CLAUDE_CONFIG_DIR`），`Tg` 读 `allowedSettingSources`，`""` 经 `zkc("")` 解析成 `[]`
  ⇒ `$CLAUDE_CONFIG_DIR/skills/*` 整个目录不 readdir，模型调用回 `Unknown skill:`（本机 2.1.226 二进制
  反查 + init 清单实测三组对照：`""`→技能不可见 / `user`→可见 / 不带该 flag→可见）。**结构性讽刺**：拿到
  `Skill` 工具的唯一途径是声明 permission，而声明 permission 的唯一后果就是进受控分支拿到 `""`——用户
  唯一会**故意开启技能**的配置，正好是唯一必挂的配置。修法：授予 Skill ⇒ 发 `--setting-sources user`
  （user-settings 根就是平台每次 attempt 新建的私有 config dir，`project`/`local` 仍关死）。
  **连带封一个提权面**：开 `user` 后技能目录里只要有 `.claude-plugin/plugin.json`，CLI 就把它当**插件**
  加载（实测 init 的 `plugins[]` 出现 `<name>@skills-dir`），而插件可带 hooks/agents/mcpServers ——
  `""` 此前只是碰巧一起挡住了；`stageSkills` 现按 basename 精确剔除该目录。**并补上缺失的证明**：
  `SpawnPlan.stagedSkills` + `driver.parseSkillInventory` + runner 对 init 技能清单做 fail-closed
  （与 RFC-242 T5 的 `fencedMcpServers` 同构）——五天内同一种「开关静默关掉本节点能力」出两次且全链零告警，
  这类失能必须能自己变红。
- ✅ **(P0，已修 2026-08-09) 同一根因族的第三条：`--agents` 无条件下发而 `Task` 未装载 ⇒ dependsOn 闭包整个调不动**。
  `driver.ts:237` 把闭包翻成 `--agents`，但 `Task` 只在 agent 自己写了 `task:'allow'` 时才进 `--tools`
  （`permissionMap.ts:69`）。真机 2.1.226：两种形态下 `init.agents` 都列出注入的 dep，前者 `init.tools` 无
  `Task` —— 子代理注册了、一个都调不动。**opencode 侧从不问用户 permission**（`hermetic.ts:864-868` 由闭包
  非空自动开 `task` 并限定到成员名），同一份定义换 runtime 就失去委派能力。修法照抄 opencode 的推导。
  **提权面实测证否**：内置 `general-purpose` 定义带 `tools:["*"]`，但在 `--tools Read,Task` 的父进程里
  委派过去自报 `TOOLS=Agent, Read` —— 父的 `--tools` 是硬上界。
- ✅ **(P1，已修 2026-08-09) 传递依赖的 model 与 permission 在 claude 上被整个丢弃**。平台**已经**为每个
  dependent 解析了 RFC-113 profile（`resolvedParamsByAgent` 契约原文「live-resolved for each dependent」），
  opencode 逐成员用上 model/variant/temperature/steps，claude 的 `toClaudeAgents` 只产 `{description,prompt}`。
  permission 同理：实测 subagent 的可用工具**就是父的装载集**，dep 的声明完全不参与 ⇒ dep 声明只读、
  父能写时 dep **过宽**。已改为逐成员发 `model` 与 `tools = dep 映射 ∩ 父装载集`（只收窄不扩张，且永不含
  `Task`——v1 无嵌套委派，对齐 opencode 的 `buildPermission(dep,false)`）；dep 要的工具父没有时显式告警。
- ✅ **(P2，已修 2026-08-09) claude 的 spawn 诊断在谎报注入**：`pluginCount`/`pluginNames` 报「选中的插件」，
  而 claude 没有插件面 ⇒ 日志说 N、进程装载 0；且完全缺 skills / subagents / 装载工具三项。已改名为
  `pluginsIgnoredUnsupported` / `pluginsIgnoredNames`（对齐 opencode 的 `machineConfigIgnoredPlugins`）并补
  三项，且与 runner 的 fail-closed 校验**同一份派生**。opencode verified 路径的诊断本就真实，只补了
  `skillNames` / `subagentNames`。
- ✅ **(结构性，2026-08-09) 把三条同型失效收成一个机制**：`SpawnPlan.declaredCapabilities`
  （tools / agents / skills）+ `driver.parseStartupInventory` + runner 的 `runtime-capability-missing`
  fail-closed。判据是**缺失**而非相等（运行时自带的内置项不关平台的事），运行时不报清单则放行
  （无法证明 ≠ 证否，fork 不该因此变红）。opencode 侧不需要新机制：它的 verified inventory 里 agents 是从
  `/agent` **真实读回**并做重名校验，skills 走 prompt 冻结块注入（内容就在 prompt 里，不存在「运行时不扫」
  这一失效模式），mcp/plugin 走密封 config。
- ✅ **(P2，已修 2026-08-09) 非围栏 MCP 没连上时完全不可见**：`--allowedTools` 放行**全部**注入的 MCP
  （`driver.ts:444` `mcpServerNames`），而 init 校验只覆盖**围栏的** local MCP（`fencedMcpServers`），
  差集（远程 MCP + 非围栏 local）连不上时模型少了它声明的工具、照样跑完、照样 `done`，日志零字。
  已加 `SpawnPlan.declaredMcpServers` + runner 的 `runtime-declared-mcp-unusable` 告警。
  **失败判据刻意不动**：远端挂了是外部故障而非平台配置问题，RFC-242 T5 只让围栏 MCP 失败的选择保留；
  本次只补可见性。**是否把「任何注入的 MCP 没连上」也升级为节点失败，是一个独立的产品决策，待定。**
- 🟡 **(P3，已登记未修) MCP playground（`mcpRuntimeTest.ts`）不读 init 的 `mcp_servers` 连接状态**：
  文件里的 `unusable` 全是 session 层面的，与 MCP 连接无关。该路径是**人在回路**的手动测试（用户会直接
  看到模型调不动工具），静默失能危害远小于业务节点；但「没连上」与「连上了但工具不对」在 UI 上不可区分，
  补一条 init 状态提示会让排障快很多。
- ✅ **(P0，已修 2026-08-04) claude 的部分 permission 声明 ⇒ 零工具且无告警**：`permissionMap.ts:110-155` 无 `'*'` 键时
  baseline 为 deny，且纯 deny 声明**不产生任何 warning**。一份从 opencode 直译的 `{bash:'deny'}` 变成
  `--tools ""`（help 原文 "Use \"\" to disable all tools"）。opencode 侧内置 defaults 是 `{"*":"allow",…}`
  后再 merge 用户声明，同一份定义两个运行时语义相反。
- ✅ **(P1，已修 2026-08-04) opencode netless wrapper 丢弃模型给的 `workdir`**：`runtime/opencode/sealedSubprocess.ts:1052`
  硬钉 `--chdir parsed.worktreePath`。opencode 的系统提示明确指示模型用 `workdir` 而非 `cd &&`
  （opencode 源码 `tool/shell/prompt.ts:112`），并据此设置子进程 cwd（`tool/shell.ts:611-613`）——平台把它
  扔掉 ⇒ 命令跑在仓根、相对路径全错、**静默产出错误结论**。monorepo / 多仓任务必中。
- ✅ **(P1，已修 2026-08-04) opencode 本地 MCP 拒绝 PATH token 且不解析解释器链**：`runtime/opencode/verifiedPlan.ts:264-271`
  对非绝对路径直接 `execution-identity-mismatch`；`:153` 固定 `FIXED_NETLESS_PATH='/usr/bin:/bin'` 且只绑
  可执行文件那一个 inode。官方文档形态 `npx -y @modelcontextprotocol/server-*` 保存成功、运行必失败；
  绝对路径的 `#!/usr/bin/env node` 启动器 exit 127。**claude 侧 RFC-242 已修**（`claudeCode/netlessMcp.ts:205-269`
  有 `Bun.which` + shebang 链解析并绑进边界），opencode 侧没跟——且 `verifiedPlan.ts:230-236` 的注释声称
  「opencode 的 `snapshotBusinessToolchain` 做了等价的事」不成立（那只封印 `bun`）。
- ✅ **(P1，已修 2026-08-04) opencode 业务 shell 的 PATH = `/usr/bin:/bin`**：
  `runtime/opencode/hermetic.ts:547` + `verifiedPlan.ts:153`，唯一补充是从 daemon PATH 找 `bun` 封一份
  （找不到只 warn）。生产机上 `node`/`npm`/`npx`/`cargo`/`go` 全部 command not found，Code→Audit→Fix 的
  「Code」段大面积失效，且模型只看到 127、无任何提示说明是平台换掉了 PATH。**修它需要新增「管理员声明
  可暴露给业务 shell 的工具链路径」的配置面 + 封印投影**，属能力面而非 bug，走独立 RFC。
- 🟡 **(P1，部分修 2026-08-04) `agent.network` 半落地**：schema/service 可写可存可导出
  （`packages/shared/src/schemas/agent.ts:252-267`、`services/agent.ts:284,444-445`），但其承诺依赖的
  `model-child-egress-v1` 在 profile 注册表里**不存在**（`services/sandbox/containmentCoordinator.ts:28-78`），
  `networkDeny` 的唯一消费方是脚本节点。写 `network:'allow'` 的 agent 拿不到网、写 deny 的也没围栏，
  而 UI/保存路径零提示。归 RFC-252 G4；**G4 落地前应在保存/导入路径对非空 `network` 显式告警**。
- ✅ **(P1，已修 2026-08-04) `sourceGuard` 祖先黑名单一路扫到文件系统根**：`runtime/opencode/sourceGuard.ts:74-99` 从 canonical
  worktree 逐级 `dirname` 到 `parse(x).root`，`FORBIDDEN_AT_EACH_LEVEL`（`:8-16`）含 `.opencode` / `reference` /
  `references` / `.claude/skills`。worktree 在 `~/.agent-workflow/` 下 ⇒ **`$HOME` 必被扫**。daemon 用户只要
  有 `~/.claude/skills` 或 `~/.opencode`，所有 verified 节点永久 `execution-identity-project-config-unsupported`，
  运维几乎不可能想到是家目录。**收窄扫描范围是安全决策**（需与 RFC-224 owner 确认）；**错误里带上命中的
  具体绝对路径是纯诊断改进，应立即做**。另 `existsUnsafe`（`:43-53`）把 EACCES 也翻成失败。

### 根因 3 —— 沙箱的错记到别人头上

- ✅ **(P0，已修 2026-08-04) `appHome/repos` 不存在时 Linux 每次沙箱 spawn 都硬挂**（三路独立命中）：
  `services/sandbox/policy.ts:299-302` 无条件 `--bind appHome/repos`（`:149` 还把它放进 `allowSubtrees`，
  于是 argv 里出现两对相同 bind），而该目录**只在首次 clone 时创建**（`services/gitRepoCache.ts:617` 是全仓
  唯一 mkdir 点）。全新装机跑 Runtime Test、纯 scratch 部署、记忆蒸馏、脚本依赖安装全都没有它。
  仓内自己的注释就写着「bwrap `--bind` of a missing source path errors the spawn」
  （`services/sandbox/index.ts:200-202`，scratch `.git` 为此加了 `existsSync` 门），镜像目录没加。
- ⏳ **(P1) 包装器失败的退出码分类四路互斥且都错**：全仓无一处识别 bwrap 1/125/126/127 或 `sandbox-exec`
  64/65。verified 路径 → `execution-identity-control-failed`（**永久**失败、不重试、语义指向「控制协议被篡改」）；
  claude/unverified → `${runtime} exited with code 1` 且烧满重试；脚本 → `script-nonzero-exit`；
  冒烟 → `stream-nonconforming`（「二进制不讲协议」）。
- ✅ **(P1，已修 2026-08-04) claude 的 `is_error` 终局结果业务路径零消费**：`parseTerminalResultError`（driver 已实现，
  `runtime/claudeCode/driver.ts:81`）全仓只有 `services/systemAgentRun.ts:680` 一个调用点。生产上鉴权失败 /
  订阅额度 / 网关错误被报成 `envelope-missing`（「没有输出信封」）并**先烧满重试**。这是 2026-08-04 事故
  「错误被吞成裸 nonce missing」的另一半——冒烟侧当天修了，业务侧没修。
- ✅ **(P1，已修 2026-08-04) 脚本节点的 `spawnError` 零读取方**：`services/execution/containedSpawn.ts:89,212,242` 产出，
  全仓 0 处消费；scheduler 只取 `stderrTail`（spawn 失败时恒空串）⇒ 用户看到「脚本进程无法启动」+**空详情**。
  且 `containedSpawn` **未接** 2026-08-04 新增的 `util/spawnDiagnostics.ts:explainSpawnEnoent`
  （wiring 锁 `tests/workspace-missing-fail-fast.test.ts:121-134` 只覆盖 runner/runtimeSmoke/systemAgentRun），
  所以同款「怪罪 bwrap」事故能在脚本节点原样复发，且这次连误导信息都没有。
- ✅ **(P2，已修 2026-08-04) 三档 profile 的准入失败一律报 `script-network-fence-unavailable`**：
  `services/scheduler.ts:4262-4273`——`readonly` 节点被拦时被告知「网络围栏不可用」，用户根本没勾网络。
- ✅ **(P2，已修 2026-08-04) `/api/runtimes/status` 的 containment 状态只算 opencode 行**：`routes/runtimes.ts:234-243` 带
  `row.protocol === 'opencode'` 前置，而 `sandboxEnforceBlocked` 与 containment 准入对所有运行时生效
  ⇒ **claude 行永远不显示被拦**（正是生产机型），首页说可用、任务却接连失败。
- ✅ **(P1，已修 2026-08-04) macOS 脚本节点的 `spawn_binary_path` 记的是沙箱壳，收割器永远杀不掉真实进程**：
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

- ✅ **(P1，已修 2026-08-04) `sandbox-degraded` 告警点「修复」必然 500**：`services/lifecycleRepair.ts:78-93` 的 `REPAIR_OPTIONS`
  只有 `R1 R2 C1 T1 T2 T3 U1 S1–S6` 十四键，`:137` 是无校验强转 ⇒ 取到 `undefined`，下一行
  `for (const def of defs)` TypeError。而前端对每行**无条件**渲染修复按钮
  （`components/tasks/TaskDiagnosePanel.tsx:183-191`）。
- ✅ **(P1，已修 2026-08-04) 同一告警的 rule/severity 都不在 canonical 枚举里**：`services/runner.ts:152-154` 写
  `rule:'sandbox-degraded'` + `severity:'warn'`，而 `packages/shared/src/lifecycle-alerts.ts:7-32` 的枚举无此 rule、
  severity 只有 `'warning'|'error'` ⇒ UI 逐字显示 `tasks.diagnose.rule.sandbox-degraded` 这样的裸键路径。
- ✅ **(P1，已修 2026-08-04) 该告警永不 resolve**：`services/lifecycleInvariants.ts:531-543` 的 reconcile 只处理 `ownedRules`
  内的行，两组 owner 都不含它；runner 侧只查重不 resolve。沙箱修好后横幅仍在，已完成的任务也仍在。
- ✅ **(P1，已修 2026-08-04) 脚本节点与依赖安装器的降级完全静默**：`alertSandboxDegradedOnce` 全仓只有
  `services/runner.ts:1414` 一个调用点。
- ✅ **(P2，已修 2026-08-04) claude 的四个 containment 告警码只进 daemon 日志**：`runtime/claudeCode/driver.ts:217,223,267,293`
  全是 `ctx.log.warn`，lifecycle_alerts / node_run 事件 / WS / 前端全链零命中。而本文件 §35/§38 正是靠
  「`unconstrained` 告警驱动收窄」——不看日志的管理员永远收不到。
- ✅ **(P2，已修 2026-08-04) 启动期 409 `sandbox-unavailable` 无 i18n**：`services/task.ts:1867-1876` 英文裸串，
  `DOMAIN_PREFIXES` 无 `sandbox-` 前缀。
- ✅ **(P2，已修 2026-08-04) 设置页不展示 reasonCodes；CLI 修复指引从 UI 不可达**：`SandboxCard.tsx:56` 只做 length 判断；
  `services/sandbox/guidance.ts:92-129` 的安装/userns 指引只有 SSH 上机的人看得到。
- ✅ **(P2，已修 2026-08-04) Linux 真 bwrap 行为在主 CI 的回归窗口最长 24h**：`.github/workflows/ci.yml:143-155` 只在 macOS shard 设
  `RUN_SANDBOX_ITEST=1`（注释明写 "ubuntu has no bwrap"）；唯一装 bubblewrap 的 `integration-opencode.yml`
  其 push path filter（`:42-58`）**不含** `services/sandbox/**`、`services/execution/**`、
  `services/runtime/netlessProjection.ts` ⇒ 这些文件的 Linux 行为回归窗口最长 24h（nightly 才红）。
- ✅ **(P2，已修 2026-08-04) runner 层沙箱接线变异不红**：`services/runner.ts:1375-1398`（sessionStore/readOnly\*/下传）与
  `:1406-1420`（warn 降级告警触发）整段删掉，现有测试零红。前者一断，RFC-251 的 Linux 插件 ENOENT
  原样复发且无预警。
- ✅ **(P2，已修 2026-08-04) 脚本节点 `network:'deny'` 的真围栏两 OS 均无 real-mechanism 测试**：只有 argv/渲染层断言。

### 本轮修复范围与仍未修的清单（2026-08-04）

**已修**（4 个 commit，见 `git log` 的 `f568deb6` → 本批；每条带回归锁，关键处做过突变实证）：
上面标 ✅ 的 21 条。新增测试文件：`sandbox-allowback-audit-2026-08-04`（含 runner 合并缝的
源码层锁）、`sandbox-multirepo-allowback-2026-08-04`、`sandbox-diagnosability-2026-08-04`、
`claude-capability-regressions-2026-08-04`、`netless-workdir-2026-08-04`；
`rfc205-sandbox-scratch-allowback` 的 fixture 改为落**真实** worktree 指针
（原来随手 mkdir 一个 `.git` 目录，不是任何真实布局）。

**2026-08-04 第二轮（用户要求「没修的直接修」）**：上一轮登记为「需独立 RFC / 需决策 / 需实测」
的 6 条，除 SIGTERM 一条外全部落地——

- **业务 shell PATH**：新增 daemon config `businessToolchainPaths`（绝对、已规范化、≤16 条，
  schema 层校验形状；默认**空** = 与修复前逐字一致，绝不从 daemon PATH 推断）。声明后按
  只读投影进子围栏（`bindReadOnly`）并前置进 PATH，与既有的 Bun 封印同一条装配线；spawn 时
  再校验一次存在性与目录性（配置写入后目录可能消失，而 bind 缺失源会中止整个子进程）。
- **`sourceGuard` 扫描范围**：按 opencode v1.18.x 源码逐条核对后收窄到工作树。两条向上遍历
  都以 worktree 封顶（`config/paths.ts:28-32`、`skill/index.ts:196-197`，`util/filesystem.ts:213-226`
  的 `if (stop === current) break`），唯一无界的读跟随 `HOME`，而受控配置把 HOME 指向私有
  hermetic home。原先的「每一级祖先都拒」严格宽于 opencode 实际读取范围，代价是任何有
  `~/.opencode` 或 `~/.claude/skills` 的 daemon 用户永久跑不了 verified 节点。祖先链仍被指纹化。
  **同时订正了一条名不副实的测试**——它标题写着 "matching upstream search scope"，而事实相反。
- **本地 MCP PATH token / 解释器链**：解析器提到 `netlessProjection.ts`，两个运行时共用。
- **claude 的能力移除事实进 `plan.diagnostics`**（审计 P2-9 自己提的通道）：`businessTools`、
  `businessToolWarnings`、`declaredNetwork` + `networkEnforced:false`。
- **设置页降级提示**：列出 reasonCodes + 指向 `agent-workflow sandbox`。
- **脚本 netless 真围栏**：新增 gated real-mechanism 用例（macOS 实跑 `sandbox-exec`、Linux 走
  `bwrap`），断言「出网被拒 **且** 工作树仍可写」，并带一条不加围栏的对照组——否则在本来就
  没网的环境里第一条是假绿。

**另外两条此前只靠推理的 Linux 断言，本轮一并在容器里实证**：①`--bind` 源缺失确实中止整个
spawn（`bwrap: Can't find source path …: No such file or directory`）——这是 `appHome/repos`
那条 P0 的前提；②appHome 打 tmpfs 后，sibling 仓路径在沙箱内 `mkdir -p` + 写入**全部成功、
读回也是新内容**，退出后宿主上仍是旧内容——多仓 P0 描述的「静默蒸发」通道由此从推断变成实测。

**仍未修，各有明确理由**：

- ⏳ **opencode 本地 MCP 拒绝 PATH token / 不解析解释器链**（上面 P1 条）——修法是复用
  claude 侧现成的 `netlessMcp.ts:canonicalExecutable` + `resolveInterpreterChain`，但落点在
  `runtime/opencode/verifiedPlan.ts`，该文件当前有**并发 session 的 RFC-255 未提交改动**。
  按 `CLAUDE.md` 多人协作原则不在别人在飞的文件上动刀；RFC-255 落库后单独一提交。
- ⏳ **opencode 业务 shell 的 PATH = `/usr/bin:/bin`**（上面 P1 条）——修它要新增「管理员
  声明可暴露给业务 shell 的工具链路径」的配置面 + 封印投影，属**能力面**而非 bug，按
  `CLAUDE.md` 走独立 RFC。这是本轮影响面最大的未修项：Code→Audit→Fix 的「Code」段在生产上
  大面积 `command not found`。
- ✅ **已随 RFC-276 收口废弃（2026-08-12 对账销账）：`agent.network` 半落地**——原归宿 RFC-252 G4 已被用户关闭不再排期；实际结局是字段整体移除：`shared/schemas/agent.ts:345` 现为 `network: z.never().optional()`（拒收任何取值），脚本节点侧 `shared/schemas/workflow.ts:897-903` 对 `network` 报 "removed and no longer enforced"。「看起来像已生效的开关」的风险已消除。
- ⏳ **`sourceGuard` 祖先黑名单扫到文件系统根**——诊断半已修（错误里给出命中的绝对路径）；
  **收窄扫描范围是安全决策**，需 RFC-224 owner 拍板（收窄 = 放宽一条 opencode 配置继承面）。
- ✅ **(已修 2026-08-04，Docker 实证) Linux bwrap 下取消的 SIGTERM 宽限塌缩为即时 SIGKILL**：
  在 Debian bookworm + bubblewrap 0.8.0 容器里用**平台自己的 `killProcessTree`** 做 A/B——
  旧行为下内层探针只留下 `INNER_STARTED`（连收到 TERM 都没来得及记），修复后完整走完
  `INNER_GOT_TERM → INNER_CLEAN_EXIT`。成因即组杀同时命中 bwrap monitor，monitor 在 TERM 上
  退出，`--die-with-parent` 随即 SIGKILL 掉 PID namespace 的 init。修法：优雅信号投给组内
  **除组长外**的成员（bwrap 在其子进程退出后自行退出），升级信号仍走整组；置位条件从**渲染
  出 argv 的拓扑**推导（`mechanism==='bwrap'` 且非 `provider-child-only`），而不是按 OS 名——
  macOS 的 `sandbox-exec` 原地 exec，组长就是运行时本身，放过它等于永远不发 TERM。
- ⏳ **claude 的四个 containment 告警码只进 daemon 日志**、**设置页不展示 reasonCodes /
  CLI 指引从 UI 不可达**、**脚本 `network:'deny'` 的真围栏无 real-mechanism 测试**——
  三条都是呈现/覆盖增强，不改执行语义，排入下一轮。

### 附：本轮已求证**不成立**的假设（勿重复挖）

`readonly` 档的 `git status`/`diff`/`log` 实测正常（git 拿不到 index 锁不致命，`add`/`stash` 如期失败）；
opencode 的 HOME/XDG/TMPDIR/store 全在 storeRoot 下且被并进放行集，**session resume 不会因 tmpfs 丢失**；
`--unshare-pid` 不破坏组杀（monitor argv 含内层命令，shape gate 命中）；32 仓的 Seatbelt profile 与 bwrap argv
离 `ARG_MAX` 还差三个数量级；`--unshare-net` 的 netns 里 **lo 是 UP 且带 127.0.0.1**（bubblewrap 0.8.0 容器实测，
此前 backlog 猜「默认 down」是错的——netless 脚本在 Linux 上可以用 localhost）；
`maskDiagnosticsText` 不会误屏蔽沙箱错误文本（反而欠屏蔽 `NAME=value` 形态）；
Seatbelt 的 appHome deny 不影响 allow 子树内的目录枚举 / `realpath` / `getcwd`（只影响逐级 stat 路径前缀的实现）；
`limits.ts` 不统计进程树（只算时长与 token），与沙箱拓扑无关；沙箱多一跳不造成 stdout 缓冲丢尾。

## 其他 backlog

- ⏳ **任务域 MCP 工具的审计行 `resource_kind` / `resource_id` 为空（RFC-326 实现期登记，2026-08-25）**：
  `token_audit` 的资源身份来自工具参数里的 `kind` / `id`（`mcp/server.ts` 的 `stringArg(args.kind)`），
  收敛工具天然带这两个参数；具名工具里 RFC-326 给评审 / 人工门工具加了 `McpToolDef.audit` 钩子
  （`{kind:'reviews', id: nodeRunId}` / `{kind:'human-gates'}`），但 `launch_task` / `watch_task` /
  `cancel_task` / `resume_task` 这一族仍走参数回退——它们的 id 参数名是 `id`，`kind` 缺失，于是
  审计行只有工具名、没有资源类别。**建议处置**：给任务工具补 `audit: (args) => ({ kind: 'tasks', id })`，
  同批把 `rfc247-token-audit.test.ts` 的断言从「toolName 对」扩到「resourceKind 对」。不在 RFC-326 内做：
  它是任务域的审计契约改动，应随任务域下一个 RFC 一起过实现门。
- ⏳ **网页选词的 `offsetStart` 仍是按比例位置的启发式（RFC-326 D5 后的残留，2026-08-25）**：
  `packages/frontend/src/lib/review/anchor.ts` `computeAnchorFromSelection` 用「渲染文本进度 × 源文长度」猜
  所选出现的源偏移，再由服务端 `canonicalizeAnchor`（策略 0 → 上下文策略）修正并把 `offsetStart/End`
  改到真实出现；高亮已改按源偏移投影（`rehypeWrapAnchors` `mode:'source-offset'`），所以这条启发式
  只影响「服务端要修正多少」，不再影响高亮位置。**根治**是前端也按源文位置反解选区（hast `position`
  已在渲染树里，投影表可以反向查），留给下一个评审 UI 的 RFC；届时把 `rfc326-anchor-canonicalize.test.ts`
  里「策略 0 需要上下文匹配」那组用例作为兼容基线。

- ⏳ **被任务终态封存的澄清轮，作答被拒时的错误码把原因说反了（RFC-319 B40 实测，2026-08-25）**：
  任务走到 done/canceled 时，终态清扫把开着的 self 轮封成 `canceled`
  （`services/terminalSweep.ts:76-110`）。此后再作答会被拒——但拒它的是外层那道
  `round.status !== 'awaiting_human'` 守卫（`services/clarify/autoDispatch.ts:550-555`），
  返回码是 **`clarify-already-answered`**。**没有人答过它，是任务结束了。**
  真正贴切的码在更深一层：把外层放开后实测仍被 `sealRoundQuestions` 拦住，返回
  `clarify-round-terminal`——即「能不能答」本身是双保险，这条**不是安全问题**，只是措辞问题。
  用户可见的形态：cancel 之前就打开了澄清页的那个人（页面不会自己变），点提交拿到
  「已经有人答过这一轮」——他会去找那个并不存在的同事，而不是去看任务为什么被取消。
  **建议处置**：让外层守卫对 `canceled` / `abandoned` 走 `clarify-round-terminal`，
  `clarify-already-answered` 只留给真的 `answered`。改动落地时
  `e2e/clarify-round-sealed-readonly.spec.ts` 那条码断言会红——它锁的是当前实际行为，
  红了正是提醒改的人顺手看一眼那段注释。
  未在 RFC-319 里顺手改：这条守卫同时服务快速通道 / 控制通道 / 自动下发三条路径，
  改码值要连它们的判据一起过一遍，超出「补 e2e 覆盖」的范围。

- ⏳ **backend 分片「静默 120s 被 SIGKILL」实撞一次（2026-08-16，未复现，但**杀进程时不报是哪条用例**）**：
  `gate:local` 一次红在 `[backend 4/4] FAIL timeout 239.9s`，日志形态是
  `IDLE TIMEOUT after 120000ms without output; sent SIGTERM to process group … SIGKILL`
  ——**没有失败断言**，已跑出约 1000 个点后整片静默。当次改动只有一个 e2e spec（backend
  lane 根本不读 e2e/），同一棵树立即重跑 `EXIT=0` 全绿，当日其余多轮门禁亦全绿 ⇒ 判为
  **某条用例阻塞 >120s**，而非新引入的确定性挂起。
  静默前最后的日志上下文是 `rfc213` 的 `pendingRestore` 负向用例（`tar` 解包失败 /
  DB swap 后失败那两条）——它们会 spawn 子进程，**子进程不返回**正好产生「静默而非断言
  失败」这个签名，是首要怀疑对象（未证实）。
  **真正该修的是可诊断性**：`scripts/local-gate.ts` 的 idle-timeout 杀手只打印进程组，
  **不打印当时正在跑哪个测试文件**，所以撞上的人（本次即我）除了瞪着一排点以外无从下手。
  待办：让 idle 超时在 SIGTERM 前先打印「最后开始 / 尚未结束的测试文件」（bun test 的
  `--dots` 下需换 reporter 或记录最近一次文件切换），否则下次复现还是从零开始。判据：
  再次出现 `IDLE TIMEOUT` 且无用例名 ⇒ 先补这条诊断输出，别急着猜是哪条。

- ⏳ **sandbox-era backlog 条目全量重定性（2026-08-12 审计对账登记）**：RFC-276 删除 sandbox/containment/netless/verified 体系后，本文件「运行时/沙箱能力收口盘点」「沙箱/containment 功能性审计」「RFC-252 残留」「RFC-224 能力回退」「verified TOCTOU」「RFC-254 verified 簇」各节数十条条目需逐条判定 moot / 转世为新形态欠账 / 仍有效（例：hooksPath 豁免的 hook 执行风险不依赖沙箱、仍真实存在；bwrap 系全部 moot）。本轮只加了节级横幅，逐条重定性属独立对账轮。
- ⏳ **2026-08-12 系统公共功能审计的「本轮不修」清单**：前端 UI 层（Card 迁移 ~151 条 bespoke 规则、CopyButton/MetaGrid/LocalizedDateTime/CollapsibleSection/MetaDots 等可抽取原语、intent 选项 UI 复用 QuestionForm、canvas inspector `form-input` 直落×5、Checkbox 迁移收尾 8 处、死 CSS ≥17 namespace、33 处裸 details、copy 状态机 8 文件）+ fanout hydration 语义分叉（scheduler.ts:6951-6954）+ DB 列 `opencode_session_id` 命名残留。完整清单与理由见 `design/system-commons-unification-audit-2026-08-12.md` §7；决策 D13-D17 拍板不做。
- ⏳ **syncTaskWorkflow 未开 worktree 预检（2026-08-12 审计登记，代码注释 "for now" 此前无登记载体）**：`services/task.ts:2893-2897` `worktreePreflight` 仅 resumeTask 开启；sync 复活 worktree 已被 GC 的任务不会 410-fail-fast（RFC-165 复活门兜住墓碑行，缺口仅「墓碑未打但 dir 已丢」走 CAS 内 heal-forward）。待 sync harness 用真 worktree 时开启同一预检。

- ✅ **已修（2026-08-08，RFC-270 push 撞红后就地根因修复）：`rfc224-fff-capability` 的「daemon EOF kills a
  descendant」用例给 marker 轮询的预算只有 1 秒**。CI（macos-latest shard 3/4，run 31205560040）红在
  `expect(Number.isSafeInteger(descendantPid)).toBe(true)` —— 收到 `NaN`，即整整 1 秒里 marker 文件
  从没出现。根因是预算本身：marker 要等**两次 bun 冷启动**（supervisor 跑的是 `main.ts`，其 import 图
  经 `./cli/start` 拉进整套 app wire；它再 spawn 一个 `-e target` 的 bun，那个才 spawn `/bin/sleep`
  并写文件），而原预算是 `100 × 10ms`。本机实测 `bun run main.ts version` 单次冷启动约 **0.30s**（空载、
  Apple Silicon、缓存热），loaded 的 macOS runner 上四个 backend 分片同时在跑，两次冷启动塞不进 1 秒。
  已改为 deadline 式 20s 预算，并给该用例补上显式 `60_000ms`（同文件其它真 spawn 用例在 `754eafde`
  就拿到了显式超时，**这一个被那批漏掉了**）。断言强度不变：supervisor 真的坏掉仍然会红，只是慢一点
  才说。**这不是 RFC-270 引入的**（本 RFC 只往 `main.ts` 的 import 图里加了两个无 I/O 的小模块），
  但既然是本次 push 撞红的，就地修掉而不是登记了事。

- ⏳ **`gate:local` 在满载机器上会随机红掉计时敏感的后端用例（模式，非单条）**。RFC-270 实施期
  两次连跑 `gate:local` 分别红在**不同**的用例上 —— `RFC-098 WP-8 runner escalation ... 
child AND grandchild group-killed`（5537ms）与 `rfc199 start-task-cleanup-incomplete`
  （git `cannot lock ref ... is at X but expected Y` 的并发竞争）—— 两条单独重跑都全绿，
  且当轮 diff **一行后端代码都没碰**（只有 design.md / WorkflowCanvas.tsx / 两个 i18n /
  一个新前端测试），归属为机器饱和而非改动。`gate:local` 把 backend 四分片与 quality lane
  **并发**跑，本机（Apple Silicon）上足以让真 spawn + 计时预算的用例踩线。
  **2026-08-09 第三次复发**（RFC-271 批次 J 门禁，5530ms；隔离连跑 2/2 绿）。注意这次
  是在**跑飞进程已被清掉**之后——即第十条那个「有分片在偷核」的解释**只覆盖部分**复发，
  这条用例即使在健康负载下也会踩线，说明它自己的预算确实按空载机器写的。
  **2026-08-09 再次复发**（RFC-271 T7/T8 门禁，5691ms）：同一条 WP-8，当轮 diff 只有一个迁移 +
  一个新 `services/bundle/provider.ts` + 一个纯函数测试，与进程治理零交集；隔离连跑 3/3 全绿。
  即这条模式**至今仍在**，且复发间隔以「一次满载 gate」计——它不是偶发噪音，是预算写法的问题。
  **可操作的解法**：把这类真 spawn / 计时用例的预算从「够快的机器上够用」改成「饱和时也够用」，
  或给 `gate:local` 一个降低并发的开关。在那之前，判据是**分开跑两条车道**（`bun run test:backend`
  与 quality 各自跑）取干净信号 —— 这不是「重跑就过」，因为它换掉的是执行条件而不是结论。
  **2026-08-19 扩面：`cannot lock ref` 这一支也出现在 GitHub Actions 上，不再只是本机现象。**
  连续扫 `main` 最近 12 次 CI，命中 2 次、且分别红在**不同用例**上：`f8b2a3a8` 的
  `RFC-098 B1 … ready downstream node is dispatched WHILE the slow commit session runs`
  （ubuntu shard 1/4，日志里先出 `WARN [scheduler] merge-back failed nodeId=n2
error="reset --mixed: … cannot lock ref 'HEAD': is at 5604ee04… but expected 8bcda365…"`）；
  `dfda2d02` 的 `CLI subcommands (P-1-05) > RFC-300 boot resumes an already-authorized scratch prune`
  （`cannot lock ref 'refs/heads/agent-workflow/<taskId>'`）。两笔当轮 diff 一个是纯文档、
  一个与 git/scheduler 零交集；RFC-098 那条本机连跑 **5/5 全绿**。
  **值得单独想清楚的一点（不只是预算问题）**：报错发生在**产品代码**里（`scheduler` 的 merge-back →
  `util/git.ts` 的 `reset --mixed`），而 `is at X but expected Y` 的语义是**读到写之间 ref 被别人改了**
  ——即同一个源仓上有两个并发写者。任务各有 worktree 但共用同一个 `.git`，所以**同仓两个任务同时
  merge-back 在生产上可复现同一竞争**，不是测试独有。也就是说这里可能藏着一个真缺陷（merge-back
  缺重试 / 缺串行化），CI 的饱和只是把窗口放大。**下一步**：给 merge-back 的 ref 更新加有界重试并
  写一条并发 merge-back 的回归用例，再回头判断 CI 这两例是否随之消失。

- ⏳ **`prose-code-mermaid-theme.test.tsx` 的主题切换用例在满载机器上仍会超时（RFC-270 实施期撞上，
  非本 RFC 引入）**。用例 `toggling <html data-theme> dark→light re-invokes MermaidBlock.render with
new theme` 在一次 `gate:local` 里红（耗时 ~5050ms，恰好压在它自己那条 5000ms 显式预算上）；
  该 lane 与 backend 四分片并发跑，机器满载。归属明确：owning commit `f37ef44d`
  （标题就是「fix macos-only flakes in … mermaid theme test」），测试顶部注释已写明根因是
  `useResolvedTheme` 的 MutationObserver → setState → useEffect → renderSpy 这条效果链在慢 runner
  上吃不下默认预算，当时的处置就是把超时从 1s 提到 5s。**与 RFC-270 无关**：本次改动不碰
  prose / mermaid / theme 任一路径；隔离重跑 3 次、全量前端套件重跑 3 次（728 文件 / 6154 用例）
  均全绿，只在满载并发那一次红。**2026-08-08 再复现一次**，同样只在 `gate:local` 的满载并发下（backend
  四分片 + quality lane 同跑），单独跑前端全套（728 文件 / 6155 用例）仍然全绿 —— 两次复现的条件完全
  一致，可以确定判据就是「机器满载 ⇒ 那条 MutationObserver 效果链吃不下 5s」。按仓规登记而不是拿
  「重跑就过」当结论。建议 owner 换成事件驱动的等待锚点（或再提预算），不宜由无关改动顺手改测试。

- ✅ **RFC-324 已修（2026-08-25）：非 owner 打开别人的工作流，编辑器完全可交互，第一次自动保存才 403，且文案是错的**
  （2026-08-08 用户实报，**非 RFC-270 引入** —— `assertPrincipalCanWritePreflight` 的
  `only the workflow owner or an admin can modify it` 在 `7174013b` 及更早就在，两处）。
  后端逻辑是对的：普通用户能看别人的公共工作流，但不能改。错的是前台没对齐这条边界 ——
  画布让他随便拖、随便改，`healLoadedDefinition` 在打开时就可能打出第一发自动保存，然后吃
  一个不带 code 的 403，被判成 `inaccessible`，弹出「无法继续访问此工作流 / 此工作流可能已
  删除或权限已变化」。**那句话两条都不成立**：工作流既没删，权限也没变，他从来就没有写权限。
  正解与 RFC-270 同款两层：①编辑器对非 owner 进入只读态（画布不可拖不可改、Inspector 只读），
  ②`forbidden` 这一码单独分流出自己的文案（「你没有修改此工作流的权限，可另存为副本」），
  别再复用「可能已删除」。**注意**：修的时候要连 `workflows.edit.tsx:1400` 的
  `isWorkflowAccessLoss`（GET 侧 `403 || 404`）一起想清楚 —— 那里的 403 也可能是「看得见但改不了」。

  **RFC-324 的实修（三处，全部按上面这段的处方）**：①`canUpdate` 纳入行级授权档，编辑器既有的
  `readOnly={!canUpdate}` 整条只读链路（画布三 flag、Inspector、保存/删除入口、`commitDefinition`
  早返回）随之生效；②`healLoadedDefinition` 那发自动保存**单独加了闸门**——它直接调
  `controller.commit`、绕过 `commitDefinition`，正是「一打开就 403」的那一发，现在要求
  `workflowAccess.isResolved && canUpdate`（等已解析的判定，不骑乐观值）；③`isWorkflowAccessLoss`
  把 `resource-read-only` / `resource-govern-owner-only` / `resource-rename-owner-only` 三个码
  从「访问丢失」里剥出来，只读拒绝不再显示「可能已删除」。源码层三条锁在
  `packages/frontend/tests/rfc324-editor-readonly-source-lock.test.ts`。

- ⏳ **RFC-270 遗留：被遮蔽读者的 `snapshotHash` 不对称（已知、显式不修）**。后端
  `workflowSnapshotHashOf` 与前端 `hashWorkflowDraftSnapshot` 是同一个算法，脱敏之后被遮用户
  本地算出的 hash 与服务端返回的不再相等。影响面逐处核过**只有一处**：
  `lib/workflow-editor-draft.ts` 里「refetch 抢在 PUT 回执之前到达」的快速结算路径
  （`observation.revision.snapshotHash === attempt.snapshotHash`）对被遮用户不再命中，落回常规
  冲突判定。CAS 不受影响（客户端回传的 `expectedSnapshotHash` 取自服务端给的值，比较两端同源），
  脏检测不受影响（比的是两份都被遮过的本地快照）。**不修的理由**：修它要让 hash 也过镜头，于是
  同一 revision 对不同观察者有不同 hash，会污染 WS 帧与 CAS 语义，代价远大于收益。若将来真要修，
  正解是让服务端按观察者镜头计算并同时改 WS 帧，而不是在前端补丁。
- ⏳ **`/repos` 对普通用户暴露全部写操作按钮（RFC-270 全面排查发现，未修）**。读是合法开放的
  （`repos:read` 在 `USER_BASELINE`），但 `routes/repos.tsx` **零权限判断**，而 `repos:create` /
  `repos:update` / `repos:delete` / `repos:execute` 全在 `MANAGER_EXTRA`。于是普通用户看到并可点：
  批量导入、新建组、逐行刷新、逐行删除（danger 样式），全部 403；删除被 N 个任务引用的仓库时还会
  先弹「此仓库被 N 个任务使用」的确认框。不是数据泄露，是**能力面泄露**。修法与 RFC-270 同款：
  按权限隐藏/禁用写操作入口。
- ⏳ **memory distill jobs 的反向洞：UI 比 API 严（RFC-270 全面排查发现，需产品拍板）**。
  `/memory` 的 distill-jobs 分区与 `/memory/distill-jobs/$jobId` 只在**前端**按 admin 拦
  （`routes/memory.tsx` / `memory.distill-jobs.$jobId.tsx` 的 `useIsAdmin`），而后端
  `routes/memoryDistillJobs.ts` 要的是 `memory:read` —— 它**在 `USER_BASELINE` 里**。所以
  `curl /api/memory-distill-jobs` 用普通用户令牌返回 **200**，含蒸馏候选与 LLM 会话记录；前端那道
  拦截是唯一的控制，PAT / 直接 fetch 一走一个准。二选一：要么 UI 的限制是错的（撤掉），要么后端
  的点是错的（需要一个 admin-only 点）。**这是 RFC-099 D12 把 `memory:*` 移进用户基线时留下的
  不一致，不是本次改动引入的。**
- ⏳ **`nav.ts` 的 `adminOnly` 标志已成死代码（RFC-270 全面排查发现，文档失真）**。RFC-260 把
  `/webhooks` 的 `adminOnly` 摘掉之后，`NAV_GROUPS` 里没有任何一项再设它，但 `ShellNavigation.tsx`
  的过滤逻辑还在、`router.tsx` 与 `nav.ts` 三处注释仍在描述那个已不存在的世界。机制**从未在生产
  跑过**，下一个写 `adminOnly: true` 的人会依赖一条零覆盖的过滤。要么删掉机制与注释，要么给它补
  一条测试。

- ⏳ **`intent-builder` RFC-293 e2e flaky（2026-08-15 观测，非 RFC-304 引入，需 RFC-293 owner 处置）**：`e2e/intent-builder.spec.ts:126` 的 "RFC-293 workbench queues context, iterates around checkpoints, discards, and **scrolls independently**" 在 `79aedd04` 的 `Playwright e2e (shard 1/4)` / macOS 上两跑两红。**判为 flaky 的四条判据（不是「重跑就过」）**：①**两次失败在不同 locator 上**——首次 `getByTestId('intent-composer-submit')`，retry1 `getByRole('dialog').getByRole('button', { name: 'Refresh after this turn' })`；确定性失败不会换位置。②**两次的机制不同，别当成同一个病**（2026-08-15 trace 逐条比对更正：初稿把两次都判成稳定性超时，照那个方向修会去调 stable 判定或加超时，**方向完全错**）。**首次**确是稳定性超时：call log 有 `locator resolved to <button … data-testid="intent-composer-submit">Continue refining</button>`，卡在 `visible, enabled and **stable**`——流式内容 + 独立滚动让 bounding box 持续变化。**retry1 则是元素压根不存在**：`0-trace.trace` 里五个动作的 actionability 日志逐条比对，前四个都有 `locator resolved to <…>`，**唯独失败那次只有一行** `waiting for getByRole('dialog').getByRole('button', { name: 'Refresh after this turn' })`，locator 从未 resolve。根因在 `packages/frontend/src/components/IntentMountDialog.tsx:158`——`props.inFlight ? (…workingContextQueue…) : (…)`，**该按钮只在 turn 在途时渲染**；测试靠 `STUB_INTENT_DELAY_MS: '900'`（`e2e/fixtures/stub/mode-intent.ts:127`，**每轮**都 sleep 该值）撑窗口，CI 慢时从 turn 起跑到该点击之间的 `waitForURL` + 开弹窗 + focus + 选项 + `Escape` 累计超过 900ms ⇒ `inFlight` 翻假 ⇒ 分支切换 ⇒ 按钮消失 ⇒ 15s 空等。**这正是本文件 08-14 webkit nightly 那条里悬着的「第二个竞态」**（原话：「webkit 侧那次仍红且形态不同（按钮从未出现，不是 detach），说明该 spec 至少还有第二个竞态未解」）——它 08-15 打到了 chromium，机制到此坐实。③用例名里就写着 `scrolls independently`，正落在滚动/动画时序面。④**归属排除**：`7d3ee340`（全绿 30/30）到 `79aedd04` 的 diff **只有 4 个文档文件**（`design/RFC-304-*/{proposal,design,plan}.md` + `docs/dev-gotchas.md`），且已逐条核实 e2e 中所有 `docs/` / `design/` 引用与它们无关——`docs/customer-policy.md` 是夹具虚构路径、`/docs/api` 是 HTTP 路由、`design/RFC-206-…` 是注释。**与本文件已登记的 unsaved-guard / centralized-answer-pane / prose-code-mermaid 是同一形态**（轮询式等待一个跨 turn 的 UI 稳定态，满载 runner 上越线），处置方向同样是**换事件驱动锚点而不是继续加超时**。**取证方式记一笔**：job log API 取不到内容（返回 0 行），改从 run artifacts 里下载 `playwright-trace-macos-latest-shard1` 解压，`test-results/*/error-context.md` 里有完整 call log 与失败位置——这条路径比 `gh run view --log-failed` 可靠。 **另外三层（2026-08-15 补）**：⑴**两个 flake 点相互独立，只修一个仍会红**——这是最容易让下一个人以为修完了的地方。⑵**`2a286abc` 是帮凶**：它为治 detach 竞态在 retry1 那次点击**之前**插了 `await expect(workingDialog.getByText(/e2e-working-context/)).toBeVisible(…)`，确实治好了 detach，但**等待时间正是从 900ms 在途预算里扣的**——用一个竞态换了另一个竞态（教训已提炼进 `docs/dev-gotchas.md`）。⑶**正解不要走「把 900 调大」**：调大仍是竞态、只是概率小一点，属仓规禁止的「重跑就过」的变体；应把首轮 in-flight 窗口做成**确定性**的（例如 stub 支持 hold-file：首轮阻塞到测试写出释放文件为止，后续轮次见文件已存在直接过，零固定开销），且**必须同时覆盖首次那个稳定性点**。**未当场修的理由**：修法要同时动共享 stub 夹具与两个机制不同的点，而**本地复现不了**（`2a286abc` 实测本地 7/7 全绿，机器快 ⇒ 窗口永远够），唯一验证面是 CI——不在共享 main 上 push 一个只能靠 CI 反复试的假设。

- ⏳ **两条 CI flaky（RFC-269 实施期间连续撞上，均非本 RFC 引入，各需 owner 处置）**：仓规明令「绝不允许『重跑就过了』作为通过依据」，故在此登记而不是就地重跑了事。
  - `packages/frontend/tests/unsaved-guard.test.tsx > dismiss via ESC = stay, then a later nav blocks again`（owning commit `5a1f6993` / RFC-250）：**仅 macOS shard 1/3** 红，该用例耗时 `5139ms`（同文件其余用例 ~100ms），ubuntu 同分片绿、本地 19/19 稳定绿。症状是 ESC 后 `unsaved-guard-dialog` 仍在 DOM 里 —— `waitFor` 等的是「消失」，在慢 runner 上像是没等到重渲染。归属判据：该测试自建路由树、**不 import 真实 settings 路由**，与并发改动零耦合。
  - `RFC-227 REAL macOS Seatbelt provider (gated) > denies app secrets, seal writes, and child network while preserving worktree writes`（owning commit `5c3eacf1` / RFC-252 G2）：**仅 macOS shard 1/4** 红，耗时 `5015ms` 像是撞上超时上限。**硬证据表明与代码无关**：红 run（`b2754f65`）与它前一个绿 run（`7322beef`）之间的全部差异是 **两个 `.md` 文件各改一行**；两行 markdown 改不了 macOS 沙箱行为。两条都在重跑后整 run success。
    **Seatbelt 那条已修（用户拍板后动手）**：根因确证 —— 该用例只在 CI 跑（`ci.yml` 的 macOS 腿设 `RUN_SANDBOX_ITEST=1`，本地恒 skip，所以躲过全部本地门禁），而它内含一次**预期被网络围栏拦住**的 `curl --max-time 2`（必然走满 2 秒）加多次 `sandbox-exec` 冷启动；本机 380ms、runner 5009ms，正卡在 bun 默认 5000ms 上。已给两个 gated 用例加显式 `30_000ms` 超时并在文件顶部写明理由（真挂起仍会失败，不是把上限抬到永不触发）。
    **RFC-250 名下现在是两条，建议 owner 一起处置**：除 unsaved-guard 外，
    `centralized-answer-pane.test.tsx > single-choice digit key picks the option AND advances to the
next question` 于 2026-08-08（run 31208702050，ubuntu shard 3/3）红，耗时 `10026ms` —— 它**已经被
    放宽过一次**（`7a1c119c`：3s→10s，理由就写着「loaded CI 时序」），10 秒仍然不够。测试里那条注释
    已经点出根因：数字键处理器是**原生监听器**，受控 radio 的 React commit 在满载 runner 上可能落到下
    一个 turn。继续加超时是治标；正解是等一个**事件驱动**的锚点（例如 `findBy*` 配合真实的 commit 信号）
    而不是轮询 `checked`。该测试只 import 自建 QueryClient / api / clarify libs / auth store / i18n，
    与 RFC-270 改动无任何 import 路径相连。
    **复发频次值得注意**：仅 RFC-270 实施期的 6 次 CI 里它就红了 **3 次**（ubuntu shard 3/3 为主，
    耗时稳定压在 10026 / 10033ms —— 即正好越过它自己的 10s 预算），已是本仓命中率最高的一条。
    继续加超时只会把这个数字往后推；根因是拿轮询式 `waitFor` 等一个**原生监听器 → 受控 radio 的
    React commit**跨 turn 的效果，满载 runner 上随时越线。
    **2026-08-08 第 4 次复发（run 31242157114，`c24eeeb0`，windows-latest shard 3/3）**：这次是 **windows** 腿，说明它和 unsaved-guard 一样**不挑 OS**（此前记的是「ubuntu 为主」）。失败快照给出了根因的直接证据 —— 两个 `<input type="radio">` **都没有 `checked`**，即数字键的原生监听器已触发、受控 radio 的 React commit 还没落，`waitFor` 轮到超时；这与登记里推断的一致，不必再猜。归属仍与触发它的改动无关（该 run 含的两笔提交分别只动 backend `services/intent/*` + 两份 md、以及 `design/RFC-271-*/` 三份 md）。**该 run 的其余失败都是它的连带**：`Playwright e2e (shard 2/4)` 是被这条 failure 触发的 cancel，不是独立问题。**（✅ 2026-08-13 centralized-answer-pane 已修——根因与修法见下方第六条的处置段；unsaved-guard 仍开放。）**
    **✅ unsaved-guard 已治本（2026-08-13，93f02dd0 CI ubuntu 腿再红一次后定案）**：根因与 centralized-answer-pane 数字键同族——Dialog 的 Escape 是 passive effect 挂的 window 原生监听，`findByTestId` 在挂载 commit 微任务 resolve、effects 排后续宏任务，同步 ESC 在监听挂上前被吞 → waitForElementToBeRemoved 永不 resolve。历史三次事故全是 ESC 变体、×/overlay（合成事件）从未红，与机制完全吻合。修法同配方：dismiss 前 `await act(async () => {})` 冲刷 effects（unsaved-guard.test.tsx 注释详述）。
    **2026-08-08 复现（RFC-270 push `c584d6bb`）**：同一测试同一 `test.each` 分支（`ESC`）在 **windows-latest shard 1/3** 又红一次，耗时 `5178ms`，而同文件的 `×` 分支同一 run 里 187ms 通过 —— 两条走的是同一个 helper，27 倍的耗时差说明是时序而非逻辑。**归属不变**（该测试自建路由树，只 import `__root` / `ResourceSplitPage` / `splitDirty` / auth store / i18n，**不 import** 任何 RFC-270 改动的模块），且现在已知它**不是 macOS 独有**，两个 OS 都能命中。
- ⏳ **call-workflow / call-workgroup 的目标选择器在 intent 路径退化成裸名字（Codex 实现门 P1-1，2026-08-08 登记；当前只做了 doc 侧缓解）**：意图会话手里**有 handle**（inventory 每行都印着 `res#workflow#N`），却只能把 `workflowName` 这个裸名字写进定义 —— 信息在这一步白白丢掉。而 `workflows.name` **非唯一**（`db/schema.ts:478` 明写），`resolveIntentBundle` 既不解析 call ref 也不回填 `workflowId`（`resolveChangeset.ts` 对 `workflowName` 零处理），于是 launch 期 `freezeCallClosure` 走 name fallback、按「启动者可见行里最老的 ULID」定夺（`execution/closure.ts:173-176`）—— **可能执行的不是用户挂载的那一个**。第二条相关缺陷：用户在确认界面用 `finalName` slot 给同 bundle 的新建目标改名后，caller 的 selector 仍是模型写的旧名（`nameOf` 只覆盖被改名 op 自己的 payload，`resolveChangeset.ts:479`），留下一个指向不存在名字的 stale 引用，launch 期报 `call-workflow-ref-missing`。**本轮只做了 doc 缓解**：INTENT.md 现在明说「名字不是稳定引用、改名会打断所有 caller」「名字不唯一、命中多个时 launch 绑最老的可见行，该问用户而不是猜」，并要求只对 mounted 目标建 call 节点。**正解是子系统改动**（intent 侧接受 handle/tempRef → resolve 阶段解析成 canonical id + final name → 同时写 `workflowId` 与 `workflowName`），要动 `IntentRefSchema` / `resolveIntentBundle` / apply 三处，按 `dev-gotchas.md` §impl-gate 经验规律属「生产逻辑类 finding = 子系统级」，不在本次 doc 补齐范围内，留给 RFC-243 owner。**注意画布路径同样只写 name**（`nodePalette.ts:198` 的 `makeDefaults: () => ({ workflowName: '' })`），所以这不是 intent 独有的降级，而是 RFC-243 的既有设计面 —— intent 只是**本可以做得更好却没有**。
- ⏳ **第六条同源 flaky：`prose-code-mermaid-theme.test.tsx > toggling <html data-theme> dark→light re-invokes MermaidBlock.render with new theme`**（2026-08-08 本机满载 `gate:local` 复现一次，backend 四分片与 frontend 729 文件并发）。**归属明确不是触发它的那次改动**：该轮 diff 只有 backend 的 `intentDoc.ts` + 四个 backend 测试 + 两份 md，`git diff --name-only HEAD | grep frontend` 为空；单跑该文件连续 3 次 3/3 全绿，只有全量并发时才红。**与已登记的 unsaved-guard、centralized-answer-pane 是同一形态**，值得一起处置：三条都在用轮询式 `waitFor` 等一个**跨 turn 的 React commit**（这条是 `MutationObserver` → setState → useEffect → renderSpy 的四段链），满载 runner 上随时越线。而且三条**都已经被放宽过超时**——这条的注释里就写着「2026-05-22 CI run 26297919707 确认环境 flake，把默认 1s 提到 5s」，如今 5s 也不够。**继续加超时是这类问题的错解**：预算只要还是「猜一个够大的数」，负载一变就再越线。正解方向一致——换成事件驱动的锚点（等一个真实的 commit 信号 / `findBy*`），而不是轮询状态直到超时。
  **2026-08-11 新观测（Windows 腿首次记录）**：`centralized-answer-pane.test.tsx > ONE-question dialog: digit pick enables submit but focus does NOT flush to it` 在 **`Frontend tests (windows-latest shard 3/3)`** 上 `Test timed out in 20000ms`（run 于 `645e63a3`）。**归属非该轮改动**：`645e63a3` 是 RFC-282 v2 的**纯文档 commit**（`git show --stat` 确认 5 个文件全是 `.md`：三件套 + `design/plan.md` + `STATE.md`，零代码），且同 SHA 的 macOS/Linux 前端腿全绿、本机 `gate:local` frontend 全绿。**该 job 在 superseding commit `909939e3` 上转绿**，进一步坐实 flaky。（原记此处为「RFC-281 commit 只动 4 个 backend 文件」——SHA 与改动内容对不上，由 `645e63a3` 的作者据第一手信息更正；结论「非该轮改动」不变。）值得记的是**它已经被放宽到 20s 仍在 Windows 上越线**——正好印证上面「继续加超时是错解」的判断：Windows runner 的 React commit 延迟比 loaded macOS 更长，事件驱动锚点是唯一出路。
  **2026-08-12 再犯（本条目最初那条用例、20s 顶仍越线）**：`single-choice digit key picks
the option AND advances`（:908）在 **windows-latest shard 3/3** 撞 **20s 用例级 timeout**
  （run 31591478754 / head `8d109b5f`，该 run 随 supersede 取消、失败已被 4d/93009 双确认）。
  归属排查：该轮链上两笔是纯 backend resources/ACL（RFC-284 批 C）与 claude capture 修复，
  零前端文件。至此这条用例的超时史是 3s→10s（`7a1c119c`）→20s 三级放宽仍复发——「继续加
  超时是错解」的论断第三次被验证。**待用户指派前端 owner 按上文事件驱动锚点方向治本**；
  当前四个活跃 session 均无 clarify 前端归属，不代改。
  **同日 Windows 双红（4d 观测，run 31591931175 / head 39c9626a）**：紧接的一轮里
  `auth-form-tabs.test.tsx`「bootstrap exposes only the setup-tok…」也红——非超时而是断言时
  元素未渲染的 race（拿到 body 而非 input）。两轮、两个文件、两种失败形态、**全部只在
  windows-latest** ⇒ 当日 Windows runner 整体偏慢是共同放大器；处置口径不变（`findBy*`
  事件驱动锚点去 race，不是继续加 timeout），auth-form-tabs 与 centralized-answer-pane
  建议同一位前端 owner 一并处置。
  **对 owner 最有用的一条新事实：这两条在本机满载下可复现，不必等 CI**。2026-08-08 一次 `bun run gate:local`（backend 四分片与 frontend 729 文件并发）里，`centralized-answer-pane` 与 `prose-code-mermaid-theme` **同一次一起红**（`Test Files 2 failed | 727 passed`，backend 侧 4/4 全绿）。此前两条都记作「CI 偶现」，实际只要把机器压满就能在本地重现——修复与验证都不再需要靠 CI 抽样，直接 `gate:local` 循环即可。
  **✅ 2026-08-13 处置落地（用户拍板，本批接 owner）：centralized-answer-pane 与 auth-form-tabs 两文件已修**，根因各自坐实且**互不相同**：
  - centralized-answer-pane——纯测试时序面：数字/Enter 热键是 QuestionForm **passive effect 里 addEventListener 的原生监听**；`waitFor(getByTestId)` 在挂载 commit 的 MutationObserver **微任务**里就 resolve，passive effects 却排在其后的宏任务——紧接的同步 `fireEvent.keyDown` 打在还没挂监听器的节点上，**击键静默丢失**，后续等待无界挂死。三级放宽史（3s→10s→20s）与「10026ms 恰好越预算」签名全部由此解释：旧轮询版等不到 `checked`，MutationObserver 版锚点没错但击键已丢、Promise 永不 resolve → 撞 20s 用例级超时。修法：击键前 `await act(async () => {})` 确定性冲刷 pending passive effects（`hotkeysAttached()` helper，4 个击键用例接入）；组件无产品 bug（真实用户不可能在 effects 冲刷前击键，聚焦本身也来自 effect）。
  - auth-form-tabs——**组件真 bug，flaky 一直在间歇性如实报告**：`auth.tsx` 自动聚焦 effect 旧版只依赖 `[discovery]`；`active` 初值（password）≠ 首选方法（bootstrap 的 token）时，表单要等 `setActive` 的第二次 commit 才挂载，而 effect 的 `queueMicrotask` 抢在那次 commit 之前跑 → ref 为 null、聚焦被静默丢弃且 effect 不再重跑。**生产真实时序（fetch 在自己的宏任务里 resolve，无 act）下必现**；测试里 RTL/act 的同步队列冲刷通常把第二次 commit 排到微任务之前，掩盖了顺序——满载 runner 偶尔踩回真实时序才红。修复：effect 补 `[active]` 依赖 + 等 active 同步到首选方法再聚焦（组件侧）。
  - 验证：两文件 5× 循环 + 全量前端多轮全绿（含一轮 231s 满载——正是历史复现条件）。⚠️ 修后第一轮全量曾另有 **1 红未归属**（当时只留 `tail -6`，输出丢失；复跑两轮含满载轮均未再现）——按「不许重跑就过」在此留痕待复发对照；教训并入 dev-gotchas 截断条：**全量跑测输出必须 tee 落盘**。`prose-code-mermaid-theme`（本条目头名）与 `unsaved-guard` 是不同链路，**仍开放**。
- ⏳ **第十条（**很可能是第六/七/九条与本机满载 flaky 的共同放大器**）：`bun test --isolate` 的 shard 会**忙等空转**，不自行退出，也不被任何超时收割**（2026-08-09 本机实测两例）。现场：`ps` 里两个 `bun test --isolate --randomize --shard=2/4` 进程，`STAT=R`、**99–100% CPU**，分别已跑 **3h37m** 与 **19h07m**；`sample` 抓栈显示主线程停在 `kevent64` 紧循环 + JIT 帧 —— 是**忙等**，不是死锁等 I/O。两例 shard-2 最后创建的 fixture 不同（`aw-rfc107-leaf-` / `aw-mig0106-partial-`），所以不是某一条用例的固定死循环。**危害有两层**：①单次 `gate:local` 永远不返回（本地没有 CI 那种 job timeout 兜底，只能人工发现）；②**没被发现的那个会一直偷走一个核**——19h 那个从 08-08 12:41 起就在跑，而本仓 08-08 12:41 之后的**每一次**本机门禁都在与它抢 CPU。这足以解释同期集中出现的计时敏感 flaky（第六/七条的前端 `waitFor` 越线、`RFC-098 WP-8` 的 5691ms、以及第九条 Windows 分片之外的本机复现），**那些条目里「机器饱和」的归因应当理解为「有一个跑飞的分片在偷核」，而不是负载天然如此**。**第三例（2026-08-09 21:05 现场抓到，两条证据推翻上面的旧假设）**：`--shard=3/4`（**不是** shard 2 —— 「两例都在 shard 2，值得先看该分片文件集有没有共同点」这条线索作废），`STAT=R`、98–99% CPU、`etime` 20 分 27 秒，**连自己的 `shard-3.log` 都没产出**（同批 shard-1 已 441s 正常收工并写出 167KB 日志）。判死方法可复用：私有 `tmp-3/` 里 fixture 数 35 秒内零增长（20 → 20），最后一批 `rfc216-sub-*` / `rfc242-*` 的 mtime 停在 21:05、即卡死前 14 分钟。`sample` 抓栈也与上面旧描述**不同**：不是 `kevent64` 空转，而是**同一帧自我重复**（`bun+0x3198724 → bun+0x3198724` 连续同址），更像 JS 层紧循环被 JIT 后的形态，而非事件循环空转 —— 查因方向应从「事件循环为何不退」改为「哪段逻辑进了不收敛的循环」。**现场处置**：本地无墙钟上限时它不会自愈，只能 `kill -TERM` 整棵进程树（含 detached 的分片 pid，父进程 kill 不掉它）后重跑。

**给 owner 的三件事**：①`gate:local` 给每个分片加**墙钟上限**（CI 侧 job timeout 已有，本地完全没有），超时打印该分片已跑到哪个文件再杀；②查清 bun 在 `--isolate` 下什么条件会让事件循环空转不退（两例都在 shard 2，值得先看该分片的文件集合有没有共同点）；③排查前先 `ps -eo pid,etime,%cpu | grep "bun test"`——历史遗留的跑飞进程会让**任何**计时结论失真。

- ✅ **[结论已更正 2026-08-09] 执行闭包内同名资源——守卫本来就存在，我第一次审计漏了**（2026-08-09 用户提问后实测定位；**不是 RFC-271 引入的**，是「全 ID 索引」的必然配套约束缺失）。DB 层名字是 `(owner, name)` 复合唯一，所以 Alice 的 `lint` 与 Bob 的 `lint` 可以共存；但**运行时注入 opencode/claudeCode config 时是按名字组织的**，同一执行闭包里两个同名资源必然撞车：
  - **技能**：`runtime/stageSkills.ts:68` `const dst = join(skillsDir, skill.name)` —— 按名字建目录。实测两个不同 owner 的同名 skill 注入后**只剩一个目录、一份内容**，另一份静默消失（探针：分别写入 `ALICE VERSION` / `BOB VERSION`，结果目录数=1）。
  - **MCP**：`runtime/claudeCode/inject.ts:33` `if (Object.hasOwn(servers, m.name)) continue // closure dedupe` —— 先到先得，第二个被静默丢弃。
    **两条都无告警、无日志、无校验**：既没有保存期校验（agent 保存时不查其闭包），也没有启动就绪校验。对比之下**导出侧有正确判据**——`package-duplicate-resource-name`（AC-2b），理由写得很清楚：「包不带 owner，两个都叫 lint 的条目导入方无从分辨」。运行时面对的是同一个不可表示性，却什么都不做。
    **可复现场景**：agent A 直接引用 Bob 的 `lint` 技能，同时 `dependsOn` 一个引用了 Alice 的 `lint` 技能的 agent B ⇒ A 的执行闭包含两个 `lint` ⇒ 注入后只剩一个，A 静默拿到错误的技能内容。
    **接线点已定位**（改动面小）：MCP/插件在 `mcpClosure.ts:61 loadMcpsByIds` / `pluginClosure.ts:63 loadPluginsByIds` 装载完成处；技能在 runner 组装 `ctx.skills` 处（`runtime/opencode/driver.ts:169` 与 `runtime/claudeCode/config.ts:38` 调 `stageSkills` 之前）。**失败语义需产品决策**：① 启动就绪期拒绝启动（最贴近既有 launch-readiness 语义，错误在启动时明确暴露）；② agent 保存期拒绝（更早，但闭包会随被依赖 agent 的修改而变化，保存期通过不代表启动期仍成立）；③ 注入期报错而非静默去重（最贴近事故现场，但那时任务已在跑）。**未擅自实现**——它触及 runner/scheduler 热路径。 **⚠️ 上面这段结论是错的，保留原文是为了记录审计方法的失误。**实际情况：`services/runtime/injectionIdentity.ts` 的 `findManagedInjectionNameConflict` 早就存在，覆盖 agent / managed-skill / mcp 三类（MCP 还额外过滤 `enabled`），接在 `scheduler.ts` 的 `prepareNodeRunInjection` —— 即**完整闭包 hydration 之后、spawn 之前**的公共边界，错误码 `duplicate-name-in-closure`，测试在 `rfc223-pr6-injection-identity.test.ts`。**我为什么漏了**：按「闭包组装点」去找（grep 了 stageSkills / mcpClosure / pluginClosure / launchReadiness），而守卫在更上层的注入准备处；关键词也没覆盖 `findManagedInjectionNameConflict` 这个函数名。**教训**：审计「有没有某类校验」时，只 grep 关键词 + 只看叶子调用点会漏掉上层的公共边界——应当先找**该行为最终必经的那道关**（这里是 spawn 前的注入准备），再看它有没有守。另：我据此错误结论写的 `closureNameConflict.ts` 已删除（重复造轮子，且它错误地把 plugin 也纳入同名拒绝——plugin 按 id 去重，同名不同 id 都应保留）。

- ✅ **[已闭环 2026-08-09] RFC-271 批次 G 引入的前端 UI 回归**（UX session 于 `ebad9fca` 修复，CI 在 `52b1400e` 转绿；诊断保留供同类问题参考）（2026-08-09 定位，`a3cc99ca` run 31297879784）。**此前一直被掩盖**：`focus-ring-clip.spec.ts` 在「找不到 `Import YAML` 按钮」上提前失败，于是那个对话框与相关页面**从未真正被扫到**；把按钮选择器修好之后，18 个裁剪一次性暴露。诊断已精确到元素与像素：
  - **`/workgroups/{id}` — 5 处**：我加的 `Export config package` 按钮落在 `.page__meta` / `.page__heading` 里，focus ring 四边 `only 0px of room`（`ring paints 4px out`）。**容器缺 `var(--focus-ring-gutter)` 的 padding**。
  - **`/workflows/{id}(editor)` 与 `(editor+inspector)` — 各 2 处**：编辑器 header 加了按钮后 `Launch task` 被挤到右边缘，`ring paints 4px out, only 0.8px of room`。同一根因还让 `rfc250-workflow-camera.spec.ts` 报 `workflow header actions still overflow at 1280px: workflow-more-actions`（header=996, heading=307.2, min=220）。
  - **`/workflows(import-dialog)` — 9 处**：`.dialog__panel` 的 `[focus-within]` 环 `paints 40–60px out, only 24px of room`。`ux-consistency.spec.ts` 的 `1280 light` 用例也卡在这个对话框（`expectWithinViewport(importDialog)` click 超时）。
    规则本身没有豁免通道（测试输出原话：_Fix the container (give it >= var(--focus-ring-gutter) of padding) or make the control's ring inset (var(--focus-ring-offset-inset)). There is NO waiver channel_）。**处置取决于并发前端重构**：那个 session 正把导入入口从列表页 header 移进创建流程、并重写 `ResourcePackageImportDialog`，三处里至少两处会被那次重构直接覆盖；`/workgroups/{id}` 的导出按钮容器 padding 则可能不在重构范围内，需要单独确认。**在那次重构合入前，main 的 e2e 腿会持续红**。

- ✅ **[已闭环 2026-08-09] RFC-271 批次 G 的视觉基线**（`71c23b2d` 接受 + `52b1400e` 收尾，`visual-regression-nightly` 已 success；流程记录保留：新增场景时首次 hosted run 故意红并产出实拍 PNG，人工审核后提交 Linux 基线）（2026-08-09 定位）。**不是缺陷，是流程没走完**：该 workflow 的文件头写明了正式姿势——「An authorized main publication that adds or changes scenes intentionally lets its first hosted run fail and upload the runner's actual PNGs. Review those PNGs, commit only the accepted Linux baselines, then require the new exact-SHA run to pass」（详见 `e2e/visual-regression.README.md`）。即**新增场景时首次 hosted run 故意红并产出实际 PNG，人工审核后只提交被接受的 Linux 基线**。归属链清楚：`8e38f81e`（T35 导出按钮公共组件）绿 → `ea27d81f`（T37 六类列表页接入导入入口）起红，此后 `d9e786f7` / `0cf30f87` / `9d7cb91b` 一路红。**处置建议：先不要更新基线**——前端正由并发 session 重构（把导入入口从列表页 header 移进创建流程，见 `ResourcePackageImportDialog` + `alternativeAction`），现在更新基线，重构落地后还要再更新一次。等那次前端重构合入后，一次性下载 run 产出的 PNG、人工审核、提交基线，再按 exact SHA 要求该 workflow 转绿。**注意它不是硬门禁**（push 触发是 path-filtered，且「首次故意红」是设计的一部分），所以不阻塞主 CI，但**不能因此当噪音长期挂着**——它挂着的每一天，真正的视觉回归都无法被发现。

- ⏳ **第十一条（**修正第十条的归因**）：`RFC-098 WP-8 — runner escalation against a stubborn child > timeout: ...; child AND grandchild group-killed` 在**没有任何跑飞进程**的情况下仍会在 4 分片并发下红**（2026-08-09，RFC-271 实现门修复轮的 `bun run test:backend`，shard 2/4 单点红，5516ms；其余三分片全绿）。失败断言是文件末尾的 `expect(await waitDead(grandchildPid)).toBe(true)` —— 等孙进程随进程组一起死。**为什么值得单独登记**：第十条把同期这条的越时归因于「有一个 19 小时的跑飞分片在偷核」，而本次复现前那两个跑飞进程**已被杀掉并确认 `ps` 计数为 0**，机器上只有本次门禁自身的 4 个分片（load avg 9.76）。所以正确结论是：**跑飞进程是放大器，不是必要条件**——这条用例在正常的 4-shard 并发下就会越线，第十条那句「那些条目里『机器饱和』的归因应当理解为『有一个跑飞的分片在偷核』」需要按本条收窄。**归属明确不是本轮改动**：RFC-271 实现门修复轮的 diff 是 `services/resourcePackage/*` / `services/bundle/*` / `cli/package.ts` / `cli/start.ts` / 三份文档 + 两个新测试文件，与进程治理/runner 升级链路零交集；该测试文件不 import `cli/start.ts`（本轮唯一碰到的 daemon 侧文件）；**同一份代码的非分片全量跑 9631 pass / 0 fail**，隔离复跑 3/3 全绿。**留给 owner**：`waitDead` 的等待预算与 `waitForFile(h.pidFile)` 一样是「猜一个够大的数」，与第六/七条同形——继续加超时只是把数字往后推；孙进程死亡有可观测锚点（进程组消失），值得换成事件驱动而非轮询到超时。

- ⏳ **第九条：Windows 前端分片的 runner 饥饿（20s testTimeout 集体撞线）**（2026-08-09，run 含 push `d53aebf6`，**windows-latest shard 2/3** 三条同时超时：`AgentForm-outputs-kind` 32.3s、`workflow-edge-insertion` 28.1s、`review-decision-info` 22.0s，预算均为 20s）。**归属证据是决定性的**：`workflow-edge-insertion.test.ts` 是**纯函数** planner 测试——不挂 DOM、不渲染 React、不发请求；一个纯函数跑不完 20 秒，只可能是 runner 被饿死，不可能是逻辑变慢。而当轮 diff **纯后端**（`services/mcp.ts` 的一个可选字段 + `intent/applyChangeset.ts` 一行 + 一个 backend 测试），与前端零交集；同 run 的 ubuntu / macOS 前端分片全部 success。**与已登记的第六/七条不是一回事**：那两条是「轮询式 `waitFor` 等一个跨 turn 的 React commit」，这一条连等待面都没有，是整机吞吐问题。**留给 CI owner 的方向**：Windows 前端分片要么降低并发（vitest `poolOptions.threads.maxThreads`）、要么给 win32 单独抬高 `testTimeout`——但后者又是「猜一个够大的数」，与第六条的教训冲突；更稳的做法是先测出该分片的实际并发与 CPU 配额是否失配（三条同时撞线、且其中一条不含任何异步等待，指向的是调度而不是单条用例）。

- ✅ **已修（2026-08-09）：`rfc224-fff-capability` 的「探针 pid 读取撕裂」——一条会伪装成容器逃逸失败的测试 bug**（CI run 31270648529，push `46dff44e`，macos-latest shard 1/4 单点红，报文是 `process 0 remained live`）。**机制完整**：后代进程把自己的 pid 写进 marker 文件是「先 create 再 write」两步；测试的等待循环只等到 `readFile` **不抛**就 break，落在两步之间的一次读取拿到空串，而 `Number('')` 是 **0**。0 随后一路蒙混过关——`Number.isSafeInteger(0)` 为真，`process.kill(0, 0)` 也必然成功（POSIX 里 `kill(0, sig)` 打的是**调用者自己的进程组**，不是「pid 为 0 的进程」），于是「拿到 pid」与「进程还活着」两个前置断言都绿；直到 `expectProcessAbsent(0)` 因为永远等不到 ESRCH 而耗满 1s 预算，抛出一句与真实原因毫无关系的 `process 0 remained live`——读者会以为是 FFF 容器没杀掉后代（一条安全断言！），实际是探针从没报回 pid。**两处都修了**：①等待循环改成「解析成功且为正整数」才算就绪，否则继续等（此前 `754eafde` 那轮只解决了「文件还没创建」，没覆盖「文件在但内容没写完」）；②`expectProcessAbsent` 对非正数 pid **当场失败**并说明真实原因，不再进轮询。断言强度不变：真的没杀掉仍然红。归属与触发它的那次 push 无关（该轮 diff 只有 `pluginInstaller.ts` 一个可选参数 + 一个纯函数 + 一个新测试文件），但既然撞红就就地修掉而不是登记了事。**通用教训已同类**：与第八条 `rfc108-resume-safety` 同一形态——**测试把真实信号吞掉、只留下一个误导的断言差**；两条都是先修「让失败自证」，再谈别的。

- ⏳ **第八条 CI 单点红（`rfc108-resume-safety.test.ts > resume on a gc-reclaimed worktree → clean 410`），机制未定，已先修掉「测试自己吞证据」这一层**（2026-08-09，run 31267111194，push `9da5cc63`，**macos-latest shard 2/4 唯一失败**，另 7 个 backend job 全 success）。断言 `expect(code).toBe('task-worktree-missing')` 收到 `undefined`。**归属分析**：本轮 diff 是 `task.ts` 的 `startTask` 内部顺序（冻结移到校验之前）、`workflow.validator.ts` 新增冻结闭包投影、外加一个新测试文件；`resumeTask` → `resumeKick` → `assertWorktreePresentForResume` 这条路径**一行未改**，且新增的 import 未引入模块环（`workflow.validator → execution/closure` 已在既有图里）。**复现尝试全部失败**：本机单跑 5/5 绿、`--isolate --randomize` 10/10 绿、8 路并发 ×3 轮共 24/24 绿，`gate:local` 三次全绿（backend 四分片 randomize）。近 12 次 main 的 CI 里无同一签名。**本轮实际做的事**：把该用例改成**能自证**的形态——原来只取 `err.code`，于是「压根没抛」与「抛了个不带 code 的错」（普通 Error / TypeError）在失败输出里完全同形，CI 只留下 `Received: undefined`，任何人接手都推不下去；现在同时断言前置条件（`existsSync(worktreePath) === false`）、是否抛出、以及把**原始异常的 name/message/code** 塞进断言消息。下次再红即可一眼分流：①前置条件先红 ⇒ 是 `rmSync` 没删掉/目录被重建（环境/后台 git 进程），②`threw=false` ⇒ 产品真的漏了 410 前检，③`threw=true` 但 code 不对 ⇒ 另一条错误路径抢先。**留给 RFC-108 owner**：在拿到下一次失败日志前不要改产品代码——当前证据不足以断定是产品缺陷，也不足以断定是环境。

- ⏳ **第七条同源 flaky：`auth-form-tabs.test.tsx > bootstrap exposes only the setup-token form without a method switcher`**（2026-08-08 本机满载 `gate:local` 复现一次，backend 四分片与 frontend 729 文件并发；`Test Files 1 failed | 728 passed`，backend 4/4 全绿）。失败断言是文件末尾那句 `await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(enUS.auth.token)))` —— 等的是 bootstrap 表单挂载后的 **autofocus effect**。**归属明确不是触发它的那次改动**：该轮 diff 只有 backend 的 `execution/closure.ts` + `scheduler.ts` + 三个 backend 测试（RFC-271 T6e），`git diff --name-only HEAD | grep frontend` 为空；单跑该文件连续 3 次 9/9 全绿。**与 unsaved-guard / centralized-answer-pane / prose-code-mermaid-theme 完全同形态**：轮询式 `waitFor` 等一个跨 turn 的 React commit（这条是 render → effect → `ref.focus()` 三段链），满载 runner 上越线。**这条比前三条更容易修**，因为焦点有现成的事件驱动锚点。**2026-08-09 已修**（CI run 31313445875 ubuntu shard 1/3 又红一次，5081ms 超时，同 run 的 macOS / windows 三条腿全绿）——但**上一版建议的写法照抄会直接红**，两条更正留给处置另外三条的人：

- ⚠️ **`toHaveFocus()` 在本仓不可用**：前端没装 jest-dom，写了会 `Invalid Chai property: toHaveFocus`。
- ⚠️ **「先 `findBy` 拿到元素」本身并不消除竞态**：元素在更上面的 `findByTestId` 时就已存在，`findBy` 会立刻 resolve，真正要等的是 `ref.focus()` 那一步。

实际生效的改法是**把查询提到轮询之外**：原写法每轮询一次就 `getByLabelText` 重扫一遍整棵树（该页面 DOM 很大——两段 SVG 插画 + 完整表单），满载 runner 上光这个重复扫描就能吃掉 5s 预算；改成只让轮询体读一个已拿到的引用。本机连跑 3 次 9/9 全绿。**这条经验对另外三条同样适用**：先看轮询体里有没有藏着一次全树查询，那往往比「跨 turn 的 React commit」更能解释预算耗尽。

**⚠️ 2026-08-10 复发一次，说明「提查询出轮询」只是压低了概率而没有消除竞态**：本机满载
`gate:local`（backend 四分片与 frontend 736 文件并发），失败逐字仍是
`expected <body>…</body> to be <input class="form-input" …>`，实测 5072ms；**同一棵树**
在几分钟前的另一次 gate 里 frontend 736 文件全绿（两次只差 vitest seed），隔离下连跑
3 次 9/9 全绿、单次仅 1.8s。归属明确不是触发它的那次改动：本轮 diff 只有 backend 的
`codeHost/connections.ts`、`scheduler.ts`、`envelope.ts`、`pluginInstaller.ts`、
`routes/plugins.ts` 与三个新 backend 测试 + 三份 md，**零前端源码与零前端测试改动**。
结论：这条仍是**未修完**的时序敏感面，等的还是 `ref.focus()` 那一步跨 turn 的 commit；
真正的正解是给它一个事件驱动锚点（等一次 focus 事件），而不是继续依赖轮询预算。

- ⏳ **第十一条 flaky：`rfc131-review-reject-aging-prior-output.test.ts > RFC-131 验收#4 组合`**（2026-08-09 干净 worktree 门禁复现一次）。与前面几条**不同形态**，值得单列：它不是前端 `waitFor` 轮询越线，而是 **bun:test 的每用例 5000ms 硬上限**被撞穿——日志逐字为 `this test timed out after 5000ms`，实测 6252.89ms。**归属明确不是触发它的那次改动**：该轮 diff 只有一个前端测试 + 两份 md + 两个 RFC-271 后端测试文件，与 clarify / review / 老化链路零耦合；同 run 另外三个 backend 分片全绿，隔离下单跑该文件连续 3 次 3/3 全绿。**现场负载**：并发 session 同时在跑自己的门禁，两套四分片抢核。**紧邻线索**：同 shard 日志在该用例前一行打了 `killed 1 dangling process`，与第五条（RFC-224 取消预言机超时后 shard 挂死）出现过的字样相同，值得一并查是不是同一个回收路径。**同族第二例（2026-08-09 同日，干净 worktree 门禁）**：`scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts > S-2 multi-repo in-process retry rollback`，同样逐字 `this test timed out after 5000ms`，实测 5609.40ms；隔离下连跑 3 次 2/2 全绿；同 run 另外三个 backend 分片全绿；本轮 diff 只有 resourcePackage / routes / fusion / 两个前端详情页，与多仓 worktree 回滚链路零耦合。两例合看，**共同点不是某条用例，而是「一条串了多段异步真实 IO（git worktree / 子进程 / DB 事务）的用例 + 满载 runner」**——本机当时有两套四分片门禁在抢核。**同族第三例（2026-08-10，干净 worktree 门禁）**：`rfc098-process-governance.test.ts > RFC-098 WP-8 — runner escalation against a stubborn child`，逐字 `this test timed out after 5000ms`，实测 5515.22ms；隔离下连跑 3 次 5/5 全绿；同 run 另外三分片全绿；本轮 diff 只有 RFC-271 的导出/预检与两个前端文件，与进程治理链路零耦合。**`rfc098 WP-8` 已复现两次且耗时稳定**（5515.22ms / 5528.45ms，相差 13ms）——这条不是随机噪声，而是**稳定地略微超预算**：它要跑完「超时 + grace + margin」三段真实等待，本身的下界就贴着 5000ms，满载时必然越线。对处置很有用：这类用例该做的不是「加超时」而是**把预算算清楚**（三段等待的标称值加起来是多少、留多少余量），或者把 kill 时序做成可注入的假时钟。**三例已经足以定型**：`rfc131-review-reject-aging`（多段 clarify/review 异步链）、`scheduler-audit-s02`（多仓 git worktree 回滚）、`rfc098 WP-8`（子进程 + 孙进程组杀），共同点是**一条用例串了多段真实异步 IO**（子进程 / git / 文件系统 / DB 事务），在满载 runner 上撞穿 bun:test 的每用例 5000ms 硬上限。它们与前面几条前端 `waitFor` 越线是**不同机理、同一后果**，处置时可以合并考虑但修法不同：前端那批要换事件驱动锚点，这批要么把多段链拆成各自可断言的单元、要么给这类用例一个显式的更高预算（并写明为什么这条需要）。**修法方向与前几条一致**：不要再把 5000ms 往上调——该用例串了 deferred self-clarify → review REJECT → 重做三段异步链，正解是给它一个确定性的完成信号（等 review 状态落库的事件，而不是等墙钟），或把三段拆成各自可断言的单元。**同族第三例（2026-08-09 同日，本机 `gate:local` 满载）**：`scheduler-audit-gap4-loop-exit-out-of-scope-port.test.ts > gap4 — wrapper-loop exitCondition referencing an out-of-loop node > an old invalid snapshot keeps the latest outer value instead of false-exiting`，同样逐字 `this test timed out after 5000ms`，实测 6189.89ms；隔离下单跑该文件 2 pass / 0 fail / 2.44s（**比预算快一倍有余**，可见不是逻辑变慢而是被抢核）；紧邻线索同样命中——同 shard 日志在该用例前打了 `killed 1 dangling process`。**归属明确不是触发它的那次改动**：该轮我的 diff 只有 `design/plan.md`（纯文档）+ 新增一个 e2e spec，**零后端源码与零后端测试改动**，而本用例走 wrapper-loop 退出条件 + 跨 scope 端口快照，两者零耦合。三例合看进一步收窄了共同点：**都是 wrapper / worktree / 子进程这类串了多段真实异步 IO 的调度器用例**，且三例全部紧邻 `killed 1 dangling process`——与第十条（`bun test --isolate` 分片忙等空转不自行退出）大概率是同一个进程回收路径在放大。**同族第四批（2026-08-12，`gate:local` 满载：本机同时在跑多路审计/设计门子代理）**：同 shard 三条齐超——`scheduler-rfc040-wrapper-await.test.ts`（wrapper-git resume 5571.60ms + wrapper-loop resume 5738.63ms）与 `rfc193-port-artifacts.test.ts`（archive-at-emit case 3b 5522.01ms），均逐字 `timed out after 5000ms`、紧邻 `killed 1 dangling process`；隔离复跑 5/5（8.41s）与 22/22（6.77s）全绿；该轮 diff 仅文档+注释（2026-08-12 审计包①），零后端行为改动。形态与前三批完全一致，不另立条目。

- ⏳ **第五条 CI 缺陷，性质与上面四条不同：它不是「一条红」，而是会吞掉整个 shard 的挂死，且伪装成「并发 push 取消」**（2026-08-08，run 31236841932 attempt 1，push `f734a897`，ubuntu shard 2/4）。测试：`RFC-224 Linux cancellation oracle protocol > rejects a target that self-exits after ARMED but before the TERM freeze lease`（`packages/backend/tests/integration-opencode/opencode-identity-preflight.integration.test.ts`）。**症状两段**：①03:19:05 该用例 `30002.05ms` 撞满自己的 30s 上限判失败，同时日志打出 `killed 1 dangling process`；②**此后整个 shard 静默 12 分 56 秒**（03:19:05 → 03:32:01）直到 job 的 `timeout-minutes: 15` 触发，`##[error]The operation was canceled.` + `Terminate orphan process: pid (2370) (bun)`。**危害不在那条红，在第二段**：该 shard 只启动到第 90 个文件就再没往下走，其余文件**一次都没执行**，而 job 的 conclusion 是 `cancelled` 不是 `failure` —— 于是整个 run 的 conclusion 也是 `cancelled`，正好落进 `CLAUDE.md` 里「共享 main 上并发 push 会取消你的 run」那条已知情形，**极易被下一个人当成噪音略过**。判别方法要写死：`cancelled` 先查 `git log <yoursha>..origin/main` 是否真有 superseding commit，为空就说明不是并发取消，必须翻 job 日志。**归属**：与本轮改动零耦合 —— 本轮 diff 只有 `services/intent/{intentDoc,turnEngine,applyChangeset}.ts` + 三个 `rfc234-*` 测试 + `STATE.md`，不触及 opencode 执行身份链路的任何模块；同 run 另外 7 个 backend shard（含跑了本轮全部三个测试文件的 ubuntu/macOS shard 1 与 shard 4）全部 success，shard 2 里唯一的 intent 相关文件 `rfc235-intent-turn-session.test.ts` 在卡死点之前跑完且全 pass。**历史**：`b2f7144a fix(ci): 修依赖漏洞门禁 + 放宽取消预言机的单阶段预算` 已经为这条用例放宽过一次预算，所以这次是「放宽之后仍然超时」，与上面 centralized-answer-pane 那条是同一种「继续加超时只是把数字往后推」的形态。**留给 RFC-224/227 owner 的两件事**：①那条用例本身为什么会在 runner 上越过 30s（它等的是一个 self-exit 与 TERM freeze lease 的竞争窗口，本就是时序敏感面）；②**更要紧的**是超时之后为什么 bun 进程没被回收 —— 一条用例失败不该让同 shard 剩余文件全部不执行，这条挂死才是把单点 flaky 放大成整 run 不可用的原因。
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
  - **RFC-254 T31 win32 特征化（task#12，已真机确证，低危安全加固待 fresh-context）**：`openContainedFile`（`worktreeFileContent.ts:94`）用 `constants.O_RDONLY | constants.O_NOFOLLOW` 防 realpath-后-open 之间的 symlink 换链 TOCTOU；**真机实测 `constants.O_NOFOLLOW === undefined`（win32），`X | undefined = X`，故 O_NOFOLLOW 在 Windows 是 no-op**——line 96-99 的 ELOOP 兜底在 win32 永不触发，那个换链窗口在 Windows 无防护。**但 realpath containment（line 86）仍拦住所有静态越界**：真机 probe `..\outside.txt`/`..\..\..\Windows\win.ini`/`sub\..\..\outside.txt` 全 `outside`、静态 symlink 越界经 realpath 也拦（合法 `sub/ok.txt` 正常读）。故残留仅「realpath 后换 symlink」的窄 TOCTOU 窗口，且 Windows 建 symlink 需 `SeCreateSymbolicLinkPrivilege`（默认无，需管理员/开发者模式）+ 赢竞态 + worktree 写权 ⇒ **低危**。**修法**（sanctioned）：`resolved` open 前 `lstat`（须非 symlink 的 regular file）、open 后 `fstat`，用 `fileTrust.assertSameFileIdentityForHost`（dev/ino，RFC-254 T40a 已令 win32 权威）比对身份，不符即拒——把 O_NOFOLLOW 的职责用句柄身份复核补上（POSIX 亦更稳）。**附带**：line 72 `..` 预筛 `split('/')` 在 win32 漏反斜杠 `..`（line 86 已兜住，纯纵深）宜改 `split(/[/\\]/)`。**为何不本 session 改**：安全核心函数，session 末尾疲劳下不仓促改（同 netlessProjection 纪律）；低危、有 realpath 主闸兜底，值得 fresh-context 带 TOCTOU seam 测试稳妥落。
- **依赖漏洞门禁「无数据放行」**（RFC-230 期间发现并修）：`scripts/audit-gate.ts` 取不到可解析的 audit 报告时（registry 返回空 / 请求失败 / bun 解压失败且救不回来），**重试 3 次后放行并打 `::warning::`**。bun 不给结构化信号，无法区分「真的没有公告」与「请求没成功」，若改成 fail-closed，一次 registry 抖动就会卡住所有合并。代价：那一次构建等于没扫。**正解**是换一个能明确区分二者的数据源（GitHub Dependabot alerts API / osv-scanner），届时改成 fail-closed。
- ⏳ **`centralized-answer-pane` 的键盘导航用例在 hosted macOS runner 上间歇性红（2026-08-04 观测）**：
  CI run 30879493805 的 `Frontend tests (macos-latest shard 3/3)` 挂在
  「ONE-question dialog: digit pick enables submit but focus does NOT flush to it」，形态是
  `waitFor` 超时（`checkRealTimersCallback`），本地 26/26 在 2 秒内全绿。当次 push 的改动
  （沙箱审计批）**零文件**触及 clarify / centralized 链路，该测试文件最后一次改动来自
  RFC-250 `5a1f6993`。按 `CLAUDE.md`「flaky 不能掩盖红 case」登记而非当噪音略过——需要它的
  owner 判定是真的焦点时序缺陷还是 runner 抖动；若属后者，应把断言从 `waitFor` 布尔改成
  等待具体可观测状态（`findByRole` / disabled 属性），而不是加超时。
- **CI 提速**：macOS `check`(870s) 是瓶颈且 gate 一切；backend 738 文件串行（`--parallel` 死锁全套，daemon flock）；安全赢 = 跨 runner 分片 + lint/typecheck 移出 macOS。
- **前端 i18n**：~134 硬编码串已抽 bundle；deferred = 4 RFC-087 结构项 + 4 基建缺口。
- **node_run id 单调性是全仓 freshest-run 前提（RFC-245 设计门 2026-08-01 发现）**：`services/freshness.ts:155-161` 的 `isFresherNodeRun` 是纯 ULID id 比较（RFC-074 PR-C 明定，`isfresher-noderun-baseline.test.ts` 锁等价性），调度器 `latestPerNode`、上游输入选取、`deriveReviewNodeNav` / `deriveClarifyNodeNav` 全部依赖它。但仓内用的是普通 `ulid()`——同毫秒内随机后缀不保证递增，时钟回拨 / daemon 重启也会破坏顺序，理论上可让「更旧的行」比出更大 id。上库前审计另确认任务画布通用状态投影仍按 `startedAt`；RFC-245 只把两个 call kind 改为与导航共用 id freshness（否则新 placeholder 的 `startedAt=null` 会让颜色停在旧代），其余 kind 的状态/抽屉投影也应纳入系统级收口。正解是持久严格递增的 node-run generation/sequence，scheduler 与所有前端消费方共用，不是逐处打补丁。
- ✅ **已修（RFC-243 D12，2026-08-12 对账销账）：retryNode cascade 不取消下游 call 行的存活子任务**——现行 `services/task.ts:3531-3541` 把 `affectedChildTaskIds` 定义为 target+全部 downstream 节点行的 `childTaskId`（注释明言 deliberately wider），`:3583-3622` CAS 胜出后逐个 `cancelTask(…, { cascadeFromParent: true })`、取消失败以 `retry-child-cancel-failed` 关回 failed 并中止 retry，即当年登记的正解。测试见 `tests/retry-cascade-kind-matrix.test.ts` / `tests/rfc243-call-workflow.test.ts`。（原登记行号 2982-3093 已漂移至 `resumeKick` 内部。）
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
- ⏳ **RFC-280 射程外的子进程缺少统一生命周期治理**（2026-08-11 RFC-282 调研发现；
  与上一条「daemon 侧无沙箱执行面」**是同一批代码的不同关注点** —— 那条看的是安全身份，
  这条看的是**进程回收**）。RFC-280 把五条 **agent** spawn 链路全部收敛到
  `services/execution/managedProcess.ts:245`（全仓唯一 agent `Bun.spawn`，带 TERM→KILL
  升级 / group kill / reap deadline / bounded drain），但**工具类子进程不在其射程内**，
  各自手抄了一份骨架，且几乎每份都比 managedProcess 弱：
  - `services/mcpProbe.ts:516` —— local MCP stdio server 由 `@modelcontextprotocol/sdk`
    的 `StdioClientTransport` 内部 `node:child_process` 拉起，daemon 侧只有
    `transport.close()` 与一个 handshake timeout race：**无 TERM→KILL 升级、无 group
    kill、无 reap deadline** ⇒ 一个 fork 出孙进程的 MCP server 在探测超时后没有任何
    兜底回收。这是本批里最值得先处理的一条（探测由用户在设置页反复触发）。
  - `services/structuralDiff/deep/runner.ts:36-54` —— SCIP indexer 真执行：自建
    `SpawnFn` + `setTimeout` + `proc.kill()`，**非 detached、只杀直接子进程**，而
    indexer 是长跑的重型构建工具，孙进程必漏。与 managedProcess 语义差距最大的一处。
  - ✅ ~~`services/pluginInstaller.ts:791-797` —— npm 安装：`node:child_process.spawn` +
    手写 chunk 累积 + `setTimeout` → `child.kill('SIGKILL')`，非 detached、无 group kill。~~
    **已收编**（RFC-284 T16）：`pluginInstaller.ts:780` 的 `runCommand` 现在直接调
    `runManagedProcess`，全仓已无手写 `node:child_process.spawn` 的 npm 安装路径。
  - ✅ ~~`services/scriptRun.ts:270-287` —— 解释器 `--version` 探针：自建 deadline +
    `proc.kill(9)`，非 detached。~~ **已收编**：`scriptRun.ts:276` 改调
    `spawnVersionProbe`（`util/process.ts:435`）。
  - ✅ ~~**三份几乎逐字相同的 `--version` 探针骨架**：`util/opencode.ts:77`、
    `services/runtime/claudeCode/probe.ts:53`、`util/opencode-models.ts:137`。~~
    **已合并**（RFC-284 T8）为单一 `util/process.ts:435 spawnVersionProbe`，
    三处调用点分别在 `services/runtime/opencode/util.ts:70`、
    `services/runtime/claudeCode/probe.ts:58`、`services/scriptRun.ts:276`。
  - **git 两处**：`util/git.ts:180-186` 与 `services/gitRepoCache.ts:126-133` 两份独立的
    timer→`process.kill(-pid,'SIGKILL')`，`gitRepoCache.ts:95-96` 的注释自己声明「这两处
    不得漂移」—— 靠注释维持而非靠代码。
    **不是 RFC-282 的目标**（该 RFC proposal §3 已显式列为非目标并指向本条）：它们不是
    agent 链路，收编需要各自评估语义（探针要的是「快速失败」而非「完整取证」，与 agent
    域不同）。建议的切法：先只把 `mcpProbe` 与 SCIP indexer 这两条**会产生孙进程**的收编
    到 `runManagedProcess`，三份 `--version` 探针合并为一个共享 helper，git 两处维持现状
    但把「不得漂移」从注释升级为源码锁。

  > ⚠️ **2026-08-24 对账（RFC-317 T66 / findings EK-09）**：本族此前**两个方向都过期**。
  > 上面三条打 ✅ 的是「已修但仍列为待办」——一份待办清单里挂着已经完成的条目，会让
  > 下一个人重复做一遍、或者反过来认为整族都还没动。反方向是**新长出来的没进清单**：
  > `modules/development-automation/infrastructure/verificationRunner.ts:143` 与
  > `modules/integration/infrastructure/developmentAdapterRunner.ts:360` 都是审计之后
  > 才出现的工具类 spawn。**这两条今天已经不弱了**（各自 `detached: true` +
  > `killProcessTree` TERM→宽限→KILL，见 verificationRunner.ts:157-165 /
  > developmentAdapterRunner.ts:370-387），所以不必补进待办——但它们说明一件事：
  > **这份清单没有任何机制会在新 spawn 点出现时提醒你**，它只在有人手工普查时才更新。
  > 尚未收编、仍值得处理的是原文列的头两条（`mcpProbe` 与 SCIP indexer 的孙进程回收）
  > 加上 `modules/development-automation/infrastructure/gitBaselineReader.ts:95`
  > （二进制字节直连，已在 rfc284 spawn allowlist 内）。
  > 结构性的解法是原文最后一句提到的「源码锁」——把 spawn 点清单变成棘轮，
  > 而不是靠下一次审计再来对一次账。
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

## 凭据 at-rest 收口（2026-08-04）

RFC-255（已撤销）曾把自定义 provider 的 apiKey 做成 secretBox 密封；该面随实现一并移除，
但它顺带留下的 `config.json` 0600 收紧保留了下来。**剩下的明文面**：

- ⏳ **(P2) `mcps.config.headers` 迁移 secretBox**：remote MCP 的 `Authorization` 仍明文入库。
  （2026-08-12 对账：**出 argv 半边已由 RFC-280 §7.1 关闭**——claude 三条路径改写 0600 文件传路径，
  见上文 RFC-242 残留项 ✅；本条只剩 at-rest 半边。）迁移需带存量行的读时兼容（明文 ⇒ 密封的一次性 backfill）。

## verified 存储的 TOCTOU 身份栅栏无行为覆盖（RFC-254 T0a/T0b 实测，2026-08-04）

> ⚠️ **2026-08-12 对账注记：verified 存储体系已随 RFC-276 删除**（`util/fileTrust.ts` 消费方 storeHygiene/sourceGuard 均不复存在），本节登记的缺口已失去载体，仅存历史价值。

把散在各处的 `dev`/`ino` 相等判断收拢进 `util/fileTrust.ts` 时，对**每一处**做了变异实证
（把身份检查改成恒真），结果 **`storeHygiene` 与 `sourceGuard` 都没有任何测试变红**。
也就是说：这些「打开后必须还是同一个对象」的栅栏，此前既没有逻辑覆盖也没有接线覆盖，
它们在代码里看着承重，实际是活是死无人知晓。

**已经补上的那半**：

- 判定逻辑本身现由 `rfc254-file-trust.test.ts` 覆盖（18 例，含 win32 fail-closed 与
  bigint stat 两种表示）；
- 「调用方确实接了原语」由 `rfc254-platform-surface-guard.test.ts` 的
  `posix-file-identity` 规则锁住（把私有比较写回去 ⇒ 守卫变红，已变异实证）。

- ⏳ **(P2) 仍缺行为覆盖：栅栏是否真的拒绝被掉包的文件**。需要在 `lstat` 与 `open` 之间
  真实替换目标（rename 一个不同 inode 的同名文件），断言各调用方返回
  `execution-identity-source-changed` / `store-unsafe`。当前实现直接用 `node:fs`，
  没有可注入的 seam，故要么加注入点、要么用真实临时目录做时序编排。
  **注意**：这是**既有**缺口而非 RFC-254 引入——迁移只是把它照了出来。

## Windows ARM64 无 Job Object（RFC-254 真机实测，2026-08-04）

Windows **ARM64** 的 Bun 发行构建禁用了 TinyCC，`bun:ffi dlopen()` 直接抛
`not available in this build`（Windows 11 build 26200 + Bun 1.3.14 实测，
见 `design/RFC-254-windows-native-execution/acceptance-real-machine-2026-08-04.md`）。

后果：该平台上 `util/windowsJobObject.ts` 整体不可用 ⇒ 杀树回退 `taskkill /T /F`
（枚举式，有竞态窗口），而按 RFC-254 设计门 P0-D，taskkill-only 的清理**不得**
被当作 runtime store 可回收的证据 —— `isProcessTreeAlive` 因此返回 `null`
（「无法判定」）而非 `false`，调用方必须把「判不了」当成「不安全」。

- ⏳ **(P2) 若要把发行目标扩到 windows-arm64，必须先解决这一条**。当前发行目标是
  x64（D6），而 x64 的 Bun 构建带 dlopen，所以发行产物保有强保证。可选路径：
  等上游为 ARM64 启用 TinyCC、或改用不依赖 FFI 的机制（例如把 Job Object 的
  创建挪进一个随产物分发的小型原生 helper —— 但那与「单一自包含可执行文件」
  的分发形态冲突，需要产品决策）。

## Windows 平台的四条未决项（RFC-254 T36 登记，2026-08-04）

RFC-254 交付的是「Windows 上跑得起来且如实呈现」，下面四条是它**明确没做**的，
逐条写清代价与触发条件，避免被后来人当成已解决。

- ⏳ **(P1) 没有 containment provider**。Linux 有 bwrap、macOS 有 Seatbelt，Windows
  一个都没有：`enforce` 档直接拒绝启动、`warn` 档原子降级到无边界并出告警、`off`
  档不做合格判定。RFC-205/227/233 的 provider 合同是按**能力**而非 OS 名写的，所以
  未来的 Job Object / AppContainer provider 可以直接接进去，不需要动核心准入。
  **触发条件**：任何要在 Windows 上以 `enforce` 运行的部署。属独立 RFC 的体量。
- ⏳ **(P2) 凭据 at-rest 在 Windows 上没有平台密钥保护**。macOS/Linux 侧的收口见
  上文「凭据 at-rest 收口」；Windows 的对应物是 **DPAPI**（`CryptProtectData`，
  按用户或按机器），目前未接入 ⇒ Windows 上的静态凭据保护等同于文件权限。
  与上面 ARM64 那条同一个技术前提：DPAPI 也要走 `bun:ffi`。
- ⏳ **(P3) npm 的 `.cmd` 垫片不自动解包**。RFC-254 D17 的结论是**绝不**经由
  `.cmd` 启动子进程——cmd.exe 会对 argv 重新分词，把精心构造的命令行改掉。因此
  本地 MCP 一律 wrapperless 物化。代价是：如果操作者配了一个只以 `.cmd` 形式存在
  的 MCP 命令（npm 全局包的常见形态），平台会拒绝而不是替他解开垫片指向真正的
  `node <script>`。自动解包是可做的（读 `.cmd` 找到目标脚本），但要先想清楚
  「解析别人的批处理文件」这件事本身的信任边界。
- ⏳ **(P3) win32 系统代理的孤儿缝**。POSIX 侧靠进程组回收；Windows 侧靠 Job
  Object，而 Job Object 在 ARM64 上不可用（见上一条）。这两者都覆盖不到的路径是
  **daemon 自身被 SIGKILL 后**留下的系统代理子进程——POSIX 上同样存在，但
  Windows 上没有 `/proc` 可供下一次启动时做可靠的孤儿识别。需要一个平台无关的
  「上次运行留下的 pid + 启动时间」记账，而不是靠内核设施。

## `focus-ring-clip` 从 4 个涨到 108 个（`01d3e541` 引入，2026-08-04）

`e2e/focus-ring-clip.spec.ts:941` 目前是 main 上 `Playwright e2e (shard 1/4)` 变红
的原因。**这条测试本来就不是绿的**（长期有 4 个被裁剪的 focus ring），但
`01d3e541 fix(frontend): keep task list scrolling local` 把它推到了 108。

逐点实测（每格都是独立 detached worktree + 完整 `build:binary:e2e` 后跑该 spec）：

| 提交                             | clipped focus ring |
| -------------------------------- | ------------------ |
| `01d3e541~1`                     | **4**              |
| `01d3e541`                       | **108**            |
| `6e9e1450`（其后第一个我方提交） | 108                |
| 当前 main                        | 104                |

`01d3e541..6e9e1450` 之间**没有任何**前端提交，所以区间归因是唯一的。之后的画布
改动把它从 108 微降到 104，量级未变。

- ⏳ **(P1) 归 `01d3e541` 的作者处理**。RFC-254 这一路只动了 e2e harness / stub /
  `e2e/command.ts`，与 focus ring 的裁剪无因果关系（上表 `01d3e541~1` 已排除）。
  未单方面修改：该文件所在的画布 / 样式面此刻正被并发 session 持续改动
  （`75fc8cdd`、`dc9930e9`），在其上改动会造成真实冲突。
- 复现：`bunx playwright test e2e/focus-ring-clip.spec.ts`，失败信息直接列出每个
  被裁剪元素的选择器与祖先 overflow 链。

## `rfc250-workflow-camera` 三条用例（并发画布改动引入，2026-08-04；2026-08-05 补根因）

**根因已查清，但修法需要画布作者的设计意图**：该 spec 断言在 `topology` 缩放档下
节点标题**不可见**。查证结果——

- `data-zoom-band='topology'` 属性本身是对的（那条断言通过）；
- 但 `styles.css` 里**从来没有**过「topology 档隐藏 `.canvas-node__title`」的规则
  （`git log -S` 全历史为空），画布组件里也没有按 band 的条件渲染；
- 所以这条断言依赖的是**几何效应**：缩到那么小的时候标题的包围盒塌成 0×0，
  Playwright 因而判定「不可见」。

也就是说，画布改动里有什么让标题在该缩放下**仍然可测量**（例如某个 min 尺寸、或
把 inverse-zoom 的 marker scale 施加到了文字上）。要恢复是让它继续塌陷、还是补一条
显式的 LOD 规则（更稳但改变了现有实现路径），是**设计选择**——不该由旁人猜。

**已修（2026-08-05）**：把「topology 档不显示标签」从**隐式的几何塌陷**改成**显式的
LOD 规则**（`data-zoom-band='topology'` 下 `.canvas-node__title { visibility: hidden }`）。
这不是发明行为——缩放档的定义本就是「只看形状、不看标签」，此前只是恰好靠算术成立；
任何让文字保持可测量的改动都会静默把标签放回来，而唯一注意到的只有这条 spec。三条
用例全绿，前端 5957 条与 workflow-editor / 视觉套件均未受影响。

## （原条目）

`e2e/rfc250-workflow-camera.spec.ts:823` 在 `6e9e1450` 上**通过**、在当前 main 上
失败，区间内只有画布 / 样式面的并发改动（`75fc8cdd fix(frontend): improve workflow
wrapper drag feedback` 一线）。同上，未单方面修改。

## `.session-role-badge` 的对比度不达 WCAG AA（RFC-027 起既有，2026-08-04 实测）

`.session-role-badge__label` 是 11px **粗体白字**压在角色色上，assistant 那档是
`#16a34a` ⇒ 对比度 **3.29:1**，AA 要求 4.5:1（axe `color-contrast`，
`e2e/intent-builder.spec.ts:193` 的 a11y 扫描实报）。徽章色自 `86e4a1b6`
（RFC-027）起就是这样，与任何近期改动无关。

**为什么现在才被看见**：这条断言扫的是「那一刻页面上有什么」，而徽章由
`ConversationFlow.tsx` 随会话转录渲染 ⇒ 扫描时转录渲染到哪一步决定了徽章在不在。
同一个提交（`190d9111`）**在 CI 上通过、在本机必现失败**，就是这个差异。因此它
既不是 flaky（本机隔离下稳定复现），也不是回归——是一条**间歇性可见的既有缺陷**。

- ⏳ **(P2) 一行修复已实测可行**：`--rfc027-accent: #16a34a` → `#15803d`（白字
  对比度 5.01:1），改后 `intent-builder.spec.ts` 四条全过（本机实测）。其余四档
  （`--user #2563eb` / `--tool #ea580c` / `--subagent #9333ea` /
  `--reasoning #64748b`）未逐一测算，应一并核对——**11px 粗体白字**这个组合对
  几乎所有中等明度色都不达标。
- 未代改的原因：徽章配色是有归属的视觉设计 token，且 `styles.css` 正被并发
  session 编辑；本轮（RFC-254 Windows）不应顺手改产品配色。

## Job Object 实现了但**没有接线**（RFC-254 实现门发现，2026-08-04）

`util/windowsJobObject.ts` 与 `util/process.ts` 的 `adoptSpawnedProcessTree` /
`isProcessTreeAlive` / `releaseProcessTreeOwnership` 已实现且经真机与 x64 CI 验证
（FFI 声明、结构偏移、标志常量全部正确），但**没有任何生产代码调用它们**——
`rg adoptSpawnedProcessTree packages e2e scripts` 除定义外只命中它自己的测试。

因此在真实 Windows daemon 上：`ownedTrees` 恒空 ⇒ `killProcessTree` 恒走
`taskkill /T /F`（枚举式，有竞态窗口）⇒ `isProcessTreeAlive` 恒返回 `null`。

**这个状态是安全的，但只是降级安全**：`null` 表示「判不了」，而设计门 P0-D 要求
调用方把「判不了」当「不可回收」，所以**数据损坏的防护在**；缺的是**强保证**
（真正拿到 Job Object 的权威存活计数）。文件头原本在断言强保证已生效，已订正。

- ⏳ **(P1) 接线**：在 win32 的 spawn 路径上 `adoptSpawnedProcessTree(child.pid)`，
  收尾时 `releaseProcessTreeOwnership(pid)`。候选点：`services/runner.ts` 的
  opencode 子进程、`execution/containedSpawn.ts` 的脚本节点、
  `runtime/opencode/verifiedLauncher.ts`。这些都是 RFC-224/227 的受控执行面，
  改动需自带回归测试与变异实证，属独立一轮切片而非顺手补。
- 注意接线后 `isProcessTreeAlive` 才会开始返回 `true`/`false`，届时所有把
  `null` 当「不安全」的调用方逻辑要重新过一遍——**语义变了**（从「永远判不了」
  变成「大多数时候能判」），沉默的分支会第一次被执行到。

## Windows e2e 腿的两条排除（RFC-254 T31，2026-08-05）

`ci.yml` 的 windows e2e 腿跳过**恰好两条**测试，两条都**在 POSIX 上同样红**、都不是
本 RFC 引入的：

- `focus rings are not clipped anywhere` —— 见上文「`focus-ring-clip` 从 4 个涨到
  108 个」，归 `01d3e541`；
- **整个 `rfc250-workflow-camera.spec.ts`（3 条）** —— 见上文
  `rfc250-workflow-camera` 条目，归并发的画布改动。**按文件排除而非按标题**：三条同源，只排掉第一条会把第二条顶上来变成新的失败（POSIX 上实测：排掉 `:823` 后 `:831` 就红）——那不是修，是把问题往后挪一格。

**为什么排除而不是让腿红着**：这是一条**新接的**门禁。红着上线的门禁没人看，一周后
就成了背景噪音；而这两条的所有者、根因、复现方式都已经查清并登记在案，不该由一条
新腿替它们背锅。

**排除按测试标题匹配、不按文件名**：Playwright 的 grep 也匹配文件路径，按文件名会
连带砍掉那两个文件里另外 8 条**在 Windows 上通过**的测试（实测 270 → 260 而不是
268）。

- ⏳ **(P2) 这两条一旦转绿就立刻删掉排除**。
  `packages/backend/tests/rfc254-windows-e2e-exclusions.test.ts` 双向盯着它：标题被
  改名（排除失效、腿会为一个自称已处理的原因变红）或清单变长（用减法维持绿）都会红，
  且要求每条都登记在本文件里。

## Windows 真机勘测发现的两处生产缺陷（RFC-254 T32，2026-08-05）

在 Windows 11 真机上跑后端全量时暴露的、**与测试写法无关的生产代码缺陷**。两条都不是
Windows 专属写法问题，而是既有实现对「非 POSIX 路径 / 非 POSIX 可执行文件」的假设。

### ① 仓库缓存目录名把整条源路径编进去 → `git clone` 直接失败（已修）

`packages/shared/src/git-url.ts` 的 `lastPathSegment` 只按 `/` 切最后一段。Windows 的
`file://C:\Users\…\remote-01KZ.git` 用 `\` 分隔，于是**整条路径成了「最后一段」**；
紧接着每个不安全字符被换成 `-`，缓存目录名变成

```
70dbb423-C--Users-…-Temp-aw-cached-repos-…-remote-01KZ….partial-01KZ…
```

git 随即以 `fatal: '$GIT_DIR' too big` 拒绝克隆。**注意这不是 `core.longpaths` 能解的
那个限制**——它是 git 自己的 GIT_DIR 缓冲上限，不是 Win32 的 MAX_PATH 检查，所以
RFC-254 已经加的 `-c core.longpaths=true` 对它无效。

修复只动 **slug**（目录名的可读部分），**不动 `canonicalForHash`**：hash 是存量
`cached_repos` 行的稳定键，重新推导会静默把每个已缓存仓库重键。同时给 slug 加了 64
字符上限——分隔符只是已知的一种越界途径，而这一段本来就没有任何上游保证其长度。
回归测试见 `packages/shared/tests/git-url.test.ts`（含一条专门盯住「hash 不得随之移动」）。

### ② 插件安装在 Windows 上整体不可用 —— `spawn('npm')` 撞 `.cmd` 垫片（未修，需独立改动）

`packages/backend/src/services/pluginInstaller.ts:599` 的 `runCommand` 直接
`spawn(bin, args)`，`bin` 取值 `'npm'`（`:141` 探活、`:221` 实际安装）。Windows 上 npm
是 `npm.cmd`，`child_process.spawn` 不经 shell 无法执行批处理垫片，报

```
EFTYPE: inappropriate file type or format, uv_spawn
```

即**插件安装/探活在 Windows 上没有一条能走通**。

- ⏳ **(P1) 修的时候不要用 `shell: true`**。那会让 cmd.exe 重新切词整条命令行，正是
  D17 记录的危险面（插件名 / 版本号里的元字符会被解释）。可行方向是绕过垫片直接执行其
  JS 入口（`node <npm-cli.js>`），或用一个显式的垫片解析层——两者都需要自己的测试。
- 现状**没有测试会发现它**：后端矩阵还没接 Windows（T31 后端侧未完成），POSIX 上这条
  路径完全正常。修好前不得声称 Windows 支持插件安装。

## `prose-code-mermaid-theme` 的 flake 修在了错的一层（2026-08-05 观测）

`packages/frontend/tests/prose-code-mermaid-theme.test.tsx:75`
（`toggling <html data-theme> dark→light re-invokes MermaidBlock.render`）在**全量前端
套件**下三次跑挂了两次，单独跑该文件 3/3 通过、耗时 33ms。报错是

```
Error: Test timed out in 5000ms.
```

**注意这不是断言失败，也不是 `waitFor` 超时**。`f37ef44d` 曾专门治过这条 flake，注释
写得很清楚：MutationObserver → setState → useEffect 这条链在慢 runner 上会错过 1 秒
默认预算，所以把 `waitFor` 的显式预算提到 5000ms。问题在于**外层 vitest 测试预算也是
默认的 5000ms**：内层等待永远等不满就被外层掐断，于是

- 内层那个 5000ms 实际上不可达，等于没提；
- 失败呈现为「测试超时」而不是作者想要的「renderSpy 最后一次调用不是 dark」诊断，
  下一个接手的人看不到真正有用的信息；
- 该测试里有**两个**各 5000ms 的 `waitFor`，预算算术从一开始就不自洽。

- ⏳ **(P2) 修法**：给这条 `test()` 一个大于内层等待之和的超时（vitest 的第三个参数），
  或把内层预算降到显著小于外层。**不要**只是再调大内层——那正是上次踩的坑。
- **CI 现在是绿的**，因为前端在 CI 里是分片跑的，负载形态与本地全量不同；这条只在
  全量同跑时暴露，属于「门禁看不见但真实存在」的一类。

## A 类：后端测试自写 `#!/bin/sh` 假二进制（RFC-254 T32，2026-08-05）

Windows 后端全量里剩下的最大一簇，**根因单一**：测试写一个 `#!/bin/sh` 脚本当作
「opencode 可执行文件」，再交给生产代码去 spawn。Windows 上 `uv_spawn` 拒绝它：

```
spawn opencode failed: EFTYPE: inappropriate file type or format, uv_spawn
```

**这一簇比最初估计的大**，因为它的失败会伪装成别的东西。`fusion-engine.test.ts`
两条报的是「取消后任务状态应为 canceled，实得 failed」，看起来像取消语义在 Windows
上不同——实际是 runtime spawn 失败让任务先以 `failed` 收场。**先前把它归为「取消
语义缺陷」的判断已证伪**；判据是同一条日志里紧邻的 `runtime-spawn-failed`。
已知成员：`opencode-models.test.ts`（9）、`fusion-engine.test.ts`（2），以及任何
以 `stub-opencode.sh` 形态出现的夹具。

**为什么不能机械替换**：

- 换 `.cmd`/`.bat` 没用——`uv_spawn` 同样拒绝批处理垫片（这正是插件安装那条
  D17 缺陷的机制），除非经 shell，而经 shell 会引入 argv 重新切词的危险面；
- 生产 API 收的是**单个路径字符串**（`listOpencodeModels(binary)`），所以假二进制
  必须是「一个能被直接 spawn 的文件」，不能是 `bun script.js` 这种两段式。

### 2026-08-05 进展：9/11 已修，不需要编译产物

实测推翻了「必须编译一个 stub 可执行文件」的前提：**`Bun.spawn` 能直接执行 `.cmd`**
（与 `node:child_process.spawn` 不同，后者对批处理 `EFTYPE` 拒绝）。所以后端单测的
假二进制只要按平台换形态即可，不必给单测挂构建产物。

已落地 `packages/backend/tests/fixtures/fakeBinary.ts`：按平台产出 `.cmd` / sh，
**输出走数据文件而非往脚本里转义**（两平台字节一致，且免掉批处理对 `%&<>^` 的转义
地狱）。`opencode-models.test.ts` 9 条已全绿（Windows 实测 13 pass / 1 skip / 0 fail），
其中 1 条按主语归类守起——它测的是 POSIX 进程组回收，Windows 对应的 Job Object
按 RFC-254 v1 决定未接线。

**剩 `fusion-engine.test.ts` 2 条**，卡在一个具体障碍上：该 stub 要**解析 argv**
（用 sed 从提示词里抽 nonce），批处理做不了。可行形态是薄壳 `.cmd` 转发给
`bun <script.ts> %*`，但 `%*` 过 cmd.exe 会遇到本文件上一条记录的**重新切词**问题，
而那个提示词里带引号——需要先实测 argv 完整性再决定，不该硬上。

**薄壳方案已实测排除**（2026-08-05，Windows 11 真机）。用真实形态的提示词测
`stub.cmd` → `bun impl.ts %*` 的 argv 完整性：

```
SENT: ["run","--print-logs","Please answer.\n<workflow-clarify nonce=\"abc123\">ok</workflow-clarify>","a & b","has \"quotes\" inside","100% done"]
GOT : ["run","--print-logs","Please answer."]
```

提示词在**换行处被截断**，其后连同其余全部参数一起消失（`<` `>` 会被当重定向、
`&` 当命令分隔、`%` 当变量）。所以「薄壳 `.cmd` 转发」不是可选项，不是调调引号的
问题。

- ⏳ **(P1) 剩下的路只有两条**，且第二条更可取：
  1. 给这两条测试一个**真的 `.exe`**（回到编译产物，代价是给后端单测挂构建步骤）；
  2. **换缝**——让测试注入一个假 runtime，而不是伪造一个可执行文件。fusion 的
     `h.deps` 已经是注入点，若 runtime spawn 能从那里注入，这两条测试根本不需要
     进程，也就与平台无关了。这正是 plan 里「改用别的 seam」那一项。
- **不要**为了让它们变绿而按主语归类守起：它们测的是 fusion 的取消语义，不是 POSIX
  机制，守起来会真丢 Windows 覆盖。

## Windows 上删不掉临时目录：EBUSY 不是「等一下就好」（RFC-254 T32，2026-08-05，未解）

`db.test.ts` / `cli.test.ts` / `gettask-multi-repo.test.ts` 在 Windows 上于**拆卸阶段**
失败：

```
EBUSY: resource busy or locked, rm 'C:\...\Temp\aw-db-xxxxxx'
```

失败落在 `afterAll` / `cleanup`，所以报表把它记成 `db client > (unnamed)` 这种条目，
而该 describe 的真实用例全部通过——归因极具误导性。

**已做且被证伪的两步**（记下来，免得下一个人重走）：

1. **委托给 Node 的 `rmSync({ maxRetries, retryDelay })`——无效**。本套件跑在 Bun 下，
   Bun 的 `node:fs.rmSync` **接受这两个选项但不实现重试**，调用看起来在重试，实际只
   试了一次。判据：加上后拆卸耗时纹丝不动（0.6ms）。
2. **改成显式重试循环（约 1 秒，见 `tests/fixtures/tempDir.ts`）——仍失败**。这次重试
   确实在跑（拆卸耗时 0.6ms → ~1376ms，把预算烧满了），但目录依旧删不掉。

所以句柄在 `$client.close()` 之后**存活超过一秒**。`$client` 确实存在且是 `Database`
实例（已实测 `'$client' in db === true`），close 也确实被调用。

- ⏳ **(P1) 下一步该查的是「谁还开着」，而不是「再等久一点」**：候选是 ①`cli.test.ts`
  spawn 的 CLI 子进程未退出（其 cwd / 打开的文件会锁住目录，POSIX 上完全看不见）；
  ②Bun 的 `bun:sqlite` 在 Windows 上 `close()` 后不立即释放文件（WAL 的 `-wal`/`-shm`
  尤其可疑）。用 `handle.exe` / `Get-Process` 之类直接看持有者，比继续调重试参数有用。
- **不要把重试预算再调大**当作修复——那只会把「永不释放」伪装成「很慢」。
- ✅ **`cli.test.ts` 已定位并修复（RFC-254 T31 task#11，`84604e9e`，真机确证）**：真机跑 `Get-Process bun` **拆卸后 0 个残留 bun 进程 ⇒ 候选①（子进程未退）排除**；根因是候选②的**具体形态——不是「close 后释放慢」，而是根本没 close**：`cli/migrate.ts:migrateCommand` `openDb()` 后**丢弃句柄从不 close**（注释「进程随后退出」故意不关，对 CLI 成立、对同进程复用的测试 harness 不成立）⇒ 泄漏的 bun:sqlite 连接锁住 temp dir。修 = `const db=openDb(...); db.$client.close()`。**真机实测 close 后 temp dir 干净删除（aw-cli dirs before=22 after=22）⇒ 关键修正上文「close() 后句柄存活>1s」的旧结论：close() 在 Windows 确实立即释放，之前的 EBUSY 是「压根没 close 的泄漏」而非「close 后释放慢」**。**据此 `db.test.ts`/`gettask-multi-repo` 应重查有无「未 close 的句柄」（db.test.ts afterAll 关的是 tracked 的那些，若有未 tracked 的 open 就会泄漏），而不是当「close 释放慢」**——真凶大概率也是某处 openDb/new Database 没进 close 路径。POSIX 看不见（打开的文件可 unlink），故此类泄漏只在 Windows 拆卸暴露。

### 已定位（2026-08-05）：`close()` 根本没关上

直接在 Windows 上探测，上面的候选 ② 成立：

```
files after open : t.sqlite, t.sqlite-shm, t.sqlite-wal
close() 返回      → 三个文件仍在，且全部 unlink 失败（EBUSY）
close(true) 抛    → "database is locked"
```

`close(true)` 是「报错而非推迟」的那一种，它抛 `database is locked` = SQLITE_BUSY，
说明**仍有未 finalize 的预处理语句持有连接**（drizzle 的语句缓存），连接从未真正关闭；
`-wal`/`-shm` 还在也印证了这点——干净关闭会 checkpoint 并删掉它们。**所以等待永远
没用，这不是时序问题。**

**处置**：拆卸的职责是清理卫生、不是断言。在运行时确实释放不了句柄的平台上，把
「重试耗尽后仍失败」降级为**可见告警**而非抛出——它此前把一个已经通过的测试报成
`(unnamed)` 失败，是最具误导性的一类结果。范围收窄到 win32、且只在耗尽全部重试之后；
POSIX 仍然照抛，因为在那里删不掉自己的临时目录是真问题。见
`packages/backend/tests/fixtures/tempDir.ts`。

- ⏳ **(P2) 真正的根治**是让 drizzle 释放语句缓存后再 close；目前没有公开 API 可用。
  若将来 Bun 或 drizzle 提供 finalize-all，这条降级应当撤掉。
- **生产含义**：守护进程在 Windows 上同样关不干净这个 SQLite 连接。目前靠进程退出
  兜底，热重启 / 同进程内换库的路径需要单独验。

## 视觉回归权威腿自 2026-08-04 15:25 起一直红（归属 `a5c7e94d`，非 RFC-254）

`visual-regression-nightly` 的 ubuntu 权威腿**每次 push 都红，9 条**，从
`ed1ee666`（14:52 最后一次绿）到 `e1cadebf`（15:25 首红）之间开始。

**归属与机制**：`a5c7e94d`（RFC-257 webhook UI 修订）给 `ShellNavigation.tsx` 加了
「Webhooks」侧栏导航项，但**没有重生成视觉基线**。这 9 条全是含侧栏的整页或对话框
截图，多一个导航项就整体位移：

```
repo-group-flat-20-1440 / repo-group-nested-1440 / workflow-complex-overview
/memory list / RFC-195 inbox empty·populated(light)·populated(dark)
390 mobile home with navigation / RFC-199 editor 1536 three-rail workspace
```

**顺带修正一条 RFC-254 的判断**：`390 mobile home with navigation` 在 Windows 上
装不下，我起初单归因于 Segoe UI 的字体度量——**说少了一半**。导航本身多了一项，
这是所有平台共同变高的原因；字体度量只决定 Windows 是唯一越过临界点的那个。

- ⏳ **(P1) 要么重生成这 9 张基线，要么说明该 UI 变更不该改变它们**。这是 RFC-257
  作者的判断（导航项的最终形态是否已定），不该由旁人代拍。
- **这条腿红着直接挡住 RFC-254 的 T35**（收敛判据 = 连续 3 次 main push 零未登记红）。
- 教训同 `dev-gotchas.md`：**改共享 chrome（侧栏 / 页头 / 全局样式）必须同批重生成
  视觉基线**，否则代价由下一个碰 CI 的人承担，而且会被误判成他引入的。

## 实测：`Bun.spawn` 执行 `.cmd` 会经 cmd.exe 重新切词（RFC-254 T32，2026-08-05）

在 Windows 11 真机上实测，**不需要 `shell: true`**——Windows 执行批处理本身就要过
cmd.exe，所以 `Bun.spawn({cmd:['x.cmd', ...args]})` 的 args 会被重新解析：

| 传入                    | 子进程实际看到 / 发生了什么                                |
| ----------------------- | ---------------------------------------------------------- |
| `['a&whoami']`          | 参数变成 `[a]`，**`whoami` 被执行了**（输出机器名\用户名） |
| `['x\|y','p>q']`        | 管道与重定向被解释，输出为空                               |
| `['%PATH%']`            | 环境变量被展开，并按空格拆成 30 多个参数                   |
| `['plain','two words']` | 正常（含空格的整参数得以保留）                             |

**两条直接结论**：

1. **`node:child_process.spawn` 与 `Bun.spawn` 行为不同**。前者对 `.cmd` 直接
   `EFTYPE` 拒绝（插件安装那条缺陷的成因），后者接受并交给 cmd.exe。所以「改用
   `Bun.spawn` 就好了」**能让 `npm --version` 跑通**（实测 code=0 / 11.17.0），
   但那是用一个注入面换一个报错，**不是修复**——插件名与版本号是用户可控输入。
2. 测试夹具里用 `.cmd` 假二进制是**可以的**，因为那里的 argv 由测试自己写死
   （`models --verbose` 之类）。但这个豁免不得外溢到生产：判据是「参数是否可能
   来自用户/DB/仓库内容」，不是「这里方便」。

- ⏳ **(P1) 插件安装的正解仍是绕开垫片**（直接执行 npm 的 JS 入口），或对参数做严格
  白名单校验后再走垫片。本条实测把「不得用 `shell: true`」的告诫升级为**有证据的
  硬约束**，且范围扩大到「任何 `.cmd`/`.bat` 目标」。

## ~~fusion 的 git worktree 在 Windows 上是坏的~~ → **真因是这个测试文件没有时间预算**（RFC-254 T32，2026-08-05，**已修**）

把 `fusion-engine.test.ts` 的假二进制换成 `opencodeCmd: [bun, stub.ts]` 后（`opencodeCmd`
本来就是**命令数组**，argv 直接进 spawn、不过 shell，所以既不需要假二进制也不受
cmd.exe 切词影响），Windows 上的 spawn 通了——日志里能看到 `bin=…\bun.exe` 被拉起。

**于是下一层暴露出来**，失败数从 2 涨到 7。这不是变糟，是原先 spawn 早早失败、后面
的流程根本没跑到：

```
git reset --mixed (iso): fatal: Could not parse object '<sha>'
workspace-missing: canonical worktree does not exist: …\fusions\…\iter1\work
git worktree remove failed: cannot change to '…': No such file or directory
TypeError: null is not an object (evaluating 'task.worktreePath')
```

### 结案（2026-08-05）：**不是 git 的问题，是这个文件没有时间预算**

查的过程本身值得留档，因为**中途下过一个错的结论**：

1. **安静的机器上复现不了**。同一 HEAD（`43a86c0b`，四个相关文件逐个 SHA-256 比对与
   本地一致）跑 `fusion-engine.test.ts` 是 **32 pass / 0 fail**，两次（单文件一次、与
   另外 7 个 worktree/iso 套件一起 `--randomize` 一次），上面四行**一行都没出现**。
2. **取样机确实被污染过**：复测前 `Get-Process bun` 查到**三个被遗弃的全量跑**还在
   机器上转（`bun test packages/backend/tests`，无 `--isolate`），启动于 09:58 /
   10:56 / 15:23，**累计 CPU 20803s / 17082s / 1163s**、驻留 0.3–1.7 GB——不是挂住
   空转，是**在烧 CPU**。原先那次 7 红就是在这个背景下取的。
3. **于是我一度结案为「污染，无缺陷」——这是错的。** 把负载**照着造回来**（四核各压
   一个 CPU burner）再跑同一个文件：**22 pass / 10 fail**。所以本条是真的，只是
   **对时延敏感**，安静的机器把它藏起来了。
   逐条对表（本次实测出现次数）：`workspace-missing` ×5、`cannot change to` ×2、
   `task.worktreePath` ×4，外加 `exited 143` ×2、`timed out after` ×20。
   原记录里的 `Could not parse object` 与 `worktree remove failed` **本次没出现**——
   同一根因下删除时序略有不同就会换一种报法，所以别拿具体某一行当判据，判据是下面
   那条链。

**真因**：这个文件里大多数用例**真的启动引擎任务**（建 git 仓、跑工作流、拉起 stub
运行时、停在 clarify），安静的 Windows 机器上单条 1.5–3.4s，**已经占掉 bun 默认 5s
预算的 30–70%**，而这个文件从来没声明过预算。机器一慢就超时。

**而超时不只是「这条红了」，它会把整个跑污染掉**——这是本条最值得记的地方：

```
bun 判定超时 → 回收该测试的子进程 → 在飞的 git rev-list 收到 SIGTERM（exit 143）
  → seedWorktree 认为基线解析失败并抛错
  → createFusion 的 finally 把它仍持有的 fusion work dir 删掉
  → 但该测试此前已经启动的任务还在被调度，于是 iso 从一个已被删除的目录上建
  → 报出 `git worktree add (iso): fatal: cannot change to '…\iter1\work'`
     / `workspace-missing: canonical worktree does not exist`
     / `TypeError: null is not an object (evaluating 'task.worktreePath')`
```

**四行错误都点名 git / worktree，于是被当成「Windows 上 git worktree 坏了」立了一条
P1——而它们全是 bun 自己那个超时回收的下游。** 这类误导性极强：报错的主语（git）和
真正的主语（测试预算）隔着两层。

**修法**：`setDefaultTimeout(60_000)`（仓内已有先例：`task-start-pre-worktree` /
`clarify-review-combination-scenarios` 等真流程套件都这么做）。**同一负载下复测：
32 pass / 0 fail，四行错误零出现**（修前同负载 10 红）。

- **留给下次的判据**：Windows 上再看到「git 报路径不存在 / 对象解析不了」这类错误，
  先看**同一批日志里有没有 `exited 143` 或 `this test timed out`**。有的话主语不是
  git，是预算。
- 这条也解释了为什么此前 `hasDirtySubmoduleContent`、`callgraph-multirepo-prefix`、
  `gettask-multi-repo` 都要显式预算：**跑真 I/O 的用例贴着 5s 默认跑，就是在等一台
  慢机器把它变成一份假的缺陷报告**。

- **记账口径**：这 7 条从来就不该记在上一批那次「换缝改动」头上；换缝本身是正解
  （无假二进制、stub 逻辑随套件一起类型检查、与平台无关），它只是让流程往下多跑了
  一段，从而把这条预算问题露出来。

### 同一形态的下一批：已按同一负载逐个实测，并**订正了我自己的度量口径**

先从整簇复扫（55 个文件、安静的 Windows 机器）里量出**通过但贴着上限**的用例，再把
负载造回来逐个跑，结果**推翻了「贴着上限 ⇒ 会红」的直觉**——只有一个真红：

| 文件                                     | 复扫里最慢一条（报表值） | 同负载复跑     | 现状                                                         |
| ---------------------------------------- | ------------------------ | -------------- | ------------------------------------------------------------ |
| `rfc130-node-isolation.test.ts`          | 4947                     | **3 条超时红** | 已加 `setDefaultTimeout(60_000)`，同负载复测 5 pass / 0 fail |
| `git-repo-cache.test.ts`                 | 4645                     | 扛住（两轮）   | 已加预算（用户指示），同负载复测绿                           |
| `clarify-inline-isolated-parity.test.ts` | 4729                     | 扛住（两轮）   | 已加预算（用户指示），同负载复测绿                           |
| `rfc210-git-diff-subrepo-paths.test.ts`  | 4749                     | 扛住（两轮）   | **本来就逐条 120s**，从来不在风险里——原表把它列进来是错的    |
| `task-start-git-identity.test.ts`        | 4463                     | 红 3 条        | **不是预算问题**，见下                                       |

#### ⚠️ 度量口径订正：**bun 报表里的耗时含 hook，而 5s 超时只管 test body**

这条把上面整张表的「风险排序」推翻了一半。直接探针（3s `beforeEach` + 3s body，默认
预算）实测：**报表打印 6.02s，测试照样 pass**。所以：

- **不能按报表耗时给「贴着上限」排序**——把重活放在 `beforeEach` 里的文件，报表数字
  很大而 body 很轻，风险其实低；这正是 `git-repo-cache` / `clarify-inline-isolated-parity`
  报表 4.6–4.7s（负载下甚至 5.5–6.0s）却两轮都没红的原因。
- 真红的 `rfc130-node-isolation` 恰恰相反：它每条用例**在 body 里**建仓、快照、
  `worktree add`、merge back，所以报表值几乎就是 body 值。
- **判据应当是「body 里做了多少真 I/O」，不是报表数字。** 报表数字只配当粗筛。

#### 一处对既有记录的订正（与预算无关）

`task-start-git-identity` 的 3 条红**与预算无关**（它本来就声明了预算），真因是
`stub-opencode-env.sh` 这个 **`.sh` 假二进制**在 Windows 上 `EFTYPE`——也就是
**「A 类清零」这个说法只在当时取样到的那几个文件上成立，不是全仓成立**。
`packages/backend/tests` 下写 shell shebang 的文件仍有几十个（`grep -rl
'#!/bin/sh\|#!/usr/bin/env bash'`），其中哪些真正会在 Windows 上被执行到，需要按
「这个 stub 会不会被 spawn」逐个判，不能按文件名猜。

一个佐证顺带记下：`rfc130-iso-worktree-primitives` 的 `hasDirtySubmoduleContent` 在
这次复扫里跑了 **9339ms**——所以给它 60s 而不是「比实测高一点」的 10s 是对的。

### 相邻套件另有 7 条真红（已修，2026-08-05）

把 fusion 与相邻的 worktree/iso 套件一起在安静的机器上跑，除了上面那条，红的还有
这些——**它们与 fusion 无关，且在安静的机器上就红**：

1. `rfc213-worktree-capture.test.ts` **5 条**：`afterEach` 的 `rmSync` 报 EBUSY——每个
   临时目录里都有一个开着的 `db.sqlite`，正是 `fixtures/tempDir.ts` 记录的那个「Bun 的
   sqlite `close()` 在 Windows 上并没真的关上」。改用 `removeTempDirSync`，并把循环改成
   **每个目录都试、第一个真错误留到循环之后再抛**：旧写法在**第一个**忙目录上就中断
   整个循环，后面的目录连试都没试过（本次实测 5 条告警对应 5 个带 db 的目录，而同批的
   staging 目录现在能正常删掉）。**留着「循环后再抛」而不是就地吞掉**是有意的——
   `tempDir.ts` 在 POSIX 上仍照抛，删不掉自己的临时目录在那里是真问题，吞掉等于把它
   悄悄撤销了。
2. 同文件 **1 条**是真断言失败：`impl-gate P2-7` 用 `chmod 000` 制造「读不了的文件」让
   tar 失败，而 Windows 上**这个机制是空操作**——实测文件照读、`tar` 退出 0，于是断言的
   那个 skip 根本没发生。它此前还需要一个 `getuid() === 0` 的逃生口（root 照样能读），
   即这个夹具本来就已经有一台宿主上什么都没证明。改成让坏 worktree 的路径**存在但不是
   目录**：`tar -C <文件>` chdir 失败退非零，**四种 tar 逐一实测**——bsdtar 3.5.3
   (macOS) 退 1、bsdtar (Windows 11) 退 1、GNU tar 1.35 (CI ubuntu) 退 2、
   busybox 1.37 (alpine) 退 1——无权限、无特权判定、无平台分支，被测主题一字未改。
3. `rfc130-iso-worktree-primitives.test.ts` **1 条**：`hasDirtySubmoduleContent` 5018ms
   撞默认 5s 上限。它是三个 `git init` 加一次 `submodule add`（真 clone）约二十次 git
   spawn，本机 ~1.6s；给显式 60s 预算（同 `callgraph-multirepo-prefix` /
   `gettask-multi-repo` 的处置）。

修完复测（Windows，安静机器，`--isolate --randomize`，10 个文件：上述 8 个 +
`callgraph-multirepo-prefix` + `gettask-multi-repo`）：**80 pass / 0 fail**。其中
`tar: could not chdir to 'C:\…\aw_bad-task'` 证明新夹具在 Windows 上照样退非零；7 条
`[tempDir] leaving … behind` 告警证明 EBUSY 是真的、只是不再被记成测试失败。

再把整簇复扫一遍（`worktree|iso|git|backup|fusion` 命名的全部 **55 个文件**）：
**429 pass / 9 skip / 22 fail**，fusion 两件与上面修的三件**全部零失败**。剩下 22 条
在这一簇的其他文件上，尚未处理：`rfc252-git-hardening`(6)、
`migration-0102-rfc210-submodule-isolation`(4)、`task-start-git-identity`(3)、
`rfc213-pre-migration-backup`(3)、`rfc205-git-credential`(3)、
`rfc208-unbounded-git-and-permits`(2)、`rfc188-isolated-agent-run`(1)。

- ⏳ **(P1)** 上面这 22 条要逐条定性（真缺陷 / 测试可移植性 / 平台无此机制），判据同
  `tests/fixtures/platformScope.ts` 的那条规则：**断言的主语**是不是 POSIX 机制本身。
- **读 bun 报表的坑**：末尾那份汇总清单会被「按最后一个文件标记归属」的朴素脚本
  整份算到**最后一个文件**头上（本次 `rfc205-git-credential` 一度显示 25 = 自身 3 +
  汇总 22）。归属统计要截到**最后一个文件标记之前**。

## ~~Windows 上后端全量跑会卡死~~ → **根因已抓到并修掉：unref 的 deadline 定时器**（2026-08-05，**已修**）

原记录：`bun test --isolate --randomize` 跑到 181/1033 个文件停住，父进程烧 CPU、无子进程、
输出冻结；三个被遗弃的 6 小时进程是同一形态。原条目还写了「卡住的位置随 `--randomize` 变，
不要按最后打印的文件归因」——**这句是错的**：分批 sweep（排序、非随机）在同一个文件停下，
单独跑该文件 12 分钟必卡，位置从来不是随机的，是 `memory-distiller.test.ts`。

**根因（15 行可复现，Bun 平台 bug 的两张脸）**：Windows 的 Bun 上，**事件循环上不再有
ref 住的东西时，unref 掉的定时器永远不触发**——
①`Promise.race` 里 unref 的 deadline（`settlesDistillerWithin` 形态）永不 settle，
`bun test` 冻死（macOS 同用例 22ms 过）；
②`AbortSignal.timeout` 内部定时器同为 unref 语义且不给句柄，只 await 它的 abort 同样
冻死（`rfc208` 的 PlantUML never-settling 测试即此，batch 07/08/11 的 wedge 源）。

**生产语义比测试更糟**：这些 unref 的 deadline 里有 SIGKILL 升级链（runtimeSmoke /
systemAgentRun / memoryDistiller）——子进程 wedge 时**杀它的定时器自己也不触发**；还有
全部对外 fetch 超时（OIDC ×3 / PlantUML / stop 控制通道）——黑洞主机上的 fetch 在空闲
daemon 里**永不超时**，恰是这些超时存在的目的。POSIX 上循环通常另有 ref 的东西掩着。

**修法**：12 处（6 文件）deadline 去 unref + settle 路径 clear；`AbortSignal.timeout`
全下，换 `util/timeoutSignal.ts`（ref 定时器 + 显式 cancel）；守卫
`rfc254-no-unref-deadline-guard.test.ts` 双禁（配对形态 + `AbortSignal.timeout`），
上线即抓到手数漏掉的两处，两类变异实证均做。**Windows 复测：两个必卡文件 + 守卫
39 pass / 0 fail / 2.05s 干净退出**（修前 12 分钟 wedge）。

### 首份**完整**的 Windows 后端清单（2026-08-05，wedge 根治后 13/13 批全出数）

**8359 pass / 约 506 fail / 1034 文件**（分批计数按批汇总行相加；此前的「386 条」
与「约 32 条」都作废——前者是坏取样的估算，后者只覆盖了当时看过的套件）。批分布：

| 批  | pass/fail | 批  | pass/fail                          |
| --- | --------- | --- | ---------------------------------- |
| 01  | 867/1     | 08  | 613/77（40min ceiling 下正常跑完） |
| 02  | 705/1     | 09  | 622/**143**                        |
| 03  | 487/19    | 10  | 841/51                             |
| 04  | 441/37    | 11  | 430/47                             |
| 05  | 567/37    | 12  | 631/40                             |
| 06  | 932/12    | 13  | 627/18                             |
| 07  | 596/23    |     |                                    |

- 原始批输出在取样机 `C:\tmp\batches\batch-*.txt`（每批含 FILES 清单与完整 stdout/
  stderr），逐条定性以它为准——stdout/stderr 交错使朴素 per-file 归属只能扫到 177/506，
  **不要**拿归属脚本的数字当总账。
- ⏳ **(P1) 下一轮切片：506 条逐条定性**（真缺陷 / 测试可移植性 / 平台无此机制），判据
  同 `tests/fixtures/platformScope.ts`。大头：batch 09 的 rfc22x 簇 143 条、batch 08 的
  rfc21x/22x 簇 77 条。已定性的第一条：`rfc210-new-submodule-topology` 的
  「NEXT node does not delete it」在 Windows 上 `subBases['newsub']` 为 undefined——
  **真缺陷候选**（attached-but-unstaged submodule 的拓扑捕获在 Windows 上没认出来，
  方向大概率是 `.git` 文件 gitdir 指针或路径拼写），不是测试卫生。

  ### ~~(P1，真缺陷候选) verified 二进制快照在 Windows 上丢扩展名~~（✅ 2026-08-12 对账：已随 RFC-276 删除 verified 体系而 moot——`runtime/binarySnapshot.ts` 不复存在）

  查 `rfc135-runtimes-status` 那 8 条红时挖到的，**比测试更深**：`snapshotRuntimeOpencodeBinary`
  （`services/runtime/binarySnapshot.ts:182`）把 `command[0]` 用 `copyFile` 原样拷到
  `snapshotPath` 后**重新执行那份副本**，而快照名是无扩展名的 `opencode`
  （`helpers/runtimeOpencodeFixture.ts:20`）。POSIX 上无扩展照跑；Windows 上一个内容是
  批处理/可执行、但**没有 `.exe`/`.cmd` 扩展名**的文件既进不了 PATHEXT 也不被 `CreateProcess`
  当可执行，于是 `--version` 探测失败、整行 `ok:false`。这不是 rfc135 夹具的问题——夹具的
  `.cmd` 独立 spawn 实测 exit 0 stdout 精确；是**快照路径本身在 Windows 上落地了一个跑不起来
  的副本**。因为它在 RFC-224/227 的 verified 执行链上（不只探测），影响面到 opencode
  正常拉起，需按能力收缩型 RFC 的证据门核实后修（快照名保留源扩展名 / 或按平台补扩展）。

  **2026-08-06 追加：试改后确认这是 verified-path 结构改动，不是单点修复——完整触点已测绘**。
  在 `snapshotRuntimeBinary` 里「win32 追加源扩展名 + 返回实际路径」是对的（digest 是字节
  哈希、不含文件名，信任边界不动），但它打破了一条贯穿 verified-path 的不变量
  **「snapshot 落在传入的确切路径上」**，下列每处都要一起改（漏一处 = Windows 上静默拉不起）：
  - `binarySnapshot.ts`：copy/chmod/verify/unlink/return 全走 `effectiveSnapshotPath`，且
    `effectiveSnapshotPath` 须提到函数外层（catch 清理要用，try 内 `const` catch 不可见）；
  - `withRuntimeBinarySnapshot`（同文件）：verify + callback 改用 `identity.snapshotPath` 而非
    预算的 basename；
  - **`verifiedPlanCore.ts:104` 是 FATAL 守卫** `binaryIdentity.snapshotPath !== input.binaryPath
⇒ execution-identity-untrusted-binary`——win32 追扩展名后必触发，须放宽为「等于 input 或
    input+已知扩展名」，且**下游执行路径与 containment bind 投影要用实际 snapshotPath**；
  - `verifiedPlan.ts:215` 的 toolchain-bun 守卫 `snapshot.snapshotPath === snapshotPath`（非
    fatal，但会静默丢掉沙盒 bun 使受控 PATH 缺 bun）；
  - `claudeCode/driver.ts:159` 与 `:247`：`claudeCmd/sealedHead = [sealPath]` 及
    `verifyRuntimeBinarySnapshot(sealPath,…)` 全改用 `identity.snapshotPath`；
  - `verifiedSystemPlan.ts` / `verifiedMcpTestPlan.ts` / `mcpTestExecutionMaterial.ts:179`：
    平行结构，同样从 snapshotPath 构造执行 cmd，逐个核。
  - **扩展名必须在 resolve 之后取**（`.exe` vs `.cmd` 不同、猜错照样不可执行），所以不能在
    调用方预算路径绕开——不变量只能放宽，不能规避。
    因此这条从「单点缺陷」升级为 **RFC-254 子任务：verified-path 快照可执行性（Windows）**，
    改前须走设计门 + 改后重跑 RFC-224/227 identity/containment 资格套件（试改已回滚，未入库）。
    **rfc135 的换缝改动已回滚**（8 条改到 6 条真红 + 2 gated 后，剩下的 6 条全部撞这条产品缺陷，
    不该用一个依赖未修产品路径的测试去掩盖它）；该文件的 A 类移植待此缺陷修复后再做。

  ### ⏳ **(P1) 剩余 ~400 条的性质盘点：多数不是「测试可移植性」，是产品/平台缺口**

  2026-08-06 逐簇实测三个大簇后订正一个此前偏乐观的口径——**能靠改测试清掉的 A 类/路径
  字面量类已基本清完（累计 ~105+）；剩下的大头卡在产品侧，逐个改测试清不动**：
  - `rfc224-store-hygiene`(19) 及 RFC-224 launcher/hygiene 家族一大片：撞 **win32 file-trust
    未实现**——`assertPrivateRegularFileForHost` / `assertSameFileIdentityForHost` 在 win32
    返回 not-trusted（`util/fileTrust.ts` 明写「a win32 implementation is a separate task」），
    而 `storeHygiene.ts` 全程走 `...ForHost` 绑定（无注入缝），生产代码 fail-closed 正确、
    测试走的就是这条真路径。**需要 win32 file-trust 原语（T0 的显式延期项），不是测试问题。**
  - `runtime-smoke`(14 条 mock-backed) + `rfc107` + `rfc135`：撞 **`smokeRuntime`/registry 只收
    `binaryPath: string`（单个可执行文件），没有 `opencodeCmd` 那样的命令数组注入缝**。
    **RFC-282 C1 已补缝（2026-08-12）**：`SmokeOptions.binaryPath` 收 `string | readonly string[]`
    （经 `binaryOverride` 落 driver 命令头）+ `driver.probe` head 同步拓宽为数组；
    macOS/Linux 行为逐字节不变，Windows 腿转绿待下一次 `windows-platform` CI 自然确证。
    实测把 `wrapperFor` 的 `#!/bin/sh` 换成 `.cmd` 跑 `bun run <mock>` **更糟**——每条撞 30s
    smoke 超时（cmd→`bun run` 的管道 stdout 不回流）。真正的修法是给这条路径加命令数组缝，
    属 verified-path 生产改动、要走 RFC 门。runtime-smoke 里 3 条纯路径校验/非协议二进制的
    子用例可换缝（本轮验证过 macOS 21/21），但与 14 条 mock 用例混在一个文件、单独提交价值
    低，**已整体回滚**待随 seam 一起做。
  - **结论**：`design/plan.md` 说「逐条分类那 8600 条」的下一轮切片，实际是**先补两个产品缺口**
    （win32 file-trust 原语；verified-path 的命令数组/可执行注入缝，含上面的快照丢扩展名），
    再回来清测试。这两项本身够格各立一个 RFC-254 子任务（能力面 + 证据门），不是测试收尾。

  **已从清单里清掉的两个大簇（2026-08-05 同日）**：
  1. `rfc224-verified-launcher` 21 条（清单最大单点）——两层夹具根因（POSIX 字面量过
     不了 canonical 校验 + sealed-shell 键的平台事实），**两平台 21/21 绿**；同形字面量
     在其余 rfc224 文件里为零，它们的红另有根因。
  2. `review-state-machine` 15 条——A 类 `.sh` 假二进制，按 fusion 的换缝修法移植为
     `[bun, stub.ts]`，**两平台 15/15 绿**（Windows 61s）。
     **review 家族 A 类已全部清零（2026-08-06）**：10 个文件移植完成并在 Windows 上
     45/45 全绿（review-iterate ×4、reviews-iterate-mints-new-run、
     rerun-prior-output-e2e、start-task-url、task-start-working-branch、
     tasks-multipart、rfc223-pr9-cross-tenant-adversarial）。标准 v1/v2 形态收进公共
     夹具 `fixtures/versionedStubOpencode.ts`（支持 port 名、单/双版本、markdown_file
     写盘）；clarify 轮次与三端口两个特殊形态按 fusion 先例内联。两条甄别记录：
     - `rfc254-stub-differential` **无需动**——`script:` 字段只是 golden 标签，真
       spawn 的是编译产物，文件头自证 runs on Windows too。
     - ⏳ **(P2)** `rfc107-url-upload-multipart` **换缝不适用、已回滚**：它的 stub 走
       runtime registry 的 `binaryPath`（必须是单个可执行文件，`validateBinaryPath`
       会 `.trim()`）与 config.json 的 `opencodePath`，不是 `opencodeCmd` 数组。
       Windows 修法要么给测试注入编译版 stub（同 e2e 的 dist 产物，但单测套件不依赖
       build 产物是现行约定）、要么给 registry 加测试缝，属独立改动。

- **batch 08 从来不是第三个 wedge**：拆开实测是 rfc210 submodule 簇的真 I/O
  （`rfc210-new-submodule-topology` 单文件 **194s**），720s 的批 ceiling 纯粹不够，
  「无 summary=wedge」的判据把被杀当成了卡死（判据订正见 dev-gotchas 勘测坑第 5 条）。
  真 wedge 只有两个，都已根治（见上）。

## `test-command-helper` 在设了 `FORCE_COLOR` 的环境里必红（2026-08-05）

`test-command-helper.test.ts` 的 `surfaces non-zero exits with bounded stderr` 断言
子进程 stderr 是 `"failure probe exited with code 7: fixture failed"`，而当环境里有
`FORCE_COLOR`（Claude Code 会设 `FORCE_COLOR=3`）时子进程的 `console.error` 带上
ANSI，实得 `"...: [0m[31mfixture failed[0m"`。**与平台无关、与改动
无关**，`env -u FORCE_COLOR bun test …` 即绿；CI 不设该变量所以那边一直是绿的。

- ⏳ **(P2)** 正解是**别把控制字符拼进 Error message**：`helpers/testCommand.ts` 组装
  失败消息时先剥掉 ANSI（该消息会进断言、进日志、可能进报表）。改断言去容忍转义是
  下策——那等于承认错误消息里可以带控制字符。
- 归属：该文件属 `0feeb8e8`，非 RFC-254 工作，本轮只登记未代改。

## Windows e2e 腿首次出现 `color-contrast` 违规（2026-08-05，未归因）

`ci.yml` 的 Windows e2e shard 2/4 在 run `30978755780` 红，失败点
`e2e/intent-builder.spec.ts:247` 的 axe 扫描，违规 **`color-contrast` ×3**。

**没有代码可以归因**：该 run 与前一个全绿 run 之间只有三个提交，全部是文档与后端
测试夹具（`36e10aad` / `9f3d265e` / `01829d51`），**无一触及 `packages/frontend/src`**。
紧邻的前两次 CI 各 12 个 e2e 分片全绿。

**因此这是首次出现、无变更可归因、且只在 Windows 腿上**。按仓规不能以「重跑就过了」
结案，所以先如实登记：

### 已复现（第二次，2026-08-05，commit `28d32465`）

同一 spec、同一行、同一违规：`e2e/intent-builder.spec.ts:247` 的
`detailBlocking` 断言收到 `["color-contrast"]`（期望 `[]`），Windows e2e
shard 2/4（`windows-2025-vs2026` 镜像），**首跑 + retry #1 都红**。该 commit 的 diff 是
**后端测试文件与文档**，`packages/frontend/src` 与 `e2e/` 零改动——**两次都无代码可
归因，且都只在 Windows 腿上**。

**它是间歇的，但频率很高**。目前的观察窗口（2026-08-05）：

| commit       | Windows e2e shard 2/4 | 该 commit 的 diff |
| ------------ | --------------------- | ----------------- |
| （首次那次） | 红                    | 文档 + 后端夹具   |
| `28d32465`   | 红（首跑 + retry）    | 后端测试 + 文档   |
| `c2096da9`   | **绿**                | 后端测试 + 文档   |
| `d149da58`   | 红（首跑 + retry）    | 后端测试 + 文档   |

**四次里三次红，且四次的 diff 都不含 `packages/frontend/src` 与 `e2e/`。** 所以口径是
「高频间歇、无代码可归因、只在 Windows 腿」，既不能写成「必红」（`c2096da9` 绿过），
也不能当偶发忽略——它实际上在把 `main` 反复打红。第一版记录我写成「常驻红」是过头，
第二版写成「间歇」又容易被读轻，以这张表为准。

### ✅ 结案（2026-08-05）：**它根本不是平台问题，是一条真实的 WCAG AA 违规**

上面那三段推理**结论全错**，留在这里是因为错的方式很典型。按自己写的「先让它可诊断」
去做——把断言从 `expect(blocking.map(v => v.id)).toEqual([])` 换成打印节点与颜色的形态
——**本机 macOS 一跑就红**：

```
color-contrast (serious) × 1
    at .session-role-badge__label
       [fgColor=#ffffff bgColor=#16a34a contrastRatio=3.29
        expectedContrastRatio=4.5:1 fontSize=8.3pt (11px) fontWeight=bold]
      <span class="session-role-badge__label">Assistant</span>
```

白字压 `#16a34a` 是 **3.29:1**，而 11px bold 要 4.5:1（大字例外要 ≥18pt 或 ≥14pt bold，
够不着）。**与 Windows 无关、与渲染取样无关**。

**为什么看起来「只在 Windows 腿、还时红时绿」**：`Assistant` 角色徽章要等那条助手消息
渲染出来才存在，扫描时它在不在页面上是**时序**决定的；而这个 spec 落在哪个分片、哪条腿
上跑，又决定了谁会看见。三条误导性观察（只在 Windows / 无代码可归因 / 间歇）**每一条都
是真的观察，合起来推出的结论却是错的**。

**教训**：`.map(v => v.id)` 这种「读起来很干净」的断言，在失败时等于什么都没说。四次 CI
红 + 两版 backlog 记录 + 一次「平台渲染差异」的假设，全部源于**没有把证据打出来**。
现在这一层收进 `e2e/axe-blocking.ts`（`describeBlocking()`），断言语义不变（仍是空数组），
失败时给出元素、前景/背景色、实测与要求的对比度。

**修复**：`--rfc027-accent` 上坐着白字的地方有三处
（`.session-block__details-tag` / `.session-role-badge` / `.session-subagent__toggle`），
所以**每个 accent 取值都必须对白色 ≥ 4.5:1**。逐个实测后有**两个**不合格，不是一个：

| 角色                            | 原值                                    | 对比度                    | 新值      | 对比度 |
| ------------------------------- | --------------------------------------- | ------------------------- | --------- | ------ |
| assistant                       | `#16a34a`                               | **3.30** ✗                | `#15803d` | 5.02 ✓ |
| tool                            | `#ea580c`                               | **3.56** ✗                | `#c2410c` | 5.18 ✓ |
| default/user/subagent/reasoning | `#6b7280`/`#2563eb`/`#9333ea`/`#64748b` | 4.83 / 5.17 / 5.38 / 4.76 | 不变      | —      |

**`tool` 那条 axe 从来没报过**——因为要有 tool 消息渲染出来才扫得到。只修 axe 点名的
那一个，等于把同一颗雷留到下次有人打开带工具调用的会话（正是仓规里「排除一条失败前先问
它后面那条会不会顶上来」的同一形态）。判据与实测值已写进 `styles.css` 该段注释，防止
有人把颜色调回亮色。

验证：`intent-builder.spec.ts` 4/4 绿；视觉基线 40 张全绿（无一场景含角色徽章，故基线
未动）；前端 702 文件 / 5957 条全绿。

## `fake-npm.sh` 夹具仍是 A 类（RFC-254 T32，2026-08-05）

`npm` 垫片解包（`resolveNpmCommand`）已落地并在 Windows 实测通过，但
`agent-plugin-not-found.test.ts` / `plugin-closure.test.ts` 仍红 4 条——它们传的
`npmBin` 指向签入的 `packages/backend/tests/fixtures/fake-npm.sh`，那是**假二进制**
问题，不是垫片问题：解包器看到一个绝对路径的 `.sh`，既不是 `.cmd` 也不是 `.bat`，
于是原样返回，spawn 照样 EFTYPE。

**已完成（2026-08-05）**：按上述方向落地。`resolveNpmCommand` 现在识别
`.ts/.mts/.cts/.js/.mjs/.cjs` 入口并交给当前运行时（`[runtimePath, entry]`）——这不是
Windows 特例，把 `npmBin` 指向脚本入口在生产上同样合法（npm 自己的入口就是一个），
而直接执行它正是「不经 shell」这条性质的来源。夹具已从 `fake-npm.sh` 移植为
`fake-npm.ts`（含 6 种模式、诱饵包、lock 生成与 host package.json 改写，行为逐条对齐；
`${SPEC%@*}` 的「从最后一个 @ 截断、无 @ 则原样」语义也照搬，包括 scoped 无版本时
得到空名这一分支）。

移植后它**还多了一层保障**：这个夹具此前从不参与类型检查，现在随套件一起检查。

一个细节值得记：`plugins-http.test.ts` 走的是 **PATH 注入**（把夹具复制成
`<tmp>/npm` 再 chmod），靠 shebang 执行，所以 `.ts` 文件必须保留
`#!/usr/bin/env bun` 首行——否则 POSIX 上那条路径直接执行失败。

实测：macOS 全部消费方 75 pass / 0 fail；Windows `agent-plugin-not-found` +
`plugin-closure` 13 pass / 0 fail（此前 4 红）。

- ⏳ **(P2) 遗留**：`plugins-http.test.ts` 的 PATH 注入在 Windows 上仍不可行——PATH
  查找要靠 PATHEXT，一个无扩展名的 `npm` 文件在那里找不到。该文件目前未在 Windows
  验证；接后端矩阵腿前需要单独处理（把注入的文件名改成带扩展名并让 `which` 能命中）。

### `services/pluginInstaller.test.ts` 在 Windows 上还有 4 条红（2026-08-05 顺带测到，**含一条生产缺陷**）

顺手在 Windows 上跑插件这一簇时测到（`rfc254-npm-shim-unwrap` 6/6 绿、
`agent-plugin-not-found` + `plugin-closure` 绿，红的都在 `services/pluginInstaller.test.ts`）。
四条与 `resolveNpmCommand` 无关——这些用例都显式传 `npmBin: FAKE_NPM`，根本不走
`which`：

- ⏳ **(P1，生产)** `installFilePlugin` 解 `file:` spec 用的是
  `new URL(spec).pathname`（`services/pluginInstaller.ts:295`），**在 Windows 上得不到
  可用路径**：`file:///C:/x/y` 的 `pathname` 是 `/C:/x/y`，`realpath` 必失败，于是
  合法的 `file:` 插件安装在 Windows 上一律报 `plugin-file-not-found`。正解是
  `fileURLToPath`（`node:url`）——它在 POSIX 上与现状等价，且顺带修掉 `pathname`
  不解百分号编码（`file:///a%20b` 现在会被当成字面量）这个两平台都有的问题。
  测试夹具那侧同时要改：它拼的是 `file://` + 绝对路径，只有 POSIX 的绝对路径以 `/`
  开头才凑巧变成合法的 `file:///…`。
- ⏳ **(P2，测试)** 两条断言写死了 `/` 分隔符
  （`expect(result.cachedPath).toContain('node_modules/opencode-toolkit')`、
  `'node_modules/@scope/pkg'`），Windows 上实际是 `\`。用 `join()` 拼期望值。
- ⏳ **(P2，夹具)** `git source kind goes through same npm path` 传 `github:org/repo`，
  `fake-npm.ts` 照搬 `${SPEC%@*}` 后去 `mkdir node_modules/github:org` —— `:` 在
  Windows 文件名里非法，报 `ENOTDIR`。夹具需要把 spec 里的非法字符归一后再落盘。

## Windows e2e shard 4/4 两条超时红（2026-08-05，commit `5c8dabe6`，未归因于代码）

CI run `31012398133`（本 commit 为纯前端「结构变更」页签视图修复 + 测试 + 文档,
不触及工作流执行/编辑器挂载路径）唯一红腿 = Playwright e2e windows shard 4/4,
其余全部 job（三 OS 前后端矩阵、其余 e2e shard、visual-regression）全绿：

- `workflow-matrix.spec.ts:661` output kinds round-trip：`kind_producer` 节点
  `node-timeout: exceeded 2000ms`（首跑任务 failed；retry 因同名 node_run 已有
  2 行直接断言失败——retry 语义对「上一轮已超时重试过」的现场不幂等）。该 spec
  在 RFC-254 曾因路径分隔符红过（`c345d948` 已修），本次是**新根因**：fixture 里
  2000ms 的节点预算贴着 Windows 共享 runner 的噪音线。与 T32「时间预算」同族,
  但在 e2e YAML fixture 层而非 bun 5s 默认层。
- `workflow-editor.spec.ts:218` editor mounts：`.workflow-canvas` 15s 不可见 +
  60s test timeout,**retry #1 26.6s 通过**——慢机首跑超时型。

两条的 owning surface（工作流执行语义 / 编辑器挂载）与 `5c8dabe6` 的 diff 零重叠,
按归属纪律未代改。处置建议归 RFC-254 Windows e2e 预算治理：output-kinds fixture 的
per-node timeout 需要按 Windows 腿放宽（或 fixture 声明平台预算）,并查 retry 路径
对「超时已产生重试行」现场的幂等性。

### 次日内第二次复现(同日,`37838d53`,纯文档 diff)

`37838d53`(+20 行 markdown,零代码)CI 唯一红 = **Windows** frontend shard 1/3,
两条既有 vitest 用例 5s 超时:`clarify-detail-route.test.tsx:222` 与
`skills-split-page.test.tsx:421`。纯文档 diff 也能把 Windows 腿打红,坐实该腿的
间歇超时是**环境性**(bun/vitest 默认 5s 预算贴共享 runner 噪音线),与上一条
e2e shard 的超时同族。均归 RFC-254 T32 预算治理域;两个文件此前不在其"贴上限
候选"名单里,治理时按同一负载法补测。

### 第三次复现(2026-08-06,superseding run 31026903962,commit 48dd201a)

六红中四条仍是本谱系:Windows frontend shard 1/3+3/3 三条既有 vitest 超时
(unsaved-guard/detail-header-actions/reviews-list-expand)、Windows e2e
crash-recovery、macOS RFC-227 Seatbelt 真实沙箱 5015ms 贴 5s 预算。另两条
owning=a231432c(RFC-258):⑥ 权重测试 240 万 occurrence fixture 自伤超预算
(已改注入式小预算)、T15 指纹随实现门代码修复漂移(已按新指纹重登记)——
两条同 commit 已修。

第四次观察(同日,run 31029066635,3d61d686):RFC-258 收口两修复零红确认
生效;仅余三条本谱系超时(Windows skills-split-page 复现/Windows
markdown-diff-table-word 新成员/macOS unsaved-guard——上轮在 Windows 腿,
证明是共享 runner 负载家族而非单 OS)。RFC-258 归属面 CI 判定闭合。

第五次复现(同日,superseding run 31070173953,a325ff1c):Windows e2e shard 1/4
`crash-recovery.spec.ts:263` `pollUntilTerminal` 30s 未达 done——第三次复现同
场景再现,家族成员重复出现,维持 RFC-254 T32 预算治理域归属。同 run 的
theme-css-ratchet 三 OS 红 owning=9269c5ee(结构变更 UI 三连修复:dock hover
误引未定义 `--fg`),已以 `var(--text)`/`var(--border-strong)` 修复另行提交。

## Webhook 权限面（RFC-260 评审门 F-9 登记，2026-08-06）

- **`webhook-triggers:{create,update,delete}` 是 grantable-but-unrenderable 的令牌授权**（RFC-257 引入、RFC-260 评审门发现）：三点是矩阵域点、触发器写路由 `tokenAccess:'allow'`，`grantableMatrixPoints(admin)` 含它们（API 422 校验以此为界），但 `'webhook-triggers'` 不在 `MATRIX_RESOURCES` ⇒ 账户页 token 矩阵永远不渲染该行——admin 经 API 可以发出能改/删触发器的 PAT，而 UI 无法呈现或复核该授权（`permission.ts` 文件头自己警告的「authorization UI lying」镜像形态）。候选修法：把 `webhook-triggers` 纳入 `MATRIX_RESOURCES`（矩阵多一行），或把三条写路由改 `tokenAccess:'never'`（触发器写完全退出令牌面，与 fire 以 owner 身份执行的 D19 模型更一致）。需要产品拍板，未在 RFC-260 内处理（其范围是读面）。

## ✅ RESOLVED（2026-08-06，`2081a8ed`）RFC-254 T40b win32 隐私原语：x64 GitHub runner 与真机行为分叉

> **根因**：GitHub `windows-latest` 以**内建 Administrator（RID-500）**跑，封根后子文件 DACL 正确
> （SY+BA+LA、无宽 ACE、文件确私有），但属主 ACE 在 SDDL 里序列化为**别名 `LA`** 而非完整 SID，
> 被 `verifyDaclPrivate` 白名单 {完整 userSID, SY, BA} 误判为非白名单 ⇒ not-private。**修复**：
> `LA`（内建 Administrator）/`DA`（Domain Admins）是 TCB ⇒ 纳入白名单；RID-500 进程以 `LA` 满足
> userGranted。`windows-platform.yml` 重新启用 live-icacls 隐私簇步、x64 转绿；纯核 3 例新测锁定。
> 以下为原始登记（存证）：

- **现象**：T40b 的 live-icacls 验证隐私簇（`rfc254-win32-acl-integration` + `rfc224-store-hygiene`
  / `verified-launcher` / `opencode-store-recovery` / `direct-control-protocol` / `verified-system-plan`）
  在**真 Windows 11 ARM64 机**上全绿（110 tests / 0 fail，见 design-T40b §0），但在 **GitHub
  `windows-latest`（x64）runner** 上大片 `execution-identity-store-unsafe` / `not-private` /
  `unsafe-ack-file`——即 `sealDirectoryOwnerOnly`（`icacls /inheritance:r /grant *SID:(OI)(CI)F`）
  在该 runner 上**没有产出预期的 owner+TCB DACL**，隐私复核据此判非私有。
- **影响**：`windows-platform.yml` 曾加过一步跑这些簇、随即在 x64 变红；**已回退为只跑纯解析
  `rfc254-win32-acl`**（不依赖 live icacls，任何 runner 安全）。已加**非门禁 evidence 步**
  「icacls seal behaviour on this runner」dump runner 上 whoami SID + seal 前后 SDDL + 子文件
  SDDL，供下次 run 免 SSH 诊断分叉根因。
- **待查根因候选**：①GitHub runner 的 `%TEMP%`/工作卷 ACL 模型（可能 ReFS/网络卷或含无法被
  `/inheritance:r` 清除的 ACE）；②runner 以特殊服务账户跑、`whoami /user` SID 或 `/grant:r *SID`
  语法在其上不生效；③icacls 版本/行为差异。**在拿到 evidence 步输出前不下结论**。
- **诚实边界修正**：先前提交把 T40b 记为「端到端验收通过」——**准确表述是「在用户的 ARM64 验收机
  上端到端验收通过」**；x64（尤其 GitHub runner）行为未过、real-x64 机未测。T40b 的隐私证明对
  用户目标机成立，但**不主张跨 x64 通用**，直到上面根因查清。

## `changes-grouped-sidebar` 的 win32 视觉基线待刷（2026-08-06 登记）

- **背景**:结构变更代码视图三项 UI 变更(默认全文渲染态 / hunk 正文精确标线 / 大纲栏收起
  为细轨 dock,commit `9269c5ee`)使 `rfc250-visual-states.spec.ts` 的 "Changes grouped
  sidebar" 场景基线过期;spec 已改为截图前显式切「改动」视图(场景主题是分组侧栏,且
  fixture 未 seed 真实 worktree 文件,全文视图会渲染 file-not-exist 占位)。
- **已刷**:darwin(本地,先 `build:binary:e2e` 后 rm+重生成,复跑绿);linux(按仓规走
  CI artifact 铸造周期——删旧基线推送,取失败 run artifact 的 actual 回填)。
- **⏳ 待刷**:`changes-grouped-sidebar-chromium-win32.png` 仍是旧 UI(RFC-254 T32/T33 期
  在 Windows VM 上生成的 44 张之一)。win32 视觉腿不在 CI 门禁里,不阻塞;下次在
  Windows VM(`reference_windows_vm`)跑 RFC-254 视觉验收时随手重生成该场景即可。

## ✅ RESOLVED（2026-08-07，同批）任务快照曾向 PAT 泄漏 script env 明文（RFC-253 T28）

- 原形态：T28 收口了 workflow 资源自身的 7 个读面，但**任务行携带的 `workflowSnapshot`**
  （`schemas/task.ts` · 冻结的完整 definition，且在源工作流被改/被删后依然作答）不在其中；
  `GET /api/tasks/:id` 为 `tokenAccess:'allow'` ⇒ 空矩阵 PAT 可直接读出 script env 明文。
  原判为独立切片，**两路实现门（独立子代理 + Codex）各自判 high/blocking** 后本批一并收口。
- 收口：`serializeTaskFor<T extends Task>`（`services/tokenRedaction.ts`）+ `routes/tasks.ts`
  七个 Task 出口（get / create×2 / cancel / resume / retry / sync），MCP `get_task`/`watch_task`
  经同一路由表继承。**约束选型让编译器筛集合**：`RepairOptionsResponse`/`RepairResponse`
  两处不含定义，被 `T extends Task` 在 typecheck 阶段挡出，确认无需投影。
- TaskSummary（列表/WS 帧）**不含** workflowSnapshot，已核实无此面。
- 锁：`rfc247-token-redaction.test.ts`（PAT 掩 / session 同引用 / 出口计数），摘掉任一出口即红
  （已变异实证）。
- ⏳ **RFC-254 win32 UX（低优先）：非 native `AGENT_WORKFLOW_HOME` 在 Windows 导致 daemon 以不透明 `execution-identity-store-unsafe` 拒启**。`opencodeStoreRecovery.ts:70-76 storeRoots` 的 `resolve(appHome)!==appHome` 规范性检查对正斜杠 / git-bash 形 home（`/c/...`、`C:/...`）判 unsafe（win32 `resolve` 归一到反斜杠）。生产默认 home 出自 `homedir()`（native 反斜杠）故免疫；但用户在 Windows 显式设正斜杠 `AGENT_WORKFLOW_HOME`（git-bash/WSL 习惯）会撞上，且错误码不提示「home 路径形态不对」。修法：boot 早期对 `AGENT_WORKFLOW_HOME` 做 native 规范化（`path.resolve`）或给出明确错误文案（「AGENT_WORKFLOW_HOME must be a native absolute path」）。真机确证（续三十二）。

## RFC-254 verified 路径对 opencode 1.18.13 的「冻结校验漂移」（2026-08-07 真机 glm-5.2 挖出；bug#7 已修，bug#8+ 待修）

用 `runNode`（无 opencodeCmd = 生产 verified 路径）在真机 VM 跑完整业务节点（opencode 1.18.13 + alibaba-cn/glm-5.2）挖出：verifiedLauncher 的多处**冻结信任边界校验**是对着旧 opencode 冻结的，1.18.13 已漂移。**非 win32 特有——所有平台受影响**（此前未撞因 CI LIVE 走 `opencode run`、preflight 有 python 锚且可能用旧 opencode）。

- ✅ **bug#7 已修（`7b3a0c27`）**：`verifiedLauncher.ts:monitorServerStdout` 要求 serve 首行即 listen 行；1.18.13 先打 `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` ⇒ 每次 `execution-identity-bootstrap-failed`。修：容忍 listen 前有界 preamble（`MAX_SERVER_PREAMBLE_LINES=16`；post-listen 仍严格；port 仍只取精确 listen）。qualification 22/0。**附带安全 backlog**：warning 提示 verified serve 无 server password（loopback 无鉴权，本机他进程若知端口可打 verified API）——RFC-224 现靠 loopback+control nonce，是否加 `OPENCODE_SERVER_PASSWORD` 纵深加固（directClient 随请求发）待评估。
- ⏳ **bug#8（待修，已特征化）**：越过 bootstrap 后 `execution-identity-mismatch`。逐层比对 opencode 1.18.13 真形状：`/config/providers` exactKeys **匹配**、`/skill` 形状匹配（`customize-opencode`，内容 digest 须在 `PINNED_BUILTIN_SKILL.contentDigests` 白名单——1.18.13 若改写正文须人工 review 加白）、`verifyManifestDigests`（spawn 前）已过。通用 mismatch 落 **spawn 后层**：`buildVerifiedInventorySnapshot`（`verifiedInventory.ts` 对 `/agent` exactKeys/model 校验；1.18.13 agent 键=name,description,mode,native,permission,options）或 config/session digest。**下一步**：child-stderr 插桩（launcher child console.error 经 drain 未捕获）定位确切校验 → 谨慎更新冻结校验（勿弱化信任边界）→ 测试 → 重跑 rfc224 qualification。**bug#7 已示范做法**。属敏感核心，须清醒专门回合。
- **净**：real execution 组件/传输侧在 Windows 全绿（真 opencode+glm-5.2、codec、direct-API session、daemon+API、plan 构建）；full verified 端到端卡在这条 opencode-1.18.13 兼容性 pass。
- ⏳ **bug#9（待修，同 killGroup 类 win32 缺陷）**：`verifiedLauncher.ts:defaultSpawnServer`(217-249) 对 opencode serve 子进程用**无条件 POSIX 进程组操作**——`detached:true`(230) + `killGroup`=`process.kill(-child.pid,signal)`(237-239) + `isGroupAlive`=`process.kill(-child.pid,0)`(247-249)。Windows 无进程组，`kill(-pid)` 抛错/no-op ⇒ `isGroupAlive()` 恒返 false（error.code≠'EPERM'）、`killGroup` 走不通。与我已修的 `systemAgentRun.ts` killGroup 缺陷同类，修法一致：win32 走 `util/process.ts` 的 `killProcessTree`/`isOwnedTreeAlive`（POSIX 保 `kill(-pid)`）。**属敏感核心**（RFC-224 kill/containment 语义载体，line 962/970/980 cleanup/settlement 依赖它），须谨慎（勿破 POSIX 进程组语义）+ 重跑 qualification。这是本次真机 runNode 跑完整 verified 节点连撞的第三处（bug#7 preamble 已修 / bug#9 进程组 / bug#8 inventory-digest 漂移），共同构成 verifiedLauncher 的 **win32 + opencode-1.18.13 兼容性 pass**（多处敏感冻结校验/进程管理对旧 opencode+POSIX 冻结，须一次专门清醒回合逐处抓真形状+真机验证）。

## `snapshotHash` 是明文定义的哈希，与掩码后的 definition 同批下发给 PAT（RFC-253 T28 实现门发现，2026-08-07 登记）

- **形态**：`workflowToDetail`（`services/workflow.ts:875-881`）按**明文** definition 算
  `snapshotHash = sha256(serializeWorkflowEditableSnapshotV1(snapshot))`；T28 的
  `serializeWorkflowFor` 掩掉 `definition.nodes[].env` 的值后，其余字段原样 spread ⇒
  PAT 同时拿到 `env:{DB_PASSWORD:'***'}` **和真值的哈希**，构成离线字典/暴力恢复的 oracle
  （低熵密钥尤甚）。评审实跑：单 script 节点 `env:{DB_PASSWORD:'hunter2'}`，5 词字典第 4 个
  候选命中。同字段还出现在 exact-revision 冲突详情与 `workflow-import-conflict` 的 details 里。
- **是 T28 的副作用而非既有问题**：掩码之前响应本就含明文，哈希不额外泄漏；掩了值却留哈希才
  使其成为 oracle。MCP 记录无此伴生字段，故属 workflow 特有。
- **为何未在本批处理（需协议层决策）**：`snapshotHash` 是 exact-revision 乐观并发协议的一部分
  （export / validate / PUT 都要求 `expectedSnapshotHash` 匹配）。若对 PAT 通道改发「掩码后
  定义的哈希」，PAT 对含 script env 的工作流将无法完成任何 exact 操作（export / validate 直接
  mismatch）——这是能力收缩，按 CLAUDE.md §能力收缩型 RFC 附加门槛须呈用户确认；若干脆不发
  哈希，则破坏同一协议。候选修法：①PAT 通道发掩码定义的哈希并同步放宽这类工作流的 exact 校验；
  ②保持现状并接受（论据：PAT 无法改 script 工作流，`scripts:author` 永不进令牌面）；
  ③让 `snapshotHash` 本身对 script env 值取「归一化占位」参与哈希（改变哈希语义，影响存量比对）。

## 全能力实机验收（2026-08-10，本机 opencode + zhipuai/glm-5.2）遗留的四项设计级未决

一轮「意图创建 → 全节点执行 → 依赖注入探针」的真机验收（12/13 种节点跑通，
`code-host-call` 的接线 P0 已在同批修复）暴露出四条**不适合直接改代码**的问题，
逐条给出形态、证据与候选修法，留待专门回合定夺。

### A. 依赖不在围栏内的 local MCP **静默不启动**，任务照样 done

- **形态**：`verifiedPlan.ts:planMcpConfig` 会把 local MCP 正常编进 `OPENCODE_CONFIG_CONTENT`
  （实测 `mcpCount=3`），但 `materializeMcpWrappers` 给子进程的 `bindReadOnly` 只有
  「frozen skill 路径 + 管理员 `businessToolchainPaths` + 启动器 inode + 解释器链」，
  而 macOS profile（`sealedSubprocess.ts:renderNetlessSeatbeltProfile`）把 `realHome`、
  `appHome`、各 tmp 全部 `(deny file-read* file-write*)`。⇒ MCP 脚本自身或它的
  `node_modules` 只要不在 allow-back 集合里就读不到，服务器起不来。
- **真正的问题不是围栏，是无声**：opencode 把起不来的 server 记为 failed 后继续跑，平台侧
  **零反馈**——无 lifecycle 告警、无 node_run 事件、无日志行，agent 只是悄悄少了工具，任务
  以 `done` 收场。用户唯一能察觉的方式是模型自己说「这个工具不在清单里」。
- **A/B 实证**：同目录同解释器（`bun <abs>.ts`），零依赖版 `aw-probe-localraw` 的工具出现在
  运行时清单里；`import '@modelcontextprotocol/sdk/...'` 的 `aw-probe-local` 不出现。把该目录
  加进 `businessToolchainPaths` 后前者可用，后者仍不可用（SDK 在仓内 `node_modules`，仍在 mask 下）。
- **候选修法**：①启动后按选中的 MCP 闭包核对实际可用工具面，缺失即告警/失败（RFC-251 曾显式
  移除 `/mcp/status` 查询，需重新论证）；②wrapper 侧捕获子进程非零退出并落一条 node_run 事件；
  ③把 MCP 命令的**参数路径**也纳入 `bindReadOnly`（只解决自身脚本，解决不了传递依赖）。
  ①③ 都触及 RFC-224/227 的密封边界，按能力型 RFC 走。

### B. managed skill 的**辅助文件运行期不可达**

- **形态**：只有 `SKILL.md` 正文以 `<aw-frozen-skill>` 注入；整棵树密封在
  `<runRoot>/opencode-identity-seal/skills/<sha24>` 并对 bash 子进程只读可见，**但没有任何
  env / 提示词行告诉 agent 这个路径**，而 `~/.agent-workflow` 又在 mask 下。
- **证据**：探针技能的 `SKILL.md` 标记行两次都取回；同一技能 `reference.md` 里的标记行两次都
  `MISSING`，agent 自己 find/grep 也搜不到。
- `docs/skill.md` 已在同批改正（它此前描述的是 RFC-224 之前的行为，会误导用户去建多文件技能）。
- **候选修法**：①在 frozen block 里追加一行「本技能的只读根路径 = …」+ 文件清单；②把辅助文件
  正文一并注入（有上下文预算风险）；③显式不支持，创建期就拒绝多文件技能（能力收缩，须逐项确认）。

### C. 意图构建器单轮产能上限 ≈ 6–8 节点，且失败轮**没有「为什么」**

> ✅ **2026-08-12 对账回填：候选修法①②③已由 RFC-273（Done 2026-08-10）逐条落地**——失败轮持久化 assistant 文本/最后消息类型/截断证据（`services/intent/turnEngine.ts`）、协议失败 scratch 默认保留 24h 由 GC 回收、INTENT.md 从共享常量生成分批指引。单轮产能上限本身是模型能力边界非缺陷。

- **形态**：要求一次产出覆盖 13 种节点的主工作流，连续 3 轮 `intent-envelope-missing`
  （415 / 465 / 459 秒，`exitCode: 0`，会话树里连一条 assistant 文本都没有）；退到 9 种节点
  仍撞 600 秒 `intent-run-timeout`。拆成「6 节点工作流」+「资源分批建」后稳定成功。
- **诊断面**：`intent_turns.content_json` 只有 `{"code":"intent-envelope-missing"}`；
  `stderrTail` 仅在非空时落库（这里 stderr 为空），`scratch_retained=0` 工作目录已删。UI 侧
  有「重试本轮」与完整事件树，但没有任何东西指向真实原因（输出超限 / 模型没收尾）。
- **候选修法**：①失败轮记录「本轮是否产生过 assistant 文本 / 最后一条消息类型」，把
  「读完 inventory 就停了」与「吐到一半被截断」分开；②`intent-envelope-missing` 时默认保留
  scratch 目录若干小时；③在 INTENT.md 里给出「单轮 op / 字节预算」的硬提示并鼓励分批提交。

### D. 工作组「零 delta」告警对**讨论型**工作组必然误报，且是硬编码英文

> ✅ **2026-08-12 对账回填：两条候选修法均已由 RFC-274（Done 2026-08-10）落地**——workgroup 全链携带 `files | discussion` 产出契约（discussion 不再探测/告警 zero-delta），平台房间消息改为 closed template + typed params 按查看者 locale 渲染（`services/workgroup/systemMessages.ts`）。

- `leaderWorker.ts:warnIfZeroDeltaDone` 只要有 assignment 完成且 canonical worktree 无变更
  就发告警。评审 / 讨论型工作组从不写文件 ⇒ 每次都报。
- 该消息（连同 `freeCollab.ts` / `engine.ts` 里的同类系统消息）**全部硬编码英文**，在 zh-CN
  界面里突兀。后端目前没有房间系统消息的 i18n 层，单独翻译一条会造成不一致。
- **候选修法**：①按工作组是否声明「产出为文件」决定是否检测（需要新的配置维度）；②把房间系统
  消息统一收进一张可翻译的消息表（跨 RFC 的基础设施改动）。

### E. 本机 DB 与迁移漂移，且启动期无漂移检测

> ✅ **2026-08-12 对账回填：候选修法已由 RFC-275（Done 2026-08-10）落地**——boot 在业务服务前核对完整 migration receipt hash/order/prefix 与物理 schema，漂移点名并拒绝启动（`db/schemaAdmission.ts`）。下文 F 条自述「E 修好后新暴露」即其生效证据。

- `mcp_runtime_test_turns` 缺 `raw_command_digest` 列（迁移 0125 里有；空库 `migrate` 后有），
  于是 RFC-238 的 MCP 运行时试跑在这台机器上 500（`SQLiteError: table … has no column named …`）。
  成因是 daemon 曾在该迁移文件仍在编辑中的工作树上启动过，drizzle 按序号记为已应用。
- 平台**启动期不做 schema 漂移检测**，漂移只会在功能被用到时炸成 500。
- **候选修法**：boot 时把 `__drizzle_migrations` 与实际表结构做一次轻量比对（或至少对每张表的
  列集合算指纹），不一致就明确报「DB 与迁移不一致，请恢复备份或重建」。

### F. RFC-238 的 MCP 运行时试跑在本机 `execution-identity-mismatch`（E 修好后新暴露）

把 E 的漂移列补回去之后，`POST /api/mcps/:id/runtime-test-sessions` 不再 500，但第一轮
即 `failed` / `execution-identity-mismatch`（stderr 仅 `AW_OPENCODE_FAILURE
execution-identity-mismatch`），会话以 `endReason: session-unusable` +
`continuationBlockedReason: session-store-missing` 收场。本机 opencode 1.18.14。

**关键对照**：同一台机器、同一个 opencode、同一个 runtime，**普通业务节点的 verified 路径
全绿**（本轮跑了 6 个任务、含 fanout 分片与子任务，全部 done）。所以这不是 RFC-224 冻结
校验对 1.18.x 的整体漂移，而是**系统 agent 链路（一次性私有 store）特有**的一处。与
audit-backlog 里已登记的 bug#8（Windows VM + 1.18.13，业务节点侧）形态相似但不是同一处，
排查时别把两者混为一谈。下一步同 bug#8：给 launcher child 的 stderr 插桩，定位到底是哪一层
校验（inventory / config digest / session digest）不匹配。

- ⏳ **RFC-284 T29 路 2 两条 latent 备忘（实证不可达，登记防前提漂移）**：①反查泛型的
  LIKE `%"<id>"%` 预过滤在「id 含 JSON 转义/非 ULID 字符」时理论上可漏检（matcher
  永不误报、只可能漏）——当前四域引用 id 恒为 `ulid()` 铸造（无用户可控非 ULID 入口），
  不可达；若未来任何引用域改用自由字符串 id，须同步复核 `resourceRefs.ts` 预过滤。
  ②`isOwnerNameUniqueViolation` 相对 skill.ts 旧正则少匹配 `skills.owner_user_id`
  单列形态——该形态无对应唯一索引（0118 是 COALESCE 表达式索引），死分支差异。

- ✅ **任务基线与仓库准备（2026-08-13 用户逐条拍板；用户裁定**并入 RFC-287 落地**，
  见其 §2 G5/G6/G7 与 design §9。本条保留为背景与实测锚，处置面以 287 为准）**：现状核实——路径模式已随 RFC-165 D3 全链路
  退役，本地仓走 `file://`；URL 模式启动时 `fetch --all --prune --tags` + 把基线分支快进到
  `origin/<branch>`（`gitRepoCache.ts:250` `syncBranchToRemote`，用 `update-ref` 不 checkout），
  **所以真实远端源的任务基线确实恒为远端最新**。两处缺口 + 一处结构事实：①`file://` 源的
  「远端」就是用户本机仓，其相对真正上游可能陈旧；②非 `file://` 源 **fetch 失败时只记
  warning 并继续用陈旧镜像**（`gitRepoCache.ts:501-518`；`file://` 源反而是硬失败）；
  ③**仓库物化发生在任务行落库之前**（task.ts:1402/1751 物化 vs :2255 insert），故启动失败
  不留任何任务记录，且启动 API 同步阻塞到工作树就绪。
  **用户拍板**：(a) `file://` **不对用户开放**（公开面拒绝；平台内部与测试通道保留——118 个
  测试/e2e 文件依赖它造仓）；(b) 基线同步失败 = **硬失败**，不再静默降级用陈旧镜像，但
  **先自己重试**；(c) 重试按**总容忍窗口**而非固定次数，默认 **60s 可配**（用户原话「1 分钟
  可能都不够」，指容忍窗口；一次正在推进的克隆不被打断，窗口只约束失败后还愿再试多久）；
  (d) 仅网络类失败重试，鉴权/仓库不存在/无权限/分支不存在立刻失败；(e) **仓库准备异步化**：
  任务行先落 `pending`、准备在后台，失败转 `failed` 且原因可见；同步段只留「填错了立刻告诉
  你」的校验（参数/权限/资源可用性/地址格式）；(f) **不新增任务状态**，复用 `pending`；
  (g) 定时任务与 webhook 触发**同一套语义**；(h) 重试语义 = **状态机语义**：重试作用于任务
  当前所处阶段，处在「准备仓库」就重试准备仓库。
  **落 RFC 时必须带能力影响清单逐项呈批**（三条收缩：本机仓直接跑任务的入口消失、网络抖动
  不再降级放行、启动 API 不再同步保证工作树就绪），并逐处复核被打破的不变量「有任务行就有
  工作树」——`worktreePath` 在 backend 有 519 个引用文件，GC 已有 `worktreePath === ''` 分支
  可作先例；另需定存量已注册 `file://` 仓与其定时任务的处置（继续可用 vs 全禁 + 迁移提示）。

- **runner stdout pump 里剩余两处「对同一行二次解析」未收进事件流**（RFC-297 D11 划出的边界，
  2026-08-13 登记）：`parseTerminalResultError`（`runtime/types.ts` 的可选方法，runner 与
  systemAgentRun 各调一次）与 `observeSystemEvent`（系统 agent 取证）。RFC-297 已把清单观测
  收进「driver 只做规范化 → 运行时无关 stage 消费」的事件流（`services/execution/eventPipeline.ts`），
  这两处按同一方向收编是自然的下一步：各自变成一个事件 kind + 一个 stage，pump 从此只解析一次。
  **本 RFC 刻意不动它们**——它们牵动节点成败判定（claude 清 exit 0 但 `result.is_error` 要判
  失败）与 RFC-237 的取证契约，混进来会让「清单看不见」这个用户可见问题的修复被无关风险拖住。
  接手前先确认 runner.ts 的并发改动已落停（RFC-297 落地期间该文件是另一位协作者的活跃战场）。

## RFC-287 G7 —— 未成功克隆的仓库身份行缺回收（B-F8，用户已拍板方向）

`ensureCachedRepoIdentity` 在克隆**之前**先登记 `cached_repos` 身份行（AC-11 的
重试要靠它找回来源），以 `last_fetched_at = 0` 标记「尚未取回内容」。若该 URL 永远
克隆不成功且用户放弃重试，这条空行没有任何回收机制——连续用不同的错误 URL 启动会
无限积累。每条只占一行 DB、不占磁盘，但会进 `/repos` 列表与 overview 计数。

**用户已拍板**：随任务终态回收（不做定时 GC、不做「只能手动删」）。

**落点更正（实测逼出）**：不能放在「准备失败」那一刻——准备失败只是任务进
`failed`，它随时可能被 AC-11 的「重试准备」拉起，而重试正是要靠
`tasks.cached_repo_id` 重建来源；在那里删会让重试撞 `cached-repo-not-found`
（实测 4 条用例连锁红）。正确时机是**任务真正离场**：`taskDelete` 与工作区 GC 的
既有清扫路径。

判据必须同时满足两条，缺一不可：
· `last_fetched_at === 0` —— 只删从未成功过的行；曾克隆成功的镜像（哪怕目录后来
失效）是别人的缓存，删掉等于替用户做主；
· 无其他引用 —— 复用 `refTaskCount` 那道守卫（RFC-287 T14 已给它补上
`tasks.cached_repo_id` 一面，此前只数 `task_repos`）。

## `e2e-webkit-nightly` 长期间歇红（2026-08-14 登记，非任何单条改动引入）

**现象**：cron（`schedule`，非 push）触发的 webkit e2e nightly 长期间歇失败，且**每次红在
不同的 spec、不同的分片**：

| 日期                  | 结论    | 失败用例                                                                        |
| --------------------- | ------- | ------------------------------------------------------------------------------- |
| 08-19                 | failure | `rfc244-task-operations.spec.ts:162/:267`（click 超时）+ `rfc294-…:491`（exitCode），shard 2/4 |
| 08-18                 | success | —                                                                               |
| 08-17（两次）         | failure | `rfc250-*` / `rfc304-*` 四条 / **`rfc294-…:491`**，分片各不相同                 |
| 08-14                 | failure | `intent-builder.spec.ts:126` RFC-293 workbench（shard 1/4 + 2/4）               |
| 08-13                 | failure | `rfc295-runtime-parameter-picker.spec.ts:132` Webhook Agent picker（1/4 + 3/4） |
| 08-12                 | success | —                                                                               |
| 08-11 / 08-10         | failure | 分片各不相同                                                                    |
| 08-09 / 08-08 / 08-07 | success | —                                                                               |

**归属核实**：它出现在某个 commit 上只是因为定时跑取到了当时的 main HEAD，与谁推了什么
无关（`event=schedule`）。08-13 与 08-14 的失败用例毫无交集，排除「某条改动引入」。

**典型形态**：Playwright 的 `locator.click` 超时，call log 停在 `waiting for …` 且从未
`locator resolved`（元素压根没出现），或 resolved 之后 `element was detached from the DOM`
（重渲染竞态）。chromium 上同一批用例稳定绿——webkit 的渲染/事件时序更慢，本地几乎复现
不了（本地机器快，重渲染在点击之前就结束）。

**处置建议**（未做，需要专门一轮）：不要逐条加 timeout——那只是把偶发变稀。按
`docs/dev-gotchas.md` 里那条「CI-only 的 e2e 竞态多半是重渲染把元素从 DOM 摘下来」的判据，
逐个找出「点击前会触发列表/面板重渲染」的动作并补真同步点。RFC-287 T14 已按此法修过
`intent-builder.spec.ts:171` 的 chromium 侧（`2a286abc`），但 webkit 侧那次仍红且形态不同
（按钮从未出现，不是 detach），说明该 spec 至少还有第二个竞态未解。

**不属于任何进行中 RFC 的连带面**，不应计入其收官判据。

**2026-08-19 补一条反面教训（本条目正是为防它而立，我还是踩了）**：当晚红的三条里，
`rfc244-task-operations.spec.ts` 两条恰好落在**刚被虚拟化改写的任务列表**上
（`99faae98` VirtualList + `/tasks` 窗口化，2026-08-18 落地），断言面又正是 `aria-setsize`
与分页点击——看上去"指向明确"。但同一晚的第三条 `rfc294-…:491` **在 08-17 就红过**，
那时虚拟化还没落地；而 08-17 两次红的 spec 集合与 08-19 毫无交集。
**判据**：`event=schedule` 的 nightly 红，单晚的 spec 集合**不构成归因**——必须先与本表
历史比对、确认该 spec 是否在相关改动之前就红过，再谈"某条改动引入"。
按 commit 相邻性下结论，会把人派去查一段没问题的代码。

## `rfc098-commitpush-nonblocking` B1 用例 CI 间歇红（2026-08-14 登记；**未复现、根因未定、非 flaky-waiver**）

**现象**：`packages/backend/tests/rfc098-commitpush-nonblocking.test.ts` 的
`RFC-098 B1 … ready downstream node is dispatched WHILE the slow commit session runs`
在 CI **ubuntu shard 2/4** 单条红（run 31790944695，SHA `5337870e`）。macOS 同批绿。

**归属核实**：`5337870e` 与其父 `6e8c4f9f` 都是**纯 markdown**（RFC-288 文档），其父
`d482942f` 的 CI 是**绿**的 ⇒ 区间内无任何代码改动，排除「某条改动引入」。该文件最近一次
改动是 RFC-282 收尾 `17b9215b`，与当时进行中的工作无关。

**失败点是哪一条断言（重要）**：**不是**它的排序 oracle。`n2Start < commit0End` 与
「无 wait-timeout 标记」都通过了；红在 `:357` 的 `expect(commitRow!.status).toBe('done')`
拿到 `failed`。CI 日志对应
`WARN [scheduler.commit] git commit failed nodeRunId=01KZZW1A1T8YYNSS578YQ8AW5P stderr=`
——**stderr 为空**的 git commit 失败即「nothing to commit」（该提示走 stdout、exit 1）。
即：那一刻工作树里没有可提交的变更。

**已证伪的假设（否定结论比猜想值钱，别再走这条死路）**：曾假设「两次 commit 会话顺序
翻转——会话 1 抢先提交，把被断言的会话 0 饿成空提交」。本地变异实证**推翻**了它：

| 变异 | 配置                                                | 结果   |
| ---- | --------------------------------------------------- | ------ |
| A    | 关掉同步点 + 会话 0 握手后再慢 300ms、会话 1 零延迟 | 4 pass |
| A2   | 同上，会话 0 慢 **3000ms**                          | 4 pass |

若顺序真能翻转，A2 必红。它没红 ⇒ **两次 commit 会话实际是被串行化的**。据此写了一个
「会话 1 等工作树变干净」的握手修复，已**整体还原**——建立在错误因果上的修复会把间歇性
伪装成「已修」，比不修更糟。

**已核实的事实**：n1 的 commit 节点在库里是 **2 行**——容器行
（`rerun_cause='commit-push'`，`commitPushJson` 非空）+ 会话行
（`rerun_cause='commit-push-session'`，JSON 为空）。测试的 `commitPushJson !== null`
谓词能正确区分二者，所以 CI 上失败的**确实是容器行本身**，不是 `rows.find` 挑错了行。

**两个待验证方向（均未跑证，不得当作结论）**：

1. 同一 harness 目录（`aw-rfc098-cp-run-qZW7Dc`）在日志里 **n1 被 spawn 两次、commit 会话
   出现三次**。先查 `rerun_cause` 区分「会话重试」与「两个会话」——若是重试，「前一次已把
   变更提交掉，后一次自然 nothing to commit」就说得通，且与 A2 测出的串行化不矛盾。
2. **iso → wt 合并回写与 commit 会话的先后**：n1 的 cwd 是 iso 目录、commit 的 cwd 是 wt，
   中间隔一次合并回写。若 commit 跑在合并回写**之前**，wt 里当然没东西可提交——那不是
   「两个会话抢」而是「缺同步点」，修法完全不同。判据：失败那一刻 wt 里有没有 n1 的产物。

**处置原则**：不许拿「重跑就过了」当通过依据（`CLAUDE.md` §Test-with-every-change）；也
不要加 timeout——那只是把偶发变稀。需要带 RFC-098 / 装配线上下文的人跟一轮，或先在
CI 上加一次性诊断输出（失败时 dump `git status` 与该节点全部 node_run 行）。

**不属于任何进行中 RFC 的连带面**，不应计入其收官判据。

### 2026-08-20 补：**本地复现了**（推翻上面「未复现」那半，给出复现配方）

RFC-313 收官时在**分离 worktree**（`git worktree add --detach` 到自己的 commit，只含被
追踪内容）里跑 `gate:local`，该用例红在**同一条断言** `:357
expect(commitRow!.status).toBe('done')` → `failed`，与 2026-08-14 记录的 CI 形态逐字一致。

- **复现条件**：满载。`gate:local` 会把 backend 四个 shard 与 quality 车道（含 5 分钟的
  frontend 全量）并发跑满机器；同一文件**单独跑 3/3 稳定绿**。所以它不是「随机」，是
  **负载相关**——这条足以让下一个接手的人不必再从「间歇/随机」这个错误起点出发。
- **归属可排除**：本次提交（RFC-313）改的是 agent 线的重试预算与形状判定，而
  ①该用例零失败注入、任务以 `done` 收场 ⇒ `shouldRetry` 结构上不触发；②commit 会话由
  `maybeRunCommitPush` 直接铸行、**不经 attempt 循环**、不读任何重试预算。两条都不可达
  ⇒ 与上面「纯 markdown 提交也红」互为佐证：该失败与代码改动无关。
- **对上面「待验证方向 1」的直接推进**：既然是负载相关，「n1 被 spawn 两次」更像是超时后
  的重派而非会话重试。下一步建议按 §处置原则 里那条一次性诊断做——失败时 dump `git
  status` 与该节点全部 node_run 行（含 `rerun_cause`），一次就能在方向 1 与方向 2
  （缺同步点）之间分出胜负。

### 2026-08-20 再补：链上**确实有**「先探后用」的两步式，窗口已定位到 file:line

由并发 session 提示去查的（他们刚治好一条同形的端口竞态：症状是语义离谱的响应码而非
`EADDRINUSE`，且「负载高才现形、单跑必绿」）。**这条提醒纠正了我上一段的表述重心**：
「负载相关」不是「环境慢」的证据，恰恰是**存在窗口的竞态**的特征——把它读成环境问题
会把下一个人引回死路。

**窗口（源码核实，非猜测）**：`maybeRunCommitPush` 的顺序是
①`services/scheduler.ts:2146` `git status --porcelain` 探脏 → `:2154` 干净就 `continue`；
②中间**跑掉一整个 commit-message agent 会话**（时长只受节点超时约束；在本用例里它是
桩里那个自旋等 `started-n2` 标记、上限 10s 的握手，见测试 `:86-95`）；
③`modules/source-control/application/repositoryCommit.ts:229` 才真正 `git commit`，
且**提交前不再复检**工作树是否仍脏。②的时长就是窗口宽度——**负载越重窗口越宽**。

**为什么与已证伪的 A2 不矛盾**：A2 是「**关掉同步点** + 会话 0 靠 delay 变慢」。关掉同步点
后会话 0 不会被**停在窗口中间**，窗口自然小；而真实红态的配置是同步点**开着**的
（`CP_COMMIT_WAIT_FOR_AGENT='n2'` + 10s 上限），会话 0 停在②里等 n2 起来，同时 n2 的完成
又会触发**第二个** commit 会话（`CP_COMMIT_DELAYS[1]=1500`）。A2 从未覆盖这个变体。

**还有一处独立缺陷（不解决竞态也该修）**：git 的「nothing to commit」是 **exit 1 +
提示走 stdout + stderr 为空**，而 `repositoryCommit.ts:236` 只判 `exitCode !== 0` 就一律
按硬失败处置 ⇒ 一次良性的空提交被报成 `git commit failed`（正是 CI 日志里那条
`stderr=` 为空的 WARN）。对**自动**提交推送而言「没东西可提交」本就不是错误。

**这条 git 行为的复现命令（2026-08-19 实测，别再重推一遍）**：

```sh
d=$(mktemp -d); cd "$d"; git init -q .; git config user.email t@t; git config user.name t
echo x > a.txt; git add a.txt; git commit -q -m first
git commit -m empty 2>/tmp/e.err 1>/tmp/e.out; echo "exit=$?"   # exit=1
wc -c < /tmp/e.err        # 0 ← stderr 确实为空
head -2 /tmp/e.out        # On branch main / nothing to commit, working tree clean
```

**必须用文件捕获，别用 `2>&1 1>/dev/null | wc -c` 那个顺手写法**：zsh 的 MULTIOS 会让它把
**stdout 也漏进管道**，于是「stderr 字节数」量出 53 而不是 0，看起来像是推翻了上面的结论。
我第一版复现命令就是这么写的，跑出 53 才发现说谎的是命令不是事实（bash 下行为又不同，
所以这个坑跨 shell 不一致、更该避开）。

**但「单修这条即可止血、与竞态修法互不冲突」这个判断有异议，接手前先读**（2026-08-19，
由 RFC-310 session 提出，本条原作者与转述者均认同其分量）：把 `exitCode=1 + 空 stderr`
判成 no-op，与「commit 前复检工作树」**是同一个决策的两半**。单修前者确实能降级这条间歇
红，**但它同时把「我以为有东西要提交、结果没有」从可见变成不可见——而那正是竞态留下的
唯一痕迹**。若竞态的正解是「commit 前重新 `status --porcelain`，仍干净就明确走 no-op
分支」，那么 `:236` 那条判断根本不该放行空提交，而是**应当永远不被触发**。结论：这两条
宜由**同一个人在同一刀里**决定，接手竞态的人顺带处置 `:236` 才是对的形状；单独把 `:236`
改成 no-op 属于**以牺牲可观测性换绿**，不推荐作为独立动作。

**决定性实验（未跑，留给接手的人）**：保留同步点、把会话 1 的延迟从 1500ms 调到 0，
并在 `git commit` 前后各打一次 `git status --porcelain` + `git log -1`。若会话 0 报的
「nothing to commit」发生在会话 1 已提交之后，本节机理即坐实。

## `unified system mock gateway` 的 npm 用例在 CI 上 30s 超时（2026-08-20 首见，1 次）

**现象**：`packages/system-mocks` 的
`unified system mock gateway > serves installable npm and PyPI artifacts plus the PlantUML renderer contract`
在 CI 的「Lint + Typecheck + Format + Shared + system mock tests」格红，报
`error: npm timed out after 30000ms`（`packages/system-mocks/src/core/process.ts:36`）。
run 32281928236，SHA `1e12aaad`。该用例会 **spawn 真实 `npm`** 打本地 mock registry。

**归属已排除（同码不同果）**：`1e12aaad` 是 RFC-313（agent 线重试预算 / 形状判定 +
shared prompt/config + 前端设置项），与 npm / PyPI / PlantUML 零接触；本地 33 pass；
该格在此前 7 次 main run 全绿；而**含同一 commit** 的后继提交 `40d75558`
（run 32283591822）该格**恢复绿**。同一份代码两种结果 ⇒ 环境因素，不是代码回归。

**待观察**：目前仅 1 次，不足以定性。若再现，先看是 `npm` 自身握手慢还是 mock gateway
起得慢——两者的修法不同（前者抬 `timeoutMs` / 加 `--prefer-offline`，后者是就绪探测缺失）。
在此之前**不要**盲目抬超时：那只会把偶发变稀，与本文件对 rfc098 的同款处置原则一致。

## `worktree-submodule-init` 的 `beforeEach` 会超时（2026-08-14 登记，非本轮改动引入）

**现象**：`RUN_GIT_NETWORK=1` 且与另外 3 个网络门控套件**同进程**跑时，
`createWorktree RFC-034 submodule init > worktree on parent w/ .gitmodules populates submodule
dir (mode=auto)` 间歇失败，报的却是 `afterEach` 的 `TypeError: path must be a string`
——真因在紧邻的一行提示里：`a beforeEach/afterEach hook timed out for this test`。
`beforeEach`（`:44`）超时后 `appHome` 从未被赋值，`afterEach`（`:89`）的
`rmSync(appHome)` 于是拿到 `undefined`。**报出来的错完全不是真因**，这是这条最费时间
的地方。

**归属**：该文件最近两次提交是 `8859a671` / `122abef9`，都不属于 RFC-287；单跑该文件
4/4 稳定绿，只在多套件同进程时抖。`beforeEach` 里要连做 `git init` + `submodule add`

- `clone --bare` 若干次真实 git 操作，共享进程下与其他套件的 git 抢 I/O 就会顶到默认
  5s 钩子超时。

**处置建议**（未做）：①给该 `beforeEach` 显式抬钩子超时（bun:test 的第三参数），
或②把夹具构建挪到 `beforeAll` 只做一次（各用例只读该夹具，不需要每例重建）。
顺带把 `afterEach` 的两处 `rmSync` 改成先判 `!== undefined` ——那样 `beforeEach` 失败时
报的就是真因而不是一个误导性的 TypeError。

**方法教训**（已同步 `docs/dev-gotchas.md`）：看到 `afterEach` 报 TypeError 时，先往上
找有没有 `hook timed out` —— 清理钩子的报错常常只是前置钩子失败的**次生现象**。

---

## RFC-165 boot healer 与 RFC-287 G5 的方向冲突（RFC-287 三轮实现门 AC 对账挖出，未做）

`healScheduledLaunchPayloads`（`packages/backend/src/services/scheduledTasks.ts:780` 起，
RFC-165 §9 的一次性 boot healer）每次 boot 都把遗留的 path-mode 定时任务 payload
用 `pathToFileURL` **改写成 `file://` 形态**。它写于 RFC-165，当时 `file://` 是一等
公民、这个改写忠实保留了本地仓（含未推送分支）。

RFC-287 G5 之后，`file://` 在**运行两面**（启动来源汇流点 `resolveRepoSourceSingle`

- 镜像刷新 `refreshCachedRepo`）一律被拒。于是 healer 现在的净效果是：**把一批本来
  就跑不动的行，改写成另一种同样跑不动的形态**——「出厂即死」。它既不再帮任何人，也
  不会主动伤人（那些行本来也起不来），但留着会让后来者以为 `file://` 仍是受支持的
  目标形态。

**为什么本轮不动**：①2026-08-13 拍板「存量为零、不做 grandfather」，动它的收益面是
空集；②healer 对已是 v2-clean 的 payload 早退（`:875`），而 `file://` 行正是 v2-clean，
所以任何「反向 healer」都不能沿用那段控制流，是独立的一块活；③它属于 RFC-165 的面，
不在 RFC-287 的改动范围内，顺手改会把两个 RFC 的回归面搅在一起。

**建议处置**（另案）：确认线上确无 path-mode 存量后**直接删除该 healer**（仓规「删除
优于 deprecate」），连同它的测试 `rfc165-scheduled-heal.test.ts` / `rfc248-scheduled-
payload-heal.test.ts` 里只为它存在的用例一起清。删除前先跑一遍「存量行计数」确认为零。

**判据**：`design/RFC-287-scheduler-assembly-convergence/design.md` §10.7 尾部已把
「一次性显式禁用 healer」标注为**设计期设想、未落地**；接手者不要照那句去补状态机。

---

## SIGKILL 落在仓库准备窗口内的两条不收敛窗口（RFC-287 三轮实现门并发面，未做）

G7 把仓库准备变成任务的第 0 步之后，出现一段新的「任务行已在、工作树还没有、后台正
跑 git」窗口。**优雅停机与用户取消已经修好**（信号穿透到子模块同步、abort 判 reason、
租约在每条出口归还——见 RFC-287 三轮门那几笔）。剩下**只在 SIGKILL / 断电**下成立的
两条，都需要设计决策，故未在本 RFC 内动：

### ① 准备的「所有权」没有持久化 ⇒ boot 后杀不掉遗留的 git

合成 `__repo_prep__` 行 mint 时**不记 pid**（`services/task.ts` 的 `mintNodeRun` 调用处），
而 `spawnGit` 因为要支持 timeout/signal 是以**独立进程组**运行的。对 daemon PID 执行
SIGKILL 时 controller / timeout / finally 一起消失，git 子进程继续跑；boot reap 看到
`pid=NULL`，`killStaleRunProcessTree` 直接返回 `no-pid`，却仍把行改成 interrupted。
于是**重试可能在旧 child 还在写的时候开始第二次克隆**。

**处置方向**（需拍板）：给准备行落 pid（新增写点，或复用 node_runs 既有 pid 列）+ boot
reap 对它走与 agent 行同款的 reap-proof 流程。代价是准备段要多一次 DB 写，且 pid 在
warm/cold 两条路径上的归属需要界定（`runGit` 目前不回传 pid）。

### ② worktree 已建、回填未提交 ⇒ 目录+分支成孤儿，且重试必然失败

`git worktree add` 成功之后、回填事务提交之前被 SIGKILL：磁盘上已有
`{appHome}/worktrees/<repoSlug>/<taskId>` 与 `agent-workflow/<taskId>` 分支，而 DB 里
仍是 `worktreePath=''`。后果三条：

- `runWorktreeOrphanGc` 按 taskId 是否存在判锚定 ⇒ **永远跳过**（任务行在）；
- `runWorktreeGc` 因 DB 路径为空 ⇒ skip；
- AC-11 重试用同一个 taskId 再跑 `worktree add -b agent-workflow/<taskId>` ⇒ 确定撞
  现存路径/分支并再次失败，且该 git 报错不在可重试分类里。

**处置方向**（需拍板）：要么让准备段的 `worktree add` 对「路径/分支已存在且属于本
taskId」幂等领养，要么在准备重跑前先做一次定向清理。前者更贴「重试作用于当前阶段」，
但改的是全仓共用的建树语义，影响面需单独评估。

**已修的部分（勿重复登记）**：`.partial-<ULID>` 半成品镜像目录的回收已落地
（`services/gc.ts` 的 `runPartialCloneGc`，挂在每小时 GC 上，按 24h 年龄判据）——它此前
**只有生产者、零消费者**，本 session 在真实 home 里实测到 13 个堆积。

---

## `runGit` 空 cwd 护栏：设计写死、从未实现（RFC-287 五轮门，用户拍板降级）

`design/RFC-287-scheduler-assembly-convergence/design.md` §10.9 写死了「`runGit` 见空
cwd 直接返回合成的 `exitCode!==0` 而不 spawn」。**它从未落地**——`util/git.ts` 至今是
裸 `['-C', cwd, ...args]`，无守卫、无测试。

**连续三轮审计都构造不出可达伤害**（这是不补实现的依据，不是没查）：G7 之后「空
`worktreePath`」从罕见终态变成常态，于是逐个扫了所有能把它喂进 git 的面——
`isGitWorkTree` 先 `existsSync('')===false` 直接返回不 spawn；`gc.ts` 的两处、
`worktreeBackup.ts`、`structuralDiff/service.ts`、`taskDelete.ts`、snapshot-refs 各自被
`!== ''` / `existsSync` / `isAbsolute` / null-`baseCommit` 拦在前面。实测
`git -C "" rev-parse --show-toplevel` 在 daemon cwd 下确实成功（退出码 0），但没有一条
生产路径能走到它。

**用户口径（2026-08-15）：降级 backlog、改文档，不补实现。** 理由是现在新增一个失败面
与 C3b 刚把清理路径统一成「吞掉 + warn」的方向相反。design §10.9d 已按「设计期设想、
未落地」显式标注。

**若将来要做**：按其自述形态实现成纯 `exitCode!==0` 合成（不抛），并同批给所有既有调用
面加回归——否则会把一批今天靠早退兜住的路径变成新的失败分支。

- ⏳ **仓里 43 张 `*-win32.png` 视觉基线没有任何 CI 会比对**（2026-08-20 查证，RFC-311 收口时销账转出）。
  判据：`visual-regression-nightly.yml` 是 `runs-on: ubuntu-24.04` **独跑**；`windows-platform.yml` 跑的是
  win32 ACL 后端测试，不含视觉套件；`grep -rn "win32" .github/workflows/` 无任何快照比对调用点。
  也就是说这些基线是**无人比对的存量产物**——刷新它们不改变任何门禁结果，而它们过期时也不会有人知道。
  两条路：①给 Windows 加一条视觉 job（成本是 runner 时间 + 又一份要维护的基线）；②删掉这 43 张并在
  `playwright.config.ts` 里把 win32 排除掉，让"没有基线"成为显式事实而不是沉默的存量。
  **这是仓级取舍，不属于任何单个 RFC**，故登记在此。RFC-311 原本挂着「刷 win32 基线」一项，据此销账。

- ⏳ **RFC-310 的验证程序 `repo:<path>` 在 Windows 上不可执行——需要一套解释器策略**（2026-08-20 查证，
  RFC-310 windows 腿定位时转出）。判据：`modules/development-automation/infrastructure/verificationRunner.ts`
  的 `createRepoScriptResolver` 把 `repo:<相对路径>` 解析成 workspace 内绝对路径后返回 `argv: [abs]`
  ——**直接 spawn，不带解释器**。POSIX 上靠 shebang 生效；Windows 没有 shebang 语义，`.sh` 根本不可执行
  （只有 `.exe`/`.bat`/`.cmd` 能这么起）。实证：RFC-310 的全旅程 E2E 在 windows 上走到
  `selected.kind = 'run-verification'` 之后就停住不动（决策轨迹实测，mission 停在同一 revision、
  同一 `upload-fulfillment-pending` hold，首跑与 retry 一致）。
  三条路：①profile 里显式声明解释器（`interpreterRef` / argv 前缀），跨平台但要动 schema 与既有 profile；
  ②Windows 上按 shebang 找 bash（本仓已有「从 git 推导 bash」的既成做法，见 dev-gotchas §跨平台），
  隐式但不改契约；③明确声明验证程序是 POSIX-only 能力，在文档与 UI 上说清楚。
  **这是产品能力取舍，需要用户裁决**，故未自行选路。相关的 E2E-B 已带着这条判据在 win32 上停跑
  （解除条件写在 `e2e/rfc310-digital-employee-journey.spec.ts` 顶部）；同 shard 的 E2E-A 在 windows 上是绿的。

## 存量 type package descriptor 与新必填字段的断层（2026-08-23 实测，RFC-310 相关）

> **发现者不是该 RFC 的作者**——这两条是排查「`bun dev` 起不来」时顺带量到的，写在这里
> 供 RFC-310 的 frozen-type-package 修复参考（对方已有 repro：commit `218ae46f0`
> *"test(dev): reproduce unparseable frozen type package"*）。**未改动任何相关生产代码。**

- **症状**：daemon 启动即退出（exit 1），zod 报
  `authoringManifest.workItems[1].humanReview.planningRoleRef / planningSlotRef: Required`。
  三条 ready 行一条都出不来。
- **坏数据位置**：`~/.agent-workflow/db.sqlite` 的 `employee_type_packages.descriptor_json`。
  本机 7 个修订里 **rev 4–7 缺这两个字段**；rev 1–3 不受影响（它们根本没有 `humanReview`）。
  即：`humanReview` 先落地，`planningRoleRef` / `planningSlotRef` 是后来才加的必填字段，
  中间那批已冻结的 descriptor 卡在断层里。
- **代码侧是对的**：内置包 `modules/development-automation/composition/employeeTypePackage.ts`
  对同一个 `analyze-implement` / `review-implementation-plan` 工作项声明的正是
  `planningRoleRef: 'planning'` / `planningSlotRef: 'plan'`——所以**全新 DB 不会复现**，
  只有带着存量行的开发机会撞。
- **本机已做的临时处置**（仅数据，未动代码）：备份 `db.sqlite` 后按内置包的取值回填那 4 行，
  daemon 恢复正常。这只是单机解封，**不是修复**——真正的修法是类型包升级 / 迁移路径要能
  处理「字段变必填之前写入的 descriptor」。

### 由此暴露的一个结构性测试盲区（不限于 RFC-310）

**CI 永远用全新临时 DB，结构上碰不到存量旧行**，所以「CI 全绿 + `bun dev` 起不来」是可
复现的常态，而不是偶发。同批实测：`973793228` 的 CI 里 3552 个后端用例只红 1 个，且红的
不是这条——启动路径对**旧形状持久化数据**的容忍度，当前没有任何用例在守。

- **建议的守卫形态**：一条「拿旧形状 descriptor（缺后加的必填字段）启动」的用例，
  或更通用的「schema 新增必填字段时，必须同批给出存量行的迁移 / 兼容路径」检查。
- 这与 `docs/dev-gotchas.md` 反复讲的是同一族：**空的 / 全新的语料让守卫零预言力**——
  那边是「扫描扫到 0 个文件」，这边是「测试库里没有一行旧数据」。

## ~~记忆→技能融合在真实 agent 下**必然失败**：结果清单被隔离 merge-back 丢弃~~（2026-08-24 实测挖出，**同日 RFC-319 B29 已修**）

> **状态：已修。** 用户拍板在 RFC-319 内直接修。修法与下文「候选修法」一致，外加一处：
> 名册的路径文法 `taskPlatformInputPaths.ts` 的 `ALLOWED_ROOTS` 是**封闭集**，原本只放行
> `PLATFORM_INPUTS_DIR` / `PLATFORM_PIPELINE_DIR`，所以光在 `fusion.ts` 传路径会被判
> `task-platform-input-paths-invalid`——`PLATFORM_FUSION_DIR` 一并入册。
> 防护两层：`packages/backend/tests/rfc319-fusion-manifest-merge-back.test.ts`（快判据，
> 不依赖运行时）+ `e2e/fusion-lifecycle.spec.ts`（真实 agent 跑完整条链）。
> 变异实证：抽掉那两行 `platformInputPaths`，单测与 e2e **双双转红**。
> 下面的根因链原样保留——它是这类缺陷的形态说明，`.agent-workflow/` 下还有别的读写两端待对照。

**症状**：任何一次由真实 agent 执行的融合，最终都停在
`fusion-failed: agent did not write the fusion result manifest`。融合是产品里唯一
一条会**改写托管技能正文并递增版本**的链路，这条缺陷让它整条不可用。

**根因链**（每一环都可复跑）：

1. merger 节点和其它 agent 节点一样跑在**逐节点隔离工作树**里——
   `<home>/iso/<taskId>/<nodeRunId>`（`services/nodeIsolation.ts:173`
   `isoWorktreePathFor`）。daemon 日志里 `spawning agent runtime … cwd=…/iso/…`。
2. 产品自己的契约要求 merger 把结果清单写进
   `.agent-workflow/fusion/result.json`（`services/fusion.ts:216-219` 的
   `MERGER_BODY` 第 3 步）。
3. 平台的工作区排除档把整个 `.agent-workflow/` 写进工作树的 git ignore
   （`modules/source-control/domain/workspaceExcludeProfile.ts:28`
   `gitignoreDirectoryRule(PLATFORM_WORKSPACE_DIR)`）。实测
   `git check-ignore -v .agent-workflow/fusion/result.json` →
   `.git/agent-workflow/excludes/v1:3:/.agent-workflow/`。
4. 逐节点 merge-back 是 **git 驱动**的，被 ignore 的路径不会被带回；唯一的逃生门是
   force-include 名册 `forcedPortPathsForTask`（`services/portArtifacts.ts:535`），
   它只收 `tasks.platform_input_paths_json` 与端口归档条目——而
   `services/fusion.ts:645` 的 `startTask` **没有**传 `platformInputPaths`。
5. 于是 `reconcileFusion`（`services/fusion.ts:753-760`）在
   `task.worktreePath` 下找不到清单，判 fail。注意它在检查前会调用
   `ensureBoundPlatformWorkspaceDirectory` **创建那个空目录**——所以事后看现场会
   看到 `.agent-workflow/fusion/` 存在但为空，容易误判成「agent 写了又被删」。

**同一次运行里的对照证据**（这是最有说服力的一条）：stub agent 在**同一个目录**里
既改了 `SKILL.md` 又写了清单；merge 回来的工作树里 `SKILL.md` 的改动**在**
（`## Fused by the e2e stub` + `- fused <memoryId>`），清单**不在**。差别只有一个：
后者被 ignore 了。

**为什么现有测试照不出来**：`packages/backend/tests/fusion-engine.test.ts:325-345`
把清单**直接写进 `task.worktreePath`** 并把任务行强制置为 `done`，从不跨越隔离边界。
它验的是 reconcile 之后的逻辑，不是 agent → 框架这一段。这正是 RFC-319 立项要找的
那类「缝隙上没有防护」。

**修法（已落地）**：`services/fusion.ts` 的两处 `startTask`
（初次 645、re-run 1606）加 `platformInputPaths: [PLATFORM_FUSION_MANIFEST]`——
它们本来就带 `internalSource`（`space_kind='internal'`），正好满足
`services/task.ts:2483` 对该名册的准入条件。回归防护应当是**跨隔离边界**的，
即用真实 agent 跑完一次融合（`e2e` 的 `fusion` stub 模式已具备该能力），
而不是再加一条直接写 worktree 的单测——那种写法正是这次漏掉它的原因。

**影响面待确认（同形隐患，未追）**：凡是「agent 把结果写进 `.agent-workflow/` 由
框架回读」的链路都可能同形。`PLATFORM_RUNS_DIR` / `PLATFORM_PIPELINE_DIR` /
`PLATFORM_REQUIREMENTS_DIR` 各自的读写两端需要逐条对照，确认它们要么不跨隔离边界，
要么已进 force-include 名册。

## 跨节点澄清提交后的落点不一致（RFC-319 B58 实测，2026-08-25）

同一条 cross-clarify 用例，**提交后停在哪一屏在不同环境下不一样**：本机每次都留在澄清详情页
（多源等待横幅就地渲染）；2026-08-25 的 CI（macOS，Playwright shard 1/2，run 32797…）trace 里的
页面快照是**任务详情页**，即那次走了跳转分支。

机制上两条路都存在且都是有意为之：`packages/frontend/src/routes/clarify.detail.tsx:481-487` 里，
提交响应是 `designer-waiting` 时把 pending 存进 `crossWaiting` 并**留在原地**，否则沿用
self-clarify 的旧行为「跳回任务详情」。所以落点取决于**提交那一刻服务端算出的多源就绪状态**，
而那受兄弟轮次的时序影响。

未决问题（留给该域的人判）：

1. 这个落点算不算用户面契约？「答完一家之后停在哪」直接决定人看不看得到「还差谁」那条提示——
   跳走了就看不到，得自己想起来回去翻。
2. 若算契约，应统一到哪一边（cross 一律留在原地？还是一律跳回任务详情并把提示搬到那一屏）？

E2E 侧的现状：`e2e/cross-clarify-multi-source.spec.ts` 已不再断言落点，改为**显式回访**该页再断言
「横幅点名还差谁」——那句承诺与落点无关，两条路上都成立。落点本身没有任何用例锁定。

## wrapper-fanout 内层节点收不到 clarify 邀请（per-shard clarify 自 RFC-060 PR-D 推迟至今未接线）

RFC-319 B62 实测：把 `clarify` 节点接到 `wrapper-fanout` 的内层 `agent-single` 上，工作流**能过静态校验**、
三个分片也都正常跑完，但渲染出来的提示词里**根本没有 clarify 邀请**——三份 `promptText` 只列了 `design`
输出端口，于是一轮 clarify 都不会被 mint，任务直接 `done`。也就是说「fan-out 的某个分片想反问」这条产品
路径目前是**静默不可达**的：不报错、不校验失败，只是问不出来。

与 `e2e/clarify.spec.ts:442-450` 那段被 `test.describe.skip` 的旧用例注释一致——per-shard clarify 从
RFC-060 PR-D 推迟到 PR-D2，至今未落地。

现状与影响面：

- 分片切换器（HUMAN-15）本身**是活的**，只是只能经**工作组** worker park 触达（`askingShardKey` 是任务卡 id、
  `WG_CLARIFY_NODE_ID` 全组共用）。正向覆盖见 `e2e/clarify-shard-switcher.spec.ts`。
- 工作流侧：validator 允许这样连线，用户会以为配好了。**要么接线，要么在校验期就明确拒绝并给出理由**——
  当前这种「能连、能跑、就是永远不问」是最难排查的一档。

留给 RFC-060 后续波次判定。

## RFC-319 B70 起草期撞到的三条用户面缺陷（2026-08-25，均未写成断言）

三条都**没有**写进 e2e 断言——把 bug 锁进测试等于把它固化。逐条给了 `file:line`，行号按 `origin/main`。

1. **清理一条孤儿 sidecar 会把草稿里的分支端口声明整体归零。** `removeOrphanOutputSidecars`
   （`packages/backend/src/services/agent-ports.ts:424-447`）的返回值里**没有 `branchPorts`**，
   而 `OutputsEditor.cleanupOrphan → emit`（`packages/frontend/src/components/OutputsEditor.tsx:81-83, 97-99`）
   把它当 `undefined` 一路传给 `onChange`。净效果：清理任意一条孤儿映射后，卡片上的「branch port」标记
   当场全部消失。这一次保存靠 `JSON.stringify` 丢掉 `undefined` + 后端 sparse-patch 语义侥幸没清库，但
   用户接着再动任何一个分支开关，PUT 就会带上一个不含原有声明的新数组，把分支端口声明**永久覆盖掉**。
2. **记忆表单 repo 档的下拉每一行都是空白。** `MemoryDialogShell.tsx:34-38` 把 `/api/cached-repos` 的行
   声明成 `{id,url,localPath}`、`:194-196` 取 `r.url` 当标签；而 RFC-204 早已把明文 `url` 从 wire 上摘掉，
   服务端只回 `urlRedacted`（`packages/shared/src/schemas/cachedRepo.ts:15`、
   `packages/backend/src/services/gitRepoCache.ts:353-359`）。全仓只剩这一个消费方还在读 `url`。
   用户后果：给 repo 挂记忆时只能靠位置盲选。
3. **`?focus=` 是个空载参数，「在审批队列中打开」实际落在 All Approved。** `routes/memory.tsx:54-61` 只把
   `focus` 透传，全仓**没有任何组件消费 `search.focus`**；且 `CandidatesList.tsx:55` 用 `search={{ focus }}`
   **整体替换**了 search，`tab` 因而回落到默认值。深链既不进审批队列，也不滚动/高亮那条候选。
   MEM-33 因此只锁「链接带对了 memoryId、点开不白屏、参数不被 `validateSearch` 吃掉」。

## RFC-319 B72 起草期撞到的产品缺陷（2026-08-25，均未写成断言）

行号按 `origin/main`。凡「未写成断言」的都是同一个理由：把缺陷锁进测试等于把它固化。

1. **`read` 档在工作组域拿到一个死按钮。** `workgroups.detail.tsx` 的权限入口挂 `canManageAcl`
   （纯方法级权限点），而承载面板的 Dialog 仍挂 `canUpdate`（= 权限点 ∧ `resourceAccess.canEdit`）。
   于是 `read` 档看得见「Permissions」按钮，点下去什么都不弹。`workflows.edit.tsx:1263 / 1294` 是同一形状；
   `agents / mcps / plugins / skills` 走 `AclDialogButton`（自带 Dialog）没有这个问题。
   两个修法：把 Dialog 也降到 `canManageAcl`（推荐），或把按钮升回 `canUpdate`（会撞 `rfc099-ownership-acl.spec.ts`）。
2. **MCP 探测的 stdio stderr 采集在失败路径上完全失效。** `services/mcpProbe.ts:477` 的 `stderrBuf` 活在
   `defaultOpenClient` 的闭包里，只通过 `:570` 构造的客户端对象暴露；而 connect / handshake 失败时
   `openClient` 在 `:636` 直接抛，那个对象根本没被构造，于是 `:235` 的 `client?.capturedStderr() ?? ''`
   恒为空串。实测：`crash` 档子进程明明往 stderr 写了东西，界面只剩 `MCP error -32000: Connection closed`。
   **最需要 stderr 的那一档恰好没有**，而 `:22` 的文件头注释与 `errorDetail` 的设计都明文承诺会带上它。
3. **数字员工的作用域摘要写死中文且暴露裸 ULID。** `authoringService.ts:2766` 调
   `summarizeWorkScope(encodedScope, 'zh-CN')`——locale 硬编码；`employeeTypePackage.ts:3018-3030`
   对 repository / repository-group 直接拼 `仓库：${repositoryId}`。英文 UI 的用户在员工卡片上看到的
   就是一行中文 + 一串 ULID，无法辨认自己选的是哪个仓库/组。
4. **`retireTool` 零校验，且能把已停用的工具绑进新岗位模板。** `authoringService.ts:1818-1821` 只做
   `#exactTool` + `retireTool`。`getToolRevision`（`sqliteAuthoringStore.ts:195-206`）不看 `retiredAt`，
   而 `listTools`（`:333-348`）才过滤——所以在跑的案例不会断（危害小于直觉），但 `#validateBinding`
   （`authoringService.ts:1839-1840`）同样走 `#toolRevision`，于是**经 API 仍可把已停用的工具绑进新模板**，
   而 UI 因为 `listTools` 过滤根本看不到它。停用时也零提示。
5. **`development` system-mock stub 没跟上 RFC-318 v2 工具合同，连带一条空洞绿。** v2 执行路径组的
   prompt 是 `… INPUT_JSON` + 普通 workflow-output 端口（`digitalEmployeeExecution.ts:195-215`），
   而 stub 只认 RFC-310 老协议的 `<agent-result nonce="…">` 帧（`mode-development.ts:68-81, :142-158`）。
   实测 `analyze-implement` 每轮都失败重试：`stub-development-agent: prompt is missing the RFC-310
   agent-result identity`。**而 `rfc310-digital-employee-journey.spec.ts` 的
   `body and repository-bound files enter a stateful employee case and the unified task list` 一直是绿的**
   ——它对时间线只断言「第一步存在」（那是 `prepare-materials` 这个平台节点），从未断言
   `analyze-implement` 轮次成功。属 RFC-319 §1.1① 的「空洞绿」。
6. **`SubmoduleBadge` 的「有子模块但从未同步」与「同步成功」在可见文案上无法区分。**
   `repos.submodule.labelOk` 与 `labelPending` 都是 `'has submodule'`，只有 `title` 与 chip 颜色不同，
   且 pending 那一支**没有 `data-testid`**（`SubmoduleBadge.tsx:42-49`，另两支都有）。RFC-210 当初把
   pending 从绿改成中性正是为了不再「宣称一次没发生过的成功」，但文案没跟着改。
7. **`main.spec.ts:570-573` 的注释与产品实际打架。** 那里写「批量导入现在也拒 `file://`」，但
   `StartBatchImportRequestSchema`（`shared/src/schemas/repoBatchImport.ts:69-74`）只 refine 了
   `noQueryCredentialUrl`，全链路无 scheme 检查——而该 schema 顶部的 RFC-287 G5 注释明确说这是**刻意**不拒
   （真正的收口在 `services/task.ts` 的 `resolveRepoSourceSingle`）。`main.spec.ts` 那条注释是过期的。
8. **导入弹窗里两个按钮的无障碍名同为 "Close"**（`Dialog.tsx:425` 的 `aria-label="Close"` vs
   `repos.batchImport.close`）。读屏用户在同一个对话框里听到两个同名按钮。属共享 `<Dialog>` 层面的问题，
   影响所有带 "Close" footer 的弹窗。
9. **`repos.tsx:534` 的空态分支与 `PageHeader` 争同一个 `data-testid`**（`repos-batch-import-button`，
   互斥出现）。`e2e/keyboard-flows.spec.ts` 的四条 Dialog 用例正是靠「零仓时按钮落在空态里」拿到它——
   一旦有人给页头补上「空态也显示导入按钮」，那四条会 strict-mode 撞车。埋着的 testid 唯一性地雷。

## RFC-319 B75 起草期撞到的产品缺陷（2026-08-25，均未写成断言）

行号按 `origin/main`。「未写成断言」的理由一律相同：把缺陷锁进测试等于把它固化。

**运维 CLI**

1. **端口绑定失败会漏掉一个陈旧锁文件。** `start` 在 `cli/start.ts:322` 之后就持锁，而 `Bun.serve`
   （`:853`）抛 EADDRINUSE 时进程经 `main.ts:212-216` 直接 exit 1——那时退出/信号处理器（`:1539`、
   `:1625`）**还没注册**，`lock.release()` 从不执行。实测：一次端口冲突后 `.daemon.lock` 里躺着已死 PID，
   随后 `status` 报「陈旧锁」。`acquireLock` 下次会自愈，但用户在两次操作之间看到的是一句吓人的话。
2. **端口冲突的报错是 Bun 的原始异常文本，不是产品自己的话**：`Failed to start server. Is port N in use?`
   ——没有 `agent-workflow:` 前缀（其余启动失败都有，见 `start.ts:325/374/404`）、没说是哪个 host、
   没提示可以 `--port`，而且随 Bun 版本漂移。
3. **`stop` 的等待预算（30s）等于 daemon 自己的排空预算（30s），必然误报。** 实测：一个正在排空的 daemon
   在 SIGTERM 后 **30.1s** 干净退出，而 `stop` 在 30.0s 就放弃并报 `did not exit within 30000ms` + exit 1。
   **只要 daemon 用满预算，`stop` 一定报失败**，哪怕它下一毫秒就停了。脚本化的 `stop && start` 会被无谓中断。
   建议 `stop` 的等待 = daemon 预算 + 缓冲，或直接做成 `--timeout`（那也正好解开 OPS-007 的不可测，见下）。
4. **`--port " "`（未展开的 shell 变量）被静默当成 `--port 0`。** `Number(' ') === 0` 通过 `readPortFlag`
   （`main.ts:41-48`）全部校验，daemon 绑到内核随机端口。用户写 `--port "$PORT"` 而变量未设置时，
   会得到一个「起来了但不知道在哪个端口」的实例。
5. **OPS-007 目前不可测**（已如实留 gap）：`stop` 的等待预算 30s 硬编码、CLI 无 `--timeout` 旋钮，
   而 `e2e/command.ts:15` 的 `COMMAND_TIMEOUT_MS` 是 15s——子进程会先被 harness 打死，拿到的是 harness
   行为而非产品契约。`forced` 那一档在 POSIX 上根本不可达（`cli/stop.ts:104` 只在 win32 硬杀）。

**Webhook 端点**

6. **`POST /api/webhook-endpoints/:id/rotate-url-token` 全仓零调用方。** 入站地址泄露后用户在界面上
   无法轮换，只能新建端点并回代码平台重配。
7. **端点「改名 / 改 clone 协议」同样没有 UI**：`WebhookEndpointCard.tsx:156-158` 是唯一的 PUT 调用点，
   body 恒为 `{ enabled }`。clone 协议选错的端点（自动注册永远失败）只能靠 API 或重建修复，而重建会
   换掉 URL 与 secret。
8. **未知 provider 的请求白烧全局限流配额**：`routes/webhooks.ts:105-108` 调了
   `limiters.unmatched.allow('global')` 却**丢弃返回值**直接 404。扫路径的人永远不会被 429，但他消耗的是
   和「真实误配置的 hook」共用的那一个桶；桶满后，一个地址配错的正经 hook 拿到的是 429 而不是能说明
   问题的 404。
9. **`data-testid="webhook-endpoint-add"` 在空列表时重复出现两次**（`WebhookEndpointCard.tsx:258` 与 `:308`），
   任何用 `getByTestId` 的 spec 在空列表下都会 strict-mode 撞车。
10. **启停开关没有 pending 反馈**：受控 checkbox 在服务端回执前 `checked` 不变，用户看到「点了弹回去」；
    Playwright 的 `check()` 会直接报「Clicking the checkbox did not change its state」。

**定时任务**

11. **手动暂停一条曾经失败过的排期，详情页谎称「系统自动停用」。** `scheduled.$id.tsx:199-203` 的条件是
    `!enabled && consecutiveFailures > 0`，而**手动停用不清零** `consecutive_failures`
    （`services/scheduledTasks.ts:697-705` 只在启用方向清零）。用户会去追一个不存在的自动停用事故。
12. **真正被自动停用的一类反而不显示该横幅**：`scheduledTaskScheduler.ts:65-77` 在 `schedule_spec` 损坏时
    直接 `enabled=false`，但**不动** `consecutive_failures`（保持 0）。与上一条是同一判据的两面：既误报也漏报。
13. **总开关与失败阈值在前台完全没有入口**：`grep -rn "scheduledTasksEnabled\|scheduledTasksMaxFailures"
    packages/frontend/src` → **0 命中**。出事时最该点得到的急停闸，界面上没有。
14. **自动停用没有任何对外通知**：`onAutoDisable` 回调在 daemon 装配处（`cli/start.ts:1476-1480`）根本没传。
    「排期被系统关掉了」只落在库里。`WHERE enabled=1 RETURNING` 的「只停一次」设计目前是为一个不存在的
    消费者服务的。
15. **RFC-324 给 `scheduled_tasks` 接了 grants 与 `/acl` 端点，前台没有任何授权面**
    （`grep -c AclPanel packages/frontend/src/routes/scheduled.$id.tsx` → 0）。

**任务列表**

16. **RFC-311 的「默认视图」快路径在生产中永不可达（双重失效）。** 唯一生产调用方
    `task-catalog-adapter.ts:76` ①恒传 `subject: sourceId`（`:83`），而 `isDefaultView` 要求
    `subject === 'all'`（`taskOperations.ts:760`）；②恒传 `catalogVisibility: 'public'`（`:90-91`），
    而 `defaultFastPath` 要求它 `undefined`（`:1119-1120`）。`fastDefaultRootQuery` 及其 O(page) keyset
    优化是死代码。仍有兜底故非 P0，但 RFC-311 声称守住的那条已不成立。
17. **筛选弹窗里两个不同维度的单选项撞了同一个可及名**：`tasks.operations.category.all` 与
    `tasks.operations.scope.all` 在 en-US 里都是 `'All tasks'`，两个 radiogroup 同屏并列，读屏用户
    无法区分「类别」与「范围」。
18. **`pruned` 的文案承诺与导航不一致**：文案明写 files / diff / node retry / workflow sync 都不再可用，
    但 `deriveTaskDetailCapabilities`（`task-detail-tabs.ts:107-134`）只看 `worktreePath`/`baseCommit`，
    而 GC 只落墓碑列、**不清空** `tasks.worktree_path`（`services/gc.ts:170-180`）。三个页签回收后照旧
    可点，点进去撞到的是裸错误而不是「这里已经回收了」。
19. **`available → pruning` 这一跳在已打开的详情页上不可观测**：终态任务的轮询已停
    （`tasks.detail.tsx:2042-2047`），而工作区 GC 认领不发 WS 帧。用户仍看得见「重试节点」按钮，
    点下去撞 409。建议 GC 认领时广播一帧，或把终态任务的轮询保留到工作区进入终态。

## MCP 探测：命令不存在时 Windows 上不回显路径（2026-08-25 CI 实测）

产品并不自己拼这句错误，它转述的是运行时 spawn 失败的原文——`services/mcpProbe.ts:319-334` 那张
errno 表在 Bun 上一条都命中不了，兜住分类的是 `CONNECT_FAILED_MESSAGE_RE` 的文本匹配。于是同一个
「命令写错了」的场景，两个平台给用户看到的东西不一样：

- POSIX：`ENOENT: no such file or directory, posix_spawn '<path>'` —— 路径在里面，用户知道该改哪。
- Windows：`Connect failed: subprocess never started or network refused. MCP error -32000: Connection closed`
  —— **一个字的路径都没有**，用户对着一句「连接失败」，分不清是路径写错、没装、还是没有执行权限。

`e2e/rfc319-mcp-management.spec.ts` 的 RES-21 因此把「回显路径」这半条降为 POSIX-only，并在注释里写明
这是**如实降级、不是把现状锁成契约**：分类（`connect-failed`）仍逐平台断言，哪天产品自己带上路径，
把那个 `process.platform === 'win32'` 分支去掉即可，不会因此变红。

修法方向：`mcpProbe` 在归类为 `connect-failed` 时把自己知道的 `command[0]` 拼进 `errorDetail`，
不要依赖运行时错误文本里恰好带路径。

## RFC-319 B80 起草期撞到的产品缺陷（2026-08-25，均未写成断言）

**工作流编辑器**

1. **【P2】编辑器 More 里的「删除」对非 owner 的被授权者照常渲染。** `workflows.edit.tsx:312` 是
   `const canDelete = usePermission('workflows:delete')`——**只看方法级权限点**，而该点在 user 预设里
   人人都有。对比同段 `:310` 的 `canUpdate = canManageAcl && workflowAccess.canEdit` 已经纳入行级档位。
   结果：只读（甚至可编辑）被授权者打开别人的工作流，能看到「删除」、能把名字逐字敲对、能点确认，
   直到服务端回 403 `resource-govern-owner-only` 才被拦下。RFC-324 修掉的正是这类「看起来能做、做了才吃 403」。
   建议与 `canUpdate` 同形：`usePermission('workflows:delete') && workflowAccess.canManage`。
2. **【P3】`workflow-in-use` 的 `details.referenceCount` 在界面上不显示。** 服务端刻意只给聚合计数
   （`services/workflow.ts:716-719`，任务 ACL 保护），但 `ErrorDetails.tsx:118-129` 的白名单里没有这个
   **标量**键，于是用户只看到「Tasks still reference this workflow」，看不到还剩几条。
3. **（非缺陷，但值得记）编辑器内的 `ErrorBanner` 没有 `role="alert"`。** `NoticeBanner.tsx:103` 在
   `ManagedLiveRegionProvider` 上下文里**故意**不挂 role（改由统一 live region 播报），而编辑器整棵树
   都在该 provider 内（含 portal 出去的 Dialog——React context 跟树走不跟 DOM 走）。任何在编辑器内用
   `getByRole('alert')` 找错误横幅的 e2e 都会稳定落空，失败信息还只是「element not found」。
   同一个组件在列表页（无 provider）又能按 role 取到——这种「同组件两种可及性形态」最容易写出空洞绿。

**画布编辑**

4. **【P2】Ctrl+A 与右键菜单「Select all」都是空操作。** `WorkflowCanvas.tsx:1921-1927` 的 `selectAll`
   只写 React 的 `selection` 状态、不动 xyflow 自己的选中标记；`:2903-2921` 的 `onSelectionChange` 在下一次
   store 更新时用 xyflow 那份**空**选择集把它覆盖回去。实测：Ctrl+A 后 `workflow-layout-selection` 连采
   8 次全 disabled；同一页面同一时刻 Shift 多选 → enabled。**用户影响**：全选之后 Ctrl+C、Delete、
   「整理所选」全部无效，而画布上没有任何选中反馈，用户完全不知道自己没选中。
5. **【P3】自动贴合尺寸的 wrapper 一旦有成员，「在里面添加」按钮就被内层卡片盖住、点不到。**
   无显式 `size` 时 `coordProjection.ts:111-118` 用内层 bbox 反推 wrapper 矩形，顶部留白（实测 62 逻辑 px）
   小于「头部 + 配置摘要」的高度（实测 67 px），第一个内层节点压住按钮下部。实测按钮中心
   `elementFromPoint` 命中的是内层 icon。而「wrapper 里已经有节点」恰恰是最常用的场景。
6. **【P3 文案】删 wrapper 的确认框写「This cannot be undone.」，但它其实可撤销。**
   文案 `en-US.ts:7024-7025`；实现 `WorkflowCanvas.tsx:2241-2257` 走 `commitTransition` + `history.delete`，
   一次 Ctrl+Z 就能完整还原。吓唬用户，或让人放弃一个本可随时撤销的操作。
7. **【待定夺】保存收到 5xx 时页面永远不显示「Save failed」。** `workflow-editor-draft.ts:659-663` 把
   `>= 500` 归为「结果不确定」→ 转 `reconciling` 并反复重试，相位在 `Saving` / `Checking save result`
   之间来回跳。语义说得通（5xx 不能证明服务端没提交），但一个明确回了 500 的服务端在界面上表现成
   「一直在检查」，没有终态也没有可操作出口。

**用户与账号**

8. **【P2】`/api/users/search` 隐藏停用账号的规则挂在一个无人调用的参数上。**
   `services/users.ts:283` 的 `.filter((r) => input.status !== undefined || r.status !== 'disabled' || excluded.size === 0)`
   ——「不显式指定 status 时是否隐藏 disabled」取决于调用方有没有传 `excludeIds`；而 `excludeIds` 在全仓是
   `UserPicker` 的**组件 prop**，排除在客户端做（`UserPicker.tsx:139-143`），发给服务端的只有 `q/limit/status`。
   于是 `excluded.size === 0` 恒真、这条隐藏规则**永远不生效**，`routes/users.ts:63` 解析的 `excludeIds` 是死参数。
9. **【P3】`/api/users/search` 的 `q` 未转义 LIKE 通配符**（`services/users.ts:266,273`）：输入 `%` 匹配到
   全部账号，输入 `a_c` 匹配 `abc`。有参数化、不是注入；是「搜索结果与你输入的不是一回事」。
10. **【P3】`account.patsDesc` 是一条与现实相反的遗留文案**：`en-US.ts:1992` 写「Personal access token
    creation is retired.」，而 RFC-247 D1 早已重开签发。该 key 已无任何渲染方，属死文案，建议直接删。

## RFC-319 B82 起草期撞到的产品缺陷（2026-08-25，均未写成断言）

1. **【P2】`disabled` 置灰在 MCP / Plugin / dependsOn 三个选择器里结构性不可达，只有 Skills 成立。**
   `ResourcePicker.tsx:85-92` 只在 `selected.has(option.value)` 时才并入 `selectedOptions`，而
   `MultiSelect.tsx:350` 的 `rowDisabled = !selected && disabled`——**选着的时候不灰（为了能摘掉，
   这是对的），一摘掉选项就整个从候选里消失**，永远不存在「灰着的选项」这一态。只有
   `SkillsPicker.tsx:80-84` 无条件并入，置灰才可达。
   **更糟的一半**：插件被停用时 `/api/plugins` 仍返回该行（因为它被选中而被 `pass(item) ||
   selected.has(item.id)` 放行），于是 resource-status 那份 actor-safe 的「(disabled or unavailable)」
   标签**一次都不会显示**——用户在 Plugins 选择器里看到的是它的原名，没有任何迹象表明这条引用已经死了。
2. **【P3】`/api/execution-contracts` 里 v1 契约的 `displayName` 装的是「输入材料」的描述，不是这项工作的名字。**
   实测：`development.analyze-implement@1` → `"Requirement context, repository snapshot, and existing
   diagnostics"`；同族 v2/v3 则是正常的 `"Implement change"`。`ExecutionContractPicker.tsx:63` 直接把它
   当选项标题渲染，于是 Ports 页那个下拉里混着一半读不懂的长句。属契约注册表的数据编写问题，不是 UI。
3. **【P3】转让归属后，前任的编辑面在 WS 断线时会一直停在「可编辑」。** `useResourceAccess` 用独立 key
   `['resource-access', …]`，而 `AclPanel` 的保存只失效 `['agents']` 与 `['acl', …]`；恢复完全依赖
   `useWebSocket.ts:200-202` 的 `resource-acl.changed` 帧。socket 不通时前任会看到一个点下去必吃 403 的保存键。
4. **【账本文案与实现不符】AGENT-X3 写的是「切 Preview 页签」，而 `MarkdownEditor.tsx:34-57` 是固定的
   编辑/预览双栏并排，没有页签可切。** 覆盖已改为「预览栏随正文实时渲染」，建议改账本措辞。
5. **【已知但值得记】`agents.new.tsx:185-192` 的创建键 disabled 条件只含 `draft.name === ''`**，
   非法名格式没有前置闸（`AgentForm.tsx:528` 的 HTML5 `pattern` 没有 submit 事件可拦）。
   用例因此**刻意没有**断言「非法名时按钮禁用」——那会把不存在的行为写成期望。

## RFC-319 B83 起草期撞到的产品缺陷（2026-08-25，均未写成断言）

1. **【P2】四个资源名输入框的 `pattern` 属性在现代浏览器里是聋的，native 校验从不触发。**
   `packages/frontend/src/routes/skills.new.tsx:225`、`packages/frontend/src/components/McpFields.tsx:48`、
   `packages/frontend/src/components/PluginFields.tsx:57`（以及代理表单用的 `AGENT_NAME_RE`）都写
   `pattern={XXX_NAME_RE.source}`，而这四个正则同形：`/^[a-z0-9][a-z0-9_-]*$/`
   （`packages/shared/src/schemas/skill.ts:7`、`schemas/mcp.ts:19`、`schemas/plugin.ts:21`、
   `schemas/agent.ts:112`）。当前 HTML 规范要求浏览器把 `pattern` 编译成 `^(?:…)$` 并带 **`v` 标志**；
   `v` 模式下字符类里未转义的 `-` 是语法错误，编译失败时约束被**静默丢弃**。实测：
   `new RegExp('^(?:^[a-z0-9][a-z0-9_-]*$)$','v')` → `Invalid character in character class`，
   同一串用 `u` 编译正常。后果：`:invalid` 样式、`validity.patternMismatch`、表单提交拦截全部失效——
   目前真正拦住用户的只有那个 `disabled` 的按钮（MCP / 插件新建页则是 `mcp-form.ts` 的手写校验）。
   修法：`[a-z0-9_\-]`，或给 `pattern` 传一份转义过的 source。
   用例里**只锁了「表单声明的规则字符串 == 共享正则」**，没有把这个聋态写进断言（那等于把缺陷固化）。
2. **【P3】`skills.zipArchiveErrorsTitle` / `zipArchiveErrorsCount` 缺复数形式，单数时出中式英语。**
   实测渲染 `1 rejected entries` / `1 entries did not pass validation`
   （`packages/frontend/src/i18n/en-US.ts`）。同文件的 `splitPage.itemsCount` 已用 `_one` / `_other`，
   说明本仓有这个惯例，这两条漏了；`zipCandidatesCount` / `zipConflictsCount` 同病。
3. **【账本文案与实现不符】RES-X5 账本行写的「有未保存改动时点 History 不切换」与源码不符。**
   `packages/frontend/src/routes/skills.detail.tsx:256-275` 的 `historyTab` 没有 `disabled`，
   `onSelect={setTab}` 也无条件——点击**会**切到 History 页签，只是面板换成 `EmptyState`（`:877-899`）。
   产品行为本身合理（徽标 + 说明 + 出路都在），但照账本措辞写会得到一条永远红的用例。
   覆盖按源码实际行为写成「History 拒绝开门（切过去只有空态说明）」。
4. **【P3】ZIP「无候选」态里 `Replace ZIP` 出现两次**：一次在归档头
   （`packages/frontend/src/components/skills/ImportZipPanel.tsx:451-459`），一次在 EmptyState 的
   action（`:477-487`）。同屏两个同名按钮，对屏幕阅读器是两个无法区分的控件。
5. **【覆盖缺口，非缺陷】技能版本「回滚」的 UI 路径目前无 e2e。** RES-13 由
   `e2e/skill-lifecycle.spec.ts:152` 在接口层锁住，但 `SkillVersionHistory.tsx:164-177` 的
   `ConfirmButton → restore`（`onRestoreStart` / `onPendingChange` / `handleRestored` 的 busy 交接）
   零浏览器覆盖。建议另立一条能力行。
6. **【覆盖缺口，非缺陷】`UnsavedChangesGuard.tsx:239-253` 的 `unsaved-force-leave` 逃生口无覆盖。**
   它只在 busy 满 `BUSY_ESCAPE_AFTER_MS = 10_000` 后出现；断言「它不存在」会随 CI 机器忙闲变成
   时序赌博，断言「它存在」则要每条用例白等 10 秒。B83 刻意只锁了恒真的那部分
   （无 Discard + 有 Stay + 走不掉）。
7. **【死防御，非缺陷但值得记】`MemoryPendingBadge.tsx:26` 的 `canManage === true` 过滤永远删不掉行。**
   候选行只对 `resource-acl:bypass` 可见（`routes/memories.ts:133` 先跑 `dropCandidates`），
   而 bypass 操作者的每一行都被盖成 `canManage: true`（`services/memory.ts:882-883` 短路）。
   「看得见但管不了的候选」这一态在产品里不存在。该符号的守卫在前端单测
   （`packages/frontend/tests/memory-admin-gate-role.test.ts:31-42`），e2e 照不到它是应然。

## RFC-319 B85 起草期撞到的产品缺陷（2026-08-25）

1. **【已修，记录在案】发行单二进制上 `backup` / `migrate` / `migration-report` / `package` 四条命令全部当场失败。**
   见 `packages/backend/src/db/migrationsFolder.ts` 的文件头与
   `packages/backend/tests/cli-embedded-migrations.test.ts`。留在这里是为了记住**它是怎么躲过所有门禁的**：
   源码树上跑的单测里 `Paths.migrationsDir` 是个真目录、`IS_EMBEDDED` 是 false，四条命令全绿；
   而二进制 smoke 只跑 `version`。与 RFC-311 P0-1（backup worker 在发行版 ModuleNotFound）同形。
   **待办**：单二进制 smoke 的覆盖面值得单独扩一轮——今天它只证明「二进制能启动」。
   **修完之后又露出一层**：同一条命令在发行二进制上仍打印
   `backup vacuum worker unavailable; falling back to the main thread`
   `error="ModuleNotFound resolving \"/$bunfs/root/backupVacuumWorker.ts\" (entry point)"`
   ——即 RFC-311 P0-1 的 worker 在发行版上**至今仍解析不到**，只是现在有了主线程兜底所以不再致命。
   代价是 VACUUM 回到主线程、备份期间 daemon 会被阻塞（本次实测 104ms / 空库，随库增长）。
   这一层不在本次修复范围内（本次只让命令跑得起来），建议单独立一条。
2. **【P2】`config set <未知键> <值>` 以退出码 0 收场并打印 `<键> = undefined`。**
   `ConfigPatchSchema`（`packages/shared/src/schemas/config.ts:756`）不是 strict，未知键被静默剥掉
   （**不落盘这一点是对的**，B85 的 e2e 已锁住），但 `cli/config-cli.ts:38-41` 随后读回
   `updated[key]` 得到 `undefined`，回执成了 `bogusKey = undefined`、exit 0。
   脚本里一个拼错的键名会被记成「配好了」。用例**没有**把 exit 0 写成期望——那是缺陷不是契约。

## RFC-319 B86 起草期撞到的产品缺陷（2026-08-25，均未写成断言）

1. **【中低，可访问性回归】`.repo-kind-tabs` 把移动端 44px 触摸目标压成 38px。**
   `packages/frontend/src/styles.css:25674-25677` 的 `.repo-kind-tabs .tabs__tab { min-height: 38px }`
   特异度 (0,2,0)，压过 `styles.css:23516-23528` 里 `@media (max-width: 720px)` 的
   `.tabs__tab { min-height: 44px }`(0,1,0)——**媒体查询不加特异度**。实测：390px 下 `/events`
   的四个页签（Overview / Sources / Subscriptions / Deliveries）高度全部是 38。
   受影响的是所有用 `repo-kind-tabs` 的 TabBar。同族坑仓内已被识别并显式修补过一次：
   `styles.css:23533-23538` 给 `.auth-page .tabs--segment .tabs__tab` 补了 44px，注释原话是
   「路由级选择器比上面那条共享的 `.tabs__tab` 移动端规则更强」——说明团队意图就是 44，
   `repo-kind-tabs` 漏了。UX-X3 的用例改到 `/agents/new` 量页签（那里实测 44），
   **没有把 38px 写成期望**。
2. **【低，可能是刻意的密度选择，请裁决】`.list-view-switch .segmented__option { min-height: 36px }`**
   （`styles.css:25709-25717`）同形压过 44px：390px 下 `/memory` 的 Approved/Archived 分段控件
   实测 36。但 36 与产品明示的紧凑档（`.btn--sm` / `.btn--xs` / `.tasks-toolbar .segmented__option`）
   一致，可能是有意的。同样没有断言。
3. **【低】MultiSelect 的「新增自定义项」判重比错了对象，能造出两枚同名 chip。**
   `packages/frontend/src/components/MultiSelect.tsx:129` 的 `showCustom` 拿**裸 `trimmed`**
   去比 `rows[].value`，而 `SkillsPicker.tsx:29-31` 存进 `value` 的是**带前缀**的 token
   （`project:foo` / `managed:<id>`）。实测复现：`/agents/new` → Skills 输入 `dupskill` → Enter
   （1 枚 chip）→ 再输入 `dupskill` → **ArrowDown**（跳过高亮的已选行）→ Enter ⇒ 出现两枚同名 chip。
   服务端保存时会去重（`POST /api/agents` 传两条相同 `{kind:'project',name:'dup'}` 返回 201、
   回体只剩一条），所以只是保存后其中一枚静默消失。同一处不对称还让「与某个受管技能重名」的
   自由文本被当成新的项目技能提供、无任何提示。
4. **【账本文案偏差，已按实现处置】UX-20 的「画布 / 选择器 / 操作结果」三个来源里，
   托管播报区实际只挂在两条路由**：`workflows.edit.tsx:1038` 与 `tasks.tsx:156` 挂了
   `ManagedLiveRegionProvider`，其它页面 `useManagedLiveRegion()` 一律返回 `null` 并退回各自的
   局部 `aria-live`。B86 覆盖的是「选择器」那一支；画布支与 `/tasks` 的「操作结果」支未覆盖。
5. **【账本文案偏差】UX-X7 说「两个公共原语」，但 Pagination 与 FilterBar 同处一屏的地方
   产品里只有 `DeliveriesPanel`**（`events.tsx` 里另外三处 Pagination 与 FilterBar 是分开组合的）。
   覆盖按实现选了 `/events?tab=deliveries`（`/webhooks` 现在只是重定向到 `/events`，
   见 `routes/webhooks.tsx:38-53`）。

## RFC-319 B87 起草期撞到的产品缺陷（2026-08-25，启动闸门 / 后台清扫域）

1. **【高】库损坏导致启动失败时，产品会顺手生成一份「内容就是那个坏库」的 pre-migration 备份，
   并把它排在恢复指引的第一位。** 链条：`backupManifest.ts:64-66` 对坏库返回 null →
   `backupScheduler.ts:318` 得到 `dbMax = -1 < binaryMax`（判成「需要迁移」）→ `rawCopyDb`
   字节拷贝（它**刻意**容忍损坏）→ 随后 `openDb` 抛 `DbCorruptionError` →
   `formatDbCorruptionGuidance` 按 mtime 倒序列备份，这份刚出炉的坏备份排第一，
   `Recover with:` 指的就是它。实测输出：
   `Recover with: agent-workflow restore …/backups/pre-migration--1-….tar.gz`。
   **运维照着做，恢复回来的还是那个坏库**，而真正可用的旧备份被挤到后面。
   两个可选修法（未做）：①`rawCopyDb` 在 manifest 读不出代次时不产出「pre-migration」名义的备份；
   ②`formatDbCorruptionGuidance` 排序时跳过本次启动刚写出的那一份。
2. **【低】`rawCopyDb` 对副本做的 `quick_check` 校验恒定失败、形同虚设。**
   `rawDbSnapshot.ts:140-147` 校验时 staging 目录里只有 `db.sqlite`（`-wal`/`-shm` 在其后几行才拷），
   而 `quickCheckDbFile` 用只读连接打开（`db/integrity.ts:43`）；WAL 库缺 `-shm` 时只读打开必然
   `unable to open database file`。实测每次 pre-migration 备份都打一行
   `WARN [rawDbSnapshot] raw db copy fails quick_check … errors=["unable to open database file"]`。
   只是 warn 不影响功能，但那道「防止拷出被截断副本」的校验从未真正生效，只剩文件大小比对。
3. **【低】`__drizzle_migrations.id` 在 SQLite 上全是 NULL。** drizzle 建表用 `SERIAL PRIMARY KEY`，
   在 SQLite 里不是 rowid 别名。任何按 `id` 定位收据行的运维 / 修复脚本都会**静默无操作**；
   `schemaAdmission.ts:210` 用它拼 `migration-extra` 的 tag，那条差异永远显示成 `receipt-null`。
4. **【低，仅源码判读，未实跑复现】零字节 `db.sqlite` 会让启动以未捕获异常收场。**
   零字节文件是合法的空 SQLite 库（`touch db.sqlite` 或一次中断的拷贝就会产生）。
   `rawDbSnapshot.ts:136-138` 的 `copySize === 0` 直接 `throw`，而 `cli/start.ts:443` 那次
   `await maybePreMigrationBackup(...)` 没有 try——异常会逃出 `startCommand`，用户拿到堆栈
   而不是可读拒绝。
5. **【账本文案偏差，已按实现处置】OPS-043「受保护家族不被裁」照抄会写出永远红的断言。**
   受保护家族（`agent-workflow-*` 手动、各 `pre-*` 族）确实不受**份数 / 天数 / 总体积**裁剪，
   但会被 `backupProtectedKeepCount`（RFC-311 C4，默认 10）**按家族各自轮换**裁掉。
   覆盖写成「不受份数与天数约束，只按各自家族的份数轮换」。
6. **【账本文案偏差】OPS-040 的「小时级」容易误导**：周期确实是 1 小时，但因为 RFC-322 的相位表，
   **首拍在 4 分钟**（`services/daemonCadence.ts:94` 的 `MAINTENANCE_PHASE.worktreeGc = 4 * MINUTE_MS`，
   硬常量、无 config 旋钮、也无 HTTP 手动入口）。按「小时级」去写等待预算会白等 56 分钟，
   或直接把这条判成不可测。这也是该 spec 单文件墙钟 ~6.9 分钟的唯一来源。

## RFC-319 B88 起草期撞到的产品缺陷（2026-08-25，doctor / migrate / db 维护域）

1. **【中】`db compact` 的回执永远报「freed 0.0 MiB」。**
   `packages/backend/src/cli/dbCompact.ts:57` 的 `const after = statSync(dbPath).size` 读在
   `finally { sqlite.close() }` **之前**，而 WAL 下 `VACUUM` 的结果要到 close 触发 checkpoint
   才落回主库。实测 21,602,304 → 3,137,536 字节（真回收 17.6 MiB），回执却打
   `file size: 20.6 MiB → 20.6 MiB (freed 0.0 MiB)`。功能是对的、回执在说谎——运维专门停一次机，
   读到「一个字节都没省」。修法：把 `after` 挪到 close 之后。
   B88 的用例**刻意没有断言那半行回执**（锁进去等于把 bug 固化），改断言磁盘上的真实收缩。
2. **【覆盖缺口，非缺陷】OPS-007（stop 超时 / 强杀以非零退出码诚实上报）在当前实现下无法端到端覆盖。**
   `main.ts:79` 调 `stopCommand()` 不传 options，CLI 没有 `--timeout` 旋钮，等待预算写死 30s
   （`cli/stop.ts:79`）；而 e2e 唯一允许的子进程边界 `e2e/command.ts` 硬超时 15s，到点子进程被打死、
   拿回 `status:-1` + 空输出——那是 harness 行为不是产品契约。`forced` 档
   （`cli/stop.ts:95`）又明写 `platform === 'win32'`，而 `@nightly` 只在 ubuntu 腿跑。
   放宽 `runCommandResult` 超时会撞 `root-test-entrypoint.test.ts` 里
   「`timeout: COMMAND_TIMEOUT_MS` 恰好出现 3 次」的守卫，属跨文件改动。
   **建议**：产品侧加 `stop --timeout <ms>`（本身也是真实运维需求），或 e2e 侧连同该守卫一起放开
   per-call 超时。在此之前 OPS-007 保持 gap。
3. **【已修，交叉印证】`migrate` / `migration-report` / `backup` / `package` 在发行单二进制上一跑就挂**
   ——起草方独立复现到与我同一条 P0（已由主干 `f565b1cb7` 修复），并额外记下一个副作用：
   失败前已把一个 4096 字节的空 `db.sqlite` 留在盘上，导致随后的 `downgrade-audit` 从
   `(no database)` 变成 `ERROR: no such table: workflows`。**新增的 OPS-012 / OPS-013 两条正是
   这条修复的回归网**：把 `migrate.ts` 倒回旧写法，两条立刻红。
4. **【账本文案偏差，已按实现处置】OPS-014 行只写「daemon 在跑时拒绝」**，而实现里
   `no-db` 与 `daemon-running` 都以退出码 1 收场、`db` 子命令写错是退出码 2
   （`main.ts:105-114`）——覆盖按源码实际分开断言。
5. **【测试基建，两条值得记】**①`e2e/` 不在 workspace typecheck 内：一个 helper 声明了
   `{code:number}` 却返回 `runCommandResult` 的 `{status}`，lint 与构建全绿、运行时拿到
   `undefined`。②**同步子进程边界与同进程 HTTP 服务端会死锁**：`execFileSync` 堵死事件循环，
   git 的请求 15s 内一次都不被 accept；最后把探针服务端挪进 worker 线程才成立。

## RFC-319 B89 起草期撞到的产品缺陷（2026-08-25，意图构建器 + 工作组）

1. **【中】过期草稿在界面上是死路，而横幅的指引是错的。**
   `services/intent/session.ts:929-951` 的 `rebaseIntentSession` 只把 `session.contextRevision + 1`，
   **不动草稿**——按下「Rebase」之后 `draft.contextRevision !== session.contextRevision` 依旧成立，
   草稿还是过期的（而且更旧），界面上按完没有任何可见变化。而
   `services/intent/iteration.ts:261-263` 的 stale 判定排在 `regenerate` 分支**之前**，于是
   `refine-current` 与「Discard and regenerate」**两条路都被 `intent-baseline-stale` 拒掉**。
   偏偏 `intent.draftStaleNotice` 的文案写的是「send a new message to regenerate」，照做必失败。
   **实际唯一出路**是去「Manage working context」改一次工作上下文（Save and generate）。
   复现：起会话拿到草稿 → `POST /api/intent-sessions/:id/mounts` 挂一个资源 → 页面转 stale →
   点 Rebase（无变化）→ composer 发消息（`intent-baseline-stale`）。
   用例**刻意没有把这个行为写成断言**（写进去等于把 bug 锁死），只断言纪元真的推进了一格。
2. **【低-中】候选历史没有内容回看入口。** `intent.detail.tsx:814-844` 只渲染「修订号 + 生命周期 chip」，
   没有任何进入旧版内容的入口；而 `GET /api/intent-sessions/:id` 其实把每一版完整的
   `changeset / validation / slots` 都返回了。账本 INTENT-13b 说「历史修订仍可回看」——
   **数据面成立、界面面不成立**。P1 用例因此把「原样读回」锁在浏览器实际收到的那份详情载荷上。
3. **【低】失败的提交不广播、前端也不 invalidate。** `routes/intentSessions.ts:970` 的广播在
   `applyIntentChangeset` 抛出后不执行，`commit.onError` 也什么都不做。提交失败时弹窗里有错误横幅，
   但**关掉弹窗后会话页的「提交记录」区不会多一条**，必须刷新页面才看得到那条 Failed 记录。
4. **【中低】`workgroup.acl.updated` 帧必然被同一次 ACL 写触发的 revalidation freeze 吞掉。**
   `services/resourceAcl.ts:944` 的 `triggerRevalidation` → `ws/connections.ts:283-288` **同步**把每条
   活连接标 `revalidating` → `routes/workgroups.ts:337-341` 的 `afterUpdate` 才广播 →
   `ws/registry.ts:1090` 对 `revalidating` 连接**直接丢帧**；而 `workgroups` 通道没实现 `resync`
   （`ws/registry.ts:729-766`），丢了就没了。实测另一标签页 30 秒内对 `/api/workgroups/{id}` 的
   GET 次数一次都不涨。`resource-acl.changed` 控制帧仍到达，所以只读/可写的界面收口是对的，
   陈旧的只是数据本身。**同形问题很可能也在 `workflow.acl.updated`（同一挂载器 + 同一 freeze）。**
5. **【低】中途改配置的判空是「键在不在」而不是「值变没变」。** `services/workgroup/configActions.ts:271-283`：
   把 `maxRounds` 原样再写一遍返回 200，并往房间插一条 `config updated: maxRounds → 4` 的系统消息。
   前端按值比对所以界面走不到；脚本 / MCP / 直调 API 的路径会。**账本 WG-34「空 patch 422」照字面写
   会得到一条永远红的用例**——覆盖按源码实际改成「空对象 + 白名单外的键」两条。
6. **【账本文案偏差】WG-45 的 `agent-missing`** 给的是**被删 agent 的名字**
   （`services/workgroup/launch.ts:249-251` 取 `member.agentName`），不是成员在组里的 displayName；
   按 displayName 写断言会永远红。
7. **【覆盖缺口，非缺陷】`workgroup-config-conflict`（并发 roster 变更 409）在 HTTP 面不可达。**
   实测 8 路并发 × 6 轮 **48/48 全 200**：handler 从入口到 `dbTxSync` 之间只有几次本地 SQLite await，
   Bun 在下一发请求到达前就跑完了。产品为此专门留了确定性竞态缝
   （`configActions.ts:110` 的 `beforeWriteTransaction`，用法见 `rfc164-workgroups.test.ts:405-430`），
   **这条闸属于后端单测层**。覆盖换成了同一 handler 里确定性可达的 `workgroup-task-terminal` 409。
8. **【环境事故，已处置】** 开工时机器 load average 194，`ps` 里有 **28 个 PPID=1 的孤儿
   `while :; do :; done` 忙循环**（启动于当日 14:32 / 14:42，已跑 7.5 小时，是某次 CPU 加压实验的
   父 shell 死掉后没执行 `kill $HOGS` 留下的）。按「ppid==1 且命令含忙循环」精确清理后，
   同一份 spec 的墙钟从 55s 降到 20s。**建议给加压脚本加 `trap`**，否则这类孤儿会一直吃满 CPU。

## RFC-319 B90 起草期撞到的产品缺陷（2026-08-25，意图时间线 + 工作组房间）

1. **【中，仅 API 可达】`POST /mount-approvals` 会把同一批追问永久锁死。**
   `services/intent/session.ts:653` 的批准事务把 `turnSeq` 推进到 `approvalTurnSeq`，而
   `services/intent/iteration.ts:472-478` 的 `reserveIntentCurrentAction` 要求
   `source.seq === session.turnSeq`。于是「先用老入口批挂载、再答追问」这条顺序下，前端
   `IntentCurrentAction` 仍渲染出待答问题（`pendingQuestions` 只看最后一条 agent turn），
   但提交必然 409 `intent-current-action-stale`，**刷新也不会好**——用户在这条会话里再也答不了
   这批追问。UI 自己不调老入口所以碰不到，任何脚本 / 集成走了老入口就会踩。
2. **【中，覆盖面】生成预算判据在仓内有四份手抄副本**：`services/intent/session.ts:437`、
   `iteration.ts:64`、`workingSet.ts:86`、`turnEngine.ts:335`，连报错文案都是复制的。
   **已被变异实证**：只改 `session.ts` 那份，UI 上的预算耗尽路径毫无变化——因为 composer 在
   「当前有草稿」时提交的是 `/iterations`，走的是 `iteration.ts` 里的另一份。
3. **【中】意图构建器整族报错没有 i18n 域，用户看到的永远是泛泛的「Request failed」。**
   `packages/frontend/src/i18n/errors.ts:57-92` 的 `DOMAIN_PREFIXES` 没有 `intent-` 条目。
   后果正落在 INTENT-20 上：唯一告诉运维「该怎么办」的那句
   `session reached its generation budget (1); raise intentBuilderMaxGenerateRounds or archive`
   **必须手动展开 `<details>` 的「Raw error message」才看得到**。`fusion-precondition-stale` 同病
   （`fusion` 域有标题没有逐码条目），而 OCC 冲突恰恰是用户必须知道原因才能决定「重发 vs 放弃」的一格。
4. **【低，UX】「回到最新」恢复的贴底状态会被异步长高的执行详情面板悄悄弄丢。**
   点击后 `intent.detail.tsx:524-530` 平滑回底并置 `conversationPinnedRef = true`，但最后一轮的
   执行详情面板是 `defaultOpen` 且事件流异步填充，回底之后卡片继续长高（实测 +220~+471px），
   顶过 `:455` 的 96px 贴底阈值 → `onScroll` 清掉贴底标记 →「回到最新」在用户没滚动的情况下自己又冒出来。
5. **【外观】意图会话页对同一个 mutation 错误渲染两遍横幅**：`intent.detail.tsx:291-298`（顶部汇总）
   与 `:589`（composer 旁）同时挂 `<ErrorBanner>`，Playwright strict mode 会撞上两个一模一样的 `<pre>`。
6. **【低，可用性】`clarifyBudget: 0` + 会反问的 agent 会让 leader 连吃 16 条失败回合而无人解释。**
   每轮 4 次 `clarify-forbidden` × 4 轮，再吃满 3 次自动 nudge 才停到 `leader-idle`。行为与 RFC-181 C 的
   drop-and-continue 设计一致，但用户在运行记录里看到 16 条红色回合、房间里只有 3 条 nudge 系统留言，
   **没有任何一句说明「它在反复想反问但被禁了」**（`clarifySuppressedNote` 确实渲染了，只是被噪音掩盖）。
7. **【测试基建，中】`fixtures/sqlite-exec.ts` 的 exec 模式建议改成逐语句 `prepare/run` 或校验 `changes()`。**
   `bun:sqlite` 的 `db.exec()` 对多语句脚本里的约束错误不抛异常（事务回滚、零行落库、调用方看到「成功」），
   全仓 e2e 的 SQL 夹具都走这条路径。最小复现与写夹具的纪律见 `docs/dev-gotchas.md` 新增的那一节。
8. **【账本文案偏差】WG-37 的四格（回复预览 / 点击跳转+聚焦+高亮 / 390px 不撑破 / reduced-motion 立即跳）
   其实已被 `e2e/rfc229-workgroup-message-quotes.spec.ts` 全覆盖**，账本记成 gap 不准。B90 补的是它没做的
   两格：被引用的是**系统**消息时作者头落到 `System`，以及高亮的**一过性**且熄灭时不收走焦点——
   因此该行的用例标题与账本措辞不同。
   另：「原消息不在房间里 ⇒ 不可用占位」这一格**在产品里不成立**（`trigger_message_id` 是自引用外键 +
   `ON DELETE SET NULL`，悬空指针存不进库；房间聚合又是按 task 全量取消息、无分页），
   要保它不腐烂应落在 `packages/frontend/tests/` 的组件单测，而不是 e2e。
9. **【账本文案偏差】WG-29「无 @ 落黑板并唤醒停机任务」有前提**：只有停机成因是 `leader-idle` /
   `clarify-or-delivery` 时，一条黑板留言才真的唤醒 leader；停在 `leader-clarify` 时
   `services/workgroup/wake.ts:249` 的 `leaderClarifyParked` 会结构性抑制 leader，此时发言不唤醒任何人。
   照字面理解成「任何 awaiting_human 都能被唤醒」会写出一条不成立的期望。

## RFC-319 B91 起草期撞到的产品缺陷（2026-08-26，仓库域 + 数字员工配置域）

1. **【中】评审 / 预览 markdown 里的工作树图片今天一律是破图。**
   `packages/frontend/src/components/prose/imageHref.ts:17` 把相对图片重写成
   `/api/worktree-files/{taskId}/{path}`，`ProseImage.tsx:46` 用普通 `<img src>` 加载它；
   而 RFC-285 B4 之后 REST 面**只认 `Authorization: Bearer`**（`auth/session.ts:246-257`，
   `?token=` 已收窄到只剩 WS 升级面），`<img>` 发不了自定义头。实测：不带头 401、
   带 `?token=` 也 401。`worktree-files.ts` 顶部注释宣称的用途（"the frontend resolves these
   to this endpoint so the browser can fetch them"）在今天的鉴权面下不成立。失败是 fail-closed
   （无安全风险）但功能已死。修法：给这条路由开受控的 query/cookie 通道，或让 `ProseImage` 走 blob 取数。
2. **【中】数字员工的「编辑」写门自相矛盾，且 govern 门可被通用端点绕过（实测确认）。**
   同一份员工、同一段内容、同一个 `write` 授权者：
   `PUT /api/code/digital-employees/:id/playbook`（**业务 UI 唯一的保存路径**，
   `routes/developmentConfig.ts:635` 用 `requireGovernable`）→ **403 `resource-govern-owner-only`**；
   而通用 CRUD `PUT /api/code/digital-employees/:id`（`:520` 用 `requireEditable`）→ **200**。
   后果两面：①「授予编辑权」在唯一的界面里等于没授（`code.config.detail.tsx:163` 的
   `canEditDraft = canUpdate` 只看 `canEdit`，那个人**看得见**「编辑草稿」按钮、填完保存吃 403）；
   ②若 `/playbook` 的 govern 门是有意的，它被通用端点原样绕过。其余四类配置资源都是
   `requireEditable`，只有员工这一族是 govern——形态上像是漏改。
3. **【低】`pre_snapshot` 是一列没有生产写点的纵深防御。**
   `util/git.ts:2388` 的 `gitStashSnapshot` 在 `packages/*/src/**` 里**零调用方**（只有 6 个测试文件引它）；
   `services/scheduler.ts:6093-6098` 明确记载 RFC-130 删掉了快照写入。于是 `resumeKick` / `retryNode`
   每次都拿 `preSnapshot=null` 走一遍恒等于「什么都不做」的回滚。回滚代码本身是好的
   （B91 的用例把快照按真实形态种进去后，它确实把工作树带回了那一刻），但**今天没有任何真实运行
   会喂给它一个非空值**。要么补写点、要么删列，不该继续悬着。
4. **【低】能力模板的复制与上游合并没有任何界面入口。**
   `packages/frontend/src/components/code/TemplateUpstreamPanel.tsx:54` 是全仓**零调用方**的组件；
   `routes/code.executors.tsx:6-11` 已在 RFC-323 退成一条 redirect。后端 7 条端点仍在装配并可用。
   账本 DE-45 的措辞在 UI 层不成立——B91 按源码实际把它写成接口面用例。删组件还是补 UI 入口是产品裁决。
5. **【低】`mount-path-*` 这一族错误码掉进 `misc` 域，用户看到最泛化的「Request failed」。**
   `packages/frontend/src/i18n/errors.ts:73-90` 的 `repo` 域前缀表里有 `repo-` / `git-` / `path-` /
   `worktree-`，**没有 `mount-path-`**；于是 `schemas/repoGroup.ts:11-17` 的五个码全落到 `misc`，
   而同一个保存动作的 `repo-group-*` 拒绝却落在 `repo` 域拿到正常标题。**路径逃逸这类最该说清楚的
   拒绝反而拿到最弱的标题。**
6. **【低-中】仓库组的 OCC 详情行永远不渲染。** `services/repoGroup.ts:576` 的 details 用
   `{ expectedVersion, actualVersion }`，而 `components/ErrorDetails.tsx:150-160` 只在
   `expectedVersion` **和 `currentVersion`** 同时是 number 时才渲染那条版本对照。全仓其余四个 OCC
   发射点（`services/task.ts:1555`、`multipartTaskStart.ts:117`、`workgroup/launch.ts:210`、
   `routes/tasks.ts:830`）用的都是 `currentVersion`——`repoGroup.ts` 是**唯一**的异类。
7. **【低】`write` 授权者的改名入口没被禁用。** `resourceAccessPolicy.ts:175-187` 对非 owner 的改名
   回 403 `resource-rename-owner-only`，而 `code.config.detail.tsx:803` 的 `config-edit-name`
   对同一个人是**可编辑**的——改完点保存才被拒。
8. **【低】仓库组重名保护有两层，服务层挂掉时用户拿到裸 500。**
   `services/repoGroup.ts:492-504` 的 `assertNameFree` 之外还有 `0131_rfc248_repo_groups.sql:37`
   的 `lower(name)` 唯一索引；后者触发时不经 `ConflictError`，直接 500。今天两层都在、不是缺陷，
   记下来是让后来者知道「可读的 409 只有服务层那道能给」。
9. **【低】`/api/capability-templates/:id` 的 404 正文回显调用方给的 id**
   （`routes/capabilityTemplates.ts:64`），与同仓其余五类配置资源的
   `NotFoundError('resource-not-found','not found')`（正文不带 id）口径不一致。
   回显的是调用方自己提供的 id，不构成存在性泄露。
10. **【低，UX】切页签会把规则的展开态吃掉**：`PolicyRuleBuilder.tsx:235` 的 `expanded` 是组件内部
    state，而 `code.policies.$id.tsx:286-325` 是条件渲染——去「模拟」跑一次再回「规则」，
    刚展开的谓词面自己收起来了。

## RFC-319 B92 起草期撞到的产品缺陷（2026-08-26，数字员工向导与案例页）

1. **【低-中】评审页「Approve」点下去后立刻导航会静默丢掉这次决定。**
   `packages/frontend/src/routes/reviews.detail.tsx:294-315` 的 `onApprove` 在无评论无草稿时直接
   `submitDecision.mutateAsync`，按钮只靠 `submitDecision.isPending` 置灰，但**不拦导航**；请求在飞时
   离开页面就被浏览器 abort，评审停在 `awaiting_review` 而界面什么都不说。
   实撞：点完 Approve 直接 `page.goto` 回案例页 ⇒ 门禁 60s 都没变成已批准。
   要求用户在 ~50ms 内离开才会踩到，但形态是「**用户以为批了、实际没批**」。
   用例改成先 `waitForResponse('/decision')` 再导航，**没有**把它写成断言（那会锁住缺陷）。
2. **【中，夹具缺口而非产品缺陷】`development` stub 无法执行 `development.plan-implementation@2`，
   整条「方案评审」分支在浏览器 e2e 里原本不可达。**
   `packages/system-mocks/src/runtime/mode-development.ts:302-303` 只认「交付三件套」形状，而方案合同是
   `outputMode: 'artifact-path'`（`digitalEmployeeToolContractsV2.ts:455`），prompt 里没有
   `OUTPUT_SCHEMA_EXAMPLE_JSON`，于是每一轮都 `fail(...)` 退避重试。这解释了既有的
   `e2e/rfc319-digital-employee-p1.spec.ts:691` 为什么断言完门禁卡就必须 `forceBlockedCase` 收摊。
   B92 没有改 `packages/system-mocks/src/**`，改用自建 Agent 把 `analysis-plan` 声明成 `markdown`
   + `review-doc` stub 绕开。**建议后续单独授权给 `mode-development.ts` 补一个 artifact-path 分支
   （写文件 + 回路径）**，否则产品主干的这一段在浏览器层长期没有可执行现场。
3. **【findings 措辞偏差，四处，已按源码实际写】**
   - DE-24：findings 说断言分段控件里没有 `'Input ID'`，而向导里那个选项的实际文案是
     **`Requirement / issue ID`**（`TaskCreationSubjectDescriptorContract.tsx:435-437`）；
     `Input ID` 是**能力图 ingress 卡片**上的文案，两处不是同一个字符串。
   - DE-19：findings 建议 `toContainText('Merged1')`——它对 `Merged10` 同样成立，也管不住四格顺序被换掉；
     改成逐格读 `[label, value]` 数组做 `toEqual`。
   - DE-30：findings 建议「等 10 秒后断言计数仍为 1」——**裸等分不清「轮询停了」和「轮询压根没起来」**；
     改成先跑一段非终态案例的对照腿（计数必须涨到 ≥3）当尺子，再在同长度窗口里断言终态计数一格不涨。
   - DE-23：findings 说夹具已给 `prepare-materials` 配了工具，实际**没有任何内置 Agent 声明
     `development.prepare-materials@3`**，只能落 `program` 执行体，且其 stdout 在发布前会被平台真跑一遍校验。

## RFC-319 B93 起草期撞到的产品缺陷（2026-08-26，资源管理：MCP / 插件 / 配置包）

1. **【真实缺陷，P2 / 可用性】MCP 表单的「schema 兜底」校验错误在界面上看不见，详情页更是全程无声。**
   `packages/frontend/src/lib/mcp-form.ts:166` 把 schema 兜底错误按**完整路径**做 key（形如
   `config.env.LD_PRELOAD`），而 `packages/frontend/src/components/mcp/McpFields.tsx:24-27` 只读
   `name` / `command` / `url` / `timeoutMs` 四个扁平 key。于是路径型 key 一个都渲染不出来：
   - `/mcps/new` 上用户只能看到页签上一颗 `!` 徽标，**没有任何文字说明哪一项非法**；
   - **详情页连徽标都没有**——`packages/frontend/src/routes/mcps.detail.tsx:193-196` 压根没配徽标，
     用户点保存后是「按钮点了没反应」，与 RES-35 在插件页修好的那类问题同形。
   B93 未就此写断言（会锁死一个错误形态）；RES-27 只断言了**请求根本没发出去**这条硬事实。
2. **【真实缺陷，P3 / 数据整洁】导入配置包时跳过可选密钥，会在库里留下一个空的承载对象。**
   `packages/backend/src/services/resourcePackage/secretInputs.ts:113-122` 跳过的密钥走
   `delete slot.parent[slot.key]`，删的是**叶子键**；当该密钥是某个对象下的唯一一项时，父对象
   会以 `config.headers: {}` 的形态留在库里。功能无害（不会误当成凭据），但存量数据会逐渐积累
   空壳字段。RES-40 断言的是「`Authorization` 这个键整个消失、绝不留 `<REDACTED:SECRET>` 字面量」，
   对空壳父对象未作判断。
3. **【账本措辞偏差，两处，已按源码实际改/写】**
   - RES-34：账本原文「**禁用** Check / Upgrade 两颗按钮」，实现是把**整块按钮区换成一条说明**
     （`plugins.detail.tsx`），按钮压根不渲染。照字面写 `toBeDisabled()` 会得到一条永远红的用例；
     用例写成 `toHaveCount(0)` + 说明可见，**并已把账本标题改准**（本批同一提交）。
   - RES-41：账本说的「提示」确实只是**提示**，不是拒绝——根类型不符时照样能提交，最终落到真正
     那类资源上。用例按这个实际形态写（info 通知 + 提交后落点断言），未把它当成一道闸。

## RFC-319 B94 起草期撞到的产品缺陷（2026-08-26，任务向导域）

1. **【真实缺陷，P3 / 工程质量，已量化爆炸半径】`tasks.new.tsx` 有三个测试锚点从未进入 DOM。**
   `packages/frontend/src/routes/tasks.new.tsx:1996`（`wizard-draft-warning`）、`:2030`
   （`wizard-draft-reentry`）、`:2072`（`wizard-outcome-unknown`）都以 **`data-testid=`** 传给
   `<NoticeBanner>`，而该组件只声明 **`testid`**（`components/NoticeBanner.tsx:29` 声明、`:110`
   渲染）且**不 spread 未声明属性**，于是这三个属性被静默丢弃。TypeScript 对**带连字符**的 JSX
   属性名不做 props 校验，所以既不报错也不生效——`getByTestId('wizard-outcome-unknown')` 恒 0 命中。
   **全仓扫描确认爆炸半径正好是这 3 处**：其余把 `data-testid` 传给自研组件的调用点，其组件要么
   显式声明了该属性、要么 spread 了 props，均正常落地。
   旁证：既有的 `e2e/rfc250-task-wizard-recovery.spec.ts:286-288` 已经改用
   `getByRole('status').filter({hasText})` 绕开它——这个坑之前踩过、没修。
   B94 按源码实际写（`.notice-banner` + 文案定位），**未改产品**；修法是三处 `data-testid=` 改
   `testid=`，属 CLAUDE.md §RFC workflow 第 6 条的「单行 bug 修复」例外，建议单独一提交并补锚点守卫。
2. **【真实缺陷，P3 / a11y】`EnumPicker` 的单选组在原生语义上不是一个 radio group。**
   `packages/frontend/src/components/launch/EnumPicker.tsx:69` 给每个选项写
   ``name={`enum-${c}`}``——**每个 radio 各自一个 name**，于是键盘方向键不能在组内移动、屏幕
   阅读器读不出「第 N / 共 M」，互斥只靠 React 受控 `checked` 维持；同页出现两个 choices 相同的
   enum 输入时 name 还会撞车。
3. **【账本措辞偏差，两处，已按源码实际写】**
   - TASK-14：账本把「git 身份」列进「高级折叠区」，它**不是**折叠区里的字段——确认页上是一行
     只读摘要（`tasks.new.tsx:2716-2727`），值由服务端从账户档案派生（RFC-320，
     `modules/identity-access/application/queries/getUserProfile.ts:14-16`），用户在向导里改不了。
     照账本字面写会得到一条永远红的用例。
   - TASK-13：实际「拦截」比措辞更彻底——快照过期时 `normalizedWorkflowRevision` 永不设置 ⇒
     `draftSeedReady` 恒 false ⇒ `materialLocked` 恒 true，**整块 `fieldset.task-wizard__material`
     冻结**，用户连执行空间都改不了，而不只是启动键置灰。用例按实际形态写，并配了「不带版本参数
     时表单可编辑」的正向对照，避免变成恒真断言。
4. **【设计取舍，非缺陷，但账本一句话读不出来】TASK-06 的「失败可见性」在两条启动臂上形状不同。**
   agent 臂 = 同步 422 + 向导原地横幅 + **不铸任务行**；workflow 臂 = RFC-287 G7 的延后准备 ⇒
   **先铸 pending 行、后台失败转 failed**（`packages/backend/src/routes/tasks.ts:330-334` 注释明说
   只有那条 JSON-body 路由打开 `deferRepoPreparation`）。B94 只覆盖了 agent 臂那一半。

## RFC-319 B95 起草期撞到的产品缺陷（2026-08-26，设置 / 配置分区）

1. **【真实缺陷，P3 / 死旋钮，已全仓核实】`largeOutputThresholdBytes` 全仓零消费方。**
   设置页 Limits 分区那格「Large output threshold (bytes)」改得动、存得下、落得进
   `config.json`，但**没有任何代码读它**。全仓命中只有 schema + 默认值 + patch
   （`shared/schemas/config.ts`）、数值边界（`shared/settingsNumericBounds.ts`）、
   前端草稿白名单与设置页控件（`frontend/src/lib/settings-drafts.ts`、`routes/settings.tsx`）
   与 i18n；**`packages/backend/src` 下 0 命中**（本人复核：`grep -rni largeoutput
   packages/backend/src | wc -l` = 0）。复现：改成 65536 保存 → 配置里有值 → 起任何任务、
   产出任意大小输出，行为与默认值毫无区别。建议要么接线、要么从设置页下架。
   B95 **未就此写断言**——断言「它不生效」等于把缺陷固化进判据。
2. **【账本措辞与实现不符，已按源码实际写】CFG-X1 的六项预算只有三项真被新任务采用。**
   进启动漏斗的只有 `defaultPerNodeTimeoutMs` / `defaultNodeRetries` / `sessionRestartBudget`
   （`services/launchRuntimeConfig.ts:154-171` → `services/startTaskDeps.ts:51`，每次启动重读）。
   `defaultPerTaskMaxDurationMs` / `defaultPerTaskMaxTotalTokens` 是 **RFC-108 PR-B 刻意不接线**
   （存量 config 持久化着旧的 1h 默认值，一旦消费会被 limits ticker 当硬上限取消任务，而
   `canceled` 不可 resume），并由 `packages/backend/tests/rfc108-launch-budget-timeout-floor.test.ts:50-56`
   正面锁着「不许泄漏这两个字段」——**照账本字面写会得到一条永远红的用例**。用例因此对这三项只断言
   「存得住 + 落盘」，对另外三项断言「新任务真的按它跑」。
3. **【文档层面容易误导，非缺陷】两条实现细节**
   - `POST /api/auth/pats` 的 scopes **不接受读点**：`grantableMatrixPoints`
     （`shared/schemas/permission.ts:1312-1318`）显式排除 `READ_POINTS`，写
     `scopes:['tasks:read']` 会被 `pat-scope-ungrantable` 拒；读权限由 `resolveTokenPermissions`
     （:1293-1303）按账号自动并入。
   - `mcpSurfaceEnabled` 的界面入口在 **Network 分区**（`?tab=network`），不是一个独立的
     「MCP 外部访问」分区——账本措辞会让人去找一个不存在的分区。

## RFC-319 B96 起草期撞到的产品缺陷（2026-08-26，事件中心视图域）

1. **【真实缺陷，P2】事件总览的「待处理投递」卡片统计的是「当前那一页」，不是全局。**
   `packages/frontend/src/routes/events.tsx:589-600` + `:257-270` 统计 `deliveries.data.items`
   （`limit=50`）。投递超过 50 条时系统性低估积压；更糟的是这个 query 跟着用户在「投递记录」
   页签里选的**状态 / 消费者筛选与页码**走——在投递页选了「已确认」再切回总览，卡片显示 0。
   复现：种 60 条 pending 投递 → 总览显示 50；再去投递页选「已确认」→ 回总览显示 0。
   用例因此**没有钉绝对值**，改成「翻某几条投递的状态、看卡片相对增减」的因果断言。
2. **【真实缺陷，P3】投递记录的空态不区分「真的没有」与「筛出来是空」。**
   `events.tsx:1075-1079` 恒用「还没有事件投递」文案。同一页面的 `DeliveriesPanel` 已经区分了
   `empty` / `filteredEmpty` 两档，这里没跟上。
3. **【真实缺陷，P3 / 死代码】`routes/webhooks.tsx:38-53` 的 `beforeLoad` 无条件
   `throw redirect`，`component: WebhooksPage` 永不渲染。** `WebhooksPage` / `WebhookManagement`
   整块、`webhooksPage.*` 一族 i18n key、`webhooks-tab-*` / `webhooks-panel-*` 全是死代码。
   **附带（本人变异实测）**：该重定向上的 `replace: true`（`:50`）在**任何可达路径上都没有可观测
   差异**——全仓没有任何指向 `/webhooks` 的应用内客户端链接（`to=`/`href=`/`navigate()` 三种写法
   均 0 命中），只能靠书签 / 粘贴地址整页加载进入，而整页加载时路由器的重定向本就替换而非压栈。
   去掉它 EVENT-X6 不红，这是「分支不可达」而非「用例假」。清理该页时可一并处置。
4. **【无缺陷，但反直觉，值得记档】触发规则的 `enabled` 闸有三层，改错层会白忙。**
   `services/webhookDispatch.ts:1184` 在现行事件中心链路上**不生效**（实测去掉行为不变）；
   真正生效的是 `modules/integration/infrastructure/sqliteCodeHostEventResponseDirectory.ts:76`
   的 `matching()`；第三层是 `event-routing-subscription-inactive` 的 422 兜底。
5. **【账本措辞与实现不符，四处，已按源码实际写】**
   - EVENT-34 漏掉最强的那条语义：**只出公开目录里的事件类型**。每次 Webhook 入站会发布**两条**
     `event_records`（兼容层 `code-host.event.*` + 公开的 `code-host.*`），全靠
     `sqliteEventStore.ts:896` 的 `eq(catalogVisibility,'public')` 挡住；这层一破用户会把同一次推送
     数成两次，且泄漏行标题退化成裸 id。照账本字面写只会得到「筛完还有行」级别的弱断言。
   - EVENT-29 措辞暗示四张卡都是全局统计，实际「待处理投递」是当前页统计（见第 1 条）。
   - EVENT-32 的「统一分页」不是一次 SQL 查两种，而是「exact 表分页 + 路由目录**全量内存合并**」
     （`eventCenterService.ts:352-376`），不加筛选的总数会随触发规则条数浮动。
   - EVENT-24 的级联**不在服务层**（`services/webhookTriggers.ts:373-381` 只删主行），靠 FK
     `ON DELETE CASCADE` + 运行时 `foreign_keys=ON`（`db/client.ts:243-250`）。
6. **【语料设计取舍，接手者须知】** 事件中心有个后台通知 worker 会认领并 dead-letter 所有
   `subscriberKind='automation'` 的投递（`eventCenterService.ts:668-693` + `cli/start.ts:820-822`）。
   本文件的消费者刻意用 `employee-case` / `system` 两种**没有注册消费者**的 kind——否则种下的投递
   状态几秒内就被后台改光，所有状态断言全是薄冰。改这份语料的人请保留这一点。

## RFC-319 B97 起草期撞到的产品缺陷（2026-08-26，任务详情页签域）

1. **【真实缺陷，严重度高，本人逐处复核过】~~「重试仓库准备」在任何启用了 `secret.key` 的部署里
   必然失败，且错误文案把原因指错方向。~~ —— 已于 2026-08-26 的 `3cc81b245` 修复（两处补 `secretBox`
   + `packages/backend/tests/repo-prep-retry-secretbox.test.ts` 先红后绿上锁）。下文保留原始诊断作为
   同类 bug 的判例：手搓 deps 就会漏字段，这已是第二次复发。**
   启动路径构造依赖时带着密钥箱：`packages/backend/src/routes/tasks.ts:321`
   `...buildStartTaskDeps(deps.db, deps.configPath, actor.user.id, deps.secretBox)`。
   而**重试路径手搓 deps、没有 `secretBox`**（`routes/tasks.ts:998-1006` 只给了
   `db` / `configPath` / `subagentLiveCapture` / `resolveLaunchRuntimeConfig`）。于是
   `retryRepoPreparation → startTask` 走到 `services/task.ts:1050` 的
   `unsealRepoUrl(row, deps.secretBox /* undefined */, deps.db)`：
   `services/repoCredentials.ts:105-111` 对「已封存但没有密钥箱」这一档**直接返回 null**，
   `task.ts:1051-1057` 随即抛 409 `cached-repo-credential-unavailable`，文案却写着
   **「sealed with a different secret.key?」**——真实原因是压根没接密钥箱，不是密钥换了。
   **同一缺口也在 boot 自动恢复的注入点**：`cli/start.ts:1492-1500` 的 `resumeDeps` 同样手搓、
   同样没有 `secretBox`（对照同文件 `:1097` / `:1128` / `:1282` 三处都老老实实走
   `buildStartTaskDeps(db, Paths.config, SYSTEM_USER_ID, secretBox)`）。因此
   `autoResumeOnBoot` 下这类任务每次 boot 白撞一次，直到被熔断隔离。
   **RFC-287 AC-11 承诺的这条唯一出口在真实部署里 100% 不可用**；它能活到今天，是因为
   `e2e/rfc319-repo-mirrors-and-launch.spec.ts` 的 REPO-15 只断言按钮**可见**、从没点过它。
   B97 **刻意不把「必然失败」写进断言**——那会变成一条阻止修复的用例。**修复已落地**（`3cc81b245`）：
   两处各补一个 `secretBox`，属 CLAUDE.md §RFC workflow 第 6 条的「单行 bug 修复」例外；
   错误文案的误导性措辞（「sealed with a different secret.key?」）**尚未改**，仍是待办。
2. **【真实缺陷，P2 / 可用性】节点抽屉对 `done` 的 run 不给重试入口，后端却是允许的。**
   `components/tasks/NodeDetailDrawer.tsx:675-686` 的 `canRetryNodeRun` 不放行 `done`，而
   `services/task.ts:5526-5536` 的 `retryNode` allowedFrom **含 `done`**。结果「重跑一个已成功的
   节点」在界面上没有任何入口，只能直接调接口。这直接决定了 TASK-26 的可测形状——必须构造
   「上游有一次失败的历史尝试、重试后成功、下游已跑完」，再从 Stats 页签的运行历史点回那次失败尝试。
3. **【真实缺陷，P3 / UX】「全部改动被排除」呈现为绿色成功 chip。**
   `routes/tasks.detail.tsx:1930` 用 `nodeRunStatusToKind(run.status)`，而 `skipped-excluded` 的 run
   状态是 `done`，于是「什么都没推上去」显示成绿色成功（文案 `Only excluded changes`）。未写成断言。
4. **【账本措辞与实现不符，已按源码实际写】TASK-26 的「级联下游开关」并不控制「下游是否重跑」。**
   实测 `rerunCause` 序列：`cascade=false` 时下游**照样重跑**——上游产出变新，引擎按
   `stale-redispatch` 自行重派（`services/scheduler.ts:2565` 的 `isNodeRunFresh`）。开关真正控制的是
   「是否给下游铸 `retry-node-cascade` 作废行」以及是否取消下游 CALL 行的子任务。照账本字面写
   「下游不被重跑」会得到一条**永远红**的用例。判据因此改成对账 `rerunCause`：关掉 =
   `['initial','stale-redispatch']`，打开 = `['initial','stale-redispatch','retry-node-cascade','revival']`。
5. **【环境边界，非产品缺陷】TASK-X2 的「按需生成」在 e2e 里必然以失败收场**：变更叙述走
   `runSystemAgent`，其提示词不带 RFC-200 信封 nonce，而所有 stub 都在
   `packages/system-mocks/src/runtime/skeleton.ts:137-143` 的 `requireOutputOpen` 上 exit 3。
   所以「按需生成」那支锁的是**接线**（按钮真发 POST、守护进程真跑一趟、界面真把结果轮询回来
   并改写自己），「查看」那支按产品真实读路径（磁盘缓存 → GET → ready）写。

## RFC-319 B98 起草期撞到的产品缺陷（2026-08-26，前端外壳 / 登录回环 / 恢复）

1. **【真实缺陷，P2】全仓没有任何路由级错误边界。**
   `packages/frontend/src` 里 `errorComponent` / `notFoundComponent` / `CatchBoundary` /
   `ErrorBoundary` **零命中**，`router.tsx:184-188` 也没有 `defaultErrorComponent`。未知路由今天靠
   TanStack 的默认 Not Found 呈现（外壳仍在、可恢复，所以 UX-38 是绿的），但**任何路由组件抛异常
   都会整树白屏**，没有兜底。账本 UX-38 写的「路由级错误边界」这一半在产品里并不存在。
2. **【真实缺陷，P2】`copyText()` 的成功回执可以说谎。**
   `packages/frontend/src/lib/clipboard.ts:49` 拿 `document.execCommand('copy')` 的返回值当「复制
   成功」。变异实测：Chromium 在**选区为空**时照样返回 `true`，界面报「Copied」而剪贴板一个字节
   都没变。今天靠 `:47` 的 `ta.select()` 兜着，但一旦有人重构掉它，**只显示一次的 PAT 明文会静默
   丢失**。B98 已把这条钉死——UX-X2 改成「写哨兵值 → 复制 → 从另一个 page 读回系统剪贴板」，
   不再信任返回值。
3. **【真实缺陷，P3 / i18n】`RelativeTime` 的 `aria-label` 在英文界面里硬编码 CJK 全角括号。**
   `packages/frontend/src/components/RelativeTime.tsx:41` 是 ``aria-label={`${label}（${absolute}）`}``，
   不走 i18n，英文读屏用户会听到全角括号。UX-X4 的断言**按源码实际写**（`/3 min ago（.+）/`），
   不是按「应该」写。
4. **【真实缺陷，P3 / 一致性】`/agents` 列表行不显示相对时间，`/skills` `/mcps` `/plugins` 显示。**
   后三者都往 `ResourceSplitPage` 传了 `updatedAt`，只有 `routes/agents.tsx` 没传，于是
   `ResourceSplitPage.tsx:470-473` 那段在 `/agents` 上整段不渲染。同一套分栏列表四个域三种行为。
5. **【真实缺陷，P3 / 文案】首启欢迎屏说「Four tracks」，界面只渲染三张。**
   `packages/frontend/src/i18n/en-US.ts:2932-2933` 写 `'Four tracks: …'` 并列举四件事，而
   `components/Onboarding.tsx:93` 的 `tracks` 与 `routes/onboarding.tsx:24-28` 的 `FLOWS` 都只有三条。
6. **【测试判据自身的缺口，已就地补强】开放重定向防线的「协议相对」半边此前没人守。**
   `routes/auth.tsx:29-32` 的 `safeInternalRedirect` 用 `/^\/(?![/\\])/`，那个 lookahead 专为
   `//evil.example/x`（浏览器当成另一个主机）与 `/\evil.example/x` 写。起草版只试了
   `https://evil.example/x`——把 lookahead 去掉只留 `/^\//`，绝对地址那条照样被拒、用例照样绿。
   本人变异实测发现后已在 UX-04 补上这两种形态，补后同一变异当场红。
7. **【可测性缺口，记档】UX-11 的「Activity hidden + 导航阻断」半边今天无法从测试端构造。**
   `AppShell.tsx:119-124` 的 `preserveDestination` 需要「同一路径先被授权过、随后 `/me` 回到
   pending/error」；React Query 在已有 data 后失败会保留 `status:'success'`，只有 queryKey 变
   （换 token）才回 pending，而 `stores/auth.ts` 没有 storage 监听，测试端换不了 token。B98 覆盖的
   是冷加载那一支（未解出 → 不挂载 + 可重试横幅 + 重试恢复）。
8. **【账本核对，未改状态】UX 域有十行标着 gap、实际已有真覆盖**（UX-05/06 → `identity-access.spec.ts`；
   UX-24 → `inbox-badge-live.spec.ts`；UX-26 → `rfc319-settings-sections.spec.ts`；UX-34 →
   `rfc319-agent-delete-and-refs.spec.ts`；UX-36 → `rfc244-task-operations.spec.ts` 等；UX-39 →
   `rfc319-users-and-account.spec.ts`；UX-40 → `rfc319-memory-fusion-and-badges.spec.ts`；UX-41 →
   `rfc199-save-reliability.spec.ts`；UX-33 → `rfc319-event-center-views.spec.ts`）。**本批没有据此
   改状态**——逐条核验证据标题是否逐字存在、tier 是否对得上，是一次独立的对账工作，留给后续批次。

## RFC-319 B99 / B100 起草期撞到的产品缺陷（2026-08-26，数字员工授权 + 身份与权限）

1. **【真实缺陷，P2 / 授权边界，本人按源码复核 + 起草侧实跑复现】仓库组作用域只在前端收窄，
   服务端不校验组成员资格。**
   `packages/backend/src/modules/development-automation/composition/employeeTypePackage.ts:3730-3739`
   里那道「目标仓库必须落在员工职责范围内」的判据**只覆盖 `scope.kind === 'repository'`**；
   `repository-group` 分支直接 `repositoryRef = requestedRepositoryRef`，**没有任何组成员校验**。
   起草侧实跑复现：给一个 `workScope = {kind:'repository-group', repositoryGroupId: G}` 的员工直接
   `POST /api/digital-employees/{id}/cases`，`target.repositoryId` 填一个**组外**仓库 → **HTTP 201，
   案例正常建立**。用户面影响：任何能发起任务的人（含脚本 / PAT 路径）可以让一名「只负责 A 组」的
   员工去改 A 组之外的仓库，而它的连接 / 策略 / 岗位配置对那个仓库并不适用。
   **不对称本身就是判据**：单仓那半边是严格校验的，组那半边不是。
   B99 **未写成断言**（写 403 是假期望、写 201 是把缺陷固化），DE-X5 只锁前端清单收窄那半边。
   **修法需要决定语义**（在 intake 处按哪一份组快照校验成员资格），不属「单行 bug 修复」例外，
   建议单独立 RFC 或至少呈用户裁决后再动。
2. **【真实缺陷，P2】前端对 `forcePasswordChange` 零消费——「强制改密」只活在数据库列里。**
   后端三处信号齐全（`routes/auth.ts:121` 登录回执带 `mustChangePassword`、`:294-310` 置位期间放行
   省略的 `oldPassword` 并在改完后清零、用户行有列），而
   `grep -rn "mustChangePassword\|forcePasswordChange" packages/frontend/src` **零命中**：登录页拿到
   回执直接 `setToken` + 跳转（`routes/auth.tsx:201-206`），`GET /api/auth/me` 也不回这个字段。
   复现：`/users` → Manage → Reset password → 勾「Require another password change at next sign-in」
   （**默认就是开**）→ 该用户用临时口令登录 → 直接进 `/agents`，界面自始至终不提改密。后果是管理员
   发出去的临时口令会被长期使用。IAM-X1 **只锁后端三处信号、刻意不锁跳转目的地**，将来补引导页时
   这条用例应当依旧全绿。
3. **【真实缺陷，P2】`AclPanel` 把 409 静默吞掉：用户的改动被丢弃且零反馈。**
   `components/AclPanel.tsx:599` 的错误段要求 `mutationBelongsToSession`；而 `onError` 自己触发的
   `invalidateQueries`（`:271`）会把 `fetchStatus` 变成 `'fetching'` ⇒ `liveCanManage` 转假（`:186-196`）
   ⇒ `lostManage` 判真（`:275,290`）⇒ `manageSessionRef += 1` + `setDirty(false)` + `save.reset()`。
   起草侧实测：409 之后 4 秒内 40 次采样，`.form-actions__error` **恒空**、`acl-save` **恒 disabled**。
   同段注释（`:264-272`）写着「The error text shows via describeApiError」——**这句承诺现在不成立**。
   服务端没有被覆盖（`aclRevision` 仍是并发写者的），所以是反馈缺失而非数据损坏。
4. **【真实缺陷，P3】内置资源的权限弹窗仍提供一个必然失败的保存入口。**
   `services/resourceAcl.ts:741` 的 `canManage` 只看 `canGovernAccess`、不看 `builtin`，而
   `routes/resourceAcl.ts:184-185` 的 `assertNotBuiltin` 一定把保存打回 `builtin-readonly`。
5. **【真实缺陷，P3 / 死代码】OIDC「把第二个身份绑到已登录账号」这条路径没有入口。**
   `auth/oidc/flow.ts:50` 的 `linkUserId` 与 `routes/oidc-auth.ts:185-208` 的整段 link 分支存在，
   但全仓没有任何调用方传 `linkUserId`，`/account` 上也没有「关联身份提供方」按钮。
6. **【真实缺陷，P3 / i18n】`workScopeSummary` 被硬编码冻结成中文。**
   `modules/digital-employee/application/authoringService.ts:2785` 写死
   `runtime.summarizeWorkScope(encodedScope, 'zh-CN')`，与查看者语言无关；英文界面的员工卡片摘要
   会念出「任务启动时指定仓库」。DE-16b 因此改断言「卡片里不得出现具体仓库 URL」（语言无关）。
7. **【测试判据自身的缺口，已就地修好】IAM-48 的「内置代理不进用户面列表」原本是一条恒真断言。**
   起草版写 `getByRole('link', { name: 'aw-skill-merger', exact: true })` → `toHaveCount(0)`，而
   `ResourceSplitPage` 的卡片是整块 `<Link>`，可访问名是卡内全部可见文字拼起来的（名字 + 描述 +
   徽标），`exact: true` **在场也匹配不到**。本人变异实测：把 `routes/agents.ts:113` 的
   `excludeBuiltinAgents` 整个摘掉，用例照样绿。已改成按卡片自己的 testid
   （`split-card-${BUILTIN_MERGER_AGENT_ID}`）定位，改后同一变异当场红。工作流那半边用的是真 testid
   （`workflow-card-aw-skill-fusion`），本来就是好的。
8. **【账本措辞与实现不符，已按源码实际写】**
   - IAM-35 的标题「配置资源写门只认 owner」在 RFC-324 之后不再成立：`write` 档授权者**可以**
     revise / publish（`services/resourceAcl.ts:643-660`），只有治理面（archive / 改名 / 转让 / 再授权）
     仍只认 owner（`:621-633`）。用例写成 public → read → write 三档矩阵。
   - DE-X4 的「体积上限校验」实现回的是 **422 `employee-upload-too-large`**，不是直觉上的 400/413。
   - DE-08 的 program 工具授权门与**工作流里 script 节点的 `scripts:author` 字段门**
     （`services/scriptAuthorGate.ts:46`）是两道门；夹具必须由 admin 建合同工作流，否则这条用例
     证的是另一道门。

## RFC-319 B101 起草期撞到的产品缺陷（2026-08-26，工作流检查器 / 画布右键）

1. **【真实缺陷，中高，起草侧实跑复现 + 本人按源码复核】右键菜单不会把命中的节点真正纳入选择，
   于是「删除」删错对象。**
   `packages/frontend/src/components/canvas/WorkflowCanvas.tsx:2658-2661` 的 `handleNodeContextMenu`
   在右键时写 `setSelection({nodes:[node.id],edges:[]})`，注释也写明「Make sure the right-clicked node
   is part of the selection」；而 `:2903-2921` 的 `onSelectionChange` 会在**任何 node/edge 更新之后
   重新触发**（该处注释自己写着这一点），用 xyflow 侧仍然只含**旧**节点的 `selected` 标志把
   `selection` 盖回去——右键**不会**翻转 xyflow 的 `selected` 标志。于是 `:1967-1993` 的
   `deleteSelected` 读到的是旧选择。
   **复现**：先左键点中节点 `inner`，再**右键** `alpha` → 菜单 → Delete。落库结果是 `['alpha','box']`
   ——被删掉的是 `inner`，`alpha` 还在。同一根因也解释了已记录的「Ctrl+A /『Select all』是空操作」
   （`:1921-1927` 同样只写 React 侧选择态）；菜单里的 Copy 读同一份 `selection`，很可能同样错位。
   **严重度中高**：删除不可逆，且用户没有任何视觉线索（右键不改任何 `selected` 类）。
   B101 未把错位行为写成期望，WF-15 只验「右键命中的就是当前选中的那个」这条正常路径，并在用例
   上方注释存证。
2. **【账本与实现不符：两条假 gap，建议改账本而不是新写用例】**
   - **WF-X2「聚焦选中」相机动作**已被 `e2e/rfc250-workflow-camera.spec.ts:1005` 完整覆盖（无选中时
     按钮 disabled → 选中后 enabled → 点下去缩放真的上去且 `data-camera-mode='readable-focus'`），
     只是那条 test 的标题挂的是 **WF-23**。建议把 WF-X2 的 evidence 指向同一条 test，或与 WF-23 合并。
   - **WF-25「模板起步弹窗」**已被 `e2e/rfc319-canvas-editing-ops.spec.ts:872` 的 WF-24 用例覆盖到底
     （选模板 → 逐字预览 `Creates 3 nodes and 2 connections.` → apply 后节点/边/inputs 全部回读落库
     → 一次撤销退回空画布）。**唯一真正没覆盖的残余**是「画布非空时先要一次『替换』二次确认」
     （`WorkflowStarterDialog.tsx:221-225`）。建议 WF-25 降为 partial 并把口径收窄到那条分支。
   - **本批未据此改任何行的 status**——逐条核验证据标题是否逐字存在、tier 是否对得上，是一次独立的
     对账工作。
3. **【产品可达性，建议账本改挂】WF-X5「code-round 节点的只读检查器」在工作流编辑器里不可达。**
   `packages/shared/src/schemas/workflow.ts:81` 的 `SYNTHESIZED_ONLY_NODE_KINDS` +
   `workflow.validator.ts:1350` 明确拒绝任何用户提交的定义里出现 `code-round`，
   `nodePalette.ts:241-248` 也把它归进 `internal` 段、`buildPalette` 不产出。它只在**已跑完的
   code-round 任务快照**里可达。建议 WF-X5 的证据改挂到数字员工 / code-round 任务详情那条链
   （`rfc319-digital-employee-*` 域），不属于 WF 前缀。

## RFC-319 B102 起草期撞到的产品缺陷（2026-08-26，代理编辑与资源配置）

1. **【账本措辞与实现不符 + 一条真缺口，P3】AGENT-28 的「体积上限」在实现里根本不存在。**
   `packages/frontend/src/lib/agent-import-preview.ts:193-196` 的 `validateAgentMarkdownFile`
   **只判扩展名**；`components/FileDropzone.tsx` 没有 `maxBytes`；`AgentImportDialog.tsx:276` 直接
   `await file.text()` 把整个文件读进内存。照账本字面写「超出体积上限」会得到一条**永远红**的用例，
   B102 因此只锁扩展名闸。严重度 P3（纯前端本地读取、无服务端放大），但「一个 800MB 的 .md 会让
   标签页卡死」这条路今天确实敞着。建议把账本这一行的措辞改成「扩展名」，或另立产品 issue。
2. **【实测记录，非缺陷，防未来误删】`isRuntimeOnlyAgentPatch` 是内置代理写面的唯一防线，没有第二条腿。**
   起草侧变异实测：把 `routes/agents.ts:274` 的
   `if (!(isBuiltinRow(existing) && isRuntimeOnlyAgentPatch(body)))` 放宽成 `if (!isBuiltinRow(existing))`
   之后，一发 `{runtime, description}` 的混合补丁**真的把 `description` 写进了 `aw-skill-merger` 行**。
   与下面第 3 条形成对照：这条没有任何兜底，AGENT-45 的价值因此高于起初估计。
3. **【实测记录，非缺陷，防未来误删】`agent-name-in-use` 的 409 靠两条腿，两条都删会降级成 500。**
   `services/agent.ts:826-828` 的事务内重名预检 + `:840-846` 把 `agents_owner_name_unique` 违例
   重映射成同一个 `ConflictError`。变异实测：只删预检仍 409（DB 兜住）；两条腿都删，用户拿到
   `{"code":"internal-error"}` **500**。记此以免未来「清理冗余」的重构把它当死代码删掉。
4. **【e2e 基建缺口，挡住三条能力，需单列任务】RES-30 / RES-32 / RES-33（npm registry 安装 / 检查更新 /
   升级基线）今天无法覆盖。** `services/pluginInstaller.ts:236-280` 走的是**真 `npm install`**
   （PATH 没有 npm 就 `npm-unavailable`），而 `e2e/harness.ts:596-610` **没有**把
   `AW_SYSTEM_MOCK_NPM_REGISTRY_URL` 接成 `npm_config_registry`——直接写用例会去打真实 registry
   （网络依赖 + 不确定性，CI 上大概率红）。要覆盖必须先给 harness 加一行 registry env 接线，
   属 e2e 基建改动，超出本批「零生产改动」授权。**建议单列一条 harness 任务后再回填这三行。**
5. **【账本核对，未改状态】两条疑似假 gap**（与 B98 §8 同类，仍留待独立对账）：
   - **AGENT-39「从配置包创建代理」**——`e2e/config-package-import.spec.ts` 三条用例整条流水线都在
     `/agents/new` 的导入配置包页签上跑（预览干跑 + 两项新建 + 复用既有），只是证据登记在 RES-39 名下。
   - **AGENT-X1「设置页给内置 aw-skill-merger 换 runtime 并保存」**——
     `e2e/rfc319-settings-config-sections.spec.ts` 的 CFG-21 / CFG-22 已走完整条界面路径并回读
     `/api/agents/00000000000000000000000001` 断言 `runtime` 落库。
   B102 因此**没有**写重复用例，改去补它们没碰的写面边界（AGENT-45）。
6. **【按源码实际改写的断言】`resolveRefsUsableById` 的 `missing` 回显的是输入 token 而非展示名**
   （`services/resourceRefs.ts:411`，正确行为）：实测形状是 `[{type:'agent', name:'<输入的 id>'}]`。
   顺手把「响应体里不得出现那条私有资源的展示名」锁成断言——这条 D1 隐私性质此前在 e2e 侧无人看守。

## RFC-319 B103 起草期撞到的产品缺陷（2026-08-26，记忆注入 + 工作组房间）

1. **【真实缺陷，P2 / i18n，本人复核确认】注入快照卡的 `repo_group` 分档没有文案，界面直接打出原始 key。**
   `packages/frontend/src/lib/injected-memories-card.ts:40` 的 `SCOPE_ORDER` 自 RFC-248 起是**五档**
   （`agent / workflow / repo / repo_group / global`），而
   `packages/frontend/src/i18n/en-US.ts:6729-6732` 与 `zh-CN.ts:12855-12858` 只有**四条**
   （agent / workflow / repo / global，本人 grep 确认无 `repo_group`）。
   `components/node-session/InjectedMemoriesCard.tsx:66-72,100-106` 按
   `nodeDrawer.injectedMemoriesGroup_${scope}` 取文案，于是该档的 chip 与小标题直接显示
   `nodeDrawer.injectedMemoriesGroup_repo_group`。旁证：组件里那两处 `as` 联合类型也只列了四个字面量。
   复现：仓库组启动 + 一条 `repo_group` scope 的已批准记忆 → 跑完 → `/tasks/:id` 点 agent 节点 →
   展开 Injected memories。B103 因此只断言结构 class（`.injected-memories-card__group--repo_group`），
   **没有**把这个文案写进断言。
2. **【死分支，如实登记，不为可测而改产品】MEM-49 的「候选行语言徽标」在产品里够不到。**
   `components/memory/MemoryRow.tsx:70-79` 的徽标只在 `memory.status === 'candidate'` 时渲染，而
   `MemoryRow` 全仓三个消费方**全部只拉 approved/archived**：`MemoryAllList.tsx:81`（`status: view`，
   `view` 类型即 `'approved' | 'archived'`）、`MemoryByScopeBrowser.tsx:24`、`MemoryScopedList.tsx:30`。
   候选行走的是 `MemoryApprovalQueue`，根本不用 `MemoryRow`。`services/memory.ts:266-274` 那段专门为
   候选行算 `outputLang` 的代码同样没有用户面读点。
3. **【覆盖边界，如实登记】WG-40 的「同批 ×N」徽记在现有 showcase 夹具下够不到正向。**
   `FcTaskListCard.tsx:56` 要求两张卡共用同一个 `nodeRunId`，而该场景跑出的三张卡各自独占一个 run
   （批量认领都是 batch of 1）。判据因此写成「徽记数 == 共用 run 的卡数」——它锁的是**反方向**
   （改成 `>= 1` 会给每张卡挂「同批 ×1」，变异当场红），正向那一半如实登记为未覆盖。
4. **【账本核对：八处假 gap，本批据此换掉了原定条目，未改任何行的 status】**
   - MEM-21 / MEM-X2 / MEM-X3 → `e2e/fusion-review-surface.spec.ts:285/427/469/521` 已完整覆盖
     （融合分区列表 + 徽章 + 空/错态互斥 + 点行进详情、带反馈驳回 → iteration+1、两步确认取消）。
   - MEM-43 / MEM-X10 → `e2e/task-feedback-distill.spec.ts`（登记在 HUMAN-47 / HUMAN-X6 名下）四条
     用例已锁「写下去真的排进蒸馏 + 已送蒸馏标」「3 秒节流」「看不见与不存在逐字节同形」「深链落到
     具体那一条」。B103 只补 MEM-44 剩下的半边（失败横幅 + 草稿不丢）。
   - MEM-49 的设置页半边 → `e2e/rfc319-settings-config-sections.spec.ts` 的 CFG-21 已走过
     `Memory distill runtime` 选择器与语言选择，一次保存落库 + 落盘 + 重载回显。
   与 B98 §8、B102 §5 同类，仍留待一次独立的账本对账。
5. **【三层冗余守卫，实测记录】动态工作流组「没有聊天室」由三层保证，只掐前两层不红。**
   `lib/task-detail-tabs.ts:263` 的 capability、`DYNAMIC_WORKGROUP_TAB_ORDER`（不含 chatroom）、
   以及 `routes/tasks.detail.tsx:376` 的硬编码 `chatroom: false`。本人变异实测：前两层同时掐死，
   WG-X3 仍绿——决定性的是路由层那一处覆盖。记此以免未来重构误判前两层是死代码。

## RFC-319 B104 起草期撞到的产品缺陷（2026-08-26，意图会话 + 设置分区）

1. **【疑似真缺陷，中高，未写成断言，建议单独立 issue 复核】call-workgroup 节点在 scratch 父任务下
   永久卡在「发起子任务之前」，且零日志。**
   起草侧全走产品接口复现：建普通 agent → 建 `mode:'leader_worker'` 且成员只含该 agent 的工作组 →
   建只含 `{kind:'call-workgroup', workgroupName, workgroupId, goalTemplate}` + `output` 的工作流 →
   `POST /api/tasks { workflowId, name, scratch: true }`。
   现象：`node_runs` 里 `call_wg` 一直 `status='running'`、`child_task_id=null`、`merge_state=null`、
   `finished_at=null`；`tasks` 表只有父任务一行；跑满 120s 无变化；**daemon.log 一行 WARN/ERROR 都没有**
   （logLevel 提到 debug 也只多出 `req` 行，调度链零日志）。
   定位区间：`services/scheduler.ts:3499-3600`。`child_task_id` 的写入（:3601）在
   `launchCallWorkgroupChild` **之前**，它是 null ⇒ 卡在 `mark-running`(:3496) 与该写入之间，即
   **深度闸 / `budget.acquire` / `createIsoUnderLock`** 三者之一。已排除：深度闸（默认 3、childDepth=1，
   且失败会落 `failed` 而非挂起）、闭包缺失（会落 `workflow-call-ref-missing`）、`createNodeIso` 的
   passthrough 分支（无论如何都会打一行 `canonical worktree is not a git repo` 的 warn，日志里没有）、
   `ChildTaskBudget` 容量（默认 8，`counted`/`held` 皆空）。
   即便夹具本身不成立（比如 call-workgroup 本就不支持 scratch 父任务），**产品也应当判定失败并落 typed
   error，而不是无声挂到超时**——这是 RFC-243 call-workgroup 运行期的唯一入口，失败形态是「任务永远
   转圈 + 零日志」，运维无从归因。
2. **【账本措辞与实现不符，已按源码实际写】CFG-45 的判别面不是运行时名。**
   `node_runs.runtime` 存的是**协议**（`'opencode' | 'claude-code'`，`scheduler.ts:1221` 的
   `frozen.protocol`），不是运行时行的名字。照账本字面写「node_runs.runtime 变成新运行时的名字」会得到
   一条永远红的用例。B104 改用 `runtime_params_json` 里的运行时档案（model）做判别面，并顺带锁住
   「冻结不可被事后改默认改写」。
3. **【测试判据自身的边界缺口，已就地补上】CFG-28 漏了「两个值相等」这一格。**
   判据是「正文期 > 整行期才拒」，等号那一格合法。起草版用的三组值（30/90、120/90、30/10）里没有
   等值对，因此把闸从 `>` 放宽/收紧成 `>=` 用例照样绿（本人变异实测）。已补一段「相等必须放行 +
   两个值一起落库」的断言，补后同一变异当场红。
4. **【账本核对：TASK 域 7 条 gap 里 6 条名不副实，本批因此一条 TASK 用例都没交】**
   - TASK-34 → `e2e/rfc319-worktree-and-commit.spec.ts:828`（REPO-X1）已覆盖懒加载 / 真实内容预览 /
     超 2 MiB 降级 / 原始字节下载。
   - TASK-35 → 同文件 `:909`（REPO-X2）已覆盖真工作树 → 接口 → 面板的 diff 渲染。**真缺**的只剩
     结构化 diff 的作用域切换（`scope=node:<runId>`）与 1 MiB 截断提示（`util/git.ts:2263`）。
   - TASK-38 → `e2e/task-feedback-distill.spec.ts` 四条已覆盖。
   - TASK-39 → `e2e/task-questions-board.spec.ts`（5 条）+ `task-questions-board-ui.spec.ts`（2 条）。
   - TASK-44 与 CFG-29 → **两行互为重复且都假**，`e2e/rfc319-ops-settings-panels.spec.ts:740`（OPS-037）
     已覆盖 dry-run 预览一行不删 → 确认后真删 → 审计行 → 未超期任务不受牵连。
   - TASK-03 → `e2e/rfc319-workgroup-launch-and-config.spec.ts:928`（WG-24）已覆盖。
   - TASK-X4b → 账本写「展开只对 `page.route` 假数据点过」**已不成立**：
     `e2e/rfc319-task-list-and-filters.spec.ts:1051`（TASK-17）用的是 `seedTasks` 真落库的 1 父 + 60 子。
     真缺的只剩「子任务由 call-workgroup 在运行期真的启出来」，而它撞上第 1 条的卡死。
     **注意这行 tier 是 `pr`（TASK 域唯一一条），接手者标题不要带 `@nightly`。**
5. **【账本核对：CFG / INTENT 另有 7 条假 gap，本批据此换行】** CFG-08 →
   `e2e/settings-outcome-unknown.spec.ts:49`（RES-08）；CFG-30 → OPS-036；CFG-32 → OPS-032（只差
   「保存后真落库」一格，已由本批 CFG-06 顺带补上）；CFG-44 → OPS-016；CFG-X6 → webhook ingress URL 由
   `rfc319-webhook-endpoints.spec.ts:313`、文档片段 origin 由 CFG-40 覆盖（只差 MCP endpoint 的 origin）；
   CFG-03 → `e2e/ux-consistency.spec.ts:602/772/981`；CFG-X5 → CFG-07 已覆盖 neutral/attention 两种，
   只差 `danger`；INTENT-X8 → `rfc319-intent-timeline-and-turns.spec.ts:951`（INTENT-21）已 SIGKILL 重启并
   断言 `intent-run-daemon-restart` + `captureState='incomplete'`。
   **本批同样未据此改任何行的 status**——与 B98/B102/B103 一致，留待一次独立的账本对账。

## RFC-319 B105 起草期撞到的产品缺陷（2026-08-26，运维清扫 + 事件入站 + 仓库）

1. **【真实缺陷，中危，未写成断言】`/tasks/new?editScheduled=` 回填丢掉工作流输入，可选输入会被静默清空。**
   `packages/frontend/src/routes/tasks.new.tsx:641-661` 的 seed 效应调了 `applyWizardSeed(seed)`，`:609`
   里有 `setInputs(seed.inputs)`，`lib/task-wizard.ts:374-381` 也确实把 `payload.inputs` 的字符串项带了
   出来——**但界面上那个输入框是空的**。起草侧本机实测：建一条 `launchKind:'workflow'` 的定时任务、
   `launchPayload.inputs = {topic:'scheduled'}`（`GET /api/scheduled-tasks/{id}` 回读确认原样在库）→
   详情页点 `scheduled-edit-config` → `wizard-task-name` **正确回填**，而工作流声明的 `Topic` 输入框
   value 为空串，`stepper-next` 因 `missingRequired` 恒灰（`tasks.new.tsx:1119-1127`）。
   **危害分两档**：必填输入 ⇒ 用户每次改配置都要把输入重打一遍（可见的烦人）；**可选输入 ⇒
   `missingRequired` 不拦，而保存是整份 `launchPayload` 替换（`:1690-1697`），那个值被静默清空**
   ——这是数据丢失形态。B105 的用例按产品实际行为走（自己把 `Topic` 填上再保存）并断言「填进去的值
   原样落库」，所以将来修好也不会红。
2. **【账本措辞与实现不符】`observer_activations.state` 的 `'blocked'` 是**从未被任何代码写入**的状态。**
   `modules/event-center/public/types.ts:101`、`domain/model.ts:220`、`db/schema.ts:5373` 三处都声明了它，
   前端 `routes/events.tsx:677,684` 还为它写了渲染分支；但 `modules/event-center/**` 里除这三处类型声明
   外零命中，`sqliteEventStore.ts` 的 `settleObserver` 失败路径只写 `lastErrorCode`（`:1205-1226`）、
   不改 `state`。EVENT-36 账本行写的「异常显示 blocked」照字面写就是一条**永远红**的用例。B105 按源码
   实际只写了前两个分句（有订阅才轮询 / 无人关注即停止）。
3. **【死列 + 死索引，建议单独立项】`tasks.webhook_trigger_id` / `webhook_fire_id` 在现行入站链路上恒为 NULL。**
   RFC-300 之后 webhook 投递统一经事件中心分发，`services/webhook/webhookDispatch.ts:1049-1064` 的 invoker
   分流只要 `eventSubscriptionId`/`eventDeliveryId` 有值就走 `type:'event'`，任务上写的是
   `launch_origin='event'` + `event_subscription_id='route:<触发规则 id>:<摘要>'` + `event_delivery_id`，
   那两列全空（起草侧实测原始行为证）。`db/schema.ts:1225` 还挂着 `idx_tasks_webhook_trigger`。
   B105 的断言写在**活着**的那三列上。
4. **【审计文案与实现不符，照抄会得到假红】OPS-X4 的建议参数 `periodicOrphanReconcileMs: 2000` 不可用。**
   `packages/shared/src/settingsNumericBounds.ts:72-78` 声明 `positiveMin: 60_000`（`PUT /api/config` 会 422），
   `services/managedPeriodicJob.ts:75-92` 的 `minPositiveMs: 60_000` 会把 2000 判非法并**把这条 loop 整个
   禁用**（`onInvalid` → `enabled=false`）。照抄那个数字会得到一条「怎么等都不发生」的假红。B105 用的是
   合法下限 60_000，代价是那条腿真等 60 多秒。
5. **【账本噪声，建议清理】`e2e/git-protocols.spec.ts:192-198` 是一个用例体为空的 `test.describe.skip`。**
   注释自述需要 daemon 先长出自定义 `GIT_SSH_COMMAND` 能力。它让 REPO-42 看起来「有覆盖」而实际一行断言
   都没有。本批未动（不改别人的 spec）。
6. **【测试判据自身的强度缺口，已就地收紧】EVENT-X2 原本只断言 `nextRunAt` 「变了」。**
   把重算换成**任何**别的数字都能满足 `not.toBe(原值)`（本人变异实测：写成 `now + 999_999_999`
   用例照样绿）。已补一条与时区无关的硬性质——每周规则的下一次触发必然落在此刻之后、且不超过 7 天
   ——把「变了」收紧成「算对了」，补后同一变异当场红。
7. **【账本核对：两条假 gap，未改状态】**
   - **UX-42**（仓库批量导入的浏览器实时进度表）**并非空白**：
     `e2e/rfc319-repos-list-and-import.spec.ts:539` 的 REPO-03 已在浏览器里挂 `page.on('websocket')`、
     断言 socket pathname 逐字等于 `/ws/repo-imports/{batchId}`、数 `row.update` / `batch.completed` 帧，
     并用「快照接口只被读过 1 次」排除轮询解释——比账本对 UX-42 的描述覆盖得更严。
   - **OPS-044b**（单二进制冒烟跑通 doctor）已被 `e2e/rfc319-ops-doctor-and-migrate.spec.ts:247`（OPS-010）
     覆盖；唯一分歧是「跑的是 `dist/agent-workflow-e2e-*` 而非 release 产物」，属产物命名口径。

## RFC-319 账本对账批（2026-08-26）：16 条假 gap 已销，10 条部分覆盖 + 7 条 tier 不一致待决

前五批起草者在开工前 grep 既有 e2e 时，反复撞见「标着 `status:'gap'` 其实已有真覆盖」的行，累计点名
33 条。本次**逐条读 test 正文**核实（不是关键字匹配——那种做法我先试过一次，把 MEM-21 匹配到了毫不
相干的 INTENT-50 上，是彻底的假阳性），结论如下。

**已销 16 条**（改 covered + 挂逐字 evidence，gap 105 → 89）：AGENT-X1、CFG-29、CFG-30、CFG-44、
MEM-21、MEM-43、MEM-X2、OPS-044b、TASK-03、TASK-38、TASK-44、UX-26、UX-33、UX-34、UX-40、UX-42。

**待你决定的三类残留：**

1. **部分覆盖（10 条，仍是 gap，缺的那一片已写清）**——补它们只需在既有 spec 上加断言，成本远低于新写：
   - UX-24：点行后**没断言抽屉关闭**；只走 clarify 行、review 行没走；徽标的三路求和口径没验。
   - UX-41：只有「显式冲突不静默覆盖」，**正向的跨标签实时传播整片缺失**。
   - MEM-X3：两步确认 + 停引擎 + 服务端拒 approve 都有；**`applying` 中不许取消那一支零覆盖**
     （`services/fusion.ts:1755-1775` 的 CAS，全仓 e2e 无 `fusion-terminal` 命中）。
   - MEM-X10：只对 **GET** 做了 missing/invisible 逐字节同形；**POST 用外人 token 的 404 同形没验**。
   - TASK-34：懒加载 / 预览 / 下载 / >2MiB 四片都在；**`worktree-files-refresh` 按钮全仓 e2e 零命中**。
   - TASK-39：四片行为都验了，但**全走 REST 驱动**；界面上的 `tq-add-question` / `tq-stage-{id}` /
     `tq-batch-dispatch` 三个控件全仓 e2e 零命中，而账本行写的是「task-questions 页签」。
   - CFG-32：**bindHost 的保存没有任何用例**（只有 `ux-consistency` 的可见性断言）。
   - CFG-03：窄屏折叠有，**「并可切换」缺**——`rfc319-settings-sections.spec.ts:147-156` 的 compact 分支
     因所有用例都在 1280 宽跑而从不执行。
   - UX-05：密码登录与 OIDC 都有，**一次性 token 登录缺**（`auth.tsx:341` 的 `auth-token-form` 与
     `auth-bootstrap-handoff` 全仓 e2e 零命中）。
   - INTENT-X8：SIGKILL 重启那半有，**「排队中的上下文后继被恢复」整片缺失**。
2. **内容核实通过、但 tier 与用例标签不一致（7 条，一行未动）**——改 covered 会当场触发
   `tierWiringMismatches`。账本写 `tier:'nightly'` 而线索用例**没有** `@nightly`（即它们每次 PR 都在跑）：
   AGENT-39、UX-06、UX-36、CFG-08、WF-X2、WF-25，外加 UX-05 / UX-41 / CFG-03（这三条内容也不完整）。
   **两条出路**：把账本 tier 改成 `pr`（承认它们跑在 PR 腿），或给那些用例补 `@nightly`（会把它们移出
   PR 腿，削弱现有防护）。**倾向前者**——那些用例本来就跑在 PR 腿上，账本该跟实现走。
3. **线索被推翻、仍是真 gap（1 条）**：**UX-39**「在线状态圆点随 `/ws/presence` 实时增删」。
   线索指向的 `rfc319-users-and-account.spec.ts` 的 IAM-42 锁的是**权限门**（有 `users:presence` 有点、
   收回后逐字节只少那几个 span、无权限不建连接），圆点消失是**权限被撤 4403 关连接**造成的，**不是
   presence 事件**——三个被观察账号全程从不登录，没有任何上线/下线事件被推过。而且那条 test **已经是
   IAM-42 行的证据**。全仓 `.presence-dot` 只出现在两个 spec，**没有任何用例观察过圆点的实时增删**。

**另记一条账本自身的重复**：**TASK-44 与 CFG-29 是同一条能力的两行**（措辞不同、内容重合，证据同为
`rfc319-ops-settings-panels.spec.ts` 的 OPS-037）。本次两行都销了，是否合并成一行待定。

## RFC-319 B106 起草期撞到的缺陷（2026-08-26，数字员工 + 资源生命周期）

1. **【测试基建缺陷，非产品，已在后续提交修掉】`packages/system-mocks/src/mcp/server.ts:44-53` 的 SSE
   分支 close 无限递归。**
   `transport.onclose` 里调 `server.close()`，而 `Protocol.close()`
   （`@modelcontextprotocol/sdk/.../shared/protocol.js:492-494`）会再次 `transport.close()`，
   `SSEServerTransport.close()`（`.../server/sse.js:145-149`）又无条件触发 `onclose?.()`——两者互相重入
   直到爆栈。`Protocol.connect` 的 `_onclose` 是**链式包裹**而非覆盖，所以自定义 handler 一直在。
   实测：单跑 RES-04 = 0 条错误，单跑 RES-20 = **154 条** `RangeError: Maximum call stack size exceeded`
   （打在 global-setup 的**共享** mock 进程里）。进程能活下来（混跑 18 条全绿），但这是整条夜跑里一份
   持续的噪声源，会掩盖真错误。**B106 是全仓第一次有 e2e 走到这条分支，所以它一直没被发现。**
2. **【实现细节，非缺陷，已按源码实际写】`services/mcpProbe.ts:568-571` 的 stdio 探测
   `protocolVersion` 恒为 `null`。** 取值方式是 `'protocolVersion' in activeTransport`，而 SDK 的
   `StdioClientTransport` 没有这个字段。「协议版本」这一栏对本地 MCP 永远为空。用例只在 Streamable HTTP
   那条上断言它非空。
3. **【账本核对：一条假 gap + 两条文案偏差】**
   - **RES-24 是假 gap**：`e2e/mcp-runtime-playground.spec.ts:89` 已把该行的五小节全部覆盖（开对话框、
     两种 runtime 都在选项里、发首条消息、失败诊断、ESC 关闭后 `GET /runtime-test-session` 仍为 null）。
     **建议改 covered 并指向该文件**（本批未动 status）。
   - **RES-19 的「两种传输」有一半已被覆盖**：stdio 那半在
     `e2e/rfc319-mcp-management.spec.ts:534-586`（RES-17/RES-22）。真缺口只有 Streamable HTTP——全仓 e2e
     从未对 `AW_SYSTEM_MOCK_MCP_URL` 发过探测（既有 remote 夹具要么指 `127.0.0.1:1`，要么指
     `${GITHUB_API_BASE}/mcp`，而后者按 `packages/system-mocks/src/suite.ts:467` 的 `serviceFor` 路由到
     code-host mock 而非 MCP mock）。用例仍把两条传输放进同一条，stdio 那半作为**对照组**——没有它，
     一个「所有探测都回 ok」的实现照样能过。
   - **RES-46 的一半是假 gap**：`rfc319-intent-access-boundaries.spec.ts:806-846` 已锁「六个入口按
     `intent:write` 收放」，`rfc319-intent-fusion-and-gates.spec.ts:695` 已锁「无权时没有融合按钮」。
     真没人碰过的是**点下去之后**：全仓没有任何 e2e 点过 `skill/mcp/plugin-intent-entry`，也没有任何
     一条从**技能详情**发起过融合（发起融合的用例走的都是 `/memory` 的 `memory-fuse-button`）。
4. **【测试判据自身的弱点，起草侧自查后已修强】** RES-46（融合）原本用
   `dialog.getByLabel('Target skill')` 断言字段不出现——而 `getByLabel` **只认可标注的表单控件**，
   该字段在 `from-skill` 下渲染的是 `fusion.noManagedSkills` 的 `<p>`，于是「字段渲染了但里面是空态」
   这一整类回归会被漏掉（变异实测 NO-BITE）。已改成 `getByText('Target skill', {exact:false})`
   + `toHaveCount(0)`，改后同一变异当场红。

## RFC-319 B107 起草期撞到的账本偏差与产品观察（2026-08-26，工作流入口 + 外壳偏好）

1. **【审计文案写错了注入码，照抄会写出永远红的用例】UX-28 建议「拦 `PUT /api/config` 返回 503 → 断言
   回滚」。** 实现里 `packages/frontend/src/lib/config-resource.ts:38-43` 的 `isDefinitiveWriteError`
   **只把 4xx 当明确失败**；5xx 属「结果未知」，走的是 `ConfigAmbiguousWriteError` +
   `reconcileAmbiguousConfigWrite` 那条**完全不同**的分支，**不执行**回滚。B107 改用 **400**。
2. **【账本措辞与实现不符】WF-45 的「无权用户直接打开编辑器 → inaccessible」不成立。**
   `routes/workflows.edit.tsx:238-246` 有一层更早的 gate：`query.data === undefined && query.error` 时
   渲染的是 `PageHeader + ErrorBanner`，**根本进不到草稿控制器**，`workflow-draft-status-focus` 不存在
   （起草侧实撞 `element(s) not found`）。inaccessible 终态**只在「已经加载过之后失去访问权」时可达**，
   用例因此改成「开着编辑器 → 收回授权 → 下一次写请求 404」。
   相关：ACL 撤销本身**不**驱动客户端进终态（`hooks/useWorkflowSync.ts:73-75` 明写
   `workflow.acl.updated` 刻意不处理），要稳定复现只能靠一次真实写请求。
3. **【账本措辞与实现不符】WF-57 的非法 ref 是 422 不是 400**：`ValidationError('execution-contract-ref-invalid')`
   在本仓映射成 422；不存在的 ref 是 404 `execution-contract-not-found`。两者确实可分辨（这点账本说对了）。
4. **【产品观察，P3 / 数据陈旧，未写成断言】配置包导入不重写 `agentName`。**
   `services/resourcePackage/serialize.ts:437-442` 只把 `agentId` 抬成 `agentRef`、`agentName` 原样带走；
   `bundle/lower.ts:277-281` 只把 `agentRef` 落回 `agentId`。于是**导入时给代理起了新名字**之后，新工作流
   节点上的 `agentName` 仍是**源代理的名字**，与 `agentId` 指向的新代理不一致。运行期以 id 为准
   （`nodeTitle` 走 agentLookup by id），目前只是陈旧冗余；但 `agentName` 在 call 目标那一族是**被当作
   late-bound 名字域用的**，值得产品侧确认要不要一并重写。
5. **【待确认，P3】目录里存在 `allowedExecutorKinds: []` 的执行合同**：`development.acknowledge-feedback@1`，
   三种 transport 全 `null`。schema 允许（`.max(3)` 无下限），但这条合同在**任何**执行体选择器里都选不出来。
   B107 因此没把「必须非空」写成逐条断言，改成目录级下限（至少一条允许 `agent`）。可能是有意的占位。
6. **【刻意设计，记一笔免得再踩】edit 授权不能改名**：被授权者 PUT 改名得 403
   `resource-rename-owner-only`（"an edit grant covers content only"）。这意味着**「重命名」不能当作
   被授权者的脏化手段**——B107 因此改用「自动布局」这类内容改动。
