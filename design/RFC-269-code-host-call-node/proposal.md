# RFC-269 · 代码平台调用节点（Code Host Call Node）

> **RFC-292 supersession（2026-08-12）**：本文的 code-host-only `{{trigger.<field>}}`
> 语法与“不开放给 agent prompt”的限制已被取代。当前唯一正式语法是
> `{{trigger.webhook.<field>}}`，并统一用于 agent/workgroup/review/code-host；trigger 字段不进入根 inputs。

> 产品视角。技术设计见 [design.md](./design.md)，任务分解见 [plan.md](./plan.md)。
> 状态：**Draft（2026-08-07）** —— 三件套已落档，按 CLAUDE.md 需用户批准后才进入实现。
> 前置：[RFC-257](../RFC-257-code-host-webhook-triggers/proposal.md)（webhook 入站与归一化信封）、
> [RFC-259](../RFC-259-github-webhook-adapter/proposal.md)（GitHub adapter）、
> [RFC-263](../RFC-263-webhook-event-action-params/proposal.md)（30 个事件变量）。
> **取代**：RFC-265（受控执行面 env 注入通道，已排期未落档）—— 用户 2026-08-07 拍板由本 RFC 覆盖，见 §9。

## 1. 背景

用户原话：

> 系统需要内置 gitlab 的调用节点，这个节点就单卡片就行，在系统配置里配置 base url 和 token

平台今天的代码平台集成只有**入站**半环：RFC-257 建了 webhook ingress + 触发器（几百仓共用一个
group hook，事件到达后按规则分流启动任务），RFC-259 补上 GitHub adapter，RFC-263（今天完成）按
「事件之后能跟的动作」反推把模板变量从 13 补到 30，`project_id` / `mr_iid` / `comment_thread_id` /
`comment_position_json` 全部一等化。

**出站是空的。** RFC-263 显式把「平台侧出站回写」列为非目标（N1，用户当时拍板「只给参数，回帖动作由
workflow 里的 agent 自己完成」），并在 proposal §6 逐条披露了随之而来的凭据现状：

1. **daemon 的环境变量到不了 agent** —— opencode 进程的环境是白名单转发（`SAFE_FORWARD_ENV`，
   `services/runtime/opencode/hermetic.ts`，仅 `LANG` / `LC_*` / `TERM` / `TZ` / `*_PROXY` /
   `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 共 14 项）。在 daemon 上 `export GITLAB_TOKEN=…` **不会**
   出现在 agent 的 shell 里。
2. **PATH 也是白名单** —— POSIX 上只有 `/usr/bin` + `/bin`（`util/platformExec.ts`）。`curl` 在，
   **`glab` / `gh` 不在**。
3. **网络本身是通的** —— 外层沙箱默认不限制出网（`services/sandbox/policy.ts`）。

于是当时可行的 token 路径只剩两条：remote MCP headers（唯一干净的一条），或把 token 写进触发器模板 /
提示词（token 会进数据库、任务日志与模型上下文，明确不推荐）。RFC-263 §9 因此把「扩 env 白名单让
agent 自己 `curl`」拆出去排期为 RFC-265。

**本 RFC 换一条路**：不把 token 送进 agent，而是让**平台自己发起调用**。token 只在 daemon 手里，
永不进 agent 进程、永不进模型上下文，`SAFE_FORWARD_ENV` 白名单一个字节都不动。这正是 RFC-257
design §12 预留的 `ReportSink` 那条路，本轮由用户直接拍板为 RFC-265 的替代方案。

配套的第二个事实：`docs/webhook-triggers.md` §7 已经把「事件 → 之后能跟的动作 → 用哪些变量 → 可直接
跑的 curl」写成了对照表。那张表今天是**给人照着写 prompt 用的**；本 RFC 把它变成**平台可执行的动作**。

## 2. 目标

新增一类工作流节点 **`code-host-call`**：以管理员在系统设置里配置的 base URL + token 身份，向 GitLab
或 GitHub 发起一次 API 调用。不启动任何模型进程、不启动任何子进程。

- **G1** 画布上一张卡片。拖下来后在右侧 Inspector 里选 provider（GitLab / GitHub）与动作，填该动作
  的定型表单即可，无需知道端点路径。
- **G2** 内置四类共 19 个预置动作（评论 / MR 状态 / Pipeline / 读取），**按类分组呈现**；平台各自映射
  到两家真实端点。某家不支持的动作在选中该 provider 时置灰并说明原因。
- **G3** 提供「自定义请求」逃生舱：method + 相对 path + query/body，覆盖预置清单以外的任何端点。
- **G4** 参数既能引用上游端口（`{{port_name}}`，与 agent 节点 prompt 模板同一套机制），也能直接引用
  触发事件上下文（`{{trigger.mr_iid}}` 等），后者不需要为每个参数接一条 input 连线。
- **G5** 系统设置里每家一套凭据（base URL + token），带「测试连接」按钮；token 密封存储，读路径掩码。
- **G6** 节点固定两个输出端口 `response` / `status`，可接任意下游节点（含喂给修复 agent）。
- **G7** 非 2xx 即节点失败，与脚本节点非零退出码同档；失败可按既有语义单节点重试 / 人工介入。
- **G8** 「谁能往工作流里放这个节点」是一个显式权限点，默认 admin + manager，且**任何 PAT / MCP 令牌
  都拿不到**。

## 3. 非目标

- **不做**「代码平台连接」这一类平台资源（无 owner / visibility / grants / 列表页）。每家一行全局配置，
  只有 admin 能改（D2）。
- **不做**节点级 base URL / token 覆盖。节点上填不了任何主机名 —— 这既是产品简化，也是 SSRF 与凭据
  外泄的封堵（design §8）。
- **不做**把 token 交给 agent。RFC-263 §6 的三条凭据现状**一条都不改**；`SAFE_FORWARD_ENV` 与 PATH
  白名单逐字节不动。需要 agent 自己调 API 的场景继续走 remote MCP headers。
- **不做** `{{trigger.*}}` 在 agent prompt / workgroup 目标里的解析（D10）。事件正文是任何人都能写的
  外部文本，本 RFC 不新开「外部文本 → 模型上下文」的直达通道；agent 拿事件内容继续走触发器模板 → input。
- **不做** GraphQL。两家的 GraphQL 面（GitHub 的 `resolveReviewThread` 是唯一因此落空的动作）留待后续
  RFC，本 RFC 只做 REST。
- **不做**分页遍历 / 长轮询 / 等待 pipeline 完成。一次节点 = 一次 HTTP 请求。要轮询就用 `wrapper-loop`
  套一个读取动作 + 退出条件。
- **不做** webhook 出站签名、事件回放、双向同步。
- **不做** GitLab / GitHub 以外的 provider（Gitea、Bitbucket）。

## 4. 用户拍板记录（2026-08-07，三轮反问）

| # | 问题 | 拍板 |
|---|---|---|
| Q1 | 节点形态 | **预置动作 + 自定义请求逃生舱** |
| Q2 | 凭据范围 | **全局唯一一套**（Q12 追加 GitHub 后 ⇒ **每家一套**，见 §5 注） |
| Q3 | 谁能放这个节点 | **新增权限点，默认 admin + manager** |
| Q4 | 与 RFC-265 的关系 | **覆盖掉它** |
| Q5 | 首批预置动作 | **四类全部内置，并且要分类呈现** |
| Q6 | 参数来源 | **额外支持触发上下文直取**（`{{trigger.*}}`） |
| Q7 | 非 2xx 语义 | **节点失败**（与脚本节点非零退出码一致） |
| Q8 | 输出端口 | **固定两个：`response` + `status`** |
| Q9 | 自定义请求的 method | **GET/POST/PUT/PATCH 放行，DELETE 需单独勾选** |
| Q10 | `{{trigger.*}}` 可见面 | **只给这个节点用**，不开放给 agent prompt |
| Q11 | project 定位 | **留空则默认当前任务的仓库** |
| Q12 | GitHub | **同批把 GitHub 也做了** |
| Q13 | 两家的卡片 | **一个「代码平台调用」节点，卡片里选 provider** |
| Q14 | 动作命名 | **统一动作名 + 各自映射** |
| Q15 | 测试连接按钮 | **要** |

> §5 注：Q2 与 Q12 在时序上相继 —— Q2 拍板「全局唯一一套」时范围还是 GitLab-only，Q12 追加 GitHub
> 后自然演化为「每个 provider 一行全局配置」。两家互不影响，只配一家时另一家的动作在 UI 上禁用并给出
> 「未配置」提示。这是对 Q2 的忠实延伸而非改判。

## 5. 用户故事

1. **自动回复评论流水线（本 RFC 的第一动机）**
   有人在 MR 里评论 `@aw 审一下这个改动` → RFC-257 触发器起任务 → 审计 agent 产出结论 →
   **代码平台调用节点**以「回复评论线程」动作把结论回帖到同一条 discussion。
   节点里 project / MR / 线程三个参数全部写 `{{trigger.project_id}}` / `{{trigger.mr_iid}}` /
   `{{trigger.comment_thread_id}}`，正文写 `{{audit_result}}`（上游端口）。**零连线**。
2. **审计结论挂成流水线状态**
   同一条链的末端再接一个节点，动作「设 commit status」，state 由上游脚本节点算出（有 P0 → failed），
   `target_url` 指向平台的任务详情页。MR 页面上直接能看到审计红绿。
3. **拉失败 job 日志喂给修复 agent**
   `pipeline_failed` 事件触发 → 节点 A「列 job」（scope=failed）→ 脚本节点挑出第一个失败 job id →
   节点 B「拉 job 日志」→ 日志作为 `response` 端口喂进修复 agent 的 prompt → 修好后 agent 提交推送。
4. **手动启动的审计任务也能回帖**
   不经 webhook：用户在 `/tasks/new` 选仓库 + 审计工作流启动，节点的 project 留空 ⇒ 自动取当前任务
   仓库，`mr_iid` 从 input 节点填。`{{trigger.*}}` 在这类任务里恒为空，所以这条工作流本就不该引用它；
   若误用，运行期会明确报「该任务不是由 webhook 触发，`{{trigger.*}}` 无值」，而不是静默发出一个
   定位参数为空的请求。

## 6. 新增能力面的代价（逐项呈报）

本 RFC **不关闭任何既有能力**，CLAUDE.md 第 7 条的「能力收缩型 RFC」门槛不触发。但它是平台第一次
**主动持有并使用代码平台的写凭据**，代价必须逐项摆上台面：

- **C1 平台首次托管代码平台写凭据。** 此前平台持有的凭据只有两类：git clone 用的仓库 URL 凭据
  （RFC-204，密封在 `cached_repos.url_enc`）与 webhook 入站验签 secret（RFC-257，`secret_enc`）。
  两者都**不能主动写**任何代码平台对象。本 RFC 的 token 能评论、能改 MR、能 merge、能触发流水线 ——
  能力上限完全由管理员发给它的 token 决定。**建议部署侧发一个专用 bot 账号的 token 并按最小权限
  勾选 scope**（GitLab：`api` 或更细的 project access token；GitHub：fine-grained PAT 限定仓库与
  Pull requests / Commit statuses 权限）。
- **C2 有权限的工作流作者 = 该 token 的使用者。** 任何持 `code-host-calls:author` 的用户（默认
  admin + manager）都能在工作流里以该 token 身份对 token 可及的**任意仓库**发起写操作，不受平台内
  资源 ACL 约束（平台不知道也无法约束 GitLab 侧的权限）。这与 RFC-253 把 `scripts:author` 定为
  「可造成宿主执行」的能力点是同一档判断，故沿用同一姿势：系统域点、永不上令牌。
- **C3 外部数据进入下游端口。** `response` 端口的内容会流向下游节点，包括 agent 的 prompt。GitLab /
  GitHub 的响应里包含**外部用户写的文本**（评论正文、MR 标题、job 日志）。这不是本 RFC 新开的面
  （RFC-263 的 `{{comment_text}}` / `{{event_json}}` 已经能把同类文本注入 prompt），但面变宽了：
  从「触发事件那一条」变成「token 能读到的任意对象」。缓解 = 端口值继续走 RFC-200 的注入边界围栏
  （`promptFencing`），且响应体有硬上限（design §7.4）。
- **C4 事件参数落库。** `{{trigger.*}}` 要求把归一化事件信封的**变量投影**快照进任务行（design §6）。
  这让评论正文、MR 标题、作者名等外部数据的保留期从 webhook 投递表的 90 天 GC 变成**与任务同寿**。
  投影只含 RFC-263 变量表的 29 项，**不含 `event_json` 原文**（那是 32 KiB 截断的完整 payload，
  没有实际用例还会显著放大保留面）。
- **C5 daemon 主动出站到管理员指定主机。** 此前 daemon 的出站只有 git clone / MCP probe / 模型 API。
  现在多了一条「按工作流定义发起的 HTTP 请求」。封堵：主机名**只能**来自管理员配置的 base URL，
  节点侧填不了绝对 URL；跨主机重定向默认不跟随（唯一例外见 design §7.5）。
- **C6 RFC-265 不再排期。** 「daemon 上配环境变量让 agent 的 `curl` 直接能用」这件事本 RFC 不做，
  也不再计划做（§9）。需要 agent 自主调 API 的场景仍是 remote MCP headers。这是能力**未获得**，
  不是既有能力被关闭 —— RFC-265 从未实现。

> **RFC-270 改判（2026-08-08）**：初版让无 `code-host-calls:author` 的用户「整块只读但可见」
> （与 RFC-253 脚本面板同款）。用户实报此为越权，故改为**整块不可见**：服务端按权限遮蔽
> `params` / `request` 的值，Inspector 换成占位，保存时从库里回填。判据与本 RFC 的 author 门
> 读的是同一个权限点，不新增点。

## 7. 验收标准

**节点与执行**

- **AC-1** 从 palette 拖入一个代码平台调用节点，选 GitLab + 「回复评论线程」，填三个定位参数与正文，
  保存工作流通过校验；运行后 GitLab 上出现该条回复。
- **AC-2** 同一个节点把 provider 改成 GitHub，动作保持不变，参数表单相应变化（thread 参数的说明从
  `discussion_id` 变成线程根评论 id），运行后 GitHub 上出现回复。
- **AC-3** 选中 GitHub 时「resolve 线程」动作置灰，hover 说明「GitHub 仅 GraphQL 支持，REST 拿不到
  线程 id」。选回 GitLab 后可用。
- **AC-4** 动作下拉按四类分组呈现（评论 / MR 状态 / Pipeline / 读取 / 自定义）。
- **AC-5** 自定义请求里 method 下拉默认只有 GET/POST/PUT/PATCH；勾选「允许破坏性方法」后 DELETE 出现。
- **AC-6** GitLab 返回 403 时节点状态为 `failed`，错误信息含状态码与响应体摘要，**不含 token**；
  `response` / `status` 端口不产生值。
- **AC-7** 单节点重试该失败节点可以重新发起请求；下游按既有级联语义处理。
- **AC-8** 成功时 `response` 端口是响应体原文、`status` 端口是三位状态码字符串；两个端口都可以不连。
- **AC-9** 响应体超过上限时 `response` 被截断且尾部带显式截断标记，节点仍算成功。

**参数与模板**

- **AC-10** 节点参数里 `{{port_name}}` 解析为上游端口值，语义与 agent 节点 prompt 模板一致。
- **AC-11** webhook 触发的任务里 `{{trigger.mr_iid}}` 等 29 个变量可解析；手动启动的任务里它们为空串。
- **AC-12** 保存期校验**变量名合法性**：拼写错的端口名、不在触发上下文变量表里的 `{{trigger.x}}`
  → 422 并指出具体字段。**不**校验「该工作流是否真有 webhook 触发器」—— 触发器是独立资源、可随后
  创建，那样校验会在「先建工作流再建触发器」这个自然顺序上产生假红（design D24）；运行期触发上下文
  为空时节点失败并明确说明该任务不是 webhook 触发的。
- **AC-13** project 参数留空 + 单仓任务 ⇒ 自动取任务仓库；仓库主机与配置的 base URL 主机不一致 ⇒
  节点失败并明确报「任务仓库不属于所配置的 GitLab 实例」，不猜、不打。
- **AC-14** project 留空 + 多仓任务（RFC-066）⇒ **运行期**失败并要求显式填写。（实现期勘误：初稿
  写「保存期即拒绝」，但仓库数量是**启动参数**而不是工作流定义的属性，保存期无从判定。）

**凭据与设置**

- **AC-15** 设置页新增「代码平台」分区，GitLab / GitHub 各一组 base URL + token + 测试连接。
- **AC-16** 保存后重新加载，token 字段显示掩码（尾 4 位提示），不回传明文；非 admin 无法进入该分区。
- **AC-17** 「测试连接」成功时回显登录名；401 / DNS 失败 / base URL 写错三种情况给出可区分的原因。
- **AC-18** token 不出现在：任何 GET 响应、任务日志、节点错误信息、YAML 导出、intent dump、诊断输出。
- **AC-19** 未配置某家凭据时，该 provider 在节点 Inspector 里禁用并提示去设置页配置；已存在的工作流
  保存期不因此变红（凭据是运行期依赖，不是定义期依赖），运行期失败并给出明确原因。

**权限**

- **AC-20** `user` 角色打开含该节点的工作流可读、可运行，但改不了节点参数（保存被拒），也拖不出新节点。
- **AC-21** 一枚勾满了所有矩阵权限的 PAT 依然拿不到 `code-host-calls:author`，用它调 PUT
  `/api/workflows/:id` 写入该类节点被拒。
- **AC-22** 复制工作流、YAML 导入、intent 生成四条入口的权限门与 RFC-253 `scripts:author` 同构。

**安全**

- **AC-23** 自定义请求的 path 填绝对 URL（`https://evil.example/x`）或含 `..` 逃逸 ⇒ 保存期拒绝。
- **AC-24** 目标返回 302 到另一主机时默认不跟随，节点失败并报明重定向被拒；仅「拉 job 日志」动作在
  GitHub 上允许跟随一次且**剥掉 `Authorization` 头**（design §7.5）。
- **AC-25** 节点执行不 spawn 任何子进程，不进入 containment 准入面（源码层锁）。

## 8. 待实证清单（fixtures）

沿 RFC-257 / 259 / 263 惯例，以下按官方文档形态实现，真实实例到手后以实测为准回改：

1. GitLab `POST /projects/:id/statuses/:sha` 的 `state` 取值在部署侧版本上的完整枚举（`canceled`
   是否接受）。
2. GitLab `approve` 端点在 **Free 版**是否存在（该动作可能仅 Premium 可用 ⇒ 需在 UI 上注明而非静默
   404）。
3. GitLab `GET /projects/:id/merge_requests/:iid/diffs` 在部署侧版本上的分页默认值与 `unidiff` 参数。
4. GitHub `POST /repos/{o}/{r}/actions/runs/{run_id}/rerun-failed-jobs` 与 `/rerun` 的选择（本 RFC
   默认前者，因为「修到绿」循环只想重跑失败的）。
5. GitHub Actions job 日志 302 的目标主机集合与签名 URL 有效期（文档称 1 分钟）。
6. GHES 的 `api_base_url` 形态（`https://host/api/v3`）与 `/user` 探活的一致性。
7. GitLab 子路径部署（`https://host/gitlab/`）下 base URL 的正确写法与 `/user` 探活。

## 9. 与 RFC-265 的处置

用户 2026-08-07 拍板：本 RFC **覆盖** RFC-265。落档动作：

- RFC-265 **不再排期**，编号保留为空缺（不复用，避免与 RFC-263 §9 / `docs/webhook-triggers.md` §7.5
  / `design/plan.md` 里既有的三处指代冲突）。
- 上述三处对 RFC-265 的引用统一改写为「由 RFC-269 以平台侧出站取代」，并说明 token 不再计划进入
  agent 的执行环境。
- `docs/webhook-triggers.md` §7.5「凭据：token 怎么到 agent 手里」相应改写：三条平台现状保持不变
  （它们仍然是事实），但结论从「等 RFC-265」改为「回帖 / 调接口走代码平台调用节点；agent 自主调 API
  仍走 remote MCP headers」。

## 10. 后续演进（非本 RFC）

- GraphQL 面（GitHub resolve 线程、GitLab 的 GraphQL-only 端点）。
- 分页遍历与「等待 pipeline 完成」的原生动作（今天用 `wrapper-loop` + 读取动作组合表达）。
- 更多 provider（Gitea / Bitbucket）—— 动作注册表已是 per-provider 映射，新增一家是加一列不是改架构。
- 按用户身份而非系统身份调用（OAuth 代表用户操作），需要先有 per-user 的代码平台身份绑定。
