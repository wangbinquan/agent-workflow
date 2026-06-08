# RFC-089 — 技术设计

## 0. 现状数据流（多仓 task 作用域）

```
getTaskStructuralDiff(repoCount>1)
  └─ for each usable repo:                      service.ts:125
        computeFromWorktree({worktreePath: repo.worktreePath, fromRef: repo.baseCommit})
        → StructuralDiff（per-repo，filePath/symbol id/classEdges 都是仓内相对）
  └─ mergeStructuralDiffs(base, parts)          assemble.ts:120
        files:           f.filePath → `${label}/${f.filePath}`   ✅ 前缀
        dependencyChanges: manifestPath → `${label}/...`         ✅ 前缀
        impact:          files.flatMap(f.impact)                 ⚠️ impact 内的 ref 未前缀
        classEdges:      []                                      ❌ 整批丢弃
        callChainAvailable: (不设置)                              ❌ 丢失
```

关键不变量：前端图（`structureGraph.ts`）的**卡片 id = `${file.filePath}::${qn}`**，
而 `file.filePath` 合并后已带 `label/` 前缀。任何引用卡片 id 的字段（classEdges
的 from/to、impact 的 caller ref、callChain 的 methodRef）**必须用同一个 `label/`
前缀**才能对齐——这正是本 RFC 的核心一致化工作。

## 1. PR-A（P1）— isGitWorkTree 一致性 + 文件树按仓可读

### 接口契约
- `structuralDiff/service.ts`：task / node / wrapper 三处 `existsSync(worktreePath)`
  守卫改为 `isGitWorkTree(worktreePath)`（复用 `util/git.ts` 已导出的探测）。
  多仓 `usable` filter 的 `existsSync(r.worktreePath)` 同样换成 `isGitWorkTree`
  预解析（`Promise.all` 后过滤，与 `getTaskDiff` 的写法一致）。
  - **顺序保持**：先 `existsSync`→readStoredDiff 兜底（GC 场景），仍在前；
    `isGitWorkTree` 仅替换「目录在但非仓库」这一档的 500→410。即：目录完全不存在
    走 readStoredDiff / 410；目录在但非 git 仓库 → 410（不再 500）。
- 前端：文件树顶层「仓」节点加可读标签（复用结构树既有 row 渲染，给 depth-0 且
  匹配 `parts[].label` 的目录节点挂一个 `repo` 标记 / icon），不引入新 chrome。
  多仓判定：`data.scope==='task'` 且存在 `>1` 个顶层目录对应 `label`。

### 失败模式
- 损坏 worktree：`isGitWorkTree=false` → 410（含 message「… is no longer a valid
  git repository …」复用 task-diff 文案风格）。
- 单仓：`isGitWorkTree` 对正常 worktree 返回 true → 行为不变。

### 测试
- 后端：`structural-diff` 路由，单仓目录存在但非仓库 → 410（镜像
  `tasks.test.ts` 的 worktree-diff 用例）。
- 前端：多仓 merged diff 渲染出按仓顶层分组（文本断言 + role 查询）。

## 2. PR-B（P2）— 类关系图多仓

### 接口契约
`mergeStructuralDiffs`（`assemble.ts`）不再 `classEdges: []`，改为前缀后合并：

```ts
for (const { label, diff } of parts) {
  for (const e of diff.classEdges) classEdges.push({
    ...e,
    from: prefixCardId(label, e.from),     // `${label}/${file}::${qn}`
    to:   prefixCardId(label, e.to),
    fromMembers: e.fromMembers?.map(id => prefixSymbolId(label, id)),
    toMembers:   e.toMembers?.map(id => prefixSymbolId(label, id)),
  })
}
```
- `prefixCardId(label, id)`：id 形如 `${filePath}::${qn}`，只前缀 `filePath` 段
  （`::` 前），得 `${label}/${filePath}::${qn}`。
- `prefixSymbolId(label, id)`：symbol id 内嵌 filePath（见
  `symbolNodeSchema`），同样只前缀其 filePath 段。抽成 `assemble.ts` 私有纯函数，
  与 `files[].filePath` 前缀逻辑共用一处「label 前缀」语义。
- **同 PR 顺带修 impact 前缀漏洞**：`impact` 里 caller/target 的 ref 也按同法前缀
  （现状 `files.flatMap(f.impact)` 直接展开，未前缀——单仓不显，多仓会让 Impact
  视图的跳转 ref 对不上卡片）。

### 耦合点
- `structureGraph.ts:573` `for (const e of diff.classEdges)` `addEdge(e.from, e.to)`
  —— 卡片 id 现在带 `label/`，与前缀后的 file card 一致，边自然只连同仓卡片。
  无需改前端图逻辑（验证：前缀一致即可）。

### 失败模式
- 跨仓引用：repo-a 引用 repo-b 的类——per-repo 计算阶段就解析不到（仓内无此符号），
  本就不会产出该 classEdge，故合并后也不会出现跨仓误连。符合非目标。

### 测试
- 单测 `prefixCardId`/`prefixSymbolId`（`::` 分割、无 `::` 容错、嵌套路径）。
- `mergeStructuralDiffs` 多仓：classEdges 非空、from/to 带各自 label、两仓同名类
  不串（`assemble` 既有测试文件扩展）。
- 前端图：喂 label 前缀的 merged diff，断言边只连同 label 卡片。

## 3. PR-C（P3）— node 作用域多仓

### 接口契约
`getNodeStructuralDiff`（`service.ts:152`）去掉 `repoCount!==1` 抛错分支，改为：
- 单仓：现逻辑不变。
- 多仓：读 `node_runs.preSnapshotReposJson`（`Record<repoDir, stashSha>`，
  schema.ts:547），对每个仓用 `resolveNodeScope` 的同款 from/to 解析（per-repo
  `preSnapshot` = map[repoDir]），逐仓 `computeFromWorktree`/`computeBetweenRefs`，
  再 `mergeStructuralDiffs`（复用 PR-B 的前缀合并）。
- 复用 `task.ts:872` 已有的 `preSnapshotReposJson` 解析 + 回退到 legacy 单 stash
  的容错模式（解析失败 → 降级，不崩）。

### 失败模式
- 某仓快照被 `git gc` 剪枝：该仓 `emptyNodeDiff('snapshot-pruned')`，其余仓照出
  （partial）。
- readonly 节点：各仓均无快照 → `readonly-node-no-snapshot`（与单仓一致）。
- git-wrapper 节点选中：沿用 `getWrapperStructuralDiff`（wrapper 作用域多仓在本
  PR 一并按同款 per-repo + merge 处理；若 wrapper baseline 仅单仓记录，则该 PR
  内显式 partial 兜底，不抛 unsupported）。

### 测试
- 多仓 node 作用域：构造 2 仓 + 一个写节点的 `preSnapshotReposJson`，断言返回
  合并 diff 含两仓文件、不再抛 `structural-node-scope-multi-repo-unsupported`。
- 某仓快照缺失 → partial。

## 4. PR-D（P4）— 调用链多仓

### 接口契约
- `mergeStructuralDiffs`：`callChainAvailable = parts.some(p => p.diff.callChainAvailable)`
  （OR 归约），写入 merged。
- `getCallTargets`（`callGraph/expandService.ts:7`）repo 感知：
  - 入参 `methodRef = ${filePath}#${qn}`，多仓时 filePath 带 `label/` 前缀。
  - 新增 `resolveRepoFromRef(task, methodRef)`：剥离 `label/` 前缀 → 命中
    `task.repos[].worktreeDirName`，取该仓 `worktreePath`；用**去前缀后的**
    methodRef 跑 `worktreeExpandCtx(repoWorktreePath)` + `expandMethod`。
  - 返回的 `CallTarget.ref`（`${filePath}#${qn}`，仓内相对）需**重新前缀** `label/`，
    使前端下一层 expand 仍带前缀、闭环。`ownerClass`（卡片 id）同样前缀。
  - 单仓：无 label，`resolveRepoFromRef` 回退 `task.worktreePath`，行为不变。
- `/call-targets` 路由（`tasks.ts:315`）签名不变（仍收 `methodRef`），repo 解析在
  service 内部。

### 失败模式
- methodRef 的 label 不匹配任何仓 → 404 `node-run-not-found` 风格的清晰错误
  （而非静默跑错仓）。
- 跨仓被调方：`expandMethod` 在本仓解析不到 → `external`/`unresolved`（既有降级）。

### 测试
- `resolveRepoFromRef`：前缀剥离 + 仓匹配 + 单仓回退 + 未知 label 报错。
- 多仓 call-targets：跨仓方法各自解析到对的仓 worktree；返回 ref 带回前缀。
- 前端：多仓 `callChainAvailable=true` → ⎇ 入口出现（已有 CallChainView 复用）。

## 5. 跨 PR 公共原语
- `assemble.ts` 内抽 `prefixCardId` / `prefixSymbolId` / `prefixFilePath`（一处
  「label 前缀」语义），PR-A/B/C/D 共用，避免各处手写 `${label}/` 漂移。
- 多仓 label 来源唯一：`repo.worktreeDirName || basename(repo.repoPath)`
  （`service.ts:132` 现状），不另起一套。

## 6. 风险
- **P4 最不确定**：methodRef 往返前缀 + ownerClass 前缀若有遗漏，调用链展开会跳错
  仓。对策：往返前缀集中在 `getCallTargets` 一个边界函数，单测覆盖前缀进出。
- 单仓回归面：所有改动都走「多仓才前缀，单仓 label 为空 → 无前缀」的分支，单仓
  路径字节不变；以单仓既有结构 diff 测试作为回归门槛。
