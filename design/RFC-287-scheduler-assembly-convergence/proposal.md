# RFC-287 — scheduler spawn 装配线收敛（proposal）

状态：Draft（2026-08-13 落档）
来源：`design/system-commons-unification-audit-2026-08-12.md` §5 决策台账 **D3**
（大件一，排 RFC-284/285/286 之后——三者已完工）。方向已拍板，本 RFC 只做工程
落地；现状测绘（2026-08-13 只读子代理，全锚）收录于 design.md §1。

## 1. 背景

审计断言「scheduler.ts 内六条同构 spawn 装配线」经测绘核实并扩展：**runNode
恰好 6 个调用点 + 3 条非 runNode 同构骨架，共 9 条装配线**（agent-single 主跑 /
workgroup host / commit-push / merge agent / fanout shard / fanout aggregator /
script / call-workflow / code-host）。每条重复「许可 → iso 物化 → 铸行 →
组装 → spawn → 结果处置 → merge-back → 清理」骨架，已产生四类实测漂移，
其中一类是 bug 级：

- **漂移 A（bug 级）**：script 线（L7）的 `mergeBackAndSettle` 裸调用无
  try/catch——merge 抛出时 iso 既不丢弃也不 `markMergeFailed`，行停在
  done+unsettled，楔死整个 scope（正是 scheduler.ts:4880 一带 RFC-276 注释
  描述过的形态）；其余三条 iso 线（L4/L5/L6）都有 keep+markMergeFailed 处置。
- 漂移 B：iso 清理守卫两种极性四个同义变量（keepIso/keepHookIso/
  keepShardIso/keepAggIso），其一还吞异常。
- 漂移 C：`persistIsoBase` passthrough 守卫两种拼法（函数自带短路，纯外观
  分叉误导读者）。
- 漂移 D：「取行前奏」（fresher 判定 + 复用/铸行 + broadcast）4 份手抄，
  overrides 各不相同。

## 2. 目标

**零产品行为变更**（例外：§4 C 表——漂移 A 修复 + iso 清理时机统一）。
三层交付：

- **G1 骨架抽取**：新 `services/scheduler/assembly.ts`（或同级文件）
  `runAssembly(spec)`——收编五个逐字同构段：许可获取/释放配对、iso 物化
  窗口（createIsoUnderLock+persistIsoBase+失败释放）、merge-back **默认三态
  处置 + 逐线声明式覆写**（设计门 P1-1 修订：L1 的 throw→replay 与
  conflict→abandon 是测试锁定的合法 per-site 差异，走 disposition 覆写 +
  豁免锁，详 design §2）、finally 单一 keep 域清理（含 clarify-park 第四
  处置的表达）、DB-先写-再广播时序。per-line 差异走显式钩子：
  `resolveRunRow` / `buildSpawnArgs` / `retryPolicy` / `settle` / 可选
  `beforeSpawn`（L5 的 T14 undo）。
- **G2 五条迁移线**（设计门 P2-3 修订：L8 定性为第六条 iso 线但**不迁**，
  归 G3 挖洞）：L1(workgroup host)/L4(agent-single)/L5(shard)/
  L6(aggregator)/L7(script) 全部改走骨架。窗口契约为**双模式**（design
  §4）：L5/L6 = per-attempt 窗口（外层 driver 重入）；L4/L7 = 跨 attempt
  窗口（iso 稳定，D17 same-session 依赖）——**禁止**把 L4 改成 per-attempt
  形态。取行前奏 4 份收敛为参数化 `resolveSchedulerRunRow`。
- **G3 刻意豁免显式化**：L2(commit-push)/L3(merge agent)/L8(call 整线，
  含其 iso 五段与可取消 childBudget hold)/L9(code-host) 不硬塞骨架，改为
  spec 字段/源注 + 豁免测试锁 + 灭绝锁显式挖洞（L8/wrapper 便车/replay 段），
  防止后来者「顺手补齐」反而改变死锁性质。
- **G4 配额面可配（2026-08-13 用户拍板纳入本 RFC）**：并发/配额共 6 项，设置页
  只露了 3 项。补齐缺的三项——代码平台池 `maxConcurrentCodeHostCalls`(8)、同时
  活跃子任务数 `maxActiveChildTasks`(8)、子任务嵌套深度 `maxInvocationDepth`(3)
  ——到设置页（复用 RFC-290 的 `NumberInput` 范围提示）。**独立末批 + 独立
  commit**，不与零行为变更的收敛批混提。顺带修 `processNodeConcurrency.ts` 头注
  「两个池」的过期表述（RFC-269 起是三池；但**峰值子进程仍是 agent+script 两池
  之和**，code-host 池只是在途 HTTP 并发上限、不产生子进程——头注第 15 行是对的，
  不要改）。**第二轮设计门更正：不是「后端零改动」**——三项里只有 code-host 池
  真正即时生效（resize-in-place 已验证）；子任务配额是单例闭包（首次创建后闭包
  永久保留，改配置需重启）、嵌套深度是「下次**根任务**启动生效」，且存在既存
  bug：子任务继承旧快照后一启动就把 daemon 级池 resize 回旧值。**用户拍板顺手
  修成真即时生效**（见 §4 C9）。
- **G5 `file://` 不对用户开放（2026-08-13 拍板并入）**：公开面（launcher / API /
  定时任务配置）拒绝 `file://` 仓库源；平台内部启动面与测试通道保留（118 个
  测试/e2e 文件依赖它造仓）。目的：消灭「用户以为基于远端、实际基于本机仓」的
  静默偏差——`file://` 源的「远端」就是用户本机仓，其相对真正上游可能陈旧。
- **G6 基线同步的窗口化重试（第二轮设计门更正定性：这是扩张，不是收缩）**：
  **启动路径今天已经是硬失败**——`task.ts:726-736` 见 `fetchOk === false` 即抛
  `repo-fetch-failed`(502)「refusing to launch from a stale cache」，配套 i18n
  与回归测试 `stale-source-must-fail`。`gitRepoCache.ts:501-518` 的
  warning+陈旧镜像只是**库层中间态**，唯二真正吞掉它的消费者是仓库组导入
  （`repoGroup.ts:397`）与批量导入（`repoBatchImport.ts:464`），都不在启动路径。
  故本项的实际交付是**让抖动不再直接打挂启动**：仅网络类失败重试，按**总容忍窗口**（默认 60s，
  可配）而非固定次数；窗口内退避重试，一次正在推进的克隆不打断；窗口耗尽仍失败
  → 任务失败并写明原因。鉴权/仓库不存在/无权限/分支不存在**立刻失败不占窗口**。
- **G7 仓库准备异步化 + 状态机重试语义**：今天仓库物化在**任务行落库之前**
  （task.ts:1402/1751 vs :2255），故启动失败不留任何记录、启动接口同步阻塞到
  工作树就绪。改为：同步段只留「填错了立刻告诉你」的校验（参数/权限/资源可用性/
  地址格式），任务行先落 `pending`，克隆/fetch/快进/多仓物化/建工作树在后台推进，
  失败转 `failed` 且原因可见。**不新增任务状态**（复用 `pending`）。定时任务与
  webhook 触发同一套语义。**重试 = 状态机语义**：重试作用于任务当前所处阶段，
  处在「准备仓库」阶段就重试准备仓库。

## 3. 非目标

- 不动 fanout 内层旁路小引擎（RFC-289/WP-6b 专属）。
- 不动 task↔scheduler 环（RFC-288/WP-5）。
- 不动 wrapper-iso 路径（createOrRebuildWrapperIso/runGitWrapperNode——
  非 spawn 装配线）。
- 不改任何池语义/锁序（writeSem ≺ agent|script ≺ subprocess 契约原样）。

## 4. 能力影响清单

| #   | 变化                                                                                                                                                                                                                                   | 影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 漂移 A 修复：script merge-back 抛出改为 keep-iso + markMergeFailed（与 L4/L5/L6 同语义）                                                                                                                                               | 原「楔死 scope」变「节点 merge-failed 可修复」——纯 bug 修复；成功路径逐字节不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| C2  | 第五漂移统一（设计门 P2-4 新发现）：L7 成功+可写 merge 后 iso 现状**不 discard**（:4592 条件为假跳过，滞留待 GC），L4/L5/L6 成功即时 discard——统一为即时 discard                                                                       | 磁盘占用更早回收；对用户不可见（该 iso 此后无人读），但属清理时机变化，列此存照                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| C3a | iso **setup** 失败的日志统一（L6 `:8236` 裸 `catch {}` 无日志 vs L5 `:7808` 记 warn）                                                                                                                                                  | 日志新增 warn 行；无功能变化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| C3b | iso **discard** 失败的处置统一为「吞掉并记 warn」（今天 L1 `:1394-1398` try/catch 吞、L7 `:4593` `.catch(()=>{})` 吞，而 **L4 `:6201` / L5 `:7954` / L6 `:8387` 完全没兜**——`discardNodeIso` 确会抛，从 finally 抛出会吃掉 return 值） | **行为变更**：L4/L5/L6 从「异常逃出 finally」变为「吞掉+warn」，配红→绿对                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| C4  | 设置页新增三个已存在但此前只能手改 config.json 的配额项（代码平台池 / 同时活跃子任务数 / 子任务嵌套深度）                                                                                                                              | **能力扩张**：管理员不必登机器改文件即可调；默认值不变，不影响存量部署                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C5  | **收缩**：用户不能再**运行** `file://` 仓库源（启动与镜像刷新两面拒绝；注册/导入面不动，存量仓行仍可见但不可运行）                                                                                                                     | 「让 agent 在本机某个 checkout 上直接干活」这一入口消失；替代=推到真实远端后注册，或用临时空间。**离线代价的准确表述（第二轮门 P2-2 勘误）**：临时空间任务离线照常启动（全程本地 `initScratchRepo`，不碰网络）、框架内部启动面同样离线可跑、内网自建 GitLab/Gitea 的 http(s) 完全走得通 ⇒ 真正受损的只有「**单机且无任何 git 服务**」这一种形态。另：「暖镜像不 fetch」开关（`fetchOnReuse`）本就存在可用、只是启动路径未接线，故离线不可用是**当前接线选择**而非技术必然——用户 2026-08-13 在此准确口径上复核后维持「彻底不支持」，且**不**接该口子 |
| C6  | **扩张**（定性更正）：基线同步失败由「立即 502 拒绝启动」改为「窗口内退避重试，窗口耗尽才失败」                                                                                                                                        | 网络抖动不再直接打挂启动；鉴权/仓库不存在/无权限仍立即失败不占窗口。**此前不是「警告+陈旧镜像继续跑」**——那是库层中间态，启动路径早已硬失败                                                                                                                                                                                                                                                                                                                                                                                                         |
| C7  | **收缩**：启动接口不再同步保证「返回成功 = 工作树就绪」（**限定无上传的 JSON-body 分支**；有上传的 multipart/agentLaunch 分支保持同步物化）                                                                                            | 调用方拿到的是「任务已受理」。**仓库准备成为 `runTask` 认领后的第 0 步**（合成运行记录 `__repo_prep__`，可见性须显式实现、可单独重试）。启动失败留记录这一好处**只对更早的 fetch/clone 失败成立**——工作树创建失败今天已经留行（`earlyError` 路径 task.ts:2284/2301/2342）                                                                                                                                                                                                                                                                           |
| C8  | **行为变更**：fanout 分片/聚合节点撞 `conflict-human` 时，由「状态记 conflict-human + finally 照常 discard iso + 判 failed」改为「**abandon** + discard + 判 failed」                                                                  | 修的是 RFC-187 T8 在 L1 修掉的同一个**孤儿承诺** bug 的第二、三例：状态说「留着等人解」而工作树已被删，恢复路径会去找不存在的树。用户拍板顺手修。fanout 仍是 fail-all-after-join，**不**变成 per-shard 挂起                                                                                                                                                                                                                                                                                                                                         |
| C9  | **行为变更**：G4 三项配额改为真正即时生效                                                                                                                                                                                              | 修 `ensureChildTaskBudget` 单例闭包（今天改配置需重启 daemon）、`maxInvocationDepth` 读点、以及「子任务继承旧快照后一启动把 daemon 级池 resize 回旧值」的既存 bug（`launchRuntimeConfig.ts:122-124` 注释自陈该失败模式）。保存后并需触发 `scan()` 才能放行排队中的 call 节点                                                                                                                                                                                                                                                                        |

**对拍豁免声明**（P2-4）：「零行为差异」判定不含**日志措辞**与上表 C2/C3 的
清理时机/日志级别；广播序列的两种既有形态（L4 逐 attempt failed→pending vs
L5/L6 单点）按线保持、不跨线统一。

## 5. 验收标准

- AC-1 骨架唯一（**限定五条迁移线**，P2-3 收窄）：L1/L4/L5/L6/L7 函数体内
  五段同构逻辑仅存 assembly 单点；散写 grep 锁按 design §5 挖洞清单执行
  （L8/wrapper 便车/replay 段显式豁免）。
- AC-2 五条迁移线各自全家测试套件绿（scheduler-\* 家族 + rfc253-script +
  fanout 家族 + workgroup 家族），对拍零行为差异（§4 C 表及豁免声明除外）。
- AC-3 漂移 A 红→绿对：merge 抛出场景先复现楔死（红）再断言 keep+
  markMergeFailed（绿）；以**行为夹具**落地（替掉 rfc210 的源码文本兜底）。
- AC-4 豁免锁：L2/L3/L8/L9 的刻意省略各有测试/源锁，注明设计依据锚；L1 的
  两个 disposition 覆写同等带豁免锁。
- AC-5 L4 拆分后 envelope-followup / clarify-mode-flip / session 继承三机器
  行为逐字节保持（P2-6 勘误后的真实套件：scheduler-envelope-followup-branch /
  scheduler-port-validation-followup-decide / rfc092-followup-chain-rollback /
  rfc122-clarify-directive-\* / rfc123 / rfc131 / rfc161 + 新增拆分对拍）。
- AC-7（G4）三个配额项在设置页可读可改，**保存后即时生效**：三池经
  resize-in-place（已验证）；子任务配额与嵌套深度经 C9 的后端修复达成即时，
  且保存后触发一次 `scan()` 放行排队中的 call 节点；并锁住「子任务启动不得把
  daemon 级池 resize 回旧值」。三项各有前后端测试 + `settings-drafts.ts` 最小
  写入白名单登记（漏登记=保存被静默丢弃）。过期头注只改池数表述、不动峰值子
  进程那句。
- AC-12（C8）红→绿对：fanout 分片/聚合撞 conflict-human 时 merge_state 落
  `abandon`（不再留孤儿 `conflict-human`），iso 照常 discard，wrapper 仍
  fail-all；`rfc187` 家族与 s18/s19 语义锁全绿。
- AC-13（C3b）红→绿对：`discardNodeIso` 抛出时 L4/L5/L6 不再让异常逃出
  finally（不吞掉 return 值），统一记 warn。
- AC-8（G5）公开面全部入口拒绝 `file://`（launcher / API / 定时配置），错误可读；
  内部与测试通道不受影响（118 文件全绿）。
- AC-9（G6）红→绿对：网络类失败在窗口内重试并最终成功 / 窗口耗尽转失败且原因
  可读；鉴权类失败**不重试**立刻失败；`file://`（内部通道）维持既有硬失败。
- AC-10（G7）不变量由「有任务行就有工作树」改为「`__repo_prep__` 行 done 之后
  才有工作树」，其**全部消费点**逐处复核并有测试：后端四扇读洞
  （worktree-files / worktreeFileContent / codeIntel.fileSymbols / port-artifacts）
  - diff / resume / retry / GC / lifecycle repair / 备份 / boot reap / auto-resume /
    恢复熔断，**以及前端**（`resumeStatus` 不得把准备中/准备失败误判成
    `worktree-missing`、页签与恢复按钮随之正确）。
- AC-11（G7）重试语义：对 `__repo_prep__` 失败行点重试 = 重跑准备，**复用现有节点
  重试机制**（不新增状态/转移）；且 UI 上点得到。
- AC-15（G7）`__repo_prep__` 失败**不得**打 `workspacePrunedAt`（否则 retryNode 的
  复活判据撞 410 `workspace-pruned`），并锁住 gc/lifecycle 三处「恰好不误伤」的现状。
- AC-16（G7）服务端拒绝对 **done** 的准备行重试（今天路由不校验 nodeId 是否在定义里
  ⇒ 会对已有工作树的任务再物化一次）。
- AC-14（G7）取消/优雅停机/删除在准备窗口内生效，且**底层 git 子进程确实终止**
  （AbortSignal 串进 `runGit`/`spawnGit` 或 kill 进程组；顺带把 `gitCloneTimeoutMs`
  在启动路径接线——今天未接、落硬编码 30min）：`AbortController` 于准备开始前
  注册；回写与 kick 前的状态 CAS 复检，已取消任务**不得**被准备完成拉起执行。
- AC-6 每批 pin worktree gate 全绿 + exact-SHA CI 绿；实现门（独立子代理）。

## 6. 决策记录（2026-08-13 用户逐问拍板）

以 use-case 为准逐条反问后落定，实现期不得再自行改动：

1. **工作组撞合并冲突 = 丢弃**（用户原话「工作组冲突了就丢弃就行了」）。不做
   「保住工作树让人来解」的能力扩张；L1 的**三处**处置差异（throw→replay / conflict→abandon / `discardWrites`→abandon+done，
   第三处见 design §2）按声明式覆写登记并加豁免锁，防后人「顺手统一」把 RFC-187 事故引回来。
2. **脚本节点合并报错照 agent 节点抄**（保留 iso + markMergeFailed + 节点失败可
   单独重试）。经核实两条线的合并是同一原语、同一合并 agent、撞冲突行为已一致，
   唯一差异是脚本线少了 try/catch——纯漂移，无产品分歧。
3. **脚本节点成功后立即删 iso**（C2）。产品界面本就看不到节点 iso（worktree-files
   只服务任务主工作树），留存的唯一效果是磁盘与 `git worktree list` 残留。
4. **完整做骨架收敛**（用户选甲，而非「只摘三处漂移的小刀」）。前提是先补行为
   夹具再动刀（T1 扩容五件）。
5. **五条线，call 节点不进骨架**（用户否掉「为一条今天没漂移的线泛化许可接口」）。
   理由链：call 节点的许可是可取消的子任务配额、形状与信号量池位不同；强行统一
   最易做丢的恰是「排队中可被取消」这一用户可感知行为。灭绝锁给它显式留缺口。
6. **配额面可配纳入本 RFC**（G4，见 §2）。
7. **G6 保留，定性改为扩张**（第二轮设计门发现原前提错误：启动路径今天已硬失败）。
8. **`file://` 彻底不支持**——离线/内网隔离部署无法启动任务这一后果**已知并接受**，
   不留管理员开关。
9. **fanout 分片/聚合的 conflict-human 孤儿承诺顺手修成 abandon**（C8）；不做
   「per-shard 挂起等人」的反向扩张。
10. **G4 顺手修后端使配额真即时生效**（C9）——「改了不生效的设置项比没有更误导」。
11. **登记不做**：子任务配额机制本身的重估——用户指出全局只需控制三类叶子节点
    （agent/script/代码平台）的运行；而子任务配额既非算力保护（叶子池已兜）、亦非
    硬上限（resume 回 running 直接计入，文档自认「突发超额是接受的取舍」）、也不
    公平（深树插队致浅层饥饿，>60s 只记告警），且它自身曾制造队头阻塞死锁（P0-1）
    才长出祖先豁免扫描。真正被约束的成本是**工作树棵数**。是否改成直接限工作树、
    或取消只靠叶子池+GC，另立 RFC 评估，本轮维持现状。

## 7. 存量 `file://` 的处置（2026-08-13 拍板：不做 grandfather）

**决策（第二轮门后精确化）：拒「运行」两面——启动 + 镜像刷新**。任何以 `file://`
为仓库源的启动一律以「非法参数」拒绝，含手动启动、定时任务触发、webhook 触发；
**`POST /api/cached-repos/:id/refresh` 同样拒绝**（否则刷新会让存量 `file://` 镜像
无限期保鲜，与「这条路已废」的叙事相反）。**注册/批量导入/仓库组保存面不动**——
存量仓行仍在列表里可见、历史任务可查，只是不可运行也不再保鲜。不区分新建与存量；
错误是明确的参数校验失败（可读的错误码 + 指引：把仓推到真实远端后重新注册，
或改用临时空间），不是静默降级、也不是延后失败。

存量数据不删（仓库行仍在列表里可见、历史任务照常可查），但它**不可再用于启动**。
RFC-165 D3 当年把路径模式的定时任务自动迁移成了 `file://`，这些定时任务在本 RFC
落地后每次触发都会失败并留下失败记录——这是**有意的、可见的断裂**，优于让它们
继续基于可能陈旧的本机仓静默跑下去。
