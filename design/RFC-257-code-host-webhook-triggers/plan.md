# RFC-257 · 任务分解

状态：Draft（设计门 findings 已折入本版任务范围）。前置：用户批准后才动生产代码（CLAUDE.md RFC 流程第 3 条）。

## 任务清单

**批次一：后端核心（T1–T6）**

- **RFC-257-T1 shared 契约层**（无依赖）
  `packages/shared`：`CodeHostEvent` / 内部 eventType 枚举 / `TriggerRule` / fires outcome（统一 `skipped-*` 命名）、delivery status（**含 received/processing 中间态**）+ reason（含 `interrupted`）closed enum / 模板变量枚举 + `availableVarsFor` 矩阵 / **触发器模板封套 schema——新派生，不直接引用 `scheduledPayloadSchemaFor`**（设计门 F-3：repo 三态与 `ref` 禁填、`name` 可省、ref-id 外置到 `launch_ref_id`、含模板值延迟格式校验；基于 `StartTaskSchema`/`StartAgentTaskSchema`(task.ts:1374)/`StartWorkgroupTaskSchema`(workgroup.ts:587) 派生）/ 端点 wire schema（secret 三形态：wire/存储/掩码）/ 权限点：`webhook-endpoints:manage`（admin+manager，不进 PAT/MCP 面）+ **触发器路由权限点对齐 `routes/scheduledTasks.ts` 既有惯例（owner 制，非 ACL——设计门 F-9/D19）**。
  测试：schema 正反例（重点：repo 字段禁填被拒、模板值跳过格式校验）、closed enum 穷尽表、`availableVarsFor` 矩阵。

- **RFC-257-T2 迁移 0138 + drizzle schema**（依赖 T1）
  五张新表（design §1）+ **`tasks.webhook_trigger_id` / `tasks.webhook_fire_id` 两列**（设计门 F-8，镜像 `scheduled_task_id` 链路）+ 去重部分唯一索引（received/processing/matched/ignored 占位、rejected/failed 排除；SQLite 部分索引写法验证）+ `attempt_count` 列（F-11）+ 删除级联（endpoint restrict / trigger cascade fires+streams，F-15）。**不接入** `ACL_TABLES`（D19 修订）。
  测试：索引占位/排除行为、级联、tasks 列可写。

- **RFC-257-T3 GitLab adapter + fixtures**（依赖 T1）
  `verify`（timingSafeEqual 明文比对）+ `normalize`（design §2.3）。**实测清单（proposal §8）**：从真实自建 GitLab 采集 9 类事件 payload 存 `tests/fixtures/gitlab-webhooks/`（脱敏）；重点实证——①push 顶层 `user_username` vs MR/note `user{}`；②**pipeline 事件 `user` 是否 = 触发流水线的 push 者**（D14/D22 熔断语义前提）；③Resend 是否复用 Event-UUID；④**自建 GitLab 对失败投递确无自动重试** + auto-disable 阈值与恢复方式（F-6）；⑤system hook 无 Note 事件。与 design §2.3 不符处**以 fixture 为准回改 design**，并在 fixture README 记录。
  测试：9 eventType 正例 + unsupported + 双协议族 repoKeys。

- **RFC-257-T4 匹配引擎 + 模板插值**（依赖 T1）
  `matchTrigger`（**ignoreUsernames 作用域 = push/tag_push/mr_*/note，pipeline 不过滤**——F-1/D14）/ `streamKeyOf`（**含 repo 维度** `${repoPath}|mr:${iid}`——F-2）/ `evaluateCircuit`（§1.5 顺序：惰性过期 → 作者∉名单清零 → 上限判定——F-1/D22）/ `renderLaunchTemplate`（白名单路径、`{{event_json}}` ≤32KiB 截断、**git kind「分支来自事件」代包**——F-10）/ 保存期静态校验组。
  测试：五维矩阵（含 pipeline 不受名单过滤正例）、**跨仓同号 MR 不同流**、熔断三重置源、代包与截断边界、malformed fail-closed。

- **RFC-257-T5 接收端点路由（同步段）**（依赖 T2、T3；**dispatch 以 stub 接口交付，T6 接线**——F-20）
  `POST /webhooks/:provider/:urlToken` + `registerRoute publicReason` + design §3.2 九步（**三段式：插 received 行后立即 200，dispatch 异步**——F-4/D23）+ 限流（**per-endpoint 300/min 为主、per-IP 仅未命中端点请求；滑窗时钟可注入 fake clock**——F-16）+ daemon 启动时 `processing/received` 遗留行标 `failed(interrupted)`。
  测试：状态码矩阵逐行（§3.3）、404/500 区分（DB error 注入）、**响应先于分发返回**、interrupted 恢复、UUID 缺失降级（F-18）、未认证 POST 可达 + 启动自检绿、「不用 `c.req.url` 拼 URL」源码断言、fake clock 限流。

- **RFC-257-T6 分流服务 `services/webhookDispatch.ts`（异步段）**（依赖 T2、T4、T5 stub 接口；核心）
  **keyed-mutex per (triggerId, streamKey)**（仿 `withUrlLock`，串行化 supersede→熔断→启动全段——F-5/D24）+ repo 解析（url_hash 双 key + **unseal 等值复核**——F-17）+ supersede（`cancelExecution`，含 awaiting_*）+ 熔断读写 + owner actor 重建 + **`assertScheduledTargetUsable` 同款校验**（F-19 拍板，非 assertWorkflowLaunchable）+ 运行期渲染后全量校验（`launch-failed(payload-invalid)`）+ `ExecutionInvoker` 新增 `webhook` 成员（`services/execution/types.ts`）+ tasks 来源两列落库 + fires/观测列落库 + **`webhookDispatch.ts` 加入 `tests/rfc243-executor-facade.test.ts` 的 `CALL_FACES`**（F-7）。
  测试：fan-out 多命中（**只扫同 endpoint 触发器**——F-15）、**同流并发两事件 → 至多一活任务**、supersede 实调（awaiting_human、终态竞态）、熔断计数/三重置、owner 失效、三形态 mock 断言、渲染失败落 fire。

**批次二：管理面 + 前端（T7–T12）**

- **RFC-257-T7 端点管理 API**（依赖 T2）：CRUD + rotate-secret/rotate-url-token + 掩码/PUT 保留语义（**RFC-255「无关 PUT 不二次密封」回归锁同款**）+ 删除 restrict + url_token 铸造同语句重试。
- **RFC-257-T8 触发器管理 API**（依赖 T2、T4）：CRUD（**owner 制**：非 owner 列表过滤/404 同形，沿 `scheduled_tasks` 路由形态）+ 保存期静态校验组接线 + **以保存者身份校验 launch_ref 目标可见性**（对齐 `services/resourceRefs.ts` 惯例——F-9）。
- **RFC-257-T9 投递观测 API**（依赖 T5、T6）：deliveries 分页/详情/replay（三规则）+ fires 列表（**触发器 owner 可读自己触发器的 fires**——F-13 分层）+ streams reset + **deliveries 保留 GC ticker**（30 天 body 置空 / 90 天删行，挂 `cli/start.ts` ticker 组——F-12）。
- **RFC-257-T10 前端·端点设置卡片**（依赖 T7）。
- **RFC-257-T11 前端·触发器管理页**（依赖 T8）：含 kind 感知输入映射控件（git kind =「分支来自事件」选项）、忽略名单的 pipeline 例外说明文案。
- **RFC-257-T12 前端·投递历史页**（依赖 T9）：徽章含 received/processing/interrupted。

**批次三：收口（T13–T14）**

- **RFC-257-T13 运维文档** `docs/webhook-triggers.md`：GitLab group/system hook 配置（system hook 无 Note）、bot 账号 + `write_repository` PAT + credential helper + 忽略名单、bindHost/publicBaseUrl/反代 TLS、备份迁移 secret 重录、**auto-disable 风险与恢复**（F-6）、**URL 形态统一防双份 auto-register**（F-17）、排障表（GitLab Recent Deliveries ↔ 平台投递历史/fires 对照）。
- **RFC-257-T14 端到端 + 可选项**：e2e（mock GitLab POST 全链路到任务行 + tasks 来源列）；视觉对齐自查；可选 `/ws/webhook-deliveries` 频道。

## 依赖图

```
T1 → T2 ─→ T5(同步段, dispatch=stub) ─→ T6(异步段, 接线) ─→ T9 → T12
T1 → T3 ──↗                            ↗                     T14
T1 → T4 ──────────────────────────────↗
T2 → T7 → T10
T2,T4 → T8 → T11
```

（F-20 修订：T5 的 step 9 出口是 dispatch 接口调用，T5 以 stub 交付、T6 实装接线——原图 T5 与 T6 平行是断链。）

## 提交切分建议（主干直推，每批全门禁）

1. `feat(webhook): RFC-257 T1-T6 入站接收与分流核心`
2. `feat(webhook): RFC-257 T7-T12 管理面与前端`
3. `docs+test(webhook): RFC-257 T13-T14 运维文档与 e2e 收口`

每批 `typecheck / lint / test / format:check` 全绿 + 推后按 exact SHA 查 CI。

## 验收清单

- [ ] AC-1..AC-20 全绿（proposal §7 ↔ 测试一一对应，测试文件顶注标 AC 编号）
- [ ] T3 实测清单五项全部有结论；design §2.3 与 fixture 一致（不符处已回改并记录）
- [ ] 设计门 findings 20 条全部可追溯（本版已折入；实现期回归锁覆盖 F-1/F-2/F-5/F-7/F-8）
- [ ] 四门禁 + CI（含 Playwright e2e）绿
- [ ] `design/plan.md` RFC 索引状态更新 + `STATE.md` 收口
