# RFC-257 设计门记档（2026-08-04）

- 评审路径：**全新上下文对抗子代理**（本机 Codex 处于 1.0.6×0.146.0 不可用组合，按 `docs/dev-gotchas.md` 止损姿势 + RFC-255 先例）。评审要求：逐条核对三件套全部 file:line 断言（实读源码）、攻击验签/竞态/ACL/模板注入面、找遗漏面与 plan 断链。
- 评审判定：**needs-changes**（2 P0 + 8 P1 + 10 P2）。
- 主 session 逐条核实结论：**20 条全部属实、零驳回**；其中 F-9(b) 促成一次**判断变更**（D19：ACL 第七类 → owner 制）。全部折入三件套 2026-08-04 版。
- 事实核对副产物：评审确认三件套引用的全部锚点语义准确（含 multica 五处）；两处行号漂移（ACL_TABLES 实际 `resourceAcl.ts:108-115`；`ExecutionInvoker` 联合在 `services/execution/types.ts` 而非 executor.ts:25-47——后者是 `depsForInvoker`），已在折入版随手修正；一处**语义性错误**独立成 F-7。评审另主动确认 `shared/lifecycle.ts` cancel 转移表原生含 awaiting_*（D21 零成本成立）、`registry.ts` gate 对零权限点+无 actor 放行（公开路由可达性成立）、SPA 兜底 GET-only、备份 VACUUM INTO 自动覆盖新表。

## Findings 与处置

### P0（设计不成立级，两条都是真实设计错误）

- **F-1 熔断计数结构性死亡**：首版把 `author ∉ ignoreUsernames` 同时用作命中条件与重置条件 ⇒ 能到闸门的事件必然先清零再 +1，计数封顶 1，`skipped-circuit-open` 不可达（AC-9 必红）；且旗舰场景 S3 两个方向都坏——bot 入名单则 bot push 引发的 pipeline_failed 不命中、循环第 2 轮即断；不入名单则无限循环。**处置**：D14 改为**作用域化名单**（只过滤 push/tag_push/mr_*/note 的命中；pipeline 类不做作者过滤），D22 重置判定与命中过滤解耦（pipeline 事件按作者∈/∉名单决定累加/清零）；S3、AC-6/AC-10、design §1.5/§4.1 全部改写。前提「pipeline `user` = 触发流水线的 push 者」列入 T3 必实证项。
- **F-2 streamKey 缺 repo 维度**：GitLab MR iid 是 per-project 序号，prefix 范围罩几百仓时 `mr:42` 跨仓同流 ⇒ 跨仓互相 supersede 误杀、`branch:main` 全仓共享熔断桶。**处置**：`streamKeyOf` 改 `${repoPath}|mr:${iid}` / `${repoPath}|branch:${branch}`；AC-9 增「不同 repo 同号 MR 互不影响」；索引条目同步改。

### P1（不修必返工，8 条全属实）

- **F-3** `scheduledPayloadSchemaFor` 直接复用走不通（StartTaskSchema superRefine 强制 repo 三态必给其一 `task.ts:787-794`、name 必填，与「repo 留空由 fire 注入」矛盾；agent/workgroup 封套的内嵌 ref-id 与 `launch_ref_id` 列双源）。处置：T1 明确「新派生触发器模板封套 schema」（repo/ref 禁填、name 可省、ref-id 外置、模板值延迟校验）。
- **F-4** delivery 落库时机未定义 + 同步 dispatch（cancel 5s 轮询、clone 分钟级）必撞 GitLab 10s 超时 ⇒ 重复分发竞态。处置：新增 D23 三段式（插 `received` 行 → 立即 200 → 异步 dispatch → 终态），status 枚举加 received/processing/interrupted，去重索引把在途态计入占位；新增 AC-5。
- **F-5** supersede/熔断 check-then-act 无互斥，两并发同流事件 ⇒ 双任务存活 + fires 链孤儿。处置：新增 D24 keyed-mutex per (triggerId, streamKey)（仿 `gitRepoCache.ts:60-65` `withUrlLock`）；新增 AC-11。
- **F-6** 「GitLab 对 5xx 自动重投」承重假设不成立（自建 GitLab 失败投递只有手工 Resend + 连续失败 auto-disable hook）。处置：D20 改写（500 只如实报告，恢复主路径 = 平台 replay）；**auto-disable 进威胁模型与部署影响清单第 5 条**（唯一 group hook 被禁 = 全部事件停摆）；T3 实测清单加自动重试/auto-disable 两项。
- **F-7** 「RFC-243 source-text lock 自动覆盖新调用点」为假——`CALL_FACES` 是硬编码四文件清单。处置：design §0/§10 改为显式登记 `webhookDispatch.ts`，列为 T6 交付物 + AC-18。
- **F-8** 迁移范围缺 tasks 归属列（镜像 scheduledTaskId 需要 `tasks.webhook_trigger_id`/`webhook_fire_id`）。处置：迁移 0138 与 T2 明确包含；proposal 开放问题 3 收口。
- **F-9** (a) ACL 第七类接入面被低估（shared 枚举/drizzle enum/ACL_PERMISSION_PREFIX/RFC-247 权限矩阵）；(b) **grants 写权 = 提权通道**（被授权者改绑 launch_ref → 以 owner 身份跑高权 workflow；`scheduled_tasks` 当年正为此有意弃用 ACL，schema.ts:1091-1092）。处置：**D19 改判断**——触发器走 owner 制（owner + admin/manager 旁路，无 visibility/grants），(a) 的大部分接入面随之消失；补「保存时以保存者身份校验目标可见性」（AC-17）。
- **F-10** (a) `{{event_json}}` 256KiB vs agent/workgroup 字段 65536 上限 ⇒ 必 422；`.trim().min(1)` 对「运行期宽松空串」有反例。(b) workflow git/enum kind 是 packed 格式，模板字面量过不了 `workflowLaunchInputIssues`，S2 与 AC-12 矛盾。处置：event_json 截断 ≤32KiB；运行期渲染后跑**全量启动校验**（失败 → `launch-failed(payload-invalid)`，不再声称不可达）；git kind 改**结构化「分支来自事件」代包**、enum/files 不支持映射；含模板值保存期跳过字面格式校验。AC-14 改写。

### P2（10 条全属实，全部折入）

F-11 补 `attempt_count` 列；F-12 deliveries 保留策略（30 天 body 置空/90 天删行 hourly ticker）；F-13 S5 排障分层（deliveries=管理员、fires=触发器 owner）；F-14 outcome 统一 `skipped-owner-invalid`；F-15 删除级联（endpoint restrict、trigger cascade、不可换绑）+ 匹配按 endpoint 过滤；F-16 限流修正（per-endpoint 为主、per-IP 只对未命中端点请求——反代下同源 IP 会误伤合法风暴且 GitLab 不重试 = 真丢事件）+ fake clock 可注入；F-17 url_hash 桶命中后 unseal 等值复核（自动化下 8-hex 碰撞 = 静默错仓 + 写凭据 push）+ URL 形态统一运维提示；F-18 UUID 缺失降级模式落文档与测试；F-19 校验基准拍板 `assertScheduledTargetUsable`（fireSchedule 路径有意不跑 assertWorkflowLaunchable，executor.ts:9-12）；F-20 依赖图修正（T5 以 stub dispatch 交付、T6 接线）。

## 结论

骨架（两表分层、去重索引、404/500 区分、公开性声明、secretBox 先例复用）被评审确认正确；两条 P0 属「安全网层自相矛盾」的设计错误，折入后熔断/supersede 语义首次自洽。**本 RFC 仍为 Draft，待用户批准后进入实现；批准时需知悉 D19 判断变更（ACL → owner 制）与部署影响清单第 5 条（GitLab auto-disable 风险）。**
