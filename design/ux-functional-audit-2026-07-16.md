# 全仓界面 / 交互 / 功能 / 错误呈现审计（2026-07-16）

> 审计目标（用户指定）：全面调研当前代码仓的界面显示、交互逻辑、功能性问题与易用性问题，**重点关注错误发生后呈现给用户的提示是否清晰可行动**（而不是一句内部实现的解释）。多人并发竞态类问题按指示降权排除。
>
> 方法：22 个维度的并行代码审计（前端 12 / 后端 8 / 横切 2，共 22 名审计 agent 逐文件读码），产出 185 条 finding 后**逐条**交由独立对抗性复核员核实（要求引用 file:line 推翻或确认、校准严重度）；同时对本机运行中的实例做了真实浏览器目检印证（§6）。最终 **184 条确认、1 条被推翻**；跨维度重复合并后为 **156 个独立问题**。
>
> 所有 file:line 锚点截至 commit `255e6473`（2026-07-16 工作树）。复核员的行号修正已并入正文。

## 0. 结论速览

| 严重度 | 定义                               | 数量（去重后） |
| ------ | ---------------------------------- | -------------- |
| P0     | 功能坏死 / 数据丢失 / 用户永久卡住 | **1**          |
| P1     | 主流程受阻或用户必然困惑不知所措   | **18**         |
| P2     | 明显的易用性 / 文案缺陷            | **87**         |
| P3     | 次要打磨                           | **50**         |

按类别：error-message 69、usability 45、functional 39、display 19、i18n 12（合并前口径）。

一句话总评：**核心链路的"正向路径"工程质量不错（草稿状态机、端口对话框、批量下发的错误码映射等都有全仓级的好样板），但"出错之后"的体验是系统性短板**——错误码翻译层覆盖率仅 ~13%，大量 mutation 失败静默，内部机器码/保留名直出界面；再加上一批画布交互的真实功能 bug 和生命周期死角。绝大多数问题共享少数几个根因（§1），按根因修比逐条修划算一个数量级。

## 1. 系统性根因（修一处赢全局）

### R1. 错误码 → 中文文案的映射层覆盖率 ~13%，`details` 结构化信息全部丢弃

后端以 `DomainError(code, message)` 统一抛错（约 **187 个错误码**），前端 `describeApiError`（`packages/frontend/src/i18n/index.ts:54-63`）只认 `errors` 词典里的 **~24-28 个**键；其余全部落入兜底「请求失败: \<英文开发者原文\>」。更糟的是后端为 UX 精心准备的 `details` 载荷——workflow 校验的逐节点 issues、删除资源时的 `referencedBy` 引用清单、`repo-ref-not-found` 的 `availableRefs` 候选分支、插件安装失败的 npm stderr——**在前端几乎无一处被消费**。受影响面：任务启动、YAML 导入、资源删除、git 操作、评审/反问冲突、定时任务失败……本报告至少 **35+ 条 finding 直接归因于此**。
**修法方向**：把 `errors` 词典按域批量补齐（每码一条「发生了什么 + 下一步」），并给 `ErrorBanner` 增加通用的 `details` 折叠渲染槽（先支持 issues / referencedBy / availableRefs / stderr 四种形状）。全仓做得最好的样板是反问批量下发的 `DISPATCH_ERROR_KEYS` 映射，照抄该模式即可。

### R2. mutation 失败静默：无 onError、无 error 渲染、`void mutateAsync` 吞 rejection

评审评论三操作、任务问题看板三操作、记忆归档/删除、用户停用/启用、运行时测试/设默认/启停、MCP 重新探测、仓库刷新、反问指令开关、反问改派……这些 `useMutation` 只写了 `onSuccess: invalidate`，失败时**界面零反馈**（按钮转一下又恢复），用户无法区分「已生效」与「没生效」。`main.tsx` 的 QueryClient 也没有全局 MutationCache onError 兜底。
**修法方向**：给 QueryClient 挂一个全局 MutationCache onError（toast/横幅兜底），再对高价值表单逐个补局部 `isError` 渲染；建立「新 mutation 必须有失败呈现」的 review 检查项。

### R3. 内部标识直出用户界面

`__wg_clarify__` / `__wg_leader__` / `__workgroup_host__`（首页收件箱、任务列表、反问页、面包屑）、`snapshot-lost` / `scheduler error` / `workgroup hit max_rounds (10)` 等 errorSummary 机器码（任务失败的全部解释面）、裸 node id（右键菜单标题、结构 diff 下拉、跳转按钮）、26 位 ULID（首页任务行首列、技能版本历史作者列）、内部 kind 枚举（检查器标题 `agent-single`）、数据库表名（词条里的 `node_run`）。RFC-145 已在 `node_runs.failure_code` 落了机器可读失败码，但 `grep failureCode packages/frontend/src` **零命中**——本可用于翻译的结构化码没人消费。
**修法方向**：(a) 保留名 → 展示名映射（`__wg_clarify__`→「工作组反问」等，一张小表全站生效）；(b) failureCode → i18n 映射层，errorSummary 原文降级进折叠详情；(c) 所有展示 node id 的地方改为节点显示名。

### R4. 「伪成功」模式：失败被包装成成功信号

- 仓库「刷新」fetch 失败仍返回 200 且 **lastFetchedAt 照样跳成"刚刚"**（违反 shared schema 自己写的「last successful git fetch」语义）；
- 任务启动时 warm fetch 失败静默跑旧镜像，启动表单还固定承诺「会自动同步到远端」；
- 修复弹窗 `resumeTask` 失败返回 200+ok:false，前端当成功静默关窗（`outcomeMessage` 全仓无消费点）；
- 反问/评审/下发三条路由的 resumeTask 均 fire-and-forget，失败只进日志、接口报 ok:true；
- 蒸馏 agent 输出信封损坏时任务照样标 done、0 候选；
- git commit 本身失败被显示成「仅本地提交（推送失败）」。
  **修法方向**：约定「HTTP 200 意味着动作全部生效」；部分失败必须带可渲染的失败字段并在前端强制消费（类型上把 ok:false 的分支做成 non-ignorable）。

### R5. 危险操作确认与快捷键防护不一致

仓库已有 `ConfirmButton`（两击确认）/`ConfirmDialog` 公共原语，但：删除运行时单击直删；记忆审批「拒绝」（不可逆终态）一键直发；账号停用、活动会话撤销一键执行；节点「重试」单击即回滚 worktree + 级联作废全部下游；wrapper 上按 Delete 无确认级联删除全部内部节点（而旁边右键菜单的同语义项有确认对话框）。快捷键侧：评审页 A/R/I 未排除修饰键（**Cmd+A 全选 = 提交通过**），而同仓 `QuestionForm`/`multiDocHotkeys` 都做对了。
**修法方向**：盘一遍所有不可逆 mutation 接 ConfirmButton；单键快捷键统一走一个带修饰键防护的公共 helper。

### R6. 后端给了、前端丢了 / 词条写了、没人接线

除 R1 的 details 外，还有一族"半成品接线"：`dw-generate-exhausted` 的中文指引词条成为死代码；`clarify.ws.toast.othersSubmitted` 词条未接线；反问历史轮列表的整套词条（historyTitle/answeredAt/…）挂空、功能从未实现；`mcps.probe.error.codeMcpDisabled` 词条永远走不到；`review.comment_updated` WS 帧前端无消费者；`errors.http-401/404/409` 三个键对结构化错误体永不命中。
**修法方向**：做一次「孤儿 i18n 键 / 无消费者字段」盘点（可写成 lint 脚本常态化），要么接线要么删除。

### R7. WS 断线重连后不补齐 + 无断线提示

`useWsInvalidation` 拿到 connectionEpoch 却从不使用；只有工作流编辑器实现了「重连即核对」与降级提示。叠加全局 `refetchOnWindowFocus:false` 和多个纯 WS 驱动（无轮询兜底）的界面（记忆审批队列、任务问题看板、蒸馏任务表），合盖挂机/daemon 重启后界面**永久停在旧状态**且无任何提示。
**修法方向**：在 `useWsInvalidation` 统一实现 epoch 变化 → invalidate 规则表内全部 key（useWorkflowSync 已验证的模式），shell 挂全局「连接中断」状态条。

### R8. 终态任务不清场：死任务的待办永久滞留

已失败/已取消任务的反问轮仍在收件箱/徽标里显示「待回答」（本机实测：收件箱 17 条反问几乎全部来自一个已失败任务的 10 轮 + 等待 14-23 天的僵尸轮）；6 月初的评审轮至今挂着「待评审」；问题看板对已死任务还提供「处理待指派问题」入口，回答后答案先落库再弹未翻译的 task-terminal 报错。
**修法方向**：任务进入终态时封存其 open 轮次（收件箱查询按任务状态过滤即可先行止血）；收件箱条目补任务状态徽标。

## 2. P0 / P1 详单（去重合并后 19 条）

> 每条均经独立对抗复核确认（含逃生通道排查与严重度校准）；「维度」列出独立发现该问题的审计视角数。

### F-0（P0）多文档评审上游产出空列表 → 任务永久卡死在 awaiting_review，且评审在所有 UI 入口不可见、不可决策

- 位置：`packages/backend/src/services/review.ts:701-761, 2065-2070`；`packages/backend/src/services/task.ts:3020-3033`
- 现象：`dispatchReviewNode` 多文档分支在上游 `list<path<md>>` 端口为空（itemCount=0）时仍铸 awaiting_review 轮但产生 **0 条 doc_versions**。后果四连：评审收件箱由 doc_versions 驱动 → 列表不出现；`getReviewDetail` 直接 404；画布节点点击目标为 null（不可点）；直接调 API 决策也被 409 `review-doc-version-missing` 拒绝。代码注释宣称「Empty list → park an empty round (approve emits an empty accepted)」，但 approve 路径永远不可达。
- 用户影响：这正是本产品核心 Code→Audit→Fix 工作流的**成功态**——审计 agent 零发现输出空清单——任务却永远停在「等待评审」，无任何入口批准/驳回，唯一出路是取消整个任务丢弃全部进度。复核补充：约 30 分钟后 stuckTaskDetector S1 会产出告警+两个修复选项，但两个选项都会重入同一空分支原地重停（workgroup 任务连告警都被豁免）。
- 建议：空列表轮不 park——自动批准并发布空 `accepted` 端口（与 approveMultiDocReview 空子集语义一致，让下游空转完成）；或铸一条可见的空轮占位 doc_version 让收件箱/详情/决策链路走通。

### F-1（P1）会话中途 401 → 全屏「正在前往登录页…」永不跳转，用户被卡死到手动刷新【3 个维度独立发现】

- 位置：`packages/frontend/src/routes/__root.tsx:66-72`；`packages/frontend/src/api/client.ts:58-61,141,167`
- 现象：任何请求 401 → `clearToken()` → RootShell 在 token===null 时整页渲染 BareShell + 「正在前往登录页…」spinner。但全仓**没有任何代码在 token 清除时执行导航**（跳 /auth 只在 beforeLoad——仅路由切换时运行；QueryClient 无全局 onError；BareShell 无任何可点击元素）。首页 10-60s 轮询使过期会话必然命中。
- 用户影响：会话过期（OIDC session 7 天 TTL）/令牌被撤销后，正在看的页面瞬间整页消失只剩永久转圈，文案还在撒谎「正在前往」；唯一出路是自己想到按 F5。主要影响 OIDC 用户；静态 daemon token 用户仅在轮换时命中。
- 建议：token 变 null 时主动 `router.navigate({to:'/auth', search:{redirect: 当前 href}})`（RootShell 的该分支挂 useEffect 兜底），占位屏加「去登录」按钮防御跳转失败；修复需一并覆盖 client.ts 的 3 处 401 路径。

### F-2（P1）任务失败的全部解释面直接透出英文机器协议串；已持久化的 failureCode 前端零使用【3 个维度独立发现】

- 位置：`packages/frontend/src/routes/tasks.detail.tsx:466-477`、`tasks.tsx:320-328`、`NodeDetailDrawer.tsx:398-403`、`DynamicWorkflowPanel.tsx:183-184`；来源 `runner.ts:1167-1352`、`scheduler.ts:584/2641`、`task.ts:1552/1826`、`dispatchFrontier.ts:417-425`
- 现象：列表红字、详情横幅、节点表错误列、抽屉统计四个表面原文渲染 errorSummary/errorMessage：`snapshot-lost`、`node-timeout: exceeded 600000ms`、`opencode exited with code 1`、`emit <workflow-clarify>, not <workflow-output>`（写给 agent 的祈使句）、甚至 `scheduler stalled — blocked nodes: …(audit S-12)`（内部审计编号）。前端对 recovery 事件已有整套中文映射（describeRecoveryKind），同一批令牌在失败横幅却原样透出——同页两套标准。RFC-145 落的 `node_runs.failure_code` 在前端 grep 零命中。
- 用户影响：每个失败任务必然命中；中文用户既看不懂发生了什么，也不知道该点「继续任务」还是「再次启动」。
- 建议：建 failureCode→i18n 映射层（每码「发生了什么+怎么办」），横幅优先展示映射结果，errorSummary 原文收进折叠详情；stalled 分支的 audit 编号只进日志。

### F-3（P1）Loop wrapper 左缘 catch-all 接受连线后边立即隐形，留下一条不可见、无法选中删除的非法边

- 位置：`packages/frontend/src/components/canvas/nodes/WrapperNodes.tsx:103-105`；`WorkflowCanvas.tsx:1017-1096, 2343-2348`；`packages/backend/src/services/workflow.validator.ts:568-575`
- 现象：loop wrapper 渲染了全高 catch-all target Handle 且 isValidConnection 放行，连线被持久化；但 loop 左侧端口硬编码 `ports={[]}`，xyflow 找不到 targetHandle **不渲染这条边**。后端校验器把它判为 error（英文长句含 edge id 与 'v1'），而 EdgeInspector 依赖点击边打开——边不可见即无法删除。
- 用户影响：拖线到 loop 左缘（真实存在、无红色拒绝反馈的落点）→ 连线凭空消失 → 校验面板一条英文报错指着画布上看不见的 edge id → 任务无法启动；只能 Ctrl+Z / 删源节点 / 删整个 wrapper 解除。
- 建议：isValidConnection 对 target 为 wrapper-git/loop 直接返回 false（红虚线拒绝），或移除 loop 的 catch-all Handle；若保留边语义则必须渲染对应 Handle 保证边可见可删。

### F-4（P1）wrapper 拖进 wrapper 永远不建立嵌套，但视觉上完全像已包含——所见与运行拓扑不一致

- 位置：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1827`（`if (isWrapperKind(dn.type)) continue`，紧邻注释却声称走同一路径）；`canvasClipboard.ts:147,182-191`
- 现象：拖拽结束后两个 wrapper 渲染成两层嵌套矩形（zIndex 均 -1，与真嵌套无法区分），但外层 nodeIds 不含内层。RFC-016 proposal 的用户故事 S4 与验收标准 A4 明确要求拖拽嵌套，属**已立项验收却未实现**；底层原语 wrapperMembership 本身支持。对称方向同样受损：已嵌套 wrapper 拖出矩形也不解除关系。复制/粘贴的克隆落在 wrapper 矩形内同样"看着在圈里、实际在圈外"。
- 用户影响：`git in loop`（循环内每轮取 diff）是设计文档的核心用例，用户用唯一直觉手势搭出来的图保存无警告、运行语义完全不同，静默产出与画面不符的结果。右键「包裹进…」是目前唯一正确路径但不可发现。
- 建议：让 wrapper 拖拽也走 resolveMembershipOnDragStop；或至少在落点在其他 wrapper 内时提示「容器需通过右键『包裹』嵌套」；粘贴/副本落点同理。

### F-5（P1）输入节点 key 逐键即时重命名：中途撞上另一输入节点的 key 会产生重复条目并吞掉对方的启动表单配置，UI 无修复入口

- 位置：`packages/frontend/src/components/canvas/inspector/InputEdit.tsx:58-61`；`syncInputDefs.ts:28-39, 69, 91-95`
- 现象：每个 keystroke 直接 `renameInputKey`（按 `i.key===prevKey` 全量 map 改名，不查重不认节点）。把 `requirement_2` 改名途经中间态 `requirement`（与另一节点撞 key）的那一刻 inputs[] 出现两条同 key 记录，下一个 keystroke 两条连坐改名——**另一节点的 label/kind/required/description 配置被静默覆盖**；syncInputDefs 永久保留重复条目，patchInputDef 也按 key map 无法拆分。校验器 input-key-duplicate 会挡启动，但编辑器内没有任何途径修复（只能删节点重建）。另 onChange 对空串 early-return，导致全选删除无反应。
- 建议：key 重命名改 blur/Enter 提交 + 提交时冲突拒绝；renameInputKey 只改该节点对应的一条；syncInputDefs 对同 key 去重。
- 同族（P2，见 §3）：新建第二个输入节点默认 key 永远是 `requirement`，与第一个静默重名（`nodePalette.ts:226`，去重逻辑查错了集合）。

### F-6（P1）Review 节点「可重跑节点」逗号分隔输入框每敲一个逗号立刻被吃掉，键盘几乎无法输入多值

- 位置：`packages/frontend/src/components/canvas/inspector/ReviewEdit.tsx:187-198, 207-223`；同病 `InputEdit.tsx:156, 213-224`（upload accept 字段）
- 现象：严格受控输入 `value={list.join(', ')}` + onChange 立即 split/trim/filter 写回——键入 `a,` 解析为 `['a']`，join 后逗号被同步删除，永远无法产生尾部逗号。继续敲 B 得到 `AB`（非法 id）被静默存储。仓库明明有 ChipsInput 公共组件（项目规范也要求列表输入走它）未被使用。
- 建议：解析放到 blur/Enter（本地 draft 持有原始字符串），或直接换 ChipsInput；upload accept 字段同改。

### F-7（P1）评审详情页 A/R/I 单键快捷键未排除修饰键——Cmd/Ctrl+A（全选复制）直接把评审提交为「通过」

- 位置：`packages/frontend/src/routes/reviews.detail.tsx:350-388`
- 现象：keydown 只挡了输入焦点等，`if (k==='a') void onApprove()` 对 metaKey/ctrlKey/altKey 零检查；无评论无草稿时 onApprove 不弹确认直接提交，成功即跳走并触发下游续跑，无撤销。对照同仓正确实现：`QuestionForm.tsx:228`、`multiDocHotkeys.ts:27` 都做了修饰键防护——此处是遗漏而非风格。且单文档页没有任何快捷键提示，用户根本不知道这些键存在。Ctrl+R（刷新习惯键）会先弹出驳回对话框。
- 建议：a/r/i 分支前加 `if (e.metaKey||e.ctrlKey||e.altKey) return`（连 shiftKey 一起挡）；补快捷键提示文案。同根因（P3 备注）：ReviewDocPane 的 J/K 跳转同样未排除修饰键。

### F-8（P1）评审评论提交/编辑/删除失败完全静默【2 个维度独立发现】

- 位置：`packages/frontend/src/components/review/ReviewDocPane.tsx:338/344/350, 504-511, 675, 784/797`
- 现象：三个 useMutation 只有 `onSuccess: onInvalidate`，全文件无任何 `.error/.isError` 渲染；`void submitPopover()` 把 mutateAsync 的 rejection 吞成 unhandled rejection。两个宿主（单文档/多文档评审页）只处理自己的决策类错误。无全局 MutationCache 兜底。
- 用户影响：daemon 重启（本仓已知高频：改后端代码即掉 daemon）、网络抖动、轮次已被决策时——写完评论点提交，按钮转一下恢复原状，零报错；草稿虽不丢（draftStore 有持久化），但用户无法区分「已保存」与「没生效」。
- 建议：三个 mutation 补 isError 分支（弹框/气泡内 ErrorBanner），`void` 调用改带 catch。

### F-9（P1）插件安装失败只显示 "plugin install failed (exit 1)"，npm stderr（唯一可定位原因的信息）被丢弃【2 个维度独立发现】

- 位置：`packages/frontend/src/routes/plugins.new.tsx:74`；`packages/backend/src/services/pluginInstaller.ts:44-52`；`routes/plugins.ts:187-204`
- 现象：后端把 stderr/exitCode 放进 ValidationError details，但 `plugin-install-failed` 等 4 个错误码均无中文词条，前端也无任何 details.stderr 消费点。拼错包名、网络不通、registry 报错全部折叠为同一句英文。
- 建议：4 个 install 错误码补中文文案；ErrorBanner 下渲染可折叠 details.stderr（照 McpInventoryPanel 的 errorDetail 折叠块模式）。

### F-10（P1）仓库缓存「刷新」失败零反馈，且 lastFetchedAt 照样跳成「刚刚」——失败被伪装成成功【2 个维度独立发现】

- 位置：`packages/backend/src/services/gitRepoCache.ts:711-739`；`packages/frontend/src/routes/repos.tsx:41-44, 148, 181-183`
- 现象：`git fetch` 失败仅 log.warn，仍无条件推进 lastFetchedAt 并返回 200（违反 shared schema 注释「last successful git fetch」的自身契约）；前端 mutation 完全不读响应体里的 fetchOk/fetchError。批量导入路径反而有 fetch-fail 展示——手动刷新独缺。
- 用户影响：远端删库/凭据过期/断网时点刷新：无报错、「最近拉取」变「刚刚」，用户确信已同步，之后任务跑在旧代码上无从追查。
- 建议：失败不推进 lastFetchedAt（或另存 lastFetchOk 列）；前端读 fetchOk 失败时 ErrorBanner + 行内失败标记。warm path（gitRepoCache.ts:460-470）同病一并修。

### F-11（P1）任务启动时 warm 镜像 fetch 失败被整条链路吞掉，任务静默跑在陈旧代码上，UI 还承诺「会自动同步」

- 位置：`packages/backend/src/services/gitRepoCache.ts:378-398,408`；`task.ts:481-516, 986-998`；`packages/frontend/src/components/launch/RepoSourceRow.tsx:116`
- 现象：warm fetch 失败只 log.warn 且跳过 fast-forward；resolveRepoSourceSingle 的返回值没有 fetch 结果字段，startTask 注释声称 'surfaced after materialization' 实际只进 daemon 日志——无任务事件、无 API 字段、无前端展示。启动表单固定显示「本地镜像会在启动前自动同步到远端」。次生怪象：目标分支是 fetch 失败前不存在的新分支时报「ref not found」（分支明明在远端存在）。
- 建议：fetchOk/fetchError 透传到 startTask 落成任务级 warning（事件或表字段），详情页头部显示「本次运行基于 X 时间的镜像」；或提供 fetch 失败即硬失败的启动项。

### F-12（P1）删除工作流不检查定时任务引用——遗留的启用中定时任务此后每次到点静默失败，连挂 10 次才自动停用

- 位置：`packages/backend/src/services/workflow.ts:272`；对照 `agent.ts:314-329`（deleteAgent 有对称守卫）
- 现象：deleteWorkflow 只查 tasks 表引用；schedule 行保持 enabled，每次 fireSchedule 抛 workflow-not-found、不产生 task 行（触发历史无新条目），recordFailure 累计 10 次才停用且生产 wiring 未配置停用通知。复核补充：可达性比想象更强——workflow-in-use 的 409 文案是 'delete those tasks first'，即系统会主动引导用户先删 task 行再删工作流，然后落入同一陷阱。
- 用户影响：每日定时任务连续 10 天什么都不产出，除非主动打开 /scheduled 看到「失败/连挂」chip 否则毫无感知；且与删代理（409 拦截）行为不一致。
- 建议：deleteWorkflow 加 scheduled_tasks 引用检查，抛 `workflow-scheduled-referenced` 409 并列出定时任务名。

### F-13（P1）daemon 正常重启把运行中任务错标为「已取消 / canceled by user」，且取消态没有恢复入口

- 位置：`packages/backend/src/services/shutdown.ts:24`；`scheduler.ts:6094-6110`；`shared/src/lifecycle.ts:317-319`；`autoResume.ts:66-72`
- 现象：SIGTERM 优雅关停 → 调度器 abort 检查点统一走 cancelTaskRow（与用户手动取消同形、无区分标志）；canceled 不可 resume（转移表/前端按钮/boot 自动恢复三层都不认）。只有超 30 秒未退出的幸存者才标 interrupted——但复核发现幸存者写的是 `daemon-shutdown` 而 autoResume 只匹配 `daemon-restart`，**连幸存者也不会被自动恢复**，问题比原报告更宽。`noderun-status.ts:4-5` 注释自认「users read raw canceled as I cancelled it manually」。
- 用户影响：升级/重启 daemon（或 bun dev watch 重启）时在跑的任务全部显示「已取消」，用户被错误归因且找不到恢复入口，只能整单 relaunch 或钻节点抽屉单节点重试。
- 建议：关停 abort 带 reason，关停路径写成 interrupted + errorSummary='daemon-restart' 与崩溃路径对齐，让 resume 按钮和 boot 自动恢复都覆盖。

### F-14（P1）修复弹窗里 resumeTask 失败被吞：HTTP 200 + ok:false 被前端当成功静默关窗，outcomeMessage 全仓无人展示

- 位置：`packages/backend/src/services/lifecycleRepair.ts:330-344`；`packages/frontend/src/components/tasks/RepairConfirmModal.tsx:48`、`TaskDiagnosePanel.tsx:120`
- 现象：applyRepairOption 在 resumeAfterApply 失败时返回 `{ok:false, outcome:'apply-failed', outcomeMessage}` 但 HTTP 200；前端 onSuccess 无条件 onApplied 关窗，全仓无任何 ok/outcome/outcomeMessage 消费点。且此路径提前 return，目标告警不被 resolve；apply 阶段的状态改动（如把 awaiting_human 翻成 interrupted）已单边生效。
- 用户影响：点「修复」→ 确认 → 弹窗正常关闭像成功了；实际状态被改了一半、续跑失败、告警还挂着，没有一个字解释。
- 建议：前端检查 result.ok===false 时 ErrorBanner 展示 outcomeMessage（映射中文）且不关窗；或后端改 4xx 让既有 ApiError 链路接管。

### F-15（P1）awaiting_human / awaiting_review 的任务既不能取消也不能删除——想放弃的用户没有出口

- 位置：`packages/backend/src/services/task.ts:1896-1901`（服务门陈旧）；对照 `shared/src/lifecycle.ts`（转移表明确允许 cancel from awaiting\_\*）；`tasks.detail.tsx:337`
- 现象：cancelTask 只放行 pending/running；前端同样只在这两态显示取消按钮；任务无 DELETE 路由；clarify 无关闭会话端点。且 `task-not-cancelable` 的中文文案是「该任务已结束，无法取消。」——对 awaiting 态是虚假陈述。唯一绕路：硬着头皮答完必答题让任务 resume、趁 running 取消（费 token 且不可发现）。
- 建议：cancelTask 的 allowedFrom 对齐共享转移表（取消时顺带关闭 open clarify round），前端同步放宽；修正文案。

### F-16（P1）loop 退出条件 port-count-lt 未填 n：编辑器显示 1、运行时按 0 评估——循环永不提前退出、必然烧满迭代后失败

- 位置：`packages/backend/src/services/exitCondition.ts:56,72`；`packages/frontend/src/components/canvas/inspector/WrapperGitLoopEdit.tsx:49,114-123`；`workflow.validator.ts:349-357`
- 现象：parseExitCondition 对缺失 n 静默降级为 0，判定 `count < 0` 恒假。前端显示回退值 1 但仅在用户手动编辑数字框时才持久化 n；loop 默认 exitCondition 无 n 字段，「切到 port-count-lt → 看到 1 → 保存」必然落下无 n 定义。校验器只查 exitCondition 是对象，不校验 kind 合法性与 n（kind 拼错如 YAML 导入 'port_empty' 同样溜过、运行时才炸）。exitCondition.ts 注释「validator forbids missing/malformed exit conditions」与实现脱节。
- 用户影响：即使第一轮就产出空列表，循环也烧满 maxIterations × 每轮全部 agent 的时间和 token，最后以英文 exhausted 报错收场；对照编辑器里的 n=1 完全无法理解。
- 建议：parse 对缺失/非法 n 返回 null 走 invalid 失败路径；validator 加 kind 白名单 + port-count-lt 必填 n≥1；前端选中即写默认 n=1 保证显示与持久一致。

### F-17（P1）MCP「重新探测」失败完全无反馈（422/500/网络错误全静默），词条已备好却永远走不到

- 位置：`packages/frontend/src/components/mcps/McpInventoryPanel.tsx:27-63`；`packages/backend/src/services/mcpProbe.ts:136-143`
- 现象：面板只用 probeMut.isPending/mutate，从不渲染 probeMut.error；后端对停用 MCP 在任何 I/O 前抛 422 mcp-disabled 且不写 probe 行，而 ErrorBox 只渲染持久化行——mutation 级错误全部无 UI 呈现。`mcps.probe.error.codeMcpDisabled` 词条（zh-CN.ts:4460）不可达。
- 用户影响：停用的 MCP 点「重新探测」按钮闪一下恢复原状，状态/清单/时间戳全不变，用户反复点击并认定功能坏了。
- 建议：渲染 probeMut.error（ErrorBanner + describeApiError，errors 补 mcp-disabled）；或 enabled=false 时禁用按钮并提示「先在配置页启用」。

### F-18（P1）除工作流编辑器外，所有 WS 订阅断线重连后不做任何补齐——断线期间的事件永久丢失，全程无断线提示

- 位置：`packages/frontend/src/hooks/useWsInvalidation.ts:47-62`；对照 `useWorkflowSync.ts:91-97`（唯一做对的）
- 现象：useWebSocket 静默指数退避重连并返回 connectionEpoch，useWsInvalidation 原样透传从不使用；6 个消费方（task/tasks/memory/scheduled/distill/clarify）都不做重连核对。叠加全局 refetchOnWindowFocus:false 与多个纯 WS 无轮询界面（记忆审批队列、任务问题看板、蒸馏任务表），构成真丢失而非延迟。后端 `/ws/tasks/{id}?since=N` 事件回放能力存在、前端从未使用（且只覆盖 node.event，不含 clarify/review/task.status——回放只是部分解）。断线提示全仓仅工作流编辑器一处。
- 用户影响：合盖挂机/daemon 重启/网络抖动后：任务状态 chip（3s 轮询）已变「等待人工」，问题看板却一条待答问题都不出现——系统明确告诉用户"在等你"，用户却找不到要答什么，也没有任何「连接已断开」提示；只能碰运气切 Tab 或 F5。
- 建议：useWsInvalidation 统一实现 epoch 变化 → invalidate 规则表全部 key（useWorkflowSync 已验证模式）；shell 挂全局「连接中断」状态条。

## 3. P2 详单（明显缺陷，按审计维度分组）

> 跨维度重复发现已合并；标注「另由 … 独立发现」的条目获得了多个独立审计视角的交叉确认。已并入 §2 的条目不重复列出。

### 3.1 首页与全局导航（fe-home-nav）

- **首页“等你处理”区单个数据源失败被静默吞掉，甚至显示“当前没有等你处理的事项 ✓”的错误空态**
  位置：`packages/frontend/src/components/home/InboxPreviewList.tsx:57`｜类别：error-message
  影响：评审列表接口持续失败（如后端某查询报错）时，用户在首页看到“等你处理 0”和带对勾的“没有待处理事项”，误以为没有待办，漏掉正在阻塞任务的评审/反问；界面没有任何迹象表明数据不完整。
  建议：参照 InboxDrawer 的 InboxFeedErrors 模式：任一源失败即在列表上方渲染一条带重试按钮的窄错误行，同时保留成功一侧的数据；空态仅在两源都成功且为空时展示。

- **Daemon token 登录失败直接透传英文内部消息“请求失败: missing or invalid token”，与密码页的定制 401 文案不一致**
  位置：`packages/frontend/src/routes/auth.tsx:141`｜类别：error-message
  影响：管理员在“Daemon token”页粘贴了错误/截断的 token 点连接，看到中英混杂的“请求失败: missing or invalid token”，既不确定是 token 抄错还是服务问题，也没有“请核对 daemon 启动日志里打印的 64 位 token”这类下一步指引。
  建议：在 handleTokenSubmit 里同样特判 ApiError.status===401，给出中文定制文案（如“token 无效——请核对 daemon 启动时打印的 64 位 token 并完整粘贴”）；或给 errors 表补 'unauthorized' 键。

- **daemon 未启动/断网时，首页与登录页的错误横幅直接显示浏览器英文原文“Failed to fetch”**（另由 前端错误呈现全链路 维度独立发现）
  位置：`packages/frontend/src/i18n/index.ts:55`｜类别：error-message
  影响：中文用户打开首页时 daemon 恰好没起（本项目最常见故障：后端热重载把 daemon 打挂），看到红条只写“Failed to fetch”+重试按钮；完全不知道是服务没启动，也没有“检查 daemon 是否在运行”的指引。登录页同理，用户可能反复重输密码。
  建议：在 describeApiError 里识别 TypeError/网络失败类错误，映射到中文文案（如“无法连接到服务——请确认 daemon 正在运行后重试”），保留原文作次要详情。

- **首页任务行不显示用户起的任务名，首列是 26 位 ULID——同工作流多任务无法区分，与 /tasks 列表页不一致**
  位置：`packages/frontend/src/components/home/task-row.tsx:45`｜类别：display
  影响：用户给任务起了名字（启动向导必填 task name），但首页“运行中/最近完成”每行看到的是“01JXXX…（截断的 ULID）+ 工作流名”；同一工作流并行/连续跑多个任务时行与行完全无法区分，必须逐个点进详情确认。
  建议：task-row 主列改为 task.name（title 提示 ULID），workflowName 降为次要文本，与 /tasks 列表的信息层级对齐。

### 3.2 工作流编辑器·画布交互（fe-canvas-core）

- **拖入第二个『输入』节点时默认 inputKey 永远是 'requirement'，与第一个静默重名——去重逻辑查错了集合**（另由 工作流编辑器·节点检查器 维度独立发现）
  位置：`packages/frontend/src/components/canvas/nodePalette.ts:226`｜类别：functional
  影响：用户拖两个『输入』节点想做两个启动参数（例如需求 + 上下文），画布上出现两个都叫 requirement 的节点；启动任务时表单只有一个输入框，两个节点下游拿到同一个值。全程无报错无提示，用户要自己发现两个 key 相同并手动改名；改名时共享声明的 label/kind/required 还会被转移到改名的那个节点上。
  建议：uniqueInputKey 应针对现有 input 节点的 inputKey 集合去重（从 definition.nodes 收集 kind==='input' 的 inputKey），makeDefaults 的 ctx 需要把这份集合传进来。

- **对已在 wrapper 内的节点执行右键『包裹进 Git/Loop』会造成双重归属：同一节点同时出现在两个 wrapper 的 nodeIds 里**
  位置：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1357`｜类别：functional
  影响：用户右键 loop 内的一个节点选『包裹进 Git wrapper』（想做 git-in-loop），得到的是该节点同时挂在 loop 和新 git wrapper 下的畸形定义：两个 wrapper 矩形互相重叠拉扯，之后拖动该节点时会从『另一个』wrapper 里被移除，画布行为看起来随机且无法理解，运行期归属也不可预测。
  建议：wrapSelection 提交前对已有归属做迁移（从旧 wrapper.nodeIds 移除，或将旧 wrapper 整个视为选区一部分）；至少在选区含已归属节点时弹提示阻止。

- **『全选』（Ctrl+A / 右键菜单）没有任何可见效果，且按 Delete 键删不掉全选内容**
  位置：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1153`｜类别：usability
  影响：用户按 Ctrl+A 或在空白处右键选『全选』，画布毫无变化，以为功能坏了；接着按 Delete 也毫无反应。而实际上此时 Ctrl+C 会复制全部节点——一个看不见的选中状态在暗中生效，行为不可预期。
  建议：selectAll 同时通过 setNodes/setEdges 应用 applySelection（或调 storeApi 的 addSelectedNodes），让高亮与 Delete 键行为同真实选中一致。

- **Delete 键/右键『删除』作用于 wrapper 时会无确认地级联删除全部内部节点，与旁边带确认对话框的『删除（含内部节点）』菜单项完全不一致**
  位置：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:2304`｜类别：usability
  影响：用户点选一个装着七八个节点的 loop wrapper 按了下 Delete（很可能只想删容器保留内容——毕竟菜单里“Unwrap 保留内部节点”和“删除（含内部节点）”是两个选项），整个子图连同内部连线瞬间消失且无确认。虽可 Ctrl+Z 撤销，但如果没注意到就保存了（1 秒自动保存），损失不易察觉。
  建议：Delete 键/普通删除命中 wrapper 时复用 snapshotWrapperDelete + ConfirmDialog 的确认流程，或改为默认等同 Unwrap（保留子节点）并把级联删除留给显式菜单项。

- **非法连线被拒绝时只有一条红色虚线，没有任何文字解释拒绝原因**
  位置：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1034`｜类别：error-message
  影响：用户想给第二个 agent 接同一个 clarify 节点，或给已评审过的 review 换上游，拖过去只看到线变红、松手无事发生——完全不知道是规则禁止（一个 clarify 只能挂一个 agent）还是自己操作不对，只能反复试错或放弃。
  建议：在 isValidConnection 拒绝时通过既有的 canvasNotice/NoticeBanner（或 ConnectDropHint 式跟随光标的徽标）给出一句原因文案，例如『该代理已绑定一个反问节点』；body-drop 落在不支持目标上也给一次性提示。

- **从侧栏拖节点放到 wrapper 内部会被弹到 wrapper 外面，而空 wrapper 上明明写着『把节点拖到这里』**
  位置：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1493`｜类别：usability
  影响：用户按空容器上的提示把侧栏里的 agent 拖进 loop/git wrapper，松手后节点出现在容器外一段距离处（有时隔了一整个节点宽度），没有任何解释；用户要再把它拖进去一次才真正入组，第一次交互直接违背了界面自己给的指引。
  建议：palette 落点命中 wrapper 矩形时改用 `scope: { kind: 'wrapper', wrapperNodeId }` 放置并同步写入 nodeIds（一步入组）；或至少弹 NoticeBanner 说明『新节点已放在容器旁，拖入容器即可加入』。

### 3.3 工作流编辑器·节点检查器（fe-canvas-inspector）

- **输出节点「添加端口」生成的默认名可与现存端口重名，重名瞬间会静默删掉原端口的连线**
  位置：`packages/frontend/src/components/canvas/inspector/OutputEdit.tsx:166`｜类别：functional
  影响：用户在输出节点里删掉一个端口后点「添加端口」，画布上另一个已连好的端口连线当场消失，且没有任何提示说明原因；保存后工作流定义里留下两个同名端口 + 丢失的边，用户只能困惑地手动重连。
  建议：默认名生成改为对现有名字集合递增去重；端口名重复时在行内给出错误提示并暂停边同步（或按行索引而非名字做边 reconcile）。

- **「入边端口」「模板引用但未连入」两个纯展示列表误用可交互的 ChipsInput：× 按钮点了没反应，输入文字回车后凭空消失**
  位置：`packages/frontend/src/components/canvas/inspector/promptRefs.tsx:49`｜类别：usability
  影响：用户看到「模板引用但未连入」里的红色 chip 带 × 按钮，本能地点 × 想清掉这个悬空引用——没有任何反应；或者在框里输入端口名回车，文字消失、什么也没发生，甚至莫名冒出「重复」报错。展示区伪装成编辑区，误导操作。
  建议：改为纯 chip 展示（如 StatusChip / 只读 .chip span 列表），或给 ChipsInput 加 readOnly 形态（不渲染 × 与输入框）。

### 3.4 工作流编辑器·外壳/版本/导入导出（fe-editor-shell）

- **YAML 导入失败时后端英文原文直接透传，schema 校验细节（details.issues）被完全丢弃，用户无从得知哪里错了**
  位置：`packages/frontend/src/components/WorkflowImportDialog.tsx:181`｜类别：error-message
  影响：中文界面用户导入一个手改过的 YAML，schema 不合法时只看到一行『请求失败: YAML definition failed schema validation』——既是英文，也完全不说明是哪个节点/哪个字段/哪一行不合法，用户只能盲目反复改文件重试。覆盖模式下版本被人改过时看到『请求失败: workflow 'xxx' is at version 5, expected 4』，同样是英文技术句。
  建议：为 workflow-yaml-invalid / workflow-yaml-empty / workflow-version-conflict / workflow-import-target-mismatch 补 errors 词典条目；对 workflow-yaml-invalid 把 details.issues 的 path+message 渲染成可读列表（至少显示前几条 zod issue 的字段路径），并区分『YAML 语法错误（含行号）』与『结构不合法（列字段）』两类文案。

- **校验结果列表整体是英文技术文案（含内部节点/边 id、审计编号），且明明带 pointer/target 却不能点击跳转定位到画布节点**（另由 工作流编辑器·节点检查器、i18n 完整性 维度独立发现）
  位置：`packages/frontend/src/routes/workflows.edit.tsx:1069`｜类别：error-message
  影响：用户点『校验』或『启动任务』后，看到一列英文句子里嵌着 'n_01JX...' 这类内部 id；画布上节点显示的是标题/代理名而不是 id，用户必须逐个点开节点人肉比对才能找到出错的那一个。二三十个节点的工作流基本无法定位。点『启动任务 →』被错误阻断时按钮文字恢复原状、无任何『为什么没跳走』的说明。
  建议：issue 渲染成可点击行：利用 target/pointer 调 canvasRef.restoreSelection 选中并居中对应节点/边，同时显示节点标题而非裸 id；message 按 code 建 i18n 映射（code 是稳定 kebab-case，天然适合做词条 key，参数用 target 插值）；launch 被阻断时给一条明确的『存在 N 个阻断性问题，已取消启动』提示并把焦点移到面板。

- **删除工作流被历史任务引用（workflow-in-use）或版本冲突时，横幅显示英文 fallback，且不提供去任务页清理的入口**
  位置：`packages/frontend/src/routes/workflows.edit.tsx:871`｜类别：error-message
  影响：用户在中文界面点『删除』→『确认』后，得到一整句英文；不懂英文的用户完全不知道发生了什么，懂英文的也不知道『去哪里删那些任务』——任务页并没有从这里可达的过滤入口，只能自己去 /tasks 翻。
  建议：为 workflow-in-use / workflow-version-conflict 补中文词条（利用 details.referenceCount 插值：『有 N 个任务引用此工作流，请先在任务页删除它们』），并在横幅上加一个跳转到任务列表（带工作流过滤参数）的按钮。

- **自动保存失败（error 相位）时真实失败原因被吞掉，且文案指引『先导出本地内容』但该状态下根本没有导出按钮**
  位置：`packages/frontend/src/components/workflow-editor/WorkflowDraftStatus.tsx:126`｜类别：usability
  影响：遇到无法通过重试解决的保存失败（例如节点 prompt 太大触发 413）时，用户看到『工作流保存失败——请重试保存，或先导出本地内容』：点『立即重试』永远失败且不告诉原因；想按文案『导出本地内容』却找不到任何可用的导出按钮（header 导出也只会把焦点弹回这条横幅），最终只能放弃修改离开。
  建议：error 相位的 NoticeBanner 增加渲染 state.error 的具体信息（经 i18n 映射后），并把『导出本地 YAML』按钮同样加到 error 相位；对可判定的永久性 4xx 提示『重试不会成功，请修改内容或导出』。

- **打开不存在/已删除的工作流链接：英文 fallback 报错 + 只有一个永远失败的『重试』按钮，没有返回列表入口**
  位置：`packages/frontend/src/routes/workflows.edit.tsx:192`｜类别：usability
  影响：用户点开一个旧书签或别人发来的已删除工作流链接，看到标题是一串 ULID、正文一句英文『请求失败: workflow 01JX... not found』，唯一按钮是点了也没用的『重试』；只能靠侧边栏自己找出路。
  建议：为 workflow-not-found 补中文词条（『工作流不存在或已被删除』），404/403 时把『重试』换成/加上『返回工作流列表』按钮。

### 3.5 任务发起向导（fe-task-wizard）

- **启动失败的常见后端错误（clone 失败/ref 不存在/上传超限等）全部缺 i18n 映射，向导最后一步直接透传英文 git stderr**
  位置：`packages/frontend/src/i18n/zh-CN.ts:6114`｜类别：error-message
  影响：中文用户填完四步点「启动」，等待 clone（提示「正在克隆…」可能持续数分钟）后，在按钮旁看到类似「请求失败: git clone failed for https://github.com/x/y: fatal: Authentication failed for ...」或「请求失败: ref 'dev' not found in ...」的英文技术句；既不知道发生了什么，也不知道下一步该去哪改（第 2 步的 URL/分支输入框），只能自行猜测。
  建议：为 repo-clone-failed / repo-ref-not-found / repo-url-invalid / upload-_（5 个）/ agent-not-found / scheduled-task-_ 等启动链路错误码补齐 zh-CN 与 en-US errors.\* 词条，文案写明「发生了什么 + 检查哪里 / 去哪一步改」；repo 类错误可在向导里附带「返回执行空间」快捷按钮（复用 version-mismatch banner 的 action 模式），git stderr 收进可展开的详情区而不是主文案。

- **必填的 git 类型工作流输入可以以空值通过校验并成功启动任务（前端只查字符串非空，后端完全不校验必填输入）**（另由 任务发起前置校验 维度独立发现）
  位置：`packages/frontend/src/routes/tasks.new.tsx:671`｜类别：functional
  影响：用户在必填分支输入里选了分支又改回占位符（或在手输框里输入后清空），「下一步/启动」保持可点；任务真正启动后 agent 的 prompt 里被注入 {"kind":"branch","ref":""} 这样的空值，跑出一轮结果错乱的废运行，浪费时间和 token，用户还以为是 agent 的问题。
  建议：missingRequired 对 def.kind === 'git' 增加语义级判空：解析 JSON 后按 gitKind 检查 ref / from+to / number 非空（与 enum multiSelect 的 '[]' 特判同一模式）；顺手把 GitPicker 的空占位选项在 required 时移除或选中即视为未填。后端 startTask 也应补一层 required 输入校验兜底。

- **上传文件无任何前端大小/类型校验：超大文件要完整上传到后端才被拒，且报错是含原始字节数的英文**
  位置：`packages/frontend/src/components/launch/UploadPicker.tsx:27`｜类别：usability
  影响：用户拖入一个 500MB 的包（或类型不符的文件），界面正常显示在列表里、启动按钮可点；点启动后浏览器要把整个文件 POST 完，等待良久才在按钮旁看到英文报错和一串字节数，需要自己换算出「超过 10MB 上限」。一次挑了超过 maxCount 数量的文件时，多余的被静默丢掉，用户以为都选上了。
  建议：在 add() 里对照 def.maxFileSize / accept 做即时校验，超限文件不入列并在 picker 内显示中文原因（「xx.zip 超过单文件上限 10 MB」）；超 maxCount 时给出「已达上限，忽略了 N 个文件」提示；字节数展示复用 humanSize()。

- **EnumPicker 的 allowOther 自定义值添加后完全不可见，多选下重复点「添加」还会静默把值删掉**（另由 UI 设计系统一致性 维度独立发现）
  位置：`packages/frontend/src/components/launch/EnumPicker.tsx:63`｜类别：usability
  影响：用户在「其他（自定义）」里输入内容点添加，输入框被清空、列表毫无变化——无法确认是否加上了；不放心再输一遍再点一次，实际反而把值删了，最终任务带着与界面显示不符的输入启动。
  建议：把 current 中不属于 choices 的值渲染成可移除的选中行/chip（可参照 FilesPicker 的 extraSelected 模式：选中但不在列表中的值显示为可取消行），单选模式下自定义值也应作为一个选中的 radio 行出现。

- **定时保存对话框的 HH:MM 时间无前端校验：填 "9:00" 预览一切正常，保存时只报「请求失败: invalid scheduled task」**（另由 记忆/融合/仓库/定时/用户/设置等页面 维度独立发现）
  位置：`packages/frontend/src/components/ScheduleDialog.tsx:254`｜类别：error-message
  影响：用户把每日时间填成 "9:00"（无前导零，非常自然的写法），下方预览正常列出未来 3 次运行时间，点保存却弹出「请求失败: invalid scheduled task」；没有任何信息指向时间字段，用户只能逐项乱试。
  建议：在 spec useMemo 里用与后端相同的 HHMM_RE 校验 at，不合法时 canSave=false 并在字段 hint 显示「请输入 24 小时制 HH:MM，如 09:00」；或直接把输入换成 type="time"。同时给 scheduled-task-invalid 补 errors 映射。

### 3.6 任务列表与详情（fe-task-detail）

- **等待审核/等待回答中的任务无处取消：前端隐藏取消按钮、后端 cancelTask 也拒绝，而共享状态机明确允许 awaiting\_\* → canceled；且 409 文案「该任务已结束」与事实相反**
  位置：`packages/frontend/src/routes/tasks.detail.tsx:337`｜类别：usability
  影响：用户想放弃一个停在「等待审核 / 等待回答」的任务时，详情页只剩「成员」按钮——没有取消、没有继续、没有再次启动（非终态）；唯一出路是绕道打开评审页驳回或去回答反问。若直接调 API 还会得到与状态矛盾的「该任务已结束」提示。
  建议：让 cancelTask 对齐 shared/lifecycle.ts 的 cancel 来源集（awaiting\_\* 可取消，需同步取消挂起的 review/clarify 会话），前端 cancelable 同步放宽；至少先修 'task-not-cancelable' 文案，区分「已结束」与「等待人工处理中」两种拒因。

- **worktree 被清理/迁移后，diff 相关接口的域错误码（task-worktree-missing / task-no-base-commit）没进 errors i18n 映射，用户看到中英混杂的原始报错加一个永远失败的重试按钮**
  位置：`packages/frontend/src/i18n/zh-CN.ts:6114`｜类别：error-message
  影响：打开一个 worktree 已被清理（按产品自己的指引清理、或后台 GC）的历史任务的「工作目录 diff」页签：红色横幅里是英文报错加机器路径，点「重试」永远失败，也没人告诉用户『worktree 已清理，diff 不再可用，可再次启动任务』。
  建议：给 'task-worktree-missing' / 'task-no-base-commit' 补 errors 映射（说明 worktree 已被清理、diff 不可恢复），diff 面板对 410 隐藏重试改为指向「再次启动」，并让终态任务的错误态停掉 6 秒轮询。

- **任务画布上的反问指令开关（继续/停止反问）失败时被静默回滚，界面零反馈**
  位置：`packages/frontend/src/routes/tasks.detail.tsx:1083`｜类别：error-message
  影响：用户在工作流状态画布上点某个反问节点的「停止反问」开关：开关先翻转、约一秒后自己弹回去，没有任何错误提示（403 非成员、网络断开、任务态冲突都会这样）。用户只会觉得开关坏了，反复点击也不知道原因。
  建议：渲染 setDirective.error（复用 ErrorBanner 或画布内 toast），失败时明确说明原因（如需任务成员权限）。

- **节点抽屉的重试失败/事件加载失败用私有 describeError 绕过 i18n 错误映射，直接显示「code: 英文原文」**
  位置：`packages/frontend/src/components/NodeDetailDrawer.tsx:587`｜类别：error-message
  影响：用户在节点抽屉点「重试节点」失败时，看到一串以机器码开头的英文错误，而同样的错误在页面其它位置是中文；事件页签加载失败同理。
  建议：删掉本地 describeError，改用 '@/i18n' 的 describeApiError（与 ErrorBanner 同源）。

### 3.7 评审与反问界面（fe-review-clarify）

- **单文档评审决策弹窗在请求发出前就关闭：失败时呈现假成功信号，错误横幅藏在长文档底部，驳回原因被清空**
  位置：`packages/frontend/src/routes/reviews.detail.tsx:336`｜类别：usability
  影响：用户点「确认驳回」→ 弹窗立即关闭（看起来成功了）→ 若请求失败（网络/daemon 重启/评审状态已变），页面顶部毫无变化，错误横幅在一屏之外的文档底部；用户离开后任务永远停在 awaiting_review。想重试还得重新打开弹窗、重新打一遍驳回原因。
  建议：对齐 MultiDocReviewView：请求 pending 期间保持弹窗打开、错误渲染在弹窗内、成功后才关闭；保留 reason 状态直至成功。

- **评审/反问所有冲突类错误码无中文映射，界面直接透传含内部术语的英文原文**
  位置：`packages/frontend/src/i18n/zh-CN.ts:6114`｜类别：error-message
  影响：单用户常见触发：反问页开着期间任务被取消/该题已在「集中回答」处理过，点「提交并继续反问」→ 中文界面蹦出一整段英文加 ULID 的技术句，既不知道发生了什么（答案到底存没存？）也不知道下一步该刷新还是重填。
  建议：为上述冲突码逐一补 zh/en 词条（如 clarify-round-terminal→「该轮反问已结束（已回答/已取消），无需再提交，刷新页面查看最新状态」；review-iteration-mismatch→「评审内容已更新，请刷新后重新决策」）；未知码回退时至少附「刷新后重试」指引。

- **集中回答弹框部分轮次提交失败后：已成功轮不刷新仍显示可编辑，重试必撞 409 already-sealed**
  位置：`packages/frontend/src/components/clarify/CentralizedAnswerDialog.tsx:298`｜类别：functional
  影响：用户在集中回答里一次填多轮问题，其中一轮因轮次过期失败：错误横幅出现后重试，反而收到「question 'q1' is already sealed…」的英文 409，反复重试都失败，不知道其实一半已经提交成功、另一半怎么救。
  建议：onError 时也 invalidate task-questions 与各轮 detail（让已封存轮从池子里消失/转为重答态），并把 allSettled 的逐轮结果分别呈现（哪几轮成功、哪几轮失败及原因）。

- **任务问题看板的确认/移入待下发/改派操作失败全部静默：点击无响应**
  位置：`packages/frontend/src/components/tasks/TaskQuestionList.tsx:132`｜类别：error-message
  影响：用户点「确认」「移入待下发」或在下拉里改派处理节点，请求失败时卡片纹丝不动、没有任何提示；用户只能反复点击或以为界面卡死。
  建议：为三个 mutation 补 onError → 复用 dispatchError 同款 ErrorBanner（已有 DISPATCH_ERROR_KEYS 的映射模式可扩展），失败后同时 invalidate 让界面回到服务器真实状态。

- **反问详情页对已取消/已封存轮次没有任何状态说明，页脚还显示「草稿已保存（关 tab 不丢）」**
  位置：`packages/frontend/src/routes/clarify.detail.tsx:875`｜类别：usability
  影响：用户从「已取消」过滤列表点开一条反问：看到一页灰掉的问题、两个禁用按钮、外加一句「草稿已保存」——完全不知道这轮是被取消了、还是自己没权限、还是页面坏了。
  建议：readonly 时在表单上方渲染状态 NoticeBanner（复用 clarifyRoundStatusChip 的 kind/label：已回答/已取消/已废弃 + 简短原因），并在 readonly 时隐藏草稿指示器。

### 3.8 资源管理（agents/skills/mcps/plugins）（fe-resources）

- **MCP 表单校验错误直接显示 i18n key 字面量（如 "mcps.errors.commandRequired"）或英文 zod 原文**
  位置：`packages/frontend/src/components/McpFields.tsx:38`｜类别：error-message
  影响：在 /mcps/new 或 /mcps/$name 保存时：命令留空 → 字段下方出现字面量 "mcps.errors.commandRequired"；名称含大写 → 中文界面蹦出一整句英文正则描述。用户看到的是内部 key/英文技术句而非人话。
  建议：McpFields 内对 errors 值统一包 t()（与 PluginFields 对齐），并在 zh-CN/en-US 两个 bundle 的 mcps 下补 errors 子表；zod 兜底分支应映射到通用中文文案而非透传 issue.message。

- **删除被引用资源（agent/skill/mcp/plugin）时错误未本地化，且后端给出的引用方清单（details.referencedBy）被前端整个丢弃**（另由 资源 CRUD 与存储 维度独立发现）
  位置：`packages/frontend/src/components/DetailHeaderActions.tsx:103`｜类别：error-message
  影响：用户点删除 → 看到 "请求失败: mcp 'x' is referenced by 2 agent(s)" 这样的中英混杂文案，既不知道具体是哪几个 agent/工作流在引用，也不知道下一步该去哪里解绑，只能逐个翻所有 agent 排查。
  建议：在 errors i18n map 补齐这批 in-use/referenced code 的中文文案，并在 DetailHeaderActions（或专用组件）渲染 details.referencedBy/workflows/agents 名单为可点击链接，明确指引先解绑再删除。

- **Agent 名称不合法时创建按钮可点、失败后只报 "请求失败: invalid agent payload"，不指明是哪个字段**（另由 资源 CRUD 与存储 维度独立发现）
  位置：`packages/frontend/src/routes/agents.new.tsx:114`｜类别：error-message
  影响：用户把名称写成 "My Agent" 点创建 → 顶部一条既是英文又不说哪里错的横幅；表单五个 tab 几十个字段，用户需要自行猜测是名称格式问题。
  建议：对齐 skills/plugins：客户端提交前用 AGENT_NAME_RE 校验并在名称字段下就地显示中文错误；同时把 agent-invalid 的 details.issues 映射为逐字段提示。

- **依赖树把"描述为空且无 skills/mcp/plugins 的真实 agent"误判渲染为 <缺失>，且不可点击跳转**
  位置：`packages/frontend/src/components/agents/DependencyTree.tsx:41`｜类别：display
  影响：用户给 agent A 挂 dependsOn: [B]（B 是刚建的空白 agent），资源页依赖树预览里 B 显示为 "<缺失> B"、灰色且不可点击，用户误以为依赖已损坏/agent 被删，跑去反复检查甚至重建 B。
  建议：toTreeAgents 透传 wire 上的 missing 字段，DependencyTree 直接消费真实标志，删除启发式判断。

- **技能文件树"新建文件"失败时错误被吞：未选中文件的情况下点添加毫无反馈**
  位置：`packages/frontend/src/components/SkillFileTree.tsx:170`｜类别：error-message
  影响：用户在 Files 标签输入一个后端不接受的路径点"添加"，界面完全没有反应，反复点击也无变化，不知道失败了还是卡了。
  建议：为新建文件用独立 mutation（或独立 error state），把错误渲染在 file-tree\_\_add 输入框下方（现有 newError 位置）。

- **插件"检查更新"结果为已最新时没有任何成功反馈**
  位置：`packages/frontend/src/routes/plugins.detail.tsx:198`｜类别：usability
  影响：用户点"检查更新"→按钮短暂变"检查中"→回到原样，界面无任何变化。用户无法区分"检查成功且已最新"和"检查根本没生效"，往往会再点几次。
  建议：checkUpdate.isSuccess && !updateReady 时渲染"当前已是最新版本（{{version}}）"的确认行。

- **技能 ZIP 导入的解析/提交/逐条失败信息把后端英文 code:message 原文透传进中文界面**（另由 资源 CRUD 与存储 维度独立发现）
  位置：`packages/frontend/src/components/skills/ImportZipPanel.tsx:805`｜类别：i18n
  影响：中文界面的导入审阅页/结果页里出现 "name-conflict: skill 'x' already exists; pick a different name..." 之类内部错误码加英文长句，与页面其余精心本地化的文案（zipRenameConflict 等）割裂。
  建议：为 zip 导入错误码建 i18n 映射（skills.zipError.<code>），未知 code 才落英文原文兜底；结果页 failed 项同样走映射。

- **保存 MCP 配置后列表卡片显示"需重新探测"，而详情 Tools & probe 标签仍显示旧探测的绿色"正常"；且手动重探请求失败被静默吞掉**（另由 运行时与 MCP/插件 维度独立发现）
  位置：`packages/frontend/src/components/mcps/McpInventoryPanel.tsx:31`｜类别：display
  影响：用户改完 MCP 的 command/URL 保存：列表说"未知/需重新探测"，点进详情 probe 标签却是绿色"正常"（针对旧配置的结果），两处自相矛盾；点"重新探测"如果请求失败，界面毫无反应。
  建议：详情面板复用 probeUiStatus 的 freshness 逻辑（陈旧探测显示"需重新探测"并弱化旧结果）；渲染 probeMut.error 与 probeQ 非 404 错误为 ErrorBanner。

### 3.9 记忆/融合/仓库/定时/用户/设置等页面（fe-misc-pages）

- **记忆审批队列的「拒绝」是不可逆终态操作，却一键直发、无确认、无撤销，且拒绝后从所有界面消失**
  位置：`packages/frontend/src/components/memory/MemoryApprovalQueue.tsx:117`｜类别：usability
  影响：「拒绝」和「通过」两个按钮紧挨着；一次误点就把蒸馏出的候选记忆永久丢弃——没有确认、没有 toast、没有撤销入口，卡片直接从队列消失，用户甚至无法再看到这条记忆的内容。
  建议：拒绝走 ConfirmButton/ConfirmDialog 二次确认；或提供 rejected 视图 + 恢复为 candidate 的入口。

- **权限（ACL）弹窗在加载中或加载失败时整个面板 return null，弹窗一片空白且无任何解释**
  位置：`packages/frontend/src/components/AclPanel.tsx:156`｜类别：error-message
  影响：用户点资源详情页的「权限」按钮，弹出一个只有标题的空白对话框，看不出是在加载还是出错了，只能关掉重试或以为功能坏了。
  建议：isLoading 渲染 <LoadingState>；error 渲染 <ErrorBanner error + 重试>；保持 footer 常驻（至少有关闭按钮）。

- **设置页所有子 Tab 的保存失败提示是原始 `code: message` 英文拼接，绕过了已有的错误码本地化**
  位置：`packages/frontend/src/routes/settings.tsx:1743`｜类别：error-message
  影响：中文界面里，管理员在设置页保存出错时看到内部错误码前缀 + 英文原句，不知道具体哪个字段越界、下一步怎么改；与其他页面（走 describeApiError 的 ErrorBanner）风格割裂。
  建议：两处 describeError 统一改调 i18n 的 describeApiError（已存在且能按 code 落中文），需要 code 供调试可放 title/tooltip。

- **定时任务详情把 lastError 内部技术串原样展示（如 `schedule-spec-invalid: …`、`rfc165-…`），无本地化、无下一步指引**（另由 任务发起前置校验 维度独立发现）
  位置：`packages/frontend/src/routes/scheduled.$id.tsx:204`｜类别：error-message
  影响：定时任务触发失败后，用户在状态行看到类似『失败 — schedule-spec-invalid: scheduleTime: no next fire within bound for kind=daily』的内部串，看不懂发生了什么，也不知道该点「编辑任务配置」修复还是重新启用；连挂自动停用时只有 autoDisabled 一句，具体原因仍是英文码。
  建议：按错误前缀/码映射成中文说明 + 修复动作指引（如『启动参数已失效，请点击「编辑任务配置」重新保存』），原始串收进可展开的详情或 tooltip。

### 3.10 UI 设计系统一致性（fe-design-system）

- **多处不可逆/破坏性操作一键直发、无任何确认，与全站 ConfirmButton/ConfirmDialog 惯例断裂**
  位置：`packages/frontend/src/routes/account.tsx:628`｜类别：usability
  影响：用户在 PAT 列表想点"复制"或看错行，误点"吊销"，正在被脚本/CI 使用的 token 瞬间作废且无法恢复，只能重新生成并重新分发；删除运行时/仓库同理，一次误点击直接消失，界面上没有任何"确定吗"的挽回机会。同一个应用里删记忆有确认、删 PAT 却没有，用户无法建立稳定的心理预期。
  建议：不可逆操作（PAT/会话吊销、runtime 删除、repo 删除）统一换成既有 ConfirmButton（行内二次确认）或 ConfirmDialog；至少 PAT 吊销必须加确认。

- **记忆冲突对比弹窗把异常对象 String() 后原样展示给用户**
  位置：`packages/frontend/src/components/memory/MemoryConflictCompareDialog.tsx:59`｜类别：error-message
  影响：用户在审批记忆冲突时打开对比弹窗，左栏"既有记忆"位置出现一行英文技术异常文本（如 'TypeError: Failed to fetch'），中文界面里蹦英文堆栈式文案，且没有重试按钮、不知道下一步该做什么，只能盲目关掉弹窗再开。
  建议：替换为 `<ErrorBanner error={existing.error} action={重试按钮 onClick={() => existing.refetch()}} />`，让 describeApiError 输出本地化的人话文案。

- **23 处直拼 <div className="error-box"> 绕过 ErrorBanner，全站错误外观两套并存、多数不播报**
  位置：`packages/frontend/src/components/ScheduleDialog.tsx:304`｜类别：error-message
  影响：同一个产品里错误提示长两副面孔：任务详情/评审页的错误带图标、结构化排版，而调度弹窗、工作组房间、画布边检查器里的错误是一块光秃秃的红底文字，用户无法凭视觉建立"这是错误"的统一识别；依赖读屏器的用户在 20 处根本听不到错误发生（无 role=alert），表单提交失败后毫无播报。
  建议：把 23 处直拼统一替换为 <ErrorBanner error={...}>（有本地字符串时用 message prop），一次性收敛错误视觉与 a11y 语义；可加一条源代码层文本断言锁住 'className="error-box"' 不再出现在组件里。

- **styles.css 引用 12 个从未定义的主题 token 且多处硬编码浅色值，暗色模式下多个界面元素刺眼或低对比**
  位置：`packages/frontend/src/styles.css:1774`｜类别：display
  影响：暗色主题用户：首页"待处理"分组的警示计数（最需要引起注意的数字）呈暗琥珀色几乎融入背景；打开评审历史版本时页面顶端突兀地出现一整条亮黄色横幅（浅色孤岛）；/repos 的子模块徽章是两个浅蓝/浅黄粉彩色块与周围深色 UI 格格不入。浅色主题用户：任务节点抽屉的重试按钮行下方有一条近黑色的分割线（#2a2a2a fallback），像渲染错误。
  建议：补齐缺失 token 的双主题定义（或直接改用既有 --warn-fg/--warn-fill/--info 系列）；.readonly-banner 迁移到 NoticeBanner tone=warning；.submodule-badge 迁移到 StatusChip；--border-muted 改为 var(--border)。

### 3.11 前端错误呈现全链路（fe-error-surface）

- **任务失败原因直接把后端机器码渲染给用户：任务列表和详情页显示 'snapshot-invalid'、'scheduler error'、'iso-setup-failed: …' 等原文**
  位置：`packages/frontend/src/routes/tasks.detail.tsx:470`｜类别：error-message
  影响：中文界面里任务一失败，用户看到的是『任务失败 snapshot-invalid』或一段英文内部术语（node_run/merge-back/iso 等实现词汇），既看不懂发生了什么，也没有任何『下一步怎么办』（重试？resume？重开任务？）的指引——失败恰恰是用户最需要引导的时刻。
  建议：仿照 describeRecoveryKind 建 errorSummary 代码→中文文案映射表（未知码回退原文放 details 折叠区），失败横幅附带对应动作按钮（resume/重试/重新发起）。

- **daemon 短暂不可用时侧边栏用户菜单误报「当前 Token 无访问权限」，诱导用户误注销**
  位置：`packages/frontend/src/components/UserMenu.tsx:61`｜类别：error-message
  影响：daemon 重启的几秒内，用户侧边栏突然变成黄色感叹号『当前 Token 无访问权限』；不明真相的用户很可能照提示点击注销，把本来有效的会话丢掉，再次登录还要重新找 token/密码——一次瞬时故障被文案放大成误操作。
  建议：区分 useActor 的 error 类型：网络/5xx 显示『暂时连不上服务』且不提供注销按钮；仅 401/403 才显示 token 权限文案。

- **运行时管理：删除运行时单击立即执行且无确认；探测/设默认/启停三个操作失败静默无提示**（另由 运行时与 MCP/插件 维度独立发现）
  位置：`packages/frontend/src/components/RuntimeList.tsx:238`｜类别：usability
  影响：用户在设置页手一抖点到「删除」，运行时立即消失，没有任何『确定要删除吗』；点「测试」或「设为默认」如果请求失败（daemon 抖动、409），按钮弹回原状、界面毫无反应，用户以为点了没生效反复点击。
  建议：删除接入 ConfirmButton；probe/setDefault/toggleEnabled 补 error 渲染（可合并为一条行内 ErrorBanner）。

- **用户管理页：停用/启用账号一键执行且失败静默；角色修改与创建用户的错误直出后端英文原文**（另由 记忆/融合/仓库/定时/用户/设置等页面 维度独立发现）
  位置：`packages/frontend/src/routes/users.tsx:215`｜类别：usability
  影响：管理员点「Disable」停用一个账号没有二次确认（虽可逆但属账号级危险操作）；操作失败时按钮毫无反应，管理员误以为已停用。改角色触发最后管理员保护时，中文界面弹出一行英文原文，需要懂内部术语才能理解拒绝原因。
  建议：disable 加确认；disable/enable 补错误渲染；roleError/create error 走 describeApiError 并为 last-admin-protection 等 code 补中文词条。

### 3.12 i18n 完整性（fe-i18n）

- **后端 187 个错误码中 163 个在前端完全无本地化处理，用户看到「请求失败: <英文原文>」甚至 git stderr 原文**（另由 API 契约一致性、后端错误文案 维度独立发现）
  位置：`packages/frontend/src/i18n/index.ts:62`｜类别：error-message
  影响：中文界面用户在最常见的失败场景里看到中英混杂的技术文案且无下一步指引：新建任务时仓库 URL 拼错 → 横幅显示「请求失败: unsupported or malformed Git URL」；私有仓库克隆失败 → 「请求失败: git clone failed for <仓库URL>: fatal: could not read Username…」（整段 git stderr）；后端任何 500 → 「请求失败: internal server error」；无权限 → 「请求失败: forbidden」。用户既看不懂发生了什么，也不知道该改 URL、配凭据还是重试。
  建议：为高频用户可触达错误码（repo-clone-failed、repo-url-invalid、forbidden、internal-error、agent-not-found、launch 校验族等）补齐 errors._ 双语词条并写明下一步动作；对确实无法穷举的码，把回退文案改为「请求失败（错误码 X），请重试或联系管理员」并将英文原文降级到可展开的详情区；可加一条测试用后端码清单 diff errors._ 键集防继续漂移。

- **OIDC 设置、用户管理、账户、技能 zip 导入等多处绕过 describeApiError，直接渲染后端英文 e.message**
  位置：`packages/frontend/src/routes/settings.tsx:1360`｜类别：error-message
  影响：管理员在中文界面保存 OIDC 配置填错 issuer、创建重名用户、导入损坏的技能 zip 时，看到的是不带任何中文包装的纯英文后端句子（如「issuer metadata fetch failed …」「user name already exists」），与页面其余全中文文案割裂，用户无法确定是自己输入的问题还是系统故障。
  建议：把这些 onError/渲染点统一改为 describeApiError（或 ErrorBanner），需要展示后端原文的场景（如 ModelSelect 的 RFC-114 决策）把英文原文放在次级详情行，主行仍用本地化文案。

- **t() 引用了两个 bundle 都不存在的键 nodeDrawer.inlineRoundsLabel，中文界面显示英文兜底「inline · N rounds」**
  位置：`packages/frontend/src/components/node-session/SessionTab.tsx:141`｜类别：i18n
  影响：中文用户在任务节点详情抽屉切换运行尝试时，下拉里混入英文技术标签「inline · 2 rounds」，与相邻的「第 N 轮」「重试 N」等中文选项同屏混杂；且「inline」是内部会话复用机制的名字，用户无法理解其含义。
  建议：在 Resources 接口与两 bundle 补 nodeDrawer.inlineRoundsLabel（zh 如「多轮反问 · {{n}} 轮」），并删掉代码里的 defaultValue 兜底；可加一条『所有静态 t() 键必须存在于 bundle』的测试防回归。

### 3.13 后端错误文案（be-error-text）

- **OIDC 登录入口未捕获 IdP discovery 失败，用户点「用 X 登录」得到 500 'internal server error'**
  位置：`packages/backend/src/routes/oidc-auth.ts:43`｜类别：error-message
  影响：管理员配好 OIDC 后，只要 IdP 暂时不可达（网络抖动、issuer 配错、内网 IdP 重启），所有用户在登录页点身份提供商按钮都会看到「请求失败: internal server error」——被误导为平台自身崩溃，完全不知道是 IdP 连不上、也不知道该重试还是改用密码登录。
  建议：为 login/start 的 getProviderMetadata 补 try/catch，与回调路径对齐：返回 503 + 标准 {ok:false, code:'discovery-failed', message}，并在 zh-CN errors.\* 加「无法连接身份提供商，请稍后重试或改用密码登录」。

- **OIDC「测试连接」失败时后端诊断原因被整体丢弃，界面只显示 HTTP statusText**（另由 API 契约一致性 维度独立发现）
  位置：`packages/backend/src/routes/oidc.ts:64`｜类别：error-message
  影响：管理员配置 OIDC 提供商后点「测试连接」，失败时只看到「Unprocessable Entity」/「request failed」，不知道是 issuer URL 格式错、网络不通还是 IdP 元数据不合法，只能盲目试错。
  建议：改为标准错误体 throw new ValidationError(result.error, <人话描述>)，或 200 + 判别联合 {ok:false, reason}（plantuml 路由的既有先例），前端按 reason 映射中文提示。

### 3.14 任务发起前置校验（be-launch-validate）

- **启动任务撞上 workflow-invalid 422 时，前端把后端精心构造的逐节点 issue 列表整个丢弃，只显示一行英文兜底文案**
  位置：`packages/frontend/src/routes/tasks.new.tsx:1174`｜类别：error-message
  影响：用户在启动向导填完仓库、输入、名称等所有步骤后点启动，得到一行看不懂的英文错误：不知道是哪个节点、哪个端口出了什么问题，也不知道下一步该去哪修。只能凭经验自己打开工作流编辑器找校验面板。
  建议：给 'workflow-invalid' 加中文文案（如「工作流校验未通过（N 处错误），需先修复才能启动」），把 err.details.issues 渲染为可展开列表（复用编辑器校验面板的 issue 文案），并附「打开工作流编辑器」跳转按钮；更进一步在向导选中工作流时预调 /validate 提前置灰启动按钮。

- **工作流引用的 MCP 被禁用后，launch 校验完全放行，节点在运行期静默丢掉该 MCP 的全部工具**
  位置：`packages/backend/src/services/workflow.validator.ts:74`｜类别：functional
  影响：用户在 MCP 页面一键关掉某个 MCP（界面不提示有 N 个代理依赖它），之后所有用到该代理的工作流任务照常启动、照常跑绿，但 agent 实际拿不到那些工具——产出悄悄劣化，节点详情、任务告警里没有任何「该 MCP 已禁用被跳过」的痕迹，排查极其困难。
  建议：与 plugin 对齐：validator context 增加 mcps 列表，闭包内引用不存在/已禁用的 MCP 分别报 'mcp-not-found'/'mcp-disabled'（error 级，带 agent 名与节点 id）；MCP 禁用开关处提示受影响的代理数。

- **仓库克隆/分支解析失败把 git stderr 原文透传给启动向导，且后端专为 UX 附带的 availableRefs 前端从未渲染**
  位置：`packages/backend/src/services/gitRepoCache.ts:523`｜类别：error-message
  影响：用户填错仓库地址或没配好凭据点「启动」，看到「请求失败: git clone failed for <仓库URL>: fatal: could not read Username for 'https://github.com'…」这类原始 git 输出；填错分支时后端明明算好了「现有分支列表」，用户却看不到，只能自己去 git 里翻。
  建议：为 repo-clone-failed / repo-ref-not-found / repo-url-invalid / repo-file-source-unreachable 增加中文文案：克隆失败区分鉴权/网络/地址不存在三类常见 stderr 并给对应指引；repo-ref-not-found 渲染 details.availableRefs 为可点选的候选分支。

### 3.15 任务生命周期（be-lifecycle-ux）

- **点「继续执行」失败时（快照丢失/子进程未死/工作区被 GC）给用户的是整句英文内部术语，且任务被悄悄翻成失败态**
  位置：`packages/backend/src/services/task.ts:1842`｜类别：error-message
  影响：中文界面用户对「已中断」任务点『继续执行』，得到一条夹着 node_run、pre-snapshot、object database、gc、pid 的英文长句，完全不知道发生了什么；页面上任务状态还突然从「已中断」变成「已失败」。正确的下一步（用『重新发起』按钮从头跑）错误文案里一个字没提。
  建议：给这几个 resume/retry 失败码补 errors.\* 中文词条（说明原因 + 指引『请使用重新发起』），或后端错误码不变、前端针对 409/410 的这几个 code 渲染专用提示条。

- **节点重试的报错绕过了统一错误翻译：直接显示「code: 英文原文」，连已有中文词条的错误码也不翻译**
  位置：`packages/frontend/src/components/NodeDetailDrawer.tsx:586`｜类别：i18n
  影响：在节点抽屉点「重试」失败时，中文界面弹出「错误码: 英文句子」格式的报错——错误码前缀是纯内部实现，英文句子对非英语用户不可读；同样的错误在任务页其它入口却是中文，体验割裂。
  建议：删掉本地 describeError，改用 '@/i18n' 的 describeApiError（其余 5 处本地拷贝——Onboarding/BatchImportDialog/FilesPicker/settings/workflows.edit——同批清理）。

- **节点「重试」单击即执行：回滚 worktree 到重试节点前快照 + 默认级联作废全部下游结果，没有任何确认**
  位置：`packages/frontend/src/components/NodeDetailDrawer.tsx:153`｜类别：usability
  影响：用户在节点抽屉里想看看重试是干嘛的，手一滑点了一下：worktree 文件立刻被 git 重置到该节点执行前的状态，之后所有下游节点的产出作废重跑，已完成任务被重新打开——没有「确定要这样吗」的机会，也没有撤销。
  建议：给重试加与修复一致的确认弹窗（说明会回滚 worktree、cascade 会重跑哪些下游节点），至少对 done 任务/勾选 cascade 时强制确认。

- **「已中断」任务详情的『错误』字段显示机器 slug（daemon-restart / orphan-reconcile / daemon-shutdown / manual-repair-S2），带指引的说明文案永远不展示**
  位置：`packages/frontend/src/routes/tasks.detail.tsx:759`｜类别：error-message
  影响：daemon 重启后用户打开被中断的任务，「错误」一栏赫然写着 `daemon-restart` 或 `orphan-reconcile` 这类内部标识符——不知道是谁的错、要不要担心、该点哪里；节点抽屉里中断节点的错误信息同样只有一个 slug。
  建议：errorSummary 是机器契约就别直接渲染：前端按已知 summary 值映射中文文案（类似 RecoverySection 的 describeRecoveryKind 模式，未知值兜底原文），并把 interrupted 状态的说明/下一步提示（点『继续执行』）纳入渲染。

### 3.16 调度与执行语义（be-scheduler-fanout）

- **loop 达到 max_iterations 后，任务页主按钮「恢复」永远立即再次失败，且界面没有任何指引告知真正的恢复路径（节点级重试）**
  位置：`packages/backend/src/services/dispatchFrontier.ts:330`｜类别：usability
  影响：循环耗尽后用户点击页面上最显眼的「恢复」按钮，任务状态闪一下又变回失败、错误一字不差；反复点击反复失败，用户极易断定任务已死、只能重开任务重跑全部节点——而实际上抽屉里的节点重试本可以从循环处续跑。
  建议：至少两者之一：① runTask/resume 入口检测『本次恢复无任何可派发节点且存在 exhausted 行』时，把 errorSummary 换成指引文案（『循环已达最大迭代数，请在画布中打开该循环节点并使用重试』）；② 前端在 failureCode/message 为 wrapper-loop-exhausted 时，把横幅的跳转按钮直接替换为『重试该循环节点』动作，或隐藏必然无效的恢复按钮。

- **节点状态 exhausted 的中文标签「已耗尽重试」语义错误——它表示循环达到 max_iterations，与重试次数无关**
  位置：`packages/frontend/src/i18n/zh-CN.ts:5973`｜类别：i18n
  影响：循环节点触顶后，用户看到「已耗尽重试」会以为是系统重试机制耗尽、去排查重试配置，而与真实原因（循环退出条件从未满足、迭代数达上限）南辕北辙；配合英文的任务级 exhausted 报错，误导加倍。
  建议：改为「循环达上限」/「已达最大迭代数」一类忠实语义的标签；顺带给该状态的节点抽屉补一句说明（退出条件未满足 + 建议检查 exitCondition 或提高 maxIterations 后节点重试）。

- **动态工作流生成耗尽时用户看到原始代号 dw-generate-exhausted，专门准备的中文指引文案成为死代码**
  位置：`packages/backend/src/services/dynamicWorkflowRunner.ts:357`｜类别：error-message
  影响：动态工作流生成连续失败后，房间面板错误框里只有一串开发者代号 dw-generate-exhausted，没有一个中文字；用户不知道生成为什么失败，也不知道『恢复任务会重置生成预算再试一次』这条已实现的出路（引擎在 resume 时会重置 attempts，代码注释明确这是设计的重试入口）。
  建议：面板改为识别到该失败码时固定展示 t('workgroups.dw.exhausted') 指引文案，把 errorSummary/errorMessage 的原始错误列表放进折叠详情；或后端把 summary 换成 message 里已有的可读句、失败码只进 errorMessage。

- **fanout 分片 iso 建立失败时错误原因被丢弃（只留 'iso-setup-failed'），且分片 node_run 行状态未落库、停留在『待运行』**
  位置：`packages/backend/src/services/scheduler.ts:4926`｜类别：error-message
  影响：分片环境故障时任务失败横幅只有 'iso-setup-failed' 一个词，用户无从判断也无从修复；同时画布/列表里该分片子行显示「待运行」（或「运行中」）与任务级「失败」互相矛盾，用户会误以为还有分片没跑完或在等资源。
  建议：catch 中把底层异常 message 拼进返回值（对齐 718 行格式），并在返回前把分片行 CAS 到 failed（errorMessage 带原因）；5043 的兜底 catch 同理先落库再广播（遵守项目自己的 DB-first 规则）。

### 3.17 反问与评审后端流程（be-clarify-review）

- **clarify/review 全部冲突类错误码无 i18n 映射，中文界面直接弹『请求失败: <英文原文+内部术语>』**
  位置：`packages/frontend/src/i18n/index.ts:62`｜类别：error-message
  影响：单用户日常即可触发：开两个 tab / 回退到旧页面后再提交反问答案或评审决定，会看到一大段英文技术句（control-channel、seal、iteration、awaiting_human），既看不懂发生了什么，也没有『刷新后重试』之类的下一步指引。这类冲突恰是最需要清晰解释的场景（答案其实已被另一处提交）。
  建议：为 clarify-iteration-mismatch / clarify-already-answered / review-iteration-mismatch / review-not-awaiting / review-selection-incomplete / clarify-question-already-sealed / task-terminal / task-question-not-sealed 等一批可被正常操作触发的码补充 zh/en 词条（如『该反问已在其他页面被回答，本页已过期，请刷新』），并让 describeApiError 的兜底文案至少提示『请刷新重试』。

- **已取消任务的反问轮永久滞留在收件箱与徽标里显示『待回答』，回答后答案先落库、再弹未翻译的 task-terminal 报错**
  位置：`packages/backend/src/services/clarifyAutoDispatch.ts:377`｜类别：usability
  影响：取消一个正在反问的任务后，左下角收件箱徽标永远多着一条『待回答』，点开是个死任务的问题；认真填完答案点提交，得到『请求失败: task … is canceled; it will not re-enter scheduling…』的英文报错，且不知道答案其实已被记录（只是永远不会被使用）。徽标数字也永远降不下去，除非用户去『回答』这些死问题来清掉它们。
  建议：取消任务时把其 awaiting_human 的 clarify 轮一并翻成 canceled（与 round 生命周期对齐）；或至少在列表/计数处过滤 canceled 任务，并在详情页对死任务展示只读横幅而不是可提交表单。

- **管理员（本地默认身份）的反问徽标计数只统计自反问，漏掉全部跨 agent 反问**
  位置：`packages/backend/src/routes/clarify.ts:168`｜类别：functional
  影响：单人本地使用（默认 admin token）时，跨 agent 反问（cross-clarify）等待回答不会让左下收件箱徽标 +1：徽标显示 0，但打开收件箱抽屉列表里却有待回答项。用户依赖徽标提醒时会漏掉跨反问，任务停在 awaiting_human 却无人察觉。
  建议：让 admin 快捷路径改为统计 clarify_rounds（status='awaiting_human'）——与列表同一事实源；countPendingClarifications 已无准确语义，应删除或改读 clarify_rounds。

- **快速通道答案被“延迟派发”（dispatchDeferredReason）时前端完全无提示，agent 不重启且问题停在待指派，用户不知要去看板手动下发**
  位置：`packages/frontend/src/routes/clarify.detail.tsx:493`｜类别：usability
  影响：用户提交反问答案后被带到任务详情页，界面显示成功，但 agent 并没有重新跑起来；任务停在 awaiting_human。用户要自己猜到：进任务中心看板 → 找到该问题 → 手动『移入待下发』→ 点『批量下发』。没有任何文案告诉他答案被延迟、也没有告诉他下一步在哪。
  建议：前端在响应带 dispatchDeferredReason 时留在页面或跳转后弹持久提示：『答案已保存，但节点正忙，需在任务中心手动下发』并附看板入口；同时更新 SubmitClarifyAnswersResponseSchema 与 onSuccess 的响应判定到 autodispatch 形状。

- **反问/评审/下发三条路由的 resumeTask 均为 fire-and-forget，真实失败（如 worktree 丢失 410）只进日志，界面报成功但任务永远不继续**（另由 后端错误文案 维度独立发现）
  位置：`packages/backend/src/routes/clarify.ts:389`｜类别：error-message
  影响：用户回答反问或批准评审后界面提示成功并跳转，然而 agent 永远没有醒来，任务状态卡在 awaiting_human/awaiting_review，界面上找不到任何错误。只有去翻 daemon 日志才能发现 worktree 丢失之类的真实原因；普通用户只会觉得『点了没反应』。
  建议：resume 的硬失败应回写用户可见的信号：至少通过 WS 向任务频道广播一条错误事件/任务横幅（『答案已保存，但任务恢复失败：工作树已被删除，请重新创建任务或恢复工作树』），或把 resume 改为同步等待并把可判定的硬失败（410 等）计入响应。

### 3.18 Git/仓库操作（be-git-repo）

- **Git/仓库域全部错误码缺 i18n 映射，中文界面直接透传英文 git stderr 与内部函数名**
  位置：`packages/frontend/src/i18n/zh-CN.ts:6114`｜类别：error-message
  影响：最常见的首用失败场景——URL 拼错、私有仓无凭据、克隆超时——中文用户看到的是『请求失败: git clone failed for <仓库URL>: fatal: Authentication failed…』或『…timed out after 1800000ms』这类英文技术句，没有『发生了什么/下一步怎么做』；'terminal prompts disabled' 这种 stderr 更是无从理解。
  建议：为 repo-clone-failed/repo-url-invalid/repo-ref-not-found/repo-cache-locked/repo-cache-corrupt/repo-file-source-unreachable/task-worktree-missing/worktree-add-failed 等补 errors.\* 中文词条（说明原因+建议动作，如『克隆失败：无法访问远端，请检查 URL 与凭据』），stderr 收进可展开详情；修正超时消息不要暴露函数名，改用人类可读时长。

- **repo-ref-not-found 精心准备的 availableRefs 候选列表从未在前端渲染，ref 输入框也无校验/无候选**
  位置：`packages/frontend/src/components/launch/RepoSourceRow.tsx:106`｜类别：usability
  影响：用户在启动页把分支名打错一个字母，只有点『启动』后才收到英文兜底错误 'ref 'foo' not found in <仓库URL>'，看不到系统其实已经算好的『可用分支列表』，只能自己去别处查正确分支名再回来重试，流程绕远。
  建议：前端识别 err.code==='repo-ref-not-found' 时读取 details.availableRefs 渲染候选（可点击回填）；对已存在于 cached-repos 的 URL，把 ref 字段升级为带自由输入的分支 Select（数据源 /api/repos/refs）。

- **『git commit 本身失败（没有任何提交）』被界面显示为『仅本地提交（推送失败）』**
  位置：`packages/frontend/src/routes/tasks.detail.tsx:1375`｜类别：display
  影响：commit 因 hook/身份问题失败时，用户在节点表看到『仅本地提交（推送失败）』，理解为『改动已经提交在本地分支，只是没推上去』，于是放心清理 worktree 或直接重跑——实际上根本不存在这个提交，未推送的工作只以暂存区形式存在，极易被误删。
  建议：按 commitSha 是否为 null 拆分两个文案：『提交失败（改动仍在工作树，未生成提交）』vs『已本地提交，推送失败』；并考虑在任务头部对含失败 commit-push 行的任务给一条汇总提示。

- **resume/retry 时回滚失败（reset/stash apply 报错）warn-and-continue，节点在脏工作树上重跑且 UI 零提示**
  位置：`packages/backend/src/services/task.ts:2120`｜类别：functional
  影响：用户点『恢复』/『重试节点』后界面显示一切正常，但工作树实际没有回滚成功——失败尝试留下的半成品文件仍在，agent 在其上叠加重跑，产出被上一次的残留污染；用户拿到错误结果也毫无线索指向『回滚失败』这一根因（只有 daemon 日志里有 warn）。
  建议：回滚失败（非 snapshot-missing）至少要落一条 recovery/任务 warning 事件并在任务详情显示『节点 X 回滚失败，本次重跑基于未清理的工作树』；或与 snapshot-missing 一样直接拒绝该次 resume 并给出可行动的提示。

- **删除缓存镜像的确认文案宣称『历史任务的 worktree 保留』，实际删除后这些任务的 diff/恢复/提交全部失效**
  位置：`packages/frontend/src/i18n/zh-CN.ts:3782`｜类别：usability
  影响：用户看到『worktree 会保留』放心确认删除，随后打开历史任务的『工作树差异』页签只见『请求失败: worktree ... is no longer a valid git repository ...』英文错误；若删除时有任务正在运行，该任务会中途莫名失败。文件确实还在磁盘上，但产品承诺的『详情页保留』名存实亡。
  建议：确认文案如实说明后果（差异视图/恢复/自动提交将不可用），running 引用单独列出并默认阻止；task-worktree-missing 补中文词条并附『可从任务重新启动』指引。

- **任务 worktree 的 submodule 初始化失败只写日志，DTO 字段前端从不读取，agent 静默跑在缺内容的仓上**
  位置：`packages/backend/src/services/task.ts:1018`｜类别：usability
  影响：submodule 远端不可达/需凭据时，任务照常启动、界面无任何标记，agent 面对空的 submodule 目录产出错误结论（如『该目录不存在』），用户毫无线索去怀疑 submodule 初始化失败。
  建议：任务详情页在 repos 元数据区渲染 submoduleInitOk=false 的警告 chip（复用 SubmoduleBadge 模式），错误文案带 submoduleInitError 详情。

### 3.19 运行时与 MCP/插件（be-runtime-mcp）

- **新建运行时：先跑最长 60 秒的真实模型冒烟探测，之后才校验名称格式/重名，失败提示还是英文正则**
  位置：`packages/backend/src/routes/runtimes.ts:178`｜类别：usability
  影响：用户填了 "My Runtime" 或一个已存在的名字 + 二进制路径，点保存后等待最长一分钟（后台真实消耗一次模型调用），最后才被一句带正则的英文告知名字不合法/重名，全部探测白跑。
  建议：路由先做名称/协议/重名等零成本校验再跑冒烟；前端用共享的 RUNTIME_NAME_RE 做内联校验；补 runtime-name-invalid / runtime-exists 中文词条。

- **修改运行时二进制路径后，旧二进制的「符合」探测结果仍显示为当前状态（无新鲜度门，MCP 侧已有的 probeFreshness 模式未复用）**
  位置：`packages/backend/src/services/runtimeRegistry.ts:489`｜类别：functional
  影响：管理员把二进制换成一个坏路径并保存，列表仍挂着绿色「符合」chip，直到任务真正派发失败才暴露；反过来修好了二进制，红色「无法启动」也一直挂着误导人。状态与现实不一致。
  建议：binaryPath/configDirEnv/configDirName 变更时后端清空 lastProbeJson（或给 lastProbe 记 probedAt，前端按 updatedAt 做 freshness 门显示「配置已变更，需重新测试」）。

- **运行时冒烟探测的详情文案英文硬编码直出中文界面，带 nonce/protocol/HTTP(S)\_PROXY/exit code 等内部术语，「缺少鉴权」不给恢复指引**
  位置：`packages/backend/src/services/runtimeSmoke.ts:312`｜类别：i18n
  影响：中文用户点「测试二进制」后，chip 是中文但下面的解释是整段英文技术句；看到「缺少鉴权」不知道下一步该登录哪个 CLI；删除/禁用被拒时收到英文长句。
  建议：detail 改为结构化 code（+参数），前端按 outcome 出中文文案与恢复动作（登录命令、代理设置入口、重试按钮）；errors bundle 补齐 runtime-\* code。

### 3.20 资源 CRUD 与存储（be-resource-mgmt）

- **记忆列表的归档/取消归档/删除操作失败时错误被完全吞掉，界面毫无反应**（另由 前端错误呈现全链路 维度独立发现）
  位置：`packages/frontend/src/components/memory/MemoryAllList.tsx:89`｜类别：usability
  影响：用户在「记忆-全部」页点删除→确认，弹窗关闭后行还在列表里，没有任何错误提示、没有 toast、没有 banner。用户以为没点上，再点一次还是同样结果，完全无法得知失败原因（例如该记忆已进入终态不可删），陷入反复重试的困惑。归档/取消归档同理。
  建议：给三个 mutation 增加错误展示：最小改法是在列表上方渲染 <ErrorBanner error={archive.error ?? unarchive.error ?? del.error}/>；或把确认弹窗保持打开直到 mutateAsync 结束，失败时在弹窗内展示 describeApiError 结果。

- **技能 ZIP 上传先用 unzipSync 全量解压再做单文件/总量检查，高压缩比 zip 可把 daemon 内存打爆**
  位置：`packages/backend/src/services/skill-zip.ts:71`｜类别：functional
  影响：用户（或误传了超大数据集/被构造的 zip）在「技能-ZIP 导入」上传一个 64MB 以内但解压后极大的 zip：轻则请求长时间无响应后报『zip-decode-failed』，重则单进程 daemon 被 OOM 杀死——所有运行中的任务变成 interrupted，Web 界面整体 503。
  建议：解压前读 zip 中央目录里声明的 uncompressed size 做预检（fflate 的 Unzip 流式 API 或手动解析 central directory），超过 perFileBytes/totalBytes 直接 422；或改用流式解压边解边计数，超限即中止。

- **蒸馏代理输出信封缺失/JSON 损坏时任务照样标记 done、0 候选，用户侧无任何警示**
  位置：`packages/backend/src/services/memoryDistiller.ts:780`｜类别：functional
  影响：代理输出格式稍有偏差（少了信封、端口名拼错、JSON 带尾逗号），一次本应产出候选记忆的蒸馏静默变成『成功且 0 条候选』。管理员在 Distill Jobs 页看到绿色 done，审批队列却始终空着，只能去翻 daemon 日志或逐个打开会话记录才能发现解析失败。
  建议：把 parse 阶段的 warning 持久化到 job 行（如 parse_warnings 列或复用 lastError + 新状态 done_with_warnings），列表页对『done 且 0 候选且有警告』的任务显示警示 chip，详情页展示具体原因。

### 3.21 API 契约一致性（api-contract）

- **errors.http-401/http-404/http-409 三个 i18n 键对结构化错误体永远不命中（后端 401 码是 'unauthorized'），登录页令牌校验失败显示中英混杂兜底文案**
  位置：`packages/frontend/src/i18n/zh-CN.ts:6115`｜类别：i18n
  影响：用户在登录页粘贴了错误/过期的 daemon token，得到的是「请求失败: missing or invalid token」这样的中英混杂句，而不是已经写好的中文提示「未授权 — 请重新登录并粘贴 token。」；同理所有 404/409 的通用中文文案也从未生效。
  建议：把这三个键改名/复制为后端真实语义码（unauthorized 等），或在 describeApiError 未命中语义码时再按 `http-<err.status>` 查一次表（用 ApiError.status 而不是 code），一行即可救活现有文案。

### 3.22 WS 实时性与多标签同步（ws-realtime）

- **工作流列表页没有订阅 /ws/workflows 也没有轮询——该 WS 通道声明的两大用途之一（列表同步）实际无人消费**
  位置：`packages/frontend/src/routes/workflows.tsx:79`｜类别：functional
  影响：同一用户开两个标签页：在标签 B 新建/重命名/删除工作流后，标签 A 的 /workflows 卡片墙永远停留在旧状态（不切路由就不会 remount refetch，窗口聚焦刷新又被全局关闭）。用户会看到已删除的工作流卡片还在，点进去才发现不可访问；新建的工作流在另一个标签里「不存在」，误以为创建失败而重复创建。
  建议：在 workflows.tsx 挂一个最简订阅（可直接复用 useWorkflowSync，workflowId 传 null——其规则表本就对每个 created/updated/deleted 帧 invalidate ['workflows']，且自带重连核对），或退而给列表 query 加 refetchInterval 兜底。

- **仓库批量导入弹窗：WS 掉线后进度表永久冻结，无重连补拉、无轮询、无提示，恢复方法（关掉重开）不可发现**
  位置：`packages/frontend/src/components/repos/BatchImportDialog.tsx:135`｜类别：functional
  影响：用户粘贴几十个 URL 开始批量导入，盯着进度表：某行「克隆中…」十分钟不动（实际上后端早已完成/失败），完成计数不再前进，「重新导入」按钮因 state 永远不是 completed 而不出现。用户以为导入卡死；实际上主表 /repos 里仓库都已导入成功——弹窗与事实完全脱节。
  建议：利用 useWebSocket 已返回的 connectionEpoch：epoch 变化时重新 GET 一次批次快照（与 reopen 路径共用同一函数）；或给进度视图加一个「存在非终态行时每 5s 重拉快照」的轮询兜底。

## 4. P3 清单（次要打磨）

### 首页与全局导航（fe-home-nav）

- **“运行中”分组的“查看全部 →”跳到 /tasks?status=running，把该分组包含的 awaiting_human/awaiting_review 任务过滤掉，数字对不上**（`packages/frontend/src/components/home/TaskFeed.tsx:59`）
  影响：首页显示“运行中 (5)”（3 个 running + 2 个等待人工），点“查看全部”后任务列表只有 3 条；最需要用户处理的 2 个 awaiting 任务恰好从“全部”里消失，用户以为数据丢了或首页在骗人。

- **运行时状态探测接口出错时，首页状态行永远停留在“检查中…”，错误被吞且无重试入口**（另由 运行时与 MCP/插件 维度独立发现）（`packages/frontend/src/components/home/HomepageGreeting.tsx:178`）
  影响：接口持续失败时，用户看到首页运行时状态一直“检查中…”，无从得知探测已失败、更不知道去哪查（该行本是发现 opencode 未安装的第一入口）；与旁边加载失败会显式报错+重试的能力磁贴形成对比。

### 工作流编辑器·画布交互（fe-canvas-core）

- **右键菜单标题暴露内部节点 id 而非节点名称，且菜单不做视口/画布边缘钳位**（`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1957`）
  影响：用户右键一个节点想确认操作对象，看到的是一串机器 id 而不是节点名；在画布底部右键时菜单被截断，最常用的删除项落在屏幕外。

- **系统内没有任何代理时，侧栏『代理』分区只剩一个空标题，无空状态说明和去创建代理的入口**（`packages/frontend/src/components/canvas/EditorSidebar.tsx:53`）
  影响：新用户首次建工作流（还没创建过任何代理）打开编辑器，侧栏『代理』栏目下空空如也，没有一句『尚无代理，去 /agents 创建』的指引——而代理节点恰是工作流的核心，用户不知道下一步该去哪里。

### 工作流编辑器·节点检查器（fe-canvas-inspector）

- **agent 节点引用的代理被删除/改名后，检查器下拉显示成「未选择」，悬空引用不可见**（`packages/frontend/src/components/canvas/inspector/AgentSingleEdit.tsx:53`）
  影响：代理被删除或改名后，画布节点卡片上还挂着旧代理名，但打开检查器却像从没选过代理一样；用户不知道这里有一个悬空引用，直到启动任务被英文校验错误挡下才发现，且很难对应回这个节点。

- **边检查器里把端口名清空后失焦：输入框停留在空白但改名被静默丢弃，界面与实际状态不一致**（`packages/frontend/src/components/canvas/EdgeInspector.tsx:48`）
  影响：用户清空端口名想重新命名，失焦后输入框空着、没有报错，用户以为改成了空名或不知道发生了什么；切走再切回来发现旧名字还在，产生「编辑不生效」的困惑。

- **节点检查器标题栏直接显示内部 kind 枚举值（agent-single / clarify-cross-agent），未走 i18n**（`packages/frontend/src/components/canvas/NodeInspector.tsx:108`）
  影响：中文用户打开任何节点的检查器，第一眼看到的是 'clarify-cross-agent' 这类工程术语，与整个界面的中文风格割裂，新用户无法把它和侧边栏的「跨代理反问」等中文名对应起来。

- **upload 输入的 targetDir 非法时错误文案渲染在灰色 hint 槽位，且非法值照常自动保存**（`packages/frontend/src/components/canvas/inspector/InputEdit.tsx:194`）
  影响：用户把输入类型切成 upload 后，「必须填 targetDir」的错误长得和普通灰色说明一模一样，很容易被无视；工作流看似保存成功，直到启动任务才被拦下。

### 工作流编辑器·外壳/版本/导入导出（fe-editor-shell）

- **冲突/终态『另存为副本』对话框用私有 describeError 裸拼 `code: message`，完全绕过 i18n 错误映射**（`packages/frontend/src/routes/workflows.edit.tsx:1109`）
  影响：用户在版本冲突时按推荐点『另存为副本（推荐）』，创建失败（网络错误、名称问题等）时对话框里出现 'workflow-name-invalid: workflow name must start with [a-z0-9]...' 这类内部 code 前缀的英文串，而同样的错误在新建工作流对话框里是正常中文——用户在最需要挽救数据的场景反而遇到最差的报错。

- **校验问题列表无最大高度：错误多时在 overflow:hidden 的编辑器页里把画布挤到消失，超出部分被裁剪且无法滚动**（`packages/frontend/src/routes/workflows.edit.tsx:898`）
  影响：工作流问题较多时点一次『校验』，画布区域被错误列表挤压成一条缝甚至完全不可见，列表尾部的错误也被裁掉读不到；用户还无法关闭这个面板（没有关闭按钮），只能改好草稿让它变 stale。

- **导出 YAML 在文件已成功取回后，仅因用户期间动了一下草稿就丢弃下载并报『草稿发生了变化』**（`packages/frontend/src/routes/workflows.edit.tsx:654`）
  影响：用户点『导出 YAML』后顺手拖动了一个节点，得到的不是文件而是一条让人摸不着头脑的报错——『我只是挪了下节点，为什么导出失败了？』；必须停手不动重新导出一次。

### 任务发起向导（fe-task-wizard）

- **EnumPicker 单选 radio 的 name 按选项文本生成：两个含相同选项的 enum 输入会互相取消选中且 React 不纠正，界面显示与提交值不一致**（`packages/frontend/src/components/launch/EnumPicker.tsx:68`）
  影响：工作流有两个都含「是/否」选项的 enum 输入时，用户先在 A 选「是」、再在 B 选「是」，A 的选中标记凭空消失；确认页与实际提交却仍带着 A 的值，用户以为漏填了又回去点一遍，反复困惑。

- **上传上限提示直接渲染原始字节数：「单文件上限：10485760 字节」**（`packages/frontend/src/i18n/zh-CN.ts:5359`）
  影响：上传输入下方显示「单文件上限：10485760 字节」，用户需要心算才知道是 10MB；与旁边文件列表里已经人性化显示的「3.2 MB」风格不一。

- **编辑定时任务时若 workflow 详情加载失败，确认页保存按钮被禁用但没有任何原因提示（错误横幅只渲染在第 3 步）**（`packages/frontend/src/routes/tasks.new.tsx:1370`）
  影响：用户从定时任务详情点「编辑配置」进向导、直接切到确认页准备重存，发现保存按钮灰着，页面上没有任何说明（workflow 已被删/网络失败的横幅藏在第 3 步）；用户不知道该做什么，只能逐步乱点排查。

### 任务列表与详情（fe-task-detail）

- **提交并推送行把「N 个文件，+X/-Y」渲染进「耗时」列、把 pushError 原始 git 报错渲染进「错误」列，列头与内容错位**（`packages/frontend/src/routes/tasks.detail.tsx:1437`）
  影响：开启自动提交推送的任务，在「节点运行」表里看到「耗时：3 个文件，+12/-4」这样牛头不对马嘴的单元格；推送失败时「错误」列是一段英文 git stderr。

- **节点运行表耗时永远以原始秒数显示（小时级运行显示为 3712.4s），开始列只有时分秒无日期**（`packages/frontend/src/routes/tasks.detail.tsx:1352`）
  影响：跑了一小时的节点在表里显示「3712.4s」，用户需要心算；隔夜恢复的任务里两个都显示「09:15:02」的运行分不清是昨天还是今天。

- **结构 diff 的「范围」下拉直接拼接原始节点 id 与英文状态（node_a1b2 · failed），与全页已本地化的节点名/状态词不一致**（`packages/frontend/src/routes/tasks.detail.tsx:864`）
  影响：中文界面里，结构页签的范围下拉出现「node_01H8… · done」「node_x · awaiting_review」这类英文/内部 id 混排选项，用户难以对应到画布上的节点。

- **画布上点击尚未运行的节点毫无反应（不开抽屉、无任何提示），点击像失灵**（`packages/frontend/src/routes/tasks.detail.tsx:1222`）
  影响：任务刚启动或长链路前期，用户点击下游灰色节点想看它的配置/预期输入：节点被选中高亮，但页面没有任何面板或提示（如「该节点尚未开始运行」），用户以为界面卡了。

- **Markdown 预览页的「← 返回」链接丢失来源页签，总是回到任务详情默认 tab**（`packages/frontend/src/routes/tasks.preview.tsx:74`）
  影响：用户在「输出」页签点「预览」，看完点「← 返回」，落回的是「工作流状态」画布而不是刚才的「输出」页签，需要重新点回去（浏览器返回键可以，但页内返回按钮行为不一致）。

### 评审与反问界面（fe-review-clarify）

- **反问提交没有任何「未答题」校验或确认，键盘流可把整轮空答案一路 Enter 提交出去**（`packages/frontend/src/routes/clarify.detail.tsx:885`）
  影响：用户连按 Enter 或误触提交，把全空/半空的答案整轮交给 agent：消耗一次反问轮次、agent 拿着空反馈继续跑，且该轮随即封存不可撤回。

- **评审详情把英文枚举值直接内插进中文文案：「决策：pending」「上一版 v1（rejected）」**（`packages/frontend/src/routes/reviews.detail.tsx:621`）
  影响：中文界面用户在页头看到「当前版本 · 已迭代 2 轮 · 决策：pending」，历史横幅看到「正在查看版本 v1（rejected）」——中英夹杂且 pending/iterated 等词对非技术用户无意义。

- **反问截断警告直接渲染内部错误码和英文 detail，现成的中文词条挂空未用**（`packages/frontend/src/routes/clarify.detail.tsx:707`）
  影响：agent 超发问题被截断时，中文用户在警告条里看到一行方括号错误码加英文句子，不明白发生了什么、是否影响作答。

### 资源管理（agents/skills/mcps/plugins）（fe-resources）

- **技能版本历史把 authorUserId（ULID）当作用户名直接显示**（`packages/frontend/src/components/skill/SkillVersionHistory.tsx:151`）
  影响：历史标签每行显示类似 "… · 由 01J8G3K9WXYZ… 修改" 的 26 位 ULID，用户无法知道是谁改的，长 id 还拉宽表格列。

### 记忆/融合/仓库/定时/用户/设置等页面（fe-misc-pages）

- **定时任务详情页的「编辑」按钮对降级行（scheduleSpec 解析失败）点击无任何响应**（`packages/frontend/src/routes/scheduled.$id.tsx:267`）
  影响：正需要修复坏配置的用户（看到黄色降级提示后）点「编辑」按钮毫无反应，既不弹窗也不报错；正确入口其实是旁边的「编辑任务配置」，但界面没有任何指引，用户会反复点击并认为页面坏了。

- **账号页「活动会话」不标识当前会话，一键撤销无确认——撤销自己正用的会话会立刻被登出**（`packages/frontend/src/routes/account.tsx:720`）
  影响：用户想清理陌生会话时无法分辨哪一行是自己正在用的浏览器；点错一行立即被踢出登录、正在编辑的内容丢失，且事前没有任何确认或警示。

- **记忆卡片「编辑」按钮在详情请求慢/失败时点击无响应：编辑弹窗只在详情数据就绪后才挂载，错误从不展示**（`packages/frontend/src/components/memory/MemoryApprovalQueue.tsx:164`）
  影响：用户点「编辑」后界面毫无变化（慢网下也没有加载指示），只能反复点击；请求失败时该按钮永久失效且无解释。

### UI 设计系统一致性（fe-design-system）

- **画布检查器与启动表单成簇绕过 Form 原语：原生 <input className="form-input"> ×9 + 第二套行内错误样式**（`packages/frontend/src/components/canvas/inspector/InputEdit.tsx:228`）
  影响：启动表单里仓库 URL 填错时的红字提示比其他表单的校验错误小一号且不被读屏器播报（错误出现时静默）；同一个字段还会同时显示 hint 和 error 两行（Field error prop 本会用 error 替换 hint）；画布检查器的数字字段与全站 NumberInput 行为存在细微分叉，后续任何 form-input 样式演进都会漏掉这 9 处。

- **复选框无公共原语：11 个组件各自手写 <input type="checkbox">，仅 2 处有主题化**（`packages/frontend/src/components/launch/FilesPicker.tsx:178`）
  影响：用户在同一个应用里看到两种勾选框：账户 PAT 授权页/反问表单里是应用主题色的勾选框，而 diff 已读标记、记忆多选、文件挑选器、依赖检测弹窗里是浏览器默认蓝色勾选框，与应用 accent 色并排出现时明显违和；每处的行高/间距也各自为政（.checkbox-inline、.fusion-picker**row、.worktree-diff**viewed 等一次性 class）。

### 前端错误呈现全链路（fe-error-surface）

- **反问处理人改派（reassign）失败静默：下拉选择后无任何成功/失败反馈，选项悄悄弹回**（`packages/frontend/src/components/clarify/ClarifyQuestionHandler.tsx:50`）
  影响：用户在反问页把问题改派给上游节点，点完下拉后如果后端拒绝（任务已结束、权限、网络），下拉框静静跳回原值，没有任何文字说明——用户不知道改派失败还是界面延迟，可能反复操作。

- **路由层无自定义错误/404 组件：组件渲染崩溃显示 TanStack 默认英文「Something went wrong!」开发者界面，未知 URL 显示裸文本「Not Found」**（`packages/frontend/src/router.tsx:136`）
  影响：一旦某页面因数据异常触发渲染错误，中文用户看到一屏无样式的英文开发者报错，唯一出路是手改地址栏；点开一个过期书签/失效深链则看到孤零零的英文 'Not Found'，没有任何返回导航。

### i18n 完整性（fe-i18n）

- **节点详情抽屉把数据库表名 node_run 和内部标记 session=inline 当作正式 UI 文案写进两语言词条**（`packages/frontend/src/i18n/zh-CN.ts:5865`）
  影响：用户点开任意任务节点查看详情，抽屉标题上方类型行显示「node_run」，统计区会话 ID 旁挂着「session=inline」徽标——数据库表名和调试标记直接出现在正式界面上，中英文用户都无法理解，且与全中文界面风格冲突。

- **记忆候选行 tooltip 暴露内部 RFC 编号与 distiller 术语，en-US 版还中英混杂**（`packages/frontend/src/i18n/zh-CN.ts:6392`）
  影响：用户在记忆审批页 hover 语言徽标，看到「（RFC-050）」这种指向仓库内部设计文档的编号和「distiller」内部组件名；切到英文界面时 tooltip 还是中英混杂的病句，显得不专业且无信息量。

### 后端错误文案（be-error-text）

- **个别路由返回非统一错误体（{error: string} / 缺 message），共享解码器无法解析导致信息清零**（`packages/backend/src/routes/tasks.ts:308`）
  影响：命中这些路径时用户只看到「请求失败」三个字加不上原因：如粘贴超过 64KB 的 PlantUML 源码时（413）评审页只显示 'request failed'，不知道是内容太大。

- **zod 校验错误以原始 JSON 数组或英文默认句作为 message 直接下发**（`packages/backend/src/routes/cached-repos.ts:61`）
  影响：运行时管理表单或仓库批量导入的 body 校验失败时，用户看到一屏 JSON 内部结构或英文 zod 术语，完全无法对应到哪个输入框填错了。

### 任务发起前置校验（be-launch-validate）

- **定时任务列表把任何一次触发失败都标成「需修复」badge，与真正需要修复的损坏行混为一谈**（`packages/frontend/src/routes/scheduled.tsx:169`）
  影响：用户看到「需修复」会点进详情找修复入口，却发现配置完全正常、degraded banner 也不出现，产生「到底哪里坏了」的困惑；真正损坏（需要重填配置）的行反而失去了视觉区分度。

### 任务生命周期（be-lifecycle-ux）

- **自动恢复熔断器把「成功」的恢复也计数：1 小时内重启 daemon 4 次就会隔离健康任务，横幅还谎称「反复自动恢复失败」**（`packages/backend/src/services/recoveryBreaker.ts:59`）
  影响：开了 boot 自动恢复的用户连续重启几次 daemon 后，任务突然不再自动续跑，详情页出现黄色「自动恢复已暂停」横幅并声称『反复自动恢复失败』——用户被错误告知任务在失败循环，需要手动逐个点「解除隔离」。

- **repair-preflight-stale 报错把 i18n key 原文嵌进英文句子透传给用户**（`packages/backend/src/services/lifecycleRepair.ts:284`）
  影响：修复确认弹窗里出现夹着未翻译 i18n key 的英文错误——用户既读不懂原因，也不知道「re-diagnose」对应界面上的哪个按钮（实际是关掉弹窗点『重新扫描』）。

### 调度与执行语义（be-scheduler-fanout）

- **fanout 分片源为空列表时包装器瞬时完成、不铸任何分片，界面无任何说明，下游拿到空字符串继续执行**（`packages/backend/src/services/scheduler.ts:4332`）
  影响：典型 Code→Audit 工作流里 worker 没产生任何改动时，用户看到审计 fanout 秒变绿色完成、点开却一个分片都没有，容易误判为调度漏跑；更困惑的是下游修复节点还会带着空输入真的跑一轮代理、产出无意义结果。

### 反问与评审后端流程（be-clarify-review）

- **手动新增问题表单把从未运行过的节点列为可选处理节点，选中后被后端以英文原文拒绝**（`packages/frontend/src/components/tasks/QuestionAuthorForm.tsx:77`）
  影响：任务早期（下游节点还没跑到）新增手动问题时，下拉里一半选项其实不可用；用户填完标题正文选好节点点提交，得到一段英文技术句，不明白为什么这个节点不行、也不知道该等它跑过一次再来。

### Git/仓库操作（be-git-repo）

- **工作目录预览把 <2MiB 的二进制文件按 UTF-8 强解码塞进 <pre>，显示乱码且无『二进制文件』提示**（`packages/backend/src/services/worktreeFiles.ts:213`）
  影响：用户在『工作目录』页签点开 png/pdf/sqlite 等小于 2MiB 的二进制文件，右侧出现大片 � 替换字符乱码，没有『这是二进制文件，请下载查看』的说明，看起来像文件损坏或页面 bug。

- **冷克隆在 POST /api/tasks 请求内同步执行（默认上限 30 分钟），仅一行静态提示、无进度、无法取消**（`packages/backend/src/services/task.ts:1408`）
  影响：对大仓库首次直接启动任务：按钮转圈数分钟到数十分钟，用户既看不到进度也不能取消；中途断连得到一个含糊的网络错误，不知道克隆其实还在进行、也不知道该等还是该重试。超过 30 分钟则得到英文超时错误（见 i18n 缺失条目）。

### 运行时与 MCP/插件（be-runtime-mcp）

- **「测试」按钮验证的配置与真实派发不一致：冒烟不带该运行时行上的 model 和 config-dir 覆盖，可能给出假「符合」**（`packages/backend/src/routes/runtimes.ts:264`）
  影响：给运行时配了不存在的 model（或依赖 config-dir 覆盖的定制 fork）后点「测试」显示绿色「符合」，但每个真实任务都会失败——探测结果提供了虚假保证，用户排障时会先排除运行时本身。

### 资源 CRUD 与存储（be-resource-mgmt）

- **备份失败（tar 缺失/磁盘满等）对用户只呈现『请求失败: internal server error』**（`packages/backend/src/services/backup.ts:162`）
  影响：管理员在设置页点『导出备份』失败时，无法区分是系统没装 tar、磁盘满还是数据库被锁，界面不给任何下一步指引（也没有重试按钮之外的提示），只能去翻服务端日志。

- **用户搜索接口的禁用账号过滤条件写反，协作者/授权选择器会列出已禁用账号且无任何标识**（`packages/backend/src/services/users.ts:284`）
  影响：管理员禁用某个账号（离职/回收权限）后，在任务协作者、资源 ACL 授权、owner 转移等所有用户选择器里，该账号仍然被搜出来且外观正常，可被继续选为协作者/被授权人，与『禁用』的直觉预期相悖。

### API 契约一致性（api-contract）

- **反问快捷提交成功但下发被延期（dispatchDeferredReason）时前端零提示，任务停在 awaiting_human 像是提交没生效**（`packages/frontend/src/routes/clarify.detail.tsx:482`）
  影响：用户回答完反问被带回任务详情，任务仍停在 awaiting_human、agent 没有重跑；界面没有任何「答案已保存但需要到问题看板手动下发」的说明，用户很可能以为提交失败而反复重答或干等。

- **跨 agent 反问 'designer-waiting' 响应分支已因后端契约演进（RFC-132）变成死代码，共享类型 SubmitClarifyAnswersResponse 与路由实际响应完全不符**（`packages/frontend/src/routes/clarify.detail.tsx:493`）
  影响：回答多来源跨 agent 反问中的一个后，用户被直接导航去任务详情，看不到本应出现的「还有 N 个兄弟反问待回答、designer 在等齐」提示（只有再手动回到该反问页时靠 peers 轮询兜底显示），期间容易误以为流程卡死；错误的共享类型也会误导后续开发。

- **工作目录/端口产物下载失败时丢弃后端结构化错误体，只报 http-<status>，用户看不到「worktree 已被回收」等真实原因**（`packages/frontend/src/lib/worktree-download.ts:28`）
  影响：历史任务的 worktree 被 GC 或源仓被移走后，用户在任务产出面板点「下载」只得到一句「下载失败」（或重试也一样），不知道文件是永久拿不到了还是网络抖动，会反复重试。

### WS 实时性与多标签同步（ws-realtime）

- **后端专为多标签同步广播的 review.comment_updated 帧在前端没有任何消费者，编辑评论后其他标签页不更新**（`packages/frontend/src/hooks/useTaskSync.ts:107`）
  影响：并排开两个标签页做评审时，在 A 标签修改一条评论，B 标签的同一条评论最多 8 秒内仍显示旧文案；新增/删除评论却是即时的——同一页面同类操作实时性不一致，用户会怀疑修改没保存成功。

- **lifecycle.alert 的 WS 失效规则只随任务列表页挂载，任务详情页的「任务卡住」红条实际全靠 30s 轮询，注释声称的实时点亮不成立**（`packages/frontend/src/hooks/useTasksSync.ts:20`）
  影响：用户停在出问题的任务详情页时，「检测到 N 个问题/诊断」红条最多迟 30 秒才出现；两处代码注释描述的实时行为与实际不符，后续维护者也容易被误导。

- **批量导入弹窗自带 describeError 绕过全局 describeApiError 映射，向用户直接抛「错误码: 英文异常原文」**（`packages/frontend/src/components/repos/BatchImportDialog.tsx:474`）
  影响：中文界面里用户会看到诸如 "batch-not-found: batch 01XX… not found or expired" 这类内部错误码加英文原文的提示（批次 1 小时 GC 过期后点重试就会触发），既看不懂发生了什么，也不知道下一步该重新发起导入。

## 5. 各维度覆盖备注（超出 10 条上限未列入详单的在册问题）

> 每个审计维度最多输出 10 条正式 finding；以下是各维度审计员记录的「超限/降权」备注原文，包含大量已核对代码锚点的次级问题，可直接作为后续修复的补充 backlog。

### 首页与全局导航（fe-home-nav）

超出上限/降权未列的问题：(1) 首页同屏数字口径三套互相打架——pulse 行"运行中/等待处理"计任务数（不封顶），"任务动态"分组徽标计条目数且封顶 8（RunningTaskList/InboxPreviewList slice 后才 onCount），侧边栏收件箱徽标又额外包含工作组待办（InboxFooterButton.tsx:55），用户在同一页面看到 3 个不同的"待处理"数字；(2) auth.tsx safeInternalRedirect 默认落地 '/agents' 而非首页 '/'（35 行）——登出后重新登录不回首页，与 RFC-032"仪表盘即首页"的定位不一致；(3) handleTokenSubmit 在验证前先 setToken 写入 localStorage（auth.tsx:135），验证遇网络错误时脏 token 残留，下次刷新会带着坏 token 进入应用；(4) home.section.error.generic 仅"加载失败"无失败对象与原因，三个分组共用同一句；(5) LanguageSwitch 失败提示直接透传 describeApiError 原文到侧边栏窄栏（LanguageSwitch.tsx:93）；(6) styles.css:1862-1884 的 .task-row\_\_status--\* 修饰类自 RFC-035 换用 StatusChip 后已成死样式。多人并发与纯性能问题按要求未报。

### 工作流编辑器·画布交互（fe-canvas-core）

超出 10 条未列入的在册问题：(1) ValidationPanel 将后端英文技术文案（含 edge id、'v1'、端口内部名）原样透传到中文界面（workflows.edit.tsx:1070 附近，属编辑器路由，与本组 #1 联动）；(2) Ctrl+C 复制成功无任何反馈，且剪贴板是模块级内存变量——刷新页面/另开标签后粘贴静默失效（canvasClipboard.ts:69）；(3) 右键点击边没有自定义菜单，弹出浏览器默认菜单（仅节点/空白处接了 onContextMenu）；(4) xyflow MiniMap/Controls 的按钮 aria-label 与悬浮提示为英文默认值，中文界面下未本地化（WorkflowCanvas.tsx:1911-1912）；(5) 右键『包裹进…』只提供 git/loop，缺 wrapper-fanout 选项，与侧栏能力不对齐（WorkflowCanvas.tsx:1626-1637）；(6) onConnectStart 挂的 document pointermove 监听在拖拽中途组件卸载时不会移除（WorkflowCanvas.tsx:853-857）；(7) onNodeDragStop 处注释宣称 wrapper-on-wrapper 走同一路径但代码跳过（1824-1827），注释/实现漂移是 #2 的直接证据。审计覆盖了任务指定的全部 canvas 范围文件（含 nodes/\*\* 全部渲染器、剪贴板、连线解析/预览、wrapper 四件套、坐标投影、palette、上下文菜单），并对关键断言追到 shared 引用清单、后端 validator 与 i18n 词条核实；EdgeInspector/NodeInspector/PromptPreview 及编辑器路由本体不在本组范围内，未展开。

### 工作流编辑器·节点检查器（fe-canvas-inspector）

超出上限未列出的次要问题：(1) WrapperGitLoopEdit 的 maxIterations/exitCondition.n 用 NumberInput 清空即被写回 1（v ?? 1），且 min 只是 HTML 属性，手输 0/负数会被接受、只能靠后端校验兜底（WrapperGitLoopEdit.tsx:90-104、263-277）；(2) PromptPreview/PortRefList 会把 **clarify_response** 等系统端口当普通入边端口展示，preview 还为其渲染可编辑 mock 输入框，但 renderUserPrompt 对 prompt-injected 端口一律跳过（prompt.ts:543），编辑该框对预览零影响；(3) ReviewEdit 上游节点下拉只显示裸 node id、不带节点 title，与 loop 检查器的 "title (id)" 风格不一致（ReviewEdit.tsx:157-160）；(4) EdgeInspector/OutputEdit/WrapperGitLoopEdit 多处用裸 <input className="form-input"> 绕过 TextInput 公共原语（违反项目 UI 一致性规范）；(5) 端口名格式无统一约束：EdgeInspector/OutputEdit 允许 \w+ 之外的字符，此类端口无法被 {{port}} 引用且 missing-ref 提示（promptRefs.tsx:24 与 shared TEMPLATE_RE 同为 \w+）对其失明——内容仍会经 auto-append 段落送达，故降为备注；(6) OutputEdit/WrapperFanoutEdit 行内端口名逐键改名会即时重排边/触发历史记录 churn，中间态重名同样有 Map 坍缩风险（与 finding 4 同根因）。审计范围内其余文件（AgentPortDialog/AgentPortCard/AgentPortValidationSummary、ClarifyEdit/CrossClarifyEdit、NodeTitleField、historyMeta、syncInputDefs 的 patchInputDef、WorkflowDraftStatus 保存失败呈现）经逐行核对未发现达到 P3 以上门槛的新问题——RFC-194 的端口对话框事务模型（本地草稿+stale 检测+逐字段校验）与 RFC-199 的保存状态机（错误/冲突/不可达均有中文兜底文案和明确下一步按钮）质量明显高于画布检查器一侧。

### 工作流编辑器·外壳/版本/导入导出（fe-editor-shell）

超出/未列入的次要问题：(1) i18n errors 词典系统性缺失工作流域错误码——workflow-not-found、workflow-version-conflict、workflow-validation-stale、workflow-version-mismatch、workflow-yaml-empty、workflow-import-target-mismatch、workflow-in-use、acl-missing-refs 全部缺席（部分已并入上述各条场景），validate/export 的 stale/mismatch 409 也会以『请求失败: workflow ... does not match the requested revision』英文呈现（workflows.edit.tsx:562-565 只做了 refetch，文案仍走 fallback）；(2) 打开编辑器后立刻点『校验』，skills/plugins 清单查询晚到会把 inventorySignature 从 null 翻成实值，刚出的校验结果被误标『校验所依赖的资源可能已变化』（workflows.edit.tsx:93-121 + 299-305）；(3) skills/plugins 列表查询失败在编辑器里无任何呈现（只渲染 agents.error，workflows.edit.tsx:877）；(4) 冲突横幅/对话框把内部本地修订计数以『本地草稿 r42』术语暴露给用户（zh-CN.ts conflictBody）；(5) 版本管理仅有 header 的 v{N} 展示与导出 YAML，无任何版本历史/回滚 UI（产品空白而非代码缺陷，回滚只能靠此前手动导出的 YAML 走导入-覆盖）；(6) editor.statusSaving/statusUnsaved/statusSaved、remoteUpdated/remoteDeleted 等为孤儿 i18n 键，无用户影响。launch 入口（workflow-launch-handoff.ts + router.tsx 重定向 + tasks.new 的 workflowVersion OCC 栅栏与 mismatch 恢复对话框）经端到端核对未发现功能性缺陷；草稿控制器（useWorkflowEditorDraft + reducer）的冲突/离线/终态路径均有出口且有导航守卫，未见 P0 级卡死或数据丢失路径。

### 任务发起向导（fe-task-wizard）

超出上限未列出的次要问题：1) files 类型输入的 minCount 在任何层都不强制——FilesPicker 只显示「最少 N」提示（FilesPicker.tsx:161），missingRequired 对 kind='files' 不看 minCount（tasks.new.tsx:662-668 只对 upload 查），后端也不校验，可少选文件启动；2) 深链 ?kind=agent&agent=<不存在的名字> 会直接落在第 2 步且 stepModeReady 通过，用户填完全部四步后才在启动时收到未映射的英文 404（agent 'x' not found）；3) relaunchFrom 源任务查询持续失败时（如任务已删），整个表单可填但启动按钮永久禁用，只有顶部「资源不存在」横幅+必然失败的重试按钮，唯一出路是手动去掉 URL 参数；4) 编辑定时任务时若 workflow 后来新增了必填 upload 输入，UI 允许挑文件并保存，后端以 scheduled-task-upload-required 拒绝（英文、无指引）——edit 模式缺少非 edit 模式的 scheduleUnsupported 守卫（tasks.new.tsx:1102-1110 vs 1118）；5) 确认页 space 摘要以明文拼接 repoUrl（tasks.new.tsx:1549），用户在 URL 里嵌入的 token 会原样展示（后端各处均做了 redact，前端未做）；6) GitPicker 分支列表加载中无 loading 态，下拉短暂只有占位项，易被误读为「没有分支」。多人并发类（如 cached-repos 两处重复查询）按要求未报。

### 任务列表与详情（fe-task-detail）

超出 10 条未列入的次要问题：① 已终态任务的 diff/结构 diff 查询在错误态下仍以 6 秒间隔无限轮询失败接口（tasks.detail.tsx:158-159/286-288）；② 任务列表显式取 limit=500，超过 500 条时更旧任务在客户端主体/搜索过滤下静默不可见且无提示（tasks.tsx:74-79）；③ 失败横幅「跳到失败节点」按钮显示原始 nodeId 而非节点显示名（tasks.detail.tsx:496）；④ 取消任务按钮在请求进行中（后端最多等 5 秒）无「取消中…」反馈（ConfirmButton 无 pending 态）；⑤ 输出面板按「最新一次运行」解析端口，节点重试失败后旧产出被「待生成」掩盖（TaskOutputPanel.tsx:66-83）；⑥ 输出/预览下载失败只有通用「下载失败」无原因（TaskOutputPanel.tsx:234-242）。另：本次未深入 TaskQuestionList/TaskFeedbackList/WorkgroupRoom 内部（问题/留言/聊天室页签），以及 reviews/clarify 独立页面（属他人范围）。

### 评审与反问界面（fe-review-clarify）

超出 10 条未列出的问题：(1) ReviewDocPane.tsx:496-498 的 J/K 评论跳转快捷键同样未排除修饰键（Cmd+K 等浏览器组合键会被吞并触发跳转），与 F1 同根因；(2) clarify.detail.tsx 顶部注释承诺的「历史轮列表」（History rows）从未实现，historyTitle/historyEmpty/answeredAt/askedAt/shardSwitcherEmpty 等 i18n 词条全部挂空——查看同一反问节点的历史轮只能回列表页切「已回答」过滤逐条找；(3) clarify.ws.toast.othersSubmitted 词条（"另一处已提交答案，本页已切换为只读"）未接线，另一渠道提交后本页只是表单突然变灰、无 toast 说明；(4) 反问服务端协作草稿在任意一次 PUT 失败（含瞬时网络错误）后被 serverDraftDisabledRef 永久静默停用（clarify.detail.tsx:322-328 与 CentralizedAnswerDialog.tsx:569-574），此后仅剩本机 IDB 草稿且用户无感知；(5) clarify.detail.tsx nodeRunId 切换的 reset effect（204-215 行）未重置 draftSaving，特定时序下页脚可能滞留「正在保存草稿…」；(6) 删除评审评论无二次确认（已并入 F2 建议）；(7) 单文档评审 onApprove/confirmDecisionDialog 经 void 调用产生未处理 promise rejection（已并入 F1/F3 detail）。已核验无问题的面：入口角标（InboxFooterButton 三源 failure-soft 求和）、收件箱抽屉（InboxDrawer 分源错误横幅+重试）、列表页空态/加载态/重试、多文档评审的决策弹窗错误处理与 Q/W 快捷键修饰键防护、QuestionForm 数字键/自定义项交互、TaskFeedbackList 的错误呈现与限速提示、批量下发的错误码本地化映射（DISPATCH_ERROR_KEYS 是全仓做得最好的样板）。多轮反问「点历史轮打开错轮」的疑点已排除（每轮 mint 独立 node_run，clarify.ts:447-464 证实）。多人并发竞态类问题按要求降权未报。

### 资源管理（agents/skills/mcps/plugins）（fe-resources）

超出 10 条未列入的次要问题：(1) 技能历史"恢复"按钮在草稿 dirty 时被禁用（skills.detail.tsx:254 busy={operationBusy||dirty}）但无 tooltip 解释，用户不知道要先保存/放弃编辑；(2) mcps/plugins 详情页在"探测/更新"标签上点头部"保存"，若表单校验失败错误只渲染在被 hidden 的 config 面板里，点击看似无响应（mcps.detail.tsx:80-90 + TabPanels keep-mounted）；(3) 依赖自动探测在库存查询仍在加载时打开会显示"未检测到候选"而非加载中（DependencyAutodetectButton.tsx:87-107 把 pending 数据当空列表）；(4) skills 详情 Overview 用 <code> 展示内部 managedPath（skills/x/files，skills.detail.tsx:163），对用户是无意义的实现细节；(5) mcps 编辑页类型 Segmented 被禁用（类型不可变）但无任何"创建后不可改"的说明（McpFields.tsx:47-58）；(6) 各 new 页创建按钮因名称不合法而禁用时无禁用原因提示（skills.new.tsx:68 等）。跨页共性根因：errors i18n map（zh-CN.ts:6114）只覆盖 task/workflow/workgroup 系列错误码，agents/skills/mcps/plugins 四资源的后端 DomainError code 几乎全部落 fallback "请求失败: <英文原文>"，且 ApiError.details 在这四页无任何消费点——修复建议按 finding 2/3 的模式系统性补齐。本次未发现 P0 级（功能坏死/数据丢失/永久卡死）问题；删除均有二次确认（ConfirmButton 4 秒窗口），脏草稿有 UnsavedChangesGuard，窄屏 split 布局（styles.css 14382 起 ≤1080px 媒体查询）的列表/详情切换与返回链路经代码走查未见断路。

### 记忆/融合/仓库/定时/用户/设置等页面（fe-misc-pages）

超出 10 条未列出的问题（均已核对代码）：① 原始英文错误透传同类项——account.tsx:150-155 改密错误、users.tsx:83-87 角色变更错误直接显示 e.message；fusions.detail.tsx:174-179 把 fusion 引擎 f.error 原样放 <pre>；BatchImportDialog 失败行 message 列是 clip+redact 后的原始 git stderr（repoBatchImport.ts:460-465）。② i18n——account.tsx:96-106 Profile 的 role/status/source 原样英文。③ MemoryDialogShell.tsx:148 记忆 scope 下拉用未脱敏的 r.url 作标签（凭据型 URL 可能露出——与既有权限审计 backlog 的 cached_repos 凭据泄漏同源）。④ MemoryDistillJobsTable.tsx:77-91 整行 onClick 导航不可键盘触达（无 role/tabIndex）。⑤ scheduled.tsx:257 列表「立即运行」对降级行禁用但无 tooltip 解释原因（有修复徽标可部分弥补）。⑥ ScheduleDialog weekly 全不选/间隔清空时保存禁用但无行内文案说明原因。覆盖范围：已逐文件读完指定范围内 routes（memory/distill-job 详情/fusions/repos/scheduled×2/workgroups×3/users/account/settings 全文）、AclPanel、memory/** 主要组件、gallery/**、inventory/\*\*、ScheduleDialog、BatchImportDialog、FuseDialog/MemoryReviewItem，并对每条 finding 端到端追到后端错误产生点（cached-repos/scheduledTasks/memory/config 等路由与服务）。多人并发竞态类问题按要求降权未报。

### UI 设计系统一致性（fe-design-system）

超出上限未列出的次要问题（均已核实）：1) 死样式两簇——styles.css:1862-1882 .task-row**status--\* 变体（task-row.tsx 已改用 StatusChip，变体类不再产出，其中硬编码的 #c5221f/#1e8e3e 也随之失效）与 styles.css:7509-7537 .diff-mode-segmented**btn\*（reviews.detail 已改用 Segmented 组件）；2) .diff-mode-segmented（styles.css:7501）把共享 Segmented 重塑为 999px 药丸形+描边，与全站 6px 圆角的 segmented 外观分叉，且内部 4px 圆角的 active 块与药丸端部弧度不贴合；3) tasks 域的 task-error-banner 家族（StuckTaskBanner/RecoverySection/WorkflowSyncBanner/WorkflowSyncDialog/tasks.detail:467）是与 NoticeBanner、error-box 并存的第三套横幅风格，RFC-198 落地后未回收；4) McpFields.tsx:38 等 4 处与 PluginFields.tsx:36 等 3 处手拼 <span className="form-field__error"> 而非 Field error prop，错误出现时无 role=alert 播报且与 hint 同屏；5) styles.css:7560-7565 .agent-import 弹窗级重定义 .btn--primary 背景色，主按钮颜色出现单弹窗分叉；6) AgentImportDialog.tsx:266 将 error.message 原文拼进提示。整体结论：Dialog/Select/window.confirm 三条红线全站零违规（无自写 modal chrome、无原生 select、无 confirm/alert），违规集中在 error 呈现、checkbox、行内校验错误与暗色 token 四个面。

### 前端错误呈现全链路（fe-error-surface）

超出 10 条未列入的次要问题：(1) RecoverySection 解除隔离按钮失败静默（components/tasks/RecoverySection.tsx:90-94，轮询会兜底纠正显示故降权）；(2) ModelSelect 刷新模型列表错误直出 refresh.error.message 英文原文（components/ModelSelect.tsx:177-179）；(3) scheduled.tsx 的 toggle/runNow 错误横幅渲染在页面顶部（:106-107），距触发行很远，长列表下用户看不到；(4) NodeDetailDrawer 仅对 superseded/rollback 做了文案净化（RFC-011），manual 取消与失败路径仍直出机器 errorMessage；(5) tasks.detail 的 cancel/resume 错误横幅同样渲染在 header 区外远端。覆盖范围说明：本次专职审计前端错误呈现链路（client.ts/ErrorBanner/mutation 反馈/catch 吞错/边界/daemon 掉线表现），逐文件核读了 56 个含 useMutation 的文件的错误分支与 52 处空 catch（多数为草稿/localStorage 类良性吞错）；未深入 workflow 画布编辑器内部（其 4 个 mutation 带 23 处 onError，覆盖良好）与 WebSocket 断连提示链路。

### i18n 完整性（fe-i18n）

超出上限未列出的次要问题：1) zh 词条残留英文段落级文案——tasks.metaWorktree='Worktree'（zh-CN.ts:4859）、tasks.sectionWorktreeDiff='Worktree diff'（zh-CN.ts:5008）在中文任务详情页作字段名/节标题；2) 诊断面板 rule 文案（zh-CN.ts:4941-4956）大量内部术语（node_run/doc_version/clarify_session/awaiting_human），属技术面板可酌情保留；3) Resources 接口把 errors 声明为 Record<string,string>（zh-CN.ts:2785），两语言 errors 键集差异不受 tsc 保护（当前恰好同步，属潜在回归风险）；4) lib/schedule-view.ts:19-48 的调度摘要中英文案硬编码在代码里而非词条库（当前双语覆盖完整，仅架构性偏离）。健康面确认：两 bundle 扁平键集 2869 个完全 1:1、插值变量零错配；动态 t() 键族（tasks.status、runtimes.smoke、tasks.diagnose.rule、tasks.syncWorkflow.blocker/warn、noderunStatus 等）逐一对照后端枚举域均完整；组件层未发现绕过 t() 的硬编码中文 UI 串（命中均为注释）。

### 后端错误文案（be-error-text）

扫描范围：packages/backend/src/routes 全部 34 个路由文件的 4xx/5xx 出口 + util/errors.ts 统一错误管道 + 前端共享解码链（api/client.ts extractErrorBody → i18n describeApiError → ErrorBanner/DetailHeaderActions），并对登录、OIDC、任务启动/取消/diff、工作流增删改、技能保存、批量导入等主流程做了端到端抽样。未列入的次要问题：① HTTP 状态码使用总体规范（422/404/409/410 一致，未发现校验错误误用 500；ValidationError 统一 422 而非 400 属风格选择）；② agents.ts closure-preview 故意用 200+ok:false 属合理设计；③ plantuml 渲染失败故意走 200 判别联合（有注释说明）；④ gitRepoCache 对 stderr 已做凭据/URL 脱敏（redactGitUrl），泄露风险已控，剩余是语言/受众问题（并入 finding#2）；⑤ 'task-not-cancelable' 的中文映射「该任务已结束，无法取消」对 awaiting_review 态任务表述不准确，但前端按钮门控使其仅在竞态下可见；⑥ workgroup-\* 错误码的中文映射是全仓做得最好的范式，可作为 finding#2 的模板；⑦ en-US 词条对称性与 WS 通道错误未审计。errorSummary 机器协议问题与既有 flag-audit（design/flag-audit-2026-07-07.md P0）部分重叠，本次补充了具体渲染位点与样例串证据。

### 任务发起前置校验（be-launch-validate）

超出上限未列出/降权的观察：(1) pollAndClaim 里坏 spec 自动停用的分支（scheduledTaskScheduler.ts:66-77）不发 WS 广播，打开中的列表最多延迟 30s 刷新——影响轻微；(2) 对 migrationNeeded 行直接 API 调 run-now 时 fireSchedule 的 scheduledPayloadSchemaFor(...).parse 会裸抛 ZodError（scheduledTasks.ts:448），可能成 500，但 UI 已用 runNowBlocked 置灰按钮，仅裸 API 可触发；(3) validator 不校验 wrapper nodeIds[] 里的悬空节点 id（仅 YAML 手改/导入可触达）；(4) 多仓/上传等其它启动 422 码（multi-repo-upload-unsupported、start-task-path-retired 等）同样缺 i18n 键，统一落「请求失败: 英文原文」兜底——与 finding 2/6 同根因，修 describeApiError 映射时应一并补齐；(5) materialize 失败铸出的 failed 任务行 errorSummary 为英文原文「worktree creation failed: …」，其展示归任务详情页范围，未单列。已覆盖：taskLaunchGate/workflow.validator/resourceRefs/scheduleLaunch/startTaskDeps/agentLaunchReservation 全文精读，routes/tasks.ts POST 入口（JSON+multipart）端到端追到前端渲染；agent/skill/mcp/runtime/plugin 被删或禁用后的 launch 行为逐一核对（删除路径普遍有 409 守卫，缺口集中在「禁用 MCP」与「删工作流 vs 定时任务」两处）。

### 任务生命周期（be-lifecycle-ux）

未占用名额的次要问题：(1) autoResumeOnBoot 开启时，被周期巡检（orphanReconcile.ts:113 errorSummary='orphan-reconcile'）翻成 interrupted 的任务永远不满足 autoResume.ts:69 的 'daemon-restart' 匹配，与 boot 被中断的任务行为不一致（部分是 T17 注释声明的设计，但对用户不可解释）；(2) orphans.ts:66-68 对 pending 任务也写 'daemon restarted while this task was running' 文案（其实没在 running）；(3) reapOrphanRuns 返回的 tasks 计数把 CAS 输掉的行也算进去（orphans.ts:126，仅影响日志）；(4) 诊断面板的规则中文文案大量夹内部术语（node_run/doc_version/awaiting_human，zh-CN.ts:4942-4955），RepairPreview 直接给用户看原始 SQL 预览步骤——按“操作员工具”容忍未列为正式 finding；(5) errors.'task-not-resumable' 中文里夹英文 “resume”（zh-CN.ts:6120）；(6) 本地 describeError 拷贝共 6 处（Onboarding/BatchImportDialog/FilesPicker/settings/workflows.edit 同 NodeDetailDrawer），均绕过统一错误翻译。范围内其余机制（stuck 检测 S1-S6 的豁免逻辑、diagnose 路由对 stuck 告警的合并、RecoverySection 的 kind 翻译兜底、驾驶租约/熔断/审计链路、boot 顺序）经核对未发现新的用户可见缺陷。

### 调度与执行语义（be-scheduler-fanout）

超出上限/较小的问题概括：① 任务失败横幅与「跳到失败节点 (nd_xxx)」按钮均用画布内部 node id 而非节点标题（tasks.detail.tsx:496、scheduler 各 summary 模板），用户需自行对照画布；② fanout 分片失败聚合为 fail-all-after-join，设计文档承诺的 errors 端口部分容忍语义仍标注 deferred（scheduler.ts:4666-4671 注释），一个分片失败即全任务失败，joined 消息（'key:原文 | key:原文'）在分片多时不可读；③ clarify 问题体格式非法时 errorMessage 为 `clarify-questions-*: 原始 zod 细节` 英文透传（runner.ts:1284-1287）；④ 工作流引用的 agent 被删除后任务运行期才报英文 `agent 'X' not found`（scheduler.ts:2641）；⑤ RFC-200 信封 nonce 已在铸行时生成并持久化（nodeRunMint.ts:217）但 renderUserPrompt 与 runner 解析两侧均未接线——当前双侧一致为裸标签、无用户可见影响，属未完工特性（疑似 T4 未落地），接线时须两侧同时传入否则将全量解析失败；⑥ 审计范围限定的 9 个后端文件已逐一通读并端到端追到前端渲染层，多人并发/竞态类与纯性能问题按要求未报。

### 反问与评审后端流程（be-clarify-review）

超出上限未列出（均已核实存在但严重度较低）：① review 派发失败把机器码写进 node_run errorMessage（'review-input-source-missing' / 'review-upstream-not-done' 等，review.ts:423-480），节点错误面板按原文展示英文槽位句（属 flag-audit 已知 errorMessage 机器协议问题的评审分支实例）；② /api/clarify 列表默认 limit=100（shared/schemas/clarify.ts:491，clarifyRounds.ts:182-183），多轮历史超过 100 条时静默截断且 UI 无“已截断”提示；③ 反问草稿 PUT 在轮已被他处提交后返回 409 'clarify-round-not-awaiting' 原文（clarifyRounds.ts:429-432），若 WS 只读切换 toast 丢失则用户看到裸英文；④ listClarifyRounds/listClarifyRoundSummaries/loadTaskNamesByTaskId 全表扫描后内存过滤（clarifyRounds.ts:135/173/344），规模化后列表页明显变慢（性能类，按要求不计入正式 findings）；⑤ clarify.detail 的多源等待横幅（crossWaiting/designer-waiting）依赖已消失的旧响应形状，正常提交后因立即导航永远不可见（已并入第 5 条 finding 的 detail）。审计范围内其余项（问题派发死锁防护、park/释放路径、多轮 Q&A 注入完整性、seal 幂等与再答窗口）逐文件读毕未发现新的用户可见缺陷。

### Git/仓库操作（be-git-repo）

超出 10 条未列入的次要问题：(1) commitPushRunner.ts:199-209 `git add -A` 及 diff --cached 的退出码被忽略，staging 失败会把有改动的仓误报为『无改动』(skipped-empty)；(2) tasks.detail.tsx:466-470 失败任务 banner 直接显示 errorSummary 原始码（如 snapshot-lost），未复用 recovery kind 的中文映射；(3) routes/worktree-files.ts:65 decodeURIComponent 未捕获 URIError，畸形 % 路径会 500；(4) repos.tsx:156 刷新 pending 时禁用所有行的刷新按钮且成功无任何 toast；(5) gitRepoCache.ts:63-69 withUrlLock 的清理比较 `urlMutex.get(h)===prev.then(...)` 恒为 false，map 条目永不回收（仅内存泄漏，无用户可见影响）；(6) 超时后底层 clone 进程不被终止，后续同 URL 请求继续在互斥锁后排队。审计范围覆盖：repo.ts/gitRepoCache.ts/gitSubmodule.ts/gitVersion.ts/commitPush.ts/commitPushRunner.ts/worktreeFiles.ts/nodeRollback.ts/routes/{repos,cached-repos,worktree-files}.ts 全量精读，并端到端追至 tasks.new/tasks.detail/repos 页与 i18n 字典；多人并发竞态按要求未报。

### 运行时与 MCP/插件（be-runtime-mcp）

超出 10 条上限的次要问题：1) runtimeSmoke 超时被归类为 model-call-failed（无独立 timeout outcome，zh 显示「模型调用失败」，runtimeSmoke.ts:313-315），挂死或等待交互输入的二进制会被误诊；2) pluginInstaller.probeNpmBinary 负结果缓存 5 分钟（pluginInstaller.ts:102-120），用户装好 npm 后 5 分钟内重试仍被告知 npm 不可用；3) mcpClosure.loadMcpsByNames / pluginClosure.loadPluginsByNames 在派发时静默跳过已删除或 schema 损坏的 MCP/插件行（mcpClosure.ts:57、pluginClosure.ts:59），agent 缺工具跑完用户无任何提示；4) GET /api/runtime/models 失败时 ModelSelect 直出后端 redact 后的英文 CLI stderr（ModelSelect.tsx:98-115）；5) 插件「升级」按钮被 check-update 结果锁死（plugins.detail.tsx:192），无法强制重装修复损坏缓存；6) RuntimeFormDialog 的「测试二进制」按钮在未填路径时禁用，无法预先测试「协议默认二进制」。审计覆盖：runtimeRegistry/runtimeSmoke/runtime 驱动目录（types/opencode/claudeCode 的 driver·probe·spawn·config）/inventory/mcp·mcpProbe·mcpProbeStore·mcpClosure/agentLaunch/launchRuntimeConfig/pluginInstaller·pluginClosure/routes(runtime·runtimes·mcps·plugins)，及前端 RuntimeList/McpInventoryPanel/ModelSelect/HomepageGreeting/mcps·plugins 路由/i18n errors bundle/api client 全链路。多人并发竞态类问题按要求降权未报。

### 资源 CRUD 与存储（be-resource-mgmt）

超出/未列入的次要问题：(1) skill-md-protected 等错误 message 直接向用户暴露 HTTP 端点（『edit content via POST /api/skills/:name/save』，skill.ts:746），因 UI 已把 SKILL.md 标记只读、触发面小；(2) fusions.detail.tsx:177 把 fusion.error（如 'agent did not write the fusion result manifest'、'engine task vanished'）以英文原文 <pre> 展示；(3) MemoryDistillJobsTable.tsx:103 的 lastError 列同样是英文原文（如 'distiller timeout after 600000ms'）；(4) skills.new.tsx:69 创建按钮因名称非法被禁用时无任何可见原因说明（只有 hint）；(5) 代理保存路径不校验 skills 引用存在性（agent.ts 只校验 dependsOn/mcp/plugins/runtime），UI 有 SkillsPicker 兜底但 agent.md 导入可写入任意技能名，直到运行时才暴露；(6) commitSkillZipBuffer 失败分支 skill-write-failed 直接透传 err.message（skill-zip.ts:357），属 finding 4 同族。审计范围内未发现 P0 级功能坏死或数据丢失路径：skill 版本 funnel（skillVersion.ts）、两阶段 op（skillOperations/skillFsPublish）、fusion CAS 状态机与用户账号 last-admin 保护经逐行核对均自洽；备份仅有创建端点（无 restore 界面，恢复靠手工解包，属产品范围而非缺陷）。

### API 契约一致性（api-contract）

深查范围为 tasks/workflows/agents/skills/repos/clarify/reviews 主流程的前后端 API 契约（以 api/client.ts + api/worktreeFiles.ts 为索引逐个对照 routes/\*\*），workflows 导入/导出、worktree-file zod 双端校验、task questions 看板错误码映射、port-artifacts、memories、plantuml 代理等均已核对为一致。未列入前 10 的次要问题：1) routes/tasks.ts:308 call-targets 缺参时返回非标准错误体 {error:string}（前端两种解码形状都不认，仅 UI 恒传参才未暴露）；2) routes/cached-repos.ts:61、95 用 parsed.error.message（zod issues 的 JSON 序列化串）作 message，一旦触发会向用户展示原始 JSON 块；3) ValidationError('task-invalid') 携带的 details.issues（具体哪个字段错）在前端从不渲染，启动失败只显示笼统的「任务输入不合法。」；4) daemon 不可达时 fetch 抛 TypeError('Failed to fetch') 原样进 ErrorBanner，无统一的「守护进程不可达，请检查服务是否在运行」提示；5) 非 JSON 错误响应在 HTTP/2 下 statusText 为空，兜底文案退化为无信息的 'request failed'。多人并发类（协作草稿 LWW、共享树竞态）按要求降权未报；测试文件问题未报。

### WS 实时性与多标签同步（ws-realtime）

超出上限未单列的问题：① memory.superseded 帧对非管理员被后端有意丢弃（ws/registry.ts:464，登记为已知限制），普通用户的记忆列表在记忆被取代时不会实时更新；② resetBroadcastersForTests 漏掉 scheduledTaskBroadcaster（broadcaster.ts:112-119，仅影响测试隔离）；③ useTaskSync 对高频 node.event 每帧 invalidate ['tasks',id,'node-runs'] 前缀，流式输出期间会连带 session/events 三个 query 反复重拉（性能余量，注释已自认待改）；④ RepoImportWsMessage 的 batch.error 变体后端从不生产、前端也不处理（死协议分支）；⑤ 任务详情对不可见/已删除任务的 WS 升级被 403 后前端以 30s 上限退避永久重试，无退出条件（仅产生网络噪音）。已覆盖：ws/server.ts、ws/registry.ts、ws/broadcaster.ts 全量精读；前端 useWebSocket/useWsInvalidation/useTaskSync/useTasksSync/useWorkflowSync/useMemoryWs/useClarifyWs/useScheduledTaskWs/useMemoryDistillJobWs/useWorkflowEditorDraft 全量精读；后端全部 broadcast 生产点与前端规则表逐一比对；各实时页面轮询兜底逐页核实。多人并发竞态类按要求降权未报。

## 6. 真实浏览器目检印证（本机运行实例，2026-07-16）

在 `localhost:5174`（开发栈，admin 会话）逐页目检 + 两条真实报错路径实测，与代码审计交叉印证：

1. **内部保留名满屏**：首页「等你处理」、收件箱弹窗、任务列表、反问页、面包屑全部显示 `__wg_clarify__ ← __wg_leader__`、`__workgroup_host__`、`__agent_host__`（→ R3）。
2. **失败原因不可读且详情更糟**：失败任务 banner「任务失败。workgroup hit max_rounds (10)」，点开「详情」只有 `max-rounds` 一个词——比摘要信息还少（→ F-2 同族，工作组侧）。
3. **死任务反问不清场（实测）**：已失败任务 probe-cl-run 的 10 轮反问全部滞留「待回答」列表与收件箱；「问题」看板还挂着 11 条「待指派」+「处理待指派问题」按钮；另有等待 14/15/22/23 天的僵尸「运行中（等待回答）」任务无任何升级提示（→ R8）。
4. **收件箱计数自相矛盾**：侧边栏 badge **37**，弹窗打开却是「20 项待处理」（评审 3 + 反问 17）——两个口径没有任何解释（→ fe-home-nav coverage note ①的三套口径问题实锤）。
5. **校验警告纯英文**：编辑器「校验」通过后的 2 条警告是完整英文技术句（`clarify-no-iteration-cap — clarify node 'clarify_7m5ay8' is not inside a wrapper-loop …`），且不能点击定位（→ §3.4 校验面板条目）。
6. **任务列表「仓库」列显示 ULID**：与名称下方的任务 ID 同串重复（工作组任务无 repo 时的回退显示欠妥）。
7. **仓库导入报错英文 + 无意义重试**：批量导入非法 URL 得到「unsupported or malformed Git URL」（英文），且对格式错误提供必然再失败的「重试」按钮（结构本身——逐行状态+详情列——是好的）。
8. **向导字段 label 重复**：任务内容步显示「requirement (requirement)」——label 与 key 相同时应只显示一次。
9. **评审列表悬挂**：6 月 4 日 / 6 月 8 日创建的评审轮至今「待评审」（对应任务早已终态，→ R8）。
10. 反问回答页体验整体不错（快捷键提示、推荐理由、草稿保存说明、双提交按钮语义清晰）——印证了「正向路径质量好、错误路径是短板」的总评。

## 7. 修复路线建议（按性价比排序）

建议拆成 6 个 RFC 推进，每个都有明确的全局杠杆：

| #     | 主题                                           | 覆盖   | 核心动作                                                                                                                                                              |
| ----- | ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC-A | **错误呈现统一层**（R1+R3+R6）                 | ~50 条 | errors 词典按域补齐 187 码；ErrorBanner 支持 details 折叠（issues/referencedBy/availableRefs/stderr）；failureCode→i18n 映射层；保留名→展示名小表；孤儿键/死词条 lint |
| RFC-B | **静默失败清零**（R2+R4）                      | ~25 条 | QueryClient 全局 MutationCache onError 兜底；高价值表单补局部 isError；「200=全部生效」约定（resumeTask×3、修复弹窗、仓库刷新、warm fetch、蒸馏 done）                |
| RFC-C | **生命周期出口与清场**（F-0/12/13/14/15 + R8） | ~10 条 | 空列表评审自动通过；awaiting\_\* 可取消；关停写 interrupted；删工作流查 schedule 引用；终态任务封存 open 轮次                                                         |
| RFC-D | **画布交互完整性**（F-3/4/5/6 + §3.2）         | ~15 条 | loop 拒收 inbound 连线；wrapper 拖拽嵌套或明确提示；输入 key 冲突治理；逗号输入框换 ChipsInput；校验结果可点击定位                                                    |
| RFC-E | **危险操作与快捷键防护**（R5）                 | ~10 条 | 不可逆 mutation 全量接 ConfirmButton；单键快捷键公共 helper（修饰键防护）；wrapper Delete 与右键删除行为对齐                                                          |
| RFC-F | **WS 重连补齐 + 断线提示**（R7/F-18）          | ~6 条  | useWsInvalidation 按 epoch invalidate；全局连接状态条；纯 WS 界面补轮询兜底                                                                                           |

前置校验类（F-16 port-count-lt、必填输入校验、MCP 禁用校验、HH:MM 等）可并入 RFC-D 或独立小 PR；`workflow.validator.ts` 的 kind 白名单 + n 校验是其中杠杆最大的一条。

## 8. 方法学附注

- **流程**：22 个维度审计（每维度上限 10 条、超限写入 coverage note）→ 185 条 finding → 每条一名独立对抗复核员（要求打开 file:line 证伪、排查兜底路径与逃生通道、校准严重度）→ 184 确认 / 1 推翻 → 跨维度合并 21 条重复 + 3 条并入 P1 → **156 个独立问题**。
- **被推翻的 1 条**：「pending 任务在首页任何区块不可见」——静态事实属实，但复核证实 pending 窗口极短（worktree 物化在 insert 之前完成，失败直接落 failed），用户可见窗口不存在，判为无用户影响。
- **已知偏差**：(a) 多人并发竞态按用户指示整类排除（复核员对该类一律判否）；(b) 每维度 10 条上限意味着 §5 的 coverage notes 里还有 ~60 条已核对锚点的次级问题未进正式详单；(c) 行号截至审计当时的工作树，RFC-199 在途改动可能造成 ±10 行漂移（复核员已修正大部分）。
- 原始结构化数据（185 条含 verdict 全文）保存在审计会话产物中，如需可导出为独立 JSON 附录。
