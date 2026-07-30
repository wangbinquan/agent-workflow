# RFC-238 · Codex 设计门记录（2026-07-30）

## 1. Gate 输入与执行说明

- snapshot base：`004eeaf3f86e108e5ff3d44ee139665676b52801`
- 范围：RFC-238 `proposal.md`、`design.md`、`plan.md`，以及当前 MCP detail/probe、
  RuntimeDriver/systemAgentRun、OpenCode/Claude、ACL/coordinator、Session view/renderer 源码
- 关键源码锚点：
  - `packages/frontend/src/routes/mcps.detail.tsx:249`
  - `packages/frontend/src/components/mcps/McpInventoryPanel.tsx:27`
  - `packages/frontend/src/components/RuntimeSelect.tsx:22`
  - `packages/frontend/src/components/node-session/SessionConversationPanel.tsx:21`
  - `packages/backend/src/services/runtime/types.ts:456`
  - `packages/backend/src/services/systemAgentRun.ts:231`
  - `packages/backend/src/services/runner.ts:1201`
  - `packages/shared/src/sessionView.ts:163`
- 模式：先把三件套复制到从上述 base 建立的 detached worktree。外部 `codex exec` 需要把私有
  RFC/source 发送到外部模型服务，权限审查未授权该数据出站，因此该调用在读取项目材料前停止，
  不把它计作通过证据，也未绕过审批。本次门禁由当前 Codex 在只读源码核对后进行独立的
  failure-sequence 对抗复核；修订只写回 RFC 文档，未修改 `packages/**`。

## 2. 首轮结论

`NEEDS_REVISION`：P0=0，P1=10，P2=7。

## 3. P1 findings 与修订

| 编号  | Finding / 失败序列                                                                                                                                                | RFC 修订                                                                                                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1  | test session/owner 若跟随 MCP 或 user cascade 删除，进程尚未 reap 时会先丢失 PID、store、lease 与 cleanup 身份，boot recovery 无法安全判断                        | session 的 `mcp_id/owner_user_id` 与 OpenCode playground owner 改为 RESTRICT/显式 teardown；delete 分成 ending、bounded cancel/reap/cleanup、权威 delete 两段                                      |
| P1-2  | 只冻结 `operationConfigHash`、runtime path/profile string，无法阻止同一路径 executable 或 local MCP bytes 在两轮之间被替换，所谓 native resume 会混合两个执行身份 | 首轮 prompt 前冻结 runtime binary、MCP execution、session contract 三个 digest；续轮 plan exact match，路径不作为充分证明                                                                          |
| P1-3  | Claude 首轮若等 stream 里出现 session id 才落 owner，模型可能已调用 MCP 但 daemon 尚无 durable native identity；崩溃后形成不可证明的外部副作用                    | 创建事务预分配并持久化 UUID，首轮用 `--session-id`；`native_session_state=pending/ready/unusable`，只有 exact stream id + transcript proof 后才可 resume                                           |
| P1-4  | ACL/visibility/disable 只在 commit 后 best-effort abort，会留下“权限已撤销但新 message 仍能提交”的线性化窗口                                                      | canonical mutation 的同一 SQLite transaction 把受影响 session 写 ending/blocked；post-commit notification 只杀进程，不承担授权正确性                                                               |
| P1-5  | 若 prompt/stdin 先于 plan/PID/真实 wrapped command receipt 持久化，daemon crash 时可能已有 MCP side effect，却无法精确 reap 对应进程                              | 固定 pre-prompt barrier：plan identity receipt → spawn → PID/raw+wrapped command receipt → Claude stdin 或 OpenCode ACK；任一步失败先 kill/reap                                                    |
| P1-6  | “只保留最新会话”若直接删 pending/quarantined old row，会删除唯一 recoverable transcript/store 或仍活进程的身份                                                    | cleanup 引入 pending/complete/quarantined；只有 complete 可替换，pending 保留重试，quarantined 保留并阻止同 user+MCP 新建                                                                          |
| P1-7  | create 没有 caller token 时，202 response loss 后重发会创建第二 session 并重复模型/MCP side effect                                                                | create 增 `clientCreateId/clientMessageId` 与 canonical request digest；exact replay 必须先于 active-conflict 判断                                                                                 |
| P1-8  | 即便 session row 上有 create token，开始下一次测试时清理旧 transcript 也会清掉 dedupe 证据，迟到旧 POST 仍可重复执行                                              | 增独立、无 prompt/secret 的 24h create-receipt 表；session 清理后仍返回原 `sessionId/acceptedTurnId`，绝不创建新 side effect                                                                       |
| P1-9  | Claude `--mcp-config <inline JSON>` 会把 MCP env/header/oauth 暴露到 argv/process title、诊断或 crash dump，违背 secret 边界                                      | `--mcp-config` 只传 daemon-private `0600` one-MCP config path；secret 不进 argv、receipt、digest 明文或日志                                                                                        |
| P1-10 | 仅在 service 计算 local MCP command digest 仍有 digest→runtime spawn 的 TOCTOU；Claude 与 OpenCode 分别解释 row 还会产生不同身份                                  | 增单一 `prepareMcpTestExecutionMaterial()`；local stdio 走 sealed child launcher 与 exec 前身份复核，remote config 走 canonical transport/credential slot digest，两 driver 只消费 frozen material |

## 4. P2 findings 与修订

| 编号 | Finding / 失败序列                                                                                                                               | RFC 修订                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | 当前 `RuntimeSelect` 在 registry 空/失败时回退内置 protocol 名；capability-filter 若直接复用，会把未证明支持 `mcp-test-v1` 的 runtime 显示为可选 | capability-filter mode loading/error fail closed；普通调用不传 filter 时保持旧 fallback                                          |
| P2-2 | 只有 latest endpoint 无法满足 system admin 的 exact-id audit，同时又容易误做跨用户 list                                                          | 增 exact metadata/session endpoints；owner 或 system admin + 精确 id，latest 对 admin 仍只返回自己的 owner slot                  |
| P2-3 | end/idle 时 capture incomplete 后直接删 store，会销毁唯一可以补捞的 Session 证据                                                                 | cleanup 前 bounded final capture retry；仍 incomplete 留 pending，达到明确 retention 才审计清理；store 未 unlock 则 quarantine   |
| P2-4 | 预分配 Claude UUID 或 OpenCode marker 不等于上下文已可恢复；首轮 pre-session cancel 后若允许第二轮，会用 fresh root 冒充多轮                     | 引入 native pending/ready/unusable；首轮未 ready 即失败/取消时结束旧 logical session                                             |
| P2-5 | `operationConfigHash` 覆盖 rename/ACL 等持久字段，只监听 config/enabled 会留下 hash 已变但 session 仍显示可续的窗口                              | 任意 operation-hash-changing canonical mutation 同 tx 封住旧 session；失权/disabled 立即 abort，其它变化让已启动 turn 完成后 end |
| P2-6 | queued turn 不计 idle 且没有自身 deadline时，semaphore 饥饿可永久占据 in-flight；end 后拿到 slot 还可能迟到 spawn                                | turn 接纳时写 10 分钟 hard deadline（queue+run）；worker 用 `queued→running` CAS 重验 active/cancel/end/deadline 后才 spawn      |
| P2-7 | 只有 16 MiB session 落库总量不能阻止 parser 先在 heap 无界拼接单条巨大 MCP result/raw line                                                       | 增 raw frame、单 normalized event、stderr tail 分级上限；超限后固定 buffer drain 并标 truncated/incomplete                       |

## 5. 第二轮复审

`APPROVED`：P0=0，P1=0，P2=0。

第二轮逐项核对：

- 产品语义闭合：普通回复只结束当轮进程；logical session 原生多轮 resume；turn 终态后才开始
  10 分钟 idle；close/reload 不 cancel/end/续期。
- “取消当前轮次”与“立即结束测试”独立存在。End 对 queued 先封 spawn，对 running 先写 durable
  ending 再 TERM→KILL→reap，对 idle 直接 cleanup；任何态都不能在 end 后继续。
- stable MCP id、operation hash、runtime profile、binary bytes、MCP execution material 与 native
  session contract 均在模型 side effect 前形成 durable fence。
- 只挂当前 MCP；repo/其它 MCP/Skill/Plugin/dependent/memory/inventory/built-in tools 均失败关闭，
  且 OpenCode/Claude 都要求真实 behavior fixture，不以“配置看起来正确”代替证明。
- owner/system-admin ACL、同事务撤权、RESTRICT delete、create/message idempotency、
  single-flight/idle CAS、process recovery/quarantine 均有确定的线性化点与负向测试。
- Session 过程只输出 canonical `SessionViewResponseSchema` 并复用
  `SessionConversationPanel → ConversationFlow`；WS 只发 locator，REST + polling 仍是事实源。
- 前端复用公共 Dialog/Form/RuntimeSelect/NoticeBanner/ConfirmDialog/StatusChip；capability picker
  的 fail-closed 扩展不改变其它调用方。

RFC 已达到再次请求用户实施批准的设计门条件；批准前不修改 `packages/**` 生产代码。
