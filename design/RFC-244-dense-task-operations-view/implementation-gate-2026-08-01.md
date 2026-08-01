# RFC-244 · 固定 SHA 实现门（2026-08-01）

## 结论

`APPROVED — P0=0/P1=0/P2=0`

RFC-244 已在不可变代码 SHA `1fbbd46388d458afda526115786c045ea17ac133` 上完成最终实现审计，
没有开放的 P0、P1 或 P2 finding。该 SHA 已推送到 `origin/main`，exact-SHA CI run
`30700645728` 全绿。

## 审计对象与边界

- 功能基线：`f134f9863e7055d96ff6ddc25bf2c1bc7594fe37`。
- 最终代码 SHA：`1fbbd46388d458afda526115786c045ea17ac133`；最后一个收尾切片把同一个
  `lifecycle.alert.resolved` broadcaster 接入 invariant、stuck detector 与 auto-repair 三个 daemon
  loop，并为 boot assembly 增加回归锁。
- UI / visual exact SHA：`e8e42b6c170889274cc04029c7202c632d842dab`；其后 RFC-244 只有 backend
  启动接线与文档收口，任务页渲染未再变化。
- 审核面：shared schema、migration/index、HTTP contract、ACL/ownership scope、root/child cursor、
  lightweight projection、WS dirty truth、daemon boot wiring、legacy compatibility、frontend URL
  state/tree/pagination、responsive/a11y/negative paths、真实浏览器与 hosted visual 证据。
- shared `main` 中夹有 RFC-245/RFC-246 提交；本门按 RFC-244 精确路径和最终运行状态审核，没有把
  并行 RFC 的变更或证据冒充 RFC-244 finding。

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
  保持撤权、增权和 child-only actor 的 dirty 真值；alert resolve 使用 additive frame，且三个后台
  reconciler 全部复用同一个 tasks-list broadcaster。
- frontend 使用原生 nested `<ol>/<li>`、独立 root/child infinite query、分支级 loading/error/retry、
  context 自动展开与 manual collapse 优先；WS 只标 dirty，再由用户或 15 秒后原子重建。
- 普通桌面父行/子行采用 56px/48px `min-height`，长 Owner 可换行、任务名保留原生详情链接和
  `title`；移动端保持同一 DOM 重排，展开控件为 44×44px，不依赖列表横向滚动。

## 验证证据

| 验证面 | 结果 |
| ------ | ---- |
| 固定 SHA RFC-244/backend 定向回归 | 45 pass，0 fail，140 assertions |
| 全仓 `bun run test` | pass；shared 1536 pass，frontend 678 files / 5648 tests |
| `bun run typecheck` | pass |
| `bun run lint` | pass；仅既有 Node `MODULE_TYPELESS_PACKAGE_JSON` 环境 warning |
| `bun run format:check` / `git diff --check` | pass |
| production binary E2E build | macOS 本地 pass；exact-SHA CI macOS/Linux smoke 均 pass |
| RFC-244 Chromium Playwright | 4/4 pass |
| RFC-244 WebKit Playwright | 4/4 pass |
| axe | serious / critical 0 |
| hosted-Ubuntu visual | run `30697676219`，UI SHA `e8e42b6c170889274cc04029c7202c632d842dab`，27/27 pass |
| exact-SHA main CI | run `30700645728`，code SHA `1fbbd46388d458afda526115786c045ea17ac133`，success |

真实 Safari + VoiceOver 人工走查：

- 在 macOS Safari 打开带 24 个 root、22 个 child、八状态、alert、scheduled 与长文本的真实任务页；
  开启 VoiceOver 后，可访问性树正确暴露业务视图、搜索、筛选、任务链接、workflow/repo/id、执行
  状态说明、告警、时间、Owner 和 Scheduled 链接。
- 通过可访问按钮激活 `Expand 22 matching child tasks` 后，按钮切换为 expanded / `Collapse child
  tasks`，22 个子任务均以分支层级、链接、状态、告警与 Owner 进入可访问性树。
- 走查结束后已把系统 VoiceOver 恢复为 `off`，临时 daemon 与测试数据目录已清理。

## 发布结论

视觉契约、固定 SHA 实现门、code exact-SHA CI 和文档收口证据均已闭合。RFC-244 可以标记为 Done。
