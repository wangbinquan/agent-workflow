# RFC-212 — 任务分解（v2，按设计门裁决重写）

> v1 的 T1–T8 建立在被推翻的选型（全局 epoch + 惰性复核）上，整体作废。
> 裁决见 [`design-gate-review.md`](design-gate-review.md)，修订后的设计见 [`design.md`](design.md)。

| 编号 | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **T1** | `src/ws/connections.ts`：进程级连接集合 + `trackConnection` / `untrackConnection`，接进 `server.ts:150-157` handleOpen 与 `:159-167` handleClose | — | 建连/断连后集合大小正确；`handleClose` 里既有的 `unsubscribe()` 不受影响 |
| **T2** | `WsConnectionData` 换成凭据**指纹**（`{kind, hash, expiresAt}` / `{kind:'daemon'}`）+ `closing` 标志；`patStore.ts:31` 的 `hashToken` 导出 | T1 | 源码锁：`WsConnectionData` 上不得出现任何原始凭据字段 |
| **T3** | 只读复核入口 `lookupActiveSessionByHash` / `lookupActivePatByHash`（查询体不变，跳过 `lastUsedAt` 写） | T2 | AC-8：复核路径零写入（计数断言） |
| **T4** | `ChannelSpec` 增加必填 `revalidation`（`refreshActor` / `cache` 判别联合 / `rerunUpgradeGate`），七通道按 design §3.4 表逐一表态 | — | AC-5：`@ts-expect-error` 反向锁 + 表驱动遍历 |
| **T5** | `revalidateAllConnections`：只读复核 → 失效 close(4401) → **写回 `ws.data.actor`** → 按声明清缓存 → 按声明重跑 `checkUpgradeGate` → 不过 close(4403)；关闭前同步置 `closing` 并同步 `unsubscribe()` | T1–T4 | AC-1 / AC-2 / AC-3 / AC-4a / AC-4b；**静默连接**也必须被关闭 |
| **T6** | `commitAndRevalidate(db, reason, fn)` 包装器；design §4 的八个写入点全部改用它（**提交之后**触发） | T5 | 「在 await 让出点人为 yield 时投递帧」的用例；写入面级源码棘轮 |
| **T7** | 凭据自然过期：投递前纯内存 `now > expiresAt → close(4401)`（零查询） | T2 | 过期用例；AC-6 不受影响 |
| **T8** | 前端：`useWebSocket.ts:186` 读 `e.code`；`4401 → clearToken() + 重新登录提示` | T5 | AC-9；配前端行为锁（不是源码文本锁） |
| **T9** | 回归锚点：`rfc152-ws-channel-registry.test.ts:277` / `:290`（同步投递）必须保持绿——方案 D 下帧路径不变，它们是「没有退回方案 C」的证据 | T5 | 两条用例原样通过 |
| **T10** | 文档收口：`design/plan.md` 状态改 Done；`STATE.md` 更新；审计报告 Top-6 标注闭环；**新增一条** `docs-implementation-parity` 反向锁（v1 误称「已受保护」，实际那是逐条手写的锁集合） | T9 | 索引与实现一致且有锁 |

## PR 拆分建议

- **PR-1（基建，行为不变）**：T1–T4 + T9 的锚点确认。可独立合并。
- **PR-2（行为）**：T5–T7。
- **PR-3**：T8 前端 + T10 收口。

**不可反向拆**：先合 T5 而不合 T4 的矩阵，等于把七个通道的复核策略重新交回给人记。

## 验收清单（合并前逐条打勾）

- [ ] AC-1 成员移除 → `task` 连接关闭且一帧不漏；**移除前收得到**（正向对照）
- [ ] AC-2 降级 → 短路类与 permissions 类**分列**断言 + `ws.data.actor` 已替换的白盒断言
- [ ] AC-3 会话 / 批量吊销 / PAT / 停用 / 过期 → 4401；**静默连接同样被关闭**
- [ ] AC-4a 有缓存通道缓存失效；AC-4b 无缓存通道按新 actor 判定
- [ ] AC-5 必填字段 + `@ts-expect-error` 反向锁 + 表驱动遍历
- [ ] AC-6 无撤销时零额外查询（`countingDb` 拦 select/insert/update/delete，**不能只拦 select**）
- [ ] AC-8 复核路径零写入
- [ ] AC-9 前端读到关闭码并清 token
- [ ] T9 两条同步投递锚点原样绿
- [ ] 写入面级棘轮就位（新增撤销写入点默认变红）
- [ ] 全量后端套件 + 前端 + typecheck + lint + format:check 全绿
- [ ] 推送后按 [feedback_post_commit_ci_check] 用本次提交的确切 sha 查 CI

> AC-7（变异实证）**不进合并门**：变异基建（审计 G6）尚未建成。本 RFC 的四条变异作为 G6 的首批输入。

## 风险

1. **粗粒度重扫**：任一撤销让所有连接各做一次只读查询。按本平台连接数量级可忽略；若成为问题，可叠加「按 userId 分桶」。
2. **`closing` 与在途帧**：`broadcaster.broadcast` 是同步 for-of，必须在 `ws.close()` 前**同步**退订，否则 AC-1 会变成 flaky 来源。
3. **`repo-import` 通道无门**：本 RFC 不补（RFC-152 D4 遗留），矩阵里显式填 `na` 并在非目标点名，避免「28 格已覆盖」的表述掩盖它。
