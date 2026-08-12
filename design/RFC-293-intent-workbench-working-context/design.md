# RFC-293 技术设计：Intent 持续迭代工作台

## 1. 约束与复用边界

本 RFC 不新增 runtime、安全或认证架构。生成继续调用现有：

```text
resolveIntentTurnConfig
  -> resolveInternalAgentRuntime
  -> runIntentTurn
  -> runSystemAgent
```

因此 runtime profile、provider、model、认证、配置发现与工具能力全部沿用当前普通 system-agent 行为。
RFC-293 只在 `services/intent` 内增加业务状态，且继续复用：

- `intent_sessions.in_flight_turn_id` single-flight；
- `context_revision` 的结果 CAS；
- RFC-291 manifest、handle allocator 与 watermark；
- `intent_apply_journal` 的 commit/checkpoint；
- `runIntentTurn` 的 dump、prompt、runtime 与 settle；
- 现有 owner/ACL 判据。

## 2. 数据模型

### 2.1 `intent_working_set_changes`

```sql
CREATE TABLE intent_working_set_changes (
  id                         TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL REFERENCES intent_sessions(id) ON DELETE CASCADE,
  client_mutation_id         TEXT NOT NULL,
  expected_turn_seq          INTEGER NOT NULL,
  expected_context_revision  INTEGER NOT NULL,
  mode                       TEXT NOT NULL, -- after-current | interrupt
  delta_json                 TEXT NOT NULL,
  state                      TEXT NOT NULL, -- queued | applying | applied | failed | canceled
  error                      TEXT,
  resulting_context_revision INTEGER,
  resulting_turn_id          TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);
```

- `(session_id, client_mutation_id)` unique，支持响应丢失后的同请求回读；
- 每个 session 只有一条 `queued|applying|failed` 未解决记录；
- `delta_json` 是 strict wire delta 的 canonical JSON；
- `applied` 表示 manifest/context revision 与 successor reservation 已在同一事务提交；
- `failed` 表示 context 未改变，可 replace/retry/dismiss。

### 2.2 `intent_draft_resolutions`

```sql
CREATE TABLE intent_draft_resolutions (
  draft_id    TEXT PRIMARY KEY REFERENCES intent_drafts(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL REFERENCES intent_sessions(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL, -- superseded | discarded
  created_at  INTEGER NOT NULL
);
```

成功 commit 继续由 `intent_apply_journal(state='committed')` 表达，不重复写 resolution。draft lifecycle 投影顺序：

1. session current pointer 命中 -> `current`；
2. committed journal 命中 -> `committed`；
3. resolution row -> `superseded|discarded`；
4. 其余历史 draft -> `superseded`（兼容升级前数据）。

### 2.3 generation mutation identity

`intent_turns` 增加 nullable `client_mutation_id`，并建立 session 内 partial unique index。RFC-293 新 iteration/current-
action 请求把 mutation id 写在 user turn；同 mutation + 同 canonical body 返回原 turn/agent reservation，changed body
返回 conflict。旧 message/answers/mount API 不要求该字段，兼容现有调用。

## 3. Shared wire

### 3.1 Working context

```ts
type IntentWorkingSetDelta = {
  additions: Array<{ resourceType: AclResourceType; resourceId: string }>
  removals: string[] // mounted root handle
}

type PostIntentWorkingSetChange = {
  clientMutationId: string
  expectedTurnSeq: number
  expectedContextRevision: number
  mode: 'after-current' | 'interrupt'
  replacesChangeId?: string
  delta: IntentWorkingSetDelta
}
```

DTO 只返回产品状态、delta 计数和可见资源 identity；WS 仍只做 session invalidation，客户端 refetch detail。

### 3.2 Iteration

```ts
type PostIntentIteration =
  | {
      mode: 'refine-current'
      clientMutationId: string
      expectedTurnSeq: number
      expectedContextRevision: number
      sourceDraftId: string
      sourceDraftHash: string
      feedback: string
    }
  | {
      mode: 'continue-checkpoint'
      clientMutationId: string
      expectedTurnSeq: number
      expectedContextRevision: number
      sourceCommitSeq: number
      feedback: string
    }
  | {
      mode: 'regenerate'
      clientMutationId: string
      expectedTurnSeq: number
      expectedContextRevision: number
      sourceDraftId: string
      sourceDraftHash: string
    }
```

### 3.3 Current action

`POST /current-action` 绑定 latest questions/changeset turn，同时携带 answers 与 mount decisions。两类输入都由服务端
从 source turn 推导完整集合，缺项、重复、额外项全部拒绝。manifest 变更、user turn 与 successor reservation 在
一个事务完成。

## 4. Working-set 状态机

### 4.1 纯 delta

`applyIntentWorkingSetDelta(manifest, watermark, delta, visibleRows)` 为纯函数：

- addition 已是 root -> no-op；closure member -> 升为 root；不存在 -> 分配新 handle；
- removal 必须命中 exact root；命中 closure/non-root/unknown 都失败；
- 同一资源同时 add/remove、重复 addition/removal 都在 wire 或纯函数层拒绝；
- 不限制 root 数量；watermark 只增不减；
- 输入对象不原地修改。

ACL/存在性在事务内重读后才把可见 rows 交给纯函数，沿用既有 404 shape。

### 4.2 Admission

`submitWorkingSetChange` 在事务中：

1. owner、active、无 unsettled apply；
2. exact `turnSeq/contextRevision`；
3. same mutation replay 优先；
4. 若已有 unresolved row，仅 `replacesChangeId` 精确命中时把旧 row 终结为 canceled 并插新 row；
5. idle -> 直接 activate；running -> `queued`；
6. `interrupt` 在 queue 提交后调用现有 exact session cancel，随后 drain。

### 4.3 Activate 与 drain

`activateWorkingSetChange` 只在 session idle 时从 `queued|failed` claim：

1. transaction 内 `state -> applying`；
2. 重新读取 session、manifest、ACL；
3. 应用完整 delta、bump 一次 context revision；
4. 写一条 model-safe user turn，预留一个 agent turn；
5. row `applied` 并保存 resulting revision/turn；
6. transaction commit 后交给同一个 Intent dispatcher。

任意校验失败把 row 记为 `failed`，manifest/context/turn 都不改变。`runIntentTurn`、cancel、start-failure 和 boot
recovery 每次释放 in-flight slot 后都调用 drain，因此排队动作不会依赖浏览器仍在线。

## 5. 持续迭代

### 5.1 Refine current

事务验证 current pointer、draft hash、context revision、turn seq 与 idle。插入 `kind='message'` user turn，正文包含
用户反馈和产品可读 source label；随后按现有机制 reserve agent turn。旧 draft 在 successor 运行期间仍是 current，
但 detail 的 activity=`generating` 使 commit 禁用。successor 成功安装新 draft 时，旧 current 写 `superseded`。
失败则旧 current 保持 current，可继续编辑或重试。

### 5.2 Continue checkpoint

要求 `currentDraftId IS NULL` 且 `sourceCommitSeq === session.commitSeq > 0`。插入 feedback user turn并 reserve。
`runIntentTurn` 会从已由 RFC-291 自动挂载的最新资源构建 fresh dump，因此不会重复 apply 旧 changeset。

### 5.3 Discard and regenerate

一个事务完成：

1. exact current draft/id/hash/context/turn fence；
2. 插入 `discarded` resolution；
3. 清 `currentDraftId`；
4. 插入固定语义的 user turn；
5. reserve agent turn。

失败不会回滚 discard，也不会复活旧 pointer。retry 只新建 agent turn，继续使用同一对话/dump。

### 5.4 Draft settle

`runIntentTurn.settle(changeset)` 安装新 draft 前，如 session 仍有不同 current draft，先 `INSERT OR IGNORE`
`superseded` resolution，再移动 pointer。apply claim 除既有 pointer/hash/context 检查外，拒绝任何已有 resolution 的 draft。

## 6. Detail 与 journey 投影

Detail 增加：

- `workingSetChange`；
- `drafts[]`（含 lifecycle）；
- `composerSource`：conversation/current-draft/latest-checkpoint；
- current draft `activity`：idle/generating；
- latest retryable error source。

Journey 优先级：apply running > working-set queued/applying/failed > turn running > questions/current action > current draft >
latest checkpoint > latest generation error。commit checkpoint 仍显示 step 4，但 action 文案为“已提交，可继续迭代”，不是终态。

## 7. Frontend

### 7.1 布局

`.intent-session-page` 成为 viewport workspace：

```css
height: calc(100dvh - var(--app-content-offset));
max-width: none;
min-height: 0;
overflow: hidden;
```

header/journey/context bar 为 auto rows，workspace 为 `minmax(0, 1fr)`。桌面 grid：

```css
grid-template-columns: clamp(360px, 32%, 620px) minmax(560px, 1fr);
```

conversation/review 各自 `min-height:0; overflow:auto`，删除 op outline 的嵌套纵向滚动。

### 7.2 Working context bar/dialog

顶部 bar 显示已应用数量、最多三个 name chip、queued delta 与状态。Dialog 复用 `Dialog`、`Segmented`、
`ResourcePicker`、`Checkbox`/按钮；本地 staged state 一次提交。运行中主按钮 queue，次按钮 interrupt。

### 7.3 Timeline 与 Composer

- current action 把 questions 和 suggestions 合在同一 section/footer；
- Composer 根据 `composerSource` 展示 chip 与 placeholder；
- draft actions：继续完善（聚焦 Composer）、废弃并重新生成、复核并提交；
- checkpoint card 提供“继续迭代”（聚焦同一 Composer）；
- scroll hook 记录是否 near-bottom；新 turn 到达时 pinned 才跟随，否则显示回到最新。

## 8. 测试

- shared：strict schemas、delta duplicate/contradiction、journey/detail/source；
- backend：migration fresh/upgrade，delta 六类型与 64+ roots，idle/queue/interrupt/replace/cancel/fail/retry，single successor，
  refine success/failure，checkpoint continue，discard success/failure/retry，current-action combined，commit resolution gate；
- frontend：action availability、dialog staged delta、composer routing、current action、independent scroll/pin；
- E2E：长会话+右栏可见、运行中 queue 自动续跑、提交前 refine、commit 后 continue、discard regenerate；
- visual/a11y：desktop wide、1080 tabs、390×844、light/dark、keyboard、axe。
