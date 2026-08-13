# RFC-295 实施计划

## 1. 实施原则

- 本 RFC 改变用户可见的 runtime-template 作者交互与 CodeHost active-target validation/preflight 投影；
  用户已于 2026-08-13 批准 proposal D1-D9 / C1-C10，T0-T8 可进入本地实施与验证。
- persisted inventory 继续覆盖可能含模板的全部存量字符串；stable sink family + action/discriminator-aware
  active projection 才决定当前可编辑、会执行和应预检的 target。不得把动态 pointer/当前控件实例数当权威。
- 以一个 provider registry、一个 authority adapter registry、一个 `RuntimeParameterPicker` 和一个 target
  conditional-commit 合同覆盖所有作者面；不保留旧新双 writer，也不在业务面复制参数清单。
- Workflow inspector 的 source-policy 请求全部已实现且对 sink 合法的 global source；Webhook rule 明确只请求
  `trigger/webhook`。本 RFC 不伪造 `trigger.scheduler.*` runtime，只用 fixture 证明未来 source 可扩展。
- 不改 RFC-292 canonical token、TriggerContext wire 或 renderer。C8 只让 CodeHost validator/dependency/preflight
  与 runtime 的 active action/provider 一致；非 active 存量值继续保留、可见诊断、可显式清理。
- 每批 production change 同批带正常、异常、回滚、并发/过期和真实浏览器防护；不留“先换 UI，以后补
  光标/无障碍/手机”的半状态。实施可分本地批次，但不得把部分 surface 单独发布到 production。
- 共享 `main` 精确修改/验证/报告本 RFC 所属路径与 hunk，不 stash/reset/rebase/广泛 stage 并发会话 WIP。
- 用户先批准 D1-D9/C1-C10 本地实施，随后于 2026-08-13 明确要求“做完提交上库”；全部发布门满足后精确提交并推送。

## 2. 子任务

| 编号 | 任务                          | 内容                                                                                                                                                                   | 依赖  |
| ---- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| T0   | 基线与 authority pin          | 重新 pin HEAD；锁两份 persisted inventory、stable sink family、CodeHost active/inactive fixture、旧 writer、Agent launch shape、视觉/E2E 基线与并发 WIP                | 批准  |
| T1   | shared authority / projection | 增 Webhook stable sink、total CodeHost projection、runtime builtin/per-surface producer descriptor；建 registry 全矩阵 fixture，分清 persisted/active/runtime producer | T0    |
| T2   | catalog/provider/文案         | 实现通用树、provider registry、surface policy、搜索；Webhook、runtime/task 与 local provider；typed 中英文案；假 scheduler 扩展测试                                    | T1    |
| T3   | target conditional adapter    | 下沉有效选区历史；实现 target id/value/revision snapshot、条件提交、stale fence、`validateNext`、whole-value、单 undo boundary、focus/live-region 合同                 | T1    |
| T4   | 公共 picker 与表单原语        | 实现 Field action、non-modal portal popover、combobox + listbox/action options、层级/breadcrumb、ARIA/IME/logical Tab、error/empty、viewport flip/clamp                | T2-T3 |
| T5   | Workflow / CodeHost 切换      | inspector 迁移；CodeHost picker/fallback/JSON guard；total projection 接 validator、Intent confirm、launch+direct preflight；删私有 writer                             | T4    |
| T6   | Webhook / Agent 切换          | common/workflow/workgroup 每字段迁移；Agent detail 状态机、zero/ported XOR、chips-newline、per-Agent draft、orphan repair 与 blocker                                   | T4    |
| T7   | 棘轮、真 E2E 与视觉           | 删除旧 chip/CSS/test ids；stable authority↔实际 registry 双向棘轮及 mutation；live-daemon Workflow+Webhook E2E；5 旧图 + 2 独立新 scene                                | T5-T6 |
| T8   | 文档与最终门                  | 更新用户文档/组件合同；双路实现门处置 findings；scoped tests + 唯一 final `bun run gate:local`；按真实边界更新 RFC/STATE                                               | T1-T7 |

## 3. 批次、验证与回滚

这些批次是本地实现/审阅检查点，不是独立 production rollout；最终只发布一个协调交付单元。

### 批 A：shared authority、目录与目标合同（T0-T3）

先建立纯函数与测试，不切换现有生产作者面/validator/preflight 消费者。

必测：

- Workflow/Webhook stable family 与 canonical fixture 双向对账；optional/dynamic pointer 不参与实例 exact equality；
- CodeHost persisted 全量与 provider/action active projection 分离，切换 action 后 active set 对称恢复；
- 完整 `CODE_HOST_ACTIONS × provider`：preset params/request inactive、custom request/all params inactive、unsupported/
  invalid structured error；direct executor 先判 action 再扫 active refs；
- Webhook 30 字段、两个功能组、`event_json` context 内展示置顶、eventTypes 全量/单项/交集/空集；
- 中英 type/source/group/field label/description exact completeness，canonical token/path/id 唯一；
- Agent builtin descriptor = `BUILTIN_VARS`，CallWorkgroup producer keys = 其 surface subset；per-surface actual-value
  golden（newline/bullet/comma、child/caller）与格式文案；context-only 解释、deprecated 排除、无 source 泄漏；
- 正常 local、重复入边合并、非法/保留 namespace port 的逐项 unavailable；坏 local 不毒死正常 local/Webhook；
- 搜索 label/raw/token/no-braces/description/alias/breadcrumb 与 CJK/NFKC；
- 假 scheduler 在 workflow policy 可见、Webhook policy 不可见，生产 registry 无 scheduler；
- caret/selection/append/never-focused、pointer/keyboard/synthetic click selection history；whole-value；
  target id/value/revision stale、JSON `validateNext`、commit error、单 undo/no-op 零 history。

回滚点：新 shared projection 尚未接生产消费者，新 catalog/adapter 无生产调用者，可以整批移除；wire/资源不变。

### 批 B：公共 picker（T4）

用独立 harness 完成交互合同，尚不删业务面旧 writer。

必测：

- trigger `aria-haspopup=listbox` ownership/name；带独立 label/controls/active descendant 的 combobox 与
  listbox/action options；
- root/type/source/group/field 导航、singleton compression、breadcrumb/back、全局搜索与 async reorder stable path；
- 行的 visible label/token/description、name/describedby；Field action 无嵌套 label，同页按钮 target name 唯一；
- Escape 只关 picker；logical Tab/Shift+Tab 回外层顺序；IME Enter/Escape 不误动作、不关闭 outer Dialog；
- outside click、user-focus-yield、unmount/hard pending、二次打开、live region；
- Workflow canvas atomic Undo/Redo；Webhook dialog-session 是全部 controlled draft 的单一 history owner，可见 actions、
  shortcuts 与已注册 draft target 的 `beforeinput historyUndo/historyRedo` 都进同一栈；picker search/Select filter 等
  ephemeral editor 保留本地 Undo 并阻止冒泡，不得撤销隐藏 draft。同字段 focus-session 连续输入/粘贴/IME 聚合，
  blur/picker/repair/Save 收口，picker/repair 保持 atomic boundary；redo truncation、save 成功 reset/失败保留、cancel
  discard；insert 与 bulk repair 后穿插多字符/IME common edit 的 exact Undo/Redo；picker search Undo 后关闭再用外层
  shortcut 的隔离测试；
- 1280/390、上下 flip、左右 clamp、visual viewport offset/resize/scroll、ResizeObserver、长说明与 44px 触控行。

回滚点：新组件仍无生产调用者，可与批 A 一起删除。

### 批 C：Workflow inspector 与 CodeHost active cutover（T5）

Agent/CallWorkgroup/Review/CodeHost 每个文件一次完成旧 writer 删除、新 picker、集成测试。CodeHost 的 frontend
target builder、workflow validator、Intent `resolveChangeset` authoring validation、launch trigger dependency/preflight、
scheduler/direct `executeCodeHostCall` defense 在同一批接 shared active projection，不允许半切换；migration/diff 与
Intent diff preview 继续走 persisted inventory。

必测：

- Agent/CallWorkgroup 默认无 30-chip 堆叠；正常/非法 local 隔离；local/runtime-task/Webhook token 精确插入；
  CallWorkgroup 只显示实际 producer 子集，Agent context-only builtins 常显可用时机；
- Review 只有一个 picker，只含 review builtin + Webhook，missing-ref 诊断不回归；
- CodeHost preset text/textarea/select；select token 整值替换、保存/重载后关闭态显示完整 runtime value，业务
  options 只有字面值，选择 literal 可替换 token，unknown literal 仍报错；
- CodeHost custom path/query value/body；query key 无 picker；JSON string value 正向及空 body/key/非字符串/裸
  token 负向；row 删除/重排/远端回流让旧 snapshot fail closed；
- provider/action 切换保留 inactive 值并显示“当前不执行”；隐藏 token 不参与当前 validator/preflight，切回后恢复；
  显式清理可取消/undo；migration/diff 仍遍历 persisted 全量；
- manual runtime 与 Intent confirm 覆盖 preset/custom inactive invalid/local/trigger refs；unsupported/invalid 先报 action
  error，direct executor 与 save/preflight 同序；
- downgrade dry-run 覆盖 pre-RFC 旧资源、RFC 后新建 inactive-invalid/inactive-trigger 资源、workflow revision 与
  live/resumable frozen closure；非空阻断回退，显式清理/切回修复后归零；
- 入边状态展示/移除保留，新增引用只走 target-adjacent picker；`code-host-calls:author` 不扩权。

回滚点：CodeHost UI 与 active projection 的 frontend/Workflow/Intent/launch/direct consumer 接线必须一起回退。先运行 legacy-projection
downgrade dry-run；任何 resource revision/frozen closure delta 非空即阻断。清理后用旧+forward-created fixtures 做
保存/validation/preflight 对账；禁止只回退 UI、只回退 shared 消费者或带差异强降级。

### 批 D：Webhook 切换与 Agent inputs 对称（T6）

必测：

- workingBranch 在合法 launch kind 上按 eventTypes 插入；eventTypes 空有精确 empty state；
- workflow 多 text mapping 每个目标显式插入，不聚焦也不猜第一个；git/enum/files/upload 不获得 picker；
- Agent detail `initial-loading/query-error/target-missing` 不闪 zero-port、不接管 target payload；
  `refreshing(previousResolved)` 保持 DOM/draft/focus/selection、普通 input/paste/IME 并 fence Save/picker；结构签名变化或
  error/missing 在 target field 聚焦/pending focus-session 时只存 pending reconcile，blur 先提交 typing 后应用，或由用户
  显式“应用最新定义”；相同签名原位更新不 remount。pending 携 agentId+generation+单调 pendingResultSeq+
  revision?/resultKind/signature；新 target/generation 清旧 pending，同 generation 更新 latest-wins；blur/Apply 捕获并
  CAS 完整 pending identity。覆盖 gen2 pending -> gen3 shape/error -> blur/Apply，以及同 generation r2/A pending ->
  r3/B replacement -> stale A Apply；只应用最新 entry，旧结果 0 resolution change/0 remount/0 patch/0 history、
  draft/history 保留，最新完整-CAS reconcile 前不解 Save/picker fence；
  error/missing 常显未验证 banner、目标与 opaque key 摘要、Retry，并将动作明确改为“仅保存通用设置，Agent 参数原样
  保留”；改 target/id/value/revision 时 fail closed，target-specific 已改则禁 preserve-opaque，backend error 不丢 draft；
- detail result 绑定 agentId + requestGeneration + Agent.updatedAt；A-slow/B-fast/A-late、resolved 后远端 rename/
  text->path/delete、save 404/422 refetch 的晚响应不污染当前 target/draft；
- resolved-zero 只序列化 description；resolved-ported 只序列化 declared inputs；两者严格 XOR；
- text/chips-newline、required/optional/trim/上限 round-trip；A -> B 不携值，B -> A 恢复 session draft；
- upload/path/signal/invalid blocker 保存请求 0 次；blocker 与 repair 可同时存在，移除旧值后 blocker 仍在；
  XOR conflict、unknown/renamed/kind-drift orphan 可见，普通编辑不删除，修复有确认/取消/undo；common key 保留；
- saving 期间 field/picker/dismiss 一致；失败后 draft/focus 可继续；取消/回滚不丢 `description`/`inputs`。

回滚点：Webhook payload wire 不升版；旧 UI 可重新把 `description`/`inputs` 原样保留在 payloadBase。整个 Webhook
authoring 迁移同批回退，旧/新前端读取同一 payload fixture 均不得删 orphan/共通键。

### 批 E：反向棘轮、真浏览器与收口（T7-T8）

- 删除 `TemplateVarChips` 的 UI 责任与旧 CSS/test id；纯 insertion mechanics 已由 T3 接管；
- AST/import/call/DOM scoped ratchet 锁旧 writer 归零；stable family registry 被生产 builder 实际消费；scanner
  sentinel/self-test + mutation 证明恢复旧 writer、绕 registry、新增 sink 不接 adapter 都会红；
- 两条 live-daemon、无 route mock 的 Playwright：Workflow 与 Webhook 各走字段旁 picker -> 真实 POST/PUT ->
  refresh 回读；Webhook 还经过 Agent detail/XOR 保存门；
- 更新 5 张 Agent default Linux baseline；新增 desktop-open-picker 与 390px-Webhook-open-picker 两个独立 full scene；
  visual scene guard `31 -> 33`、README pixel baseline `45 -> 47`、infrastructure test 同步；
- Darwin 本地布局诊断与 Linux hosted 权威像素结果分报；
- scoped shared/frontend/E2E/visual 通过后运行唯一 final `bun run gate:local`；
- 实现双路门 findings 逐项处置，不用 happy-path 数量替代可构造的 rollback/concurrency 失败输入。

## 4. 回归文件与 adjacent-miss

具体文件名在 T0 按 live tree 定稿，至少覆盖 catalog/search/i18n、shared authority/active projection、target adapter、
公共 picker、四类 workflow inspector、CodeHost preset/custom/permissions、Webhook Agent/payload、ratchet、live E2E 与 visual。

现有 `template-var-chips.test.tsx`、`webhook-template-var-insert.test.tsx`、`rfc269-code-host-inspector.test.tsx`
中的有效光标、事件过滤、保存行为迁到新公共合同，不因删组件而丢防护。

T0/T7 明确锁定以下不纳入面：

- Agent resource `bodyMd`、Script body、Clarify/Review 普通 description；
- i18n interpolation、starter generator、Intent diff/Prompt Preview；Intent confirm authoring validation 属 active consumer；
- manual/scheduled task 的本次 launch literal；未来 scheduler context 需另立 runtime contract；
- node title、branch filter、command prefix、ignore usernames、numeric/boolean limit、CodeHost query key；
- Webhook workflow 的 git/enum/files/upload mapping。

## 5. 只读设计门处置记录

RFC 初稿及修订稿经 contract、UX/a11y、tests/rollback 三路只读门审；经七轮增量复核，findings 已全部折回并 PASS。
门审未改生产代码、未跑测试。实施前必须保留以下已折回合同：

| finding                                                      | 已落合同                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| persisted collector 与当前 UI/action 不等价                  | stable sink family + CodeHost active projection；migration/diff 与 validator/preflight 分层     |
| 动态 pointer 无法做实例 exact ledger                         | authority key `(domain, launchKind?, sink)` + canonical fixtures + 实际消费 registry            |
| picker 打开后 value/row 可变化                               | target id/value/revision conditional commit，undo/remote/row/event stale fail closed            |
| CodeHost select 存量 token 不在业务 options                  | 关闭态独立 runtime-value fallback，打开列表仍只有字面枚举                                       |
| JSON body 不是任意 caret 都合法                              | sink-specific `validateNext`，只允许 JSON string value                                          |
| Agent 列表缺 detail，undefined 会伪装 zero-port              | initial-loading/refreshing/error/missing/resolved + 正交 blocker/repair 状态机                  |
| Agent `description`/`inputs` XOR、切目标与 orphan 未闭合     | target-owned draft、A/B 隔离、XOR serializer、显式 repair/确认/undo                             |
| portal/focus/Field/IME 合同不完整                            | combobox/listbox ownership、action options、logical Tab、composition fence、Field action        |
| 一个坏 local port 可毒死 catalog                             | global source failure 与 user-derived per-entry unavailable 隔离                                |
| “未来 scheduler 零 callsite”过度承诺                         | registry 零组件分支；workflow inspector 零修改；未来新配置面只声明 source-policy                |
| Agent/CallWorkgroup 既有 builtins 只能手输且来源名单分裂     | shared typed descriptor + surface producer subset；统一归 `runtime -> task`，无 producer 不展示 |
| 同 builtin 在 Agent/CallWorkgroup 的指代与格式不同           | per-surface semantic/format override + actual producer golden，禁止通用文案误导                 |
| Webhook controlled draft 没有 canvas history                 | dialog stack 单一 owner；draft target 聚合/仲裁；ephemeral search Undo 隔离；save/cancel 明确   |
| CodeHost custom/unsupported/direct/Intent 是 projection 特例 | total registry matrix；custom request-only；先 action error；全部 active consumer 共用          |
| Agent detail 晚响应/定义漂移可覆盖当前状态                   | id/generation/revision/signature/seq 完整 pending CAS；latest-wins；失配零副作用                |

## 6. 能力批准记录

用户已于 2026-08-13 确认 proposal D1-D9/C1-C10，特别是：

1. 不只改 Agent，而是全部权威 runtime-template 作者面同时收口；
2. 一个 field-adjacent 公共 picker 取代平铺 chip、私有 token Select 与多目标暗猜；
3. 全部目录在 scope 下固定 type/source/group/field；全局已有 trigger/webhook 与 runtime/task，未来 scheduler 走新 source contract；
4. CodeHost 反向 writer 退场，select 整值替换且存量 token 始终可见；active action/provider 决定
   authoring/validation/preflight，inactive 值保留；
5. Webhook Agent 合法 `inputs.*` 新增 UI，目标切换隔离，不兼容/orphan 显式阻断与修复。
6. Agent/CallWorkgroup 已有 runtime/task builtin 也进入统一 picker，但严格按实际 producer 子集提供。
7. Webhook Agent detail 失败时以 banner/摘要/Retry/“仅保存通用设置”保留 common-only preserve-opaque；刷新不卸载
   在编字段；CodeHost 回退必须先通过 legacy dry-run。
8. Webhook Dialog 使用单一 draft history owner；连续文本按 focus-session 聚合，picker/repair 保持独立 atomic boundary。

用户随后已明确授权“做完提交上库”；本地验证、commit/push、hosted CI 与最终 Done 仍按真实边界分别记录。

## 7. 完成定义

- proposal 验收项全部勾选，D1-D9/C1-C10 都有代码、可见文案、正常/异常/回滚/并发测试；
- 页面默认无常驻 token 长列表，打开 picker 后可按分类找到每个合法参数并常显解释；
- stable authority、active projection、Webhook catalog、i18n 与实际 adapter registry 双向棘轮有 mutation 证明；
- 旧 chip/writer/CSS/test-id 归零，没有第二个私有选择器规避公共合同；
- CodeHost inactive 值不误阻断且不丢；Webhook Agent 合法 inputs 可保存/回读、非法/orphan fail closed、共通键不丢；
- scoped、live browser、Linux visual 与唯一 final `bun run gate:local` 全绿，Darwin/hosted 结果分报；
- `design/plan.md` 与 `STATE.md` 只在真实完工后从 Draft 改 Done，不提前声称 commit/push/hosted CI/live service。

## 8. 实施记录（2026-08-13）

- T0-T8 生产接线与本地防护已落工作树：shared authority/runtime descriptors/CodeHost total active projection、公共
  `RuntimeParameterPicker`/target adapter、全部 Workflow/Webhook 作者面、Webhook Agent resolution/history、旧 writer
  归零、双向棘轮、文档与视觉场景均已完成；无 wire/schema migration。
- legacy downgrade dry-run 已交付为只读 `agent-workflow downgrade-audit rfc-295`：扫描当前 workflow revision 与
  live/resumable task 根快照/frozen closure，报告稳定定位并在 legacy delta 非空时阻断；命令无 force/ignore 且回归锁
  确认数据库零写入。
- 本地定向结果：shared 79/79、frontend 136/136、Webhook 专项 24/24、Webhook→CodeHost 真机 2/2、RFC-295
  live-daemon E2E 2/2、Darwin 受影响视觉 7/7，三包 typecheck 与 owned-source ESLint/Prettier/diff-check 均通过。
- 最终本地门禁已在干净后继快照 `3e85956e` 完整通过：backend 9990 pass / 35 skip / 0 fail、frontend
  6366/6366、shared 2033/2033，三包 typecheck、全仓 lint/format 与 dependency rules 全绿。第一次受限沙箱重跑因
  loopback listen/进程探针权限失败；正常权限下一轮的 5 个历史 5 秒硬超时均按原 seed 连续复跑 3 次通过，随后
  唯一 final `bun run gate:local` 以 0 退出，不把环境红冒充产品红或把定向复跑冒充最终门禁。
- RFC-295 实现与审核后的 Linux 基线已随 `c4a845c0` 推入 `origin/main`；该 exact SHA 的主 CI run
  `31670110969` 36/36 job 全绿，Linux visual run `31670110869` 42/42 场景全绿。后继 `3e85956e` 继续满足
  main CI run `31672205401` 36/36 与 OpenCode 双版本 integration run `31672205349` 全绿；未声称 live service 部署。
