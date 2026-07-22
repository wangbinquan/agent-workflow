# Codex Adversarial Review

Target: branch diff against 34755a2d
Verdict: needs-attention

NO-SHIP：撤销提交后仍可漏帧，握手中的连接还能永久逃逸并回放历史 stdout。八个撤销入口已接线，单连接异常隔离和 e62546fd 的 null 回归用例本身未见问题，但核心竞态未闭环。

Findings:
- [high] 异步重扫前未封锁连接，撤销后的帧仍会投递 (packages/backend/src/ws/connections.ts:132-203)
  触发器在 197 行 fire-and-forget，重扫又按连接串行执行，并在设置 closing 前先 await 凭据与 upgradeGate 查询。任务成员移除等写入提交后，运行中的 task/admin-short-circuit 订阅仍能用旧权限同步发送；连接越多，排在后面的泄漏窗口越长。重叠撤销也没有 generation 所有权来协调栅栏。
  Recommendation: 撤销提交时先同步提高单调 generation，并让所有当前连接立即进入不可投递状态；随后有界并发复核，只有校验到最新 generation 才解除栅栏。让触发器返回 Promise，并按 AC 决定等待关闭完成。
- [high] upgrade 与 track 之间的连接会永久漏过唯一一次重扫 (packages/backend/src/ws/server.ts:115-168)
  actor 与 upgradeGate 在 117/132 行完成，但连接到 164 行的 open 回调才加入 live 集合，中间还有 buildWsCredential await。若成员撤销或角色降级在 gate 通过后发生，重扫快照看不到该连接；它随后携旧 actor 建连，且 task ?since 路径会无二次门控地回放历史 node events（包含完整 stdout），之后也没有事件保证再次复核。
  Recommendation: 在第一次鉴权 await 前捕获 generation；track 后、subscribe/hello/replay 前比较并复核，generation 变化时禁止任何发送。增加在 checkUpgradeGate 与 open 之间撤销成员的确定性回放测试。
- [medium] 第二次凭据查询失败被误编码为“永不过期” (packages/backend/src/auth/session.ts:88-104)
  tryUpgrade 已经解析一次 actor，buildWsCredential 又查询一次；若 session/PAT 恰在两次查询之间过期或被吊销，resolved 为 null，却仍返回 expiresAt:null。该哨兵同时表示无期限 PAT，服务器继续 upgrade，帧路径也跳过到期检查；自然过期没有后续触发器，因此连接可持续收帧。
  Recommendation: 用一次原子解析同时产出 actor、hash 和 expiresAt；至少让第二次查询返回 null 时拒绝 upgrade，并把 session 的 expiresAt 类型设为非空。补充跨过期边界的握手回归测试。
- [medium] 行为测试主动绕开生产触发链，竞态没有防护网 (packages/backend/tests/rfc212-revalidation-behavior.test.ts:143-149)
  AC-1 测试明确使用直接 DB 删除并手工 await revalidateAllConnections，以避开真实 fire-and-forget 竞态；现有 real-server WS 测试也没有执行撤销。因此 production trigger、撤销后并发帧、pending upgrade、两次并发撤销及回放路径均未被验证，上述两个高风险窗口可在全绿门禁下存活。
  Recommendation: 使用真实 adapter/socket 与可注入 barrier，分别卡在重扫首个 await、upgradeGate 后和 replay 前；断言撤销提交后零帧、pending upgrade 被拒、并发重扫不解除较新 generation，并保留单连接抛错不影响批次的用例。

Next steps:
- 先实现跨重扫与 pending-upgrade 共用的单调 generation 栅栏。
- 合并 actor 与 WS credential 的单次解析，禁止失效查询降级为 expiresAt:null。
- 补齐确定性竞态测试后运行完整 typecheck、后端/前端测试及单二进制 smoke；当前 worktree 缺少 drizzle-orm/vitest，定向测试未能执行。

Codex session ID: 019f8764-a2cd-7572-92e3-0ad70329d29a
Resume in Codex: codex resume 019f8764-a2cd-7572-92e3-0ad70329d29a
