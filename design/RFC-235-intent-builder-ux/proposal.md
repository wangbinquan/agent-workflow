# RFC-235 意图构建完整创建体验 UX 重构 — proposal

状态：In Progress v22（2026-08-11 用户已批准按当前主干完成实现并上库；v22 是当前规范，v21 仅作历史审计记录）

触发：2026-07-28 用户反馈「意图创建的界面太丑了」；真实浏览器核对现状后，用户选择
**方案 A：重做完整意图构建体验**，而不是只美化创建弹窗。

依赖：[RFC-234 意图驱动的资源构建](../RFC-234-intent-driven-builder/proposal.md)。

## 0. v22 当前主干重审与规范优先级

2026-08-11 按用户要求重新从 `main` 的真实代码与已完成 RFC 反向审视后，v21 不能继续原样
实施。v21 的二十轮设计门把 Intent UX 与当时尚未定型的运行期加固、artifact broker、备份恢复
和 worktree reconstruction 绑成了一个巨大交付；其后 [RFC-276](../RFC-276-runtime-hardening-deprecation/proposal.md)
已明确删除 sandbox/containment、verified execution identity、hermetic store、netless 与对应
API/UI/DB surface。继续实现 v21 会把主干刚删除的架构重新引入。

本节与 [design.md 的 v22 设计](./design.md#0a-v22-当前主干设计) 具有最高规范优先级；下文 v21
历史中与本节冲突的 mutation ledger、artifact V3、broker control、backup/restore、platform
containment 与 worktree reconstruction 条款全部 `Superseded`，保留文字只为解释历史 gate，不再是
验收项。

v22 固定以下边界：

1. **保留 RFC-234 的现行安全与落地内核。** ACL、owner-only mutation、OCC、secret slot、
   immutable draft、apply journal 与 all-or-nothing 继续权威；不新建第二套 ledger。
2. **Intent 暂不迁移到 RFC-271 `BundleApply`。** RFC-271 已明确只为未来迁移预留 provider，
   本次继续使用已上线且覆盖 Intent provenance/copy/secret 语义的 `applyIntentChangeset`，避免把
   引擎迁移风险与 UX 收口压在同一变更里。
3. **不恢复 RFC-276 已删除的运行期加固。** Intent turn 继续使用当前 natural runtime；现有
   durable Session event capture 与共享 `SessionConversationPanel` 保持不变。
4. **服务端成为业务阶段的唯一投影者。** 列表与详情都消费 strict `journey` DTO，不再用
   `turnSeq/commitSeq/currentDraftRevision` 在浏览器猜“第几步”。
5. **完成整个创建旅程，而非只换皮肤。** Auto 与六类资源选择分层；最近任务可分页；详情在
   小屏以“构建/复核”页签切换；问答与挂载审批使用语义化时间线；挂载只显示 actor-safe 名称；
   64-op changeset 采用资源目录 + 单项预览；唯一当前行动固定在复核区；提交使用
   Strategy → Details → Review Stepper，并在网络重试中复用同一 `clientMutationId`。
6. **四步语义不变。** `Goal / Generate / Review / Apply` 是任务状态的业务骨架；“运行中”只能是
   Generate 或 Apply 内的原因，不再作为与四步并列的泛化标签。

### 0.1 v22 验收增量

- 列表与详情对 generating、awaiting answers、review ready/blocked、applying、apply failed、
  applied、archived 给出同源的四步投影与下一行动原因；分页后顺序稳定且无重复。
- create/message/answers/retry 在成功响应可见前已经持久化对应 `running` reservation；runtime 配置或
  启动失败成为 durable agent error turn，不能落成“用户消息已收下但任务看起来还在第 1 步”的
  静默窗口。
- agent `mountRequests` 能被 owner 明确批准或拒绝；服务端只返回 actor 当前可见的候选，整批决定
  绑定 source turn + expected seq/context 后原子落库，不能审批旧建议或部分挂载；管理员审计只读，
  不能借审批扩大写权限。
- mounted context 显示资源类型 + 可读名称，不把内部 handle/id 当主要信息；历史回答与审批不再
  渲染裸 JSON。
- 390px 宽下默认打开当前最需要处理的“构建”或“复核”页签；切换页签不卸载状态；桌面继续
  双栏。长 Session 执行树、64 个 ops、长名称与空/错误/stale 状态都保持单一滚动边界。
- changeset 同时只挂载一个富预览（工作流继续复用只读 `WorkflowCanvas`），目录可键盘选择；
  Review CTA sticky 且只在当前草稿可提交时进入 Commit Stepper。
- Commit Stepper 锁 pending dismissal、分步校验必需 slot、最终页展示策略与输入完成度；同一次
  dialog 的失败重试复用同一 mutation id，关闭后才换新 id，密钥不进入 timeline、缓存或日志。
- shared/backend/frontend 定向测试、三包 typecheck/lint/format/depcheck、真实浏览器 desktop/
  390px light/dark、axe 与完整 `bun run gate:local` 通过；实现门无未闭合 P0/P1/P2 后方可 Done。

## 1. 背景

RFC-234 已交付核心业务闭环，但前端仍保留功能落地期的通用页面拼装：

1. `/intent` 空页由 `PageHeader + EmptyState` 组成，页面头和空状态重复放置「新建意图
   会话」，主内容区留下大片空白；已有会话使用通用表格，在窄屏只能横向查看。
2. 创建入口是默认 520px `Dialog`，正文只有一个 `TextArea` 和一个 `Select`。它没有解释
   「先描述目标，不必先决定资源结构」，没有可复用示例，也没有在主行动附近说明
   「只生成草稿、提交前不会修改资源」。
3. 390×844 下默认 Dialog 顶部留白、正文和两级辅助文案共同挤压主输入，产物类型仍是一个
   难扫读的下拉；整张弹窗像后台配置表，而不是 AI 共创入口。
4. `/intent/$sessionId` 把时间线、问题、挂载、草稿、提交记录和继续调整依次堆成多个
   `.page__section`。用户必须纵向寻找当前阶段与下一步；`Review & commit` 会随长预览落到
   折叠线下，生成中、待澄清、草稿可提交和 stale/error 没有统一阶段表达。
5. 时间线每一轮都使用同形 `.card`，用户/Builder/错误/变更集缺少角色与事件层级；
   `answers` 直接渲染 JSON。草稿卡片虽有四类富预览，但与对话没有明确主从关系。
6. 提交弹窗把 apply mode、密钥、waiver、人类绑定和命名槽位纵向平铺。资源多时用户无法
   先理解修改策略、再补齐必需信息、最后整体复核。
7. RFC-234 wire 已支持 `multiSelect=true` 问题和 agent `mountRequests`，但当前前端把所有
   问题都投影成单选，并且没有批准/拒绝挂载建议的交互；`mount-approval` 历史 turn 也只得到
   空的通用卡片。这是完整创建体验里实际不可达的既有合同，不应被视觉重构继续掩盖。
8. 首轮 source-backed 设计门进一步证明，当前 wire 无法可靠支撑新 UX：generation 请求与
   agent `running` turn 之间存在不可见启动失败窗口；answers/mount approvals 没有 source-turn
   fence；apply journal 缺少可排序、可关联的 attempt 投影；archive 可与 apply 交错。若只在
   前端“根据文本、时间戳或 revision 猜”，界面会更漂亮，却可能把另一标签页的副作用误当成本次
   操作成功。
9. 第二轮隔离门禁继续找出四个 supporting-contract 缺口：create/turn/journal 各自占用
   `clientMutationId`，跨 endpoint 无统一 namespace；reservation 落库到 runner 接管之间仍可能
   在 daemon 存活时失主；旧 journal 回填 `attemptSeq` 后 session counter 仍可能从 0 开始；
   create/manual mount 的 route 外 ACL/active 检查可被撤权、删除或 archive 穿过。它们必须在
   实施视觉层前闭合。
10. 第三轮隔离门禁确认上述四项中两项闭合、两项被更精确的新风险取代：route-independent
    dispatcher 若没有持久 run-as principal，route actor 消失后可能永远不运行，或错误回退
    system actor 读取普通 owner 已不可见的私有资源；HMAC 若签的是 lossy normalized body、
    executor 却继续消费 raw body，则重复/换序 decisions 可能在真实副作用不同的情况下被当作
    exact replay。v4 必须把当前 session owner 的执行身份和唯一 normalized execution object
    都变成持久、可验证的合同。
11. 第四轮隔离门禁确认上述两项的核心分别已具体化/闭合，但找到一个 P0 与两个 P1：
    apply preflight 后若资源转让 owner，旧 route actor可在 final transaction 以
    resource-admin 身份原地改写本应 copy-only 的 Workflow/Workgroup；dump 的异步 catalog 与
    spawn 之间没有 ACL disclosure 线性化点，撤权后的 private 内容仍可能进入模型；
    answers/approvals 若在 owner 404 gate 前读取 source turn，会形成私有 question/request 内容
    oracle。v5 必须把 apply run-as/final target authority、两阶段 disclosure admission 与
    owner-first source hydration 变成可测试合同。
12. 第五轮隔离门禁逐项关闭了第四轮三项 finding，但证明 apply 的“先补偿、再 terminal
    failed”仍是假合同：Plugin generation id 在 installer 内部临时生成，journal 只有
    `pluginId`；Skill reserve operation也未在文件写入前与 journal原子关联；两类 cleanup吞掉
    删除失败后，journal仍可显示 failed。v6 必须把 exact artifact identity、record-before-act、
    可重试 compensation ownership与 terminalization 顺序变成同一个 durable protocol。
13. 第六轮隔离门禁确认 v6 已关闭 exact identity、cleanup 吞错与 legacy 猜删，但
    `failed=artifact 已清理`仍缺两项必要证明：daemon 崩溃时 npm/lifecycle descendant 可能在
    新 daemon 删除 generation 后继续写回；而 no-symlink containment 只写在 cleanup，Plugin/
    Skill 首次 mkdir、write、spawn 或 producer 仍可能先沿 symlink 写到受控根外。v7 必须把
    release-before-write 的 owned process-group supervisor、跨 daemon process-start identity、
    writer quiescence，以及 forward containment-before-act 纳入同一个 artifact protocol。
14. 第七轮隔离门禁确认主 UX、权限/OCC、secret、current-owner dispatcher、final authority与
    migration/legacy合同没有新增阻断，但 v7 的两项 artifact证明仍停在过窄边界：npm lifecycle
    可用 `setsid + double-fork`逃出原 PGID；最后一次 inode复验与 path-based syscall之间仍有
    TOCTOU。与此同时，同轮 questions + mountRequests的两阶段 UI缺少严格 approval receipt wire。
    v8 必须以 Linux private PID namespace形成不可逃逸 writer set；Darwin因没有可用的等价
    descendant ownership primitive，对 npm/git Intent apply在 receipt/文件动作前明确 fail
    closed。两平台 host writer都以 descriptor-relative capability消除 check-then-use，同时把
    approval HTTP/detail receipt锁成同一个 strict shared schema。
15. 第八轮隔离门禁确认 Linux PID namespace process-set主体与 strict approval receipt已闭合，
    但 artifact proof与 filesystem authority仍缺必要 primitive：共享 HMAC key无法同时做到跨
    daemon可验证和对 same-UID process不可伪造；零状态 pre-accept rejection无法承诺环境恢复后旧
    id仍永久被拒；具名 temp存在 hardlink write race，capability API无法产出 entry authority，
    traversal缺 mount boundary，cold/pending restore仍以裸路径替换 whole Skill tree，embedded
    helper也未绑定 verified executable。产品流另有三项真实断路：Darwin用户会在 Review前走完
    注定不可 apply的 npm/git Plugin路径，模型 prompt的 Plugin/Workflow示例与 strict schema冲突，
    Composer的 artifact hint在进入 `INTENT.md`前被丢弃。v9以 supervisor-owned Ed25519 proof、
    `ArtifactFsCapabilityV3`/restore generation authority、入口前 host capability disclosure、
    shared model contract与 session-level hint补齐，并把 390×568 touch/软键盘近似场景纳入门禁。
16. 第九轮隔离门禁确认 v9 的 Ed25519 trust root、匿名/私有 temp、mount boundary、verified helper、
    Darwin前置 UX、shared model contract、durable hint与短视口门禁均已闭合，但又找到 5 个跨层
    P1：已 accepted commit 的 exact replay会被后来的 capability red抢先变成 422；V3 surface没有
    managed Skill完整目录 publication/exchange，也无法同时表达 published与 displaced entry；
    restore先替换保存 public key的 DB，却不替换 Plugin generation，可能丢失旧 writer obligation；
    daemon运行中的 `restore --stage`没有合法 broker delegation；`file:` Plugin只用布尔
    capability，未把模型输出绑定到 actor选择的 exact mounted source。v10以 ledger-first accepted
    replay、sealed tree publication + 双 entry exchange receipt、非 restore 的
    `ArtifactWriterObligationLedgerV3`、daemon-owned pending-stage control RPC，以及 opaque
    mounted-source handle/fence逐项闭合。
17. 第十轮隔离门禁确认第九轮 5 项 finding 与既有 UX/权限/幂等/containment 主体均已闭合，
    但发现 4 个仍不可落地的 P1：restore把当前 regular-file `config.json`误当成目录树交换；
    普通/定时/pre-migration backup没有可 mint 的 V3 operation/slot；live stage cancel在文件删除
    后响应丢失时没有持久 replay anchor；Darwin modify Composer又要求 session handle、又只在
    create transaction内生成 handle，形成先有鸡还是先有蛋。v11明确区分 config file与skills
    tree publication，增加独立 backup authority，给 stage/cancel建立不随 restore回滚的 control
    ledger，并以 actor/目标/attempt绑定的 pre-session source grant在 create transaction内换取
    真正 session handle。
18. 第十一轮隔离门禁确认第十轮 4 项 finding 与方案 A 主 UX、RFC-234
    ACL/OCC/secret/all-or-nothing 主体均已闭合，但沿真实 restore/backup 产品入口又找到 5 个
    P1：HTTP upload没有从 stream产出 immutable read-only archive capability的合法入口；
    Settings/CLI没有保存 stage/cancel exact replay locator；升级前已存在的 pending marker无法
    安全迁入 V3 control ledger；旧 backup archive没有 publication receipt、会掉出 retention
    inventory；worktree reconstruction只有 extractor，没有完成 Git registration，更没有覆盖
    `task_repos[]` 多仓真值。v12必须把 ingress、caller wire/locator、两类 legacy adoption与
    task/repo-scoped Git reconstruction一起闭合，不能靠 raw path fallback或兼容性猜测。
19. 第十二轮隔离门禁确认方案 A 主 UX、RFC-234 主合同及第十一轮的 ingress、legacy backup
    adoption均未出现新增阻断，但证明 v12 仍有 5 个恢复控制面断点：daemon live时 read-only
    dry-run没有可执行的 delegated inspect wire；Settings在账号 A→B 时删除 locator会让 A 回来后
    无法 exact reconcile；legacy pending被写成不存在的 `marker.json/archivePath`，也没有覆盖
    released binary真实的 empty-active、archive-only、marker-only与 quarantine-rename crash形态；multi-repo
    reconstruction对整个 task parent不存在时没有可 mint的 reservation authority；durable
    reconstruction receipt又没有保存 target identity/branch-ref before-after，无法在 add响应丢失
    后 exact resume/compensate。v13必须把 inspect control、actor-namespaced locator retention、
    真实 legacy evidence union，以及 task/repo reservation + per-repo effect ledger写成同一个
    可执行协议。
20. 第十三轮隔离门禁确认 inspect、actor locator及 Git add效果账本已闭合，主 UX与
    RFC-234 ACL/OCC/secret/all-or-nothing继续无新增阻断；但 v13 对两个更早的 crash window仍
    过度承诺。released restore在 DB swap后失败、进入 catch却尚未 quarantine rename时，磁盘仍是
    marker+archive，和从未 apply的合法 pending物理不可区分；canonical task/target目录又在
    reservation receipt前就已 mkdir+fsync。v14必须把 legacy active pair改成 operator-confirmed
    fail-closed recovery，并把 root/namespace/container/target改成 durable-intent + broker-private
    directory + no-replace canonical publication，不能靠事后补 ledger猜 ownership。
21. 第十四轮隔离门禁确认 v14 已关闭 active-pair 自动误重放与 canonical mkdir-before-receipt
    主路径，方案 A、RFC-234 主合同及 supporting authority也没有新增阻断；但两个 terminal
    receipt仍无法表达真实零/已发生 effect。legacy reapply/quarantine只在 rename后才记录
    adoption-hold/quarantine目标，effect成功、checkpoint前被杀时无法 exact找回；worktree在
    declaration后零目录 effect、Git明确 `not-started`以及 single-existing alias时又没有可构造的
    terminal compensated union。v15必须让 legacy move也先有 durable target publication，并为
    worktree增加 closed-absent、no-Git-effect与 single alias的严格终态，不能伪造 removed/Git
    after evidence。
22. 第十五轮隔离门禁确认 v15 已关闭 rename前无 target authority、declaration后零目录 effect、
    纯 absent baseline的 Git `not-started`与 single-existing alias，但又证明终态代数仍非全域：
    reapply hold在 `cleaning`删除成功、`cleaned` checkpoint前合法呈现 neither，却被统一矩阵误判
    repair；operation-created shared root/namespace按策略保留时没有 cleanup终态，unique-stale
    baseline cleanup与 Git branch/registration/admin-dir partial delta也无法被 `none|registered`
    表达；两套所谓 strict codec又没有逐字段绑定 nested publication、parent/slot/fence/fsync/
    removed identity。v16必须以 phase-sensitive move discovery、完整 worktree preparation/partial
    effect algebra及显式 nested strict schemas闭合，不能把 producer自律当 durable proof。
23. 第十六轮隔离门禁确认上述 cleanup/worktree algebra与 nested cross-field binding均已闭合，
    但 v16把本应位于 `ArtifactEntryIdentityV3Schema` 的 bigint decode transform误挂到了
    `IntentMountApprovalReceiptSchema`。合法 approval transaction提交后，frontend parse会读 receipt
    不存在的 `dev/ino`并阻断 answers；response-loss后 detail receipt也走同一坏 codec。v17必须让
    approval receipt保持同形输出，并把 canonical uint64 wire、bigint decode与反向 encoder收口到
    identity schema这一唯一边界。
24. 第十七轮隔离门禁确认 approval receipt与 identity leaf codec均已闭合，但 v17只给
    `ArtifactEntryIdentityV3`定义了反向 encoder。pending restore、legacy adoption/move/operator、
    artifact publication及 worktree reconstruction等 record-before-act root的 decoded object都
    嵌套真实 `bigint`，却没有顶层 decoded→wire encoder；严格实现既不能直接
    `JSON.stringify`，也被禁止自行挑字段或使用通用 bigint replacer。v18必须为每个 durable root
    定义成对 wire/decoded schema、显式穷举 union的 canonical encoder与唯一 branded writer
    boundary，并以所有 identity-bearing branch的完整 durable round trip及 kill fixture闭合写侧。
25. 第十八轮隔离门禁确认 durable root顶层 producer闭合，但 restore generation marker漏出
    registry，且跨进程 raw bytes没有唯一 loader/runtime trust boundary。v19把 marker加入闭集，
    增加 canonical frame、expected-codec loader与 runtime membership。
26. 第十九轮隔离门禁确认方案 A主 UX、RFC-234 authority与既有 recovery closure没有回退，但
    找到一个数据破坏级 P0与四个 P1：restore把 SQLite generation误建模为单 DB文件，既缺 DB
    slot role也没有 WAL/SHM record-before-act删除；七态 schema/encoder仍只有未定义名字；
    publication ref缺 root-specific key与 versioned operation digest；execution options跨 checkpoint
    丢失且 `--no-migrate`没有诚实终态；DB/Skills又强制 replace，无法表示 clean-machine absent
    target。v20以 normative executable appendix、第16个 SQLite publication root、完整 options/
    digest/locator及 `absent|present × no-replace|replace`代数一起闭合。
27. 第二十轮隔离门禁确认 SQLite generation、normative codecs、full-operation digest、durable
    options与 absent target代数已闭合，但在 crash recovery 的引用语义上仍有四个 P1：
    marker引用可变 root的旧 revision后，合法内层 checkpoint会让该引用失效；publication
    verifier只核对 id/revision/role/operation而未绑定 phase/mode及 staged/published/displaced
    证据；repair分支允许丢弃已知 publication/sidecar identity；legacy adoption/operator reapply
    又没有把原 restore options作为后续执行 authority。v21把 root改成不可变 revision-addressed
    frame + descendant traversal，以 purpose-specific projection绑定 publication evidence，以
    lossless forensic union与 transition validator封闭 repair，并让所有 reapply授权显式携带
    options/optionsDigest。
28. 用户在 v21 收敛期间补充硬要求：意图构建任务也要显示系统代理的 session执行过程，并与
    其它 session界面一致。当前 Intent detail只有 turn summary，`runSystemAgent`虽已解析
    normalized runtime events，却只累计 envelope文本且清理 private session store；不能靠
    `runMeta`或终态文本复原 reasoning、tool call与 subagent tree。v21因此新增 Intent turn
    专属 durable event store与 owner-gated session endpoint，复用 shared `parseSessionTree`、
    `SessionViewResponseSchema`及前端 `ConversationFlow`；任务专属 attempt picker/runtime
    inventory不被错误搬进 Intent。

根因不是单个颜色或圆角，而是 RFC-234 的可靠业务状态尚未被投影成一条可读的
「描述 → 生成/澄清 → 复核 → 应用」当前循环。若只改创建 Dialog，用户创建后的主体体验仍会
回到通用卡片堆叠，治标不治本。

## 2. 目标

- **G1 目标优先的创建入口**：`/intent` 直接呈现可输入的目标 Composer；资源页快捷入口
  复用同一个业务组件的大弹窗，不再维护两套表单。
- **G2 降低空白页启动成本**：提供三条可点击但不自动提交的意图示例；产物类型用现有
  `ChoiceCards + ResourceIcon` 可扫读选择，默认仍为「AI 自动判断」。当前 host不支持的创建
  路径必须在选择前禁用并解释，不能等到 Review才暴露。
- **G3 清楚表达安全边界**：创建 CTA 附近持续说明「本步只生成草稿；任何资源改动都要在
  复核后显式提交」，不把模型生成误呈现为立即写入。
- **G4 当前循环进度可见**：会话页用非交互阶段轨表达 Goal / Generate / Review / Apply，
  并把 generating、clarifying、review-ready、review-blocked、applying、applied、error、
  archived 映射为唯一当前状态。
- **G5 对话与草稿并列工作区**：桌面端左侧为挂载上下文、对话/澄清与继续调整，右侧为草稿
  富预览；草稿的校验状态和复核 CTA 在右栏稳定可达。窄屏回落为单列，语义顺序不变。
- **G6 时间线角色化**：用户消息、Builder 回复、问题、变更集事件、错误与运行中状态有明确
  视觉身份；历史答案以可读问答摘要呈现，不再暴露 JSON；长消息复用可展开全文，不硬截断。
- **G7 既有交互合同可达**：单选/多选问题按 schema 正确作答；agent 的 mountRequests 可逐项
  选择 actor-visible 资源或拒绝，并在启动下一轮前先持久化裁决。
- **G8 提交决策分步化**：复用现有 `Stepper`，按「应用策略 → 必需信息 → 最终复核」组织
  server-issued slots；空步骤自动省略，最终 request body 与 RFC-234 完全一致。
- **G9 最近会话响应式**：历史记录改为整卡可点击的语义列表，桌面紧凑、移动端自然换行，
  状态、轮次、提交次数和更新时间仍完整可见。
- **G10 只读状态诚实**：归档态与 system-admin 审计他人会话都不呈现可写控件，避免把
  服务端 404/409 留给用户点击后才发现。
- **G11 设计系统一致**：优先复用 `Dialog`、`Field/TextArea/TextInput`、`ChoiceCards`、
  `ResourceIcon`、`Card`、`ClampedText`、`NoticeBanner`、`StatusChip`、`Stepper`、`EmptyState` 与按钮
  classes；新增内容只放业务组件与 `.intent-*` 命名空间。
- **G12 状态可证明而非猜测**：所有 receipt-bearing Intent 写入共用一个 durable mutation
  ledger 与 request fingerprint；generation、answers、mount approvals 与 apply 暴露最小
  source/attempt identity。route 不拥有 runner handoff，异步启动失败必须落为 durable terminal
  turn；跨标签页与响应丢失后只按服务端 receipt/identity 投影。
- **G13 敏感提交生命周期闭合**：Commit wizard 固定用户实际复核的 draft；secret-bearing
  request 不进入 TanStack MutationCache/storage/URL/log，提交未定时阻止无提示离开，并以安全
  locator 在刷新后继续核对 journal。
- **G14 session 写入新鲜度闭合**：create initial mounts 与 manual add/remove/rebase 在实际
  mutation 的同一个同步 transaction 内复验 actor、active、OCC、inFlight/unsettled gate；需要
  资源读取的 create/add 同时使用 transaction 内 ACL oracle，route 外预览不得充当授权。
- **G15 后台执行身份不漂移**：每个 reserved running turn 持久绑定 session owner 与版本化
  run-as policy；dispatcher 只从当前 active owner 构造非 fallback actor，并在当前 ACL 下生成
  dump。principal 不可用时原位 terminal，不得把普通 owner 替换成 system。
- **G16 指纹与执行对象同一**：每个 receipt-bearing endpoint 只有一个
  `normalizeIntentMutationV1` 结果；scope、HMAC、ledger anchor、turn/session/journal 写入与
  resolver 都消费该结果，duplicate/order/default/trim 语义有显式合同和性质测试。
- **G17 apply 最终授权不漂移**：commit journal 持久绑定 session owner；final transaction 从
  当前 active user/role 重建 actor，并在同一 transaction 重新检查每个 update target 的
  owner/builtin/copy-only、授权 fence 与全部最终引用。preflight 或旧 route actor不能充当提交
  权限。
- **G18 模型 disclosure 有线性化点**：dump 先从一个同步 DB snapshot冻结当前可见 catalog 与
  disclosure tokens，构造 seed 后在紧邻 spawn 的第二个同步 transaction 验证 current
  principal、完整 visible set、ACL 与 content fence。只有 admission CAS 成功的 exact turn可把
  seed交给模型。
- **G19 私有 source 先授权后解析**：session-scoped source endpoint 在 wire-only strict parse
  后，先以 immutable `session.id + ownerUserId` 做同形 404 write-scope gate；只有 owner 才能按
  route session读取并 safeParse source turn，随后生成唯一 normalized object/HMAC。
- **G20 外部 artifact 终态可证明**：每个 npm/git Plugin generation 与 managed Skill reserve
  operation在任何文件写入前以版本化 exact identity进入 apply journal；失败后保持
  `compensating/repair-required` 非终态。npm/git writer只有在不可逃逸 containment identity已
  持久化后才可开始写；Plugin/Skill 的 host writer只接受 descriptor-relative capability，
  package-controlled child只在“exact leaf可写、authority ancestors与其余 host路径不可写”的
  OS sandbox内运行。file与directory replace publication都必须返回 published/displaced exact
  authority；
  released Plugin obligation另进入不随 DB restore回滚的 broker-owned ledger。只有
  kernel-backed containment set已证明 empty，且严格、可重试的逆序 cleanup通过同一 capability
  证明本 attempt 的 artifact已不存在，journal才可进入 terminal `failed`。
- **G21 类型提示与模型合同真实有效**：artifact hint以 strict shared enum作为 immutable session
  fact进入每轮受信 `INTENT.md`；当前 host apply capability也进入模型上下文。prompt中的六类
  payload字段与可执行示例由 versioned shared model contract提供，并逐个通过 strict changeset
  parser、resolver与 canonical validator，不能再出现“UI已选择但模型看不到”或“照 prompt输出却
  必然校验失败”。
- **G22 accepted mutation与 host source authority不漂移**：任何已进入 owner-scoped ledger的
  commit exact replay都在当前 capability/freshness前返回原 anchor；只有 ledger absent的新 id才
  接受 zero-state capability rejection。`file:` Plugin不接受模型提供的 host path，只能以
  session-scoped mounted handle引用 actor选择且 final-fenced的 source；live restore staging只由
  持有 singleton lock与 verified broker的 daemon或 cold CLI执行。
- **G23 config恢复保持真实文件合同**：`Paths.config`继续是 regular `config.json`，不引入目录
  layout migration；incoming config按 exact file publication交换，incoming缺失时明确保留 live
  config。只有 Skill generation使用 sealed-tree publication。
- **G24 backup写入也有闭集 authority**：manual、scheduled、auto、pre-migration、pre-restore与
  corrupt-DB backup均只能通过独立 `ArtifactBackupCapabilityV3`写 broker-private staging与
  archive slot；packer、SQLite snapshot adapter与 retention均不得取得 app-home裸路径。
- **G25 pending cancel可跨崩溃精确重放**：stage/cancel先写不随 DB/config/Skill restore回滚的
  strict control ledger，再执行 exact archive/marker publication或删除；相同 caller/id/body在
  response loss与 restart后返回逐字段相同 receipt，不从当前空目录猜成功。
- **G26 Darwin modify入口可达且不放宽 path authority**：create页面能力与已创建 session能力分成
  两个 DTO。modify入口先取得绑定 actor、exact Plugin、source fence与 create attempt id的 opaque
  pre-session grant；create transaction重新授权并换成 session handle。grant、model与 wire均不
  暴露 raw path/spec。
- **G27 restore输入从每个真实入口都可合法验收**：HTTP raw stream、live CLI delegated fd、
  stopped CLI locked fd与 strict pending marker都只能先进入 bounded broker-owned ingress，
  seal为绑定 exact identity/digest的 `ReadOnlyBackupCapabilityV3`，再进入 stage/dry-run/restore；
  route、CLI与 extractor都不持有 upload/pending root path。
- **G28 stage/cancel的调用者也能完成 exact replay**：shared HTTP/local-control schema显式携
  mutation id、stage id/revision与 typed receipt；Settings在 effect前只持久化非敏感 owner-bound
  locator，CLI在 effect前持久化并打印可复用 id。reload、response loss、daemon restart与
  `status=null`都通过 ledger lookup/replay收敛，不让 UI或 CLI猜 terminal。
- **G29 旧 pending状态有一次性升级语义**：verified broker在 singleton lock下只从 canonical
  legacy marker/archive位置读取并完整验证，写独立 `legacy-unverifiable` adoption record后再
  转成 V3 internal restore marker；无法证明的旧 pending/failed quarantine进入 typed repair，
  绝不伪造原 caller receipt或按旧绝对路径行动。
- **G30 旧 backup仍受 retention且不冒充新 publication**：descriptor-rooted adoption验证每个
  legacy archive的 regular-file identity、digest、strict manifest与保护类型，写独立 durable
  adoption receipt。retention inventory显式区分 new publication与 legacy adoption，并在 exact
  identity下继续执行 scheduled/auto count/days/size策略；malformed/ambiguous entry只可保护/
  repair，不得 raw unlink。
- **G31 worktree恢复产生真实 Git worktree**：capture与 reconstruction都以完整有序
  `task_repos[]`为真值；恢复操作绑定 task/repo/branch/base/repo-admin/target fences与必要 locks，
  先安全建立 Git registration，再 overlay captured tree并验证 postcondition。single/multi-repo、
  partial add与 crash都 exact resume/compensate；archive中的任何 path仍为零 authority。
- **G32 daemon-live只读计划真正可达**：default plan与 `--dry-run`无论 daemon live/stopped都走
  同一个 strict inspection service并返回 `RestorePlanDtoV3`；live CLI只可通过 peer/boot校验的
  local-control `inspect-backup`委托 read-only fd。inspect不创建 pending/control receipt、
  publication或 locator，所有 fd/ingress bytes在响应前 exact释放。
- **G33 actor切换不破坏恢复能力**：Settings locator按 actor命名空间持久化；当前 actor只查询/
  展示自己的 locator，遇到其它 actor只忽略不删除。原 actor回来后仍可恢复 exact reconcile；
  只有显式「清除本机恢复记录」才删除，并明确警告会失去响应丢失后的找回能力。
- **G34 legacy pending按 released bytes完整分型**：只识别真实
  `.restore-pending/restore-pending.json`与固定 `staged.tar.gz`；strict旧 marker接受
  `stagedTarball/requestedAt`及三个可选 boolean但不给 `stagedTarball` path authority。active-pair、
  marker-only、archive-only、empty-active与 failed-quarantine分别有可持久化、可重放的 closed evidence；
  copy-before-marker、archive-delete-before-cleanup及 quarantine rename/error-write每个窗口都有
  明确 boot/operator结果。active-pair只表示 marker+archive同时存在，不再命名或推导为 clean
  `complete`。
- **G35 缺失 worktree task parent也可安全创建**：reconstruction从 canonical worktrees root、
  task id与 ordered repo descriptors mint closed task-container/repo-target reservations；每个
  operation-created root/namespace/parent/leaf先在 broker-private slot由 durable publication intent
  绑定 identity，再以 same-inode no-replace rename发布到 canonical slot并持久化 publication
  receipt，之后才交给 Git adapter消费。补偿只删本 operation发布且仍为空/identity匹配的 entry，
  既存 parent/target永不删除。
- **G36 Git side effect可从 durable证据 exact恢复**：reconstruction不再用平行 index/id数组；
  每 repo ledger保存 descriptor/task/repo fences、target reservation、Git target与 registration
  identity、branch/ref before/after及 phase。reservation在 Git effect前持久化，post-add identities
  在 overlay前持久化；add-before-result、result-before-ledger fsync、identity替换与 partial multi
  都只能 exact resume/逆序 compensate或 repair-required。
- **G37 legacy active pair不自动重放**：升级启动看到 marker+archive时无法区分从未 apply与
  post-swap failure/catch-before-quarantine，因此先 durable投影
  `legacy-active-pair-ambiguous`并在 DB open/restore前 fail closed。只有 operator对 exact
  adoption id/evidence digest执行 inspect后显式选择 reapply或 quarantine，才可创建新的 V3
  operation；自动 boot不得把物理共存解释成安全 stage。
- **G38 directory reservation先有凭据再有 canonical effect**：root、namespace、task container与
  repo target的每个缺失 slot都先 durable声明 parent/leaf/private slot，再在 broker-private
  namespace创建并记录 identity；canonical no-replace publish前写 `publishing`，crash后同时核对
  private/canonical exact identity判 before/after/repair。publication receipt durable后才成为
  `reserved`，不存在 canonical mkdir后无 ledger的 ownership空窗。
- **G39 legacy handoff先有目标凭据再 rename**：reapply adoption-hold与 operator quarantine
  共用 `LegacyPendingMovePublicationV3`。每次 rename前先 durable绑定 action、source identity、
  exact source/target parent、opaque broker target slot及 target-absent proof，再写 `moving`；
  rename与双 parent fsync后才记录 same-inode target identity。restart只接受
  rename阶段 source-only/target-only的 exact before/after，both、neither或 replacement一律
  repair；后续 cleaning按 G41的 phase matrix处理。
- **G40 worktree零 effect也有真实 terminal receipt**：directory declaration在 private/canonical
  均 absent时可终结为 `closed-absent`，不伪造 removed identity；container在 reservation尚未形成
  时仍可逐层引用 absent/removed/existing-retained evidence完成补偿。Git明确 `not-started`时以
  `effect:'none'`保存 before snapshots与 no-effect proof，single target只可别名
  operation-created `published` container；existing single container在 preflight typed skip。
- **G41 legacy cleanup按 phase识别合法 neither**：move discovery不是一张无 phase的
  source/target真值表。`moving`只把 exact target-only解释为 rename after；`moved`只接受 exact
  target-only；`cleaning`允许 exact target-only重试 remove，也允许 source/target双 absent在
  recorded moved identity、post-cleanup absence observation与 target-parent re-fsync后补写
  `cleaned`；`cleaned`只接受 exact neither。source reappear、both、replacement或 proof漂移仍
  fail closed。
- **G42 worktree补偿覆盖 retained infrastructure与 Git partial delta**：同一 reconstruction创建、
  identity仍匹配且策略要求保留的 root/namespace以
  `created-infrastructure-retained`闭合；unique-stale cleanup是 Git add前独立 durable effect，
  effect前先保存 exact stale admin-entry removal intent，完成后 effective registration baseline
  推进为 absent；任何 terminal preparation到 Git add intent间的 cancel/failure都有
  no-add-intent、before-git no-effect receipt与 target cleanup。Git add前保存 bounded
  repo-admin/target/branch inventory与当前 Git version资格化的 exact admin-slot absent intent，
  response loss或非零返回后区分 zero、完整 registered与唯一可归属 partial delta，并逐项逆序
  补偿。只有外部/重复/无法归属变化进入 repair。
- **G43 durable receipt先 strict parse再 discovery**：legacy move publication与 worktree directory/
  Git effect ledger各有 `.strict()` discriminated schema、共享 canonical identity comparator与完整
  `superRefine`矩阵。publication/reconstruction/action id、role、parents、slot、descriptor fence、
  same-inode identity、fsync filesystem、removed identity及 absence observation任一不等，在打开
  descriptor、discover、remove、checkpoint或 DB open前拒绝。
- **G44 public receipt与 recovery identity codec不可串线**：
  `IntentMountApprovalReceiptSchema`的 output逐字段仍是 receipt，不含任何 identity transform；
  `ArtifactEntryIdentityV3Schema`独占 canonical uint64 decimal→bigint decode并提供唯一反向
  canonical encoder。`0`、大 uint64与 round trip可执行，`+1`、前导零、负数、overflow及 unsafe
  numeric companion全部在 consumer取得 decoded identity前拒绝。
- **G45 durable recovery root具有双向 canonical codec**：所有会 append/checkpoint/fsync 的
  artifact publication/obligation、pending restore、legacy adoption/move/operator、legacy backup
  adoption与 worktree directory/Git/reconstruction root，必须同时拥有 strict wire schema、
  decoded schema及唯一顶层 encoder。encoder逐 branch穷举并只调用 leaf identity encoder，
  返回前重过 root wire schema；ledger storage只接受 branded canonical bytes。任何 decoded
  `bigint`直接序列化、通用 bigint replacer、partial mapper或新增未覆盖 branch都在 effect前失败。
- **G46 restore generation marker属于同一 durable root闭集**：restore七态 marker不是 capability
  快照或例外 JSON；它以 `restore-generation-marker`进入 registry，并保存 operation/digest、
  config disposition、staged/safety/published/displaced exact identities、publication refs、
  migration/identity barrier与 cleanup proof。每态有 strict wire/decoded branch和显式 encoder；
  cold/pending启动在 DB open前解析，同一 phase的 mixed generation只能 exact resume或 fail closed。
- **G47 raw durable bytes只有一个跨进程验真入口**：storage落盘的是含 exact root kind、
  domain-separated digest与 canonical payload的 canonical frame。重启后 raw bytes必须由 expected
  codec绑定的唯一 loader验证 strict UTF-8、size、outer schema/kind/digest、inner wire/
  canonical bytes与 decoded cross-field invariant，随后才生成 runtime-unforgeable instance。
  cast/rebrand、generic raw lookup、foreign kind、digest bit flip或非 canonical frame都不能到达
  ledger consumer或任何 effect。
- **G48 SQLite restore以 DB/WAL/SHM完整 generation为单位**：incoming trio先在 broker-private
  generation durable consolidate成 self-contained DB；live trio在 destructive effect前逐项 exact
  observation。WAL/SHM必须各自 record-before-unlink、parent fsync与 exact receipt，DB publish只在
  两个 sidecar settled后发生；stale WAL不能叠到新 DB，WAL-only committed rows不能丢失。
- **G49 restore marker合同在 snapshot内真实可执行**：七个 wire phase schema、七个 decoded phase
  schema、七个逐字段 encoder、component schema、两套完整 refiner与 compile-time equality必须存在
  于同 snapshot的 normative TypeScript appendix，不能再用名字/prose或 snapshot外 proof代替。
- **G50 publication ref可从 opaque key定位并验证 full operation**：storage key只能由
  module-private、root-specific factory从 validated segment构造；operation digest固定 versioned
  domain与 canonical input。lookup后逐字段比较 namespace/kind/id/revision/role/digest/full
  operation；SQLite ref另绑定 decoded root的 revision与 staged DB identity，same-kind foreign
  receipt/root也不能进入 effect。
- **G51 restore options是 durable execution authority**：canonical
  `noMigrate/noSafetyBackup/skipIntegrityCheck`及 digest贯穿 pending control、legacy handoff、
  restore operation、generation marker与 SQLite root。migration终态必须诚实区分
  `applied|skipped-no-migrate|not-required`；重启不能猜默认值。
- **G52 clean-machine restore不制造 placeholder**：live DB/config/Skills各自
  `absent|present`；incoming config/DB/Skills按 `preserve|no-replace|replace`闭合。
  absent旧 target无 displaced identity且 cleanup=`not-applicable`，present才允许 exact displaced
  cleanup；empty incoming Skills仍发布真实 sealed empty tree。
- **G53 durable root引用在合法 checkpoint后仍可恢复**：artifact/SQLite publication每次
  checkpoint写不可变、revision-addressed canonical frame并保存 previous revision/frame digest。
  marker引用当时的 exact anchor；restart先验真 anchor，再沿同 root唯一连续 lineage找到最新
  descendant。旧 frame绝不覆写，gap、fork、digest不符或 foreign root只可 repair。
- **G54 publication proof绑定实际语义而非角色集合**：safety、identity barrier与cleanup分别定义
  exact expected projection，逐 receipt验证 phase、publication mode、staged identity/digest、
  expected/published/displaced identity及 full operation。marker中的 exchange ref必须逐字段等于
  exchange receipt，cleanup ref必须是同 receipt lineage的 cleanup-verified descendant；同一
  receipt id不能跨 role/revision冒充另一份证明。
- **G55 repair保留全部已知前缀**：artifact与SQLite repair以 `repairFromPhase/fromPhase`
  discriminated union保存进入 repair前的完整已知 state，包括 publication refs、sidecar
  intent revision、published/displaced identities与 cleanup evidence。transition validator先验
  lineage，再要求 forensic exact等于上一 immutable frame；不能用 nullable字段抹掉证据。
- **G56 legacy reapply沿用被检查的 restore options**：active-pair adoption在进入
  `operator-confirmation-required`前固定完整 `RestoreExecutionOptionsV3 + optionsDigest`；
  reapply request、control root、receipt与新 V3 operation逐字段绑定同一 authority。缺失、变化或
  digest不符只能重新 inspect/授权，不能在 restart后补默认值。
- **G57 Intent turn执行过程与现有 session体验同源**：每个 agent turn把 runtime-normalized
  parent events及 post-run child session tree持久化到 Intent-owned event rows，owner/audit gate后
  以现有 `SessionViewResponseSchema + parseSessionTree`投影；前端抽取可复用的
  `SessionConversationPanel`并继续由 `ConversationFlow/SubagentBlock`渲染 reasoning、tool与
  subagent。Intent只新增 turn折叠/加载外壳，不复制 message renderer，也不伪造 task attempt或
  runtime inventory。

## 3. 非目标

- 不改变 RFC-234 的权限边界、OCC/draftHash、密钥闭集、copy-only、all-or-nothing 与 apply
  资源写入语义。本 RFC 会增加统一 mutation ledger、runner claim、最小 DB migration、
  shared HTTP/WS schema、source/attempt receipt，并修复 manual/status/apply fence；这些是新
  UX 不说谎的前置合同，不是放宽安全语义。
- 不改变 Intent Agent 的 runtime、输出 envelope、问题单/变更集互斥协议或一般生成策略。
  本 RFC会把现有 prompt里与 strict Plugin/Workflow schema冲突的字段修正为 versioned shared
  contract，并加入 requested artifact hint、host capability与 mounted `file:` source-ref
  discriminant；这是修复现有合同断路并收窄 host path authority，不扩大模型权限。
- 不增加「一键生成并自动提交」；任何资源写入仍必须经过现有确认请求。
- 不新增资源删除、补丁式 op、Skill/Plugin 原地 update、仓库上下文或自动试跑。
- 不改变通用 Plugin generation GC或 Skill update/delete 的产品语义；为避免其它同进程 writer
  绕过安全边界，底层 Plugin/Skill canonical filesystem writer会共用 descriptor capability与
  child containment，但本 RFC只为 Intent apply增加预分配 generation/reserve identity、严格
  cleanup义务与 journal recovery coordinator。
- 不把会话改造成聊天应用，不新增附件、Markdown 编辑器、slash command 或模型选择器。
- 不重做 `IntentOpPreview` 内部的 Workflow/Workgroup/Skill/Markdown 四类预览逻辑；只改善
  它们所在的工作区、标题和行动层级。
- 不把阶段轨的视觉 step 写回后端。服务端只持久化原业务事实与新增的 source/attempt identity；
  阶段仍是权威事实的纯前端投影，不能成为权限或提交依据。
- 不新增 Archive/Reopen 生命周期入口；本 RFC 只诚实投影已存在的 archived/audit 只读状态。
- 不新增通用卡片/弹窗/表单原语；若实施中发现现有公共组件缺少必要可选 prop，只做向后兼容
  的最小扩展并补公共组件测试。

## 4. 已确认与待批准的设计决策

- **D1（用户已确认）范围**：选择完整创建流程（方案 A），覆盖 `/intent`、快捷创建/修改
  弹窗、会话详情和提交弹窗；不采用「仅美化创建 Dialog」的方案 B。
- **D2（随本 RFC 待批准）双入口同源**：全局页使用 inline Composer；资源快捷入口继续
  导航到 `/intent?create=true...`，打开同一 Composer 的 `Dialog size="lg"` 形态。
- **D3（随本 RFC 待批准）示例只作起稿**：仅普通创建且输入为空时显示三条静态示例；
  点击只填入文本并聚焦，不自动发请求，也不覆盖非空草稿。修改目标入口不显示示例。
- **D4（随本 RFC 待批准）产物类型是弱提示**：普通创建显示 Auto + 六类资源的紧凑
  `ChoiceCards`；modify 入口隐藏类型选择，改为目标上下文条，维持 RFC-234「挂载目标就是
  修改对象」的既有裁决。
- **D5（随本 RFC 待批准）会话工作区**：桌面双栏「对话 0.9fr / 草稿 1.1fr」，内容宽度
  不足时自动单栏；不引入双独立滚动区，保留页面唯一主滚动。
- **D6（随本 RFC 待批准）阶段轨按当前循环投影**：持久会话可多轮、多次提交，阶段轨不冒充
  一次性 wizard。提交成功显示本轮 Applied；发送下一条调整后重新进入 Generate。
- **D7（随本 RFC 待批准）提交弹窗分步**：仅组织现有 decisions/slots，不改变默认值、
  必填条件或 request；不存在的步骤不渲染，最后总有 Review & apply。当前 backend 为每个 op
  都签发 optional finalName，因此 Details/inputs 在合法 draft 中实际总会出现；动态省略主要
  适用于没有 update 时省略 Strategy，并为未来 wire 兼容。
- **D8（随本 RFC 待批准）历史列表卡片化**：用语义 link card 替换 table row navigation，
  不增加服务端摘要字段，不猜测当前产物类型。
- **D9（随本 RFC 待批准）source-bound 原子裁决**：多选题使用显式 checkbox group；
  mountRequests 在当前 agent turn 中逐项选择/拒绝。answers 与 mount approvals 都携
  `sourceTurnId + expectedTurnSeq + clientMutationId`。审批服务在一个 transaction 内验证
  source、重新检查所选资源的 actor visibility/name、一次性更新 manifest 并写带 source/id 的
  receipt turn；同轮有 questions 时，客户端确认该 receipt 后才提交 answers。
- **D10（随本 RFC 待批准）问题选项适配正文长度**：单选/多选都使用纵向原生
  radio/checkbox choice rows；不再用只适合短标签、强制 nowrap 的 `Segmented` 承载最长
  512 字符的问题选项。答案与 mount decisions 同时在 UI state 和服务端 transaction 绑定
  source agent turn；轮次变化即清理，迟到提交返回结构化 superseded conflict。
- **D11（随本 RFC 待批准）stale 与 baseline stale 分型**：因挂载/context epoch 变化而
  `draft.stale` 时，引导发送调整消息生成新版；只有 commit 明确返回
  `intent-baseline-stale` 时才提供「刷新上下文（rebase）」，成功后仍需显式生成新版。
- **D12（随本 RFC 待批准）只读 gate**：admin 审计他人会话与 archived 会话只读；统一
  `canMutate = own && active` 控制所有写入口。
- **D13（随本 RFC 待批准）统一写入身份**：create/message/answers/retry/mount-approvals 与
  commit 共用 owner-scoped durable mutation ledger；同一 `clientMutationId` 不能在另一个
  endpoint/session/journal namespace 再生效。只有 endpoint、scope 与 server-keyed request
  fingerprint 全部相同才返回原 receipt；不同 payload 或 endpoint fail closed。rebase、cancel 与
  单项 manual mount 没有 durable receipt，结果不确定时只能说明“目标状态已满足/本动作已被新
  状态 supersede”或保持 outcome unknown，绝不认领 effect-equivalent marker。
- **D14（随本 RFC 待批准）generation 先保留再执行**：create/message/answers/retry 在同一
  transaction 内写 user turn（若有）和 agent `running` turn、设置 `inFlightTurnId` 后再返回；
  route-independent dispatcher 再 claim/register runner 并启动。runtime/config/budget、handoff
  或 pre-spawn 失败把该 reserved turn 原位 settle 为结构化 `error` 并广播；周期 orphan
  reconciliation 收口 daemon-alive 失主。不存在“user turn 已 202、但服务端没有可观察
  attempt”的等待窗口。
- **D15（随本 RFC 待批准）权威 apply attempt**：session 增加单调 `applyAttemptSeq`，journal
  DTO 按它排序并暴露安全的 `clientMutationId/draftId/draftHash/errorCode/updatedAt`；claim 与
  terminal settlement 均发 WS invalidation，页面在 unsettled/local unknown 期间轮询。migration
  回填旧 journal 后必须把每个 session counter 同步到其 `MAX(attemptSeq)`，下一次 claim 才能取
  `max+1`。
- **D16（随本 RFC 待批准）固定复核对象与私有 secret request**：打开 Commit Dialog 时 pin
  完整 draft view；live draft identity 变化立即锁定、擦除 secret 并关闭旧 wizard。含 secret
  的 request 只在组件私有 ref 中，通过 direct async submit 发送，不作为 React Query mutation
  variables；storage 仅可保存不含 decisions/secret 的 attempt locator。
- **D17（随本 RFC 待批准）导航恢复合同**：commit 有未保存敏感输入或 submitting/
  outcome-unknown 时接入共享 `UnsavedChangesGuard`，覆盖 link、browser Back 与 beforeunload；
  definitive settlement/draft change/discard/unmount 都显式擦除 secret。强制离开只保留安全
  locator，回来后按 `clientMutationId` 核对 journal，不能伪造 exact replay。
- **D18（随本 RFC 待批准）actor-safe 挂载身份**：detail mount DTO 增加可空的
  `display{name,owner}`；UI 以 `name + type + owner` 为主，handle 为次级技术信息。资源已删除/
  不可解析时显示安全 fallback，不回退 raw resource id。
- **D19（随本 RFC 待批准）secret-safe request fingerprint**：ledger fingerprint 由 server
  对严格解析、规范化且包含 endpoint/scope 的语义请求计算；统一使用现有 host
  `secret.key` 经 HKDF 派生独立 domain key 后计算 HMAC（不直接复用 AES key），并记录非敏感
  key id以识别异机恢复。commit fingerprint覆盖 draft 与全部 decisions，secret只短暂参与
  HMAC，不持久化 raw value或可离线枚举的普通 hash；key变化时结构化 fail closed而非误报 body
  mismatch。
- **D20（随本 RFC 待批准）可靠 generation ownership**：reservation 只产生 durable queued
  running turn；daemon-scoped dispatcher 负责 claim、live-owner 注册、started event 与实际
  run。route 只 best-effort wake；周期扫描处理未 claim 或 claim 后无 live owner 的 row，同时
  不回收 live registry 中的合法长任务。
- **D21（随本 RFC 待批准）manual mutation final gate**：create initial mounts 与 manual add
  在写入 transaction 内调用 `canViewResourceInTx`；add/remove/rebase 同一 transaction fresh
  检查 owner、`status==='active'`、exact context revision、无 inFlight、无 unsettled apply，并
  以 conditional update `changes===1` 收口。
- **D22（随本 RFC 待批准）legacy mutation fail closed**：migration 可为旧 journal 建立
  `legacy-unverifiable` ledger anchor，但不能伪造原 request fingerprint；未来 POST 只允许通过
  detail/journal reconcile，不得把 changed body 当 exact replay。若旧数据中 owner/id 跨
  session 冲突，写一个永久 `legacy-ambiguous` tombstone，禁止该 id 再产生副作用。
- **D23（随本 RFC 待批准）current-owner execution actor**：每个新 running turn 与 reservation
  原子持久化 `runAsUserId=session.ownerUserId=actor.user.id` 和
  `runAsPolicy='current-session-owner-v1'`，不保存 token、PAT secret 或权限快照。dispatcher
  claim 时以及 dump 前都重读当前 user；只有 user active 且当前 role 仍有 `intent:write` 才构造
  owner actor。普通 owner 永不回退 `__system__`；principal 不可用时 exact turn 原位 settle
  `intent-runner-principal-unavailable`。PAT/session credential 在动作被接受后撤销本身不取消
  durable action，user disable、role/ACL 变化则按执行时当前状态生效。
- **D24（随本 RFC 待批准）single normalized execution object**：strict parse 后调用唯一
  `normalizeIntentMutationV1`，返回版本化、带 trusted owner/session scope 的 branded object；
  raw parsed body 随即丢弃。create mounts 保留首次出现顺序；source-bound answers/approvals按
  source 顺序；commit 在拒绝 duplicate 后按 `opId/slotId` 排序但保留每个 value 的精确字节。
  HMAC 与 executor 使用同一对象，ledger 标记
  `fingerprintVersion='intent-normalized-v1'`；未知/legacy 版本继续 fail closed。
- **D25（随本 RFC 待批准）current-owner apply actor 与 final authority**：新 journal 与 claim
  原子写 `runAsUserId=session.ownerUserId=actor.user.id`、
  `runAsPolicy='current-session-owner-v1'`；不保存 credential/PAT scopes。final `dbTxSync` 按
  journal 重读 current active user/role并重建 actor；prepared op 中旧 actor不具授权效力。
  每个 modify target 必须仍由该 owner持有、非 builtin，且 server-only
  `ownerUserId/aclRevision/builtin` authorization fence与 content fence仍匹配；否则整包
  fail closed，绝不把已确认的 modify静默转成 copy。target authority、最终引用、六类写入、
  provenance、journal committed与 session CAS同 transaction。
- **D26（随本 RFC 待批准）two-phase disclosure admission**：执行时权限的线性化点是 final
  disclosure-admission transaction。第一短 transaction冻结 current user/session/claim、六类
  visible rows/grants与每个会影响 root/closure/inventory seed 的
  `{type,id,owner,visibility,aclRevision,builtin,contentFence}`；transaction 外只从该 snapshot与 Skill
  immutable version读取文件。紧邻 spawn 的第二短 transaction重算并精确比较 visible-set/token
  digest；成功才在 running turn CAS非敏感 `dumpAdmissionDigest/dumpAdmittedAt`。在 final
  admission commit 前完成的 user/role/ACL/content变化必须使 seed作废；commit后的变化不追溯
  取消已 admission 的 live run。
- **D27（随本 RFC 待批准）immutable owner scope before source hydration**：answers与
  mount-approvals 固定顺序为 authentication/coarse permission → wire-only strict parse →
  immutable owner-scope 404 gate → route-session-scoped source load/safeParse → 唯一
  normalization/HMAC → ledger replay → 仅新 id freshness/ACL。owner gate不检查
  status/turnSeq，因此 session推进或归档后的 exact owner replay仍可重建原 bytes；foreign、
  manager与 system-admin auditor在任何 source-aware valid/invalid body下都不得读取 source并
  得到同一 `intent-session-not-found`。
- **D28（随本 RFC 待批准）durable exact artifact compensation**：新 journal 固定
  `preparedArtifactsVersion=3`。Plugin receipt保存 canonical
  `{pluginId,generationId}`与版本化 writer phase，Skill receipt保存
  `{skillId,operationId}`；均不保存/信任 absolute path。npm/git installer消费 caller预生成、
  已先落 journal 的 generation id；Skill hidden reservation、reserve operation 与 journal
  receipt在一个 transaction内建立。host forward/cleanup writer在任何 mkdir/write/rename/
  publication前都必须消费同一 `ArtifactFsCapabilityV3`，由 app-home root directory handle开始
  逐段做 no-symlink/no-mount-crossing descriptor traversal；public API只从
  `createTemp/writeTemp/sealTemp/openEntry/commitFile*`与
  `createTree/mkdir/writeFile/seal/commitTree*`产出可消费的 temp/entry/sealed-tree capability，
  不接受裸 absolute/relative path、raw fd或 callback。Linux写入使用 `O_TMPFILE`，完成并 fsync后才
  原子 link/rename；
  Darwin的具名 staging只存在于 contained child不可见的 broker-private目录，并在每次 write前后
  验证 unique inode。npm/git/lifecycle child只在平台 exact-admitted filesystem sandbox中看见
  可写 generation leaf与 attempt scratch，不能写 authority ancestors或其它 host path。
  npm先由 verified-self `OwnedArtifactContainmentV3`进入 `reserved`；当前唯一 admitted
  implementation是 Linux private PID namespace anchor。Darwin SDK明确不提供可依赖的递归
  descendant ownership primitive，因此 npm/git Plugin create在 preflight、journal receipt与
  任一 filesystem action前返回 `intent-artifact-containment-unavailable`；不得以 PGID、轮询
  child list、Seatbelt或 `--ignore-scripts`冒充 process-set proof。daemon独立验证并持久化 exact
  nonce/supervisor start identity/containment kind与 supervisor-generated Ed25519 public key后才
  发送 GO。private signing key在 supervisor完成 non-dumpable/core-off/locked-memory设置后生成，
  不进入 daemon、disk、env、argv或 descendant；EMPTY是绑定 exact release record、namespace与
  empty process-set facts的 Ed25519 signature。daemon EOF、timeout、cancel与 restart recovery均
  终止并确认整个 kernel
  containment set empty；`setsid`、double-fork、裸 PID/PGID或空内存 registry都不能构成
  quiescence proof；新 daemon只用 journal中的公钥验签，不需要恢复任何私钥。能力 self-test失败时
  在 GO/任何文件动作前 typed fail closed。任何 apply失败先 CAS为
  `compensating`并保存原 typed error，再由 durable claim coordinator逆序 cleanup；boot在
  HTTP/GC前、periodic在 daemon-alive时接管无 live owner的 exact row。writer未静默、删除失败、
  claim丢失、path identity或 legacy identity不可证明时保持
  `compensating/repair-required`并阻断 session write。只有 writer quiesced、全部 receipt幂等
  absent且 Skill row/op收口后才 CAS `failed`。旧 `{pluginId}`不得扫描猜 generation；只能等待
  保守 GC/doctor零残留 proof。新 failed必须带 cleanup-verified timestamp；既有 v1 failed继续
  显示 legacy cleanup unverified。
- **D29（随本 RFC 待批准）strict mount-approval receipt**：HTTP response与 detail 中
  `kind='mount-approval'` turn content共用 strict `IntentMountApprovalReceiptSchema`。receipt
  固定携 `clientMutationId/sourceTurnId/expectedTurnSeq/approvalTurnId/resultingTurnSeq/
resultingContextRevision`，并按 source顺序逐项给出 approve/reject decision与
  `mounted|already-mounted|rejected` outcome（批准项含 exact `resourceId/handle`）。exact replay
  返回逐字段相同 receipt；combined questions流只可用 receipt的 `resultingTurnSeq`提交 answers，
  丢响应后只按 exact mutation/source identity找回，禁止从 mounts、文本或相邻 turn推断。
- **D30（随本 RFC 待批准）artifact threat boundary与 whole-tree authority**：安全目标覆盖
  daemon自身并发、被 containment约束的 untrusted agent/npm/lifecycle child、崩溃与恶意
  symlink/hardlink/mount输入；已经能直接改写 app DB、app-home或 executable的任意 unsandboxed
  same-UID host process等同 host compromise，不在本 RFC可隔离边界内。Linux qualification仍须
  证明 same-UID sibling不能经 `/proc/<pid>/{mem,fd}`、`process_vm_readv`、ptrace或 control replay
  取得 proof/control authority。cold CLI与 pending startup在 singleton lock后、DB open前先建立
  `ArtifactRestoreCapabilityV3`，以
  `restoreOperationId + archive/db/config-or-null/tree digests`持有 config/DB/whole Skill tree
  generation；staging、safety snapshot、原子 root swap、crash marker、migration
  barrier与旧 generation cleanup全部走同一 broker，不给 restore/ZIP/fusion/migration裸路径
  例外。archive先锁 exact fd/digest，拒绝 path traversal、link/device/duplicate/超限 entry并只经
  sealed tree capability写 staging。Linux helper由 sealed memfd `execveat`绑定 verified bytes；
  Darwin helper在取得任何 root dirfd前以 audit token + pinned code-sign/CDHash验证实际运行映像，
  无法验证即 capability unavailable。released Plugin的 public key/identity同时写入不随 DB
  generation swap的 broker-owned obligation ledger；pending restore必须先把全部 live obligation
  收口到 quiesced，swap后再与 restored DB和 generation inventory合并恢复。
- **D31（随本 RFC 待批准）零状态 rejection的诚实幂等语义**：wire/static/dynamic capability
  rejection只发生在确认 owner-scoped ledger **不存在**之后、new-id claim之前，故没有 durable
  attempt。任何 existing exact anchor先于当前 capability返回；mismatch/corrupt仍 fail closed。
  收到 definitive 422的客户端销毁本地 id；若响应丢失，原 frozen body/id在能力恢复后可以被
  第一次接受，此后才由统一 ledger保证 at-most-once。服务端不承诺、也不伪造“无状态旧 id永久
  拒绝”。
- **D32（随本 RFC 待批准）host capability前置**：strict
  `IntentComposerCapabilitiesDtoV3`只回答 pre-create UI admission，
  `IntentArtifactCapabilitiesDtoV3`只回答已创建 session的每轮模型 seed，两者不能互相代用。
  Darwin继续把 Plugin卡展示为六类 schema的一部分，但 generic npm/git create disabled并带
  可访问原因；两平台 npm/git in-place update均为 false。`file:`能力不是布尔许可：Composer
  modify只接 D42的 pre-session grant，session/model只接 D38的 concrete handles。URL强制 hint或
  明确目标也不能绕过。Auto模式的模型必须按受信 capability问回/解释而非生成注定无法 apply的
  op；Review preflight继续作为 defense in depth。六类均为 schema-supported，六类
  create→apply完整闭环当前只承诺 admitted Linux；Darwin只承诺 Composer/session DTO中明确
  enabled的 source-bound路径。
- **D33（随本 RFC 待批准）shared model contract与 durable hint**：shared
  `IntentArtifactHintSchema`只允许六类值，Auto在 wire中仍为 omitted。create transaction把 hint
  写入 immutable `intent_sessions.artifact_hint`；modify/mount入口省略。每轮
  `IntentDocInput.requestedArtifactHint`以受信弱偏好呈现，用户明确目标优先。新增
  `INTENT_MODEL_CONTRACT_VERSION=3`及六类合法 changeset examples；Plugin package create固定
  `{name,source:{kind:'package',spec},description,optionsJson?,enabled?}`，mounted `file:` copy固定
  `{name,source:{kind:'mounted-file',handle},description,optionsJson?,enabled?}`且不接受 raw path；
  Workflow output固定
  `ports:[{name,bind:{nodeId,portName}}]`并有 matching edge。prompt renderer、golden、strict
  parser、resolver与 canonical validator共用该合同。
- **D34（随本 RFC 待批准）accepted replay先于 capability**：commit顺序固定为 owner授权 →
  strict parse → 唯一 normalizer/HMAC → ledger lookup。existing exact沿 typed anchor返回，不跑
  current static/dynamic capability；只有 absent才做 pure matrix validation与 zero-write exact
  probe。probe产生短寿命、daemon-local、不可序列化的 `ArtifactAdmissionLeaseV1`；claim
  transaction再次先查 ledger，再验证 lease仍绑定当前 boot/provider revision与 normalized op
  kinds，才插 ledger+journal。claim后 capability漂红只会把 accepted journal收敛为 typed
  compensating/failed，绝不把 exact replay改写成422。
- **D35（随本 RFC 待批准）file/tree publication双 authority**：
  `ArtifactTreeWriterV3`在 broker-private namespace中完整 materialize、逐文件/目录 fsync、核对
  digest后 seal；sealed tree只能经 `commitTreeNoReplace`或
  `commitTreeReplace(RENAME_EXCHANGE|RENAME_SWAP)`发布。file/tree replace统一返回
  `{published,displaced}`两个不可序列化 entry capabilities；publication前先 durable记录
  operation id、canonical slot role与 staged/expected identities到 broker-owned、非 restore 的
  `ArtifactPublicationLedgerV3`，crash只按这些 exact identities resume。tree writer只接自己的
  staging-dir capability，operation/slot closed allowlist禁止跨 canonical target。file/tree
  displaced分别 exact cleanup且 receipt标为 cleanup-verified前，Skill operation/restore phase不得
  terminal。
- **D36（随本 RFC 待批准）restore不可丢 writer obligation**：verified broker独占维护
  `ArtifactWriterObligationLedgerV3`，严格持久化 released Plugin的 journal/artifact revision、
  generation、public key、release identity与 phase；该 ledger不进入 backup、也不随 DB restore
  替换。GO要求 DB receipt与 obligation均 durable。startup在任何 pending DB swap前先扫描 ledger，
  等待/验证所有 released writer到 quiesced；swap后把 obligation与 restored DB/current Plugin
  generation引用合并，exact cleanup或标记 repair，全部收口前禁止 HTTP/GC/workers。
- **D37（随本 RFC 待批准）live pending-stage由 daemon代理**：新增
  `PendingRestoreStageCapabilityV3`，只有已持 singleton lock和 verified broker的 daemon/cold CLI
  可 mint。UI route按 D43先把 raw stream交给 daemon-owned ingress，再调用 stage service；daemon live时 CLI通过独立的 0600 local admin
  control socket传 archive fd/digest/options，按 peer UID、daemon boot nonce与 strict frame验证，
  broker root fd从不出 daemon。daemon stopped时 CLI先取得 singleton lock再启动同一 broker。
  stage publication仍 marker-last；stage/cancel/status共用 exact stage id/revision strict receipt，
  cancel replay另由 D41的 non-restored control ledger保证。
- **D38（随本 RFC 待批准）`file:` source只认 mounted handle**：create-time actor-safe Plugin
  mount在 transaction内被分配 session handle并持久化 server-only source kind、operation hash与
  spec HMAC fence。模型只看到 opaque handle/可读名称，不看到 host path；strict Plugin
  source union对 `mounted-file`只接受该 handle，拒绝 `spec`。resolver与 final transaction按
  handle重读 exact current row/fence并由 broker mint read-only source capability；payload path、
  changed handle、source kind/ACL/spec drift都在任何 `realpath/open`前 fail closed，源永不删除。
- **D39（随本 RFC 待批准）config file与Skill tree分型发布**：restore slot改为
  `restore-config-file`与`restore-skills-root`。`RestoreStagedGenerationV3`以
  `configDisposition:'preserve' | 'replace'`显式表达 archive是否包含 config；replace只允许 verified
  regular file，并走
  `createTemp/writeTemp/sealTemp/commitFileNoReplace|Replace`。skills始终是 sealed tree，
  live absent走 `commitTreeNoReplace`、present才走 `commitTreeReplace`；marker分别保存 file/tree
  publication ref与 published/displaced exact identity。现有 `Paths.config`、`loadConfig`与
  first-run「backup无 config则保留 live config」语义不变，不做 layout migration。
- **D40（随本 RFC 待批准）backup是独立高层 authority**：closed operation新增
  `backup-export`与`backup-retention`，slot只允许 `backup-staging-tree`与`backup-archive`。
  `ArtifactBackupCapabilityV3`从 canonical read-only file/tree capability materialize sealed
  staging；healthy DB只由专用 branded SQLite snapshot source写入 broker-owned sink，corrupt/
  pre-migration模式只复制 exact DB/WAL/SHM read capabilities。可选 worktree按 D47从 current
  task完整 `task_repos[]` fence mint read-only descriptor set，先原子复制到 versioned private
  task tree；archive内 path不成为 reconstruction authority。packer sandbox只看 sealed staging与单一 output
  temp，archive publication先写 non-restored publication ledger；retention另用
  verified inventory与 `removeEntryExact`，不能复用 export authority、删除 active/protected/
  last-good archive。
- **D41（随本 RFC 待批准）pending control ledger先于 stage/cancel effect**：
  `PendingRestoreControlLedgerV3`由 verified broker在 non-restored control root独占，strict
  append/checkpoint fsync并以稳定 caller scope + clientMutationId为键。stage publication前写
  pending record；cancel在删除 archive/marker前写 `canceling`，删除后写 terminal `canceled`
  receipt。boot先用 publication identity与 exact entry inventory收敛 interrupted phase，再开放
  status/control。v1不做 GC，receipt无限期保留；未来压缩必须另做 protocol migration。相同
  caller/id/request digest exact replay不受 active marker是否仍存在影响，mismatch/cross-caller
  fail closed；真实 Settings/CLI如何保留并提交该 identity由 D44锁定。
- **D42（随本 RFC 待批准）pre-session source grant打通Darwin modify**：新增 side-effect-free、
  context-aware `POST /api/intent-sessions/capabilities/resolve`，输入 strict
  `{kind:'create'}`或`{kind:'modify',resourceType,resourceId,clientMutationId}`。generic Darwin
  Plugin仍 disabled；只有 actor当前可见且 source kind/fence合格的 exact file Plugin返回短寿命
  opaque `IntentPreSessionSourceGrantV1`。grant绑定 actor、target、source fence、create
  mutation id、issuer boot/key revision与 expiry，不含 path/spec。Composer先冻结 attempt id再
  resolve并把 grant纳入 frozen create body；create ledger replay仍先于 grant expiry/freshness，
  新 request则要求 body恰有一个与 grant匹配的 Plugin initial mount且 hint omitted，并在同一
  create transaction重验 actor/ACL/resource/fence、验证 grant后分配真正 session handle。accepted
  replay即使 grant随后过期或 source漂移也返回原 session；未 accepted 的篡改/过期/漂移请求零
  ledger/session/turn。
- **D43（随本 RFC 待批准）restore ingress先 seal、后 stage**：定义
  `ReadOnlyBackupCapabilityV3`、`StrictRestoreOptionsV3`与完整 restore phase result。
  `PendingRestoreIngressCapabilityV3`只在 verified broker内创建 bounded upload；HTTP改为
  strict raw-stream PUT，route把 authenticated actor、path/query metadata与 request body stream
  交给 sink，自己看不到 temp path/fd。sink执行总量/entry前置上限、backpressure、增量 digest、
  exclusive temp、file+parent fsync与 seal；中断/超限按 ingress ledger exact cleanup。
  live/stopped CLI delegated fd与 strict pending marker同样通过 broker验收并 seal，dry-run只消费
  read-only capability。sealed capability绑定 operation、immutable entry identity、digest、
  byteLength与来源域，不可序列化/跨 operation复用。
- **D44（随本 RFC 待批准）stage/cancel wire与 caller locator同 ledger闭合**：shared schema
  固定 stage raw-stream metadata、status/mutation lookup、cancel body与 typed repair summary；
  取消不再使用无 body `DELETE`。Settings在发送前把不含 filename/path/archive bytes/digest的
  owner-bound locator写入 localStorage；stage locator可含 strict非敏感 options + digest以重建
  未 seal请求。reconcile terminal后只删除当前 actor自己的 locator；actor不符时忽略且保留，
  服务端仍重新授权。仅显式本机清除动作可删除其它/当前 actor locator，并先警告会失去
  response-loss恢复能力。CLI支持显式
  `--mutation-id`，默认 id在 effect前写 broker-owned 0600 client locator
  并打印；`--replay/--status`沿同一 local-control ledger读取，stage未 seal时要求用户用同 id
  重新提供 archive。HTTP/local control都先按 id查 ledger；只有无 body的 mutation lookup/replay
  命令可在读 body/fd前直接返回 terminal。重复 stage PUT/CLI若携 archive，仍须流式/fd重验
  metadata、byteLength与 digest后才返回旧 receipt；changed content conflict。in-flight则 exact
  resume或要求相同 metadata/content重新验收。
- **D45（随本 RFC 待批准）legacy pending只 adoption、不伪造 caller receipt**：startup在
  verified broker qualification后、V3 control merge/restore前运行一次性
  `LegacyPendingRestoreAdoptionV3`。它只识别 released layout
  `.restore-pending/restore-pending.json`与固定 `staged.tar.gz`：旧 marker strict解析
  `stagedTarball:string`、finite non-negative integer `requestedAt`和可选
  `noSafetyBackup/noMigrate/skipIntegrityCheck:boolean`（缺省 false），但完全忽略
  `stagedTarball`的 path值。三个 option必须立刻 canonicalize为完整
  `RestoreExecutionOptionsV3`并连 digest持久化到 adoption/operator/V3 handoff，不得只留 digest。
  scanner先产出 `active-pair | marker-only | archive-only |
empty-active | failed-quarantine` closed evidence并以 canonical slot + 当前实际存在的 exact identities导出
  deterministic adoption id。active-pair只表示 marker+archive共存，先投影
  operator-confirmation-required，不自动转 V3 marker或 apply；
  marker-only按 released archive-delete-before-directory-cleanup语义记为
  consumed-without-caller-receipt并 exact cleanup，不重复 apply；archive-only按
  copy-before-marker的未 armed状态 durable quarantine，不 apply；empty-active按 mkdir-before-copy
  只在 exact directory仍为空时清理。failed quarantine同时覆盖
  rename前后与 `error.txt`写入前后，raw error/path不成为 authority。无法严格分类、identity漂移或
  post-swap状态不可证明时进入 typed repair-required；任何分支都不创建
  callerScope/clientMutationId exact replay。
- **D46（随本 RFC 待批准）legacy backup采用独立 retention authority**：新增 non-restored
  `ArtifactLegacyArchiveAdoptionLedgerV3`。retention第一次看到无 V3 publication ref的
  `.tar.gz`时，只能 descriptor-relative打开 regular `nlink=1` entry，计算 digest、strict解析
  manifest/limits并按 manifest kind分类 scheduled/auto removable与 manual/pre-\* explicit；
  fsync adoption receipt后才进入 inventory。inventory authority是
  `published | legacy-adopted` discriminated union，remove前重验对应 receipt + exact identity/
  digest。损坏、partial、symlink/hardlink、unknown manifest或 crash中 adoption保持 protected/
  repair；不得从 filename伪造 kind/publication或继续 raw unlink。last-good在新旧 verified
  archives统一计算。
- **D47（随本 RFC 待批准）worktree capture/reconstruction以 task repo set为原子单位**：
  新 backup layout把完整 ordered `task_repos[]`复制到 versioned v2 task payload；任一 repo
  missing/race/unsafe/over-cap则删除 private partial并 skip整个 task。restore只对 single-repo
  接受旧 v1 payload；旧 v1遇 multi-repo明确
  `legacy-multi-repo-incomplete`零写。新 closed `worktree-reconstruction` operation按 current
  restored DB mint task capability，绑定 task状态/repoCount与每个 repoIndex的 repo identity、
  branch/base、target parent/leaf和 task/repo coordinator locks。broker-owned
  `GitWorktreeRegistrationAdapterV3`只允许定位并移除 exact stale registration、建立 exact missing
  worktree、overlay对应 sealed captured tree、验证 `.git` back-reference/branch/status与全部
  repo postcondition；archive path/meta不能形成 argv或 fd authority。non-restored
  `WorktreeReconstructionLedgerV3`在每个 Git side effect前持久化 exact phase，DB open后与 restored
  `task_repos[]`合并 resume/compensate。multi-repo预检全通过后才逐 repo行动，失败按 durable
  phase逆序补偿；partial registration不能被当作 reconstructed。
- **D48（随本 RFC 待批准）restore inspection是独立只读 local-control operation**：
  default plan与 `--dry-run`统一调用 `RestoreInspectionServiceV3.inspect`，只接受
  `ReadOnlyBackupCapabilityV3`并严格返回 `RestorePlanDtoV3`。daemon live时 CLI在 0600
  local-control socket发送 discriminated `inspect-backup` frame与 delegated read-only fd；
  daemon stopped时持 singleton lock后调用同一 service。`inspect-backup`与
  `stage | lookup | cancel`在 shared request/response union中穷尽分型；只有 inspect/stage携 fd，
  lookup/cancel拒 fd。inspect只使用 bounded private ingress，响应前 exact关闭 fd、删除 ingress，
  不写 caller locator、pending control ledger、publication ledger、stage marker或 restore
  generation；peer UID/boot nonce/fd mode/digest/frame不符均零持久 side effect。
  embedded inspection的 current migration axis从 build-bound sealed journal直接 mint，dev从
  repository read-only descriptor读取；default plan/dry-run不得调用会写 app-home runtime的
  `extractMigrationsTo()`。
- **D49（随本 RFC 待批准）Settings locator按 actor命名空间保留**：
  `RestoreControlLocatorV1.actorUserId`既是 storage key的一部分也是投影 fence。current actor只枚举
  自己的 prefix；发现其它 actor key不得 lookup、展示、覆盖或自动删除，sign-out也只使其不可见。
  原 actor重新登录后继续 mutation lookup直到 terminal。显式 clear调用按 exact key删除并显示
  “清除后无法找回该 mutation receipt”的确认；server control ledger与授权不受本机 clear影响。
- **D50（随本 RFC 待批准）legacy adoption记录保存实际 evidence而非假定双 entry**：
  `LegacyPendingRestoreAdoptionRecordV3`持有 discriminated
  `LegacyPendingEvidenceV3`，每个分支只含当时确实存在的 directory/marker/archive/quarantine identities；
  不再强制同时拥有两个 identity。copy后marker前、marker-only cleanup、quarantine rename后
  error-write前/后均先 fsync phase/evidence再做下一 effect，restart只按 exact identity收敛。
  marker+archive共存分支命名为 `active-pair`，只陈述物理 evidence，不再称为或推导出 clean
  `complete`。
  marker-only terminal只表示“released protocol按已消费收口”，不得伪造 apply成功 receipt；
  active-pair/archive-only/failed-quarantine只进入 typed operator inventory。explicit recovery/
  repair同样只能通过 closed adoption capability exact重放/删除/保留，不开放 raw directory操作。
- **D51（随本 RFC 待批准）worktree reconstruction先取得 task/target reservation**：
  `WorktreeReconstructionCapabilityV3`从 canonical worktrees root + restored task id + ordered
  repo descriptors mint `reserveTaskContainer`与`reserveRepoTarget`。task container记录
  existing或operation-created exact publication receipt；repo target reservation记录
  parent/name/private/canonical same-inode publication evidence。每个 missing
  root/namespace/container/target先 durable声明 publication intent，在 broker-private slot创建并
  fsync empty directory、记录 identity，再以 no-replace rename发布；canonical parent fsync与
  publication receipt完成后才进入 `reserved`。Git adapter是唯一可消费 terminal reservation的
  actor；不能接受 raw path或 generic mkdir。whole parent absent、parent-only与partial child均可
  从 private/canonical exact evidence resume。逆序 compensation只移除 identity匹配的
  operation-created target/registration，最后仅在 operation-created parent仍为空时删除；
  preexisting parent/entry与identity replacement一律 repair而不删。
- **D52（随本 RFC 待批准）每 repo reconstruction ledger是效果凭据**：
  `WorktreeReconstructionReceiptV3`以 ordered per-repo discriminated entries替代
  `completedRepoIndexes/registrationIdentities`。每 entry保存 repoIndex、phase、descriptor/task/
  repo fences、directory publication、target reservation identity、post-add target identity、Git
  registration identity及 branch/ref before/after；task receipt另保存 ordered root/namespace/
  container publication records。`reserving/publishing`覆盖 directory canonical effect前后，
  terminal reservation先于 Git effect durable；add返回后必须先 durable post-add evidence才可
  overlay。若进程在 directory publish或 add返回前后/ledger fsync前崩溃，startup分别用
  private+canonical slot或 repo-admin + exact target slot重新 discover，并且只有唯一 identity与
  recorded fences一致才补记；否则 repair-required。`compensateExact`只从 ledger rehydrate
  closed capabilities，按 overlay→registration/target→directory publication逆序执行，branch/ref
  只做 recorded before→after CAS rollback。全部 exact cleanup后以 terminal
  `compensated + closed skip reason`继续 optional-worktree restore；任何一步不可证才保持
  repair-required。
- **D53（随本 RFC 待批准）legacy active pair必须由 operator重新授权**：
  released marker+archive的 `active-pair`与 post-swap failure/catch-before-quarantine在磁盘上
  物理同形。startup先在 non-restored adoption ledger fsync
  `operator-confirmation-required {adoptionId,evidenceDigest,marker/archive/directory identities}`，
  然后在 DB open、migration、restore与 HTTP/workers前以 typed
  `legacy-active-pair-ambiguous`退出；不得自动发布 V3 marker。stopped CLI只能通过 exact
  adoption id读取 `RestorePlanDtoV3`，再以新 `clientMutationId`和 evidence digest显式提交
  `reapply | quarantine`。non-restored `LegacyPendingOperatorLedgerV3`先按 stable caller scope/id/
  request digest写 `claimed`；reapply依次 checkpoint
  `v3-staged → legacy-moving → legacy-held → v3-marker-published → settled`，从 canonical exact
  archive mint `ReadOnlyBackupCapabilityV3`并 seal到独立 V3 private stage，再按 D55的 pre-effect
  move publication把旧 active directory exact rename到 adoption-hold，最后发布不冲突的 V3
  marker并执行 generation，hold在 V3 cleanup-verified前保留。quarantine同样必须先建立 D55
  move publication再 exact no-replace rename。response loss/restart只沿
  operator/move/adoption/V3 receipts重放，identity drift转 repair-required。
  合法未开始 pending也付出一次确认，这是无法从 released bytes恢复 phase事实的明确兼容性取舍。
- **D54（随本 RFC 待批准）directory reservation使用可恢复 publication state machine**：
  `WorktreeDirectoryReservationPublicationV3`覆盖
  `declared → private-prepared → publishing → published → removing → removed`，另有 `existing`与
  `repair-required`。`declared`在任何 mkdir前持久化 operation/slot role、descriptor fence、
  exact parent identity、validated leaf与 opaque broker-private slot id；private mkdir后记录
  identity。Linux只用 `renameat2(RENAME_NOREPLACE)`、Darwin只用
  `renameatx_np(RENAME_EXCL)`把同一 inode发布到 canonical slot，并消费 mint时 exact parent
  `ArtifactDirCapabilityV3`而不重解字符串 path；primitive qualification失败则在 declaration/
  目录 effect前 typed unavailable。`publishing`在 rename前 fsync；restart按 recorded
  identity检查 private/canonical：只有 `declared`且两处 absent可创建；`private-prepared`或
  `publishing`两处都 absent为 authority丢失并 repair；private-only继续发布、canonical-only exact
  匹配补 receipt，both或 replacement进入 repair。single container/target共享同一 publication，
  不重复创建；multi root/namespace/container/children按父 publication顺序执行。compensation在
  unlink/rmdir前写 `removing`，identity-matching absent后写 `removed`；repo与 top-level
  compensated receipt必须引用这些 cleanup records。private orphan不成为 canonical authority，
  并由相同 ledger exact cleanup。
- **D55（随本 RFC 待批准）legacy handoff使用独立 move publication**：
  `LegacyPendingMovePublicationV3`覆盖
  `declared → moving → moved → cleaning → cleaned`，另有 `repair-required`。`declared`在
  rename前 fsync `publicationId/adoptionId/action/sourceIdentity/sourceParentIdentity/
targetParentIdentity/opaqueTargetSlot/targetAbsentProof`；broker closed allowlist只允许
  `pending-restore-legacy-hold`与`pending-restore-legacy-quarantine`。`moving`在 syscall前
  fsync；rename成功并 fsync source/target parent后，`moved`保存与 source same-inode的
  `targetIdentity`及 source-absent proof。reapply的 settled control持续引用 move publication，
  V3 terminal后才走 cleaning/cleaned；quarantine的 settled receipt引用 retained moved target。
  rename阶段对 source-only继续、target-only exact补 receipt，both/neither/replacement只 repair；
  cleanup阶段按 D57 的 phase-sensitive matrix收敛。任何阶段都不从 adoption id重新推导 path。
- **D56（随本 RFC 待批准）worktree compensation显式区分 never-created与 no-Git-effect**：
  `WorktreeDirectoryReservationPublicationV3`新增 terminal `closed-absent`，只允许
  durable `declared`且 private/canonical在 exact parent/slot均 absent时生成，携双 absent
  observation与 parent proof，不要求 `removedIdentity`。task-container `compensated`允许
  `reservation=null`，但 root/namespace/container每个非空 publication必须分别终结为
  closed-absent、removed、existing-retained或 D58限定的
  created-infrastructure-retained。repo compensation的 effect是 strict
  `none | partial | registered`：`none`保存 effective registration/branch before snapshots、
  `not-started`或 no-add-intent `before-git` proof与 directory cleanup，不得出现伪造 after字段；
  `partial|registered`保存实际 component delta并逆序补偿。single target只接受与
  `published + operation-created` container同 publication id的 alias；existing container在任何
  repo reservation/Git effect前返回 `target-present`。
- **D57（随本 RFC 待批准）legacy hold cleanup使用独立 post-cleanup evidence**：
  pre-move target absent proof与 post-cleanup target absent proof以 purpose/revision分型，不可互换。
  `cleaning`先于 exact remove持久化；remove后重新观察 source/target双 absent并对 target parent
  re-fsync，形成绑定 publication、moved target identity、parent、slot与 cleanup revision的
  `LegacyPendingMoveCleanupEvidenceV3`，才可 checkpoint `cleaned`。restart在 `cleaning`看到
  target-only时 exact重试 remove，看到 exact neither时重建上述 evidence并 roll forward；
  `moved`阶段的 neither仍是 repair。
- **D58（随本 RFC 待批准）worktree Git preparation与 add delta分别记账**：
  root/namespace由本 operation发布但按共享策略保留时，terminal cleanup新增
  `created-infrastructure-retained`，只接受相同 reconstruction、root/namespace role、published
  canonical identity与 fresh observation。registration preparation以
  `already-absent | stale-removing → stale-removed | stale-retained`独立 checkpoint收口；成功
  stale cleanup前的 intent固定 cleanup attempt、registration identity/fence及唯一
  expected-target admin entry的 parent/leaf/identity，成功后 effective baseline固定 absent。
  `already-absent|stale-removed|stale-retained`任一 terminal preparation到 add intent之间取消或
  遇到 baseline未变的 typed failure时，先写无 add intent的 before-git
  compensating/no-effect proof，复验各自 effective absent或 original stale baseline，再清 exact
  target并 terminal；任何 snapshot drift仍 repair。Git add intent在 syscall前
  保存 bounded repo-admin inventory、target empty identity、branch/ref、effective registration
  baseline及资格化命名算法产生的 exact admin-slot absent intent；deterministic naming/inventory
  cap在任何 directory declaration前完成，无法预声明唯一 slot或 inventory超 cap时零 effect
  typed skip。discovery返回
  `not-started | partial | registered | ambiguous`。`partial`逐项保存 branch-only、
  registration-only、operation-owned partial admin dir/target delta，cleanup first-fail保持
  compensating并在第二次 exact重试。stale remove明确未开始或 effect前 cancel且 original
  registration/admin未变时以 `stale-retained + before-git none`清 target并 skip；无法唯一绑定
  expected target/ref/admin slot才 repair。
- **D59（随本 RFC 待批准）recovery codec逐字段 canonical equality**：
  `ArtifactEntryIdentityV3Schema`规范序列化；共享 `artifactEntrySnapshotEqual()`比较
  dev/ino/mode/nlink/fsid，共享 `artifactEntrySameObject()`比较 dev/ino/fsid/file-type以覆盖
  directory内容变化，consumer不得自选字段。`LegacyPendingMovePublicationV3Schema`、
  `WorktreeDirectoryReservationPublicationV3Schema`、Git preparation/effect schema与顶层 receipt
  schema全部 `.strict()`。各自 `superRefine`必须把 nested publication/reconstruction/action id、
  parent/slot/role/fence、source=moved identity、fsync parent/filesystem、cleanup removed identity与
  absent observation逐字段绑定；顶层嵌套引用再次 safeParse。任何 foreign但类型合法的替换在
  filesystem discovery前 fail closed。
- **D60（随本 RFC 待批准）receipt wire与 identity wire使用两个显式 type boundary**：
  mount approval schema无 transform，并以编译期 equality锁定
  `z.output === IntentMountApprovalReceipt`；合法 approve/reject runtime parse逐字段不变。
  filesystem identity另有 strict `ArtifactEntryIdentityV3WireSchema`，`dev/ino`只接受
  `0 | [1-9][0-9]*`且不超过 uint64 max，mode/nlink/fsid只接受 safe integer；唯一 decoded schema
  在 object parse后把 dev/ino转为 bigint，唯一 encoder再生成 canonical decimal并 re-parse。
  nested recovery schema只消费 decoded output，frontend approval flow永不引用该 transform。
- **D61（随本 RFC 待批准）durable root codec registry封闭写侧**：
  build-bound registry逐项列出 `ArtifactWriterObligationV3`、
  `ArtifactPublicationReceiptV3`、`PendingRestoreControlEnvelopeV3`、
  `PendingRestoreInFlightRecordV3`、`LegacyPendingRestoreAdoptionRecordV3`、
  `LegacyPendingMovePublicationV3`、`LegacyPendingOperatorControlV3`、
  `ArtifactLegacyArchiveAdoptionReceiptV3`、worktree directory/registration/stale-cleanup/
  before-Git/effect roots与 `WorktreeReconstructionReceiptV3`。每项有独立
  `*WireSchema/*Schema/encode*`和 input/output equality断言；discriminated union encoder逐 case
  构造完整对象，以 `assertNever`锁新增 branch，nested identity只调用
  `encodeArtifactEntryIdentityV3()`。统一 serializer只接 encoder返回且经 root wire schema验证的
  wire，先递归拒绝 bigint再 canonical JSON；底层 append/checkpoint writer只接收带 root-kind
  brand的 bytes，禁止 decoded root、JSON replacer或 object spread式漏映射绕过。
- **D62（随本 RFC 待批准）restore generation marker是第 15个 registry root**：
  `RestoreGenerationMarkerV3`以七个 exact phase branch保存 staged/safety/DB exchange/FS
  exchange/migration/identity barrier/cleanup的递增 prefix，suffix必须为 null。配套
  `RestoreGenerationMarkerV3WireSchema`、decoded schema与
  `encodeRestoreGenerationMarkerV3()`逐态逐字段构造，identity全部走 canonical leaf codec；
  `superRefine`绑定 operation/digest/config preserve-or-replace、published=staged、
  displaced=live-before observation、safety copy与 live digest一致、最终 observation与 cleanup
  exact identity。marker在 non-restored broker
  control root fsync；cold CLI与 pending startup都必须在 DB open前按 exact phase恢复。
- **D63（随本 RFC 待批准）storage loader拥有唯一 raw→trusted权限**：
  canonical storage frame固定为 strict `{schemaVersion,rootKind,digestAlgorithm,digest,
canonicalJson}`，digest覆盖 domain separator + exact kind + payload；外层与内层都必须
  byte-for-byte canonical。`loadCanonicalDurableRootV3(expectedCodec, rawFrame)`是唯一 raw
  consumer，执行 fatal UTF-8/size/strict frame/expected kind/digest/inner wire/decoded
  refinement后，经 module-private constructor与 runtime `WeakSet`生成实例。业务层不暴露
  `readRaw/rebrand/generic lookup`，decoder再次检查 runtime membership与 kind；writer encoder与
  loader之外无 brand来源。
- **D64（随本 RFC 待批准）SQLite publication独立成为第16个 durable root**：
  `ArtifactSqliteGenerationV3`保存 DB及 optional WAL/SHM exact identity/digest/presence。archive
  trio先在 private root copy+fsync并 checkpoint/consolidate，staged generation只允许 self-contained
  DB。live observation后，`restore-sqlite-publication`按
  declared/wal-removing/wal-settled/shm-removing/sidecars-settled/db-publishing/db-published/
  repair-required推进；`declared`只允许 `pending|not-applicable`，WAL未 settled时 SHM也只能保持
  初态。每个 present sidecar先持久化 expected identity与intent revision，再 exact
  unlink+parent fsync+removed receipt。DB/WAL/SHM/config/Skills safety与 live publication各有互不
  混用的 closed slot role；DB absent走 no-replace，present走 exact exchange。
- **D65（随本 RFC 待批准）restore executable appendix是 normative design source**：
  同目录 `restore-generation-v3.normative.ts`给出全部 component schemas、14个 phase schemas、
  7个 phase encoders、wire/decoded refiners、codec equality与真实 fixtures；它以 repo Zod 3.25.76
  strict typecheck并可直接运行。实现必须复用/抽取该合同，正文摘要冲突时以 appendix为准。
- **D66（随本 RFC 待批准）storage key与 publication operation均有唯一构造/验真路径**：
  `DurableRootStorageKeyV3`绑定 fixed namespace/root kind/validated segment，只能由 module-private
  factory及 root-specific locator产生并经 runtime membership验证。
  `digestArtifactFsOperationIdentityV3`固定 domain-separated canonical算法；publication receipt
  使用完整 prepared/exchanged/cleanup/repair strict union。lookup后逐字段验证 ref与receipt的
  id/revision/role/digest/full operation；SQLite ref/root另验证 publication id/revision/full
  operation/staged DB identity，任一 foreign值effect前失败。
- **D67（随本 RFC 待批准）restore options与migration disposition全链持久化**：
  `RestoreExecutionOptionsV3`三个 boolean无 optional/默认分叉，options digest进入 operation、
  pending receipt/in-flight、legacy adoption handoff、generation marker及 SQLite root。
  safety严格为 `captured|skipped-by-operator`且后者只匹配 `noSafetyBackup=true`；migration严格为
  `applied|skipped-no-migrate|not-required`并与 options/schema delta cross-field绑定。
- **D68（随本 RFC 待批准）live target presence决定 publication与cleanup algebra**：
  DB/config/Skills live observation各为 `absent|present(identity,digest)`；DB/Skills incoming均有真实
  sealed generation。absent使用 no-replace、displaced=null、cleanup not-applicable；present使用
  replace、displaced=exact live identity、cleanup removed。config另保留 preserve分支；
  `noSafetyBackup`只放弃 rollback bytes，不放弃 observation、publication ledger或 exact roll-forward。
- **D69（随本 RFC 待批准）publication root是不可变 revision chain**：
  `ArtifactPublicationReceiptRefV3`与`RestoreSqlitePublicationRefV3`都携
  `revision + frameDigest`；trusted storage key包含 root id/revision/frame digest而非只含可变
  segment。每个新 frame保存 `previousRevision/previousFrameDigest`，append禁止覆盖既有 revision；
  `latest*Descendant(anchor)`只遍历同 id的连续、逐帧验真 lineage。marker保留当时 anchor，
  cleanup/repair不回写旧 marker引用。
- **D70（随本 RFC 待批准）publication verifier按用途绑定完整 projection**：
  `assertPublicationRefMatchesV3`除 ref/operation/role外必须接
  `ArtifactPublicationExpectedProjectionV3`。safety只接受
  `cleanup-verified + no-replace + captured identity/digest`；identity barrier只接受 exact
  exchanged state；cleanup只接受同 receipt的 cleanup-verified descendant。三处 caller必须把
  staged、expected、published、displaced facts从 marker generation传入，不能只比较 role
  multiset或任选同 operation receipt。
- **D71（随本 RFC 待批准）repair只允许 lossless terminal transition**：
  artifact repair按 prepared/exchanged/cleanup-verified分支保存该 phase的全部字段；SQLite
  repair的 forensic按 declared到db-published七个 prefix分支保存 exact WAL/SHM removal、
  databasePublication及database exchange。`assert*TransitionV3(previous,next)`先验证 immutable
  lineage与 invariant base，再验证 next forensic等于 previous canonical projection；repair
  terminal，不允许从 repair继续隐式执行。
- **D72（随本 RFC 待批准）legacy operator reapply显式继承 options authority**：
  adoption evidence-only阶段可因没有可信 marker而保持 options unavailable；但只要进入
  `operator-confirmation-required`或任何 reapply phase，record必须含完整 options/optionsDigest。
  `LegacyPendingOperatorRequestV3`的 reapply分支、operator control的 claimed/authorized/running/
  terminal分支及 receipt都逐字段复制并与 adoption/new operation cross-bind；quarantine分支不
  冒充 restore options。
- **D73（用户新增要求，随本 RFC 待批准）Intent执行过程复用统一 session projection**：
  migration新增 `intent_turn_events`，以 `(turn_id,event_seq)`唯一、turn cascade FK保存
  timestamp/kind/payload/root session id/parent session id；Intent turn另投影
  `captureState='live|complete|truncated|incomplete'`与 last event seq，不复用带
  `node_run_id`外键的 `node_run_events`。`runSystemAgent`新增有序、awaited、bounded
  normalized-event sink，并在 private store cleanup前调用抽取后的 runtime session-capture
  adapter写入同一 sink；capture失败只把执行视图标为 typed incomplete，不改已经确定的 Intent
  changeset/questions/error业务结果。新增与 Intent detail同一 read scope的
  `GET /api/intent-sessions/:sessionId/turns/:turnId/session`，turn必须属于 route session，
  creator owner与现有 system-admin audit只读可达，其他 foreign/missing同形404；响应只返回
  strict `SessionViewResponseSchema`与非敏感 capture meta。
  frontend把 `SessionBody`抽为接 query key/loader的`SessionConversationPanel`，任务
  `SessionTab`继续包 attempt picker/inventory，Intent agent turn默认展开最新 running、历史默认
  折叠；WS仅广播 `{sessionId,turnId,eventSeq}`用于 invalidate，500ms节流且断线用 running
  polling兜底，绝不广播 raw tool payload。

## 5. 用户故事

- 作为首次使用者，我进入 Intent Builder 就能直接描述目标，并看到「不必先懂资源结构」的
  引导与可选示例，而不是先判断该点哪个重复按钮。
- 作为熟练使用者，我可键入目标、按 `Cmd/Ctrl + Enter` 生成第一版；示例和产物类型不会
  阻碍纯键盘操作。
- 作为从 Workflow 编辑页进入的使用者，我看到清楚的「正在修改 Workflow」上下文，不会被
  再次询问产物类型；创建请求仍在第一轮前预挂载目标。
- 作为正在等待模型的使用者，我在时间线里看到 Builder generating 状态与取消动作，不会把
  空白草稿栏误认为系统没有响应。
- 作为正在等待或排查生成的使用者，我能在该 Builder turn内展开与任务 Session相同的执行流，
  看到 reasoning、tool call及 subagent层级；刷新、断线或生成结束后仍从 durable events恢复，
  不需要在另一个页面找日志。
- 作为收到反问的使用者，我在对话流中直接回答；提交答案后阶段回到 Generate，不需在页面
  多个 section 间寻找按钮。
- 作为复核者，我在桌面右栏始终看见草稿版本、校验/stale 原因、每个 op 的富预览与
  Review & commit 主行动；窄屏按同一语义顺序逐段浏览。
- 作为需要补密钥/人类成员/副本决策的使用者，我先完成应用策略，再补必要信息，最终看到按
  资源名称组织的提交摘要；返回上一步不会丢输入。
- 作为回访者，我在最近会话卡片中快速识别状态、轮次、提交次数和更新时间，并以整卡进入。

## 6. 验收标准

1. `/intent` 首屏直接渲染 inline `IntentCreateComposer`；无会话时下方只显示紧凑的
   「暂无最近会话」状态，不再出现两个同名创建按钮。
2. Composer 主次层级为：目标输入 → 空输入示例 → 可选产物类型/modify 上下文 → 安全边界
   → 主 CTA；目标输入使用 shared `INTENT_MESSAGE_MAX` 的原生上限与计数。创建 payload 为
   `{clientMutationId,message,hint?,mounts?}`；统一 ledger 中同 owner/id/endpoint/scope/fingerprint
   replay 返回原 session，id 被不同 endpoint 或 payload 复用时 fail closed，response loss 只
   重放同一冻结 payload/id。
3. 三个示例仅在普通创建且 trimmed message 为空时可见；点击填入、不提交；非空输入永不
   被示例按钮覆盖。
4. 普通创建的 Auto + 六类产物均可通过鼠标、Tab、方向键浏览；当前 host支持项可选择，
   unsupported项保持可见但 `aria-disabled`且同屏说明原因，键盘不能选中。modify 入口不渲染该
   radiogroup，POST 仍携正确 mount。capability DTO malformed/unknown时 Plugin等受影响路径
   fail closed，不能乐观启用。
5. 快捷入口 Dialog 使用 `size="lg"`、显式初始焦点与 trigger focus restore；关闭后清理
   `create/hint/mountType/mountId` search，浏览器前进/后退不会留下视觉与 URL 状态分叉。
6. 390×844 下创建 Dialog 使用近全高安全边距、正文可滚、footer 固定；类型卡两列且无横向
   overflow。1280×800、390×844 light/dark，以及 390×568 touch和 Dialog已聚焦后
   844→568的软键盘近似 resize均通过；create/commit当前输入、唯一滚动区与 CTA持续可达，
   interactive target至少 44×44px且不被 overlay/safe-area遮挡。
7. 最近会话使用语义列表和 link cards；状态、turnSeq、commitSeq、updatedAt 全保留；长标题
   换行/截断有可访问全文，不依赖横向滚动。
8. 会话页阶段投影有表驱动纯函数测试，覆盖 generating、clarifying、review-ready、
   review-blocked(stale/validation)、applying、applied、error、idle-active、archived；
   权威优先级逐项锁定。
9. 桌面会话页为单主滚动双栏，conversation 在 DOM 中先于 review workspace；≤1080px
   回落单列，390px 无水平 overflow。
10. 时间线使用语义 `<ol>`；历史 turn 顺序逐字保持。用户/agent message、answers、
    changeset、questions、error 各有可读投影；answers 不再显示原始 JSON。
11. pending questions 位于最新 Builder question 卡内：单选用原生 radio choice rows，多选用
    checkbox choice rows，并可提交 1..N 个 picked；选项长文本可换行。答案 state 绑定 source
    question turn id，轮次变化不继承同名 question id；所有题答完前按钮禁用。answers request
    携 `clientMutationId/sourceTurnId/expectedTurnSeq`，服务端 transaction 拒绝迟到/跨轮答案，
    同 id replay 返回同一 user/agent turn receipt。
12. 最新 agent turn 的 mountRequests 逐项显示 type/name/reason；Approve 必须由使用者在
    actor-visible 候选中选定具体资源，Reject 显式记录 name。questions 同轮存在时，统一主
    行动严格先 POST mount-approvals、取得 durable receipt 后才 POST answers；第一步失败绝不
    触发下一轮。服务端按 source turn 校验完整 decisions，在同一 transaction 内原子记录
    approve/reject 与 manifest 变化；HTTP 与 detail turn content均以 strict shared schema返回
    相同 receipt，包含原/结果 turn seq、结果 context revision及 source-order逐项 outcome。
    response loss 以同一 clientMutationId + sourceTurnId replay/read receipt，answers只消费
    `resultingTurnSeq`，不再从 name/seq/mounts 猜部分副作用。重复 `(resourceType,name)` 建议在
    source turn 内规范化；
    当前 question/mount decision 未完成时 Continue 与 commit 同屏说明原因并阻断，manual mount
    和 approval 仍可用来解除阻断。
13. 生成中状态位于时间线尾部并显示取消动作；错误卡显示结构化 code 与 Retry；所有 mutation
    pending、API ErrorBanner、archived/owner-admin-audit 只读路径均可达。generation-starting
    response 返回前必须已有 reserved running 或 terminal error turn；route/callback 在
    reservation 后失败、runtime unsupported、budget exhausted、daemon restart 都有 durable
    terminal path。dispatcher/live-owner 周期回收不能误杀合法长任务。高风险动作按统一 ledger
    receipt reconcile；无 receipt 的动作不把等价 marker 冒充 attempt 成功。`draft.stale` 引导
    生成新版，只有 `intent-baseline-stale` 才引导 rebase。
14. review workspace 保留全部 `IntentOpPreview` 富预览与 per-op error；stale/validation
    时主 CTA 禁用且必须同时显示人类可读原因，不能只靠 disabled。`draft.changeset` 先经 shared
    schema safeParse；无效数据不进入 op/commit 控件。commit DTO 以单调 attemptSeq 排序并含
    draft/client identity；任一 prepared/applying/compensating/repair-required journal期间，
    commit 与其它 session write同样禁用并说明正在结算。每次 apply state transition WS、
    compensating 1.5s polling与 repair-required低频 reconcile可让其它标签页及时看到 gate。
15. Review & commit action bar 紧随 draft summary；桌面 sticky 到 review rail 顶部，移动端
    恢复 normal flow，不遮挡预览、safe-area 或虚拟键盘。
16. Commit Dialog 动态步骤与 gating 有纯函数/DOM 测试；上一步/下一步不丢 applyMode、
    slotValues、humanPicks；secret 非空与每个 secretWaiver 显式勾选是前端 gate，
    humanBinding/finalName 保持 optional；最终 POST 的
    `clientMutationId/draftRevision/draftHash/decisions`
    与 RFC-234 字节语义不变。Dialog 打开时固定
    `{draftId,revision,draftHash,ops,slots}`，live draft 变化不得静默替换。4xx 后可修正并生成
    新 attempt；transport/5xx 等非确定结果冻结原 request，复核当前 detail 后只允许以同一
    clientMutationId 重放或采纳已提交结果；
    `intent-apply-unsettled` 继续等待，不能误开新 attempt。含 secret 的 frozen request
    只驻留组件私有内存 ref，不作为 mutation variables，不进入 storage/query cache/URL/log；
    navigation/beforeunload guard 与安全 locator 恢复有 DOM/E2E 证明。server ledger 的 HMAC
    fingerprint覆盖 pinned draft 与 decisions；same id 改 draft/decision/secret 必须在 freshness
    gate 前返回 structured conflict。
17. commit history 按服务端 `attemptSeq` 展示；每项以
    `clientMutationId + draftId/draftHash` 权威关联，receipt 以资源名称可读呈现；
    prepared/applying/compensating/repair-required/failed/committed 六态保持，
    `compensating/repair-required`始终是阻断写入的非终态，不冒充失败已清理。
18. 新增/修改 i18n 中英文 key 对称；页面没有裸 key、raw opId 作为主要标签，conversation
    不显示 raw JSON；`IntentOpPreview` 既有「精确 payload」details 作为审阅证据继续保留。
19. 键盘路径覆盖：打开/关闭快捷 Dialog、示例填入、类型 radiogroup、Composer 提交、
    问题作答、打开 commit、Stepper 前后退、ESC/focus restore；reduced-motion 无依赖动画。
20. axe WCAG 2A/2AA 的 critical/serious 为 0；桌面 light、桌面 dark、390px light、
    390px dark 做真实浏览器视觉核对，并与 `/agents`、`/workflows`、`/workgroups` 对齐。
21. 所有 Intent list/detail/create HTTP response 在建立 journey/权限 gate 前经 shared schema
    safeParse；malformed outer DTO fail closed 且不显示 raw payload。mounted/modify context
    显示 actor-safe name/type/owner，长 Owner 可换行，删除/不可见资源安全 fallback。
22. create initial mounts、manual add/remove/rebase 的 deterministic interleaving 全绿：archive、
    grant revoke、visibility change、delete 或 context revision 改变发生在 route read 与
    transaction 之间时，写入必须 fail closed；create/add 的最终资源授权只来自
    `canViewResourceInTx`。
23. archive/reopen 与 apply claim/final transaction 的交错测试全绿：status mutation 在
    transaction 内拒绝 unsettled apply，final apply 必须复验并 CAS `status==='active'`。
24. `bun run typecheck && bun run lint && bun run test && bun run format:check && bun run depcheck`
    全绿；shared/backend/frontend 定向 suites、migration check、Intent Playwright、binary smoke
    和 Codex 实现门通过。
25. dispatcher principal 回归全绿：route actor 在 reservation 后丢失仍由 periodic poll 接管；
    disabled/missing owner 或失去 `intent:write` 时 exact running turn terminal 且不调用模型；
    grant revoke 后 mounted private root 不进入 dump；role 升降、普通 admin owner与 exact
    system-owned兼容路径都使用当前 owner 身份。任何非 admin普通 owner case 均证明没有
    `__system__` fallback且 foreign-private canary 不泄露；普通 admin只获得其当前 role既有的
    resource-admin visibility，身份仍不是 system。restart/cancel 仍受 turn/claim CAS。
26. mutation normalizer 回归全绿：commit duplicate `opId`、duplicate
    `(opId,slotId)` 与 answers duplicate question id/picked option 在副作用前拒绝；create mount 顺序、
    source question option首次出现去重、single/multi数量、question/option/approval 顺序、commit
    decision/slot 顺序及 trim/default/omit 规则逐项锁定。duplicate/reversed
    secret/human/waiver、mount 换序与 picked 换序均按合同产生
    same-normalized replay或 changed-body conflict；性质测试证明同 endpoint/scope/key 下
    fingerprint 相同必然对应 executor 消费的相同 normalized bytes。
27. apply final-authority 回归全绿：journal持久 current-session-owner run-as；claim与 final
    transaction均读取 current user，prepared route actor不能进入权威 kernel。Workflow/
    Workgroup owner transfer、builtin flip、role升降/user disable及 bundle reference grant revoke
    分别注入 preflight→plugin stage→skill stage→final tx；任一失配均零资源改动、原 target
    不变、journal先进入 compensating；只有 exact Plugin generation/Skill reserve逆序补偿成功
    才 typed failed，exact replay只返回原失败。MCP 全字段 operation hash作为既有 fence会拒绝
    ACL transfer的对照组。
28. disclosure admission 回归全绿：冻结 snapshot 与 final admission覆盖全部会影响
    inventory/root/closure seed的 visible row/token；catalog ACL读取后、各类/Skill文件读取后、
    final admission前分别注入 grant revoke、owner transfer、visibility/content change、delete、
    rename与 role downgrade，普通 user canary字节不得进入模型。final admission成功持久化仅
    digest/timestamp；admission→spawn间的变化按已声明线性化语义不取消 live run，长任务不被
    orphan sweep误杀。
29. source owner-first 回归全绿：answers/approvals 对 foreign/manager/admin auditor 的正确或
    错误 question/option/type/name均同形 404，spy证明零 source read/parse、零 ledger/turn；
    owner duplicate/missing/extra仍得到结构化错误。cross-session、missing/corrupt source、
    session推进/归档后的 exact replay与 changed-body conflict均锁定。
30. artifact recovery 回归全绿：npm/git generation id由 caller预生成并先持久化，Skill
    receipt与 hidden reserve row/op同 transaction建立。Plugin containment identity durable前
    不得启动 npm；Linux private PID namespace必须收口
    `setsid + double-fork + closed-pipe` lifecycle descendant。daemon EOF/timeout/cancel/restart后
    只有 supervisor-owned Ed25519 EMPTY signature确认 kernel process set empty才可 quiesced，
    signature绑定 release digest/public key id/boot+start/PID namespace identity/direct leader与
    artifact revision；terminal后等待 fixture
    延迟写窗口仍不能复活 generation。Darwin npm/git Intent apply及 Linux capability probe失败都
    必须在 journal receipt、generation leaf、GO、npm之前 typed fail closed；managed Skill与
    `file:`零-owned-artifact路径继续可用。
    Plugin/Skill host writers全走 `ArtifactFsCapabilityV3`产生的 dir/temp/entry authority；
    Linux anonymous temp hardlink攻击、Darwin contained-child named-temp hardlink、bind mount/
    mount crossing、在最后一次验证返回→syscall窗口替换任一 parent/leaf，及 lifecycle child主动
    rename/symlink再写，外部 sentinel都必须零 bytes。npm sandbox只可写 exact opened
    leaf/attempt scratch且不可写 authority ancestors。
    record/GO/npm/manifest、Skill materialize/version与 final transaction断点真实杀 daemon，
    restart只有在 writer quiesced后才精确删除本 attempt目录并 terminal。cleanup第一次失败、
    第二次成功时第一次仍 compensating且 exact authority保留；同 plugin多 generation、长期
    running node与 legacy fixture证明不依赖24h GC、不误删 current/其它 attempt，无法证明的
    identity进入 repair-required。既有 v1 failed显示 legacy cleanup unverified，新 v3 failed
    必须带 cleanup verified proof。
31. model-input回归全绿：六类 shared examples逐个通过 strict changeset parse、resolve与 canonical
    validation；golden锁 Plugin `optionsJson`/required description和 Workflow output ports/bind/
    matching edge，旧 `options?`文案由 source guard禁止。六类 hint分别从 create body进入 immutable
    session再进入 fenced-history之外的 trusted `INTENT.md` section；Auto omitted、modify omitted、
    明确目标覆盖弱 hint都有测试。E2E stub必须实际读取 `INTENT.md`并按 hint/type分支，不能固定
    返回 Agent。
32. platform capability回归全绿：Composer在生成前 strict parse host DTO；Darwin generic
    Plugin卡禁用并解释 npm/git不可用，D42 exact file-Plugin modify除外；Auto/URL hint/明确自然
    语言目标均让模型看到同一矩阵且不生成 unsupported op。admitted Linux六类 flow可生成并
    apply；Review preflight仍拒绝 capability drift。已知
    definitive pre-accept 422销毁 id；丢失的 rejection response后，同 frozen id可在能力恢复时被
    首次接受，但统一 ledger保证 accepted effect至多一次。
33. whole-tree restore与broker trust回归全绿：cold CLI、pending startup、pre-restore safety
    snapshot、config/DB/skills generation swap、post-swap migration/identity barrier和 crash每阶段
    recovery都只消费 `ArtifactRestoreCapabilityV3`；不出现 canonical root裸 `rm/cp/rename`。
    Linux sealed-fd exec与Darwin post-exec code identity在 authority transfer前通过；helper swap/
    unsigned或identity mismatch零 root dirfd。supervisor/daemon non-dumpable与 no-core生效，同
    UID sibling的 ptrace/mem/fd/control injection及 old EMPTY replay qualification均失败。
34. accepted replay/capability interleaving全绿：green时 accepted且 response丢失，随后把
    static/dynamic capability翻 red，同 frozen id/body仍先返回原 ledger anchor且不产生第二副作用；
    ledger absent的 red请求仍零状态422，red→green未知结果只可首次 accepted。claim race必须在
    transaction二次 ledger lookup与 `ArtifactAdmissionLeaseV1`验证下收敛。
35. Skill/file/tree publication全绿：sealed directory tree只经
    `commitTreeNoReplace|Replace`发布，replace receipt同时持有 published/displaced identity；
    staged→exchange前、exchange→receipt后、displaced cleanup前逐点真 crash，restart只 exact
    resume/cleanup。tree writer不能消费 canonical/general dir capability，operation/slot mismatch
    零写；non-restored publication ledger在业务 DB回滚后仍保留 displaced authority并与 current
    inventory合并。raw path API/source guard编译门证明六类 Linux managed Skill主路径无需绕过 V3。
36. restore/containment组合全绿：构造 backup B后启动 released writer、杀 daemon、让 supervisor
    延迟 EMPTY，再启动 pending restore到 B。非 restore obligation ledger必须先收口 writer，
    DB swap后仍能验签并 exact cleanup/repair；Plugin generation tree不随 restore也不能让
    HTTP/GC提前开放。ledger/DB任一单边持久化断点均保守恢复。
37. live staging全绿：daemon持锁时 CLI `--stage`与 admin HTTP都只调用 daemon-owned
    `PendingRestoreStageCapabilityV3`；peer/boot nonce错、fd/digest换包、并发 stage/cancel、
    daemon stop/start竞态、response loss均按 exact stage receipt收敛。daemon stopped时 CLI持锁
    走同一 broker；任何路径都没有裸 `.restore-upload/.restore-pending` writer。
38. mounted `file:` source全绿：模型只收到 source handle，raw path不进入 `INTENT.md`；尝试提交
    任意 `spec`、换 handle、跨 session handle或在 dump→final间改变 source kind/spec/ACL/hash，
    都在 source open前拒绝且 external-read spy为零。exact mounted source成功 copy/create，
    read-only capability不删除、不改写源。
39. config restore file合同全绿：有/无 incoming config与有/无 live config四种组合均按
    `configDisposition`处理；incoming缺失保留 live regular file，incoming存在只用 file temp/
    exchange publication。regular-file↔directory、symlink/hardlink、digest/identity mismatch均在
    swap前拒绝。file exchange前、syscall后 receipt前、displaced cleanup前逐点真 crash，restart
    只按 marker/publication identity恢复；完成后 `Paths.config`仍是 regular file且
    `loadConfig(Paths.config)`可读，skills仍通过 sealed tree交换。
40. backup authority全绿：manual、HTTP、scheduled、auto、pre-migration、pre-restore、healthy与 corrupt
    DB模式都只能 mint allowlisted backup operation/slot；healthy SQLite adapter与 corrupt
    DB/WAL/SHM exact-copy路径都只写 broker-owned sink。packer看不到 app-home/root dirfd，只能读取
    sealed staging并写 exact output temp；publish/crash/restart按 publication ledger收敛。
    retention不能复用 export capability，不能删 active/protected/last-good archive；source guard
    证明 backup/archive/worktree snapshot/reconstruction路径无 canonical裸 writer。worktree
    missing/race/unsafe/over-cap保持 skip-not-abort且不留下半个 meta/payload，archive path字段不能
    指定 restore target。
41. pending stage/cancel replay全绿：stage与cancel receipt有 strict shared schema、stable caller
    scope、request digest、stage id/revision与 terminal state。cancel在 ledger prepare前、prepare
    后删除前、archive删除后marker删除前、effect后terminal fsync前逐点真 crash；boot均 exact
    收敛。相同 id/body在 status为 null、daemon restart及 response loss后返回原 canceled receipt；
    同 id变 body/caller、并发不同 id、stage/cancel race均 fail closed且不误删后来 stage。v1 control
    ledger无 GC并明确 owner。
42. Darwin modify pre-session grant全绿：资源快捷入口先冻结 create mutation id，再按 exact
    modify context resolve actor-safe grant；create transaction验证 grant并重验 current
    owner/ACL/source kind/config/spec fence后分配 session handle，首轮 `INTENT.md`只含 handle/
    display/binding digest。generic Darwin create仍 disabled；invisible/deleted/drifted target、
    tampered/cross-actor/cross-attempt/expired grant均零 ledger/session/turn与零 external read。
    accepted create response丢失后，即使 grant过期或 source漂移，同 frozen body/id仍 ledger-first
    返回原 session。
43. restore ingress全绿：HTTP strict raw-stream、live CLI delegated fd、stopped CLI locked fd、
    pending marker与 dry-run都只能产出/消费 `ReadOnlyBackupCapabilityV3`。HTTP在总量上限、
    chunk边界、backpressure、disconnect、daemon kill、digest mismatch、seal前后 response loss下
    不暴露 temp path/fd、不留下可见 partial；file与parent fsync后才可 stage。capability跨
    operation/boot/identity复用、multipart/raw fallback与 direct `.restore-upload` writer均被
    source guard/negative test拒绝。
44. caller replay全绿：stage/status/mutation lookup/cancel HTTP与 local-control frame全部 strict
    parse同一 receipt。Settings在 stage/cancel effect前保存 owner-bound safe locator，reload、
    sign-out/in actor变化、effect后隐藏 response、daemon restart、later stage均正确 reconcile；
    A→B时B看不到也不删除A locator，A回来后仍能 exact lookup；显式清除前有恢复能力丢失警告；
    storage不含 filename/path/archive bytes/digest。CLI在 effect前持久化+打印 id，显式
    `--mutation-id/--replay/--status`能取得原 receipt；incomplete upload只允许同 metadata/id
    重传相同 archive；同 id重复 PUT/CLI换 archive必须在流式/fd digest验证后 conflict。旧
    `{cleared:boolean}`与无 body DELETE不再存在。
45. legacy pending cutover全绿：用升级前 binary fixtures生成 valid marker、missing/partial/
    tampered archive、legacy failed quarantine，再由新 binary真实启动。fixture锁真实
    `restore-pending.json`字段/缺省值并分别覆盖 active-pair、marker-only、archive-only、
    empty-active及 quarantine
    rename/error-write窗口。active-pair只从 canonical位置 descriptor-open并投影
    `operator-confirmation-required`，boot绝不自动 apply；operator exact inspect后以新 mutation
    显式 reapply或 quarantine。marker-only只按已消费收口且不重放，archive-only只 quarantine不
    arm。`stagedTarball` path完全无 authority，也不伪造 caller replay。每点真 crash均 exact
    resume；invalid/ambiguous状态形成 typed repair summary，live generation不被误改/误删。
46. legacy backup retention全绿：升级前真实 scheduled/auto/manual/pre-migration/pre-restore
    archives在 descriptor-rooted adoption后进入统一 inventory；scheduled/auto继续按 count/days/
    total-size轮转，manual/pre-\*与统一 last-good仍保护。adoption receipt明确不同于 publication
    receipt；scan/digest/manifest/receipt每点 crash可重试。symlink/hardlink/partial/corrupt/
    unknown manifest与 identity替换均不删除并产生 typed repair，filename不能决定 kind。
47. Git worktree reconstruction全绿：new v2 backup capture完整 ordered `task_repos[]`，单个 repo
    失败时整个 task skip且无半 payload；single/multi-repo restore都由 DB-derived closed
    operation先 reserve task parent/每 repo target、注册真实 Git worktree、再 overlay并逐 repo
    验证。source repo missing、whole parent absent、parent-only、已有任一 target、stale
    registration ambiguity、partial add/overlay、daemon kill与 compensation
    first-fail-second-success均保持零覆盖或 exact repair；旧 v1 single-repo可恢复，旧 v1
    multi-repo typed skip。archive meta/path无法改变 repo/target/branch/argv，外部 sentinel零写。
48. restore inspection全绿：daemon live/stopped下 default plan与 `--dry-run`均返回同一 strict
    `RestorePlanDtoV3`；live path只经 peer/boot-auth local-control `inspect-backup` + delegated fd，
    stopped path持锁走同一 service。peer/fd/digest/frame错误、响应丢失与 daemon kill均 exact清理，
    pending/control/publication/locator/DB/config/skills/worktree side effect为零；embedded path直接
    读取 sealed migration journal，`extractMigrationsTo()`调用次数为零。
49. actor locator retention全绿：A stage/cancel响应丢失→切到B→reload/restart→切回A的序列中，
    B既不读取也不删除A locator，A能取得逐字段相同 receipt；B同 id独立命名空间。terminal只删除
    current actor exact key；显式 clear须确认并只影响本地 recoverability，foreign lookup仍404。
50. legacy evidence crash矩阵全绿：released binary真实 stage/cancel/apply failure fixture验证
    `restore-pending.json` strict codec、mkdir-before-copy、copy-before-marker、archive-delete-before-cleanup、
    DB-swap/config/skills/migration/worktree/catch-before-quarantine、quarantine rename-before-error与
    error-write后窗口。record只引用实际存在的 identities，deterministic id在restart稳定；
    active-pair/consumed/empty/orphan/quarantine分支零混淆，任何 active-pair都在 DB open前
    fail closed并要求 exact operator decision，identity replacement只 repair不删除。
51. worktree reservation全绿：canonical worktrees root已有/不存在、task parent不存在/已存在、
    parent-only、partial child及duplicate basename都按 ordered descriptor产生唯一 reservation。
    每个 operation-created entry在 canonical effect前已有 durable declaration，private
    identity与 `publishing` phase；same-inode no-replace publish + parent fsync + receipt后才
    reserved/Git。kill后从 private/canonical exact identity resume。补偿只删除本 operation
    identity匹配且仍为空的 leaf/parent，preexisting或被替换的 entry保持并 repair-required。
52. per-repo reconstruction ledger全绿：每 repo reservation/add/result-ledger/overlay/verify之间逐点
    真 crash，含 add-before-result、result-before-ledger fsync、target/registration/branch identity
    replacement与 multi-repo第 N 项失败。startup只凭 descriptor + durable evidence discover/
    rehydrate；唯一匹配则补记或继续，不唯一则 repair。reverse compensation恢复 exact branch/ref
    before值并删除 exact operation-created registration/target/container；全收口后是 typed
    compensated skip而非假 reconstructed，平行数组合同已不存在。
53. legacy active-pair operator flow全绿：合法未开始 pending与 released post-swap failure在
    marker+archive同形时产生逐字段相同的 `legacy-active-pair-ambiguous`，startup均零自动 apply、
    零 DB open。stopped CLI exact inspect后，reapply/quarantine request在 response loss、restart、
    changed action/body与 identity replacement下分别 exact replay/conflict/repair；reapply的
    V3 private seal/control→legacy adoption-hold rename→V3 marker publish→generation各断点可
    resume且 hold在 cleanup-verified前不删。旧 binary在
    DB swap后、config、skills、migration、worktree及 catch→rename各 kill fixture均不能被新
    binary当 clean pending。
54. directory reservation publication全绿：root/namespace/task-container/single target/multi child
    在 declaration、private mkdir、identity checkpoint、publishing、no-replace rename、parent fsync、
    publication receipt、removing/removed每个断点真 kill。declared+neither可重做，
    prepared/publishing+neither只 repair，private-only/canonical-only exact收敛，both与 identity
    replacement只 repair；任何 canonical directory都能追溯到 prior durable intent，single alias
    不双建，补偿同时收口未发布 private slot与已发布 operation-created slot并留下 strict cleanup
    receipt。
55. legacy move publication全绿：reapply hold与quarantine分别在 declaration/moving/rename/
    source-parent fsync/target-parent fsync/moved receipt/cleaning/cleaned逐点真 kill；source-only与
    target-only按 rename phase exact收敛，`cleaning`删除后 exact neither可凭 post-cleanup
    observation + parent re-fsync补写 `cleaned`；`moved` neither、source reappear、both与
    replacement只 repair。operator terminal receipt始终引用同一 publication，response loss不从
    adoption id/path猜目标。
56. worktree zero-effect terminal全绿：declaration后ENOSPC/EIO/cancel且两处 absent可写
    `closed-absent`；reservation未形成时仍逐层 terminal compensated。Git非零且 discovery明确
    `not-started`时写 `effect:'none'`、清 exact target并返回 `git-registration-failed`，不伪造
    registration/branch after。single-existing container在 preflight typed skip，绝不投影成
    operation-created target或进入删除路径。
57. legacy cleanup phase matrix全绿：kill immediately after hold remove及 target-parent fsync后、
    `cleaned` checkpoint前均从 `cleaning + exact neither` roll forward；settled response loss沿同一
    publication cleanup replay。`moved + neither`、source reappear、target replacement、foreign
    parent/slot/identity/proof均在任何 descriptor open前 fail closed。
58. worktree全域补偿全绿：operation-created root/namespace在 Git not-started及 multi第 N repo
    失败后以 `created-infrastructure-retained` terminal，existing/foreign infrastructure零误删；
    unique-stale exact entry removal intent前后、Git非零与response loss逐点kill后均以 effective
    absent baseline收敛。already-absent/stale-removed到 add intent之间取消或 baseline未变的 typed
    failure可凭 no-add-intent before-git receipt清 target；snapshot drift仍 repair。stale remove
    effect前 cancel/明确未开始同样保留 original并 skip。branch-only、registration-only、
    predeclared admin slot内 operation-owned
    partial directory/target delta均先 durable记账再逆序补偿；first-fail/second-success可重试，
    无法唯一归属只 repair。
59. recovery strict codec负例全绿：legacy/worktree每个 nested id、parent、slot、role、fence、
    filesystem与 identity分别替换另一合法值，包含 `sameInodeAsSource:true`配 foreign identity、
    swapped fsync、foreign removed identity/closed-absent observation、stale cleanup intent entry/
    digest错配，以及 before-git baseline/preparation/addIntent矛盾。全部 `safeParse`须在 descriptor
    open、discover、remove、checkpoint及 DB open前失败。
60. receipt/identity codec分离全绿：编译期断言 approval receipt output为 receipt，合法
    approve/reject逐字段 round trip，identity字段注入、missing/extra/order/outer-turn错配均零
    answers POST。identity wire覆盖 zero、uint64 max、大于 JS safe integer、canonical
    decoded→wire→decoded round trip，并拒绝 `+1`、`01`、`-1`、overflow与 unsafe companion
    number；approval commit后 response-loss/restart从 detail receipt恢复且 answers只提交一次。
61. durable root双向 codec全绿：registry中每个 root及其所有 identity-bearing union branch都以
    `dev/ino > Number.MAX_SAFE_INTEGER`执行 decoded root → explicit root encoder → strict wire
    schema → canonical `JSON.stringify` → `JSON.parse` → decoded root schema → exact comparator，
    编译期 input/output equality与 `never` guard锁住新增 branch。legacy move在 `moving` fsync后、
    rename前 kill，以及 worktree publication在 `declared` fsync后、private mkdir前 kill，restart
    均按同一 record继续且 effect至多一次。source guard拒绝 decoded root直接 stringify、通用
    bigint replacer、object spread/partial identity mapper；missing/extra/swapped nested identity
    在 descriptor/filesystem/DB effect前 fail closed。
62. restore marker durable root全绿：七个 phase逐态跑超 JS-safe bigint canonical round trip，
    并逐字段交换 operation/digest/config disposition/staged/safety/published/displaced identity、
    publication ref、migration/barrier/cleanup proof，全部在 DB open或 filesystem effect前拒绝。
    `safety-snapshotted` fsync后/DB exchange前及 `db-swapped` fsync后/config-skills exchange前，
    cold与 pending路径分别真 kill；重启只从同一 marker exact resume且 exchange至多一次。
63. raw frame跨进程 loader全绿：进程 A对 registry每个 root写 disk frame，进程 B只用 raw bytes
    与 expected codec恢复并通过 runtime membership检查。wrong kind、digest bit flip、outer/inner
    非 canonical key order/whitespace、duplicate key、BOM/trailing bytes、valid foreign payload、
    invalid UTF-8与 oversize全部在返回 decoded root前失败；source guard确认无 public raw lookup、
    rebrand/cast或绕过 loader的 decoder入口。
64. SQLite generation全绿：真实 file-based fixture让 incoming committed rows只存在于 WAL，并让
    live DB另有 stale WAL/SHM；private copy/consolidation后 incoming行不丢，safety DB/WAL/SHM可
    恢复 live行。safety fsync、WAL removing/unlink/fsync、SHM removing/unlink/fsync、
    DB publication syscall/receipt各点 cold/pending真 kill，重启只 exact resume/repair，最终 DB
    精确等于 incoming，stale WAL零重放。
65. normative appendix全绿：`restore-generation-v3.normative.ts`以 repo Zod 3.25.76 strict
    typecheck与 runtime执行均 exit 0；14个 phase schema、7个 encoder、两套 refiner及
    `satisfies DurableRootCodecV3` equality真实存在。逐 phase extra key、null prefix/suffix、
    wire/decoded identity、foreign ref及 unsafe revision均在 effect spy前拒绝。
66. publication locator/digest全绿：valid ref只能经 root-specific factory取得 runtime-trusted key并
    返回 full matching receipt；wrong namespace/kind/segment、same-kind foreign receipt、wrong
    id/revision/role/operation/digest与 collision全部在 descriptor/DB/FS effect前失败。digest golden
    固定 domain、canonical input与 version。
67. restore options/migration全绿：`noMigrate=true|false`、`noSafetyBackup=true|false`、
    `skipIntegrityCheck=true|false`全组合从 stage/cold checkpoint重启后保持逐字段相等；changed replay
    conflict。`fs-swapped`后 kill时 migration runner按 applied=恰一次、skipped/not-required=零次，
    `skipped-by-operator`不伪造 safety bytes且仍可 exact roll-forward。
68. absent target全绿：live DB present/absent × live Skills present/absent与 config
    preserve/no-replace/replace完整矩阵，clean app-home cold/pending E2E通过。prepared、
    no-replace syscall、receipt、cleanup checkpoint逐点 kill后不创建 placeholder/假 displaced
    identity，不删除 foreign replacement；empty incoming Skills发布真实 sealed empty tree。
69. immutable publication lineage全绿：artifact prepared/exchanged/cleanup与SQLite七个 checkpoint
    每一 revision都落独立 canonical frame；外层 marker仍引用旧 anchor时，restart能验真旧 frame
    并唯一走到最新 descendant。逐 checkpoint在 inner fsync后、outer marker更新前真 kill，
    restart不报 foreign；missing revision、fork、previous digest漂移、old frame覆写及跨 root
    descendant均在 descriptor/DB/FS effect前进入 typed repair。
70. purpose-specific publication projection全绿：prepared receipt不能证明 exchanged，
    alternate同 role/operation receipt不能替换 marker exact ref；phase/mode/staged digest、
    staged/published/displaced identity任一替换都失败。同 receipt id跨 role或重复 revision被拒；
    safety五类 capture只接受 no-replace cleanup-verified exact copy，barrier只接受 exact exchanged，
    cleanup只接受其连续 descendant。所有负例在实际 cleanup/DB open前触发。
71. lossless repair全绿：artifact在 prepared/exchanged/cleanup-verified分别转 repair，SQLite在
    declared到db-published每个 prefix转 repair；round trip后已知 ref、identity、sidecar
    `intentRevision`、fsync fence与cleanup timestamp逐字段不变。null/drop/rewrite任一字段、
    非连续 previous digest、从 repair继续推进均 fail closed；kill/restart后 forensic可完整呈现给
    operator。
72. legacy options authority全绿：released marker boolean缺省按旧 codec一次性 canonical化后，
    adoption进入 operator确认即固定完整 options/digest；reapply request/receipt/control/new
    operation每个 checkpoint逐字段相等。response loss/restart后相同 request exact replay；
    changed `noMigrate/noSafetyBackup/skipIntegrityCheck`、missing options、digest mismatch及以默认值
    补空全部在 seal/DB open前 conflict。quarantine不需要也不产生伪 options。
73. Intent session执行视图全绿：OpenCode与Claude的 parent text/reasoning/tool/error及至少一层
    child/subagent fixture经 `runSystemAgent` sink写入 `intent_turn_events`，owner endpoint用同一
    `parseSessionTree`返回 strict `SessionViewResponseSchema`，DOM继续由
    `ConversationFlow/SubagentBlock`渲染。running期间WS节流 invalidate、断线 polling、刷新与
    terminal refetch均不重排/重复 event；最新 running默认展开、历史折叠，键盘可操作，390px无
    overflow。foreign session/turn、audit mutation、malformed payload、row/byte cap与 capture
    failure分别同形404/fail-closed/truncated/incomplete；capture失败不改变 Intent业务结果，
    private store在 post-run capture完成或明确标记 incomplete后才 cleanup，raw payload不进入WS。

## 7. 风险与取舍

- 双栏会让复杂 Workflow 预览在中等宽度变窄：以 1080px 内容断点回落单栏，禁止为了坚持
  双栏把 canvas 压到不可用宽度。
- 阶段轨来自多个现有字段：必须先写唯一纯函数和优先级矩阵，组件不得各自猜状态。
- Intent执行过程复用会把 task-only IO外壳与真正通用 renderer拆开：共享边界只到 strict
  `SessionViewResponse`与 conversation panel；attempt picker、node status、inventory仍归 task。
  event capture采用按 turn有界持久化，超限显示明确 truncated，不得为“完整日志”牺牲 daemon
  内存/数据库上限，也不得因观测失败推翻已完成的 Intent业务结果。
- Inline 与 Dialog 共用组件容易出现 mutation/state 双实例：两种形态不会同时可交互；
  search 驱动的 Dialog 开闭与 inline state 各自隔离，创建请求通过同一 hook/build 函数。
- 示例文案可能被误认为模板生成器：明确其只是填充自然语言文本，点击绝不发请求。
- sticky action 容易遮挡移动端内容：sticky 仅桌面 review rail 启用；移动端恢复 normal flow，
  并纳入 390×568 touch + 已聚焦 Dialog动态缩高的虚拟键盘近似测试。
- commit wizard 不能改变后端必填语义：secret 必填、credential finding 的 waiver 必须显式
  确认；humanBinding/finalName 继续 optional，不自行升级。
- mount approvals 由逐项副作用升级成 source-bound 原子 transaction，实施面更大；作为交换，
  UI 不再承担无法证明的部分成功猜测。HTTP/detail共用 strict source-order receipt，迟到答案/
  审批和 response loss 只按 exact identity与 `resultingTurnSeq` 收敛。
- `draft.stale` 与 commit 的 `intent-baseline-stale` 名字相近但恢复动作不同：前者直接生成
  新版，后者先 rebase 再生成；必须按 server code 分型，不做一个含糊的 Rebase 按钮。
- `clientMutationId` 不能分散在 session/turn/journal 各自 namespace：统一 ledger 是唯一
  replay authority；turn/journal 字段只作 anchor/projection。无 receipt 的
  rebase/cancel/manual mount 仍只描述目标状态，不把另一标签页产生的 marker 说成本次 request
  成功。
- commit request fingerprint 需要覆盖 secret，但 raw secret/普通 hash 都不能落库：复用现有
  host `secret.key` 做 domain-separated HMAC；异机恢复丢 key 时 POST replay 明确 fail closed，
  journal/detail 的只读 reconcile 仍可用。
- dispatcher 的周期收口不能把合法长模型调用当 orphan：只有 queued 未 claim，或 DB claim
  在当前 daemon 的 live-owner registry 中不存在并超过 grace 的 exact running turn才可处理；
  live owner 继续由 runtime timeout/cancel 收口。
- dispatcher 不能把 HTTP route closure 当执行身份：run-as user/policy 与 reservation 同时
  持久化，claim/dump 重新读取 current owner，普通 owner 永不 fallback 到 system。该策略明确
  采用执行时权限；credential revocation 与 user/role/ACL revocation 的语义不能混为一谈。
- apply preflight 也不能把 HTTP route actor冻结成最终权限：journal run-as只保存 owner/policy，
  final transaction按 current user重建 actor并重新分类 copy-only；authorization fence变化必须
  要求重新复核，不能利用 resource-admin bypass或静默改成 copy。
- 两阶段 disclosure 会把一次 dump 的 DB token读取做两遍；这是把异步文件构造移出 transaction
  的代价。final admission比较完整 visible-set/token digest，宁可因任何前置变化丢弃 seed并要求
  retry，也不能把撤权前缓存交给模型。
- ledger-before-freshness 不等于 source-before-authorization：source-bound endpoint先做
  immutable owner-scope 404 gate，再读取私有 source并计算 HMAC；该 gate不检查可变状态，因此
  不破坏已推进/归档后的 owner exact replay。
- HMAC 不能补救“签名对象”和“执行对象”分叉：normalizer 返回值必须是唯一 service 输入。
  对会影响 handle 的 create mounts 保序，对真正集合语义先拒绝 duplicate 再排序；secret/human/
  waiver value 不 trim、不 hash 落库，避免两个不同副作用共享一枚 fingerprint。
- apply 的 failed 也不能替代“artifact已清理”证明：Plugin/Skill identity必须先于任何外部
  side effect持久化，cleanup失败继续保留 durable unsettled state与 exact claim。legacy
  `pluginId`没有 generation authority，宁可进入 repair-required并等待安全证明，也不能按
  plugin目录猜删或向 UI 宣称 all-or-nothing 已收口。
- PGID不是 npm lifecycle 的不可逃逸所有权边界：Linux必须由 private PID namespace anchor证明
  namespace empty。Darwin当前没有同等可恢复 process-set primitive；npm/git Intent apply宁可在
  receipt/文件动作前显示明确 capability error，也不以已被 SDK标为 unsupported的
  `NOTE_TRACK`、轮询后代或禁 lifecycle假装 parity。
- kernel set empty也不能让 shared HMAC key变成清理授权：每个 supervisor在进入 non-dumpable、
  no-core状态后自生成一次性 Ed25519 key，journal只持久化 public key；新 daemon验签而不恢复
  private material。若 process identity、signature或 release binding任一不可证，保持
  repair-required。
- `lstat`后再传字符串路径仍有 TOCTOU，具名 temp也有 hardlink race：host writer只能用 root
  dirfd派生的 V3 capability做 descriptor-relative syscall；Linux先写 anonymous `O_TMPFILE`，
  Darwin staging只对 trusted broker可见并检查 unique inode；traversal拒绝 mount crossing。
  whole-tree restore、migration与 safety snapshot没有裸路径豁免。该安全单元会扩大到通用
  Plugin/Skill writer与启动恢复，但这是兑现“外部 sentinel零写”的必要成本。
- “同 UID任意进程”若已能直接改 DB/app-home/executable，就能绕过应用内所有 receipt，本 RFC
  不伪造对 host compromise的隔离。支持边界要求 untrusted agent/package child进入声明的 OS
  containment；同时仍以 non-dumpable、sealed control和 adversarial qualification保护 proof
  signer免受无 app-state authority的 sibling探测。
- 零状态 validation不能同时承诺永久记住旧 id：definitive 422被客户端看见时丢弃 id；响应丢失
  后若环境恢复，原 frozen id可能首次被接受。at-most-once从 durable ledger claim开始，而不是
  伪造 rejection tombstone；但 ledger已存在的 exact replay必须先于当前 capability，不能把
  accepted结果倒退成422。
- Darwin安全拒绝若只在 Review出现，会把 Plugin ChoiceCard变成死路；capability必须在
  Composer和模型 seed前置。代价是六类 schema parity不等于每个平台的 apply parity，UI需诚实
  展示当前 host支持矩阵。
- prompt prose和 strict schema各自维护会再次漂移：versioned shared model contract、六类可执行
  examples与 resolver/validator golden作为唯一发布门；artifact hint也必须有 session→INTENT.md
  backend/E2E证据，不能只测 POST payload。
- descriptor API若只覆盖 regular file，source guard会让 managed Skill目录发布无路可走；
  sealed tree、双 entry exchange receipt与 crash phase必须作为 public contract一次落地，不能让
  实现临时发明第三套 rename helper。
- DB restore不能成为删除 Plugin writer proof的手段：public key虽非 secret，仍是收口 obligation
  的唯一 verifier。独立 broker ledger会增加一个需要严格迁移/doctor的持久面，但它必须故意不被
  backup回滚，才能在 restore交错中保住旧 generation义务。
- live `--stage`若让第二个 CLI broker直接进入 app-home，会破坏 singleton authority；local admin
  control socket只传 archive fd与严格 receipt，root capability永不离开 daemon。peer credential
  属于本机 break-glass边界，不替代应用内 admin HTTP权限。
- `file:` host path不能作为 untrusted model可编辑字符串。opaque mounted handle会牺牲“让模型
  随意换本机路径”的灵活性，但这正是 actor明确选择 source与模型建议之间必须保留的权限边界。
- config与Skill若共用 tree slot，会把当前 `config.json`的 regular-file ABI隐式改成目录；restore
  必须用 file/tree两套 publication primitive，并把「archive没有 config」显式建模为 preserve，
  不能用空 tree或缺 entry猜测。
- backup若只被 source guard禁止裸写、却没有自身可 mint operation/slot，会使定时与迁移安全路径
  无法实现。独立高层 authority扩大 broker API，但把 SQLite snapshot、packer与 retention的
  authority限制在各自单一角色，避免用 restore/apply capability越权。
- cancel删除当前 marker后不能再靠 filesystem状态证明是哪次请求完成；non-restored control ledger
  会增长，但 v1选择无限保留低频 receipt来保证 restart后 exact replay。未设计可证明的 compaction
  前不做按时长 GC。
- pre-create Composer不能消费只能在 session transaction内产生的 handle。短寿命 grant只承担
  UI admission与 create请求绑定，不直接授予 filesystem read；最终 authority仍由 create
  transaction重验后产生的 session handle与 apply final fence持有。
- HTTP `File`若继续整体 `arrayBuffer()`再写 temp，会同时绕过 size/backpressure与 broker
  authority；v12改成 raw body streaming sink，route只传 trusted metadata与 stream。代价是同
  binary更新 Settings endpoint，但可以在读 body前完成 actor/id replay gate。
- durable control ledger本身不足以让人类 caller找回 id。Settings safe locator和 CLI
  pre-effect locator必须与服务端 receipt同批交付；locator只含重新查账所需身份，不含本地 path/
  filename/archive内容，并始终由服务端 actor/peer scope重新授权。
- 旧 pending marker没有 caller id，任何“补一枚 clientMutationId”都会伪造 exact replay。
  adoption只能保留“这是一项升级前已授权但 caller不可验证的 restore”事实；valid可继续 boot
  apply，invalid必须 typed quarantine/repair，不能同时声称原 caller可重放。
- 旧 backup没有 publication receipt，但不能因此永久绕过 retention。独立 adoption ledger会增加
  一次全量 digest/manifest扫描成本；扫描期间 entry保持 protected，只有 durable adoption后才可
  exact remove，避免把文件名/mtime当 authority。
- Git worktree不是普通目录。reconstruction adapter必须拥有 exact repo admin metadata与 target
  authority，不能把 `git worktree prune/add`藏在 extractor里。multi-repo选择 task级
  preflight/compensation，代价是任一 repo不可恢复时整 task skip，但不会产生看似可用的半工作区。
- read-only dry-run若仍在 CLI里直接 `planRestore(path)`，daemon live时就绕开了新 ingress；
  若简单拿 stage capability又会产生错误的 pending side effect。独立 inspect union/service让
  live/stopped共享解析合同，代价是 local-control多一个 operation，但可把“零持久写”做成类型与
  negative source guard。
- actor切换时自动清 locator看似整洁，却会永久丢失 A 的唯一 client mutation key。按 actor prefix
  保留会留下少量低敏本机元数据；显式清除警告与 server-side重新授权把隐私和可恢复性边界说清。
- released legacy marker里的 `stagedTarball`是绝对路径，但它只能解释历史意图，不能成为新
  authority。把 marker-only视为已消费是为保持当前 boot idempotency；它不能证明 restore成功，
  因此只记 consumed-without-caller-receipt，不生成成功 receipt。archive-only则从未 marker-last
  arm，宁可 quarantine也不擅自 apply。marker+archive同样不能证明“尚未 apply”：released
  post-swap failure在 quarantine前留下完全相同 bytes。v14让合法旧 pending也多一次 operator确认，
  以换取升级时绝不自动重放可能已经部分执行的 restore。
- multi-repo task parent在恢复时可能完全不存在；只有 target descriptor而无创建 authority会让
  happy path不可实现。canonical mkdir后再补 ledger仍会留下无 ownership凭据的 crash窗口；v14
  使用 broker-private preparation + no-replace publication，会增加 declaration/private/publishing/
  receipt fsync与孤儿清理成本，但确保每个 canonical operation-created directory在出现前已有
  durable intent，并能区分 existing与 operation-created parent/leaf。
- Git add的返回值若先于 ledger持久化，单靠 completed index无法判断 registration、target与
  branch/ref分别处于哪一步。per-repo discriminated ledger增加数据量，但把 crash ambiguity限定为
  唯一 exact discovery或 repair-required，并给逆序 compensation足够的 identity与 CAS fence。
- legacy hold/quarantine若只在 rename后记 target，响应丢失会让 source absent却没有目标
  authority。v15用 pre-effect move publication增加一次 durable intent/fsync，换取 source/target
  双槽闭集恢复且不从名称猜 ownership。
- directory/Git补偿若把“从未创建/从未注册”硬塞进 removed/registered，会迫使实现伪造 identity。
  v15以 `closed-absent`与 `effect:'none'`增加终态分支，并禁止 single-existing alias；schema更宽但
  每个分支的证据更窄、更可验证。
- move discovery若不看 phase，`cleaning`删除后的合法 neither会被当成 rename丢 authority。v16把
  pre-move与post-cleanup absence proof分型，并以 moved identity + target-parent re-fsync把
  `cleaning` roll forward；这不会放宽 `moving|moved`的 neither。
- optional worktree的 Git命令不是零/完整二值：shared infrastructure retention、stale registration
  cleanup和 branch/admin/registration partial effect都必须有 terminal algebra。v16增加一次
  bounded inventory与若干 checkpoint，换取真实 skipped receipt；foreign/unbounded delta仍
  repair，不以 broad prune猜清理。
- discriminated union只锁字段形状，不会自动证明两个嵌套 identity相同。v16把 canonical comparator
  与所有 cross-field equality列成 strict schema合同并加入逐字段替换负测，避免 producer/consumer
  对同一 durable row得出不同结论。
- public receipt与 durable identity虽然都用 Zod，但不能共享或手工搬运 transform。v17以两个独立
  input/output type assertion、唯一 identity encoder/decode与跨 journey response-loss fixture换取
  可执行边界；这样也避免 JSON decimal在 `number`中静默丢失精度。
- leaf encoder不能自动形成 durable root的反向 codec。v18为每个 checkpoint root增加显式
  wire/decoded pair与穷举 encoder，会增加 branch mapper和 fixture数量；代价换来 writer编译期
  完整性、canonical durable bytes与 crash后可重建的 authority evidence。通用 bigint replacer虽短，
  却会把新增字段静默序列化而绕过 root schema，因此明确禁止。
- secret-bearing request 绕开 MutationCache 会失去 `useMutation` 的现成状态机：用 feature hook
  内的 reducer/ref 明确实现状态，并以 cache/storage/log negative tests 与 navigation guard
  换取可证明的 secret 生命周期。
