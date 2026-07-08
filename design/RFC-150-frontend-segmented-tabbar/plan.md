# RFC-150 · 前端 Segmented/TabBar 原语 + W0 收口补做（plan）

> 3 commit；每批以真行为锁零改动为判据。授权语境：G3-G10 批量授权。

## RFC-150-T1 原语 + W0 补做 + ConfirmButton（PR-1）

- Segmented/TabBar 两组件 + 单测；15 裸 span → StatusChip + 棘轮扩展；
  describeStatus 并 `tasks.status.*` 键族（8 键删除）；ConfirmButton variant 化
  （16 调用点 + danger 零再现锁）。
- **commit**：`feat(frontend): RFC-150 PR-1 Segmented/TabBar 原语 + StatusChip/键族/ConfirmButton W0 收口`

## RFC-150-T2 纯机械迁移批（PR-2）

- Segmented 8 + TabBar 7；memory-all tabs--pills 幽灵 modifier 修正；
  相应 grep 锁改组件断言。
- **commit**：`refactor(frontend): RFC-150 PR-2 Segmented×8 + TabBar×7 纯机械迁移`

## RFC-150-T3 中风险迁移批（PR-3）

- TabBar 4（inspector 族/badge/segment）+ Segmented 3（AclPanel a11y 修正/
  canvas stopPropagation/shortcut 场景）；tabs-retrofit-grep 等锁改写；
  遗留清单登记入 design.md。
- **commit**：`refactor(frontend): RFC-150 PR-3 中风险批迁移 + AclPanel a11y 修正`

## 门禁节奏

每 commit：typecheck×3 + lint + format + 前端全量；PR-3 后 binary smoke →
push → CI conclusion 直查 → Codex 实现门循环至收敛。

## 验收清单

- [ ] 两原语 + 单测；真行为锁（radio/roving/badge）零改动
- [ ] 迁移 Segmented 10/11、TabBar 11/12；遗留清单登记
- [ ] W0 补做两项 + ConfirmButton variant；棘轮扩展
- [ ] 门禁 + CI + Codex 双门
