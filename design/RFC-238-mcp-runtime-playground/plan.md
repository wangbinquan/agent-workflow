# RFC-238 · MCP 运行时多轮测试对话框 — plan

状态：Implementation v1（设计门与用户实施批准均已通过；核心多轮链路已落地，强化验证与实现门待完成）。

## 1. 任务

- [x] **RFC-238-T1 现状定位与产品决策**：追踪
      `mcps.detail → McpInventoryPanel → operationConfigHash`、RuntimeDriver 两条 spawn、
      `runSystemAgent` 生命周期、RFC-224 owner/lease、RFC-235 Session renderer/event sink；
      与用户确认 runtime 选择、MCP-only 边界、多轮 resume、Dialog close 不取消、idle 10 分钟、
      cancel turn 与立即 end 分离。

- [x] **RFC-238-T2 设计门与用户批准**：Codex 设计门已关闭全部 P0/P1/P2，并记录
      `design-gate-review-2026-07-30.md`；用户已明确回复“批准”，允许按最终 RFC 修改
      `packages/**`。

- [x] **RFC-238-T3 Shared + migration**：strict request/DTO/status/receipt schemas；新增 session/
      turn/event/create-receipt 与 OpenCode playground owner 表、CHECK/partial unique/index；
      migration fresh/upgrade 约束测试已落地；完整 rollback fixture 归入 T10 强化验证。

- [ ] **RFC-238-T4 Service 与 HTTP/WS**：owner ACL、stable-id + operation hash、runtime
      fingerprint/capability、create/message idempotency、single-flight/idle CAS、cancel/end、
      SessionView endpoint、private WS locator + polling fallback。v1 已完成 service、HTTP 与
      1.5 秒 polling；private WS locator 尚待补齐。

- [ ] **RFC-238-T5 进程生命周期抽取**：从 `runSystemAgent` 抽 runtime-neutral captured attempt，
      现有 system-agent contract 与测试不变；MCP coordinator 接入 semaphore、AbortController、
      PID identity、TERM→KILL→reap、graceful shutdown、boot recovery、idle reaper、cleanup GC。
      v1 已通过 `runSystemAgent` 扩展接入前述核心生命周期、boot recovery 与 idle reaper；
      daemon graceful shutdown hook、周期 cleanup retry/receipt GC 尚待补齐。

- [ ] **RFC-238-T6 OpenCode capability**：独立 `mcp-test-v1` verified plan、closed controlled
      config、exact one MCP、persistent store、playground owner/lease/control ACK、new/resume、
      containment、same-instance identity 与 behavior qualification；不制造 task/node rows。
      v1 已完成 closed one-MCP plan、独立 store 与 native new/resume；完整 owner/lease/control
      ACK 行为资格与真实 runtime fixture 尚待补齐。

- [x] **RFC-238-T7 Claude Code capability**：专用 one-MCP spawn；built-in tools disabled、
      no bypass、strict MCP/settings/config-dir、new/resume、binary/env boundary与 fixture behavior
      qualification；已复用 RFC-237 的公共 binary snapshot 原语并保持能力声明独立。真实模型
      行为资格仍归入 T10。

- [ ] **RFC-238-T8 Capture 与 Session view**：抽 ordered sink core；session-wide event cursor、
      canonical external-key dedupe、root-id CAS、cross-turn `extraUserPrompts`、capture limit/
      incomplete/truncated/WS final cursor。v1 已完成 durable ordered sink、跨轮 dedupe、limits
      与 Session view；WS final cursor 尚待补齐。

- [x] **RFC-238-T9 Frontend Dialog**：Tools & Probe 入口；公共 Dialog/RuntimeSelect/TextArea/
      NoticeBanner/ConfirmDialog/StatusChip；dirty save basis、多轮 composer、cancel/end、idle
      deadline、close/reopen；共享 `SessionConversationPanel`，中英文与 responsive/a11y。

- [ ] **RFC-238-T10 自动化与真实验证**：shared/backend/frontend 定向；mock runtime + fixture
      MCP 两轮 E2E；cancel/end/expiry/config drift/ACL/response-loss/recovery；desktop light/dark、
      390px、keyboard、axe；全仓门禁与双 binary smoke。v1 已完成 backend 定向 73/73、
      Shared 全量 1,487/1,487、Frontend 全量 5,396/5,396，以及 typecheck/lint/format/depcheck/
      diff-check；真实 fixture/runtime、浏览器/axe、双 binary smoke 与全量 Backend 的受限环境
      复验仍未完成。RFC-224 source reachability 仍会因 OpenCode playground 直接调用 legacy
      `buildOpencodeSpawn` 而失败，必须由 T6 独立 verified plan 闭合，不能更新白名单绕过。

- [ ] **RFC-238-T11 实现门与收口**：从精确实现 commit 的分离 worktree 跑 Codex 实现门，
      关闭 P0/P1/P2；更新 RFC/STATE/index；按用户授权范围精确提交，若用户要求上库再 push 并按
      exact SHA 核验 CI。

## 2. 依赖顺序

```text
T1 → T2 设计门/批准
        ↓
       T3 schema+migration
        ↓
       T4 service/API/WS ─────────────┐
        ↓                             │
       T5 lifecycle core              │
        ├────────→ T6 OpenCode        │
        └────────→ T7 Claude          │
                     ↓                │
                    T8 capture/view ←─┘
                     ↓
                    T9 frontend
                     ↓
                    T10 full verification
                     ↓
                    T11 implementation gate/closure
```

T6/T7 可在 T5 interface 稳定后并行开发，但共享同一工作树时仍按精确文件归属合并。
T9 可先用 mock contract，但不得在 T3/T4 wire 未定时另造临时 API。

## 3. 建议实现切片

这是单一 RFC，建议在一个分支中分 6 个可独立复核的 commit，而不是把半个产品发布到 main：

1. `feat(mcp): RFC-238 persist runtime test sessions`
   - shared schemas、migration、DB/service state machine、ACL/idempotency/idle CAS。
2. `refactor(runtime): RFC-238 share captured attempt lifecycle`
   - 行为保持 refactor + process/recovery seams。
3. `feat(runtime): RFC-238 add MCP-only runtime capability`
   - OpenCode/Claude driver capability、identity/qualification。
4. `feat(mcp): RFC-238 capture multi-turn MCP sessions`
   - sink、session view、WS locator、limits。
5. `feat(frontend): RFC-238 add runtime test dialog`
   - UI/i18n/responsive/a11y。
6. `test(mcp): RFC-238 verify multi-turn playground`
   - real daemon fixture E2E、gates、review fixes、docs closure。

任何中间 commit 都不得在 UI 暴露无法安全运行的入口；若逐 commit push，feature route/entry
只在 capability + recovery + ACL 都完成后接通。

## 4. 不变约束

- MCP canonical identity 永远是 stable id；name 只作为 runtime config/tool namespace。
- session 固定 exact `operationConfigHash`；secret-bearing MCP config 不落新表/DTO/日志。
- 任意 operationConfigHash 变化同 tx 封住旧 session；失权/disabled 立即 abort，其它修改让
  已启动 turn 完成后自动 end。
- runtime profile fingerprint、实际 runtime binary digest、MCP execution digest 与 native
  session contract 均在首个模型请求前冻结；续轮 exact match。
- local/remote MCP 都先进入单一 frozen execution-material builder；secret 只进 private
  `0600` config，不进 argv/process title/receipt/log。
- 多轮必须用 runtime-native resume，不用 prompt history 拼接冒充。
- 每轮一个可回收进程；逻辑 session/store 跨轮存在，idle/end 才清理。
- idle TTL 固定 10 分钟；running/queued 不计；只有接纳新 message 续期。
- turn hard deadline 从接纳起固定 10 分钟并覆盖 queue+run；cancel/end/timeout 后的 queued
  worker 不能迟到 spawn。
- Dialog close/reload 不 cancel、不 end、不续期。
- Cancel 只取消当前 turn；End 始终保留并终止整个逻辑 session。
- end/idle/delete 只有在 child reaped/store unlocked 后才删目录；不确定则 quarantine。
- MCP/test-owner FK 使用 restrict/显式 teardown，不能由 cascade 先抹掉 recovery identity。
- 每个 session 最多一个 in-flight；message response-loss 不重复模型 side effect。
- 只挂当前 MCP；repo/其它 MCP/Skill/Plugin/dependent/memory/inventory/built-ins 全部不可达。
- runtime support 来自 closed driver capability，前后端不按 protocol 名称猜。
- OpenCode playground owner 不进入 task business owner 表，不伪造 Task/NodeRun。
- Session UI 只复用 `SessionConversationPanel` 与 strict shared response。
- 会话内容仅 owner/system admin；MCP owner/manager无权读他人测试 transcript。
- ACL/visibility/disable 的 canonical mutation transaction 同步把受影响 session 写 ending；
  post-commit abort 只负责杀进程，不承担权限线性化。
- MCP 调用可能产生真实外部副作用，UI warning 不可省略。
- RFC-237 为并行范围；只复用已经合入的公共代码，不覆盖其未提交内容。

## 5. 自动化验收清单

### Contract / DB

- [ ] strict schemas 与 unknown-field/size/enum 负例。
- [ ] create receipt + session + first turn 原子；active partial unique。
- [ ] create clientCreateId exact replay/mismatch 在 active-conflict 判断之前；旧 transcript
      清理后重放仍不产生 side effect。
- [ ] message single-flight、clientMessageId replay/mismatch。
- [ ] idle/message/end CAS race。
- [ ] queued cancel/end/hard deadline 与 semaphore 释放竞态不 spawn。
- [ ] cleanup-complete ended replacement；pending/quarantined row 不被误删。
- [ ] cleanup pending 可新建、quarantined 阻止新建且不丢 recovery row。
- [ ] secret absence audit。

### ACL / mutation

- [ ] viewer 可创建；另一 viewer 不可读；owner 与普通 MCP manager 不可跨用户读；system admin
      exact-id 可审计。
- [ ] revoke/visibility/disable 与 session-ending 同事务；delete restrict + 显式 teardown；
      runtime mutation 触发正确 end/block。
- [ ] user deletion 先 teardown test sessions，owner FK 不允许级联丢 recovery identity。
- [ ] delete 在 live child 未证明回收时失败关闭。

### Runtime / lifecycle

- [ ] driver capability source/completeness lock。
- [ ] OpenCode exact-one-MCP + effective MCP-only permission。
- [ ] OpenCode new/resume owner/lease/ACK pre-prompt。
- [ ] OpenCode persistent identity 不含 per-turn path，但锁 exact execution digests。
- [ ] Claude exact argv/env + 首轮预持久化 `--session-id` + MCP-only behavior + resume。
- [ ] systemAgentRun 既有路径行为不变。
- [ ] timeout/cancel/TERM→KILL/group reap/pipe flush。
- [ ] raw frame/单 event/stderr tail 有界，超限后固定 buffer drain。
- [ ] PID reuse guard、graceful shutdown、boot recovery、cleanup quarantine。
- [ ] plan identity receipt 与 PID/raw+wrapped command receipt 均在 prompt/stdin 前持久化。
- [ ] idle single timer + periodic reconciliation。

### Capture / frontend

- [ ] session-wide event sequence + resume replay dedupe。
- [ ] root session mismatch fail closed。
- [ ] 多轮 `extraUserPrompts` 与完整 tool events。
- [ ] capture terminal precedence、limits、final cursor refetch。
- [ ] Dialog public primitives、dirty paths、runtime lock、close/reopen。
- [ ] Cancel 与 End 独立；idle deadline 只展示、不客户端续期。
- [ ] `SessionConversationPanel` source guard。
- [ ] zh/en、desktop light/dark、390px、keyboard、axe。

### E2E / gates

- [ ] mock provider + fixture MCP 至少两轮 native resume。
- [ ] close/reopen while running。
- [ ] cancel then continue；running end；idle expiry；new session。
- [ ] builtin/other MCP negative access。
- [ ] config/runtime drift、ACL revoke、create/message response-loss。
- [x] `bun run typecheck`
- [x] `bun run lint`
- [ ] `bun run test`（Shared/Frontend 全量已绿；Backend 全量受限环境与 T6 verified gap 未绿）
- [x] `bun run format:check`
- [x] `bun run depcheck`
- [ ] production + E2E binary build/version smoke。
- [ ] Codex 实现门 0 open P0/P1/P2。

## 6. 用户批准记录

用户已在 2026-07-30 明确：

1. 采用推荐的 runtime 选择、保存依据、隔离与 Dialog/Session renderer 方向；
2. MCP 测试通常不是单轮，必须支持多轮；
3. 采用闲置 10 分钟自动停止会话；
4. “立即结束测试”必须保留。

设计门关闭后，用户已进一步明确回复“批准”，构成本 RFC 的实施批准。当前生产代码已进入
Implementation v1；T10 强化验证与 T11 实现门/发布收口仍需继续完成。
