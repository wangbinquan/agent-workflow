# RFC-244 · 本地工作区实施预门（2026-08-01）

## 结论

`LOCAL APPROVED — P0=0/P1=0/P2=0`

本结论只适用于下述本地审计对象。没有开放的实现 finding，但发布门仍未闭合：当前对象不是固定
commit SHA，hosted-Ubuntu 视觉基线与 Safari VoiceOver 人工走查也尚未执行。因此本记录不能替代
plan T23 的固定 SHA 实现门，RFC-244 当前不标记为 Done。

## 审计对象与边界

- 基线：`f134f9863e7055d96ff6ddc25bf2c1bc7594fe37`。
- 增量：2026-08-01 审阅时的 RFC-244 未提交工作区 patch。
- 审核面：shared schema、migration/index、HTTP contract、ACL/ownership scope、root/child cursor、
  lightweight projection、WS dirty truth、legacy compatibility、frontend URL state/tree/pagination、
  responsive/a11y/negative paths、自动化与真实浏览器表现。
- 明确排除：工作区内并行 RFC-245 及其他用户 WIP；本次没有暂存、提交、推送或发布。

## 审计结果

| 严重度 | 数量 | 结果 |
| ------ | ---: | ---- |
| P0     |    0 | 无   |
| P1     |    0 | 无   |
| P2     |    0 | 无   |

重点复核结论：

- authorized tree 始终先应用 ACL，ownership scope 只筛 self match；child plan 受父分支约束，不跨越
  未授权中间节点。
- cursor fingerprint 绑定 actor、read-all capability、filter 与 parent；root/child 均为有界 keyset
  pagination，facets 只在 root 计算。
- list projection 不载入大 JSON；冻结 workgroup JSON 解析 fail-soft；Owner、告警、失败码与 child
  count 均按页批量 enrichment。
- member change 在 revalidation 完成后广播，before/after audience 与删除前 cascade frozen audience
  保持撤权、增权和 child-only actor 的 dirty 真值；alert resolve 具备 additive 通知。
- frontend 使用原生 nested `<ol>/<li>`、独立 root/child infinite query、分支级 loading/error/retry、
  context 自动展开与 manual collapse 优先；WS 只标 dirty，再由用户或 15 秒原子重建。
- 普通桌面父行/子行采用 56px/48px `min-height`，长 Owner/任务文本可换行；移动端保持同一 DOM
  重排，展开控件为 44×44px，不依赖横向滚动。

## 验证证据

| 验证面 | 结果 |
| ------ | ---- |
| shared 全量 | 1536 pass，0 fail |
| backend 全量（正常本地权限） | 7907 pass，28 skip，0 fail；955 files |
| frontend 全量 | 675 files，5626 tests，0 fail |
| RFC-244 Playwright | 4/4 pass |
| UX consistency Playwright | 20/20 pass |
| macOS targeted visual（更新后无 update 重跑） | 1/1 pass |
| production binary E2E build | pass |
| `bun run typecheck` | pass |
| `bun run lint` | pass；仅 Node `MODULE_TYPELESS_PACKAGE_JSON` 环境 warning |
| `bun run format:check` | pass |
| `git diff --check` | pass |

真实渲染抽查：

- 1280px：普通父行 56px、长内容行 74px，约 11 行可见，无横向 overflow。
- 390×844：普通行约 95.6px、长内容行约 115.6px、可展开分支约 135.9px；展开控件 44×44px；
  document、main 与 list 均无横向 overflow。

## 待发布闭环

1. 在 hosted Ubuntu 生成并复核 visual baseline。
2. 在 Safari + VoiceOver 人工走查层级、展开/折叠、分支状态与 load-more focus。
3. 用户另行授权后精确提交 RFC-244 scope，对不可变 SHA 重跑实现门与 exact-SHA CI。
4. 以上全部通过后再完成 T21、T23、T24，并把 proposal/design/plan/STATE 更新为 Done。
