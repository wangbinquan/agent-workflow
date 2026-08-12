# 系统公共功能全局归一审计（2026-08-12）

> 起因：用户问「调度器、执行器、资源管理、权限管理、任务管理、执行能力抽象等系统公共功能
> 是不是已完成全局归一，且目录模块划分明确、模块边界清晰，没有特殊处理」。
> 方法：11 路并行独立审计（6 子系统深审、横切特殊处理猎手、依赖图 SCC 实测、
> 已登记欠账对账、前端组件/数据层两路），随后主 session 交叉对账并逐条向用户反问拍板。
> 审计基线：main ≈ `e7361b02`（审计中途 RFC-280/282 收尾 `17b9215b`…`e75a05ff`/`d6760d24`
> 落 main，结论按其后 HEAD 审定）。
> 处置：本报告 §6 的包①随本报告同批落地；其余按 RFC-284…289 执行（§6）。
> **决策台账 §5 是后续全部 RFC 的输入契约**——接手 RFC-284…289 的 session 必读。

## 0. 总判定

| 问题               | 答案                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全局归一了吗       | **判定层/状态机层/spawn 层：是**——RFC-280「唯一 spawn 点」、RFC-282「ACL 单源 / buildSpawn 单面 / runtime 分支清零」经独立复核全部兑现。**装配层/CRUD 形态层/微 helper 层：残留成片**（六类资源 CRUD 六份手写、scheduler 六条同构装配线、safeJson×20 等复制）。 |
| 目录模块划分明确吗 | 可运维但非「明确」：services/ 下 172 平铺文件 vs 15 子目录是**历史沉积而非成文约定**（clarify/ 目录 1 个文件、5 个 clarify\*.ts 平铺在外反向 import 它；四个「ref」概念各立门户）。                                                                             |
| 模块边界清晰吗     | **防护成体系、账本诚实**：Tarjan SCC 实测 5 个值级循环全部与 `scripts/depcheck.ts` KNOWN_VIOLATIONS 吻合、零账外环。但 routes→db 直查（18/44 路由文件）与 util→services 两个方向完全无防护规则。                                                                |
| 没有特殊处理吗     | 纪律明显强于常态：全仓零裸 TODO/HACK 标记、零测试环境行为分叉（45 处 seam 全契约化）、fail-open 全显式带 RFC 锚、scheduler.ts 内 `process.env` 零命中。存在的特化基本是有 RFC/测试锁定的合理特化；真正的债是**重复实现**而非暗门。                              |

## 1. 六大子系统记分卡

| 子系统       | 归一度 | 核心证据（复核过）                                                                                                                                                                                                                                                                              | 主要残留                                                                                                                                                             |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 调度器       | 高     | frontier 单引擎（旧 `computeReadyNodes` 降级 test oracle，freshness.ts:114-119）；node-kind 编译期穷尽单表（shared/node-kind-behavior.ts:100-203）+ 链尾 `unhandled-node-kind` 响亮失败（scheduler.ts:5126-5131）；workgroup/动态工作流是注册表路由（scheduler.ts:738-743）的显式第二模型非漂移 | scheduler.ts 9791 行内六条同构 spawn 装配线（→RFC-287）；fanout 内层旁路小引擎（已登记 WP-6b→RFC-289）                                                               |
| 执行器       | 高     | agent 类 `Bun.spawn` 全仓仅 managedProcess.ts:250 一处；7 消费方全经 `runAgentProcess`；治理语义（TERM→KILL/reap/drain/上限）单源                                                                                                                                                               | 工具类 spawn（npm 安装/探针）各自手抄弱杀链（已登记族，backlog「其他 backlog」节）；`drainTimedOut` 无人消费（新）；缺全仓 spawn 棘轮锁                              |
| runtime 抽象 | 高     | runtime 字面量执行分支 driver 目录外真零；`?? opencodeDriver` 改显式 throw + fence 测试（rfc282-c0c2）；唯一 `buildSpawn` 五链全走；ESLint 密封栅栏有真配置变异测试；driver 零反向依赖                                                                                                          | selfCheck 不验「声明 inventory-file ⇒ 实现 readInventory」蕴含（新增 kind 最大漏点）；declared 与注入 business 面两次计算（已登记 deferred，RFC-282 plan §实施记录） |
| 资源管理     | 中高   | ACL 判据/grant SQL/name→id 入口/RFC-271 codec 四域单源兑现；路由 ACL 面六类完全同构；创建默认三元组单点                                                                                                                                                                                         | 「六类对称」只在 ACL/引用层成立：修订 fence 六种拼法、反查引用四份复制、删除任务引用强度三档；`resourcePolicy.ts` 'agent' 条目基于不存在的列（P1 事实错误）          |
| 权限         | 高     | resourceAcl.ts 单源真实成立；RouteMeta 声明式 gate + 双向启动自检（routes/registry.ts:356-378）；非 HTTP 入口（MCP/webhook/scheduled/CLI/bundle）全构造同构 Actor 无第二实现；未发现新 fail-open                                                                                                | 任务域 403/404 双轨（语义分叉）；快照式可见性三份同构手写；两个已登记旧洞（review 冒名 / ws-repo-imports）                                                           |
| 任务生命周期 | 高     | 三条状态机全收敛 lifecycle.ts CAS+转移表 + 源文本棘轮（s14 钉恰好 1 处直写）；11 启动入口全过 `startExecution` 门面 + 源文本锁；修复七模块职责正交                                                                                                                                              | call 子任务 `as unknown as` 伪造 Actor；retry_index 取号 4 处手写；若干注释与现实相反                                                                                |
| 前端         | 高     | 六大高危面（modal/tabs/segmented/骨架/WS/chip）实测 100% 归一零逃逸；HTTP/WS/错误/状态骨架单点且有 RFC 锚                                                                                                                                                                                       | 死 class ×8（报错无错误视觉，真实 bug）；原语建成迁移未收尾（Checkbox 8 处、Card ~151 条 bespoke）；queryKey 双轨                                                    |

## 2. 核实为已归一的面（正面清单选摘，均经独立子代理带锚复核）

- **调度**：状态机单源 shared/lifecycle.ts（node_run status + merge_state 两台机）；node_runs 插入单厂 nodeRunMint.ts + grep 守卫；边分类注册表 shared/systemChannelPorts.ts（RFC-147）；wrapper 三类共用 resume/terminal/progress 辅助、loop/git 内层递归复用同一 runScope；exit_condition 单模块；fanout fail-all-after-join 有测试锁；并发池注册表 resize-on-read；回滚单权威 nodeRollback.ts；注入解析单点 resolveInjection 6+6 调用点配对。
- **执行**：pump 单实现；outcome 六态映射单源 agentProcess.ts mapOutcome；startupVerification 三层由 `capabilities.startupObservation` 能力枚举驱动、读端单点；testOnly seam 全显式；平台分支收敛 util/platformExec.ts（负扫描锁）。
- **runtime**：`opencodeCmd` 收敛 binaryOverride + mint 冻结（nodeRunMint.ts:493-546）；boundary 各归各 driver；新 kind 编译期表态多层（Record 穷尽 + declarationFaces 派生 + boot 拒启）；会话 lease runtime 无关（(protocol,sessionId) CAS）；降级路径全带结构化 warn 码；driver.kind 目录外零引用。
- **权限**：六类资源路由同形（filterVisibleRows / canView→404 / requireResourceOwner 六文件无例外）；PAT 公式单点 + 矩阵越权 422；launch 闭包名解析按 actor 可见性过滤（closure.ts:242-256）；prompt 隔离双层锁在位、新组装点复核无泄漏；凭据链 fail-closed（disabled 过滤、WS 撤权即时重扫）。
- **任务**：resume/retry 单核 resumeKick（7 调用面无旁路）；worktree 生命周期单点（两阶段墓碑 claim↔revive CAS 对偶）；修复七模块正交（lifecycleRepair.ts=引擎 + lifecycleRepair/=per-rule 插件包，非同名冲突）。
- **边界**：shared 零反向；db 零反向；services→routes 仅 1 条已记账；runtime/ 零上层依赖；5 值环全部在 depcheck 账本（零账外）；防护制度清单——ESLint 跨包+密封栅栏（真配置变异测试）、dep-cruiser 四规则、depcheck 三棘轮、A2 单实现锁+禁止词族、写纪律 grep 锁群、启动自检×2、类型穷尽 Record×3。
- **前端**：Dialog 64 文件（window.confirm 零）；原生 select 零；Segmented 37/TabBar 17 手拼零；ErrorBanner 105/EmptyState 67/LoadingState 70；WS 一份实现（useWebSocket.ts:152 唯一 new WebSocket）+ 表驱动 invalidation + 10 领域薄封装；HTTP 单点 api/client.ts（RFC-208 双超时预算）；stores 刻意薄（155 行零状态库）；lib 主体纯函数。

## 3. 新发现问题与处置去向

严重度分级；「去向」列为处置载体。P1：

| #   | 发现                                                                                                                                             | 锚点                                                                                            | 去向                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------- |
| N1  | `resourcePolicy.ts` 'agent' 条目声称 agents.enabled 列存在——schema 里没有，且经 selfCheck 原样输出给运维；恰犯自身注释警告的 RFC-280 P2-D 反模式 | services/execution/resourcePolicy.ts:18-25,71-76 vs db/schema.ts（agents 表 24-103 无 enabled） | RFC-284（决策 D2：删条目+守卫断言） |

P2（结构性，纯实现）：

| #   | 发现                                                                                                      | 锚点                                                                                                             | 去向                                                   |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| N2  | selfCheck 缺「声明 inventory-file ⇒ 实现 readInventory / init-event ⇒ parseStartupInventory」蕴含守卫     | runtime/selfCheck.ts:48-52；消费双源 runner.ts:1793,1828-1838                                                    | RFC-284                                                |
| N3  | session-not-found stderr 方言四条正则全 opencode 措辞却在公共层对所有 runtime 调用；claude 告警静默缺失   | sessionModeFallback.ts:97-102；scheduler.ts:6041                                                                 | RFC-284（D10 下沉 driver）                             |
| N4  | mcpRuntimeTest 手写二元 cast 绕开 shared 完备性设计；新增第三 kind 编译过运行时 TypeError                 | mcpRuntimeTest.ts:2547 vs shared/runtimeConfigDir.ts:23-26                                                       | RFC-284                                                |
| N5  | runner 丢弃 `drainTimedOut`（尾流丢失取证降级零消费；envelope 静默取旧值无线索）                          | runner.ts:1256-1258（对照 systemAgentRun.ts:593-598 有消费）                                                     | RFC-284（D9 进观测面）                                 |
| N6  | bundle plugin-create 手写 initialAcl 字面量，RFC-231 创建默认单点唯一破口                                 | services/bundle/apply.ts:743                                                                                     | RFC-284                                                |
| N7  | skill 名称唯一性自写两套原语（六类唯一不走 ownerScopedName 共享对）                                       | skill.ts:123-139,233-241,355-360                                                                                 | RFC-284                                                |
| N8  | 快照式可见性判定三份同构手写（ws 两份 admin 正确性依赖 60 行外旗标非局部不变量）                          | ws/registry.ts:383-416；mcpRuntimeTestTransitions.ts:126-133                                                     | RFC-284（抽 isVisibleToAudienceSnapshot）              |
| N9  | by-resource grant 集 SQL 五处平行（D2 只单源了 by-user 形状）                                             | resourceAcl.ts:401-404,553-558；workflow.ts:741-745；workgroups.ts:560-563；mcpRuntimeTestTransitions.ts:251-256 | RFC-284                                                |
| N10 | webhook 域整个 CRUD 长在路由层无 service 对应物；routes→db 方向无任何防护规则                             | routes/webhookTriggers.ts:201-220,302,371；routes/webhookEndpoints.ts×5                                          | RFC-284（规则+记账；抽 service **排 RFC-283 落地后**） |
| N11 | 任务域「不可见」403/404 双轨构成存在性 oracle（taskQuestions.ts:41-44 注释还说反了）                      | routes/tasks.ts:1224-1226 vs taskCollab.ts:53-70（RFC-248 H9）                                                   | RFC-285（D1 统一 404）                                 |
| N12 | 「扫 agents JSON 列反查引用」四份复制 + 接口三处重复定义（skill 版还缺 LIKE 预过滤）                      | mcp.ts:360-427；plugin.ts:311-377；skillReferenceGuard.ts:20-84；agentDeps.ts:228-245                            | RFC-284                                                |
| N13 | 内容修订 fence 六类六种拼法、stale 错误码 4+ 种                                                           | agent/workflow/workgroups/mcp/plugin/skillToken 各文件（详见审计原文）                                           | RFC-285（D6 错误码归一）+ RFC-284（选型表文档）        |
| N14 | 删除任务引用强度三档无横向文档；三份 scheduled 引用扫描纯复制                                             | workflow.ts:682-695；agent.ts:661-689,804-818；workgroups.ts:528-592,894-931                                     | RFC-285（D5 统一中档）+ RFC-284（扫描单点）            |
| N15 | call 子任务 `as unknown as` 伪造空权限 Actor；owner 失活后仍可拉起新子任务（与 scheduled/webhook 不对称） | scheduler.ts:3867-3870                                                                                           | RFC-285（D7）                                          |
| N16 | 前端死 class ×8：error-text（6 处）/checkbox-row/form-error——报错无错误视觉的真实 bug                     | routes/tasks.new.tsx:2235 等；intent.detail.tsx:1263；review/MultiDocReviewView.tsx:662                          | RFC-286                                                |
| N17 | bare fetch ×3 + 自写第二 error decoder（client.ts:146-149 明文禁止形态；apiGetBlob 闲置）                 | lib/worktree-download.ts:26,60；WorktreeFilesPanel.tsx:284；ImportZipPanel.tsx:963-982                           | RFC-286                                                |
| N18 | resourcePackages wire 类型前端手写副本（shared 零对应；全仓其余 334 处走 shared）                         | frontend/api/resourcePackages.ts:13-60+                                                                          | RFC-286                                                |
| N19 | queryKey 双轨、同 key 双定义；WS invalidation 靠字符串相等纪律                                            | lib/mcp-probe-query.ts:22 vs routes/mcps.detail.tsx:55 等                                                        | RFC-286（D16 只收 WS 关联族）                          |

P3（选摘；完整清单见各子代理存档结论，均已納入 RFC-284 任务分解）：

- N20 微 helper 复制族：safeJson×20（17 个 routes 各一份）、containment「lexical+realpath 双查」3+ 份安全关键副本（envelope.ts:131-160、portArtifacts.ts:227-283）、hash 包装~11、drained race 逐字拷贝×2、探针三胞胎杀链已分叉、monotonic updatedAt×4 →RFC-284。
- N21 pluginInstaller npm 安装弱治理 spawn（单 pid kill 无树杀；孙进程泄漏）；probeIndexer 无超时（HTTP 路径可挂死）；probeInterpreter 杀链弱 →RFC-284（已登记族的提级处理）。
- N22 「唯一 spawn 点」缺全仓棘轮锁（backlog 自认 containedSpawnRegistry 从未存在）→RFC-284。
- N23 diffSplit.ts 生产死代码被测试锁活 + CLAUDE.md §Multi-process node 描述已删机制 →包①（文档）+RFC-284（D12 删除）。
- N24 buildChildDeps 手工漏斗（两次真实漏配事故）→RFC-284（整体透传结构）。
- N25 retry_index 取号 4 处手写口径微差 →RFC-284（nextRetryIndex helper）。
- N26 定时器 cadence 散布 8+ 处、start.ts:805,828 裸 1h 字面量 →RFC-284。
- N27 S4 告警对子任务无豁免叠加 childBudget 噪音 →RFC-284（D11）。
- N28 util/opencode-models.ts 未随 C3 搬迁；resolveOpencodeCmd 死导出；legacy ctx 三套并存 →RFC-284。
- N29 2 个未文档化 env 开关（AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS、AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS 且后者是 env 型 test seam 违例）→RFC-284。
- N30 REST 面接受 `?token=` query 凭据（正当消费方仅 WS 升级）→RFC-285（D8）。
- N31 create 路径隐式 system 逃生门与 update 显式 principal 不对称 →RFC-284。

## 4. 登记面失真与对账（包①已处置）

本次审计最重要的横切发现：**代码比账本新**。逐条核实后随包①修正 `docs/audit-backlog.md`：

1. backlog「retryNode cascade 不取消下游子任务」——已被 RFC-243 D12 修复（task.ts:3531-3622：affectedChildTaskIds=target+全 downstream、cancelTask cascadeFromParent、取消失败关回 failed）。销账。
2. backlog P0「cached_repos 明文 URL 凭据泄漏」——已被 RFC-204 修复（shared/schemas/cachedRepo.ts:5-15 wire 删明文 url；gitRepoCache.ts:233 仅上 urlRedacted）。销账（内部结构仍持原 url 供 daemon 侧解析，不出 wire）。
3. 实机验收 C/D/E——已分别被 RFC-273（intent/turnEngine.ts 失败轮取证）/ RFC-274（workgroup/systemMessages.ts closed template registry）/ RFC-275（db/schemaAdmission.ts 启动准入）收口。回填。
4. backlog「RFC-247 已加 --ignore-scripts」记载失实——实测 pluginInstaller **没有**该 flag（scriptDepsEnv.ts:165 的脚本依赖安装有）；插件安装生命周期脚本 RCE 面仍开。修正记载。
5. remote MCP header 进 claude argv——RFC-280 §7.1 已改为写 0600 `mcp-config.json` 文件传路径（claudeCode/driver.ts:64-73 "THE mcp-config write"），backlog 两处未同步（dev-gotchas.md:134 已正确记录关闭）。销 argv 半边；`mcps.config.headers` at-rest secretBox 半边保留未决。
6. `agent.network` 半落地失归宿（原挂 RFC-252 G4，G4 已被用户关闭）——实际已随 RFC-276 收口废弃：shared/schemas/agent.ts:345 现为 `network: z.never().optional()`（拒收），脚本节点侧 schemas/workflow.ts:897-903 报 removed。销账。
7. **sandbox-era 整簇失效**：RFC-276（2026-08-10）物理删除 sandbox/containment/netless/verified 体系（services/sandbox/、runtime/opencode/verifiedPlan.ts、runtime/binarySnapshot.ts 等均已不存在），backlog 中「运行时/沙箱能力收口盘点」「沙箱/containment 功能性审计」「RFC-252 残留」「RFC-224 能力回退」「verified TOCTOU」「RFC-254 verified 簇」等节的大量条目已失去载体（含 :1290 的 P1「verified 快照丢扩展名」——模块已删）。包①给相关节加 supersession 横幅；**逐条重定性登记为独立欠账**（见 §7）。
8. RFC-282 索引状态列畸形（"Draft v2" 打头 + 结尾 "Done"，按「四选一打头」规则被读为 Draft）+ followup 措辞过期（二次收尾已全清）。包①修正为 Done 打头。
9. 注释与现实相反簇（本仓注释是接手复核依据）：exitCondition.ts:27-29（null 语义写反）、scheduleLaunch.ts:8-9 + execution/executor.ts:10-12（断言 fire 时无校验门，实际 scheduledTasks.ts:755→271 每次跑 assertWorkflowLaunchable）、workspaceBoundary.ts:149-150（gitMetaDirs 两 driver 现在都填）、runner.ts:2104-2111（描述已删 re-export）、claudeCode/driver.ts:3-6（描述已不存在的 runtime-branched 装配）、runtime/index.ts:70-73 + types.ts:556-558（config 头描述过时）。包①逐条修正。

## 5. 决策台账（2026-08-12，用户六轮反问逐条拍板）

> 后续 RFC 的输入契约。「不要自己做臆测」——本台账之外的新设计歧义须继续反问用户。

| #   | 决策                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 任务域「无权查看」统一到 **404 与不存在同形**（tasks/reviews/clarify 详情 403→404；更新测试锁与前端文案；对齐 RFC-248 H9 反枚举）                                                                                                                                                                                                                                                                                       |
| D2  | resourcePolicy **删 'agent' 条目**（无列即不入表）+ 新增「DisableableResourceKind 每条目必须真有 enabled 列」守卫断言；将来真要 agent 启停再随功能 RFC 加回                                                                                                                                                                                                                                                             |
| D3  | 三个大件**全部立项**：scheduler 六条装配线收敛（RFC-287）→ WP-5 task↔scheduler 环拆解（RFC-288）→ WP-6b fanout 内链根治（RFC-289），依此顺序、排在小 RFC 之后                                                                                                                                                                                                                                                           |
| D4  | skill 不可改名**定为设计**：补裁决注释（目录名=FS 身份=opencode registry key，改名等于身份迁移）锁定于 UpdateSkillContentSchema 与 skill.ts                                                                                                                                                                                                                                                                             |
| D5  | 六类资源删除时的任务引用拦截**统一到中档（只拒非终态引用）**：workflow 放宽（能力扩张）、workgroup 收紧（能力收缩，按 CLAUDE.md 第 7 条列能力影响清单呈批）                                                                                                                                                                                                                                                             |
| D6  | fence 机制保持各自；**stale 错误码归一为 resource-operation-stale 族**（前端同批适配）+ 六类 fence 选型表文档                                                                                                                                                                                                                                                                                                           |
| D7  | **owner 失活即拒启 call 子任务**（新错误码、父任务 call 节点明确失败收场）+ 显式 InheritedActor 构造器取代 `as unknown as`                                                                                                                                                                                                                                                                                              |
| D8  | query token **收窄到仅 /ws/\***：REST 面只收 Authorization Bearer（先排查存量 REST query-token 用法，如有同批迁移）                                                                                                                                                                                                                                                                                                     |
| D9  | drainTimedOut：runner 打结构化 warn + **并入 node_runs.startup_verification_json 观测面**（StartupVerificationBanner 已有展示通道）；envelope 解析失败时错误信息带「尾流截断」定向诊断；节点成败不变                                                                                                                                                                                                                    |
| D10 | session-not-found 方言检测**下沉 driver 可选方法** detectSessionNotFound(stderr)；claude 补缺失判据；公共层只调能力面                                                                                                                                                                                                                                                                                                   |
| D11 | S4 pending 告警：**子任务行（parent_task_id 非空）提高阈值（30min 级）**+ detail 标注可能在等 childBudget；顶层任务维持 5min                                                                                                                                                                                                                                                                                            |
| D12 | **diffSplit.ts 删模块+两个测试**；CLAUDE.md §Multi-process node 改写为现行 RFC-103 list 逐项分片机制                                                                                                                                                                                                                                                                                                                    |
| D13 | Card 迁移本轮不做（登记）                                                                                                                                                                                                                                                                                                                                                                                               |
| D14 | 新前端原语（CopyButton/MetaGrid/LocalizedDateTime/CollapsibleSection/MetaDots/gradient token）本轮不做（登记）                                                                                                                                                                                                                                                                                                          |
| D15 | intent 反问选项 UI 归一本轮不做（登记）                                                                                                                                                                                                                                                                                                                                                                                 |
| D16 | queryKey **只收 WS 关联族**（tasks/reviews/clarify——被 WS 规则表与 route 双端引用的 key 抽工厂、双端 import 同一符号）；其余 inline 保持                                                                                                                                                                                                                                                                                |
| D17 | 前端本轮范围=**死 class 真实 bug + 数据层**（bare fetch 收敛 / resourcePackages 类型下沉 / D16）；其余 UI 层（form-input 直落 / Checkbox 收尾 / 死 CSS / F 系清单）全部登记                                                                                                                                                                                                                                             |
| D18 | services/ 目录**轻规则成文 CLAUDE.md**（≥5 文件共享前缀且互引 → 优先落同名子目录；存量不做一次性大迁移、随各域下一个 RFC 顺带迁）+ **clarify 家族本轮迁入 clarify/ 作示范**（迁移前确认无他人在途改动）                                                                                                                                                                                                                 |
| D19 | 处置打包认可：包①（对账+注释直接做）→ RFC-284 抽象去重与防护制度化（零行为）→ RFC-285 语义统一与权限收口（行为变更）→ RFC-286 前端数据层 → RFC-287→288→289 大件依次                                                                                                                                                                                                                                                     |
| D20 | 存量 P2 四洞**全部拉入 RFC-285**：review 评论作者校验（+delete decided 冻结）、/ws/repo-imports batch-ownership gate、导入 visibility 硬编码 public 收紧为 private（对齐 RFC-231，列能力影响）、memory distill 门（见 D21）                                                                                                                                                                                             |
| D21 | **memory 权限模型更新**：①「资源管理员」= admin+manager（现有 isResourceAdminRole 谓词）可**管理所有记忆**；②读面：资源 scope 随绑定资源可见性（现状）、**repo 与 global scope 放宽为全体登录用户可读**；③管理面：随 scope 资源写权（现状）+ 资源管理员全量兜底；④**distill 蒸馏任务详情（含 LLM 会话）读门=仅资源管理员**（后端补门与 UI 对齐；backlog 前端谓词漂移〔usePermission('memory:approve') 恒 true〕同批修） |
| D22 | **auth 下沉为底层**：authLoginPolicy 迁入 auth/、消除唯一反向值边；加 no-auth-to-services 方向规则（auth 只准依赖 db/util/shared）                                                                                                                                                                                                                                                                                      |

## 6. 处置路线

| 载体                         | 内容                                                                                                                                                           | 状态              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 包①（本报告同批）            | §4 全部对账修正 + §4-9 注释修正簇 + skill 裁决注释（D4）+ driverLease 互斥契约注释 + CLAUDE.md 两处（D12 文档半 + D18 规则）+ RFC-282 索引置 Done + 本报告落仓 | 随本提交落地      |
| RFC-284 抽象去重与防护制度化 | §3 标注 RFC-284 的全部条目；零行为结构收口；含 clarify 迁目录（D18）、webhook CRUD 抽 service（**排 RFC-283 落地后**，避免并发冲突）                           | 三件套待落档→请批 |
| RFC-285 语义统一与权限收口   | D1/D5/D6/D7/D8 + D20 四洞 + D21 memory 模型；每条列能力影响清单                                                                                                | 三件套待落档→请批 |
| RFC-286 前端数据层与死 class | D16/D17 范围                                                                                                                                                   | 三件套待落档→请批 |
| RFC-287 装配线收敛           | D3 大件一：runNode 六站点+script/call 装配骨架参数化收敛                                                                                                       | 排 284-286 实现后 |
| RFC-288 WP-5 环拆解          | D3 大件二：taskDriver 断 8 模块 SCC，depcheck 账本 6 条销账                                                                                                    | 排 287 后         |
| RFC-289 WP-6b fanout 内链    | D3 大件三：shardKey 解析+拓扑序派发，解除 validator 挡板（能力扩张）                                                                                           | 排 288 后         |

## 7. 本轮不修、登记待后续

- 前端 UI 层清单（D13-D15/D17 划出）：Card 迁移（~151 条 bespoke 规则）、新原语 Top 清单（CopyButton 8 文件/MetaGrid 16 文件/LocalizedDateTime 36 处/CollapsibleSection 33 处/MetaDots 7 文件/装饰 gradient 18 处三组重复色值）、intent 选项 UI 复用 QuestionForm、canvas inspector form-input 直落×5、Checkbox 迁移收尾 8 处、死 CSS ≥17 namespace（~300+ 行）、33 处裸 details、copy 状态机 8 文件。
- fanout hydration 与主派发对坏引用的语义分叉（scheduler.ts:6951-6954 注释在案，用户可见结果收敛）——待 RFC-271 后续收敛为声明式差异。
- DB 列 `opencode_session_id` 对 claude 会话同用（行为无碍，改名需迁移，收益纯命名）。
- syncTaskWorkflow 未开 worktree 预检（task.ts:2893-2897 "for now"）——RFC-165 复活门兜住墓碑行，缺口仅「墓碑未打但 dir 已丢」；待 sync harness 用真 worktree 时开启。
- node_run id 单调性依赖普通 ulid()（backlog 既有登记保持）——正解持久递增 generation，属独立设计。
- **sandbox-era backlog 条目全量重定性**（§4-7）：RFC-276 删除机制体系后，backlog 相关节需逐条判「moot / 转世为新形态欠账 / 仍有效」，工作量约数十条，独立对账轮执行。
- RFC-282 自留 deferred（其 plan §实施记录在案，不重复登记）：declaredMcpServers 由 declared.mcpServers 承接、business 面声明与注入「真身合一」（B4 式）。
