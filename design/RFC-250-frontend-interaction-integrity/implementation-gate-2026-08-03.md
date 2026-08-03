# RFC-250 · 独立实现门（2026-08-03）

- 结论：**APPROVED — P0=0 / P1=0**
- 冻结基线：`40535c0e23832c6dbbb39e22ee96a4ab6e8bd777`
- 审计对象：最终 staged RFC-250 树（123 paths，unstaged=0）
- 审计方式：独立只读源码、DOM/CSS ownership、focused unit/E2E、几何与视觉复核

## 1. 审计台账

首轮终审结论为 `NEEDS FIXES — P0=0 / P1=2`：

1. Scheduled 列表的立即运行错误被塞进 86px action cell，长错误与 retry 不可读。
2. Workflow 中等宽度同时存在 header Add 与 canvas Add，且 1280px 的 Launch / More action rail 会裁切。

最终复审确认两项均关闭，post-fix delta 未发现新增 P0/P1。

## 2. P1 关闭证据

### Scheduled 全宽反馈

- `ScheduledRunNowAction` 暴露独立 action/feedback slots。
- action 留在主数据行；feedback 位于紧邻 sibling `<tr><td colSpan={6}>`。
- CSS 将反馈行投影为 full-width one-track，并分别覆盖 desktop/tablet/mobile padding。
- unit 锁 DOM ownership；E2E 锁 banner 宽度、长内容可读与 retry 不重叠。
- Chromium / WebKit focused 2/2、interaction matrix 10/10、operations surfaces 6/6 通过。

### Workflow 唯一 Add 与 action rail

- `workflows.edit.tsx` 移除 `workflow-add-step`；`workflow-canvas-add` 是窄屏/中等宽度唯一稳定 Add。
- 1180–1535px 只让已 ellipsis 的 workflow title column 让位，Launch/More 保持完整可见。
- 1280 几何锁逐项验证：唯一 Add、primary/More visible、action rail 在 viewport 内、
  `scrollWidth <= clientWidth`、无 clipped child。
- post-fix binary：Chromium 1/1、WebKit 1/1；4 files / 51 focused tests 通过。
- 1280 light/dark Darwin baseline 人工复核：Launch task / More actions 完整，画布仅一个 Add。

## 3. 最终门禁

- `bun run typecheck`：PASS（shared/backend/frontend）
- `bun run lint`：PASS
- `bun run format:check`：PASS
- `bun run depcheck`：PASS（1230 modules；19/19 accepted；16 unresolved externals ignored）
- `bun run test:shared`：PASS（148 files / 1617 tests）
- `bun run test:frontend`：PASS（696 files / 5912 tests，seed `1785767521209`）
- final interaction matrix：Chromium 50/50 + WebKit 50/50（100/100）
- Darwin visual update/compare：40/40 + 40/40，人工复核 6 张刷新基线
- `git diff --cached --check`：PASS

## 4. Backend 基线例外与冻结规则

冻结树 backend full 已执行一次：`8269 pass / 28 skip / 9 fail`，990 files，seed
`500898906`，978.70s。9 项全部位于 RFC-165/RFC-210/RFC-252：6 条为 RFC-252 新增
`--checkout` 后旧 exact-argv baseline 未更新，2 条为 hooks 压制引发的真实既有语义回归，另 1 条为
前述 scratch lease 的级联。RFC-250 staged backend 仅触及两份 test-only 文件，与这些路径无交集。

共享 `main` 后继 `9f296872` 已同步 baseline 并恢复 commit hooks 语义。为避免持续有人提交时门禁成为
移动靶，本地验证固定在 `40535c0e + RFC-250`：无关提交不触发 full 重跑；只有命中 RFC-250 或直接依赖
才补 focused gate。最终发布 SHA 的完整性由 T46 exact-SHA CI 与 hosted visual 负责。

## 5. 发布判定

RFC-250 自有实现门 **APPROVED**，发布状态为 `Done / Published`。T46 已在最终实现 SHA
`bfb1ed9c9420e9bde3bf9c4c7b9534f9c92a8773` 上完成 commit、push、remote ancestry、exact-SHA CI
（run `30829695953`，28/28 jobs success）与 hosted visual（run `30829696055`，40/40 pass）。
