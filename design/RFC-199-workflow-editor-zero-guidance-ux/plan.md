# RFC-199 — 工作流编排器零指导 UX 与可靠草稿：实施计划

> **状态**：In Progress（2026-07-16，用户明确回复「ok」批准实施）
>
> **强顺序**：可信保存门 G1 → 交互语义门 G2 → 零指导 UI 门 G3 → 响应式/真实浏览器门 G4。
>
> **协作约束**：RFC-198 最终实现基线为 `e48ba3e7` 且 Done 状态已收口；每批开始前重读 `CLAUDE.md`、`STATE.md` 与 live diff，只修改本 RFC 路径和明确接缝，保留其他 session 的 hunks。

## 1. 批次总览

| 批次 | 内容                                                            | 前置                              | 完成门                         |
| ---- | --------------------------------------------------------------- | --------------------------------- | ------------------------------ |
| B0   | baseline、失败复现与邻接不变量                                  | 用户批准 RFC                      | 旧行为与红测证据完整           |
| B1   | shared save/revision/WS contract + backend CAS + 全 writer 迁移 | B0                                | 并发写线性、回执归属正确       |
| B2   | frontend composite draft、单写队列、sync/conflict/reconcile     | B1                                | 保存状态可信，本地内容不被覆盖 |
| B3   | validate/export/launch exact revision 与 wizard fence           | B2                                | G1 可信保存/启动门             |
| B4   | composite history、clipboard 守恒、placement                    | G1                                | Undo/Redo 与结构不变量稳定     |
| B5   | connection planner、drag 语义等价迁移及明列不变量修复           | B4                                | G2 单一连接语义门              |
| B6   | empty state、Node Picker、显式连接、edge 插入                   | G2                                | 不用拖拽可完成建图             |
| B7   | starter、自动布局                                               | B6                                | 创建起点与安全整理可用         |
| B8   | typed validation target、检查器与画布定位                       | B7                                | 修错闭环可直达                 |
| B9   | 四档 workspace、视觉层级、a11y/keyboard                         | B8 + RFC-198 live foundation 核对 | G3/G4 零指导体验门             |
| B10  | 全量/二进制/E2E/visual/文档收口                                 | B9                                | 可交付                         |

任何批次触及 production code 时，测试与实现同批；bug 先写稳定红测，再修绿。P0 保存门未完成前，不并行落 B6–B9 UI。

## 2. B0 — Baseline 与反证

- [x] T0.1 记录开始 SHA、`git status --short --branch`、RFC-198 live 状态与本 RFC 允许路径；确认并行脏文件归属，不覆盖。
- [x] T0.2 将当前内存 SQLite 并发探针固化为 backend test：从同一 vN 同时写 A/B，当前实现应稳定暴露“两个 success/版本复用/错误 receipt”至少一项。
- [x] T0.3 增 frontend reducer/harness 红测：A 保存中继续编辑 B，A receipt 不能清 B dirty；自身 WS 先到不能覆盖 B。
- [x] T0.4 增两 tab 远端更新红测：clean follow，dirty freeze/conflict，remote delete 保留 local。
- [x] T0.5 为现有 drag connect 的 NEW、REUSE、review/output sync、clarify 与 boundary 行为补 golden fixture；这是 B5 重构的等价 oracle。
- [x] T0.6 为 clipboard wrapper `nodeIds`/edge `boundary`，以及 node delete 遗留 wrapper/review/output/loop refs 补红测。
- [x] T0.7 记录 editor 几何 baseline：1536、1280、1179、720、390；用断言证明 1280 当前三栏画布过窄、390 当前纵向长塔，而非只截屏。

**批内验证**：相关 backend/frontend focused tests；B0 的红测只作本地反证并与对应 B1/B2 修复同一提交转绿，不把红 trunk 单独提交，也不用弱化断言让旧实现假绿。

## 3. B1 — Revision contract 与 backend CAS

### T1 — Shared wire

- [x] T1.1 从 `workflow-sync-diff.ts` 抽稳定 snapshot serialization/hash helper：schema/migration 规范化后，以 domain-separated canonical UTF-8 bytes 做 byte equality + lowercase SHA-256；DB definition 统一 `serializeWorkflowDefinitionStorageV1 = canonicalJson(normalizedDefinition)`，create/import/update/heal 与 agentLaunch/workgroupLaunch fixed-id host seed 共用。锁 object/array/immutable与已 canonical 行不重复 heal。
- [x] T1.2 将 PUT schema 改为 `{expectedVersion, clientMutationId, snapshot:{name,description,definition}}` 完整替换语义。
- [x] T1.3 新增 `WorkflowRevision`、`SaveWorkflowReceipt` schema；outcome 只有 `committed | already-current`。detail/create payload 增 derived `snapshotHash` 供初始/reconciliation revision 使用，不落 DB、list 无需计算。
- [x] T1.4 `clientMutationId` 使用 canonical 128-bit ULID（26 位 Crockford 大写且首字符仅 0–7；8/Z 首字符为反例）并锁正反例；每个 submitted intent 生成一次、transport retry 复用。`workflow.updated` frame 增 `clientMutationId/version/snapshotHash/updatedAt`，`workflow.deleted` 增 mutation id/deletedVersion。
- [x] T1.5 validation issue 增 strict discriminated target union（node/node-field/node-port/edge/workflow-input/workflow-output/workflow）与封闭 `WORKFLOW_NODE_FIELD_KEYS` semantic enum；保留 pointer wire 兼容。

### T2 — Atomic service

- [x] T2.1 `updateWorkflow` 要求显式 actor/system principal；schema/ref preflight 在 transaction 外，`dbTxSync` 内重读 current owner/acl/builtin/physical definition，先重做 current owner/admin、builtin/name-change gate，再用 `WHERE id AND version RETURNING` 原子写。
- [x] T2.2 expectedVersion 匹配 + canonical bytes 同且 physical storage 已新返回 already-current；logical 同但旧 schema/非 canonical storage 执行 fenced heal+bump。stale + bytes 同仅作响应丢失对账；digest 不代替 byte compare。
- [x] T2.3 stale + 异 hash 返回 `409 workflow-version-conflict` + current revision；ACL/not-found 保持同形，失败零 partial write。
- [x] T2.4 changed commit 的 receipt 直接来自 RETURNING/事务内规范化结果，不在提交后无 fence GET；只在 commit 后广播同 mutation id/hash。
- [x] T2.5 枚举并迁移全部 content writer：editor autosave、rename、YAML overwrite、CLI/seed/test helper；凡触碰 name/description/definition/version 均走 save service。metadata-only `db.update(workflows)` 进入显式 allowlist并禁止触碰 editable columns/version。
- [x] T2.6 YAML import 收敛为 `{yamlText,mode,overwrite?}` shared schema；collision 带 current revision，overwrite 携 workflowId/expectedVersion/ULID 并复用 save receipt；漂移 409 要求重新预览，不静默覆盖。
- [x] T2.7 no migration；锁 workflow.version 严格单调与 receipt ownership。
- [x] T2.8 Delete 要求 expectedVersion + ULID；single tx 重读 current owner/builtin/version、检查 task refs，再 `id+version DELETE RETURNING`。commit 后才广播；409 重新确认，禁止 force-delete。

**B1 测试**：

- [x] 两 writer 同 vN 恰一 committed 到 vN+1、另一 409；不可两个 success/同版本。
- [x] 先发 A 的 receipt 绝不包含后发 B snapshot。
- [x] no-op、physical heal-on-edit、retry reconciliation、name/ref preflight failure、owner transfer/builtin/ACL/not-found、YAML 竞争与 broadcast；owner-transfer/save 与 delete race、已有 task reference in-use。active task-start race 留 B3 与 cleanup ledger 同批闭合。
- [x] 更新所有 schema/source locks；`bun run typecheck` + focused backend/shared/frontend caller tests。

## 4. B2 — Frontend 草稿状态机

### T3 — Pure model

- [x] T3.1 新增 `workflowEditorDraft` reducer：composite snapshot、monotonic revision、server revision、inFlight、queued、history pointer、save phase 与正交 transport=online/degraded/offline。
- [x] T3.2 action 覆盖 LOCAL_COMMIT、SAVE_REQUESTED、SAVE_COMMITTED、SAVE_ALREADY_CURRENT、SAVE_FAILED、RECONCILED、REMOTE_OBSERVED、REMOTE_DELETED、REMOTE_INACCESSIBLE、冲突三种决议。
- [x] T3.3 同一 workflow single-flight；编辑只 coalesce 最新 queued revision。receipt 只 ack submitted revision，绝不按“任意 success”清 dirty。
- [x] T3.4 transport/5xx 进入 reconciling；GET 也不可达时保留 attempt/local/queued，1/2/4/8/15s capped backoff + manual retry。online/WS-open/visible/focus 先 reconcile：same hash 成功、same version 原 mutation重发、advanced diff conflict；完成前不发 queued。
- [x] T3.5 clean remote adopt；dirty/saving/error 的 foreign update 保留 local 并 conflict。active reconciling observation 必须先走 T3.4 attempt-aware 分类：same submitted hash 成功、same expectedVersion 重发原 mutation、advanced different hash 才 conflict，不能被 generic dirty-remote 抢先消费或 clean-adopt。own mutation WS 不 invalidate detail，HTTP receipt 结算。每次 WS open 增 connection epoch 并无条件 reconcile detail/list，visible/focus 节流 reconcile；own frame 不能屏蔽重连补读。
- [x] T3.6 明确 delete frame 进入 deleted；save/reconcile/detail 403/404 进入不可区分的 inaccessible。两者保留 local/history、停止 autosave，本地 YAML/返回列表可用；有 create/ref 权限才可另存副本。

### T4 — Route 接线

- [x] T4.1 `workflows.edit.tsx` 删除 draft/name/description/dirty 分散 state 与 rename 独立 mutation，所有本地编辑走 `dispatchDraftChange`。
- [x] T4.2 query effect 只发 REMOTE_OBSERVED，不再裸 `setDraft(query.data)`。
- [x] T4.3 autosave mutation variables 携带提交 snapshot/revision/version/mutationId；closure 不读取 live draft。
- [x] T4.4 `useWorkflowSync` 暴露 frame 给状态机；own echo 与 foreign update 分流。
- [x] T4.5 保存投影拆为 saved/dirty/saving/reconciling/error/conflict/inaccessible/deleted，并与 online/degraded/offline transport 分轴；StatusChip 只显示短状态，offline/error/conflict/inaccessible/deleted 用持久 Notice + action。
- [x] T4.6 dirty/saving/reconciling/error/conflict/inaccessible/deleted 接入离页 guard；clean own echo 不误弹。
- [x] T4.7 conflict：另存副本推荐、加载远端确认、覆盖远端 danger CAS；重复竞争仍停在 conflict。

**B2 测试**：edit-during-save、三次 coalesce、请求前断网/响应丢失后断网/恢复三分支、own WS before HTTP、clean/dirty remote；active reconciling 明确锁 same expectedVersion 重发且不假冲突、response-loss → offline → foreign commit → WS-open/GET 仅在 advanced different hash 时 conflict；另锁 explicit delete、owner-transfer 403/404 inaccessible、reload 后服务端为最新 revision、rename/autosave 单队列。必须包含 fake-clock reducer + 真实 hook/route integration。

## 5. B3 — Exact validate/export/launch

### T5 — Save barrier

- [x] T5.1 实现 `ensureSaved()`，可取消 debounce、flush queued、返回 `{local revision, WorkflowRevision, normalized snapshot}`；error/conflict/inaccessible/deleted 聚焦保存 Notice。
- [x] T5.2 先将 backend validator 抽为 `loadWorkflowValidationContext` + pure `validateWorkflowDefinition(definition,context)`。Validate body 要求 expectedVersion + expectedSnapshotHash；服务端捕获一次 visible workflow row，以同一 immutable definition guard + core validate，禁止 guard 后按 id 二次读。response 带 WorkflowRevision、validatedAt 与 `projectWorkflowValidationContext` 全读取字段投影的 domain-separated hash；mismatch 为 `workflow-validation-stale`。
- [x] T5.3 validation 绑定 local revision/version/hash/context hash；任意 edit 或 agent/skill/plugin inventory 变化立即标 stale，旧绿色状态不控制 Launch。
- [x] T5.4 Export 走 ensureSaved + authenticated exact-revision fetch；服务端只捕获一次 visible row，并用同一 immutable snapshot guard + stringify，禁止 guard 后二次读 latest。deleted 只允许明确 unsaved local export。
- [x] T5.5 validator 能唯一定位的 issue 发 strict shared target；output binding row 使用 output node 自身的 `nodeId+direction:'input'+portName`，loop outputBinding/exitCondition 使用 node-field semantic target，其他 node port 使用 nodeId+direction+portName；重复 input/output 退 workflow target；pointer fallback 产同一 union。

### T6 — Launch handoff

- [x] T6.1 Launch double-click 合并为一个 `preparing-launch` operation；短暂冻结点击 revision，显示“正在保存并校验”，失败解锁。
- [x] T6.2 严格执行 save → **fresh** validate exact revision/context → blocking issue gate → navigate；每次 Launch 都重跑，绝不复用旧绿色结果，任一步失败都不离页。
- [x] T6.3 `/workflows/:id/launch?version=N` 将 validated `workflowVersion` 传到 `/tasks/new` search。
- [x] T6.4 fresh workflow launch 与 relaunch 都捕获 guard；JSON/multipart immediate submit 都发送现有 `expectedWorkflowVersion`。
- [x] T6.5 wizard 已填内容时远端升版不静默 reset；materialize 前 mismatch 零创建。startTask 与 delete 交错若 delete 先赢，最终 FK/zero-row 转结构化 mismatch，并用 ledger 清 normal repo/worktree/scratch 到零残留；task insert 先赢则 delete in-use。
- [x] T6.6 scheduled payload 继续不持久化 point-in-time guard，并明确“执行时使用最新工作流”。

### G1 — 可信门

- [x] 后端并发、frontend save race、双 tab、validate stale、editor→wizard fence 全绿。
- [x] 人工网络节流：保存中继续编辑后 reload 不丢；请求前离线与 response 丢失后离线均保留本地/attempt，恢复后按 hash/version 对账再发 queued。
- [x] writer 插在 validate/export guard 与消费之间仍只返回 captured revision 或 409；validator-read context 任一语义字段变化都会改变 context hash，secret/prompt 不泄漏。
- [x] 未出现“local ≠ server 却显示已保存”状态；Launch 产出的 task.workflowVersion 与 validated revision 一致。
- [x] G1 未通过不得开始 B4–B9 production UI。

## 6. B4 — History、clipboard 与安全放置

- [x] T7.1 建 shared node-reference descriptor inventory：copy/duplicate wrapper 递归扩 child closure 与 closure 内 edges；重写 wrapper/review/output/loop refs，slice 外引用清空/过滤+warning，edge boundary 保留；同 inventory 驱动 delete prune。clipboard 另携 sourceWorkflowId + input declarations，按 distinct source key 映射一个 collision-safe target key，所有共享-key nodes/edges/declaration 同改并保留 upload 字段；missing declaration fail closed。跨/同 workflow + shared-key fixtures 与 ratchet 防漏映射。
- [x] T7.2 route composite history 保存完整 editable snapshot reference + intent/selection hint；save receipt 不清 history。
- [x] T7.3 drag start/stop、Dialog submit、delete 走原子 transaction；同字段连续输入按 mergeKey/blur/750ms 合并。后续新增的 insert/layout 入口继续分别由 T10.4/T12.4 锁定为单 transaction。
- [x] T7.4 Undo/Redo 生成新 revision；新 edit 清 redo；clean remote/load remote/switch workflow 清 history；上限 50，immutable/deep-freeze test。
- [x] T7.5 文本控件保留原生 undo；画布聚焦时接管 Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z、Ctrl+Y；toolbar 是可见主入口。
- [x] T7.6 undo 后清理已不存在 selection，并根据 hint 恢复合理 focus；不把 viewport 写进 definition history。
- [x] T7.7 新增 `findOpenPlacement`：连续 click 不重叠、中心占用避让、无显式 intent 不落入 wrapper 假包含。

**B4 验证（2026-07-19 live source 复核）**：shared reference inventory/closure/rewrite/prune/ratchet `10/10`；history、clipboard、delete、placement、route integration 第一组 `54/54`；hook、Inspector history meta、edge/delete/wrapper missed-issues 组 `131/131`，合计 `195 pass / 0 fail`。未发现需补 production code 的 B4 缺口。

## 7. B5 — 单一连接语义

- [x] T8.1 抽 `WorkflowSemanticContext{agentsByName,inventoryRevision}` + `ConnectionIntent/ConnectionPlanResult`；planner 只产出 remove/add edge delta、typed node declaration patches、semantic meta 与 preview，不提前执行 disconnect/connect mirror sync；context 更新必须重算/作废旧 preview。
- [x] T8.2 target authority 区分 dynamic agent-single/output inputs 与 fixed review/clarify/wrapper。review 提升 shared `__review_input__` policy：单入/REUSE、agent-only、复用 shared markdownish/list predicate；generic/clarify/fanout intent 返回 compatibility 三态。fanout shard kind 必为 list，选择新 shard 原子 demote 旧 shard并 preview；无 shard 时 broadcast-only 不算完成，锁 0/1/2 shard oracle。
- [x] T8.3 唯一 `applyWorkflowTransition(prev,transition,context)`：disconnect cascade → graph/node delta → connect sync → prev/final declared-port diff，返回 next+warnings。review single↔multi 原子迁 `approved_doc↔accepted` 下游 refs；disappeared fanout derived ports 删除 stale edges/清 PortRef并警告。node delete 递归/prune；membership 变更 unlocked refit、locked 保持。所有入口全迁且只 sync 一次。
- [x] T8.4 golden fixture 证明 drag `NEW / REUSE` preview 与合法图语义不回退；definition 字节差异只允许明列 dangling-ref/derived-port/fanout 修复并逐 fixture 解释。删除重复拼边/同步分支并用 ratchet 阻止复活。

**B5 验证（2026-07-19）**：frontend 全量 `595 files / 4848 pass / 0 fail`，shared 全量 `123 files / 1332 pass / 0 fail`，backend validator/RFC-199 精确套件 `14 files / 143 pass / 0 fail`；workspace typecheck、lint 与本批 code format/diff-check 全绿。并行 dirty tree 上 backend 首轮全量为 `5793 pass / 22 skip / 46 fail`，失败横跨 RFC-200 prompt 文本、daemon/WS/PID/既有跨域时序面；其中本批命中的 validator 发射点计数 ratchet 已由 86 更新至 89 并在上述 143 条精确套件复绿。整树 backend 全绿仍留给并行变更合流后及 T16.5 正式门，不把 G2 通过误写为仓库总门通过。

### G2 — 语义门

- [x] 现有真实 drag NEW/REUSE、wrapper boundary、review/output、clarify 回归全绿。
- [x] review shared `__review_input__` policy 锁 agent-only + markdownish/list compatibility、occupied replace 与 inputSource/edge 单次 sync；non-agent/known-bad kind fail closed。
- [x] review single→multi→single 锁 `approved_doc↔accepted` edges/output/loop refs；删除/更换 fanout aggregator 锁 disappeared promoted port 无 ghost edge/PortRef、warning 可见。
- [x] planner 对 self/duplicate 返回稳定 structural reason、零 partial mutation；compatibility 单列三态，guided UI 阻止 known-incompatible，legacy drag 保持 advisory；generic cycle 只 advisory，合法 loop/clarify cycle 保持可建并交最终 validator。
- [x] G2 后 UI 才可消费 planner，不能在 Dialog 复制第二套规则。

## 8. B6 — 零指导建图 UI

### T9 — Empty / Picker / actions

- [x] T9.1 editable 空画布用公共 EmptyState 显示“添加第一步”“从模板开始”；readOnly canvas 无创作 CTA。
- [x] T9.2 `WorkflowNodePicker` 复用 `buildPalette/makeNode`，支持搜索、推荐/最近/全部、disabled reason、上下键/Enter/Escape/focus restore。
- [x] T9.3 palette 搜索迁共享 `TextInput type=search` + accessible label；整行以 click/pointer 为主，拖拽 grip 为桌面增强。
- [x] T9.4 toolbar Add、空态、palette、节点/边 contextual `+` 与每个 editable wrapper（含空 wrapper）的“添加内部步骤”共用 picker；intent 显式携 top-level/wrapper scope。placement 可 local 计算，但 definition 始终经 coordProjection 存 absolute、renderer 才 relative；创建+nodeIds membership 一个 transaction，取消零 mutation，锁 nested/Undo 投影。
- [x] T9.5 选中节点显示可见“连接下一步 / 复制 / 更多”；Shift+F10/ContextMenu key 与菜单 Arrow/Home/End/Escape/focus restore 完整。

### T10 — Non-drag connection / edge insert

- [x] T10.1 `ConnectionDialog` 显式选择 source output、target node、NEW/REUSE input，显示 kind 与 `A.output → B.input` preview；占用 REUSE 明示替换对象；fanout boundary 显示内/外侧、kind 与 shard/broadcast role，新 shard 明示旧 shard 将转 broadcast。
- [x] T10.2 clarify/cross-clarify/fanout boundary 用领域动作文案，不伪装普通 port；agent query 更新时候选同步刷新并作废旧 submit plan。
- [x] T10.3 custom ordinary-data edge 提供可聚焦中点 `+`；hover 只是增强，stopPropagation 不抢 EdgeInspector/pane selection。
- [x] T10.4 `insertNodeOnEdge` 原子保留原 target port；v1 仅 top-level 且两端都不属于 wrapper 的普通 data edge，boundary/clarify/control/任意 inner/cross-wrapper（含 fanout inner-chain）fail closed。pure+rendered golden 锁 `A→B(existing target port)` 变 `A→N→B`、原 edge 删除、B port/mirrors 单次同步、一个 history/Undo；禁止类型无入口或 fail closed，Cancel 零 mutation。
- [x] T10.5 成功后 selection/inspector/focus 可预测并通过 polite live region 宣布；Cancel/Escape 零 mutation。

**B6 验证（2026-07-19）**：Picker/键盘菜单/空态/wrapper 内添加/节点工具条、ConnectionDialog、普通 data edge 插入与单一 planner/transition 的 7 个聚焦文件 `23 pass / 0 fail`；frontend typecheck/lint 全绿。

## 9. B7 — Starter 与布局

### T11 — Starter

- [x] T11.1 建 client-only catalog：标准开发闭环、只做审计；空白关闭回 picker。
- [x] T11.2 role mapping 本地 preflight 后调用 authenticated `validate-draft`，复用 B3 已抽的 backend core/context loader，不建临时 row、不复制到 frontend/shared；candidate/context 变化取消旧结果，Apply 时 fresh 回执匹配 candidate 才允许。
- [x] T11.3 将 git diff path-list 以 grammar 合法 `wrapper-git.git_diff = list<path<*>>` 提升到 shared declaredPorts；更新 `list<path>` stale 注释，枚举 sourcePortKind/shardingRegistry/control-flow/validator/canvas/scheduler 并锁 path shardKey 不退化 index、零 runtime 漂移。
- [x] T11.4 `validate-draft` 服务端重算 domain-separated candidate hash、claimed mismatch 422，并按 captured stored→candidate 调同源 `assertNewRefsUsable`；返回 hash/context/时间/issues 且零持久化，Apply 后 PUT 再 gate。catalog golden 跑同一 validator；标准闭环遵守 git wrapper/fan-out/aggregator/output promotion。
- [x] T11.5 空 workflow 一步 Apply；非空替换二次确认；整个 apply 一个可 Undo transaction。

### T12 — Auto-layout

- [x] T12.1 新增纯 `planWorkflowLayout(definition,{semanticContext,measuredSizes,selection})`；adapter 捕获 immutable measured sizes，优先实测再用默认；返回 `{next,warnings}`，只改 position/必要 wrapper size。
- [x] T12.2 data + control/signal execution dependency 都参与 rank；每条边在 endpoint coordinate-space LCA 投影到 direct-child representatives，补 external→wrapper-inner 等跨层约束；actual boundary/mirror 不重复，clarify/system feedback/channel 排除，cycle back edge 稳定选择。
- [x] T12.3 最深 wrapper 向外递归，使用 coord projection/wrapper fit；父层移动 wrapper 时把完整 descendant closure 的 canonical absolute positions 同 delta 平移，并锁 nested fixture 的 child-relative geometry 不变；control classification 读 semantic context；sizeLocked 保持尺寸，内容放不下给可见 warning。
- [x] T12.4 整图与同 scope selection 模式；selection 保持原 bbox 锚点并避让未选节点；跨 wrapper 返回 advisory，不静默回退整图；layout 一个可 Undo transaction并 fit view。

**B7 验证（2026-07-19）**：starter/catalog/preview fresh-validation/apply history + layout planner/adapter/route 的 frontend 聚焦门 `34 pass / 0 fail`，shared candidate/hash 与 git-diff grammar `3/0`，backend validate-draft/catalog golden/runtime path stability `13/0`；frontend typecheck/lint 与本批 format 全绿。布局另锁 measured-size snapshot、data+signal LCA、稳定 cycle back-edge、nested descendant delta、selection 避让、cross-scope advisory、sizeLocked warning、单 transaction 与 fit view。

## 10. B8 — 校验定位与检查器

- [x] T13.1 strict typed target 覆盖所有能唯一定位的现有 blocking issue；node field 用 shared semantic enum、node port 用复合身份；frontend resolver 优先 target、兼容 pointer/code、unknown/重复对象不猜。
- [x] T13.2 抽真实 ValidationPanel；summary 固定 toolbar；normal-height 详情为不参与 grid 的 anchored overlay，`<=720px`/block-size<=520 为互斥 validation sheet；每条 issue 是 button，可 handoff selection + fit + inspector section + stable field focus；1→N own-scroll 且 canvas bounding box 不变。
- [x] T13.3 stale target 提示重新校验；节点/边 issue 显示图标+文字+计数，颜色不是唯一信息。
- [x] T13.4 node 主卡显示业务名/agent 名与配置摘要；raw kind/id 移到“技术详情”，保留 copy id。
- [x] T13.5 `OutputEdit`/`ReviewEdit` editable upstream/rerun node/port 迁可搜索选择；Edge endpoint node 只读业务名+技术 ID，target-port selector 必须走 B5 唯一 transition，端点重连走 ConnectionDialog；wire 不变、零直写旁路。
- [x] T13.6 canvas 加 accessible name/description；全页只保留一个受控 live announcement。
- [x] T13.7 Inspector 顶层保持“编辑 / 提示词预览”；Review/Loop 等复杂表单在 Edit 内按 Basics / Flow / Advanced / Technical 渐进披露，不继续堆同级 Tab。

**B8 验证（2026-07-19）**：typed target/resolver、ValidationPanel 定位与 stale handoff、业务标题/技术详情、搜索式 selector、单一 transition/reconnect、canvas a11y/live region 与 Inspector 渐进披露均有 shared/backend/frontend 行为测试及 source ratchet；完整仓库单测与后续浏览器门零失败。

## 11. B9 — 四档 workspace 与视觉

### T14 — Responsive surfaces

- [x] T14.1 抽无 chrome 的 Palette/NodeInspector/EdgeInspector content；rail/Dialog 复用，避免双标题/双 close。
- [x] T14.2 editor mode：`>=1536` palette rail + canvas + selection inspector rail；`1180–1535` canvas + selection inspector rail / palette modal；`721–1179` canvas-only + side modal；`<=720` full-screen modal。grid track 分别锁 `240 + minmax(520,1fr) + clamp(360,27vw,420)` 与 `minmax(520,1fr) + clamp(360,30vw,420)`。
- [x] T14.3 persistent rail 由 mode+selection 派生；单一 top-level `modalSurface = none|palette|inspector|connection|starter|validation|actions|rename|acl|save-copy|confirm`。compact validation issue→inspector、palette→inspector、More→Rename/ACL/Delete、conflict→save-copy 直接 handoff，无双 top-level Dialog/抢焦点。
- [x] T14.4 共享 Dialog + feature `panelClassName`，side `min(88vw,420px)`、phone `100vw×100dvh` + safe area；只为现有 ACL owner-transfer 允许一层 nested Dialog，parent inert，Esc/Cancel/成功逐层恢复焦点。锁其他 surface 不叠层、200% zoom 与 resize fallback。
- [x] T14.5 supersede editor vertical-stack selector/test；task/review/workgroup 等 RFC-198 specialized workspace 不变。

### T15 — Visual hierarchy

- [x] T15.1 PageHeader：名称/版本/保存；Validate secondary；Launch 唯一 primary；Export/Rename/ACL/Delete 明确进共享 Dialog action list，Delete 转 confirm surface，不新造 Menu。
- [x] T15.2 `WorkflowCanvas.surface` 在 editor/task/workgroup-preview 三个 call site 必填并输出 data scope；普通 node 220–240px，列入 fixture 的复杂 wrapper/review 可到 260px；raw id 隐藏、kind/config/validation 新视觉仅 editor 生效，task runtime 与 dynamic preview 零变化。
- [x] T15.3 save/transport/validation/config health 分轴；warning 补真实 visual rule，offline/inaccessible/deleted 有独立文案/action oracle，StatusChip/NoticeBanner role 与 live timing 正确。
- [x] T15.4 validation 走独立文字/图标/计数 badge，不抢 focus/selected border；锁 focused+selected+error、selected+incomplete、task runtime+kind 组合。port visual 可小但 hit area 尽量 24×24；ConnectionDialog 是完整键盘/触摸等价路径。

### G3/G4 — UX 门

- [x] 纯键盘/触摸、不用 drag/right-click/help：空白 → 添加两节点 → 连接 → 修校验 → Launch；另锁空 git/loop/fanout wrapper 内部 Add 与 Undo。
- [x] edge insert E2E 锁合法普通 edge 的 target/mirror/Undo 守恒；boundary/clarify/control/inner/cross-wrapper/fanout inner-chain 不显示入口或 fail closed，Cancel 零 mutation。
- [x] 1536/1535、1280、1180/1179、1280×521/520、901/900、721/720、390×844、640×400 几何门直接量 bounding box：wide/mid inspector open canvas >=520px、390 block >=560px、landscape summary-only canvas >=240px、side <=420px；无 body overflow、最后字段可达；Validation 1/N own-scroll 且 canvas 尺寸不变，1280×521/520 独立锁 short-height overlay→modal，compact/short modal 打开时改量 full-screen surface/最后 issue/focus handoff。
- [x] top-level modal 单实例、ACL owner-transfer 唯一 nested layer、persistent rail 共存规则、初始焦点、Tab trap、handoff、逐层 Escape/resize restore、selection/draft 不丢；More→Rename/ACL/Delete Cancel/成功回交有 oracle。
- [x] axe 场景实跑 1536/1280 inspector、1179 palette modal、390 NodePicker/Inspector/Connection、More→Rename/ACL/Delete 与 ACL→owner-transfer（至少一组 light/dark）；单层查唯一 top-level Dialog，nested 按 topmost scope 查 name/heading/close、parent inert/无重复 focus。renderer exclusion 另有 node/port/action component keyboard gate。
- [x] task-detail 与 dynamic-workflow preview rendered/visual oracle 证明 editor surface CSS 未泄漏。

**B9 验证（2026-07-19）**：四档 workspace/short-height/zoom/resize、route-owned rail 与单一 modalSurface、ACL 唯一 nested Dialog、More handoff、zero-drag/edge-insert、keyboard/touch/focus/axe 及 task/dynamic-preview 隔离均由 component/source/Chromium E2E 覆盖；完整 E2E `126 passed / 30 skipped / 0 failed`。

## 12. B10 — 收口与发布验证

- [x] T16.1 将 `e2e/workflow-editor.spec.ts` 加入 root lint/format 精确清单；不靠未被 gate 覆盖的文件宣称完成。
- [x] T16.2 E2E：zero-drag + empty-wrapper Add、真实 drag NEW/REUSE、edge insert target/mirror/Undo + forbidden-edge fail-closed、delayed save、offline before PUT/response-loss+offline/recovery/foreign-commit conflict、two-tab conflict、editor→wizard mismatch、mobile non-drag、validation focus、strict undo/redo oracle。
- [x] T16.3 visual scenes：1536 三栏、1280 inspector light/dark、1179 palette/inspector side modal、390 empty+picker、390 full-screen inspector；保留既有 task-detail baseline，并**新增** deterministic dynamic-workflow preview component/page baseline。固定 fixture、mask 随机 id/version、禁动画/caret并同步新增 scene count。
- [ ] T16.4 同步 visual scene count、README、nightly 注释与 Darwin/Linux baseline；不扩大 threshold 吞差异。
- [x] T16.5 focused tests 后跑仓库正式门：
  - `bun run typecheck`
  - `bun run test`
  - `bun run format:check`
  - `bun run lint`
  - `bun run build:binary` 及既有单二进制 smoke
  - RFC-199 Playwright/axe/visual 精确项目，最后按 CI 约定跑完整 e2e
- [x] T16.6 检查 source/AST ratchets：content writer 无 unfenced update；所有 production workflow INSERT definition（显列 agentLaunch/workgroupLaunch）必经 canonical helper；metadata-only update 仅 allowlist且不触碰 editable columns/version；DB delete 仅 fenced service，禁 `deleteWorkflow(db,id)`/route direct delete；无裸 setDraft、第二 connection builder、editor vertical stack 或新增 native alert/prompt/confirm。
- [ ] T16.7 更新 RFC 状态、`STATE.md`、`design/plan.md`；精确路径提交，保留并行改动。若获 push 授权，按仓库要求验证 commit attribution、push 后检查该 SHA CI。

**B10 本地验证（2026-07-19）**：workspace typecheck/lint/format、depcheck、`git diff --check`、完整 backend/shared/frontend 单测、单二进制构建/version/doctor smoke、完整 Chromium E2E、RFC-199 axe/source ratchet 与 Darwin visual `25/25` 全绿；1280 light/dark Darwin 各重复 5 次零 diff。T16.4 保持未勾：本地 MCR `ubuntu-24.04` 容器与 GitHub 托管 runner 的字体/栅格库存不同，所产 9 张 Linux 图仅作诊断且尚未由 hosted runner 验证，不扩大 threshold。T16.7 保持未勾：尚未获 commit/push 授权，也没有 exact-SHA CI。

## 13. 回滚与停线条件

- B1 API/shared/backend/all callers 是一个原子兼容批；不能只回滚 schema 或只回滚 backend。无 DB migration，回滚不需要数据变换。
- B2/B3 frontend state machine 可独立回滚到 B1 的 fenced writer adapter，但不得恢复 unfenced backend service。
- B6–B9 是 editor-scoped UI；按批回滚不得影响 task read-only canvas 或 RFC-198 全局 shell。
- 任一测试发现 runtime、definition schemaVersion、wrapper/fan-out 语义需要改变，立即停线回 RFC 重新审批。
- RFC-198 同一 selector/primitive 出现真实冲突时停下协调，不手工剥离或覆盖另一 session hunk。
- 并发门、receipt ownership、dirty remote preservation、Launch version fence 任一不成立，整体不得标 Done。
