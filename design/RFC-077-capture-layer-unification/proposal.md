# RFC-077 — opencode Session 捕获层统一（评估）

> 状态：Draft
>
> 编号：RFC-077
>
> 类型：**评估型 RFC**（先评估是否值得做 + 给出推荐方案，实现阶段以用户批准为条件）
>
> 依赖（被统一的三处来源）：RFC-027（节点 session 后置捕获）、RFC-043（蒸馏 session 后置捕获）、RFC-048（subagent 实时轮询捕获）
>
> 不改变：`parseSessionTree` / `SessionTree` 模型 / 前端 `ConversationFlow` 渲染 / 两张事件表 schema / 任何对用户可见的对话内容

## 1. 背景

平台现有**三处**从 opencode 的 XDG SQLite（`~/.local/share/opencode/opencode.db`）只读读取 session 事件、BFS 遍历 `session.parent_id` 树、把 message+part 行 transcode 成统一 NDJSON 事件、再落进各自事件表的代码：

| 处 | 文件 | 引入 RFC | 落库表 | 触发时机 |
| --- | --- | --- | --- | --- |
| ① 节点后置捕获 | `services/sessionCapture.ts` `captureChildSessions` | RFC-027 | `node_run_events` | worker opencode 子进程退出后一次性读 |
| ② 蒸馏后置捕获 | `services/distillSessionCapture.ts` `captureDistillJobSession` | RFC-043 | `memory_distill_events` | 蒸馏 opencode 子进程退出后一次性读 |
| ③ subagent 实时捕获 | `services/subagentLiveCapture.ts` `startLiveSubagentCapture` | RFC-048 | `node_run_events` | 父进程运行期间定时轮询 |

三者**已共享**两个纯函数：`resolveOpencodeDbPath()` 与 `transcodeOpencodeRowsToEvents()`（②③ 都 `import ... from './sessionCapture'`）。但**核心遍历过程是手抄复制的**：

- **BFS 遍历**（`SELECT id, parent_id, agent FROM session WHERE parent_id = ?` + visited-set + queue）在三处近乎逐字重复（`sessionCapture.ts:212-230`、`distillSessionCapture.ts:94-118`、`subagentLiveCapture.ts:174-192`）。
- **逐 session 的 message/part SELECT**（两条固定 SQL）在三处逐字重复（`sessionCapture.ts:248-259`、`distillSessionCapture.ts:122-133`、`subagentLiveCapture.ts:198-209`）。
- **行接口声明** `OpencodeSessionRow` / `OpencodeMessageRow` / `OpencodePartRow` 在三个文件里各抄一份（`sessionCapture.ts:100-117`、`distillSessionCapture.ts:41-58`、`subagentLiveCapture.ts:85-102`）。
- **`markCaptureFailed`**（写一条 marker 行 + 永不抛）在 ①② 各一份，仅表名/行形状/`kind` 字符串不同（`sessionCapture.ts:348-367`、`distillSessionCapture.ts:175-193`）。

### 1.1 为什么现在提

RFC-043 在 `distillSessionCapture.ts:1-9` 的头注释里明确写了当初**有意不抽象**的理由，并立了一个触发条件：

> "We deliberately keep it a near-90% copy of captureChildSessions rather than abstracting over the owner … **When a third capture owner appears we can revisit.**"

**第三个 owner 已经出现**：RFC-048 的 `subagentLiveCapture.ts` 就是第三处复制同一套 BFS+SELECT 的代码。当初约定的"再 revisit"触发条件在字面上已满足，因此本 RFC 把这次评估正式落档。

### 1.2 真正的成本不是"看起来重复"，是漂移风险

这次重复**不会**造成用户可见的不一致——三处最终都喂给同一个 `parseSessionTree` + 同一个 `ConversationFlow`，渲染出来的对话强一致（见上一轮分析）。代价是**单向漂移风险**：

- 在 `sessionCapture.ts` 的 BFS/SELECT/transcode 取数路径上修了一个 bug（例如 opencode 改了 `part.type` 枚举、或某个 session 列改名），**很容易忘记同步到 `distillSessionCapture.ts`**，于是蒸馏那一支会悄悄落后、捕获不全或落空 marker。
- `subagentLiveCapture.ts` 头注释自己承诺"final transcript matches RFC-027 **byte-for-byte**"，这个不变式当前靠"三份代码恰好一致"维持，没有任何机制强制；任何一处单独改动都会静默打破它。

## 2. 目标 / 非目标

### 2.1 目标

1. **评估**把三处共有的"打开只读 DB → BFS session 树 → 逐 session 读 message/part → transcode"过程收敛为**单一实现**是否值得、以何种切法风险最低。
2. 给出**推荐方案**与**明确的不做（do-nothing）对比**，让用户拍板。
3. 若获批：在**完全不改变可观察行为**（事件内容、落库行、marker、dedup 语义、byte-for-byte 不变式）的前提下，让三处共用同一份遍历核心；新增 capture owner 退化为一个薄适配器。

### 2.2 非目标

- **不**改 `parseSessionTree` / `SessionTree` / 前端渲染 / 两张事件表 schema。
- **不**改捕获语义：root 是否纳入、sibling-session 去重、partId 去重、live↔post-run 交接、auto-disable、`onInsert` 回调，全部按现状保留。
- **不**强行把"一次性后置捕获"和"实时轮询编排"合成一个函数——轮询器的 interval / 重入保护 / 连续失败禁用 / 持久 DB 句柄是 live 专属编排，本 RFC 不动它的生命周期，只替换它内部那段抄来的 BFS+SELECT。
- **不**改 `resolveOpencodeDbPath` / `transcodeOpencodeRowsToEvents`（它们已经是共享纯函数）。

## 3. 维护者故事（本 RFC 的"用户"是未来改这块的人）

- **作为修 bug 的人**：opencode 升级后改了 part schema，我只需改一处遍历核心 + 一处 transcode，三个捕获点同时受益，不必记得"还有蒸馏那一份要同步"。
- **作为加新捕获 owner 的人**（例如未来给 review / clarify 子进程加 session 捕获）：我只写一个"目标表 + 行形状 + marker kind"的薄 sink，BFS/SELECT 复用核心，不再 copy 90 行。
- **作为 reviewer**：看到三处都 `import { walkOpencodeSessions }`，一眼确认遍历逻辑同源，byte-for-byte 不变式由代码结构保证而非巧合。

## 4. 验收标准

1. **行为零变化（硬性）**：现有捕获测试全套保持绿且断言不变——`session-capture-sqlite` / `distill-session-capture` / `subagent-live-capture` / `subagent-live-capture-source` / `memory-distiller-capture-rfc043` / `routes-session` / `sessions` 等（见 `design.md §测试策略`）。这些测试就是本次重构的**等价性预言机**。
2. **遍历核心单一**：三处的 BFS+逐 session SELECT 全部委托给新建的共享核心；`OpencodeSessionRow/MessageRow/PartRow` 只声明一份并被复用。
3. **漂移风险关闭**：新增"遍历核心"单测覆盖 root-inclusion 开关、空 part、自环（self-loop）防挂、未知 part.type 丢弃等分支，作为唯一的取数行为契约。
4. **门禁全绿**：`bun run typecheck && bun run test && bun run format:check`，CI（含 build smoke + Playwright e2e）。
5. **若评估结论为"不做"**：本 RFC 以 `Superseded`/`Done(评估:不实施)` 收尾，并在 `distillSessionCapture.ts` 头注释里把"第三个 owner 已出现但经评估仍维持复制"的结论与理由补上，避免下一个人重复发问。

## 5. 推荐（详见 `design.md`）

倾向 **Option B（最小风险切法）**：抽出一个 `walkOpencodeSessions(db, rootSessionId, includeRoot)` 生成器，吃掉三处最大且最危险的重复（BFS + 逐 session SELECT + 行接口），各站点保留各自的 insert/dedup 循环（那里承载真正不同的语义）。`markCaptureFailed` 提取为按 sink 参数化的小工具。Option C（再加 `CaptureSink` 接口把 insert 也统一）列为可选后续，不在首个 PR 强求。
