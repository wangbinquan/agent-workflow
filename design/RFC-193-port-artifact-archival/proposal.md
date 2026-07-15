# RFC-193 — path 端口产物归档制（archive-at-emit）

- 状态：Draft
- 日期：2026-07-15
- 发起：用户报告线上断链（wrapper 内 review 节点读不到上游 agent 写的文件）+「怎么根治，以后肯定还会出现很多，包括其他 agent 读这个 agent 的输出」
- 关联：RFC-130（节点级隔离 worktree）、RFC-005（review 节点）、RFC-049（端口 kind 校验）、RFC-079/081（多文档 review）、RFC-188（隔离执行原语）

## 1. 背景

RFC-130 之后每个 agent 节点在自己的隔离 worktree（iso）里运行，成功后 delta 三方合并回「所在
scope 的 canonical worktree」；git/loop wrapper 又各有自己的 wrapper-canonical，wrapper 整体完成
才把总 delta 合并回任务主 worktree。于是 **path 类端口（`path<md>` / `path<ext>` /
`list<path<md>>` / 别名 `markdown_file`）入库的那个路径字符串成了「悬挂指针」**——它能否兑现为
文件内容，取决于每个消费方自己重建三个隐含维度：

| 维度 | 不稳定来源 |
|---|---|
| **根**（相对谁解析） | 任务主 worktree / wrapper-canonical / 节点自己的 iso / 多 repo 时 repos[0] vs 容器根——每个消费方各拼各的 |
| **时刻**（何时读） | 产出时文件在节点 iso；merge-back 后在 scope canonical；wrapper 完成后才到任务主 worktree；任务结束后 worktree 可被 GC |
| **可见性**（能否随 merge-back 走） | 快照用 `git add -A`（遵守 .gitignore），被 ignore 的文件进不了 merge-back；绝对路径指向已销毁的 iso |

### 已确认的五类断链（2026-07-15 排查）

1. **review 节点**（`review.ts:471/658`）：恒用 `task.worktreePath` 解析。review 在 git/loop
   wrapper 内部时（validator 甚至推荐该形态，`workflow.validator.ts:880`），上游文件在
   wrapper-canonical 里，而 review 本身是 wrapper 的暂停点——wrapper 永远等不到「整体完成」把
   文件带回主 worktree，**死锁级必然找不到**。多文档模式落占位 body（`review.ts:662`），单文档
   模式直接 `review-source-resolve-failed`。已被用户线上撞到。
2. **runner 端口校验**（`runner.ts:1369`）：以节点 iso 为根（多 repo 时是 repos[0]，
   `scheduler.ts:3365`）校验存在性——校验通过 ≠ 消费时刻可读；且与 review/前端的「容器根」语义
   在多 repo 下先天错位。
3. **前端预览 / 下载 → worktree-files API**（`TaskOutputPanel.tsx:157/175`、
   `worktreeFiles.ts:28`）：只认任务主 worktree。wrapper 内节点的输出取不到；**任务完成、
   worktree 被 GC 之后，历史任务的所有 path 端口在 UI 里永久变坏**。
4. **下游 agent 消费上游 path 端口**（`{{port}}` 渲染路径字符串，agent 在自己 iso 里找文件）：
   依赖 merge-back 链完整——gitignored 文件在下游 iso 里不存在（`git.ts:1186`）、绝对路径指向已
   销毁的 iso（`envelope.ts:129` 校验容忍绝对路径）。
5. **fanout 按 `list<path>` 分片**：shard agent 读文件，同 4。

每接一个新消费方就要再猜一遍三个维度——不根治则断链清单只会继续变长。

## 2. 目标

- **G1（阅读语义恒可用）**：任何「读端口文件内容」的消费方（review、前端预览/下载、导出、未来
  新消费方）拿到的内容不再依赖 worktree 的根、时刻、gitignore、GC——产出即固化。
- **G2（工作区语义必达）**：下游 agent 在自己 worktree 里按相对路径**编辑**上游 port 文件时，
  文件保证存在——包括被 .gitignore 覆盖的文件。
- **G3（路径规范化）**：path 端口入库值统一为规范化的容器相对路径；agent 输出绝对路径 / `./`
  前缀不再泄漏到下游。
- **G4（wrapper 内 review 即刻修复）**：断链 1 的死锁作为本 RFC 的首要回归被修复（含存量任务的
  回退通路）。
- **G5（防再犯）**：路径解析收敛到单一读取原语 + 源码级文本锁，新消费方无法再「自己拼根」。

## 3. 非目标

- 不改端口 kind 语法与校验规则（`path<ext>` 的 containment / ext / non-empty 检查原样）。
- 不提供 `{{port__content}}` 之类的内容内联渲染新模板语法（`{{port}}` 仍渲染路径字符串）。
- 不迁移 doc_versions 既有存储（review 版本归档机制照旧，仅 body 的**来源**换掉）。
- 不做内容寻址（CAS）去重、不做跨任务归档共享。
- 不改多 repo 的校验根（仍为 repos[0]；只统一「入库路径」的容器相对语义）。
- 不动 worktree-files API 的「浏览当前 worktree」职责（保留，作为浏览器与回退通路）。

## 4. 用户故事

- **US-1**：工作流把「编码 agent → 审计 agent → review」放进 git wrapper。审计 agent 在
  wrapper-canonical 里写 `audit-report.md` 并从 `report` 端口输出路径。review 节点弹出的文档就
  是报告内容——不再出现「file not found in worktree」占位。
- **US-2**：审计 agent 把报告写到被 `.gitignore` 覆盖的 `notes/` 目录。下游修复 agent 在自己的
  iso 里仍能按相对路径打开该文件（必达 merge-back）；review / 前端预览也照常显示内容（归档）。
- **US-3**：任务三个月前已完成、worktree 已被 GC。用户在任务详情 Outputs 页点「预览」/「下载」
  path 端口——内容来自归档，照常可用。
- **US-4**：agent 不守规矩输出了绝对路径（指向自己 iso 内的文件）。入库值被规范化为容器相对
  路径，下游 agent / review / 前端全部照常工作。
- **US-5**：存量任务（本 RFC 之前的 node_run）没有归档。review / 前端按回退链读 scope
  worktree，行为不劣于现状；worktree 已 GC 时明确显示「产物不可用」占位而非报错。

## 5. 验收标准

- **AC-1**：wrapper（git/loop）内的 review 节点能读到上游 agent 在 wrapper-canonical 中写的
  文件（单文档 + 多文档 list 两形态），有专门回归测试锁定（修复前红）。
- **AC-2**：agent 节点成功时，其所有 path 类端口指向的文件内容已归档到 appHome 下，
  `node_run_outputs` 行携带归档引用；节点失败 / 端口校验失败不产生归档。
- **AC-3**：被 .gitignore 覆盖的 port 文件出现在 merge-back 后的 scope canonical 里（`git add
  -f` 精确 pathspec），并进而出现在后续下游节点的 iso 里。
- **AC-4**：path 端口入库 content 为规范化容器相对路径：绝对路径（iso 内）、`./` 前缀、多余
  分隔符均被规范化；`list<path>` 逐行规范化且行序不变（与 `splitListItems` 对齐）。
- **AC-5**：前端预览 / 下载优先走归档 API；归档缺失（存量数据）时回退现行 worktree-files 行为。
- **AC-6**：超过尺寸上限的文件归档为截断副本并带 `truncated` 标记，review / 前端展示截断提示；
  merge-back 必达不受尺寸上限影响。
- **AC-7**：源码文本锁生效：`review.ts` 中不再出现 `task.worktreePath`；消费方读产物一律走
  统一读取原语。
- **AC-8**：`bun run typecheck && bun run test && bun run format:check` 全绿；migration 落地时
  `upgrade-rolling.test.ts` 的 journal 计数断言同步 bump。
