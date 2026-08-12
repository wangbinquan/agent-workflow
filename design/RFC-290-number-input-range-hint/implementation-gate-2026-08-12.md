# RFC-290 实现门（2026-08-12）

## 结论

实现与修订后的设计一致。当前会话对生产路径、调用点、可访问性、边界双真值与真实浏览器
布局逐项复核后，发现 1 条 P2 测试覆盖缺口，已补齐；三组针对设计门关键 finding 的变异均能
稳定打红，恢复后定向测试全绿。

外部 `codex review` 未重试：设计门阶段同一命令已因会把未提交补丁发往外部服务而被执行策略
明确拒绝，本轮没有新增外发授权，故不绕过该限制，也不把外部实现门记作“0 findings”。以下
证据来自本次 Codex 会话在 detached worktree 中的对抗式复核。

## 隔离与归属

- 共享 `main` 在实现期间持续前进；实现门快照固定到
  `b922c29e0dddfe1071e69f7e14d12088e30ef018`，只复制 RFC-290 的实现、测试与文档。
- 新文件在隔离 worktree 中用 `git add -N` 登记，确保 `git ls-files` 型源码守卫可见。
- 共享树全量前端测试曾只在并发 WIP `routes/intent.detail.tsx` /
  `tests/intent-detail-inline.test.tsx` 上失败；该 diff 是提交策略资源标签改造，不在 RFC-290
  路径内。最终判定只采隔离快照门禁，不把共享树瞬时红当作通过或产品缺陷。

## Finding 与处置

### P2 — 17 个有界调用点的验收只靠人工清单，缺少防退化锁

初版测试验证了 `NumberInput` 默认行为和 Pagination 单点 opt-out，但若以后第二个调用点也写
`rangeHint={false}`，组件测试仍会全绿，不能直接守住 proposal AC“17 处中 16 处显示”。

处置：`number-input-range.test.tsx` 递归扫描整个 frontend `src/**/*.tsx` 做源码 census，断言
17 个带 `max` 的调用点、16 个继承默认提示、唯一 opt-out 为 `components/Pagination.tsx`。新增有界
调用点时必须显式复核布局并更新计数，而不是因落在新文件中而逃出枚举面或静默扩大例外。

## 变异实证

| 破坏                                                                     | 预期与实测                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 换算 helper 改成“继续降档找能整除单位”                                   | `90000ms` 产出 `30 秒 – 90 秒`，对应测试 1/12 必红                |
| 删除 range span 的 `aria-hidden`                                         | accessible name 变成“超时 + 范围 + 用途说明”，a11y 测试 1/12 必红 |
| 只把 `ConfigPatchSchema.intentBuilderTurnTimeoutMs.max` 改成 `3_600_001` | base schema 仍绿，但 PATCH 上限断言 1/16 必红                     |

三处变异均用 `apply_patch` 原样恢复；恢复后对
`packages/shared/src/schemas/config.ts` 执行 `git diff --exit-code` 通过，RFC-290 定向套件
3 文件 34/34 通过。

## 额外验证

- 相关消费者回归：10 文件 129/129 通过（调度、runtime、workgroup、settings、网络、系统代理、
  commit/push、webhook pagination）。
- 前端 typecheck、lint 与 RFC-290 路径 prettier / `git diff --check` 通过。
- 真实浏览器在中文设置页逐项看到 8 个有界字段；单位换算分别为
  `0 – 256 KiB`、`30 秒 – 1 小时`、`1 天 – 10 年`。
- 390×844 视口下系统代理四个范围均未溢出，DOM 几何顺序为用途 hint → 范围；控制台无
  error / warning。

## 完整门禁

隔离快照的 `bun run gate:local` 结果在交付前回填。
