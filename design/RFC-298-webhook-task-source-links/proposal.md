# RFC-298 Webhook 任务来源链接

状态：**Done（2026-08-13）**

## 1. 背景

Webhook 触发的任务名称已经能提示仓库、MR/PR 编号等上下文，但进入任务详情后，用户仍需
回到代码平台手工搜索对应的评论、MR/PR、流水线或提交。任务详情标题区目前只显示任务名、
状态、任务 ID 与执行主体，没有从任务回到原始事件对象的直接入口。

现有数据链已经具备实现条件，无需回查 GitLab/GitHub：

- GitLab/GitHub adapter 会把事件归一化为 `CodeHostEvent`；
- RFC-263 已提供 `mr_url`、`comment_url`、`pipeline_url`、`project_web_url`、
  `commit_sha` 与 `provider`；
- RFC-292 会把这些字段冻结进任务行的 `trigger_context_json`，并在子任务中继承；
- 任务详情读模型目前没有投影这些字段，所以前台无法展示来源入口。

本 RFC 只把已冻结的可信投影转换为一个受限的任务来源链接，不把整份 trigger context
暴露给前端，也不新增代码平台请求。

## 2. 用户已拍板的产品规则

### D1. 展示文案，不展示原始 URL

链接只显示可读文字，不把可能很长的 URL 直接铺在标题区。文案由**最终选中的目标类型**
决定：

| 最终目标 | 中文文案       | 英文文案                       |
| -------- | -------------- | ------------------------------ |
| 评论     | 查看原始评论   | Open original comment          |
| MR/PR    | 查看原始 MR/PR | Open original merge request/PR |
| 流水线   | 查看原始流水线 | Open original pipeline         |
| 提交     | 查看原始提交   | Open original commit           |
| 项目     | 查看源项目     | Open source project            |

因此，评论事件的 `comment_url` 缺失但 `mr_url` 可用时，文案必须是「查看原始 MR/PR」，
不能继续写「查看原始评论」。

### D2. 固定放在任务 ID 后面

入口只放在任务详情页标题下方的任务 ID 行，顺序固定为：

```text
任务 ID 01H... · 查看原始评论 ↗
```

不在标题上方、执行主体行、任务列表、首页任务流或其他卡片重复展示。

### D3. 完整的事件回退层级

每一层先校验 URL；当前候选不可用时继续下一层，不因一个坏字段放弃整条回退链。

| 事件类型                                               | 按顺序选择的目标                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `note`                                                 | `comment_url` → `mr_url` → `project_web_url`                     |
| `mr_opened` / `mr_updated` / `mr_merged` / `mr_closed` | `mr_url` → `project_web_url`                                     |
| `pipeline_failed` / `pipeline_succeeded`               | `pipeline_url` → `mr_url` → `project_web_url`                    |
| `push` / `tag_push`                                    | 由 `provider + project_web_url + commit_sha` 构造提交页 → 项目页 |

GitHub 提交页为 `<project>/commit/<sha>`；GitLab 提交页为
`<project>/-/commit/<sha>`。构造前必须先校验项目 URL；SHA 必须是 7–64 位十六进制且不能
全为 `0`（删除分支/tag 的 sentinel），再作为编码后的单一路径段使用。

### D4. 覆盖整棵 Webhook 任务链

直接由 webhook fire 创建的根任务，以及继承同一冻结 trigger context 的调用子任务，都显示
同一个来源入口。是否展示以任务自身冻结的合法 webhook context 为准，不依赖仍然存在的
trigger、delivery 或父任务行。

### D5. 安全与缺省行为

- 只允许 `http:` / `https:`；拒绝带 URL userinfo 的候选；
- 无效候选继续尝试下一层；全部不可用时不渲染链接、分隔点或占位符；
- 链接新窗口打开，并使用 `noopener noreferrer`；
- URL 只进入 `href`，不能成为可见正文或 hover `title`；
- 损坏的 `trigger_context_json` fail-closed，不影响任务详情其余内容。

## 3. 目标

1. 用户从任意 webhook 来源任务详情，一次点击回到最精确的原始事件对象。
2. 所有 9 种现有 webhook 事件类型都有确定的优先级与降级结果。
3. 复用任务已经冻结的上下文，不回查代码平台、不依赖 webhook 管理资源继续存在。
4. 保持任务标题区紧凑、可读、可访问，并在小屏上自然换行。
5. 让回退选择成为 shared 纯函数单一事实源，后端、前端与测试不各写一份事件判断。

## 4. 非目标

- 不在界面直接显示原始 URL 字符串。
- 不在 `/tasks` 列表、首页任务流、调度历史或 webhook delivery 页面新增同类入口。
- 不新增 webhook template variable，不修改 `CodeHostEvent` 或 30 字段 trigger contract。
- 不保存新的 `source_url` 数据库列，不做历史回填或 migration。
- 不调用 GitLab/GitHub API，不做 URL 存活探测，也不读取 delivery 的原始 body。
- 不改变任务标题生成、trigger 匹配、supersede、权限或任务生命周期语义。

## 5. 用户故事

1. **评论触发修复**：用户打开任务，ID 后看到「查看原始评论」，点击直达具体评论锚点。
2. **评论 URL 缺失**：同一任务退到 MR/PR 页面，链接准确写「查看原始 MR/PR」。
3. **流水线失败触发**：优先打开具体流水线；平台未给流水线 URL 时退到 MR/PR，再退项目页。
4. **Push/Tag 触发**：优先打开事件提交；缺 SHA 时仍可打开源项目。
5. **调用子任务**：从 webhook 根任务派生的子任务仍能回到同一个事件来源。
6. **旧或损坏任务**：没有可用来源字段时，标题区保持现状，不出现坏链接或空文案。

## 6. 验收标准

- [x] `note` 严格按 评论 → MR/PR → 项目 选择，且文案跟随实际目标。
- [x] 四类 MR 事件严格按 MR/PR → 项目选择。
- [x] 两类 pipeline 事件严格按 流水线 → MR/PR → 项目选择。
- [x] `push` / `tag_push` 在 GitHub/GitLab 分别生成正确提交页；SHA 缺失、非法或全零时退项目页。
- [x] 无效 scheme、带 userinfo、畸形或缺失 URL 会逐级跳过；全失效时不渲染任何来源 UI。
- [x] 任务 ID 仍完整可复制，来源文字紧跟 ID 后；小屏可换行且不挤压标题操作区。
- [x] 可见正文不含 URL，只显示五种受控 i18n 文案之一。
- [x] 链接为 `target="_blank"` + `rel="noopener noreferrer"`，并有明确可访问名称。
- [x] Webhook 根任务与继承 context 的子任务均展示；非 webhook 任务不展示。
- [x] canonical 与 RFC-292 历史扁平 context 都能投影；损坏 context fail-closed。
- [x] `Task` wire 只新增最小 `{ kind, url } | null` 投影，不暴露 trigger context/raw event。
- [x] 无数据库迁移、无代码平台请求；定向 shared/backend/frontend/E2E 与 `bun run gate:local` 全绿。

## 7. 能力影响

本 RFC 只新增只读导航入口，不关闭、收窄或改变任何现有能力。现有任务 ACL 继续决定谁能
读取任务详情；本 RFC 不扩大任务可见范围。
