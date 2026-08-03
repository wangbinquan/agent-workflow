# RFC-253 设计门（Codex，2026-08-03）

对抗式设计门，评审对象是本 RFC 三件套（尚无代码改动时发起）。判定 **不通过**，
12 条「事实错误」+ 4 条 P0 + 13 条 P1 + 6 条 P2。**逐条实读源码核实**后的处置见下；
不是空洞通过，也不是全盘照收——有 2 条部分驳回。

> 跑法：作业 `task-msda9n60-meisf4`。本轮是**新增文档、无 diff**，故按路径直接读盘评审，
> 天然不受 `docs/dev-gotchas.md:109`「共享树并发 diff 吞掉 review」的影响。
> 评审期间共享树发生并发 WIP（见下「并发漂移」），Codex 的行号以其读盘快照为准。

## 0. 并发漂移（本轮最重要的发现之一）

评审同时，另一 session 把 RFC-252 的一部分**提交进了本地 main**：

- `40535c0e feat(git): RFC-252 G1 收口 daemon 侧 git 执行面` → 新增 `packages/backend/src/util/gitHardening.ts`
- `37496943 fix(sandbox): RFC-251 让选中的插件在 Linux 沙箱内可读——只读放行` → `policy.ts` 新增 `readOnlyAllowSubtrees`

两者都直接命中本 RFC 的设计面（见 F5、P0-1）。**结论：本 RFC 不再自建同类机制，一律复用。**

## 1. 事实错误（文档断言与源码不符）—— 全部属实，全部已改

| # | 断言 | 实际 | 处置 |
|---|------|------|------|
| F1 | 把七个标量字段「登记为已知非引用字段」可消除 unmanaged 棘轮告警 | 棘轮只识别**引用形状**（`/nodeId$/i` 键名、`nodeIds`/`rerunnable` 数组、`PortRef` 形状），没有「非引用字段登记表」（`workflow-node-references.ts:325,375`） | **部分驳回 + 改**。Codex 说「七字段不会告警」**不完全对**：`env` 的键名是**用户可控**的，一个叫 `FOO_NODEID` 的普通环境变量会命中 `/nodeId$/i` 而触发 `action:'abort'`。已实现 `opaqueFields` 描述符（声明「此子树是用户数据、绝无引用」），并只把 `env`/`script` 标为不透明——这比原文档的说法更准确，也确实修掉一个真缺陷 |
| F2 | 需为 `scripts:author` 登记 `HANDLER_CONSUMED_POINTS` 豁免 | 该符号**不存在**；反向自检只遍历 `ROUTE_BACKED_POINTS`，而它已排除系统域点（`permission.ts:249`、`routes/registry.ts:326`） | 采纳，删除该要求 |
| F3 | 为遥测可分辨而新增与 `runner-filesystem-v1` 需求相同的 `script-node-v1` | 注册表明文：profile 命名 WHAT 不命名 WHO，**只有需求真正分歧才拆**（`containmentCoordinator.ts:13-26`） | 采纳。allow 档**复用** `runner-filesystem-v1`；只新增 netless 档 profile |
| F4 | 依赖安装器「可写根只有 build 目录」 | 外层沙箱**不是 jail**：Linux `--bind / /` 可写、macOS `(allow default)`，只限制 appHome（`policy.ts:21,170,211,226`） | 采纳，改为如实描述：脚本与安装器都能写 appHome 之外的宿主路径，与**今天的 agent 同档**；envDir 的只读保护靠 RO overlay 单独成立 |
| F5 | 需新造 `readOnlyRoots` 入参 | `policy.ts` 已有 `readOnlyAllowSubtrees`，语义正是「被 deny 的 appHome 下只读 allow-back」 | 采纳，复用既有入参，不加平行机制 |
| F6 | script 分支可复用 agent 分支「同一套外层循环」 | 非 `agent-single` 在穷尽守卫处**已 return**；globalSem/iso/retry 在其后（`scheduler.ts:4162→4355`） | 采纳。改为：脚本执行器**复用同一批原语**（`createIsoUnderLock`/`persistIsoBase`/`mergeBackNodeIso`/`discardNodeIso`/`globalSem`/`mintNodeRun`），而不是复用那段循环体 |
| F7 | 脚本可直接在 wrapper-fanout 内逐分片执行 | fanout 独立硬拒非 agent 内节点，dispatcher 类型要求 `innerAgent` 并直呼 `runNode`（`scheduler.ts:6198,6448,6808`） | 采纳并**缩范围**：v1 明确**不支持**脚本节点位于 fanout 内，且由校验器**显式拒绝**（fail closed，而不是留一个静默坏掉的组合）。「脚本算出清单喂给 fanout」（US-3，真正的价值场景）不受影响 |
| F8 | 单端口 = 「整个 stdout，8 MiB 尾截断」 | 行泵会丢空行与尾换行（`a\n\nb\n` → `a\nb`），上限是 UTF-16 code unit 且 2× 缓冲（`runner.ts:2791,2806,2845`） | 采纳。端口值改为**独立的原始字节累加**，与「逐行落事件」分离 |
| F9 | 复用 `parseEnvelope` 即可让缺端口失败 | parser 把缺失端口补空串并另报 `missingDeclared`；runner 只告警（`envelope.ts:436`、`runner.ts:2220`） | 采纳，显式实现 `script-port-missing` |
| F10 | 文档里的依赖正则同时接受 `@scope/pkg@1.2.3` / `pkg@1.2.3` | 文档版正则对二者均 false | 采纳。实现版已含 `@` 比较符分支（文档滞后）；另按建议**按语言分档**校验，并要求**精确版本** |
| F11 | 「5 个 PR」拆分 | 本仓硬规则：主干开发、禁止分支与 PR（`CLAUDE.md`） | 采纳，改称**提交切片**（RFC-248 同样在 main 上用 PR-N 作切片标签，此处改为无歧义措辞） |
| F12 | 账本三处错误 | T9 误引 T20（脱敏实为 T30）；T10 称五条却列六条；清单称 6 张穷尽表 | 采纳。另**实测发现第 8 处**穷尽点：`runLiveness.ts:100` `livenessSourceOfKind`（Codex 只列到 7 张，编译器替我们找出了第 8 处） |

## 2. P0

| # | finding | 处置 |
|---|---------|------|
| P0-1 | **`network:'deny'` 存在围栏外链**：脚本写 `.gitattributes` + repo-local `filter.<n>.clean`，daemon 侧 `git add -A`（快照/合回）在**沙箱外以 daemon 身份**执行它 | **属实、且当前未封**——`gitHardening.ts:29-33` 自己登记了这条残留（`filter.*`/`diff.*.textconv` 是通配名，`-c` 压不住），归 RFC-252 的独立切片。**本 RFC 不擅自扩大他人 RFC 的范围**，改为：①AC-13 措辞精确化为「围住脚本进程的出网」，不再宣称覆盖 daemon 侧 git 副作用；②在 `docs/audit-backlog.md` 该条目下登记「RFC-253 是第二个消费者」；③设计里写明威胁模型差异——脚本作者按 D19 是 admin/manager（已具备宿主权限），此链的真实价值是防**依赖供应链**而非防作者 |
| P0-2 | **Linux `--unshare-net` 仍留 pathname Unix socket**（`/run/user/$UID/bus`、`docker.sock`） | 属实。`--unshare-net` 只隔离 abstract socket。**采纳**：netless 档追加 `--tmpfs /run --tmpfs /var/run`，并在文档写明这是 best-effort 边界而非完全隔离 |
| P0-3 | **`ContainedSpawnResult` 无 pid ⇒ AC-7 不成立**，daemon crash 后 boot reaper 拿不到 pid（`process.ts:111`） | 采纳，加 `onSpawned` 回执（先例 `systemAgentRun.ts:114`），spawn 后立刻持久化 `pid` + `spawn_binary_path` |
| P0-4 | **macOS `setsid()` 孤儿逃逸**（无 PID namespace / parent-death） | 属实，但**与今天的 agent 完全同档**（同一 `killProcessTree` 语义）。不在本 RFC 造 macOS 专属机制；如实写进文档与 `docs/audit-backlog.md` |

## 3. P1（全部采纳，除注明外）

- **D20 投影漏了真实执行能力字段**：入边决定 `AW_PORT_*` 的键与值；wrapper 归属/`maxIterations` 决定跑几次。⇒ 投影扩展为「脚本节点自身字段 + 指向它的入边 + 包含它的 wrapper 归属与循环上限」。
- **`mcpEnvIssues` 不足以护住脚本 ABI**：它显式放行 `PYTHONPATH`/`NODE_OPTIONS`。⇒ 新增脚本专属保留键/前缀拒绝表，且**平台键最终覆盖用户键**（原设计「用户键最后覆盖」是错的，已翻转）。
- **依赖未冻结实际字节**：⇒ 要求**精确版本**（pip `==`、npm `@x.y.z`），并把解析结果写进 manifest 与运行记录。
- **`readonly:true` 未覆盖 git common dir**：`${appHome}/repos` 恒为 RW allow-back。⇒ readonly 脚本改为把它降级为只读。
- **权限门必须落在持久化原语**：intent create 直呼 `insertWorkflowInTx`（`applyChangeset.ts:759`、`workflow.ts:729`）。⇒ 门下沉到 `insertWorkflowInTx` / `prepareWorkflowSave` 两个原子边界，HTTP 入口不再是唯一防线。
- **D23 fail-closed 必须由 coordinator 拥有**，否则 caller 二次判断 = 第二决策源。⇒ profile 携带 fail-closed 策略。
- **失败码「不可重试」未接进真实 predicate**（`scheduler.ts:1381`）。⇒ 显式登记。
- **process lifecycle 三项契约**（spawn 前 `pending→running` + DB-first 广播、shutdown 的 canceled/interrupted 区分、`livenessSourceOfKind` 登记）。⇒ 全部实现（`livenessSourceOfKind` 已由编译器逼出并完成）。
- **D24 只能分路径成立**（普通 retry / loop / fanout / resume 四条）。⇒ fanout 已按 F7 禁止；其余三条分别测。
- **path/list-path 端口缺归档链**：iso 删除后会断链（`portArtifacts.ts`）。⇒ v1 **不支持** `path<…>` 族端口 kind，校验器显式拒绝（fail closed），把归档链留作后续切片——比"看起来支持、GC 后断链"诚实。
- **`malformedPorts` 无错误码归属**。⇒ 补 `script-envelope-malformed`。
- **G3 多文档 review 三层都拒非 agent 源**。⇒ 三层放行脚本节点作为 review 源。
- **前端开放式输入链漏改**：`dropTarget.ts:65`、`workflow-connection-plan.ts:451`、`workflow-transition.ts:82`。⇒ 全部补上。
- **AC-35 只有写入没有读投影**。⇒ NodeRun DTO 增加解释器与依赖环境元数据。

## 4. P2

- 两平台只读挂载补**真实写探针**（现有测试只锁 argv/SBPL 顺序）——采纳。
- **nonce 措辞**：nonce 防的是「运行前上游注入」，不防脚本作者自己伪造（脚本能读到 nonce）。⇒ AC-5 措辞收紧——采纳，这是真实的过度声称。
- `stuckTaskDetector` 会对长时间静默的脚本报 S5 假阳性 ⇒ 锁定预期行为并在文档说明。
- picker 分区计数表 + intent supported node forms 漏改 ⇒ 补。
- proposal D6 仍写「默认仅 admin」与 G7/D19 的 admin+manager 矛盾 ⇒ 已订正。

## 5. 已核实、断言成立（Codex 明确背书的部分）

- 外层沙箱**确实**无网络限制（Seatbelt 无 `deny network*`、bwrap 无 `--unshare-net`）——本 RFC 的核心前提成立。
- bwrap 后置 `--ro-bind` 与 Seatbelt `allow-RW → deny-write → allow-read` 的顺序语义成立；macOS `(deny network*)` 置于 `(allow default)` 之后符合 last-match 契约（RFC-242 已有真实 curl 对照）。
- `--only-binary=:all:` 拒绝 sdist/build backend、`--ignore-scripts` 关闭 lifecycle scripts；`entry_points`/`.pth` 是安装**产物**而非这两条命令调用的 hook。依赖正则确实拒绝 environment marker、`;`、URL/VCS、路径、flag 与 Unicode 同形字；argv 不过 shell，分号不构成命令拼接。
- **权限写入口无遗漏**（这是我最担心的一条）：YAML 最终回流 `updateWorkflow/createWorkflow`；MCP 复用同一 Hono 路由表且 PAT 公式删除系统域点；dynamic workflow 当前只允许 `agent-single`；scheduled task 只存 target+inputs；RFC-109 sync 只复制既存定义；restore 是 admin-only 整实例操作；**未发现暴露 raw SQL 的 REST/MCP 面**。
- `limits` / `freshness` / `nodeRunMint` / 进程并发闸 **均不按 NodeKind 漏管**；`orphans` 是状态/PID 驱动（问题只在 PID 未持久化，即 P0-3）。
- `nodeTitle` / `NodeConfigurationSummary` / `wrapperCandidates` / `controlFlowEdge` / `canvasClipboard` / `coordProjection` / `changeGroups` / `sessionView` 经核对**无需 script 特判**。
