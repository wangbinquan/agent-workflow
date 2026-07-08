# RFC-145 · 失败形态结构化（design）

> 行号为 2026-07-08 调研快照（HEAD `27857a82`），实现以 grep 实况为准。
> 先例蓝本：rerun_cause（RFC-098 WP-10——`as const → z.enum → infer` + 纯 nullable ADD COLUMN
> + `Record<RerunCause, boolean>` 编译期穷举锁）；backfill 蓝本：0075/0076 + fixture 级迁移测试。

## 1. 数据模型

### 1.1 新列（node_runs，migration 0077）

```sql
ALTER TABLE node_runs ADD COLUMN failure_code text;          -- FAILURE_CODES 之一或 NULL
ALTER TABLE node_runs ADD COLUMN superseded_by_review text;  -- 'iterated' | 'rejected' | NULL
ALTER TABLE node_runs ADD COLUMN rolled_back integer;        -- boolean（mode:'boolean'），默认 NULL=false 语义
```

- 与 rerun_cause 同范式：纯 nullable text，枚举在 TS 边界强制、不设 DB CHECK。
- `rolled_back` 用 `integer(mode:'boolean')`（先例 selectionStale）；NULL 与 false 同义
  （读侧谓词 `=== true`），backfill 只写 1。
- NULL 语义：`failure_code IS NULL` = 本行没有机器可读失败形态（绝大多数行的常态——不是
  每个失败都可 follow-up）；`superseded_by_review IS NULL` = 非 review supersede 行。

### 1.2 FAILURE_CODES（shared/schemas/task.ts，紧邻 RERUN_CAUSES）

```ts
export const FAILURE_CODES = [
  'envelope-missing',            // runner: 无 <workflow-output>（含 output-null 防御分支）
  'clarify-and-output-both',     // runner: 非 ask-back 下 clarify 与 output 并存
  'clarify-questions-malformed', // runner: clarify 解析失败（clarify-questions-* code 族折叠）
  'clarify-required',            // runner: clarifyActive 下产 output / both / none
  'clarify-forbidden',           // runner: clarifyStopped 下仍产 clarify
  'envelope-port-malformed',     // runner: parsed.malformedPorts 非空
  'port-validation-failed',      // runner: PortValidationError（RFC-049 内容校验）
] as const
export const FailureCodeSchema = z.enum(FAILURE_CODES)
export type FailureCode = z.infer<typeof FailureCodeSchema>
```

生产侧 7 值；渲染 reason 6 值是其**多对一投影**（clarify-forbidden 与 envelope-missing 同
渲染），由 §3 的策略表显式表达——今日 decide 链 :705 的隐式降级从此可读。

### 1.3 supersede decision 值域

复用 `shared/schemas/review.ts` 既有体系：新增
`export const SUPERSEDE_DECISIONS = ['iterated', 'rejected'] as const`（= REVIEW_DECISION_KIND
去 approved；approve 路径在标记代码前 early-return〔review.ts:1878〕，永不产 supersede）。
**防混淆立牌**：`doc_versions.decision` 的 `'superseded'` 是另一概念（RFC-074 系统退休
awaiting 版本），与本列无关——注释双侧互指。

## 2. 写侧

### 2.1 写入通道（全部经既有白名单，零新直写点）

- `NodeRunStatusUpdateExtra`（services/lifecycle.ts:46-63）Pick 加三列：`failureCode` /
  `supersededByReview` / `rolledBack`——随 status 转移在同一 `.set()` 原子落库
  （transitionNodeRunStatus:114 / setNodeRunStatus:176 均自动获益）。
- mint 侧不加 override（无出生即带码的场景：retryNode 占位行的 'queued for retry' 非机器
  失败；注入失败等 errorMessage 不在 7 值域）。

### 2.2 runner 正向声明（分类从「scheduler 反解」移到「产出点自述」）

runner 的 `RunResult`（内部类型）加 `failureCode?: FailureCode`；11 个 stamp 点在写
errorMessage 的同时置码（errorMessage 文案逐字节保持原状）：

| stamp 点（调研快照） | failureCode |
|---|---|
| runner.ts:1186/1188/1189（clarify-required 三变体） | `clarify-required` |
| runner.ts:1201（clarify-forbidden） | `clarify-forbidden` |
| runner.ts:1205（both-present 裸字面量） | `clarify-and-output-both` |
| runner.ts:1217/1218（clarify code 族 + 空 body fallback） | `clarify-questions-malformed`——**仅当 `firstErr.code.startsWith('clarify-questions-')`**（设计门 P2/D8）：clarify 校验器还会产 `clarify-options-*` 等码，今日 decide 链对它们不给 follow-up（落 default `{followup:false}`），置码会把无 follow-up 错误升级成同 session 续跑；非该族保持 failureCode 未置（unstructured）。:1218 空 body fallback 的字面量本就是 `clarify-questions-malformed:` 前缀，恒置码 |
| runner.ts:1236/1244（no envelope 两份裸字面量） | `envelope-missing` |
| runner.ts:1280（malformed ports） | `envelope-port-malformed` |
| runner.ts:1316（PortValidationError，`instanceof` 判定） | `port-validation-failed` |

runner-exit 主写点（runner.ts:1431 的 setNodeRunStatus extra）把 `failureCode` 与
errorMessage 并列落库。envelope.ts 三个前缀常量**保留**为 message 构造器（对人文案），
scheduler 不再 import；scheduler 本地 `PORT_VALIDATION_PREFIX`（:675）删除。

### 2.3 review supersede 写点（review.ts:2085-2096）

`setNodeRunStatus` extra 加 `supersededByReview: args.decision`（'iterated'|'rejected'）与
`rolledBack`（§2048-2067 既有 `rolledBack` 布尔）。errorMessage 的 marker 串**原样保留**
（人读 breadcrumb + 使既有写形态锁〔reviews-iterate-mints-new-run 的正则锁〕保持绿）。
`REVIEW_SUPERSEDE_MARKER_PREFIX` 常量随 `isReviewSupersededRow` 切列后**移居 review.ts**
（唯一剩余用途 = message 构造）；dispatchFrontier 不再导出它。

## 3. 读侧

### 3.1 decideEnvelopeFollowup 查表化（scheduler.ts:677-730）

- `PreviousAttemptShape` 加 `failureCode: FailureCode | null`（调用点 scheduler.ts:2426 从
  行读 `row.failureCode`）；`errorMessage` 字段从该 shape **删除**（唯一用途就是被解析）。
- 7 连 startsWith 链删除，换为：

```ts
// shared/prompt.ts（与渲染同居，reason union 单源化）
export const FOLLOWUP_POLICY: Record<FailureCode, { reason: EnvelopeFollowupReason }> = {
  'envelope-missing':            { reason: 'envelope-missing' },
  'clarify-and-output-both':     { reason: 'both-present' },
  'clarify-questions-malformed': { reason: 'clarify-malformed' },
  'clarify-required':            { reason: 'clarify-required' },
  'clarify-forbidden':           { reason: 'envelope-missing' }, // :705 的隐式降级显式化
  'envelope-port-malformed':     { reason: 'envelope-port-malformed' },
  'port-validation-failed':      { reason: 'port-validation' },
}
```

- decide 体 = 4 道早退门（status/exitCode/sessionId/agentTextCount 原样）→
  `code === null → {followup:false}` → 查表；`port-validation-failed` 时附
  `failures: prev.portValidationFailures ?? []`（载荷仍走既有
  port_validation_failures_json 列，不进 code）。顺序敏感性（⑥ 先于 ⑦）随链消亡：
  runner 在产出点已区分两种形态（malformed 在解析层、validation 在校验层，天然互斥）。
- `EnvelopeFollowupReason`（6 值）在 shared/prompt.ts 定义一次导出；scheduler.ts:654-660 与
  runner.ts:355-361 的两份逐字 union 改 import（三份 → 一份）。prompt 渲染 if-chain 本 RFC
  不动（G6/RFC-148 领地），只换类型来源。

### 3.2 supersede 判定切列

- `isReviewSupersededRow(row)`（dispatchFrontier.ts:65-67）→ `row.supersededByReview !== null`
  ——null/空串/缺尾横线/内嵌 note 等 startsWith 边界问题结构性消亡（rfc095 边界锁改写为
  列判定语义）。isDispatchable:322 与 scheduler.ts:1554 分桶自动获益。
- clarifyRerunLedger.ts:148/:264 → `r.supersededByReview !== null`（:148 处保留
  `status==='canceled'` 合取）；**删除** :244 inline 常量与 rfc131-target-consumed.test.ts
  的 source-text parity 锁（fork 消亡，锁无对象）。
- 前端：`NodeRunSchema`（shared/schemas/task.ts:570-662）加 `supersededByReview` +
  `rolledBack` 两字段（序列化点 task.ts:2245/2577 补映射）；`failure_code` **不进 DTO**
  （无前端消费者，随 rerun_cause 先例保持后端内部）。`noderun-status.ts` 重写：
  `classifyCanceled(run) = run.rolledBack ? 'rollback' : run.supersededByReview ? 'superseded' : 'manual'`、
  `supersededDecision(run) = run.supersededByReview`——4 条展开式字面量删除，签名从
  `(errorMessage: string|null)` 变为行字段（NodeDetailDrawer 等 3 个调用点跟随）。

## 4. migration 0077（含 backfill）

```sql
ALTER TABLE node_runs ADD COLUMN failure_code text;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN superseded_by_review text;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN rolled_back integer;
--> statement-breakpoint
-- 信封失败七前缀反解（互不重叠，顺序无关；仅 failed 行有这些 stamp，谓词从宽 LIKE 即可）
UPDATE node_runs SET failure_code = 'envelope-missing'            WHERE failure_code IS NULL AND error_message LIKE 'no <workflow-output> envelope found in stdout%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'clarify-and-output-both'     WHERE failure_code IS NULL AND error_message LIKE 'clarify-and-output-both-present%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'clarify-questions-malformed' WHERE failure_code IS NULL AND error_message LIKE 'clarify-questions-%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'clarify-required'            WHERE failure_code IS NULL AND error_message LIKE 'clarify-required%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'clarify-forbidden'           WHERE failure_code IS NULL AND error_message LIKE 'clarify-forbidden%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'envelope-port-malformed'     WHERE failure_code IS NULL AND error_message LIKE 'envelope-port-malformed%';
--> statement-breakpoint
UPDATE node_runs SET failure_code = 'port-validation-failed'      WHERE failure_code IS NULL AND error_message LIKE 'port-validation-%';
--> statement-breakpoint
-- supersede 三事实反解（decision 实际只有两值；-rollback 是 ':' 前可选后缀）
UPDATE node_runs SET superseded_by_review = 'iterated' WHERE error_message LIKE 'superseded-by-review-iterated%';
--> statement-breakpoint
UPDATE node_runs SET superseded_by_review = 'rejected' WHERE error_message LIKE 'superseded-by-review-rejected%';
--> statement-breakpoint
UPDATE node_runs SET rolled_back = 1 WHERE error_message LIKE 'superseded-by-review-%-rollback:%';
```

- 多语句必须 `--> statement-breakpoint`（0052/0053 事故记忆）。
- journal 76→77 + `upgrade-rolling.test.ts`「HEAD journal has 76 entries」bump 三件套。
- **为何 backfill 而非双读**（决策 D2 详述）：flock 单实例 + openDb 启动即迁移 ⟹ 迁移之后
  不存在旧代码写库窗口；未匹配前缀的行留 NULL 恰是正确语义（无机器可读失败）。0044 的
  「加列不 backfill」先例适用于 gate-degradation 可接受的场景；本 RFC 的读点是
  LOAD-BEARING dispatch 契约，双读意味着前缀解析代码与三份字面量永久保留——与目标背反。

## 5. 守卫（第 3/4 层）

1. **新源码守卫** `rfc145-error-message-machine-read-guard.test.ts`：扫 `packages/backend/src`
   生产代码（剥注释），`errorMessage` 出现在 `.startsWith( / .includes( / === '...'` 形态
   即红（allowlist 空；null 判与纯透传不匹配该形态）。前端同理扫 `packages/frontend/src`
   （noderun-status.ts 重写后应零命中）。
- 2. **穷举锁**：`Record<FailureCode, …>` 的 FOLLOWUP_POLICY 天然编译期穷举；另设
  `rfc145-followup-policy.test.ts` property：全 7 code × 表 → decide 输出与旧真值表逐格
  等价（旧真值表用 errorMessage fixture 的语义预期翻写成 failureCode fixture）。
3. **迁移测试**：0077 fixture 级（各前缀→码/不匹配留 NULL/幂等/supersede 三列组合），
   复刻 0076 形态。

## 6. 源码锁更新预算（据盘点清单，实现前逐一处理）

- **改写**：`rfc095-scope-outcome.test.ts:521-540`（边界锁 → 列判定语义 + 常量值锁删除）、
  `noderun-status-display.test.ts`（4 形态 → 字段驱动）、
  `scheduler-envelope-followup-branch.test.ts` 等 decide 真值表（fixture 换 failureCode）、
  `rfc098-rerun-cause-gates` 同型的 wiring 字面锁若引用 decide 旧形态则跟随、
  引用 `REVIEW_SUPERSEDE_MARKER_PREFIX` from dispatchFrontier 的测试改 import 或改字面。
- **删除**：`rfc131-target-consumed.test.ts:142-152` source-text parity 锁（fork 消亡）。
- **保持绿（不动）**：errorMessage 文案类锁（reviews-iterate-mints-new-run 正则写形态锁、
  各 `toContain('superseded-by-review-…')` 载体断言）——文案原样保留。
- s12 状态桶宇宙锁：`REVIEW_SUPERSEDE_MARKER_PREFIX` 引用改为造列 fixture。

## 7. 决策记录

- **D1 三列而非单 code 串**：failure_code（本行失败分类）与 superseded_by_review+rolled_back
  （行退休血缘）是正交概念；塞同一 code 串 = 换列不换编码，`-rollback` 后缀解析残留。
- **D2 backfill + 单读路径**（拍板准则「面向代码最合理」显式裁决，推翻调研三路给出的
  「双读回退、锁预算 0」保守建议）：依据见 §4；风险由 fixture 级迁移测试 + rfc130/095
  golden 群兜底。
- **D3 errorMessage 文案零变更**：机器地位取消但人读价值保留；同时把「意图+载体」类
  弱锁的翻锁面压到零。
- **D4 7 值生产域 / 6 值渲染域分离**：投影关系入表（FOLLOWUP_POLICY），clarify-forbidden
  降级显式化；渲染 if-chain 与四字段散装留给 G6（RFC-148）。
- **D5 failure_code 不进 DTO**（rerun_cause 先例）；supersede 两列进 DTO（前端本就消费）。
- **D6 breadcrumb 短码族不纳入**：零消费者，结构化无收益；留人读。
- **D7 常量归位**：REVIEW_SUPERSEDE_MARKER_PREFIX 移居 review.ts（message 构造器）；
  envelope.ts 三常量保留为 message 构造器；scheduler 的 PORT_VALIDATION_PREFIX 删除。
- **D8 clarify 解析失败的条件置码**（设计门 P2 产物）：runner.ts:1217 的 `firstErr.code`
  值域超出 `clarify-questions-*`（含 `clarify-options-*` 等），今日路由只认
  `startsWith('clarify-questions-')`——stamp 点按同谓词条件置码，非该族留 NULL，保住
  「查表后与旧真值表逐格等价」承诺；migration backfill 的 `LIKE 'clarify-questions-%'`
  本就同谓词、无需改。测试补一格：`clarify-options-*` 类 errorMessage 的行
  failureCode 为 NULL 且 decide 返回 `{followup:false}`。

## 8. 测试策略

1. shared：FAILURE_CODES 枚举 + FOLLOWUP_POLICY 穷举/投影锁（含 clarify-forbidden 降级格）。
2. backend：decide 真值表切源等价（8 例 + rfc123 stop + rfc049 port-validation 系全绿）；
   runner 11 stamp 点正向声明（漏 stamp 即真值表红——先红后绿：先切 decide 数据源、
   确认未接 stamp 时相关集成测试红，再逐点接线转绿）。
3. supersede：写点双列落库断言；isReviewSupersededRow 列判定边界；clarifyRerunLedger
   双站行为不变（rfc131/132 既有群）；前端 noderun-status 字段驱动重写测试。
4. migration 0077 fixture 级 + journal bump + rolling。
5. 守卫：errorMessage 机器读 grep 守卫（backend+frontend）。
6. golden：review 全套 / dispatch-frontier / rfc095 / rfc131/132 / envelope-followup
   全链保持绿。
