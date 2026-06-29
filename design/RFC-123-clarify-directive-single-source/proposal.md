# RFC-123 — 反问 directive 单一事实源：答题「停止反问」回写提问节点开关（RFC-122 修订）

状态：Approved（2026-06-29 用户批准、**含重启用方向**）— 实现中
触发：2026-06-29 用户报「我已经在反问页面选择要求停止反问了，为什么任务节点上的反问开关还是继续反问而不是停止反问」+ 追问「这两个开关的理念和语义本来就是一套」。

## 背景

RFC-122 给**提问 agent 节点**加了画布「继续反问 / 停止反问」开关，存 `task_node_clarify_directives`，调度器 dispatch 读 `nodeStopOverride`（`scheduler.ts:2348`）强制 STOP CLARIFYING。但 RFC-122 把它**有意**设计成与「答题时附带 `directive='stop'`」（RFC-056 `hasPersistentStop` / RFC-100 latest-directive）**并行、互不写入**（RFC-122 proposal 非目标第 19–20 行）。

后果（用户实际踩到）：在反问页（`/clarify`）点「提交并停止反问」只写 `clarify_sessions.directive`（同节点）/ `cross_clarify_sessions.directive`（跨节点），**从不写** `task_node_clarify_directives`；而画布开关只读后者、缺行默认显示「继续反问」（`WorkflowCanvas.tsx:1753`）。于是答题选 stop 后：

1. **画布开关仍显示「继续反问」**——开关在「说谎」。
2. **两套 stop 的持久度不一致**：
   - 跨节点：答题 stop 经 `hasPersistentStop`（`crossClarify.ts:1065`）持久短路，整任务不再问（durable）。
   - 同节点：答题 stop 仅作用于紧接的 clarify-answer 重跑（`applyLatestDirective`）；若该产出被 review 驳回触发重跑（`reviewContext` 置位），directive 被**剥离**、**重新强制反问**（`scheduler.ts:2329-2338`，RFC-100）。而画布开关 stop 不受此影响（每次 dispatch 都强制）。

## 用户判断（本 RFC 的立场）

从产品意图看，「这个提问节点：继续反问 / 停止反问」本就是**一个**概念，不该有两套状态、两种持久度。当前分裂纯粹是 RFC-056 与 RFC-122 先后落地堆出来的实现产物；那个「答题 stop 较弱、会被 review 重跑重新强制反问」的不对称**没有产品理由、更像 bug**。正确的修法不是「给两套系统加同步桥」，而是**让 per-(任务,提问节点) 的 clarify directive 成为单一事实源**，画布开关与反问页只是它的两个 UI。

## 目标

- 让 per-(任务, 提问节点) 的 clarify directive 成为**单一事实源**：画布开关与反问页读/写同一个 stop 态。
- **stop 方向**：答题选 `stop` → 同步写 `task_node_clarify_directives`（该提问节点行）。于是 ① 画布开关如实显示「停止反问」；② 答题 stop 经既有 `nodeStopOverride` 通道获得与画布开关**同等持久度**（每次 dispatch，含 retry / review 重跑，都强制 STOP）。
- **重启用方向（双向单一事实源）**：手点画布开关翻回 `continue` → 真正让该 agent 再问，**覆盖最新已答轮的 stale `directive='stop'`**（不被 prompt 路径或 cross `hasPersistentStop` 残留卡住）。
- 覆盖同节点（self-clarify）+ 跨节点（cross-questioner）两条路径。

## 非目标

- 不改反问协议 / XML envelope / 裁决流程 / clarify session 既有数据流。
- 不删除 RFC-056 `hasPersistentStop`、不删答题 session 的 per-round directive：本 RFC **additive**——新写一层、不动既有机制（golden-lock）。
- **不让答题 `continue` 回写开关**（见 design D1：continue 是默认态；stopped 节点不再反问、不存在「答 continue」窗口；避免一次 continue 答案顶掉用户特意点的 stop）。
- 不做 agent 级 / 跨任务持久策略（仍 per-(任务,节点) 运行期）。
- 不改 review 重跑既有语义（`reviewActive && !isClarifyRerun` 仍天然压制 ask-back，toggle='continue' 不解除——agent 处理评审意见、不反问）。

## 用户故事

1. 我在反问页点「提交并停止反问」，回到画布——该节点开关**已显示「停止反问」**，不再是误导的「继续反问」。
2. 我答 stop 让设计者 agent 收尾；其产出被 reviewer 驳回触发重跑——它**不再反问**（与我手点开关停它一致），而非今天那样被重新强制反问。
3. 我答 `continue`（继续反问）——开关不被回写，保持默认 / 我先前的设置。
4. 我先答了 stop（开关变「停止反问」），后来改主意——**手点开关翻回「继续反问」**，该 agent 下次重跑就**重新开始反问**（不被之前的 stop 残留卡住）。

## 验收标准

- [ ] self-clarify 答题 `stop` → `task_node_clarify_directives` 出现 `sourceAgentNodeId` = 'stop' 行（`set_by` = 答题成员 id）。
- [ ] cross-clarify 答题 `stop` → 出现 `sourceQuestionerNodeId` = 'stop' 行。
- [ ] 答题 `continue` → **不**写该表（golden-lock：与本 RFC 前逐字一致）。
- [ ] **行为差异锁**：self-clarify 答 stop 后 review 驳回重跑 → promptText **含 STOP CLARIFYING、不含**强制 ask-back。
- [ ] 画布开关在答题 stop 后反映为「停止反问」（经任务 WS / 重取）。
- [ ] 归属 `set_by` 仅入库 / UI、**绝不进 prompt**（沿用 RFC-122 不变式）。
- [ ] 幂等：答 stop 与手点开关任意次序，行终值 = 'stop'。
- [ ] **重启用锁（self + cross-questioner，prompt 路径）**：存在已答 `directive='stop'` 轮 + toggle='continue' → dispatch promptText **含 ask-back、不含 STOP**。
- [ ] **重启用锁（cross 节点）**：cross 有 `directive='stop'` session + questioner toggle='continue' → 不被 `hasPersistentStop` 短路（questioner 可再问）；无 continue 行 → 仍短路（golden-lock）。
