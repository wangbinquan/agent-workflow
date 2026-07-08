# RFC-145 · 失败形态结构化：failure_code + supersede 事实列化（proposal）

- **状态**：Draft（G3-G10 批量授权内，设计门后直接实现）
- **来源**：`design/flag-audit-2026-07-07.md` §4.3（RFC-G3）；用户 2026-07-08 授权 G3-G10 一次性完成、拍板准则「面向代码最合理 > 改动最小」
- **前期调研**：三路并行（信封前缀协议全景 / supersede 标记全景 / rerun_cause 先例 + 源码锁盘点），行号以调研实测为准

## 1. 背景

`node_runs.error_message` 是人读文本列，但两个机器协议寄生其上：

1. **信封失败 follow-up 路由**：runner 在 11 个 stamp 点往 errorMessage 写前缀化字符串
   （3 个常量分居 `envelope.ts:235/248/265` + 2 份逐字重复的裸字面量 `'no <workflow-output>
   envelope found in stdout'`〔runner.ts:1236/1244〕+ `'clarify-and-output-both-present'`
   〔:1205〕+ `'clarify-questions-'` 命名族间接约定），scheduler 的 `decideEnvelopeFollowup`
   （scheduler.ts:677-730）用 **7 连 `startsWith` 且顺序敏感**（⑥ envelope-port-malformed
   必须排在 ⑦ port-validation 之前）反向解析出 followup reason。新增一种可 follow-up 失败
   = 产出 stamp + decide 链插分支（排对顺序）+ 三份 reason union（scheduler/runner/prompt
   逐字重复）+ prompt if-chain ≈ **8-9 处 shotgun**。
2. **review supersede 标记**：`superseded-by-review-{iterated|rejected}[-rollback]:` 把
   「被 review 取代 / 决策类型 / 是否回滚」三个事实编码进前缀（写点 review.ts:2077）。
   前缀字面量在源码里有 **3 份独立拷贝**（dispatchFrontier.ts:63 权威、clarifyRerunLedger.ts:244
   inline fork、前端 noderun-status.ts:19-22 四条展开式），靠 3 组 parity 文本锁防漂移；
   `isReviewSupersededRow` 自 RFC-095 起是 **LOAD-BEARING dispatch 契约**（误判假阴 = 在
   supersede→mint 窗口内裸跑 agent；假阳 = 行永不复活、假 stalled）。

第三条（`errorSummary === 'daemon-restart'`）已由 flag-audit W0-5 常量化治理完毕，本 RFC
确认现状、不再动。`xxx-failed:` 冒号短码族（wrapper-merge-failed / git-diff-failed /
inner-* / aggregator-* 等）经全仓 grep 证实**零机器读**，是纯人读 breadcrumb——不纳入。

## 2. 目标

1. **`failure_code` 枚举列**（node_runs）承载信封失败分类学：生产侧 7 值
   （envelope-missing / clarify-and-output-both / clarify-questions-malformed /
   clarify-required / clarify-forbidden / envelope-port-malformed / port-validation-failed），
   runner 在 stamp 点**正向声明**代码，`decideEnvelopeFollowup` 改为
   `Record<FailureCode, …>` 查表——7 连 startsWith 链删除，顺序敏感性消亡；
   渲染 reason（6 值）由查表投影，`clarify-forbidden → envelope-missing` 的隐式降级显式化。
2. **supersede 三事实列化**：`superseded_by_review`（'iterated'|'rejected'）+
   `rolled_back`（boolean）两个正交列；`isReviewSupersededRow` 契约从 `startsWith` 换成
   `IS NOT NULL` 判定；clarifyRerunLedger 双站切列（inline fork 常量删除）；前端 decode
   改读 DTO 新字段（4 条展开式字面量删除）。
3. **backfill 而非双读**（拍板准则）：migration 0077 一次性反解存量前缀（LIKE 模式完全
   规则）；读侧单一干净路径，不留「新列 + legacy 前缀回退」双路径。依据：本仓 flock 单
   实例 + 启动时迁移 ⟹ 不存在旧代码写新库的窗口；0075/0076 已验证迁移 SQL 的 fixture
   级测试形态。
4. **errorMessage 回归纯人读**：文案保持原样（对人有信息量、避免翻大量意图+载体弱锁），
   但全部机器消费点退役；新增源码守卫禁止未来在生产代码里机器读 errorMessage。

## 3. 非目标

- **不动 `xxx-failed:` breadcrumb 族**（零机器读；结构化 wrapper 失败留待有真实消费需求时）。
- **不动 envelopeFollowup 四字段散装**（runner.ts:354-376 的 bundle 形态是 flag-audit
  §5.1 的 G6 领地，RFC-148 做 ADT 化；本 RFC 只换其数据源）。
- **不动 tasks 表**（errorSummary/errorMessage 及 failTask 不变；daemon-restart 已治理）。
- **不改任何 followup 行为语义**：查表后每个 code 的 reason/failures 载荷与今日 decide
  链逐格等价（含 clarify-forbidden 降级）；prompt 渲染文本零变更。
- **decidedBy 不入列**（marker 本就不携带该事实，在 doc_versions 域）。

## 4. 用户故事（对内质量）

- **平台开发者**新增一种可 follow-up 失败：加 1 个枚举值 + 表里 1 行 + runner 产出点 1 处
  ——编译器（`Record<FailureCode,…>` 穷举）强制补表，不再有顺序敏感的 startsWith 链可排错。
- **排障者**直接看 `failure_code` / `superseded_by_review` / `rolled_back` 列，不再从
  error_message 前缀反推；error_message 纯粹是给人看的上下文。
- **前端**渲染 supersede 状态用结构化字段，`review.ts` 改文案不再可能静默打断前端分类。

## 5. 验收标准

1. `decideEnvelopeFollowup` 无任何 `startsWith`；输入含 `failureCode`，输出与现真值表
   （scheduler-envelope-followup-branch 8 例 + rfc123 + rfc049 系）逐格等价。
2. `isReviewSupersededRow` 为列判定；dispatchFrontier / scheduler / clarifyRerunLedger /
   前端五个消费点零前缀解析；`clarifyRerunLedger.ts` 的 inline 常量与
   `noderun-status.ts:19-22` 四字面量删除，对应 parity 锁按盘点清单更新或删除。
3. migration 0077：三列 + backfill（7 个信封前缀 + 2 个 supersede decision + rollback），
   存量行判定测试锁死（各前缀→码、不匹配行留 NULL、幂等）；journal 76→77 + rolling 锁 bump。
4. 生产代码新增源码守卫：`services/` `routes/` 内不得出现对 `errorMessage` 的
   `startsWith/includes/===` 机器读（允许 null 判与纯透传）。
5. runner 11 个 stamp 点全部同步声明 failureCode（先红后绿：真值表切数据源后，漏 stamp
   的分支立刻红）。
6. 门禁全绿 + CI conclusion=success + Codex 实现门收敛。
