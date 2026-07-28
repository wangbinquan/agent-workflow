# RFC-234 意图驱动的资源构建 — plan

状态：Draft（2026-07-28）。任务编号 `RFC-234-T*`；依赖图见各条 "依赖"。

## 任务分解

- **T1 shared 契约与序列化器**（依赖：无）
  `intentChangeset` zod（互斥端口、句柄/tempRef 语法、skill files 白名单、§3.2
  尺寸不变量）；`intentSecretSlots.ts` 闭集投影表（argv/URL/spec/options 逐载体）
  + 凭据模式扫描器；`agent-md-serialize.ts`（round-trip golden）；workgroup/mcp/
  plugin YAML serializer（输出句柄不输出 id）+ 脱敏/身份零泄漏锁测试。
  **交付记录（2026-07-28）**：已落 `schemas/intentChangeset.ts` +
  `intentSecretSlots.ts` + `agent-md-serialize.ts` + `intent-dump-serialize.ts` +
  3 测试文件（25 case；shared 全量 1469/0；测试期抓修 excerpt 泄密一处）。
  **ws channel builder 移入 T7**——`rfc152-ws-paths-interlock` 锁 WS_PATHS↔registry
  精确双射，条目必须与后端 registry 同 commit 落。
- **T2 runSystemAgent 公共原语 + intent-read-v1 profile**（依赖：无；与 T1 并行）
  抽取 distiller/smoke 共同序列为 `services/systemAgentRun.ts`；
  `SystemAgentSpawnContext.systemPermissionProfile` 冻结枚举（默认 all-deny 锁测）
  + `verifiedSystemPlan` 权限尾物化 + **RFC-224 行为资格套件扩项**（工具枚举/
  symlink 实测）；"profile 含 bash/write ⇒ 构建期抛错"守卫；app-home scratch +
  GC 钩子；distiller+smoke 全套件回归绿为验收线。
  **交付记录（2026-07-28）**：`SYSTEM_PERMISSION_PROFILES` 冻结枚举（types.ts）+
  `SYSTEM_READ_ONLY_TOOLS` 闭集与权限尾同序翻转（hermetic.ts，键序零变化锁测）+
  verifiedSystemPlan profile 物化（未知值 identity failure）+ claude driver
  fail-closed + `services/systemAgentRun.ts` 原语（scratch 生命周期/seed 注入/
  逃逸拒绝/TERM→KILL→reap 屏障/成功删除失败保留/诊断脱敏）。测试
  `rfc234-system-permission-profile`（5）+`rfc234-system-agent-run`（7）全绿；
  RFC-224 hermetic/verified-plan 36 例、distiller/smoke 60 例回归绿；tsc 干净。
  **遗留（RFC 收口前完成）**：①distiller/smoke 改薄适配层的去重重构未做——原语
  已独立成型且行为锁定，两调用方现仍走自有代码（套件绿）；②RFC-224 资格套件的
  intent-read-v1 真实实测扩项随 T13 真实 runtime 资格测试一并落。
- **T3 数据模型 migration**（依赖：无）
  `intent_sessions / intent_turns / intent_drafts / intent_apply_journal /
  intent_provenance` 五表 + journal bump；关键列：sessions.context_revision/
  context_manifest_json/current_draft_id、turns.envelope_nonce/context_revision、
  drafts.draft_hash、journal UNIQUE(session_id, client_mutation_id)；索引：
  sessions.owner、turns.(session,seq)、drafts.(session,revision)、
  provenance.(resource_type,resource_id)。
  **交付记录（2026-07-28）**：schema.ts 五表 + 手写 `0123_rfc234_intent_builder.sql`
  （本仓 meta 快照止于 0012，drizzle-kit generate 不可用——沿手写惯例）+ journal
  合成轴 +86400000 追加 idx 122 + `upgrade-rolling` count 锁 122→123；套件 6/6 绿
  （全链含 0123 实际执行）；tsc 干净。
- **T4 dump 构建器**（依赖：T1）
  inventory 摘要（六类、句柄、>500 截断显式标注）；挂载闭包 BFS + ACL 过滤 +
  hidden 占位 + **闭包逐资源 fence/dumpHash 入 manifest**；INTENT.md 组装
  （§1.3 确定性压缩 golden/协议块/fenceUntrusted 消毒）；脱敏与身份隔离双层锁。
  **交付记录（2026-07-28）**：`services/intent/manifest.ts`（句柄分配器/六型围栏
  /detail-vs-summary 条目——inventory 行也持句柄可被引用但无围栏、update 目标须
  detail）+ `services/intent/dumpBuilder.ts`（六类可见清单+显式截断、闭包 BFS+
  ACL 过滤+hidden 计数不泄名、agentId→agentRef 句柄化、skill 快照树 dump+token
  围栏、跨 epoch 句柄稳定）。`rfc234-dump-builder` 6 case 绿（毒化夹具锁身份/
  密钥零泄漏）；lint 0 warning / tsc 干净。**INTENT.md 组装（历史压缩+协议块+
  fenceUntrusted）依赖会话历史，移入 T5 上下文组装一并落**。
- **T5 turn 引擎 + 设置**（依赖：T2/T3/T4）
  上下文组装→runSystemAgent→信封解析（summary/questions/changeset/requests 全
  分支；nonce 持久 turn 行）→context epoch CAS（晚到轮归档）→不可变 draft
  revision 铸造+校验报告；requests→待批准建议流；会话单飞、全局 Semaphore(2)、
  取消屏障、boot 孤儿轮回收；config 八键 + `routes/config.ts` 校验（含 runtime
  fail-closed）+ `RuntimeRefConfig` 删除引用检查。
  **交付记录（2026-07-28）**：config 八键（shared schema+patch null-delete）+
  `routes/config.ts` intent fail-closed（非 opencode protocol 保存期 422）+
  `RuntimeRefConfig.intentBuilderRuntime` 删除引用检查三件套；
  `services/intent/intentDoc.ts`（确定性压缩：近 8 轮逐字/更早一行/answers 永不
  压缩/截断显式标注/fenceUntrusted）+ `session.ts`（CRUD/挂载/rebase/epoch/
  admin-only 旁路）+ `turnEngine.ts`（nonce 同事务持久/manifest 围栏捕获/信封
  端口规则/不可变 draft+sha256/预算/单飞/取消/epoch CAS 晚到归档）+
  `maintenance.ts`（boot 恢复+scratch GC）+ `resolveChangeset.ts` receipt 级
  校验（句柄类型/detail 目标/tempRef 环/密钥哨兵/凭据扫描）。测试
  `rfc234-turn-engine`（9）+`rfc234-intent-doc`（4）；RFC-234 后端 31/31、
  shared 1469/0、config/runtime-registry 回归 51/51 绿；lint 0/tsc 干净。
  **遗留（随 T7 落）**：cli/start.ts 接线（boot recovery+每小时 GC 注册+turn
  config 解析器）；设置 UI 卡片随 T12。
- **T6 apply 管线**（依赖：T1/T3；六类 service in-tx 内核抽取含在本任务）
  journal claim（clientMutationId 幂等）→preflight（copy 规范化为 create 全量
  复验、draftHash/epoch/fence 三层围栏）→插件预装(先记后装+补偿)→skill 预
  stage(补偿)→槽位签发/覆盖重物化全量复验→单 dbTxSync（拓扑执行、opId 锚定
  重接线、unique 兜底、provenance、journal committed+receipt）→roll-forward
  发布→广播；boot 收敛路径；actor 贯穿；raw-SQL 源码锁。
  **实施设计定案（2026-07-28 推导，agent.ts 源码已核）**：
  ①每类 service 做 **prepare/commit 两段式抽取**——`prepareXxxCreate(db,…)→
  Prepared`（现函数 pre-tx async 校验段，agent 例=agent.ts:93-202）与
  `commitXxxCreateInTx(tx, prepared)`（现 dbTxSync 体，agent 例=:204-252）；
  原 createXxx/updateXxx 改为 prepare→dbTxSync(commit) 薄组合，**外壳行为字节
  不变、既有套件锁**；update 同型（:279-437 / :438-472）。
  ②**bundle 内 tempRef 依赖**：preflight 对存在性校验器
  （validateDependsOn/validateMcpReferences/validatePluginReferences）加
  `pendingBundleIds` 跳过集参（bundle 新建 id 预铸 ulid；类型正确性由 receipt
  校验保证）；`assertAgentResourceIntegrity` 走既有 `overrides` 参数注入
  bundle 候选。③大事务内**按拓扑序执行 commit 内核**——SQLite 同连接可见未提交
  行，`assertRefsUsableInTx` 对 bundle 内先建资源自然通过，零改动。
  ④插件 create 的 npm install 段拆出为 pipeline 预装阶段（先记 journal 后装、
  失败逆序清理本次产物）。⑤skill 复用 `createManagedSkillWithFiles` 的
  reserve→produceFiles→commitSkillVersion 前段为预 stage，**ready 翻转抽为
  in-tx 内核**并入大事务，live 树发布为 tx 后幂等 roll-forward（实施时再核
  services/skillVersion.ts:563-655 的事务边界）。⑥workflow/workgroup 全文档
  保存内核带 expectedVersion 围栏，broadcast 延迟到 tx 后统一发。
  **进展（2026-07-28）**：①的 **agent 服务两段式已落**——`prepareAgentCreate/
  commitAgentCreateInTx/prepareAgentUpdate/commitAgentUpdateInTx`（外壳组合行为
  不变；agent+rfc223+rfc228 定向 72/72 绿、lint 0、tsc 干净）。
  **全量套件三红归因与闭环（2026-07-28）**：7543 test 中 3 fail 全为守卫棘轮咬住
  本 RFC 新增，逐一修复——①`rfc224-source-reachability` seam 文件精确清单 +
  `services/systemAgentRun.ts`（合法 seam 消费者，同 runtimeSmoke 类，注释注明
  生产不设标志）；②`route-error-code-coverage` 要求新 code 有命名测试 → 新增
  `rfc234-config-intent-runtime.test.ts` 真实行为测试（claude-code 选择 422
  `intent-runtime-unsupported` + 零持久化 + null 清除回继承）并 git add 入
  tracked 域；③`rfc222 G-1` isAdminActor 单源守卫 → resourceAcl.ts 新增专名
  `canAuditIntentSessions`（内部即 isAdminActor，注明 manager 无旁路语义），
  session.ts 改走该助手。三守卫复跑全绿。
  **六服务内核里程碑（2026-07-28 续）**：mcp（create 两段+update 核带 configHash
  围栏）、plugin（create insert 核+publish 核；installer/cleanup 本已分离）、
  workflow（insertWorkflowInTx 导出+save 两段）、workgroup（create+save 两段）、
  skill（`stageManagedSkill` 预 stage + `commitSkillReadyInTx` 大事务翻转 +
  `compensateManagedSkillStage`；**update 定案=preflight 持 version-write op 锁
  →大事务后 roll-forward 版本提交**，不拆 commitSkillVersion——RFC-170 2PC 原样）。
  回归：agent 72/mcp 48/plugin 34/workflow 41/workgroup 154/skill 80 全绿；
  rfc231 写点清单守卫扩项（skill.ts 2 写点，注释注明同盖 private ACL）。
  **解析层里程碑（2026-07-28 续②）**：`deriveIntentSlots`（secret/humanBinding/
  finalName/secretWaiver 四类服务端签发槽位，确定性 slotId）+
  `resolveIntentBundle`（未签发槽位 422、哨兵必填、凭据 finding 必显式豁免、
  copy 规范化为 create + bundle 级重接线、人类占位绑定或丢弃、名称冲突预检+
  finalName 改名、skills→mcps→plugins→agents(dependsOn 拓扑)→wf/wg 排序、
  agent 内环检测）。`rfc234-resolve-bundle` 4 case 全绿；tsc/lint 0。
  **applyChangeset 编排器交付（2026-07-28 续③）**：`applyChangeset.ts`——claim
  单事务（draftHash+epoch+无 in-flight+UNIQUE(session,clientMutationId) 台账
  claim，重复请求零副作用回放 receipt/failed）→preflight（resolveIntentBundle+
  六类 prepare* 内核，pendingBundleIds 三校验器跳过集+prepareAgentMembers
  pending 名回退+integrity pending 时按构造覆盖跳过〔注释注明〕）→prestage（
  插件 install/skill stage 先记 journal 后做）→大事务（prepared→applying CAS→
  拓扑逐核提交→provenance→session epoch 关闭〔contextRevision+1+清 current〕→
  committed+receipt）→roll-forward（skill finishOperation+created 广播，逐项
  容错）→`convergeIntentApplyJournal`（prepared/applying→补偿→failed；
  committed→幂等重放）。会话级 in-process 互斥。**测试期抓修真 bug 一处**：
  post-commit 阶段异常曾误走补偿+failed 覆盖 durable committed——现 committed
  后异常只告警重抛、由收敛补尾。`rfc234-apply-changeset` 6 case（happy 六类
  bundle 接线/provenance/epoch、幂等回放、stale fence 整包零落库+skill 补偿、
  in-tx 崩溃全回滚、post-commit 崩溃收敛重放、claim 前拒绝零台账）全绿；
  RFC-234 八套件 43/43、tsc/lint 0。
  **v1 op 覆盖边界（plan 记录）**：六类 create + agent/mcp/workflow/workgroup
  update；**skill/plugin update 走 `intent-op-unsupported` 拒绝**（op-lock+
  staged-version roll-forward 后续段补齐后放开）；rename 经 finalName/copy，
  in-place rename 拒绝（intent-rename-unsupported）。
  **T6 终局（2026-07-28）**：全量基线 7529/25/1 的唯一红=RFC-223 T15 结构指纹
  守卫咬住 `occupiedNamesFor` 的 name 集合（collection-name-identity）——按守卫
  流程登记 reviewed allowance（reason=owner-uniqueness：仅命名预检，权威兜底为
  各类型 owner 域唯一索引在事务内）+ 指纹计数 95→96；守卫 8/8 复绿。T6 关闭
  （skill/plugin update 放开与 workflow-update fence 深矩阵随后续段）。
- **T7 路由 + WS + 权限**（依赖：T5/T6）
  `/api/intent-sessions` 全表（§6）；`/ws/intent-sessions` registry 条目；
  `intentSessions:read/write` 权限点；api-contract-coverage 登记；404 同形测试。
  **交付记录（2026-07-28）**：权限点定名 `intent:read/write`（全角色基线，
  permission 目录锁 34→36/23→25 同步）；shared `schemas/intentSession.ts` 全
  wire 契约；`routes/intentSessions.ts` 13 端点（create/list/detail〔turns+
  draft+服务端签发 slots+stale 派生+commits〕/messages/answers/mount-approvals
  〔批准制，P1-4〕/mounts±/rebase/cancel-turn/commit/archive/reopen）；
  `AppDeps.intentTestDependencies.runFn` 测试 seam；server mount；
  `resolveIntentTurnConfig`（launch 期二次 fail-closed）；cli/start.ts 接线
  （boot：孤儿轮回收+journal 收敛；每小时：scratch GC+收敛，retention 可配）；
  api-contract registry +13；`rfc234-intent-routes` 3 case（桩 runFn 全链
  create→draft+slots→commit→落库、陌生人+manager 404 同形+admin 只读审计+
  越权写 404、in-flight 409+intent-invalid/invalid-json 命名）。全守卫
  （错误码/契约/manager/WS 双射）32/0、RFC-234 九套件 46/46、tsc/lint 0。
  测试期抓修：execution policy 正确拒绝未配 model 的 runtime（测试补种，生产
  语义验证无误）。**WS 切片已落（2026-07-28 续④）**：shared `IntentSessionWsMessage`
  四帧型（ownerUserId 随帧）+ `WS_PATHS.intentSessions`；backend broadcaster
  channel + registry 三映射+条目（frameGate=creator ∨ canAuditIntentSessions，
  manager 无旁路）；路由/engine 发射接线（turn started/finished、
  session.updated×6 点、apply.committed）；`rfc152` 双射与穷举锁 8→9 双更新；
  RFC-054 路由 cast 守卫红→4 处 cast 全改 zod 解析闭环。WS 系套件 59/0、
  shared 1469/0、tsc/lint 0。**前端 useWsInvalidation hook 随 T8 页面落。**
- **T8 前端会话页骨架**（依赖：T7）
  `/intent` 列表 + `/intent/$sessionId` 时间线/composer/挂载面板/WS invalidation；
  问题单作答（QuestionForm 复用）；error 重试。
  **切片一交付（2026-07-28 续⑤）**：`hooks/useIntentSessionsWs`（invalidation
  规则表+apply.committed 联动六类资源列表失效）；`routes/intent.tsx`（列表+新建
  Dialog）；`routes/intent.detail.tsx`（时间线各 kind 卡/Segmented 问题单作答/
  挂载列表+卸载/草稿面板 v1〔op 卡+JSON 视图+阻断错误+stale 横幅〕/提交 Dialog
  〔四类槽位：finalName/secret password/waiver checkbox/humanBinding UserPicker
  single + update op 直改-副本 Segmented〕/历次提交回执卡/composer/重试/取消/
  rebase）；router+nav 注册；i18n intent 全节双语（interface+zh+en 三处）。
  后端随行小补：detail 响应加 `mounts`、新增 `POST /:id/retry`（契约 registry
  +1，rfc234 路由测试复绿 9/0）。前端 tsc/lint 全绿。
  **前端棘轮四连闭环（2026-07-28 续⑥）**：①nav 图标锁——入口按设计移正到
  workflows 组（初版误锚 tasks 组，nav.test 抓出后修正）；②inline
  common.loading 禁令——两页改用 LoadingState 默认文案；③route-ux-inventory
  ——两路由登记，owners=新增真实渲染测试 `intent-list-inline`（2 case：状态
  chip/创建 POST+导航+按钮门控）与 `intent-detail-inline`（3 case：反问
  Segmented 作答 POST〔调试发现 Field label 抢占 radio 可及名，按文本点击〕/
  阻断错误与 stale 双双禁提交/干净草稿经服务端槽位提交——draftHash+decisions
  全字段断言）；④overlay-ux-inventory——两 Dialog 以 workflow-authoring 族
  登记。定向 5+3+6+11 全绿；**前端全量基线 5306/5306 零红**。
  **T11/T12 切片（2026-07-28 续⑦）**：System Agents「意图构建」设置卡
  （RuntimeSelect/语言 Select〔null=删键回默认〕/超时与轮数 NumberInput/追加
  指令 TextArea + settings-drafts allowlist 八键 + i18n 13 键×3）；
  `IntentEntryButton` 公共组件 + `/intent` search 预填机制（create/hint/
  mountType/mountId，创建后自动挂载 best-effort）；接线：workflows/workgroups
  两 gallery「意图创建」（hint 预填）+ agents.detail extra 槽「意图修改」
  （mount 预填）。settings/nav/intent 定向 26/26、tsc/lint 0。
  **T8-T12 收口（2026-07-28 续⑧）**：
  - 入口全铺：agents/skills/mcps/plugins detail `extra` 槽 + workgroups.detail
    actions 槽 + workflows.edit headerActions 均挂 `IntentEntryButton`
    (modify, mount 预填) — 六资源面全通。
  - **Provenance（AC-11）**：`GET /api/intent-provenance/:resourceType/:resourceId`
    （`listIntentProvenanceForActor`：资源 ACL 预检 + 会话可见者过滤 admin/owner，
    一律 200 `[]` 同形——不确认资源存在也不泄他人意图活动；shared
    `IntentProvenanceEntrySchema`；contracts/registry +1；rfc234-intent-routes
    新 test 锁 owner 可见/stranger+manager 空/admin 审计/未知 id 空/坏类型 422）；
    前端 `IntentProvenanceBadge`（rows 空→不渲染，点击跳源会话）挂六面。
  - **挂载 picker**：`IntentMountDialog`（Segmented 六类 + 共享 ResourcePicker，
    逐个 POST /mounts；mounts 区常显 + 添加按钮）；overlay-ux-inventory +1。
  - **T9 四类富预览**：`intent/IntentOpPreview.tsx` — workflow 画布
    （`intent-preview` surface 加入 union；agentRef→agentName 映射 + 本地
    schema 校验失败降级文案；update 且目标已挂载→Before/After Segmented +
    逐节点 promptTemplate word-diff）/ workgroup 结构（成员+组长+人类占位 chips、
    $new 经 bundleNames 解析）/ skill 文件树（字节数 + 脚本后缀警示徽记 +
    可展开内容 + bodyMd block-diff）/ agent 字段 chips + bodyMd word-diff
    （update 拉取在线 before）；op 级校验错误内联；raw JSON `<details>` 保留。
  - 测试：intent-entry-badge(2)、intent-detail-inline +mount-dialog(4)、
    intent-op-preview(4，抓到 malformed nodes 降级 bug)、settings-drafts 守卫
    键清单 +8（上轮全量唯一红，honest ratchet）。tsc×3/lint 0。
  **T8-T12 全部交付完毕**；仍余 T13（e2e+盲区矩阵）/ T14（门禁+提交+实现门）。
  **T13 交付（2026-07-28 续⑨）**：
  - **e2e 3/3 绿**（`e2e/intent-builder.spec.ts` + `stub-opencode-intent.sh`）：
    US-1 全链（创建→系统代理轮→画好草稿富预览→提交→资源落地→provenance
    badge 跳回会话）、US-6 修改入口预挂载（`res#agent#1` 出现在 mounts 区）、
    a11y wcag2a/2aa critical+serious 零 + 390×844 dark 渲染；各测试自足
    （API 直建 target/会话，无跨测试耦合）。
  - **两个真产品 bug 由 e2e 逼出并修正**：
    ① 系统代理 spawn 在 e2e 构建里无 legacy 出口（verified 计划对 shell 桩必
    败 auth）→ 给 `SystemAgentSpawnContext` 补 `opencodeCmd` **烙印命令 seam**
    （与业务路径 `usesLegacyTestOpencodePath` 同款：生产 brand→verified 不变；
    unit/e2e 未 brand→legacy）；turnEngine 每轮 `markProductionOpencodeCommand`；
    rfc234-system-agent-run 新增 branded→identity-failed / unbranded→ok 双断言。
    ② 修改入口的挂载 prefill 在创建后 POST，必撞自动首轮的
    `intent-turn-in-flight` 409 且首轮本就该带着目标跑 → `CreateIntentSessionSchema`
    增 `mounts[]`（≤16），`createIntentSession` 转 async 在**首轮前**做 ACL 预检
    （不可见→create 404 同形）+ 直建 manifest roots；前端随 create 传参，
    删 best-effort 后补 POST。routes 新 test 锁 create-with-mounts（轮后
    detail:true）+ 不可见 404。
  - **P2-2 盲区矩阵收口**：五断点崩溃全覆盖（新增 afterPluginInstall/
    afterSkillStage/beforeTx ×〔failed+零可见+补偿+**failed-replay 幂等**〕；
    inTx/postCommit 既有）；manager `?all=1` 无旁路（own-only vs admin 全量
    +ownerUserId）；注入演练（`requests` 端口→turn 内容 mountRequests 建议、
    manifest 零变化）；**真机资格**入 identity-preflight 套件（零 LLM 花费：
    intent-read-v1 controlled config 经真实 opencode 1.18.4 同实例 attest 逐字
    通过 + agent 级 permission read/grep/glob=allow、edit/write/bash/webfetch=
    deny 显式断言；本机实跑 1 pass）。copy-ACL 深案未单列新测试——由组合锁
    覆盖：未知句柄→turn 校验错误（turn-engine 既有）、fence 复验（apply stale
    既有）、prepare* `assertRefsUsableInTx`（RFC-231 服务级套件既有）。
  - 门禁进行中：backend/frontend 全量后台跑；shared 1469/0 已绿。
  **用户 UI 反馈三连修（2026-07-28 续⑩，用户实时评审）**：
  ① 产物类型自由文本 → 共享 `Select` 下拉（「自动判断」+ 六类；值仍走
  `hint` 字符串，`auto`→空串）；② `IntentEntryButton` 默认尺寸由 `btn--sm`
  改为页级 `.btn`（gallery/detail/actions 邻居全是 md），仅 workflows.edit
  工具栏显式 `size="sm"` 对齐其 btn--sm 邻居；③ 意图修改入口**不再询问产物
  类型**——挂载目标即修改对象，对话框改显示「修改目标：{{type}}」note
  （`intent-modify-target`）。i18n +2 键（hintAuto/modifyTargetNote）×3；
  intent-list-inline 新增第 3 测锁「创建显示下拉、修改隐藏之且 mounts 随
  create POST」（test 路由复用真 `validateSearch` 以还原 `?create=true`
  coercion）。
  **真机 live 功能验证（2026-07-28 续⑪，用户指令「自己创建几个意图构建任务测试」）**：
  生产二进制 + 真 opencode 1.18.4 + deepseek-chat，三场景脚本（A 创建审计代理 /
  B 双代理评审工作流 / C 挂载修改），五轮迭代逼出并修复**四个真产品缺陷**：
  - ①协议尾自相矛盾：四端口全喂共享 protocol block（其语义=全部列出+四端口
    合并示例）→ 模型必然双端口 → `intent-ports-exclusive`。修：主线块只渲染
    summary+changeset，互斥规则+questions/requests 替代形态显式文字紧随；
    turn-engine 新增 prompt 形状锁。
  - ②校验错误对模型不可读：12 分支平 union 在 zod v3 坍缩为 `ops.0: Invalid
    input`，自纠循环失效。修：shared `formatChangesetIssues` 递归展开取最少
    issue 分支 → 字段级 path（上限 12）；shared 回归锁。
  - ③payload 字段无 spec：模型编造 systemPrompt/outputPorts/handle 等键、
    display 式 name、嵌套 ops。修：INTENT.md 新增「Payload schemas (STRICT)」
    节（六类字段谱 + 通用规则 + worked example + kind 语法清单 + 输出预算
    指引）。
  - ④canonical 拒绝逃逸为 500：inputs[].kind 自由串过 intent 校验、在
    prepareAgentCreate 撞 RFC-060 kind 语法抛裸 ZodError。修：shared 源头
    `AgentOutputKindSchema` 前置到 inputs[].kind/outputKinds（解析期可自纠）+
    apply 预检 ZodError→类型化 `intent-op-canonical-invalid`（含 op 定位与
    字段路径）；shared+backend 双回归锁。
  - 附带：JSON 截断（模型输出上限）hint 注入自纠错误；live 脚本走产品
    /retry 演练自纠。**结果 8/9 PASS**：A 全链绿（草稿 0 错→提交→落库
    outputs=[findings]→provenance 双向）;B 全链绿（coder+reviewer+workflow
    三 op bundle、tempRef 接线、落库）;C 挂载+自纠反馈工作正常，draft 卡
    deepseek-chat 8K 输出上限×update 整文档契约（模型侧限制，opencode
    transform.ts:1367 `min(model.limit.output, 32000)`；大输出模型复验中；
    「补丁式 update op」记为后续演进方向）。换 deepseek-reasoner（64K 输出）
    复验：**11/11 全 PASS**——C 亦全链贯通（update 精确 target res#agent#1、
    outputs=["findings","summary"] 保留+新增、真实行更新、provenance 记两次
    提交），确证 C 前次失败纯为模型输出上限而非链路缺陷。
  **Codex 实现门（2026-07-28，pin 094f0f2f 分离 worktree）**：NOT-CLEAN，
  1 P0 + 6 P1 + 5 P2，逐条裁决与落点：
  - **P0-1 跨所有者 MCP 越权写入**（intent update 绕过标准路由的
    `requireResourceOwner`）→ `copyOnlyTargetsFor`（DB 推导：他人/内置 owner、
    以及 skill/plugin 未实现原地更新的类型）+ `resolveIntentBundle` 单一
    choke point 强制 `applyMode:'copy'`，新错误码
    `intent-foreign-modify-forbidden`；锁：他人 agent modify 被拒且原行零改
    动、copy 落新资源 owner=操作者。
  - **P1-1 claim 后无 lease**（prestage 窗口可被 rebase/mount 抢跑）→ 最终
    事务内重新 CAS session（contextRevision/currentDraftId/inFlightTurnId）+
    `assertNoUnsettledApply` 挡住所有 session 变更与新轮次（
    `intent-apply-in-flight`）。
  - **P1-2 密钥闭集 IN 向缺口** → `findNonSentinelSecretCarriers` 扩为
    argv 凭据标志/URL userinfo/任意 secret-named 键（递归）+ 拒绝
    `‹redacted›` 回写；MCP update 保留既有 oauth（intent schema 无该字段、
    整体替换 config 会丢失）。
  - **P1-3 同 epoch 旧 revision 可提交** → claim 要求
    `session.currentDraftId === draft.id`（`intent-draft-superseded`）。
  - **P1-4 fence 声明与实际不符** → 会话标题与**全部** dump 文件（mounted+
    inventory）统一经 `fenceUntrusted(turn nonce)`；投毒回归锁断言攻击文本
    只存在于 fence 内。
  - **P1-5 finalName 绕过命名规范** → shared `validateFinalNameForType`
    按类型复验槽位值（`intent-slot-value-invalid`）。
  - **P1-6 / P2-3 / P2-2**：plugin generation 精确补偿、skill/plugin update
    2PC、mount 审批前端流记为后续演进；当前按 Codex 建议先做成 copy-only
    与 converger 安全化，避免静默失败。
  - **P2-1 converger 误杀活跃 apply** → 进程内 active-set + 10 分钟最小年龄。
  - **P2-4 admin retry/cancel 返回 422** → 统一 404 同形（并在测试里显式
    命名 route-local `intent-session-not-found` 以过 error-code 守卫）。
  修复后：backend 全量、shared 1472/0、frontend 5314/5314。
  **T14 门禁尾段两红如实闭环**：①rfc224-source-guard e2e stub 版本矩阵登记
  `stub-opencode-intent.sh: 'intent-build'`（守卫顺带校验其 --version echo 臂
  逐字）；②rfc212-revalidation-infrastructure 通道计数 8→9（intent-sessions
  的 revalidation 声明本体〔refreshActor+cache.none why+rerunUpgradeGate.na〕
  经同套件逐项检查通过，仅计数未随 rfc152 双射锁一起更新）。前端全量
  5314/5314（UI 反馈修正后）、e2e 二进制重建后 3/3 复绿。
  **待续（T8-T12 余量）**：四类富预览（canvas/工作组结构/skill 树/markdown
  diff）、六资源页+编辑器入口、provenance badge、System Agents 设置卡、
  挂载添加 picker、vitest 组件套件。
- **T9 前端草稿变更集面板**（依赖：T8）
  per-op 卡 + 字段 diff（review DiffView）+ 画布 `intent-preview` surface +
  工作组结构预览 + skill 文件树 DiffViewer + MarkdownDiffView + 脚本警示徽记 +
  校验错误内联。
- **T10 前端提交流**（依赖：T9）
  Dialog+Stepper 三步（直改/副本+改名 → 服务端签发槽位填写〔密钥/humanBinding/
  waiver〕 → 总览携 draftRevision+draftHash）；副本重接线预览；挂载申请批准
  chips；冲突横幅（baseline-stale / context-superseded 分型）+ rebase；草稿
  revision 历史与恢复；提交回执卡。
- **T11 入口与来源标注**（依赖：T8）
  nav / gallery headerActions / ResourceSplitPage 次要 action 槽 /
  DetailHeaderActions / workflow 编辑器工具栏（注释链接 RFC-199 推翻记录）；
  provenance badge；i18n 双语齐套。
- **T12 设置卡片**（依赖：T5）
  System Agents "意图构建"卡（runtime/语言/超时与上限/轮预算/追加指令）+
  settings-drafts allowlist + 前端测试。
- **T13 e2e + 盲区矩阵 + 收尾**（依赖：T7-T12）
  桩 runtime 的 Playwright 全链（US-1、US-6）+ 390px/dark/axe；**设计门 P2-2
  盲区**：五断点崩溃矩阵、clientMutationId 重放（含响应丢失）、双标签页旧
  draftHash、晚到轮 CAS、copy-ACL（US-2/US-3）、密钥闭集出入双向、最大合法
  payload golden、manager 边界、注入演练（诱导挂载/泄密）；`design/plan.md`
  索引与 `STATE.md` 状态翻转；docs 增补（若触及 dev-gotchas 通用坑）。
- **T14 门禁**（依赖：全部）
  typecheck×3 / lint(--max-warnings 0) / format:check / 全量测试 / depcheck /
  binary smoke / exact-SHA CI 核验 / Codex 实现门跑并修 findings。

## PR 拆分建议

默认单 RFC 单 PR（`feat(intent): RFC-234 意图驱动的资源构建`）。如体量需拆，按
三段依赖切且每段独立绿：

1. **PR-A 基座**：T1+T2+T3（纯新增 + 无行为变化重构；distiller/smoke 套件绿）。
2. **PR-B 后端**：T4+T5+T6+T7+T12 配置键（含设置后端）；e2e 前可用 API 级测试。
3. **PR-C 前端+e2e**：T8-T13。

## 验收清单（对照 proposal AC）

- [ ] AC-1 入口全（全局页/列表/详情/编辑器）
- [ ] AC-2 呈现四件套齐
- [ ] AC-3 反问闭环
- [ ] AC-4 all-or-nothing（含插件失败零落库）
- [ ] AC-5 直改/副本 + 自动重接线 + 他人/内置仅副本
- [ ] AC-6 OCC + rebase
- [ ] AC-7 隔离（containment admit / 无 Bash/MCP/网络 / 临时目录）
- [ ] AC-8 脱敏与身份双层锁
- [ ] AC-9 canonical service 落库 + raw-SQL 零出现 + owner/private
- [ ] AC-10 设置五项生效 + runtime 删除引用检查
- [ ] AC-11 留存回看 + 来源标注
- [ ] AC-12 全门禁绿 + e2e + i18n 对称
- [ ] AC-13 提交幂等 + 五断点崩溃收敛（journal）
- [ ] AC-14 draftHash/epoch 确认绑定 + 晚到轮归档 + 挂载申请批准制

## 风险登记

- **六类 service in-tx 内核抽取**（T6）是最大重构面——外壳行为不变靠既有全量套件
  锁；逐类小步提交。
- **intent-read-v1 权限 profile**是对 RFC-224 verified 面的显式扩展（冻结枚举 +
  权限尾物化 + 资格套件扩项），不是绕过；默认 all-deny 路径字节不变，
  qualification 套件复跑（CLAUDE.md 要求）。若资格实测发现只读白名单在目标
  opencode 直连 codec 下不可证明，fail-closed 回退方案=全量材料内联 INTENT.md
  （dump 降级为纯 prompt），需回到设计门复核。
- **journal 崩溃收敛**依赖插件安装器"可枚举本次调用产物"——实现期先审
  `pluginInstaller` 产物记账能力，不足则先补记账（设计门 P0-5 前提）。
- **画布 surface 新枚举**可能牵动编辑器守卫测试（RFC-199 文本锁）——推翻处显式
  改锁并注明本 RFC。
- 大变更集/大 dump 的 token 压力：尺寸不变量与确定性压缩已定（design §1.3/§3.2），
  首版保守，数值可由设置调。
