# RFC-212 — 任务分解

单 PR 交付（改动集中在 `ws/` + 七个撤销写入点各一行），但按下列顺序推进，每步自带测试。

| 编号 | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **T1** | 新建 `src/auth/authEpoch.ts`：`bumpAuthEpoch(reason)` / `currentAuthEpoch()` / `AuthEpochReason` 联合类型 | — | 单测：初值、单调递增、reason 进日志不进逻辑 |
| **T2** | 七个撤销写入点各加一次 `bumpAuthEpoch(...)`（design §4 表） | T1 | 每个写入点一条「调用后 epoch 递增」的断言；**外加源码棘轮**断言七个函数体都含该调用 |
| **T3** | `ChannelSpec` 增加必填 `revalidation` 字段，七个通道逐一表态 | — | **编译期**：删掉任一通道的声明必须 tsc 失败（变异实证）；表驱动测试遍历矩阵 |
| **T4** | `ConnectionData` 加 `token` / `epoch`；upgrade 时填充 | T1 | 类型 + 一条断言 upgrade 后 `epoch === currentAuthEpoch()` |
| **T5** | 帧投递前的惰性复核（design §2 五步），含 4401/4403 关闭码 | T1–T4 | AC-1~AC-4 的行为用例 + AC-6 零额外查询计数 |
| **T6** | 确认前端对 4401/4403 的重连退避不会退化成快速重试风暴 | T5 | 读 `hooks/useWebSocket.ts`；若无退避则补，并加一条源码/行为锁 |
| **T7** | 变异实证（AC-7）：三处定向劣化各自必红；纳入审计报告 G6 的变异清单 | T5 | 三条变异逐一记录在 PR 说明里 |
| **T8** | 文档收口：`design/plan.md` RFC 索引状态改 Done；`STATE.md` 追加一行；审计报告 Top-6 标注已闭环 | T7 | 索引与实现一致（受 `docs-implementation-parity.test.ts` 同类反向锁保护） |

## PR 拆分建议

默认单 PR。若 T5 的复核逻辑评审中出现分歧，可把 T1–T4（纯基建 + 矩阵，行为不变）先合，T5–T7 作为第二个 PR。**不可反向拆**：先合 T5 而不合 T3 的矩阵，等于把 28 格重新交回给人记。

## 验收清单（合并前逐条打勾）

- [ ] AC-1 任务成员移除 → `task` 连接被关闭且不再收帧；**移除前收得到**（正向对照）
- [ ] AC-2 角色降级 → `tasks-list` / `workflows` / `memories` 失去 admin 短路
- [ ] AC-3 会话 / PAT 吊销、账号停用 → 连接被 4401 关闭
- [ ] AC-4 资源 ACL 收回 → 对应通道缓存失效
- [ ] AC-5 矩阵 `satisfies Record<WsChannelKind, …>`；删一格即编译失败
- [ ] AC-6 无撤销时零额外 DB 查询（计数断言）
- [ ] AC-7 三条变异各自必红
- [ ] 全量后端套件 + typecheck + lint + format:check 全绿
- [ ] 推送后按 [feedback_post_commit_ci_check] 查 CI（用本次提交的确切 sha）

## 风险

1. **`token` 驻留连接对象**：见 design §3.2 的安全评估。评审时若认为不可接受，退化方案是保存凭据 id + 类型，复核时按 id 查两张表——多一次查询，且拿不到「用户被停用」的统一答案，需额外查 users。
2. **粗粒度 epoch 导致的复核风暴**：任一撤销让所有连接各复核一次。按本平台的连接数量级（个位数到几十）可忽略；若未来成为问题，可把 epoch 按 userId 分桶，接口不变。
3. **与 RFC-054 W2-4 的取舍冲突**：本设计不改「无撤销时不查 DB」这一前提，冲突只存在于表述层面，已在 proposal §6 说明。
