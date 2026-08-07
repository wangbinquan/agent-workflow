# RFC-263 · 任务分解

单 RFC 单交付（主干开发，直接在 `main` 上分批 commit）。依赖链：**T1 是所有其余任务的前置**（契约层定了变量名，adapter 与前端才有可实现的目标）。

| 任务 | 内容 | 依赖 | 落点 |
|---|---|---|---|
| **RFC-263-T1** | **shared 契约层**：`CodeHostEventSchema` +16 字段（design §1）；`WEBHOOK_TEMPLATE_VARS` 13→30；`COMMON_VARS` +8 与逐事件矩阵扩展（design §6）；新增 `WEBHOOK_VAR_GROUPS`；`eventVarsOf` 填新变量 + `COMMENT_POSITION_JSON_MAX_CHARS` 序列化规则（design §5.2） | — | `packages/shared/src/schemas/webhook.ts`、`packages/shared/src/webhookTemplate.ts` |
| **RFC-263-T1a** | T1 的测试：键集完备性、position 四例（GitLab 原样含 null / GitHub 省略 null / 超限空串 / 序列化失败空串）、分组并集与交集、`availableVarsFor` 新变量交集 | T1 | `packages/shared/tests/webhook-schema.test.ts` |
| **RFC-263-T2** | **GitLab adapter**：`parseProject` / `parseUser` / `parseMrBlock` 扩字段；push·MR·note·pipeline 四分支补取（design §2）；`gitlabApiBaseUrl` 纯函数（design §4.1，含子路径部署） | T1 | `services/webhook/gitlabAdapter.ts` |
| **RFC-263-T2a** | T2 的测试：note 的 discussion_id/position/url/mr_id、push 的 before 与顶层 user_id、pipeline 的 id/url、多层 namespace 的 owner 切分、apiBase 五形态、**软提取回归锁**（缺全部新字段仍 `ok:true`） | T2 | `packages/backend/tests/rfc263-gitlab-params.test.ts` |
| **RFC-263-T3** | **GitHub adapter**：`parseRepository` / `parseSender` / `parsePrBlock` 扩字段；push·PR·issue_comment·review_comment·workflow_run 五分支补取（design §3）；`githubApiBaseUrl` 纯函数（design §4.2，含 GHES） | T1 | `services/webhook/githubAdapter.ts` |
| **RFC-263-T3a** | T3 的测试：`in_reply_to_id ?? id` 两条独立用例、issue_comment 的 thread 空 / `mr_id` 不填 / `mr_url`=issue.html_url、**workflow_run 的 `mr_url` 不填**（防回归成 API URL）、apiBase 三形态、软提取回归锁 | T3 | `packages/backend/tests/rfc263-github-params.test.ts` |
| **RFC-263-T4** | **前端**：`TemplateVarChips` 最小扩展（可选 `groups` + `titleOf`，`vars` 路径逐字节不变）；`webhookVarsForDisplay` 返回分组；`TriggersPanel` 三个注入面消费（design §7） | T1 | `components/TemplateVarChips.tsx`、`components/webhooks/TriggersPanel.tsx` |
| **RFC-263-T5** | **i18n**：30 条变量说明中英双语；`comment_thread_id` 写明「GitLab 即 discussion_id」、`mr_id` 写明「REST 用 mr_iid」 | T4 | `i18n/zh-CN.ts`、`i18n/en-US.ts` |
| **RFC-263-T4a** | 前端测试：分组渲染（`findByRole('group')`）、tooltip 存在、既有插入行为不回归 | T4·T5 | `packages/frontend/tests/template-var-chips.test.tsx`（扩）+ 新增触发器面用例 |
| **RFC-263-T6** | **文档**：`docs/webhook-triggers.md` 新增「§7 事件 → 可跟动作 → 变量 → curl」对照表（GitLab / GitHub 各一套可直接抄的回帖样例）+ **凭据通道现状**三条（proposal §6）；加源码文本断言锁「文档里出现的 `{{var}}` ⊆ `WEBHOOK_TEMPLATE_VARS`」 | T1 | `docs/webhook-triggers.md` + 一条测试 |
| **RFC-263-T7** | **棘轮与门禁**：`tests/rfc223-identity-structural-guard.test.ts` findings 计数按实测更新 + 注释说明；`bun run typecheck && lint && test && format:check` 全绿；推送后按 exact SHA 查 CI | T1–T6 | — |
| **RFC-263-T8** | **实现门**：Codex review（分离 worktree，pin→本次 commit）修 findings；`design/plan.md` RFC 索引登记 + `STATE.md` 状态改 Done | T7 | `design/plan.md`、`STATE.md` |

## 提交批次建议

1. **批 1**：T1 + T1a（契约层独立可测，先绿再动 adapter）
2. **批 2**：T2 + T2a + T3 + T3a（两个 adapter 对称，一起提交便于对比 review）
3. **批 3**：T4 + T5 + T4a + T6（前端与文档）
4. **批 4**：T7 + T8（棘轮 / 门禁 / 索引）

## 验收清单

- [x] **AC-1** 17 个新变量进表与矩阵，保存期静态校验对不可用变量如实 422 —— `webhook-vars-rfc263` 的「push 触发器引用 comment_thread_id 被拒」
- [x] **AC-2** GitLab `comment_thread_id` = `discussion_id`；GitHub 行内 = `in_reply_to_id ?? id`（两条独立用例）；GitHub 普通 PR 评论 = 空
- [x] **AC-3** `api_base_url` 四形态正确（github.com / GHES / GitLab 根 / **GitLab 子路径**），推导失败 → 空串
- [x] **AC-4** `comment_position_json` 两边键名各自与建评论 API 参数一一对应（GL 保留 null / GH 省略 null + 当前行原始行成组）；非行内评论空串
- [x] **AC-5** 全部新变量缺值渲染空串（不出现 `undefined` / `null` 字面量）
- [x] **AC-6** 既有触发器渲染结果逐字节不变 —— rfc257/259 adapter 全套 27 条不改断言即绿
- [x] **AC-7** 旧投递 replay 能提取新字段 —— replay 走同一 `normalize`，路径零改动
- [x] **AC-8** chips 分组 + tooltip，30 变量不挤成一坨
- [x] **AC-9** `docs/webhook-triggers.md` §7 对照表 + 两平台 curl 样例 + 凭据现状三条（附「文档变量 ⊆ 变量表」源码文本锁）
- [x] **AC-10** 零迁移、零 wire breaking、零权限点变更
- [ ] 四项门禁全绿 + CI 按 exact SHA 查绿
- [ ] Codex 实现门 findings 清零

## 实现期改判记录

- `webhookVarsForDisplay` → `webhookVarGroupsForDisplay`（返回分组）。三处既有断言按新 COMMON 集显式改判并注明理由：`template-var-chips.test.tsx`（长度 7 → 16）、`webhook-template-var-insert.test.tsx`（同）。
- `gitlabAdapter` 的 `mrIid` 内联三元换成统一的 `numStr`：空字符串从「原样带进信封」收紧为 `undefined`（空 iid 不是合法编号，让它走 parse-failed 比让下游拿 `''` 拼 URL 更早暴露）。
- `rfc223-identity-structural-guard` 指纹更新：chip 渲染移出内联 `.map()` 到局部 `chip` helper，围绕函数名变化，sink 与判定不变。
- **RFC 编号避让**：token 通道后续 RFC 原写 264，落档时发现并发 session 已占用 → 改 265，并把这条通用踩坑落进 `docs/dev-gotchas.md`。
