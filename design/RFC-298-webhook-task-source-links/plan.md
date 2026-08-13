# RFC-298 Webhook 任务来源链接 — 实施计划

状态：**Done（2026-08-13）**

## 1. 前置门

- [x] 核对 RFC-263：现有 trigger fields 已含 MR/评论/流水线/项目 URL 与 commit SHA。
- [x] 核对 RFC-292：context 在任务 INSERT 时冻结，历史扁平 context 有兼容 parser，子任务继承。
- [x] 核对任务详情：用户指定入口放在任务 ID 后，且不在列表扩面。
- [x] 用户拍板文案化、完整回退层级与 ID 后位置。
- [x] 用户正式批准本 RFC 三件套。
- [x] 实现前复核共享工作树；不得触碰并发 `scheduler.ts` WIP。

## 2. 任务分解

### 批 A — Shared 单一事实源

| #          | 任务                                                                     | 验证                     |
| ---------- | ------------------------------------------------------------------------ | ------------------------ |
| RFC-298-T1 | 新增 `WebhookTaskSourceLink` schema/kind 与 `safeWebhookTaskSourceUrl`   | typecheck + URL 安全矩阵 |
| RFC-298-T2 | 实现 9 事件闭合选择器与带 SHA sentinel 防护的 commit URL 构造            | shared 纯函数全矩阵      |
| RFC-298-T3 | `TaskSchema` 新增 optional nullable `webhookSourceLink`；导出 shared API | 新旧 wire 兼容测试       |

依赖：用户批准。

### 批 B — Backend 详情读模型

| #          | 任务                                                                             | 验证               |
| ---------- | -------------------------------------------------------------------------------- | ------------------ |
| RFC-298-T4 | 只在详情读路径解析冻结 context，并向 `rowToTask()` 传最小 `{kind,url}` 或 `null` | service 测试       |
| RFC-298-T5 | 锁 canonical / 历史扁平 / 损坏 / 非 webhook / 全失效                             | backend 回归       |
| RFC-298-T6 | 锁只有继承 context 的子任务仍展示，且响应不泄漏 raw context/comment/event_json   | API 集成测试       |
| RFC-298-T7 | 扩展 RFC-292 source-lock；锁 `rowToTask()` 不读 raw context、ACL/token 行为不变  | source-lock + 路由 |

依赖：批 A。

### 批 C — Frontend 标题区

| #           | 任务                                                                         | 验证                  |
| ----------- | ---------------------------------------------------------------------------- | --------------------- |
| RFC-298-T8  | 新增 `TaskWebhookSourceLink`，五种闭合 i18n 文案、外链安全属性、正文不含 URL | frontend 组件测试     |
| RFC-298-T9  | 在 ID `<code>` 后加入不可拆的分隔点+条件链接组                               | DOM 顺序/缺省测试     |
| RFC-298-T10 | 保留 ID inline flow、来源组 nowrap、复用既有 link 样式                       | 390px + desktop 视觉  |
| RFC-298-T11 | en/zh 键与类型完整性                                                         | i18n 测试 + typecheck |

依赖：批 B。

### 批 D — 真实展示链与收尾

| #           | 任务                                                                     | 验证            |
| ----------- | ------------------------------------------------------------------------ | --------------- |
| RFC-298-T12 | seeded task-detail E2E：真实 API → 标题 ID 后链接，href 校验但不访问外网 | Playwright      |
| RFC-298-T13 | 非 webhook 对照 + 390×844 / desktop 视觉回归                             | screenshots     |
| RFC-298-T14 | 更新 `docs/webhook-triggers.md`，记录任务详情来源入口与降级矩阵          | 文档变量/链接门 |
| RFC-298-T15 | Codex 实现门、修 findings、跑 `bun run gate:local`                       | 全门禁          |

依赖：批 C。

## 3. 测试用例清单

### 正常路径

- note 命中评论；四类 MR 命中 MR/PR；两类 pipeline 命中流水线；push/tag 命中提交。
- GitHub 与 GitLab commit URL 路径分别正确。
- 根任务与只有继承 context 的子任务均展示。
- 五种目标显示五种受控文字，href 不作为正文。

### 回退与异常路径

- 每条链的第一层缺失、畸形、危险 scheme、userinfo、超长时继续下一层。
- note：评论 → MR → 项目；pipeline：流水线 → MR → 项目；MR：MR → 项目；push/tag：提交 → 项目。
- 全字段缺失、损坏 JSON、未知键 strict 失败时不渲染来源 UI且详情不 5xx。
- GitHub workflow_run 的 `mr_url` 为空时不得构造 API URL，退 pipeline/项目。
- 项目 URL query/hash 只在项目回退时保留；commit 构造时清空。
- commit SHA 缺失、非 7–64 位十六进制或全零 sentinel 时退项目，不能生成死链接。

### UX / a11y / 安全

- DOM 顺序固定为任务 ID、分隔点、文字链接。
- `target=_blank`、`rel="noopener noreferrer"`、可访问名称正确。
- URL 不出现在可见文本或 hover `title`；无链接时无孤立 `·`。
- 分隔点与链接作为 nowrap 组共同换行，不能把分隔点孤立在上一行。
- 390px 可换行，任务 ID 不截断，focus ring 不裁切。
- 普通任务、任务列表、首页任务流不出现新链接。

### 兼容 / 回滚

- Task field optional：新前端读旧响应、旧前端读新响应均安全。
- RFC-292 canonical 与历史扁平 context 同结果。
- trigger/delivery 行不存在不影响投影。
- 回滚前端/读模型后无需数据修复。

## 4. 提交建议

本仓直接在共享 `main` 小步提交，不建分支：

1. `feat(shared): RFC-298 webhook 任务来源选择契约`
2. `feat(tasks): RFC-298 投影 webhook 来源链接`
3. `feat(frontend): RFC-298 在任务 ID 后展示来源入口`
4. `test(e2e): RFC-298 锁定 webhook 来源链接展示`
5. `docs(webhook): RFC-298 记录任务来源入口`

每个生产提交都同时携带对应测试；提交前精确暂存本人路径，不纳入并发
`packages/backend/src/services/scheduler.ts`。如 Codex 对生产代码有实质贡献，commit message
追加本 session 实际模型的 `Co-Authored-By` trailer，并在 push 前用
`git show -s --format=%B HEAD` 核验。

## 5. 验收映射

| Proposal AC                                        | 任务            |
| -------------------------------------------------- | --------------- |
| note/MR/pipeline/push/tag 完整层级                 | T1-T6           |
| 文案跟随实际目标、正文无 URL                       | T2, T4, T8-T9   |
| ID 后位置与小屏布局                                | T9-T10, T12-T13 |
| 根任务 + 继承 context 子任务                       | T4, T6, T12     |
| URL 安全与全失效缺省                               | T1-T2, T5, T8   |
| canonical/历史/损坏兼容                            | T4-T6           |
| 最小 wire、raw context 隔离、无 migration/API 回查 | T3-T7           |
| a11y/外链属性                                      | T8-T10, T12     |
| 全门禁与实现门                                     | T15             |

## 6. 完成定义

- Proposal §6 全部勾选且有测试/视觉证据；
- `bun run gate:local` 全绿；
- 与本 RFC 有关的 Playwright/E2E 绿；
- 实现门 findings 全处置；
- `STATE.md` 与 `design/plan.md` 状态更新为 Done；
- 若用户授权上库，再按 exact SHA 区分本地验证、push、CI 与 live service 状态。

## 7. 实施记录（2026-08-13）

- T1-T3：shared 新增闭合 kind/schema、只接受无 userinfo 的 HTTP(S) URL 安全门、
  9 事件选择器与 GitHub/GitLab commit URL 构造；22 个定向用例全绿。
- T4-T7：只在 `getTask()` 详情读路径解析冻结 context，`rowToTask()` 只接收
  `{kind,url}|null`；canonical、历史扁平、子任务继承、损坏/非 webhook/全失效与
  HTTP 详情/列表不扩面均已锁定；定向 backend 38 个用例全绿。
- T8-T11：五种闭合中英文案、ID 后条件链接、无孤立分隔点、外链安全属性与
  nowrap 来源组均已落地；frontend 定向 13 个用例全绿。
- T12-T14：真 daemon/API/browser 链路与 390px 对照 E2E 2/2 通过；desktop/mobile
  视觉场景 2/2 通过，macOS mobile 基线已更新并人工审图；用户文档已更新。
- T15：在只含 RFC-298 改动的固定快照、正常本机权限下完成 `bun run gate:local`：
  typecheck、lint、format、依赖分层全绿；shared 2055/2055、frontend 6404/6404，
  backend 四分片合计 10015 pass / 35 skip / 0 fail，完整门禁 5m41s 通过。
- 外部 companion Codex 实现门因私有源码外发审批被拒绝，未绕过；已以当前
  Codex 会话内的源码、契约、安全与相邻遗漏审查代替，未发现 RFC-298 未处置 finding。
