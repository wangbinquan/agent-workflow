# RFC-229 工作组聊天室触发消息引用 UX — plan

状态：Done（2026-07-26；用户批准后完成实现、实现门与本地验证；0 open P0/P1/P2）。

## 任务

- [x] **T1 现状定位**：确认 runHistory 已有 trigger 关系、消息行没有父级、后验推断不可靠，
      并核对 human/agent mention 共用同一唤醒链。
- [x] **T2 设计门**：当前 Codex 会话对三件套与 live source 做本地只读审查；2 个 P1、1 个
      P2 已全部折入设计，结论 APPROVED；用户随后以“ok”批准实施。
- [x] **T3 schema/migration**：新增 nullable self-FK `trigger_message_id`、shared schema/default、
      row mapper 与迁移/级联测试；`RoomMessageRowArgs` 把 trigger 设为必填 `string | null`；
      实现前重读 journal 决定最终编号。
- [x] **T4 单一 resolver**：把 trigger resolver 下沉 `context.ts`，补 self-author 排除，
      runHistory 与持久化共用，table 测试覆盖 human/agent/fan-out/adopted 边界。
- [x] **T5 message-turn 传播**：fresh/adopted 都按真实 shard max 固化 parent；`wg_messages` 与
      `wg_result` 全继承，非 message-turn/system 维持 null。
- [x] **T6 room wire + prompt 隔离**：aggregate 显式返回字段，WS 维持 invalidation-only，
      prompt null/non-null golden byte-identical。
- [x] **T7 公共引用组件**：新增 `MessageReference`、作者/正文两行预览、坏指针占位、i18n 与
      clip-safe keyboard focus。
- [x] **T8 跳转 UX**：room message map、scroll/focus/1.6s highlight、tail-follow 解锁、
      reduced-motion 与清理逻辑。
- [x] **T9 自动化验证**：shared/backend/frontend 定向与相关全量测试、typecheck/lint/format、
      migration、binary smoke。
- [x] **T10 浏览器验证**：真实 daemon 下 desktop light 鼠标跳转 + 390px dark
      overflow/axe + reduced-motion 键盘跳转；human/agent/fan-out/链式关系由后端测试锁定。
- [x] **T11 实现门与收尾**：Codex 实现审查 findings 全折；更新 RFC/STATE/index，复核共享树
      归属；未经用户要求不 commit/push。

## 依赖与顺序

```text
T2 设计门 ✓ → 用户批准 ✓
  → T3 schema/migration
  → T4 resolver
  → T5 propagation
  → T6 wire/prompt
  → T7 component ─┐
  → T8 interaction├→ T9 gates → T10 browser → T11 impl gate
                  ┘
```

T7 可在 T3-T6 后半并行思考，但共享 DTO 未落前不提交前端 fixture。单 PR，测试与生产改动同批
落地，不留“先展示、以后补关系”的模糊过渡态。

## 不变约束

- agent→agent 与 human→agent 同合同，不按 author kind 分叉。
- parent 只来自 message-turn shardKey 的权威 max，不按时间/相邻位置猜。
- self-mention 不得成为父消息。
- adopted/clarify continuation 不得改绑期间的新消息。
- 客户端不能指定 trigger id；坏 id 不跨任务查询。
- assignment/leader/system 无唯一消息父级时维持 null。
- 引用 metadata 不进入 prompt，不改变 cursor/wake/budget/WS 语义。
- 引用焦点环必须 inset，390px 不水平溢出。
- 共享树中 RFC-230 等未提交改动全部保留；重叠 i18n/STATE/index 只做精确 hunk。

## 验收清单

- [x] AC-1/2：human→agent 与 agent→agent 均引用。
- [x] AC-3：一父多 agent 的 parent id 一致。
- [x] AC-4：一回合多输出全部引用。
- [x] AC-5：adopted run 锁原 parent。
- [x] AC-6：无权威父级不造引用。
- [x] AC-7/8：预览、键盘跳转、聚焦高亮、坏指针安全降级。
- [x] AC-9：prompt byte-identical。
- [x] AC-10：desktop light / 390px dark 真浏览器、axe、overflow、reduced-motion 通过。
- [x] AC-11：RFC-229 相关门禁与实现门通过；完整 backend randomized suite 的两次外部单例
      flake 及同 seed 隔离全绿结果已准确记录，不冒充全量绿。

## 交付记录（2026-07-26）

- Shared 1440 / Backend 定向 95 / Frontend 5285 / Playwright 3，均 0 fail。
- format、lint、typecheck、depcheck、diff-check 与 production/test-only binary smoke 全绿。
- 实现门 2 P1 + 1 P2 全折，0 open；完整证据与 randomized backend caveat 见
  [impl-gate-2026-07-26.md](./impl-gate-2026-07-26.md)。
- 当前共享树中的 RFC-230 等并行改动未回退、未混入本 RFC 台账；用户已授权本次提交并推送，远端 CI 待按 exact SHA 核验。
