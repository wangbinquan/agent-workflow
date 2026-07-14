# RFC-181 工作组「全自动」硬化 —— plan

## 任务分解

按"能独立跑绿 + 依赖单向"拆，A / C / D 三条相对正交，可分 PR 也可合并单 PR（改动面小、无 migration）。

### T1 —— D：新建默认全自动（schema + 表单）

- `shared/schemas/workgroup.ts`：autonomous 缺省 true **仅挂 create schema**（设计门 P1：`workgroupConfigFields` 为 create/update 共享，共享层挂默认会让省略字段的老 PUT 静默翻转已有组）；update 路径省略＝服务层保留现值。
- `packages/frontend/src/lib/workgroup-form.ts` / `WorkgroupForm.tsx`：核对新建 draft autonomous 初值来源，确保新建默认 ON、编辑老组显存储值。
- 测试：create parse 缺省 true；新建组 autonomous=true；**update/PUT 省略＝保留现值（false 不被翻 on、true 不被翻 off 双向回归锁）**；前端表单默认 ON。
- **依赖**：无。**验收**：D 全 case 绿；无 migration（journal 计数不变）。

### T2 —— A + A2：per-task 中途切换 + 遣散在途 park（后端）

- `routes/workgroupTasks.ts`：`ConfigPatchSchema` +`autonomous`；`nextConfig` 透传 + changes 文案。
- **A2（设计门 P0；二审修订）**：false→true 转移且有 open clarify park → **单一加锁事务**：clarify_sessions+clarify_rounds 双表 canceled（与答案提交串行化，陈旧答案 409）+ 中介 park run（clarifyNodeRunId；asking run 已 done）lifecycle CAS→canceled + assignment `awaiting_human→dispatched/open` requeue；事务后 resume。canceled 语义复用既有原语（`clarifyRerunLedger`/`clarifyRounds`/`clarifySeal`），编排新收敛一处。
- `services/workgroupLifecycle.ts`：`WORKGROUP_ASSIGNMENT_TRANSITIONS` 显式新增 `awaiting_human→dispatched` / `awaiting_human→open` 两条 A2 requeue 合法边（现表该态仅 →running/failed/canceled）。
- 测试：PATCH 接受 autonomous、写 `workgroupConfigJson`、落 system 变更消息、对称 on/off；引擎即时生效（运行中 patch on → 下一 pass prompt 无邀请 + gate off + 压制判定真；off 恢复）；**A2**：leader/worker park 各一例 false→true → 单事务遣散 + 任务脱离 awaiting_human + 并发陈旧答案 409；转移表新边 oracle 全表穷举；无 park/true→true no-op；gate park 不误遣散。
- **依赖**：无（resolve 纯函数 RFC-180 已在）。**验收**：A/A2 引擎/patch case 绿；A2 遣散-解卡-推进链专测。

### T3 —— A：房间「全自动」Switch（前端）

- `components/workgroup/WorkgroupRoom.tsx` 配置区：+「全自动」`<Switch>`（复用公共 `Switch` + 现有 per-task patch 通道，同 completionGate）。i18n zh/en。
- 测试：Switch patch 往返；i18n 对称；`findByRole('switch')` 锚点。
- **依赖**：T2（后端字段）。**验收**：前端 workgroup 套件绿 + 视觉对齐自查（贴既有配置区 Switch 样式）。

### T4 —— C：clarify 硬压制（hook + runner）

- `WorkgroupHostRunRequest` +`clarifySuppressed?: () => Promise<boolean>` 即时判定器；runner 3 调用点（`:962/1149/1290`）注入（判定器内重读任务最新 `workgroupConfigJson.autonomous` → `resolveClarifyEnabled`——关死在途竞态窗，设计门 P1）。
- `services/runner.ts`（`runNode` 收尾分类，设计门 P1）：clarify envelope + 判定为真 → **持久化** `failed` + `errorMessage='clarify-suppressed:<n>'` + 终态广播；不建 session、不 mint 中介 run（DB 行为 182 note 派生依据）。`scheduler.ts` clarify 分支仅未压制可达（无新短路）、透传判定器。
- `workgroupRunner.ts`：leader 失败分支（`:971-990`）加 `clarify-suppressed` 重试（耗尽 drop-and-continue、不 `throw`）；worker 失败分支（`:1167`）加 `clarify-suppressed` 重试（耗尽 assignment failed）。
- 测试：收尾持久化（run 行 failed + 前缀 errorMessage + 广播、不建 session——DB 断言）；在途竞态（false 起跑中途翻 on → envelope 被压制；反向翻 off → 正常 park）；leader 收场（重提示→耗尽 idle→nudge、不 park、malformed 仍 throw）；worker 收场（重提示→耗尽 failed、fc 重开）；message-turn drop；三 role + 非全自动不回归（RFC-172 round-trip）。
- **依赖**：无（可与 A/D 并行；与 T2 无耦合）。**验收**：C 全 case 绿；**关键守卫**——耗尽后全部尝试 run 均已 failed 落库、引擎不 hot-loop / 不僵死。

## PR 拆分建议

- **默认单 PR**（RFC 默认粒度）：A+C+D 改动面小、无 migration、互不阻塞，一次 `feat(workgroup): RFC-181 ...` 交付。
- 若需拆：`PR-1 = T1(D)`、`PR-2 = T2+T3(A)`、`PR-3 = T4(C)`；C 最独立，可最先或最后。
- **与 RFC-182 统筹（2026-07-14 接管修订）**：本 RFC 先行落地，RFC-182 三 PR 随后（182 消费本 RFC 的 `clarify-suppressed` 前缀做 note 派生，前缀契约测试两 RFC 共享互链；`WorkgroupRoom.tsx` 触点错开——本 RFC 仅配置弹窗）。

## 验收清单（PR 合并前逐项打勾）

- [ ] D：schema 缺省 autonomous=true；新建组 true；已有组不变；表单默认 ON；**无新 migration**（`upgrade-rolling` 计数不变）。
- [ ] A：`ConfigPatchSchema` 含 autonomous；PATCH 往返 + system 消息 + 对称 on/off；引擎下一 pass 即时生效；房间 Switch + i18n。
- [ ] A2（设计门 P0）：false→true 遣散 open clarify park（session canceled + 解 park + resume）→ 任务解卡推进、陈旧答案回流被拒；无 park/true→true no-op；不误遣散 gate park。
- [ ] C：hook 短路不建 session；leader 重提示→耗尽 drop-and-continue（不 throw、不 park、run 终态）；worker 重提示→耗尽 failed；message-turn drop；三 role 覆盖。
- [ ] 非全自动零回归：clarify 正常 park + RFC-172/RFC-023 round-trip；RFC-180 resolve/prompt/gate/nudge 全绿。
- [ ] prompt 隔离：autonomous / clarifyEnabled 不进 agent prompt 归属信息。
- [ ] 五门：`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；单二进制 build smoke。
- [ ] Codex 设计门（批准前）+ 实现门（推送前）findings 全折。
- [ ] STATE.md / plan.md RFC 索引更新（Draft→In Progress→Done）。
