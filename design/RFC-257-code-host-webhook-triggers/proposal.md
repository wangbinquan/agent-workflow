# RFC-257 · 代码平台 Webhook 触发器（入站事件驱动任务）

- 状态：Draft（设计门已闭环，待用户批准）
- 日期：2026-08-04（设计门 findings 折入同日）
- 作者：Claude（与用户四轮澄清拍板）
- 设计门：[design-gate-2026-08-04.md](./design-gate-2026-08-04.md) —— 对抗子代理判定 needs-changes（2 P0 + 8 P1 + 10 P2），逐条核实后**全部属实零驳回**，已折入本版；其中 D19 因 F-9 提权分析**改判断**（ACL → owner 制）
- 关联：RFC-024（launch-from-git-url，演进点预告）、RFC-159/165（定时任务，模型模板）、RFC-243（startExecution 统一收口）、RFC-255（secretBox 密封先例）

## 1. 背景

平台的产品愿景（`docs/blog/02-agent-workflow-how.md:472-479`）一直包含「工作流被事件驱动，AI 真正进入交付链路」：MR 打开自动审计、评论指令触发修复、流水线失败自动修到绿。但截至本 RFC，仓内 **255 个 RFC 与 81-issue 清单里没有任何外部事件触发机制**——任务只能由人在 UI 里发起或定时器（RFC-159）发起。RFC-024 曾把「webhook → 自动起任务」「Git provider 抽象」列为后续演进点（`design/RFC-024-launch-from-git-url/design.md:364-365`），本 RFC 即该演进的落地。

目标部署形态是**商用内网**：一个自建 GitLab 实例、**几百个仓库**，GitLab 与本平台 daemon 网络互通。几百个仓库在 GitLab 侧**只配置一个 webhook**（group/system 级），事件到达本平台后由平台内的**触发器规则**完成分流。

## 2. 目标

1. **全局 webhook 接收端点**：GitLab（group / system / project hook 均可）把所有仓库的事件投递到一个 URL；验签、去重、限流、投递审计、**快速应答 + 异步分发**（GitLab 10s 超时且失败不自动重试）。
2. **通用 provider 抽象 + GitLab 参考实现**：归一化事件信封平台无关，GitLab adapter 是 v1 唯一实现；出站回写只定义接口占位、不实现。
3. **触发器（owner 制资源，沿 `scheduled_tasks` 模型）**：匹配规则（repo 范围 × 事件类型 × 分支 × 评论指令 × 忽略名单）→ 目标执行（workflow / agent / workgroup 三形态，对齐 `startExecution` 与定时任务的 launchKind 模型）→ 启动参数模板（事件变量插值，输入 kind 感知）。
4. **事件驱动循环的安全网**：同流（repo × MR/分支）supersede 取消旧任务；连续触发熔断（修到绿循环的上限）；bot 自触发防护（作用域化忽略名单）；同流互斥串行化。
5. **可观测性与恢复**：投递历史（含拒绝/忽略原因、处理中间态）、触发记录、手动重放（**平台 replay 是主恢复路径**——GitLab 侧只有手工 Resend）。

## 3. 非目标

- **出站回写**（MR 评论、commit status、check run）：仅在 provider 接口定义 `ReportSink` 类型占位，v1 零实现、零调用（用户拍板「本期严格仅入站，回写留接口」）。后续独立 RFC。
- **代码平台 REST API 调用**（含只读）：不配置 access token，不拉 CI 日志/MR diff。CI 失败上下文由 agent 在 worktree 里自行重跑构建复现（用户拍板「零平台 API」）。
- **polling / 出站长连接**：部署形态确认平台可直达 daemon，不做轮询回退。
- **GitHub / Gitea adapter**：抽象层预留，实现后续按需加。
- **多仓任务触发**：webhook 事件只涉及单仓，v1 触发的任务是单仓任务；`repoGroupId` / `sourceTaskId` / `scratch` 型启动参数不可被触发器引用。
- **GitLab 侧配置自动化**：不调 GitLab API 创建 webhook，URL + Secret 由管理员人工粘贴。
- **评论指令的平台侧身份鉴权**：用户拍板「不限制」——内网 GitLab 全员可信，任何能评论的人都能下指令；授权主体是触发器 owner（见 §5 D10）。
- **触发器的分享/授权**：owner 制（D19 修订版），无 visibility/grants；协作场景由 admin/manager 的旁路覆盖。

## 4. 用户故事

**S1（管理员，一次性）**：在 设置 → Webhook 端点 新建端点，得到完整 URL（`publicBaseUrl` 拼装）与 Secret Token，粘贴到 GitLab Group → Settings → Webhooks，勾选 Push / Merge request / Note / Pipeline 事件。在 GitLab 建 bot 账号、发 `write_repository` PAT 配进 daemon 的 git credential helper，并把 bot username 填进相关触发器的忽略名单。
**S2（触发器作者）**：新建触发器「platform 组 MR 审计」：repo 范围 = 前缀 `platform/`，事件 = `mr_opened, mr_updated`，目标分支 = `main`，目标 = 工作流「Audit」。输入映射按输入 kind 感知：git kind 输入选「分支来自事件」（平台 fire 时代包 `{"kind":"branch","ref":"<事件源分支>"}`），text kind 输入填模板（如 `{{mr_title}}`）。保存时平台校验必填输入已覆盖、模板变量对所选事件类型可用；含模板的值跳过字面格式校验（延迟到运行期渲染后全量校验）。
**S3（开发者日常，修到绿）**：MR !42 流水线失败 → Pipeline Hook 到达 → 命中触发器「修到绿」（pipeline 类事件**不受忽略名单过滤**——流水线状态是客观事实）→ 同流互斥下取消同 repo 同 MR 还在跑的上一轮修复任务 → 以触发器 owner 身份起修复任务 → agent 在 worktree 重跑构建复现失败、修代码、push 回 MR 源分支 → GitLab 自动重跑流水线；再失败则再触发。bot push 引发的 pipeline_failed 作者是 bot（∈ 忽略名单）→ 计数**不重置**、正常累加，连续 3 轮熔断；开发者自己 push 后的 pipeline_failed 作者是人（∉ 名单）→ 计数重置，循环重新获得配额。bot 的 push/mr_updated 事件被忽略名单过滤，不会触发 push 型/MR 型触发器（防自触发风暴）。
**S4（开发者日常，评论指令）**：在 MR 里评论 `/fix 把这个空指针处理掉` → Note Hook 命中评论指令触发器 → 起修复任务，评论正文经 `{{comment_text}}` 进入 prompt；产出以 git push 呈现在 MR 上（无平台 API 回帖，执行详情在本平台 UI）。
**S5（排障，分层）**：管理员在投递历史页（`webhook-endpoints:manage`）看到 `rejected(invalid-token)` → 轮换 secret 重贴，或看到 `ignored(no-trigger-matched)` 明白规则没罩住该仓；触发器 owner 在**自己触发器的 fires 列表**里排障（skipped/launch-failed 原因、supersede 链、熔断态与重置按钮）。

## 5. 决策记录

用户拍板（对话四轮）：

| # | 决策 | 内容 |
|---|---|---|
| D1 | 方向 | 仅入站触发；出站回写只留接口不实现 |
| D2 | 平台 | 通用 provider 抽象；参考实现 = 自建 GitLab |
| D3 | 网络 | GitLab 可直达 daemon，真 webhook receiver，不做 polling |
| D4 | 场景 | push 触发、MR 审计、评论指令、修到绿循环、通用可配置触发器 |
| D5 | 修到绿 | = 事件驱动循环（pipeline_failed 反复触发修复任务），配熔断上限 |
| D6 | 产出交付 | 修复走 git push 回源分支；审计/回执只在本平台 UI；零平台 API 写入 |
| D7 | 零平台 API | 不配 access token；CI 失败上下文靠 agent 在 worktree 重跑复现 |
| D8 | 并发 | supersede：新事件取消同流旧任务（v1 固定，不做可配） |
| D9 | 端点形态 | 几百仓共用一个全局 hook；分流靠平台内触发器规则匹配 + repo 动态解析 |
| D10 | 指令权限 | GitLab 侧评论者身份不限制；授权主体 = 触发器 owner（预授权模型） |
| D11 | 人审环节 | 沿现状：反问/评审照常挂 awaiting_human / awaiting_review，触发器 owner 在 UI 处理 |
| D12 | 目标三形态 | workflow / agent / workgroup 全支持，对齐 startExecution 与 scheduled_tasks 的 launchKind 封套 |

Claude 判断（设计门修订后版本；与首版的差异见设计门记档）：

| # | 决策 | 内容与理由 |
|---|---|---|
| D13 | 未导入仓自动注册 | 事件仓不在 `cached_repos` 时按 payload URL 现场 clone（复用既有按-URL-启动能力）；触发器级开关 `autoRegisterRepos` 默认开 |
| D14 | bot 自触发防护（**F-1 修订**） | 触发器级 `ignoreUsernames` **只过滤 push / tag_push / mr_* / note 类事件的命中**；**pipeline 类事件不做作者过滤**（流水线失败是客观事实，bot push 引发的失败必须能继续触发修到绿循环）。防风暴 = 名单过滤 bot 的 push/MR/评论事件 + 熔断兜底 |
| D15 | GitLab 接入形态 | project / group / system hook 三形态按 `object_kind` 同构解析；system hook 原生无 Note 事件，写进运维指引 |
| D16 | 事件变量注入 | 标准变量集 + 显式映射；保存期静态校验（必填覆盖 + 变量可用集），**含模板的值跳过字面格式校验，运行期渲染后跑全量启动校验**（F-10 修订：git kind 走「分支来自事件」代包，`{{event_json}}` 按注入面截断 ≤32KiB） |
| D17 | 单仓语义 | v1 事件仓即任务仓；启动参数模板不允许 repoGroup/scratch/sourceTask 形态 |
| D18 | secret 存储 | 统一 secretBox 密封 + 全出口掩码（GitLab 明文比对本可存哈希，但未来 GitHub HMAC 需明文，为 provider 无关一致性统一密封） |
| D19 | 管理面分层（**F-9 修订**） | 端点 = admin/manager 级全局配置（权限点 `webhook-endpoints:manage`，不进 PAT/MCP 令牌面，RFC-253 先例）；触发器 = **owner 制资源，沿 `scheduled_tasks` 模型**（owner + admin/manager 旁路，无 visibility/grants）——**不走** RFC-231 第七类 ACL：fire 以 owner 身份执行，grants 写权会构成「被授权者改绑目标 → 以 owner 身份跑高权 workflow」的提权通道，定时任务当年正是为此有意弃用 ACL（`db/schema.ts:1091-1092` 注释） |
| D20 | 状态码语义（**F-6 修订**） | token 不存在 404 同形；验签失败 401 + rejected；端点禁用/无命中 200 + ignored；内部错误 500 如实报告。**自建 GitLab 对失败投递不自动重试**（仅手工 Resend + 连续失败自动禁用 hook）——恢复主路径是**平台侧 replay**，而非「让对端重投」 |
| D21 | supersede 范围 | 同流挂起中的 awaiting_human / awaiting_review 任务**也被取消**（`shared/lifecycle.ts` cancel 转移表原生支持 awaiting_*） |
| D22 | 熔断重置（**F-1 修订**） | 计数在成功 launched 后 +1；重置三来源：人工重置按钮；**命中事件的 author ∉ ignoreUsernames 时先清零再计**（对 pipeline 事件同样按此判定——bot 作者不清零、人类作者清零，「人已介入」语义与命中过滤解耦）；距上次触发超过重置窗口（默认 24h，惰性评估） |
| D23 | 快速应答 + 异步分发（**F-4 新增**） | 三段式：插 `received` 行 → 立即响应 → 异步分发（supersede 的 cancel 轮询最多 5s、auto-register clone 分钟级，同步执行必撞 GitLab 10s 超时）→ 终态更新。daemon 重启把 `processing` 行标 `failed(interrupted)`，手动 replay 恢复 |
| D24 | 同流互斥（**F-5 新增**） | per `(triggerId, streamKey)` 内存 keyed-mutex 串行化「supersede 判定 + 熔断计数 + 启动」段（仿 `gitRepoCache.ts` `withUrlLock` 先例），防两并发事件双任务存活 |

## 6. 部署与能力影响清单（呈用户逐项确认）

本 RFC 是纯新增能力，无既有能力收缩；但有五条**部署形态影响**按 CLAUDE.md 第 7 条精神逐项呈报：

1. **管理 API 暴露到内网**：webhook 要求 `bindHost` 从默认 `127.0.0.1` 改绑内网地址，整个 `/api/*` 管理面随之暴露。所有 `/api/*` 已强制 `multiAuth`（`server.ts:168`），属「有认证的暴露」；攻击面变化 = 内网侧可尝试凭据爆破 → 文档要求配合反代/防火墙，且本 RFC 不改任何既有鉴权语义。
2. **新增无认证公开路径 `/webhooks/*`**：不经 `multiAuth`，防护 = 高熵 URL token + Secret 验签 + 限流 + body 上限 + 去重。公开性经 `registerRoute publicReason` 显式声明并被启动自检锁定。
3. **daemon git 凭据的写权限要求**：修复场景要 push 回几百个仓的 MR 源分支，daemon 宿主机 git 凭据（credential helper / ssh key）必须对它们有写权限。建议专用 bot 账号 + `write_repository` PAT；该 bot username 同时填进触发器忽略名单。凭据仍由宿主机管理，平台不托管。
4. **备份迁移语义**：webhook secret 走 secretBox，备份 tarball 不含 `secret.key`（既有语义，`services/repoCredentials.ts:5-8`）——restore 到新机后 secret 全部失效，需在 UI 重新生成并重贴 GitLab。
5. **GitLab hook 自动禁用风险（F-6 新增）**：平台侧持续 401/5xx 会触发 GitLab 的 webhook auto-disable——**几百仓共用的唯一 group hook 会被整个禁掉**，全部事件静默停摆。运维指引必须写明：secret 配错要即刻在 GitLab Recent Deliveries 发现并修复、auto-disable 后的重新启用路径；平台侧 500 只在真内部错误时返回（可忽略情形一律 200）。

## 7. 验收标准（可证伪；oracle 独立于实现）

**入站与验签**
- AC-1 正确 `X-Gitlab-Token` 通过；错误/缺失 → HTTP 401 且落 `rejected` delivery 行。
- AC-2 URL token 不存在 / provider 段不匹配 → 404，与「路径不存在」同形。
- AC-3 去重：同 `X-Gitlab-Event-UUID` 二次投递（对应 GitLab 手工 Resend）→ 200、原行 bump `attempt_count`、**不产生第二次分发**；曾 `rejected` 的 UUID 修正 secret 后重投**能成功**（唯一索引排除 rejected/failed）；`event_uuid` 缺失的投递**无去重、逐条处理**（降级模式显式测试）。
- AC-4 端点禁用 → 200 + `ignored(endpoint-disabled)`；限流超阈 → 429；body 超限 → 413；payload 非法 JSON → 400。
- AC-5 三段式：HTTP 响应在分发完成前返回（响应含 deliveryId）；分发结果异步落 fires；daemon 重启后 `processing` 行被标 `failed(interrupted)` 且可 replay。

**分流**
- AC-6 匹配矩阵：repo 范围（all/prefix/exact）× 事件类型 × 分支 glob × 评论指令前缀 × 忽略名单（**含 pipeline 类不受名单过滤的正例**），逐维正反用例（纯函数测试）；触发器只匹配**同 endpoint** 的投递。
- AC-7 一个事件命中 N 个触发器 → N 个 fire、N 个任务；零命中 → delivery `ignored(no-trigger-matched)` 可在 API 查到。
- AC-8 repo 解析：http-URL 事件命中 ssh-URL 导入的缓存仓（双协议族 key）；**url_hash 桶命中后 unseal `url_enc` 做 canonical 等值复核**（8-hex 碰撞防线）；未缓存 + `autoRegisterRepos` 开 → 按 URL 启动；关 → fire `skipped(repo-unregistered)`。

**循环安全网**
- AC-9 supersede：同 `(triggerId, repo, MR)` 旧任务 running（含 awaiting_human）→ 新事件 fire 后旧任务 canceled、新任务创建、fire 行记录 `supersededTaskId`；**不同 repo 的同号 MR 互不影响**（streamKey 含 repo 维度）。
- AC-10 熔断：bot 作者（∈ 名单）的 pipeline_failed 连续 `maxConsecutiveFires`（默认 3）次 launched 后第 4 次 → `skipped-circuit-open`；人类作者（∉ 名单）同流事件重置计数；人工重置恢复；超重置窗口惰性过期。
- AC-11 同流并发：两个同流事件并发到达 → 串行化后**至多一个存活任务**（keyed-mutex），fires 链无孤儿。

**启动装配**
- AC-12 三形态各一条端到端：workflow（inputs 映射 + git kind 代包）、agent（prompt 模板插值）、workgroup。
- AC-13 触发器 owner 被禁用/对目标失去启动权 → fire `skipped-owner-invalid`，零任务产生（每次触发重建 actor 重校验）。
- AC-14 模板校验分层：保存期——引用了所选事件类型不可用的变量 / 必填 workflow 输入未覆盖 / payload 含 repoGroup/scratch/sourceTask/upload → 拒绝保存；含模板变量的输入值**跳过**字面格式校验；运行期——渲染后跑全量启动校验，失败 → fire `launch-failed(payload-invalid)`（含超长：`{{event_json}}` 截断 ≤32KiB 仍超目标字段上限的组合）。

**管理面与安全**
- AC-15 secret 全出口掩码：GET 列表/详情永不含明文；无关 PUT 不二次密封（RFC-255 P0 回归锁同款）。
- AC-16 重放：`rejected` 不可重放；重放新建 delivery 行（`replayedFromDeliveryId` 指回原行、`event_uuid` NULL 绕过去重）。
- AC-17 触发器 owner 制：非 owner 非 admin/manager → 列表不可见、详情 404 与不存在同形（沿 `scheduled_tasks` 测试形态）；**触发器保存时以保存者身份校验目标资源可见性**。
- AC-18 `/webhooks/*` 路由经 `registerRoute` + `publicReason` 注册（启动自检绿），未认证 POST 可达 handler；`webhookDispatch` 在 RFC-243 门面锁的 `CALL_FACES` 清单内（新增调用面显式登记，**该锁不自动覆盖新文件**）。
- AC-19 前端：端点设置卡片 + 触发器管理页 + 投递历史页，全部复用公共组件，中英双语。
- AC-20 deliveries 保留策略生效：超窗口行的 `body_json` 被置空/行被清理（hourly ticker）。

## 8. 开放问题（T3 实测清单）

1. GitLab payload 字段路径以**真实实例 fixture** 为准，尤其：push 顶层 `user_username` vs MR/note 的 `user{}`、note 的 `merge_request.source_branch`、**pipeline 事件的 `user` 是否 = 流水线触发者（= push 者）**——这是 D14/D22 熔断语义的前提。
2. GitLab「Resend」是否复用同一 Event-UUID；**自建 GitLab 对失败投递是否确无自动重试**；webhook auto-disable 的触发阈值与恢复方式。
3. ~~任务行触发来源落列方式~~（已定：迁移 0138 含 `tasks.webhook_trigger_id` / `tasks.webhook_fire_id` 两列，镜像 `scheduled_task_id` 链路——设计门 F-8）。
