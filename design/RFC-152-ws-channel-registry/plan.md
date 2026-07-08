# RFC-152 · WS 频道双端注册表（plan）

> PR-0（distill-jobs admin 门禁）已先行交付（682de313）。5 commit 递进，
> 每步逐帧对拍锁零改动为判据。授权语境：G3-G10 批量授权。

## RFC-152-T1 ChannelSpec + gatedSubscribe（PR-1，纯新增）

- ws/registry.ts 注册表 + 高阶订阅管线；不迁移任何频道；注册表穷举锁。
- **commit**：`feat(ws): RFC-152 PR-1 ChannelSpec 注册表 + gatedSubscribe（未接线）`

## RFC-152-T2 低风险频道迁移（PR-2）

- repo-import + memory-distill-jobs 入表（P0 门禁语义入 upgradeGate）。
- **commit**：`refactor(ws): RFC-152 PR-2 仅 token 频道入表`

## RFC-152-T3 per-frame 家族迁移（PR-3）

- tasks-list / workflows（cacheBustOn+deleted 旧缓存）/ memories（双码路）；
  rfc099-ws-acl-filter 零改动。
- **commit**：`refactor(ws): RFC-152 PR-3 per-frame 频道入表`

## RFC-152-T4 task 频道迁移（PR-4，压轴）

- 前置：stranger-task 帧级拒绝新格；upgradeGate+onOpenExtra（?since 回放）；
  server.ts 散装分支清零棘轮翻绿。
- **commit**：`refactor(ws): RFC-152 PR-4 task 频道入表——升级门禁+回放走逃生舱`

## RFC-152-T5 前端 invalidation 表（PR-5）

- WS_PATHS shared 常量 + useWsInvalidation + 6 hook 薄包装 + reviews.detail
  双挂消除；hook 群测试零改动/最小随迁。
- **commit**：`refactor(frontend): RFC-152 PR-5 WS invalidation 表 + 双挂消除`

## 门禁节奏

每 commit：typecheck×3 + lint + format + ws 定向群；T4/T5 后全量 + binary smoke →
push → CI conclusion 直查 → Codex 实现门循环至收敛。

## 验收清单

- [ ] 注册表穷举 + 新频道改动面棘轮；三鉴权形态不拍平
- [ ] 逐帧对拍群零改动；task stranger 帧级新格
- [ ] 前端 6 hook 收敛 + 双挂消除 + WS_PATHS 双端单源
- [ ] 门禁 + CI + Codex 双门
