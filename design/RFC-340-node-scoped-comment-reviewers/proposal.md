# RFC-340 节点级意见型评审人授权与配置

- 状态：In Progress（2026-08-28；候选实现与定向功能验证已完成，等待并发 RFC-338 / RFC-339 发布后同步、全门与 exact-SHA CI）
- current-source：`5128efad55ba55fc95205c6dfd9b148916a181d1`
- 关联：RFC-005（人工评审门）、RFC-009（意见编辑）、RFC-013 / RFC-142（版本与轮次历史）、
  RFC-036（已移除的单人节点指派）、RFC-079 / RFC-129（多文档评审）、RFC-099（任务成员作答权）、
  RFC-285（意见作者边界）、RFC-294（`collaboration` 目标上下文）、RFC-324（observer）、
  RFC-326（评审 REST / MCP 能力面）、RFC-333（人工门原子决策）
- 边界：只做用户明确要求的功能与相应功能测试；不新增安全策略、权限体系重构或无关限制

## 1. 用户诉求与结论

当前任务只有 owner / collaborator / observer 三档任务关系。用户需要增加一种“评审人”参与方式：可以按某个
`review` 节点配置一组人员，让这些人只看到该节点的评审文档和全部评审意见，并提交意见；评审人不能通过、重新生成、
退回，也不能替文档做采纳 / 不采纳选择。

用户进一步确认：

> 评审人，不能通过、重新生成、退回，只能加评审意见。

> 评审人只访问被指派节点；只能新增及维护自己的意见。任务 owner / collaborator 负责收口。

这里的“评审人”因此不是一个会获得整任务可见性的 `task_collaborators` 新档位，而是
**`task + frozen review node` 作用域内的意见角色**。如果把它直接塞进任务成员表，当前 `canViewTask` 会同步放开任务详情、
日志、节点图和 diff，违反已经确认的节点级可见性。

## 2. current-source 事实

| 面        | 当前事实                                                                                        | 本 RFC 要补的能力                                                     |
| --------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 任务成员  | `TaskCollaboratorRoleSchema = owner \| collaborator \| observer`；observer 可看整任务但不能操作 | 不改变三档任务成员；另建节点级 reviewer 集合                          |
| 评审读    | `ensureReviewVisible` 只继承 `canViewTask`，无节点指派读面                                      | 任务可见者维持原范围；额外允许 assigned reviewer 只读被指派节点       |
| 评审写    | decision / selection / comment 共用 `ensureReviewMember`                                        | 拆成 comment、selection、decision 三个能力门                          |
| 意见作者  | 服务层已允许 owner / admin 改任意意见，普通成员只能改自己的                                     | reviewer 复用 own-only 规则；前端按能力和作者隐藏无效按钮             |
| 详情 wire | `ReviewDetail` 没有 actor-specific capability                                                   | 返回明确的 access scope 与能力集合                                    |
| 多文档    | 当前 reviewer 页面同时提供逐篇采纳与整轮 approve / iterate / reject                             | assigned reviewer 只看全部篇目、正文和意见；不显示任何取舍 / 决策入口 |
| 配置      | RFC-099 已删除 RFC-036 的 `node_assignments` 与 assignments API                                 | 新建支持“每节点多人集合”的独立配置面，不复活旧单人决策模型            |
| 实时更新  | 评审页订阅 task WS；该订阅以整任务可见性为前提                                                  | 节点级 reviewer 不订阅 task WS，沿用评审查询轮询刷新                  |

RFC-036 的旧模型每节点只有一个 reviewer，而且 reviewer 可以做最终决策；RFC-099 又把它整体删除并改为任务成员均可作答。
本 RFC 不是把旧表原样恢复，而是新增一个不同合同：**多人、意见型、节点可见、无决策权**。

## 3. 已确认产品裁决

### D1 — reviewer 是节点级角色，不是任务成员档位

reviewer 指派键为 `(taskId, reviewNodeId, userId)`。单纯被指派不会写入 `task_collaborators`，也不会获得任务详情、日志、
变更 diff、其它节点或任务 WS 的访问权。

### D2 — 一个节点是一组 reviewer

任务 owner / admin 可为每个 frozen `review` 节点配置零到多名 active user。集合为空合法；owner / collaborator 仍可完成评审，
所以空集合不会阻塞工作流。

### D3 — 指派覆盖该节点的全部轮次

指派按 frozen workflow node id 生效，覆盖该任务中该节点当前及未来的 iteration、round、multi-document member 和 wrapper / shard
产生的 node run。被指派人可查看该节点已经留存的历史版本、历史轮次和其中全部意见。

### D4 — reviewer 只访问被指派节点

reviewer 可从评审收件箱进入被指派节点；页面仅展示评审所需的最小任务 / 工作流 / 节点标签。任务名不得链接到其无权访问的
任务详情，也不能借 reviewer 指派列出同任务的其它评审节点。

### D5 — reviewer 可以新增意见

当前轮次仍为 pending 时，reviewer 可在任一篇文档上新增带锚点的评审意见。现有 REST 与 RFC-326 MCP
`add_review_comment` 都遵守同一节点指派判据。

### D6 — reviewer 只能维护自己的意见

pending 期间 reviewer 可以编辑自己的意见，不能删除意见，也不能编辑他人意见。历史或已决轮次继续只读。owner 和
`resource-acl:bypass` 操作者现有的任意意见管理能力不收缩；普通 collaborator 现有 own-only 行为不变。

### D7 — reviewer 没有文档取舍权

多文档评审中的 `accepted / not_accepted` 是收口决定的一部分。assigned reviewer 可以查看每篇文档和当前取舍状态，但不能写
selection，页面也不显示逐篇采纳 / 不采纳控件及 Q / W 快捷键。

### D8 — reviewer 没有最终决策权

assigned reviewer 不能 approve、iterate（重新生成）或 reject（退回），也不能通过 decision batch 间接提交 selection / comments。
最终决策仍由 task owner / collaborator / admin 按现有合同完成；RFC-333 `CollaborationDecisionTx` 不因本 RFC 改语义。

### D9 — 既有任务关系能力不回退

- owner / collaborator：继续看该任务全部评审；继续新增意见、做文档取舍和最终决策；
- observer：继续看该任务全部评审，保持全只读；
- admin / `tasks:read:all` / `resource-acl:bypass`：保持现有读写旁路；
- 同一用户兼具任务关系与 reviewer 指派时，能力取并集，既有较强任务关系不被降级。

### D10 — 配置是任务内独立页面

任务详情页为可管理者提供“评审人配置”入口，打开专用路由 `/tasks/:taskId/reviewers`。页面逐行列出 frozen snapshot 中的
`review` 节点，使用共享多选 `UserPicker` 配置 reviewer 集合；一次保存完整集合。picker 可选择任何 active user；如果某人已经是
owner / collaborator / observer，页面同时显示其任务关系，并明确提示能力按并集计算，不会因为被列为 reviewer 而降级。

### D11 — 只有 owner / admin 管理配置

配置 GET / PUT 复用任务成员面板的 `canManage` 口径：task owner 或具有现有管理旁路的 admin 可读写；collaborator、observer、
assigned reviewer 均不能管理指派。

### D12 — 移除指派只撤销后续能力

从集合移除后，该用户下一次 list / detail / comment 请求即不再以 reviewer 身份通过；已写意见和作者快照永久保留。再次指派后，
重新获得该节点及其留存历史的访问权。

### D13 — reviewer 有独立的意见署名

reviewer 新增意见时 `authorRole = 'reviewer'`。只扩 review comment 的署名 union，不把 `'reviewer'` 加进全局
`TaskActorRoleSchema`，因为 reviewer 不能成为任务决策者、clarify 回答者或任务事件操作者。

### D14 — 不新增 assignment MCP

本轮配置面只提供任务 REST + Web UI。现有 review 查询 / 加意见 MCP 会自然遵守新指派；不新增由代理批量改 reviewer 集合的 MCP
工具，避免扩大用户未要求的配置面。

## 4. 能力矩阵

| actor 与目标节点的关系 |  看评审 / 历史 | 新增意见 | 改自己的意见 | 删自己的意见 | 改 / 删他人意见 | 逐篇取舍 | approve / iterate / reject | 配置 reviewer |
| ---------------------- | -------------: | -------: | -----------: | -----------: | --------------: | -------: | -------------------------: | ------------: |
| task owner             |       ✓ 全任务 |        ✓ |            ✓ |            ✓ |               ✓ |        ✓ |                          ✓ |             ✓ |
| task collaborator      |       ✓ 全任务 |        ✓ |            ✓ |            ✓ |               — |        ✓ |                          ✓ |             — |
| task observer          |       ✓ 全任务 |        — |            — |            — |               — |        — |                          — |             — |
| assigned reviewer      | ✓ 仅被指派节点 |        ✓ |            ✓ |            — |               — |        — |                          — |             — |
| admin / 既有旁路       |         ✓ 全部 |        ✓ |            ✓ |            ✓ |               ✓ |        ✓ |                          ✓ |             ✓ |
| 无关系用户             |              — |        — |            — |            — |               — |        — |                          — |             — |

当一个用户命中多行时取能力并集。例如 observer 同时是节点 reviewer：整任务只读仍存在，但只有被指派节点多出“新增 / 维护自己
意见”的能力。

## 5. 用户旅程

### US-1 — owner 配置多人评审

Alice 打开任务详情，进入“评审人配置”。页面列出“方案评审”“实现评审”两个 frozen review 节点。Alice 给方案评审选择 Bob、
Carol，给实现评审只选择 Dave，保存后返回成功状态；重新进入页面可看到持久集合。

### US-2 — reviewer 只看指定节点并提交意见

Bob 在 `/reviews` 收件箱只看到自己被指派的“方案评审”。打开后能切换该节点所有文档与历史轮次、看到 Alice 和 Carol 的全部
意见，并新增 / 编辑自己的意见；任务标题是文本而不是 task detail 链接。

### US-3 — reviewer 不能收口

Bob 的页面不出现逐篇采纳、通过、重新生成、退回及对应快捷键。直接调用 selection 或 decision API 得到现有权限型错误；
`POST decision` 携带 comments 也不能成为绕过路径。

### US-4 — owner / collaborator 完成决策

Carol 写完意见后，任务 collaborator Erin 打开同一节点，能看到所有意见、完成逐篇取舍并 approve / iterate / reject。现有续跑、
重生、退回和原子 decision 行为不变。

### US-5 — 移除 reviewer

Alice 从方案评审移除 Bob。Bob 刷新收件箱后该节点消失，旧直链不再可读 / 写，但他此前的意见仍显示给该节点的其他可见者，
署名仍是 Bob / reviewer。

## 6. 目标

1. 提供每任务、每 frozen review 节点的 reviewer 集合配置和独立 UI。
2. 为 reviewer 提供精确到节点的文档 / 历史 / 全部意见可见性。
3. 让 reviewer 只能新增及维护自己的意见，彻底隔离 selection 与 final decision。
4. 让 REST、MCP、reviews inbox / badge、single-doc / multi-doc / historical 页面遵守同一能力投影。
5. 保持 owner / collaborator / observer / admin 的现有功能不变。
6. 按 RFC-294 把新授权策略和 assignment owner 放在 `collaboration`，不继续把逻辑堆进 route / scheduler。

## 7. 非目标

- 不做 quorum、多签、投票、评审完成确认、必评人数或“等所有 reviewer 提交后才允许决策”。
- 不给 reviewer task detail、日志、节点图、diff、clarify 或任务操作能力。
- 不改变 review node 定义格式，也不把人员固化到 workflow template。
- 不改变 approve / iterate / reject、逐篇 selection、续跑或 RFC-333 原子决策语义。
- 不新增通知、邮件、@mention、截止时间、催办或 reviewer 在线状态。
- 不新增 reviewer assignment MCP、公共分享链接或外部匿名评审。
- 不顺手重构全站 ACL、WS 或 task membership。

## 8. 验收标准

- **AC-1**：每个 task 的 frozen review node 可持久化 0..N 个 reviewer；重复 user / node、非 review node、未知 / disabled user
  被明确拒绝，保存为一次完整替换。
- **AC-2**：单纯 reviewer 指派不产生 `task_collaborators` 行；task detail、logs、diff、其它节点与 task WS 仍不可用。
- **AC-3**：reviews list、pending count、detail、versions、version detail、rounds 对 assigned reviewer 只返回被指派节点；任务可见者
  的既有结果不缩小。
- **AC-4**：指派覆盖同一 frozen review node 的所有 iteration、round、multi-doc member 与 shard / wrapper run；历史内容和全部意见
  可见。
- **AC-5**：pending round 上 assigned reviewer 可用 REST 与 MCP 新增意见；意见作者和 review-specific role 快照正确。
- **AC-6**：reviewer 只能 PATCH 自己的 pending 意见，DELETE 任意意见及 PATCH 他人意见都失败；历史意见、已决意见均不可改。
  owner / admin 既有 manage-any 行为和 collaborator own-only edit / delete 行为不变。
- **AC-7**：reviewer 调 selection、approve、iterate、reject 或带 comments 的 decision batch 均失败且无持久化效果；这些路径仍只认
  现有 task acting membership / admin。
- **AC-8**：ReviewDetail 明确返回 access scope 与 actor capabilities；单文档和多文档 UI 不渲染无权操作，键盘快捷键也不注册。
- **AC-9**：reviewer 页面不链接任务详情，不请求 task detail / node runs / diff，也不建立 task WS；轮询能看到其他人的新意见。
- **AC-10**：独立 reviewer 配置页在 1280px 和 390px 可用，节点标题 / id 清晰，支持键盘完成多选、删除、保存、失败重试和空节点态；
  已有任务成员显示关系与“能力取并集”提示。
- **AC-11**：只有 owner / admin 能 GET / PUT reviewer 配置；collaborator、observer、reviewer 不能配置。
- **AC-12**：移除 assignment 后 list / read / write 均立即收回 reviewer 能力，历史意见不删除；再次指派恢复历史可见性。
- **AC-13**：owner / collaborator / observer / admin 的 current-source capability matrix 有回归锁，兼具角色时能力按并集计算。
- **AC-14**：assignment 与 review access policy 由 `modules/collaboration` 拥有；route 只做 transport，task-execution 只提供 task / node
  identity，不新增 scheduler 授权分支。
- **AC-15**：backend/shared/frontend targeted tests、浏览器 reviewer 旅程和 exact-SHA hosted CI 全绿后才可置 Done。本地 Browser Use
  因 URL policy 拒绝 localhost 且明确禁止替代浏览器绕行，因此本地先以 Testing Library 真实 DOM / keyboard / click 断言闭合；浏览器证据
  由 hosted UI / E2E gate 承担。

## 9. 批准门

用户已于 2026-08-28 明确批准实现，并授权实现完成后提交推送；production 按 `plan.md` T2～T11 推进。

## 10. 当前候选事实（2026-08-28）

- migration / shared contracts、`collaboration` policy + ports、task-execution 窄 read models、配置 REST、review REST / MCP 共路由授权、
  独立配置页以及 single / multi-doc capability UI 均已实现；
- reviewer 的 HTTP 旅程已锁定：只列 assigned node、能读本人和他人的全部意见、可新增并以 `authorRole=reviewer` 署名、只能改自己，
  不能删除 / selection / decision；
- 配置 HTTP 已锁定 owner-only full replace、不会产生 `task_collaborators` 行、task 删除时 assignment cascade；移除 / 重加及历史 run
  访问均有回归；
- shared 4、backend reviewer/comment 20（77 expects）、frontend review/config 52、RFC-326 MCP 15（145 expects）项定向测试通过；
  migration check、targeted lint 与三端类型检查通过。当前共享树继续被 RFC-338 / RFC-339 修改，本 RFC 不改动或代交这些并发产物；
- `origin/main` 仍为 `5128efad55ba55fc95205c6dfd9b148916a181d1`，未进入 publication critical section，未暂存、未提交、未推送。
