# RFC-263 · 技术设计

读法：先 `proposal.md`（§3 动作矩阵是字段集的推导依据，§6 是凭据现状披露）。本篇是接口契约与映射表。所有「既有代码」断言均附 `file:line`；外部平台字段以官方文档/源码为准并列入 proposal §8 待实证清单。

## 0. 改动面总览

```
shared/schemas/webhook.ts   信封 +16 字段 · 变量表 13→30 · 事件矩阵扩展 · 变量分组常量
shared/webhookTemplate.ts   eventVarsOf 填新变量 + position JSON 序列化与上限
backend/gitlabAdapter.ts    parseProject/parseUser/parseMrBlock 扩字段 + 四个事件分支补取
                            + `gitlabApiBaseUrl` 纯函数（导出供测）
backend/githubAdapter.ts    parseRepository/parseSender/parsePrBlock 扩字段 + 五个事件分支补取
                            + `githubApiBaseUrl` / `githubCommentPosition` 纯函数
frontend/TemplateVarChips   最小扩展：可选分组 + 每 chip 的说明 tooltip
frontend/i18n               30 个变量的中英文说明
docs/webhook-triggers.md    §7 事件→动作→变量→curl 对照表 + 凭据现状
```

**零迁移**：`CodeHostEvent` 是运行时构造物，不落库（落库的是 `webhook_deliveries.body_json` 原文 + `event_type`/`repo_path`/`stream_hint` 摘要列，RFC-257 design §1.3）。**零 wire breaking**：新变量只出现在触发器模板的渲染输入侧。

## 1. 归一化信封扩展（`shared/schemas/webhook.ts:57-79`）

在 `CodeHostEventSchema` 追加，全部 `optional`（软提取，见 §6 失败模式）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `projectId` | `string?` | 平台项目主键（GitLab `/projects/:id` 的实参） |
| `repoOwner` / `repoName` | `string?` | GitHub `{owner}` / `{repo}` 路径段 |
| `apiBaseUrl` | `string?` | 推导值，§4 |
| `projectWebUrl` | `string?` | 仓库网页地址 |
| `defaultBranch` | `string?` | 仓库默认分支 |
| `authorId` | `string?` | 事件作者的平台用户 id |
| `mrId` | `string?` | MR/PR 的 global id（≠ 既有 `mrIid`） |
| `mrUrl` | `string?` | MR/PR 网页地址 |
| `commentId` | `string?` | 评论本体 id |
| `commentThreadId` | `string?` | 讨论线程 id，§5.1 |
| `commentUrl` | `string?` | 评论网页地址 |
| `commentPosition` | `unknown?` | **结构化对象**（非字符串），序列化在 `eventVarsOf`，§5.2 |
| `pipelineId` | `string?` | GitLab pipeline id / GitHub workflow run id |
| `pipelineUrl` | `string?` | 流水线网页地址 |
| `commitBefore` | `string?` | push 的前一个 sha |

**数值统一转字符串**（与既有 `mrIid` 的 `String(iidRaw)` / `numStr` 姿势一致，`gitlabAdapter.ts:86-90`、`githubAdapter.ts:32-39`）：GitLab 的 `discussion_id` 本身是 hex 字符串，其余 id 是数字。

**扁平不嵌套**：既有信封是扁平的（`mrIid` / `mrTitle` / `commentText`），新字段跟随，不引入 `comment: {...}` 子对象——否则 `eventVarsOf` 的取值路径与既有字段两套写法。

## 2. GitLab 映射（`services/webhook/gitlabAdapter.ts`）

### 2.1 公共块

| 信封字段 | payload 路径 | 改哪里 |
|---|---|---|
| `projectId` | `project.id` | `parseProject`（`:64-74`）扩返回 |
| `projectWebUrl` | `project.web_url` | 同上 |
| `defaultBranch` | `project.default_branch` | 同上 |
| `repoOwner` / `repoName` | `path_with_namespace` 按**最后一个 `/`** 切分（`group/sub/repo` → owner=`group/sub`、name=`repo`） | 同上 |
| `apiBaseUrl` | 由 `web_url` + `path_with_namespace` 推导，§4.1 | 同上 |
| `authorId` | `user.id`；push/tag_push 无 `user{}` → 顶层 `user_id` | `parseUser`（`:98-105`）扩返回，与既有双形态兼容同款 |

**`repoOwner` 的切分口径**：GitLab 的 namespace 可以多层（`group/subgroup/repo`），`repoOwner` 取最后一段之前的全部。GitHub 恒为单段，语义天然对齐。该切分只服务「GitHub 调 API」这一用途，GitLab 侧的 API 一律走 `projectId`——文档写明。

### 2.2 逐事件

| 事件 | 新提取 | payload 路径 |
|---|---|---|
| push / tag_push | `commitBefore` | 顶层 `before` |
| merge_request | `mrId` / `mrUrl` | `object_attributes.id` / `.url` |
| note | `commentId` | `object_attributes.id` |
| note | `commentThreadId` | `object_attributes.discussion_id` |
| note | `commentUrl` | `object_attributes.url` |
| note | `commentPosition` | `object_attributes.position`（**原样对象**，仅 DiffNote 有） |
| note | `mrId` / `mrUrl` | `merge_request.id` / `.url` |
| pipeline | `pipelineId` / `pipelineUrl` | `object_attributes.id` / `.url` |
| pipeline | `mrId` / `mrUrl` | `merge_request.id` / `.url`（MR 流水线才有） |

依据：GitLab `lib/gitlab/hook_data/note_builder.rb` 的 `SAFE_HOOK_ATTRIBUTES` 含 `id` / `discussion_id` / `position` / `line_code` / `noteable_id` / `project_id`，`url` 经 `.merge()` 追加（2026-08-07 源码查证）。`parseMrBlock`（`:76-96`）扩 `id` / `url` 两个键后，note 与 pipeline 分支共用。

## 3. GitHub 映射（`services/webhook/githubAdapter.ts`）

### 3.1 公共块

| 信封字段 | payload 路径 | 改哪里 |
|---|---|---|
| `projectId` | `repository.id` | `parseRepository`（`:70-80`）扩返回 |
| `repoOwner` / `repoName` | `repository.owner.login` / `repository.name` | 同上（**不**从 `full_name` 切——原字段更权威） |
| `projectWebUrl` | `repository.html_url` | 同上 |
| `defaultBranch` | `repository.default_branch` | 同上 |
| `apiBaseUrl` | 由 `html_url` + `full_name` 推导，§4.2 | 同上 |
| `authorId` | `sender.id` | `parseSender`（`:82-86`）扩返回 |

### 3.2 逐事件

| 事件 | 新提取 | payload 路径 |
|---|---|---|
| push | `commitBefore` | 顶层 `before` |
| pull_request | `mrId` / `mrUrl` | `pull_request.id` / `.html_url` |
| issue_comment | `commentId` / `commentUrl` | `comment.id` / `.html_url` |
| issue_comment | `mrId` / `mrUrl` | ⚠️ `issue.id` **不是** PR 的 id（issue 与 PR 是两个 id 空间）→ **不填 `mrId`**；`mrUrl` = `issue.html_url`（该 URL 就是 PR 页面） |
| issue_comment | `commentThreadId` | **不填**（普通 PR 评论无线程，proposal AC-2） |
| pull_request_review_comment | `commentId` / `commentUrl` | `comment.id` / `.html_url` |
| pull_request_review_comment | `commentThreadId` | `comment.in_reply_to_id ?? comment.id`，§5.1 |
| pull_request_review_comment | `commentPosition` | 由 comment 字段组装，§5.2 |
| pull_request_review_comment | `mrId` / `mrUrl` | `pull_request.id` / `.html_url` |
| workflow_run | `pipelineId` / `pipelineUrl` | `workflow_run.id` / `.html_url` |
| workflow_run | `mrId` | `workflow_run.pull_requests[0].id`（fork PR 为空数组，RFC-259 已有降级） |
| workflow_run | `mrUrl` | **不填**——`pull_requests[0].url` 是 **API URL** 不是网页地址，填了会让「贴链接」动作贴出一条 JSON 端点 |

依据：`octokit/webhooks` 的 `common/pull-request-review-comment.schema.json`（2026-08-07 查证）——`in_reply_to_id` 与 `subject_type` 是仅有的两个 optional 属性，其余（`id` / `pull_request_review_id` / `path` / `position` / `line` / `original_line` / `side` / `start_line` / `start_side` / `commit_id` / `html_url`）均 required，其中 `position` / `line` / `start_line` / `start_side` 可为 null。

## 4. `apiBaseUrl` 推导

纯函数，各 adapter 内实现并导出（provider 特有知识不出 adapter，沿 RFC-257 design §0 的信封边界原则）。**推导不出一律 `undefined` → 渲染空串**，绝不猜测（proposal AC-3）。

### 4.1 GitLab

```
输入 webUrl = project.web_url, path = project.path_with_namespace
若 webUrl 以 `/${path}` 结尾：base = webUrl 去掉该后缀 ⇒ `${base}/api/v4`
否则：undefined
```

后缀剥离而非 `new URL().origin`，是为了**子路径部署**：`https://host/gitlab/group/repo` 必须得到 `https://host/gitlab/api/v4`，取 origin 会得到错误的 `https://host/api/v4`。大小写严格匹配（GitLab 的 `web_url` 与 `path_with_namespace` 同源，不一致即视为形态未知）。

### 4.2 GitHub

```
输入 htmlUrl = repository.html_url, full = repository.full_name
若 htmlUrl 以 `/${full}` 结尾：base = 去掉后缀
    base 的 hostname ∈ {github.com, www.github.com} ⇒ `https://api.github.com`
    否则（GHES）                                    ⇒ `${base}/api/v3`
否则：undefined
```

hostname 判别走 `new URL(base)` 并 try/catch（畸形 URL → undefined）。GHES 不支持子路径部署，`${base}/api/v3` 恒等于 `https://host/api/v3`。

## 5. 评论线程与位置

### 5.1 `commentThreadId`（回复到同一线程）

| provider / 形态 | 值 | 回复端点 |
|---|---|---|
| GitLab 任意 MR 评论 | `object_attributes.discussion_id` | `POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes` |
| GitHub 行内评论（review comment） | `in_reply_to_id ?? comment.id` | `POST /repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies` |
| GitHub 普通 PR 评论（issue_comment） | **空** | 无线程概念，只能 `POST /issues/{n}/comments` 新开 |

GitHub 的 `?? comment.id` 是必需的：回复端点吃的是**线程根评论的 id**。用户回复别人的行内评论时 `in_reply_to_id` 指向根；对根评论本身回复时该字段不存在，此时根就是 `comment.id`。若直接用 `comment.id` 而不看 `in_reply_to_id`，回复第 3 条评论会开出一条新线程而不是接在原线程后。

### 5.2 `commentPosition` → `{{comment_position_json}}`

**设计口径：键名与该平台建评论 API 的参数名一一对应，agent 原样回传即可**。两边策略不同，理由见下。

**GitLab**（DiffNote）：`object_attributes.position` **原样透传**，其键正好是 Discussions API 的 `position[...]` 实参集：

```json
{"base_sha":"a1","start_sha":"b2","head_sha":"c3",
 "old_path":"src/a.ts","new_path":"src/a.ts",
 "position_type":"text","old_line":null,"new_line":12}
```

`null` **保留**——GitLab 的 null 有语义（`old_line:null` ⇒ 这是新增行），丢掉会让 agent 无法区分新增/删除行。

**GitHub**（review comment）：由 comment 字段组装，**省略 null 键**：

```json
{"path":"src/a.ts","line":12,"side":"RIGHT","commit_id":"c3"}
```

GitHub 的 null 是「不适用」（`start_line:null` ⇒ 单行评论），原样传给 `POST /pulls/{n}/comments` 会 422，所以只输出有值的键。`line` 取 `comment.line ?? comment.original_line`：评论所指行被后续 commit 改动时 `line` 为 null，`original_line`（schema 标注非 null）是唯一可用行号；两者皆无则整个 `line` 键省略。**不含 `diff_hunk`**——它是上下文不是定位参数（可能几十行），agent 有 worktree 可以直接读文件；需要时仍可从 `{{event_json}}` 取。

**序列化与上限**（在 `shared/webhookTemplate.ts` 的 `eventVarsOf`，与 `event_json` 的截断同处）：`JSON.stringify` 失败或长度 > `COMMENT_POSITION_JSON_MAX_CHARS`（8 KiB）→ **渲染空串**。这里**不能像 `event_json` 那样截断**：截断的 JSON 是非法 JSON，agent 拿到会解析失败或（更糟）在部分解析后打出错位的评论。空串是可判定的失败。

## 6. 变量表与事件矩阵（`shared/schemas/webhook.ts:109-153`）

`WEBHOOK_TEMPLATE_VARS` 13 → 30（新增 17 个，含 `provider`）。

`COMMON_VARS`（每类事件都声明）追加 8 个：`provider` `api_base_url` `project_id` `repo_owner` `repo_name` `project_web_url` `default_branch` `author_id`——它们全部来自 project/repository/user 块，9 类事件的 payload 都带（GitHub org 级 `ping` 无 repository，但它在 repository 解析前就返回 `unsupported`，`githubAdapter.ts:130-132`）。

逐事件追加：

| 事件 | 追加 |
|---|---|
| push / tag_push | `commit_before` |
| mr_opened / mr_updated / mr_merged / mr_closed | `mr_id` `mr_url` |
| note | `mr_id` `mr_url` `comment_id` `comment_thread_id` `comment_url` `comment_position_json` |
| pipeline_failed / pipeline_succeeded | `pipeline_id` `pipeline_url` `mr_id` `mr_url` |

矩阵语义不变（RFC-257：「声明 = 该事件类型**结构上可能**提供该值；运行期缺值渲染空串」）——所以 `note` 声明 `comment_thread_id` 而 GitHub 普通 PR 评论渲染空串，与既有「pipeline 声明 `mr_iid` 但分支流水线为空」完全同构，不是新语义。

**新增分组常量**（供前端消费，单一事实源在 shared）：

```ts
export const WEBHOOK_VAR_GROUPS = [
  { key: 'context', vars: [...] },   // 事件上下文：event_type provider repo_path branch … event_json
  { key: 'api',     vars: [...] },   // API 定位：api_base_url project_id … comment_position_json
] as const
```

需有测试锁定两组的并集 === `WEBHOOK_TEMPLATE_VARS` 且交集为空（漏登记一个新变量会让它在 UI 里消失）。

## 7. 前端

- **`TemplateVarChips`（`components/TemplateVarChips.tsx:90-114`）最小扩展**（CLAUDE.md 前端一致性规程第 2 条）：新增可选 `groups?: ReadonlyArray<{ label: string; vars: ReadonlyArray<string> }>`（与既有 `vars` 二选一，`vars` 路径逐字节不变）与可选 `titleOf?: (name: string) => string`（chip 的 `title` 属性）。不 fork 组件、不在 TriggersPanel 里自写一套。
- **`webhookVarsForDisplay`（同文件 `:33-39`）** 保持「按所选事件类型交集过滤 + `event_json` 置顶」语义，返回值改为分组结构；分组内部顺序仍按 `WEBHOOK_TEMPLATE_VARS` 声明序。
- **i18n**：30 条变量说明（`webhookTriggers.vars.<name>`）中英双语。`comment_thread_id` 的说明必须写「GitLab 即 `discussion_id`」，`mr_id` 必须写「REST 路径用 `mr_iid`，本变量是 global id」——这两处是最容易用错的。
- 消费点 `TriggersPanel.tsx:488、853-860`（workflow 输入映射）以及 agent/workgroup 两个注入面同步。

**仓内棘轮**：`tests/rfc223-identity-structural-guard.test.ts:377-382` 的 findings 计数（当前 140）已为 TemplateVarChips「按变量名 keyed 渲染」记过一笔；本 RFC 若因分组/tooltip 引入新的按名索引结构会让该计数上涨——按既有惯例在该文件补注释说明并更新期望值，不得绕过。

## 8. 兼容性

- **既有触发器零影响**（AC-6）：`renderTemplate`（`webhookTemplate.ts:87-92`）只替换出现过的 `{{var}}`，变量表变长不改变任何既有模板的渲染结果。
- **既有测试零破坏**：两个 adapter 测试用逐字段 `expect(ev.x).toBe(...)`（`tests/rfc257-gitlab-adapter.test.ts` / `rfc259-github-adapter.test.ts` 全文无 `toEqual` / `toMatchObject` 全对象断言），新增字段不会让它们变红。
- **replay**（AC-7）：`routes/webhookDeliveries.ts:215` 用存档 `body_json` + `replayHeaders` 重新 `normalize`，所以旧投递重放会走新 adapter 提取出新字段——前提是 `body_json` 未被保留期 GC 清空（RFC-261 可配，默认 30 天）。
- **保存期校验**：既有触发器不引用新变量，`templateVarIssues`（`webhookTemplate.ts:126-153`）对它们的判定不变。

## 9. 失败模式

| 失败 | 表现 | 设计选择 |
|---|---|---|
| 新字段缺失 / 类型不符 | 该变量渲染空串 | **软提取**：所有新字段走 `str()` / `numStr()` 式窄化，返回 `undefined`。**绝不**因新字段缺失把投递判成 `parse-failed`——那会把一条本可正常触发的事件整条丢掉（C4） |
| `apiBaseUrl` 推导不出 | 空串 | 文档指引改用 `{{project_web_url}}` 自行拼；空串导致 agent 的 URL 变成 `/projects/...` 相对路径，curl 立刻失败（可判定），不会打到错误主机 |
| position JSON 超 8 KiB / 序列化失败 | 空串 | 见 §5.2：不截断 |
| GitHub 普通 PR 评论要求回复线程 | `comment_thread_id` 空串 | 文档写明该形态只能新开评论；与 RFC-259 D7'「普通 PR 评论无分支」是同一类如实缺省 |
| 模板引用了该事件类型不提供的新变量 | **保存期 422** `template-var-unavailable` | 既有机制自动覆盖（矩阵驱动），无需新错误码 |

## 10. 测试策略

**shared**
- `eventVarsOf` 返回键集 === `WEBHOOK_TEMPLATE_VARS`（防漏填新变量）；每个新变量的取值与缺值空串。
- `comment_position_json`：GitLab 原样（含 null 保留）/ GitHub 省略 null / 超 8 KiB → 空串 / 循环引用 → 空串。
- `WEBHOOK_VAR_GROUPS` 并集 === 全表、交集 = ∅。
- `availableVarsFor` 对新变量的交集行为（`['note','push']` 不含 `comment_*`）。

**backend adapter**（每 provider × 每事件类型正反例）
- GitLab：note 的 `discussion_id` / `position` / `url` / 双 `mr_id`；push 的 `before` 与顶层 `user_id`；pipeline 的 id/url；`project.id`/`web_url`/`default_branch`；多层 namespace 的 `repo_owner` 切分。
- GitHub：review comment 的 `in_reply_to_id ?? id`（**两条独立用例：有 in_reply_to_id / 无**）；issue_comment 的 `comment_thread_id` 空 + `mr_id` 不填 + `mr_url` = issue.html_url；workflow_run 的 `mr_url` **不填**（防回归成 API URL）；`sender.id`。
- `apiBaseUrl` 纯函数：github.com / GHES / GitLab 根路径 / **GitLab 子路径** / web_url 与 path 不匹配 → undefined / 畸形 URL → undefined。
- **软提取回归锁**：构造缺失全部新字段的最小 payload，断言 `normalize` 仍 `ok:true` 且既有字段不变（锁死 C4）。

**frontend**
- chips 分组渲染（`findByRole('group')` + 组标签）、tooltip 存在、插入行为不回归（既有 `tests/template-var-chips.test.tsx`）。
- i18n 完备性（30 变量 × 双语，走仓内既有 i18n 对齐测试）。

**docs**：对照表里的 curl 样例所引用的变量名必须都在 `WEBHOOK_TEMPLATE_VARS` 内——加一条源码文本断言，防文档写出不存在的变量。

## 11. 与既有模块的耦合点

| 模块 | 耦合 | 性质 |
|---|---|---|
| `shared/schemas/webhook.ts` | 信封 / 变量表 / 矩阵 / 分组常量 | 扩展 |
| `shared/webhookTemplate.ts` | `eventVarsOf` 填值 + position 序列化 | 扩展 |
| `backend/services/webhook/{gitlab,github}Adapter.ts` | 提取 + API base 推导 | 扩展 |
| `backend/services/webhook/webhookDispatch.ts:230` | `eventVarsOf(event)` 消费点 | **零改动**（表驱动） |
| `backend/routes/webhookDeliveries.ts:215` | replay 重新 normalize | **零改动**（自动受益） |
| `backend/services/webhook/matching.ts` | 匹配只读 repoPath/eventType/branch/author | **零改动** |
| `frontend/components/TemplateVarChips.tsx` | 可选分组 + tooltip | 最小扩展 |
| `frontend/components/webhooks/TriggersPanel.tsx` | 三个注入面消费分组 | 扩展 |
| `tests/rfc223-identity-structural-guard.test.ts` | findings 计数棘轮 | 显式登记 |
| DB / 迁移 / 权限点 / 路由契约 | — | **零改动** |
