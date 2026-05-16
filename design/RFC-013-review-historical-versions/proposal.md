# RFC-013 评审页面历史版本浏览

> 产品视角。技术细节见 [design.md](./design.md)，任务拆分见 [plan.md](./plan.md)。

## 背景

RFC-005 落地的人工评审节点（`review` kind）通过"reject / iterate / approve"三决策驱动文档迭代。每被 reject 或 iterate 一次，`doc_versions` 表新增一行（versionIndex 递增），`review_comments` 表里每条评论携带 `docVersionId` 指向当时被评的那一版。

但当前 `/reviews` 列表页表格每个 review 行只暴露**当前那一版**的入口：

- 列表表"Version"列只显示 `v{currentVersionIndex}`；
- 行尾 "Open" 按钮跳 `/reviews/$nodeRunId` 详情页，详情页固定渲染 `currentVersion`；
- 详情页里有个"Diff: prior version"toggle，但它只能对比"上一版 → 当前版"两版，**无法查看 v1 / v(N-2) 这些更早的历史版**；
- 评论侧栏永远只显示**当前版**关联的评论，历史版的评审意见在 UI 上完全看不到。

后端其实已经有完整的 endpoint：

- `GET /api/reviews/:nodeRunId/versions` — 列出 doc_versions 全部行；
- `GET /api/reviews/:nodeRunId/versions/:vid` — 取某一历史版的 markdown body + meta。

只是前端没用到。`review_comments` 也天然按 `docVersionId` 切片，只是当前查询固定 `docVersionId = currentVersion.id`。

## 目标

让评审人能在 `/reviews` 列表页直接**看到并打开任一历史版本文档**，并在历史版本视图里**完整看到那一版的所有评审意见**（保持评审时的原位锚定显示）。

为了避免误操作历史档导致状态错乱（决策只对当前版有意义），**打开历史版本时不允许执行任何决策动作（approve / reject / iterate）也不允许新增 / 编辑 / 删除评论**。

## 非目标

- 不为历史版本提供 diff / 跨版对比视图（用户已确认去掉历史视图上的 diff toggle）。当前版详情页保留原有 prior-version diff toggle 不变。
- 不改任何后端 `doc_versions` / `review_comments` schema；不新增任何 API endpoint。仅在前端复用已有 endpoint。
- 不引入 "fork from historical version" / "restore historical version" 这类编辑能力。
- 不动 review 节点的状态机（awaiting_review / decisions / iterate cascade 等行为均保持 RFC-005 现状）。

## 用户故事

### US-1 列表页看到所有历史版本

> 作为评审人，我打开 `/reviews` 列表页时希望直接知道某个评审条目有几版历史；不用先点进详情页才知道这个节点被反复 reject / iterate 过几次。

**验收**：

- 列表每一行末尾新增"展开"按钮（图标 ▸ / ▾），点击展开内联子区。
- 子区按 `versionIndex` 升序列出该 node-run 的全部 doc_versions：每行显示 `v{N}` + 决策状态 chip（approved / rejected / iterated / pending）+ 评论数 + "Open" 按钮。
- 当前版（`versionIndex === currentVersionIndex`）在子区里显式标记 `(current)`，"Open" 按钮跳现有详情页（无 query 参数，行为不变）。
- 历史版（`versionIndex < currentVersionIndex`）的 "Open" 跳 `/reviews/$nodeRunId?version=<vid>`。
- 展开/折叠状态在页面会话期内保留（同一 `/reviews` 页面切 filter tab 不重置；离开路由可重置，不持久化到 localStorage）。
- 列表整体首次加载不预拉 versions（按需）；点击"展开"那一刻才发 `/api/reviews/:nodeRunId/versions` 请求，加载中显示骨架行；加载失败显示行内 error chip + 重试按钮。
- 一个 review 只有 1 版（即从未被 reject/iterate 过）时，展开按钮可见但子区只展示 v1 + "(current)" 一行，体验自洽，不做"无历史则隐藏展开"的条件渲染（避免列表抖动）。

### US-2 历史版本视图

> 作为评审人，我点击"v2 Open"后希望看到当时 v2 的 markdown 正文，以及当时贴在 v2 上的所有评审意见，按它们原本的锚点高亮在正文里；但我**不能**对历史档执行任何决策或评论编辑。

**验收**：

- 路由：`/reviews/$nodeRunId?version=<vid>`。`vid` 是该 node-run 名下任一 doc_version 的 ULID。
- `vid` 缺失 / 非法 / 不属于此 node-run 时，回落到默认行为（显示 currentVersion，等价无 query 参数路径）+ 顶部 toast 提示 "Unknown version"。
- 页头加只读 banner（黄底文字）："Read-only · viewing version v{N} ({decision}) · 决策与评论编辑已禁用 · [回到当前版]"。点 "回到当前版" 跳无 query 的同路由。
- markdown 正文渲染历史版的 body；评论侧栏列出当时 `docVersionId = vid` 的所有评论；正文中的 anchor 高亮 / scroll-spy / 点击跳锚行为与当前版完全一致（复用同一份渲染逻辑）。
- 决策三按钮（Approve / Reject / Iterate）在历史版本视图**完全隐藏**（不是 disabled，避免 RFC-009 / RFC-011 落地的快捷键 J/K/A 误触发；快捷键在历史版本视图同步无效）。
- 评论侧栏的"添加评论" / 单条评论的"编辑" / "删除"按钮 / "复制" 按钮全部隐藏（"复制"不构成写操作，但为风格一致也一并隐藏；如用户后续抱怨可单独放开）。
- 选词浮层（select-to-comment popover）在历史版本视图禁用（不弹）。
- Diff toggle 在历史版本视图整体不渲染（不是 disabled）。
- 历史版本视图的所有写 mutation（如有任何漏网走到的快捷键路径）在 UI 层就拦截，不依赖后端 403；后端 API 不做改动，因为如果真发到后端，已有的 `currentVersionId !== submitted docVersionId` 业务校验会拒绝，行为安全。

### US-3 历史版本上的评论保真度

> 作为评审人，看 v2 历史档时，每条评论的原始锚点 / 行号 / 作者 / 时间戳都应该和当时评审完全一致；不应该因为 v3 又改了正文导致锚点错位。

**验收**：

- 评论的 anchor 用它原本 `body` / `selectionContext` 落在 v2 body 上；不调 RFC-005 那套"在新版上重定位 anchor"的策略（那只在 reject 触发新版生成时跑一次，跑完结果就持久化进 anchor 字段了，历史版渲染直接用即可）。
- 评论的回显 metadata（作者、createdAt / updatedAt）与当时入库一致。

## 边界与风险

- **行为发散点小**：表格只加一个展开列；详情页只加一个 `version` query 参数 + 一层只读包裹。绝大多数渲染代码（markdown / 评论侧栏 / anchor 锚定）原样复用。
- **版本数量爆炸的极端 case**：若某 review 被 reject 50 次，展开后子区会很长。v1 不做分页 / 折叠，按 versionIndex 顺序铺平显示。实测中评审节点重复 iterate 超 10 次极少，足够用。
- **缓存键冲突**：详情页现有 `useQuery(['reviews', 'detail', nodeRunId])` 拉的是 currentVersion；历史版本视图改用 `['reviews', 'version-body', nodeRunId, vid]` 已有的 queryKey（详情页 prior-version diff toggle 已经在用），缓存命中天然友好。`versions` 列表（`['reviews', 'versions', nodeRunId]`）在列表页展开和详情页加载之间共享缓存，省一次重复请求。
- **与 RFC-011 关系**：RFC-011 把 review reject/iterate 改成"mint 新 node_run 行"。但 doc_versions 表仍然按 `reviewNodeRunId`（最早那一行）聚合所有历史版，`/api/reviews/:nodeRunId/versions` endpoint 对入参 `nodeRunId` 已经做了"反查链头"处理（RFC-005 B-T8 落地时已实现），所以列表行无论传 chain 上哪一个 node_run id，展开都能拿到完整 v1..vN。这点已经在 backend 是正确的，前端只是消费。
- **i18n**：新增中英各约 8 条 key（reviews.expand / collapse / historicalVersionBanner / backToCurrent / loadVersionsFailed / retry / commentCountChip / versionRowCurrent）。
