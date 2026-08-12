# RFC-293：Intent Builder 双栏工作台与工作上下文自动刷新

- 状态：Draft（待用户设计确认）
- 日期：2026-08-12
- 关联：RFC-234、RFC-235、RFC-273、RFC-291
- 取代范围：RFC-235 `design.md` §4.1 的“页面唯一主滚动”、§5.4/§5.5 的手动挂载后人工续写、§6.2 的 stale draft 人工恢复路径；其余安全、ACL、草稿与提交合同继续有效。
- 设计门：第一轮 source-backed review 的 12 个 P1、1 个 P2与第二轮的 6 个 P1已纳入本版；最终复审
  通过前仍不授权生产代码。

## 1. 背景

用户在真实使用中指出三处连续体验问题：

1. 左侧会话很长时，随整页滚动到下方就看不到右侧产物；对话与产物本应并行工作，却共享一个文档滚动位置。
2. 宽屏上页面被居中窄化，左右大量空白；最需要面积的 workflow canvas / 资源详情预览反而被压缩。
3. 资源挂载被做成会话底部的孤立动作：运行中完全不能挂载；挂载后旧草稿变 stale，用户还必须自己输入一条消息重跑，才能重新开放提交。

这不是偶发样式问题，而是现行合同的直接结果：

| 现状                                             | 源码证据                                                          | 用户后果                             |
| ------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------ |
| `.content` 是整页滚动容器                        | `packages/frontend/src/styles.css:3026-3032`                      | 左栏越长，右栏一起离开 viewport      |
| Intent 页面 `max-width:1400px` 居中              | `packages/frontend/src/styles.css:20890-20896`                    | 超宽屏空白，预览面积未利用           |
| 两栏只做普通文档 grid，`align-items:start`       | `packages/frontend/src/styles.css:21051-21056`                    | 两栏没有独立高度与滚动所有权         |
| 挂载区位于 timeline、待决事项之后                | `packages/frontend/src/routes/intent.detail.tsx:446-500`          | 上下文入口埋在长历史底部             |
| 运行中 Add/Remove mount 被禁用                   | `packages/frontend/src/routes/intent.detail.tsx:450-455,478-482`  | 用户发现缺资源时不能先选择并排队     |
| add/remove 服务对 `inFlightTurnId` 直接 409      | `packages/backend/src/services/intent/session.ts:812-845,889-906` | 不是只改前端即可解决                 |
| 挂载 bump `contextRevision`，旧 draft 随即 stale | `packages/backend/src/services/intent/session.ts:868-883,913-923` | 提交被挡后仍需用户手动发消息         |
| stale CTA 只解释禁用，不提供连续恢复动作         | `packages/frontend/src/routes/intent.detail.tsx:638-659`          | “挂载 → 重跑 → 再回右栏”的因果链割裂 |

RFC-235 当时明确规定“页面保持唯一主滚动，不给两栏各造滚动容器”
（`design/RFC-235-intent-builder-ux/design.md:5246-5254`），并规定 manual mount 后由用户在
Composer 明确生成新版（`:5395-5406`、`:5644-5648`）。本 RFC 根据新的实测反馈修订这两个产品决策。

## 2. 目标

### G1：同时看见会话与产物

桌面端成为占满可用内容区高度与宽度的工作台。会话与复核区各自拥有一个明确、可键盘访问的纵向滚动容器；滚动左栏不移动右栏，反之亦然。

### G2：把面积给产物

取消 1400px 页面封顶。左栏保持可读的 360–620px，自适应占约三分之一；右栏吃掉其余宽度。workflow canvas、op preview 与 commit review 使用右栏全部可用宽度。

### G3：把资源变成全局工作上下文

挂载从左栏底部提升为横跨两栏的紧凑工作上下文条。它持续显示：已应用资源、待应用变更、刷新状态与唯一“管理上下文”入口。

### G4：上下文变更自动收敛到新草稿

用户无需再手工输入“请重跑”：

- 空闲时保存上下文变更，服务端在同一事务中应用变更并预留下一轮生成；
- 运行中保存，默认持久化排队，当前轮结束后原子应用并自动生成新版；
- 用户也可显式选择“停止当前轮并立即刷新”；
- 新版成功前，旧产物可读但不可误提交。

### G5：运行、刷新、提交的因果关系可见

界面明确区分“本轮仍在运行”“上下文变更已排队”“正在基于新上下文生成”“刷新失败”“新版可提交”，不再用一个灰掉的按钮让用户猜原因。

### G6：刷新/重启/多标签页不丢动作

排队变更、替换、取消和执行回执全部持久化、可幂等对账。浏览器刷新、HTTP 响应丢失或 daemon 重启不能静默丢掉用户已确认的工作上下文变更。

## 3. 非目标

- 不宣称把新资源热注入已经启动的模型进程；当前轮使用的上下文快照仍不可变。
- 不增加资源挂载数量上限，不推翻 RFC-291 的 handle 高水位、copy 谱系或失效资源跳过语义。
- 不改变资源 ACL、owner、visibility 或六类资源的创建/提交语义。
- 不让排队上下文变更与 apply journal 并发；提交应用中仍禁止开始新的上下文写入。
- 不新增可拖拽分隔条或个人布局持久化；本轮先用自适应列宽解决空间问题。
- 不删除 legacy `POST/DELETE /mounts` API；前端主路径迁入新批量工作上下文 API，旧 API 保持兼容并复用底层 delta 纯函数。
- 不把原始 resource id、凭据、secret 或隐藏 owner 信息渲染到可见 UI/accessibility tree、turn 文本或
  模型 prompt。沿用现有 owner/admin-audit 授权边界的 HTTP machine DTO 可携 resource id 用于 picker
  identity 与精确对账，但前端不得显示、分析或写入日志/WS。

## 4. 核心 UX

### 4.1 桌面工作台

```text
┌ 会话标题 / 生命周期动作 ───────────────────────────────────────────────┐
│ 目标 ───── 生成 ───── 复核 ───── 应用  · 当前状态                     │
├ 工作上下文  Agent ×2 · Workflow ×1 · +3   [本轮后自动刷新] [管理] ─────┤
├──────────────────────┬────────────────────────────────────────────────┤
│ 构建会话              │ 草稿产物                                      │
│ 轮次 / 回到最新        │ revision / validation / [复核并提交]           │
│                      │                                                │
│ 独立滚动：历史与执行流 │ 独立滚动：op 导航、canvas、详情、提交历史       │
│                      │                                                │
│ 当前待办 / 调整输入    │                                                │
└──────────────────────┴────────────────────────────────────────────────┘
```

- 页面 header、journey、工作上下文条不参与两栏内部滚动。
- 左栏宽度为 `clamp(360px, 32cqw, 620px)`，右栏 `minmax(560px, 1fr)`；实际断点按内容容器宽度，不按含 sidebar 的 viewport 猜。
- page、workbench、两个 pane wrapper 形成完整的 `min-height:0` 高度链；pane wrapper 使用
  `auto minmax(0,1fr)`，只有其第二行 scroll region 拥有 `overflow:auto`。op outline 不再另造嵌套纵向滚动。
- 左栏滚到底部时，右栏所选产物、canvas pan/zoom 与滚动位置保持不动。
- live event 到达时，只有使用者已在左栏底部附近才自动跟随；使用者已向上阅读则保留位置并显示“回到最新”。

### 4.2 窄屏

- 内容容器宽度不足时继续使用 Build / Review `TabBar`，两个 panel 保持 mounted，仅活动 panel 占满剩余高度并滚动。
- 工作上下文条留在 tab 上方；390px 只显示资源总数、排队状态与“管理”，详细 chips 进 Dialog。
- 390×568/844 无横向溢出；可点目标至少 44×44；软键盘或短可视高度出现时，header 次要信息、journey 标签与 context chips 折叠为单行摘要，workspace 始终保有一个 `minmax(0,1fr)` 轨道。
- Composer 在活动 pane 的唯一 scroll region 内走 normal flow；visual viewport resize 后以
  `scrollIntoView({block:'nearest'})` 保证输入框与提交动作可达，不使用 fixed/sticky 遮挡内容。

### 4.3 工作上下文条

工作上下文不是第三个页面，也不是会话消息的一部分。它是会话和产物共同依赖的 baseline：

- 默认显示最多三个 actor-safe identity chip（资源图标、名称、类型），其余折叠为 `+N`；
- 不可用资源显示“资源不可用 + type + handle”，不回退 raw id 或旧名称；
- queued 时显示 `+N / -N` 与“本轮结束后自动刷新”；
- interrupt 时显示“正在停止当前轮并刷新”；
- applied + 新 turn running 时显示“正在基于新上下文生成”；
- failed 时显示安全错误原因及“调整变更 / 放弃”入口；
- audit/archived 只读时仍完整显示上下文与状态，但没有管理入口。

### 4.4 管理工作上下文 Dialog

复用公共 `Dialog`、`Segmented`、`ResourcePicker`、`StatusChip`、`NoticeBanner`、按钮体系：

1. 上部显示当前已应用资源；
2. 资源类型分段 + 可搜索 picker 用于 staged additions；
3. 已应用资源可 staged removal，保存前不逐项写后端；
4. footer 显示精确 delta；
5. 空闲时主按钮为“应用并生成新版”；
6. 运行中主按钮为“本轮结束后应用并生成新版”，次按钮为“停止当前轮并立即刷新”；
7. 已有 after-current queued change 时打开的是其 staged 目标，可“更新排队变更”或“取消排队”；
   interrupt一旦 exact stop request已持久化即进入不可逆“正在停止”，短暂锁定 replace/cancel并说明原因；
   failed change可“调整并替换”或 exact “放弃”；
8. queued/no-op/applied/failed/superseded/canceled/dismissed 均有可按 change id 或 mutation id 对账的
   terminal receipt；
9. apply journal 未收敛、archived 或只读时禁用并给出正文原因，不只靠 tooltip。

## 5. 交互决策

### D1：默认不打断当前轮

运行中保存上下文变更时，默认让当前轮完成。变更持久化为 queued；当前 agent turn terminal 的同一事务中应用 delta、bump context epoch、插入用户工作上下文事件并预留下一轮生成。

### D2：提供明确的立即模式

“停止当前轮并立即刷新”的 effectful queued insert/replace、`interruptCommittedAt` 与 exact old turn
`cancelRequestedAt` 在**同一个 DB transaction**提交；只有 commit 后才 best-effort 中止同一
claim/controller。任一竞争或 DB失败都整批不提交，不能留下“journal写了但 cancel没写”的半动作。
即使取消响应丢失、claim 尚未注册 controller 或 runtime 慢退出，queued request 与 cancel request
仍不会丢；旧 turn 真正 terminal 且旧进程组已退出后才启动新版，绝不并发运行两轮。

### D3：不是热挂载

当前模型进程继续使用启动时冻结的 manifest。工作上下文条明确写“将在下一轮生效”，不得让 UI 文案暗示资源已注入当前运行。

### D4：空闲变更与自动生成原子绑定

空闲时，effectful delta 与新的 agent running reservation 在同一个 DB transaction 完成。不会出现“挂载已生效但还要用户手工重跑”的可见中间态。

### D5：当前轮产物保留历史，但新版前不可提交

默认等待的当前轮若成功产出 draft，该 draft 仍保存以便审计；queued delta 随后 bump epoch，使其立即成为 stale。新 running reservation 同事务占住 session，因此不存在可提交旧 draft 的间隙。

### D6：先验证可生成，再改变上下文

ACL、owner active、session active、context/turn OCC、pending replacement CAS、无 unsettled apply 都在
改变 manifest 前验证。系统还必须先成功解析并持久绑定本次 reservation 的 authoritative generation
policy snapshot（含 budget 上限与 fingerprint），再在同一 manifest transaction 中判断预算；任一失败
整批零副作用，旧 context/draft 仍保持原状。runner 只能消费该绑定，不得在 context 已变后换用另一份配置。

### D7：变更全量暂存、一次提交

Dialog 中多项 add/remove 是一个 all-or-nothing delta，只 bump 一次 context revision。不得继续由前端循环多个 `/mounts` 请求形成部分成功。

### D8：排队动作可替换、可取消

每个 queued request 不可变；修改时以 `supersedesChangeId` 原子终结 exact latest queued/failed row
并插入新 row。取消只作用于 exact queued id；放弃只作用于 exact failed id；重复取消/放弃返回原
terminal receipt。interrupt stop一旦赢得 CAS就不可撤销，row在 old turn terminal前拒绝 replace/cancel；
若另一个标签先 replace/cancel，原 interrupt不得再取消 turn。跨标签页看到不同 id/revision/turnSeq
必须 refetch，不覆盖别人的更新。

### D9：agent mount request 也自动继续

Builder 同一轮提出 questions 与 mount requests 时，界面合并为一个“需要你的决定”区和一个提交动作。服务端在同一事务中写 mount decision / answers、应用批准的资源、预留下一轮；reject-only 或 already-mounted 仍会生成下一轮，因为该决定本身需要送回 Builder。持久化审计 receipt 与 model-safe semantic text 分离，下一轮只能看见 type/name/handle/decision，不能看见 resource/session/change/owner id。

### D10：无效 delta 不浪费生成预算

只有空 delta，或所有 additions 已经是 root且没有 removals时，request才可能收敛为 `no-op` receipt。
但所有新 mutation必须先通过 exact current/just-terminal causal turn fence，并对每个 requested addition
（包括 already-root）复验 canonical row存在与当前可见；no-op不是授权或 stale gate旁路。通过后 no-op
不 bump epoch、不启动新轮。任一 remove必须指向 exact current root；known non-root、unknown handle与
valid+invalid mixed都整批 stale/404。相同 request replay只返回原 receipt。

### D11：新建/提交后的 RFC-291 自动挂载保持原样

Intent commit 创建/copy 的资源继续在 apply 大事务内自动成为 root。它不是本 RFC 的“手工工作上下文 delta”，不会在 commit 后自动额外生成一轮；工作上下文条只负责如实显示结果。

### D12：旧 API 保持兼容但退出前端主路径

legacy add/remove 仍要求 idle、逐项生效且不自动生成，避免破坏既有 API 调用者；它们与新 API 共用 `applyIntentWorkingSetDelta`，并在存在 queued change 时 409。前端与新 E2E 必须证明不再调用 legacy 路由。

### D13：幂等回执先于易变状态门

请求只先做 owner 同形授权与 canonical hash；随后必须先 reconcile exact mutation ledger。已提交请求
无论后来 context、turn、archive 或 apply 状态如何变化，都返回它当前的 queued/terminal receipt；
只有全新的 mutation 才进入 writable、OCC、in-flight、apply 与 budget gates。same id changed body 409，
stranger 始终 404。

### D14：异步执行必须可唤醒、可取消、可关停

`wake()` 是 non-throwing hint，短周期 durable reconciler 是活性兜底。claim 必须绑定 exact
`turnId+claimId+runAsUserId`、持久 cancel 状态与 runtime process identity；semaphore wait 可 abort。
detached runtime 通过 supervisor handshake 启动：DB 持久化防 PID 复用 identity 前不得 spawn 模型，
parent 在 handshake 中死亡时 supervisor 自杀，关闭 spawn→DB 无身份窗口。
graceful shutdown 停止新 claim、终止并 reap exact Intent 进程树；`main exited`、`drainTimedOut`、
`unreaped`或 AbortSignal触发都不是退出证明。只有 supervisor证明 containment为空、endpoint关闭且自身被
reap后才能 terminal+drain；否则保留 `reap-pending` claim/slot。硬崩溃后的 boot在启动 successor前必须
完成同一防 PID复用 fence，不能只把 DB row标 terminal就宣称没有双跑。

### D15：模型释放前做最终授权

普通 owner reservation 以 fresh user 构造 `source:'session'` actor；只有真实 system user 可用 daemon
source，禁止缺失 owner 时回退 system。claim 后生成 frozen disclosure snapshot，紧邻 seed 交给模型前
再次校验 exact claim、user/status/role、所有资源 ACL 与 content fence；任一变化 typed settle 且 spawn=0。
snapshot开始时已经不可用的 mounted root继续沿 RFC-291省略正文并输出 safe Access note；只有
visible/unavailable分类或 fence在 snapshot→admission窗口变化才使本轮作废。

### D16：失败与异步终态都能收口

failed change 可 exact dismiss 或被新 change supersede；queued 后转为 no-op/canceled/superseded/failed/
applied 仍可按 id 查询并幂等重放。Detail 先取最新 row，再决定是否展示 active banner，绝不因过滤掉
新 terminal row 而让更早的 failed 重新出现。

## 6. 用户旅程

### US-1：长会话并行复核

用户把左侧历史滚到底部或展开长执行流，右侧 workflow canvas 始终可见；切换/滚动右侧 op 时左侧当前位置不变。

### US-2：运行中补资源（默认）

用户发现 Builder 缺少一个 Agent，打开工作上下文、选中资源并保存。当前轮继续，顶栏显示“+1，本轮结束后自动刷新”。当前轮结束后系统自动进入下一轮，新 draft 到达后直接恢复提交。

### US-3：运行中补资源（立即）

用户选择“停止当前轮并立即刷新”。历史记录当前轮已取消；上下文条进入刷新中；系统只在旧进程终止后开始新轮。

### US-4：已有 draft 时调整上下文

用户 add/remove 资源并保存。旧 draft 立刻以只读 stale 状态保留，系统自动生成新版；用户不输入占位消息，也不能误提交旧 draft。

### US-5：Builder 同时提问并请求资源

用户在一个当前待办区回答问题、批准/拒绝资源并一次提交。页面只启动一轮后续生成，不经历“先挂载、再回答、再手工重跑”三段动作。

### US-6：刷新与多标签页

保存响应丢失后，页面以 exact `clientMutationId` 或 change id 得到 queued 及任意 terminal 状态。另一标签页替换 queued delta 时，本页不能以旧选择覆盖它；古老 turnSeq 的 Dialog 也不能作用于后来对话。

### US-7：失败可恢复

排队期间资源被删除或撤权，应用失败且 context 没变；用户可 exact 调整/替换或放弃，旧 failed 不会
永久占住 journey。若 context 已应用而 runtime 启动失败，旧 draft 明确 stale，提供“重试生成”，不要求重新选择资源。

## 7. 能力影响清单

| 影响                            | 结论                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI 中“只挂载、不刷新”的单独动作 | 主路径移除；新 UI 的 effectful context change 总与新版生成绑定。legacy API 仍保留。                                                                             |
| 运行中挂载                      | 从完全禁用扩展为 durable queue；不承诺热注入当前进程。                                                                                                          |
| 当前轮结果                      | 默认模式保留历史；立即模式由用户显式取消。                                                                                                                      |
| 提交旧 draft                    | queued/applying refresh 期间继续 fail-closed；不放宽 RFC-234 的 context fence。                                                                                 |
| 资源数量                        | 不新增上限。                                                                                                                                                    |
| ACL / visibility / owner        | 不变；应用时与模型 seed 释放前都重新验证。                                                                                                                      |
| archived / admin audit          | 仍只读。                                                                                                                                                        |
| API 自动化调用者                | legacy mount API 默认行为不变；新增批量 API。                                                                                                                   |
| 升级时已有 legacy running turn  | 因旧版本没有可验证进程身份，新 daemon fail closed；应先在旧版等到 idle。遗留 crash row 只能在 daemon 停止且人工确认无活进程后由专用 doctor 收口，绝不自动续跑。 |

## 8. 验收标准

- **AC-1**：1536px 与 2560px 内容区中，Intent 页面使用至少 95% 可用宽度；右栏宽于左栏，canvas 宽度随剩余空间增长。
- **AC-2**：桌面左、右栏是两个命名滚动 region；在两边都溢出的 fixture 中分别满足
  `clientHeight < scrollHeight`，滚动任一栏不会改变另一栏 `scrollTop`，右栏 rect 始终在 viewport 内。
- **AC-3**：390×568、390×844、内容宽度 1080px 边界无横向 overflow，两个 panel 保持 mounted；模拟
  soft-keyboard 将可视高度压至约 300px 后 Composer 与提交动作仍可滚动到达，Tab 切换不丢 selection/canvas 状态。
- **AC-4**：live timeline 仅在 near-bottom 时跟随；向上阅读时显示可键盘触达的“回到最新”。同 turn
  `running→changeset/error` 即使 event count 不变也触发相同 pin 判据：pinned 跟随，unpinned 保位并累计 unseen。
- **AC-5**：工作上下文条始终位于两栏上方；actor-safe 名称/类型可见，raw resource id 不可见。
- **AC-6**：idle effectful delta 一次请求、一次 epoch bump、一次 agent reservation；UI 不调用 legacy add/remove 循环。
- **AC-7**：running `after-current` 请求持久化 queued，当前 context 与进程不变；terminal transaction 原子应用 delta 并预留下一轮。
- **AC-8**：effectful `interrupt` 的 journal insert/replace + interrupt committed marker + exact old turn
  cancel flag在一个 transaction提交；与跨标签 replace/cancel竞态只有一个赢家。stop committed后不可逆；
  claim前、controller注册前、semaphore等待中都可收敛，不能取消后来 turn，也不能让两轮 runtime重叠。
- **AC-9**：queued request 可 exact replace/cancel，failed 可 replace/dismiss；same-id same-body 在
  applied/no-op/failed/superseded/canceled/dismissed 及后来 archive/apply 状态下仍返回原 receipt，same-id changed-body 409。
- **AC-10**：ACL/删除/archive/owner disabled/OCC/apply unsettled/authoritative budget exhausted 任一失败时
  delta 全部不生效、epoch/turn count 不变；queue 后降额与重启后降额也 spawn=0。
- **AC-11**：当前轮成功 draft + queued delta 的路径保留旧 draft 历史，但 detail 同一可见状态已经是 stale + new running，commit 从无开放窗口。
- **AC-12**：context 已应用但生成启动失败时，资源保持已应用、draft stale、typed error + Retry 可用。
- **AC-13**：daemon 在 queued、旧 turn running、delta applied + new reservation 三个时间点重启，或
  daemon-alive 时丢 wake/claim 后抛错，均能确定收敛、只 spawn 一次。只杀 daemon PID 的 E2E 必须证明旧子进程组消失且 runtime `maxConcurrent=1`。
- **AC-14**：questions + mount requests 一次提交、一个事务、一个后续 running turn；任一 decision 非法整批 rollback；真实 `INTENT.md` 不含候选 resource/session/change/owner id。
- **AC-15**：空 delta或全 add-satisfied且无 remove才可能 no-op；新 mutation仍须先通过 exact causal turn
  fence，且每个 addition（含 already-root）须 final存在/ACL复验。通过后不 bump、不生成、不消耗 budget且
  receipt可 replay；remove non-root/unknown失败并锁住 legacy 404。
- **AC-16**：unavailable existing root 可被移除；新增不可见资源 404 同形；UI/prompt/WS/log 无 raw id 泄漏。
- **AC-17**：pending refresh、read-only、archived、unsettled apply、stale、validation error 都在提交 action 正文给出精确原因和可用下一步。
- **AC-18**：中文/英文、light/dark、reduced-motion、keyboard、touch 与 axe serious/critical 通过真实浏览器验收。
- **AC-19**：working-set request pin exact `expectedTurnSeq`；同 session 古老 turn、跨 session turn 与 terminal 后已有任何新 user/agent turn 都 409/404 且零副作用。
- **AC-20**：短周期 reconciler在 daemon不重启时收敛 lost wake、unclaimed past grace与
  claimed-without-owner；`launching` token-only也先等 handshake deadline并证明 supervisor不能再 release，
  `spawned|reap-pending`须 whole-tree proof。真实 live owner不按墙钟误回收。
- **AC-21**：launch-token/supervisor handshake在 identity commit前不 spawn模型且 parent EOF自杀；
  graceful shutdown停止 claim、abort/kill/reap Intent进程树。`drainTimedOut`/`unreaped`下未取得
  `{treeEmpty,endpointClosed,supervisorReaped}` proof就保持 `reap-pending`；硬崩溃 boot在旧 runtime未证明
  消失时 fail closed，不启动 successor。
- **AC-22**：claim-bound frozen disclosure 在 spawn 前复验 user、role、ACL、owner transfer 与 content fence；dump 后任一变化均 typed settle、spawn=0。
- **AC-23**：含 legacy-unfenced running row 的升级 boot 在 listener 前 fail closed；不会自动 settle或启动
  successor。旧版 idle 升级正常；offline doctor无 exact确认不得改 row。

## 9. 发布边界

本 RFC 必须按 `proposal → design → plan → 用户批准 → 实现` 执行。当前 Draft 只授权设计落档，不授权生产代码改动。实现完成后另跑实现门、`bun run gate:local`、Intent 真实 E2E、视觉回归与 exact-SHA CI。
