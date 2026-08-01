# RFC-246 · 实施计划

- 状态：Done（2026-08-01）
- 实施批准：用户于 2026-08-01 明确要求同步 Scheduled/Repos UX

## 任务

- [x] **RFC-246-T1**：审计 Scheduled/Repos 数据、行内动作、权限与既有测试契约。
- [x] **RFC-246-T2**：固化业务视图、attention 口径、列映射与响应式验收。
- [x] **RFC-246-T3**：抽取公共 `OperationsToolbar` 与通用 surface/toolbar CSS，迁移 `/tasks`。
- [x] **RFC-246-T4**：实现 Scheduled 四视图、搜索、筛选、高密度行与移动端重排。
- [x] **RFC-246-T5**：实现 Repos 四视图、搜索、筛选、高密度行与移动端重排。
- [x] **RFC-246-T6**：补齐 zh-CN/en-US i18n、纯函数与行为回归测试。
- [x] **RFC-246-T7**：补 Playwright geometry/a11y 与 Scheduled/Repos visual baselines。
- [x] **RFC-246-T8**：完成 typecheck/lint/test/format、真实浏览器验收与实现自审。
- [x] **RFC-246-T9**：精确路径暂存、提交、推送，并按 exact SHA 核验 CI/visual workflow。

## 验收清单

- [x] 三页共用公共 surface/toolbar，任务列表视觉不退化。
- [x] Scheduled/Repos 普通桌面行密度目标为 56px，业务正文不裁切。
- [x] 两页四业务视图、搜索、高级筛选与无结果清除正确。
- [x] 原有 mutations、详情导航、确认与敏感信息边界全部保持。
- [x] 1024px 与两个 390px 高度场景均无横向 overflow。
- [x] 本地门禁、截图人工检查、exact-SHA CI 与 hosted visual 全绿。

## 交付记录

2026-08-01 已完成 T3–T9：公共 toolbar/surface、Scheduled/Repos 业务视图与筛选、同构移动端重排、
读屏字段标签以及三页 populated baselines 均已落地。完整 frontend **678 文件 / 5648 tests**，
全仓 typecheck/lint/format 全绿；RFC-246 Playwright **3/3**（含 1280/1024/901/390×844/
390×568、document/main/list overflow 与 axe critical/serious=0），相关 Chromium E2E 合并复核 **8/8**，
macOS Tasks/Scheduled/Repos targeted visual **3/3**。

发布侧以 UI/visual exact SHA `e8e42b6c` 收口：GitHub-hosted Ubuntu visual run `30697676219`
**27/27**，main CI run `30697676238` attempt 2 全绿。CI attempt 1 唯一失败为本 RFC 未触及的
`centralized-answer-pane.test.tsx` 单选键盘用例 3 秒时序波动；同文件在 exact SHA 本地独立复跑
**5/5**，失败 job 重跑通过，随后双平台 build 与全部 Playwright 分片通过。远端 `main` 已验证包含
该 SHA，T9 与最后一项验收闭合。
