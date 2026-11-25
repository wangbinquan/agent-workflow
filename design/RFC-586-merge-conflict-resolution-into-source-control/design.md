# RFC-586 技术设计

记号：`S/` = `packages/backend/src/`，`SC/` = source-control 的模块目录，`TE/` = task-execution 的模块目录。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：source-control 的 `domain`（纯逻辑：只取 shared 与本模块 domain）；三个模板函数经 `public/participants` 交出（与
  `requireIsolationWorkspaceScope` 等同处）。
- **承担的演进**：W5 第二步；`services/` 只剩 `codeRoundContract.ts` 与 `repoCredentials.ts`。
- **不新增** DAG 之外的边：task-execution → source-control 是 DAG 上的 offered-consumption；domain 文件不取 legacy。
- **偏离项**：无。

## 1. 文件去向与连接

- `S/services/mergeAgent.ts` → `SC/domain/mergeConflictResolution.ts`：内容逐字不变，只改两处 import——冲突类型改从同目录的 `isolationConflict.ts` 取
  （原来经本模块 public 绕一圈），`residualConflictMarkers` 不再从 `util/git` 取，函数逐字移进本文件（导出名不变）。原文件末尾对三个冲突类型的
  转出照旧保留（改为转出同目录的声明）。
- `S/util/git.ts` 删去 `residualConflictMarkers`（只有本文件与一个用例在用）。
- `SC/public/participants.ts` 转出 `buildMergeAgent`、`buildMergeResolvePrompt`、`mergeResolveNodeId`。
- `TE/composition/mergeConflictResolution.ts` 改从 `@/modules/source-control/public/participants` 取这三个函数，端口绑定不变。
- `SC/infrastructure/local/nodeIsolation.ts` 改从 `../../domain/mergeConflictResolution` 取它用的函数与类型。

## 2. 门、用例与文档

- 架构报告归属表删 `services/mergeAgent.ts` 一行；`counts.json` 两个上限。
- 直接 import 旧路径的用例由搬迁脚本改写；取 `residualConflictMarkers` 的用例改取新位置；`rfc487` / `rfc488` / `rfc282` 等钉着旧路径的用例随改
  （检索：`pins.py` 覆盖 `src` / `tests` / `scripts` / `architecture` / `.github`，另查 `design/`、`docs/` 的 Markdown 链接）。
- 新增 `T/rfc586-merge-conflict-resolution-into-source-control-boundary.test.ts`，登记 guard-manifest：① 旧路径不存在，`src` / `tests` / `scripts` 的
  全部说明符不再解析到它（带负对照）；② 新的 domain 文件只取 shared 与本模块 domain（带负对照）；③ `residualConflictMarkers` 只在新文件声明一次；
  ④ task-execution 的合并冲突端口经 source-control 的 public 取模板函数，且取到的与 domain 里的是同一份（函数身份相等）。

## 3. 失败模式

- **有人在旧路径重建文件或重新取它**：用例 ① 红，legacy 计数也红。
- **domain 文件又取 git 模块或别的层**：用例 ② 红。
- **task-execution 改取 source-control 的内部**：用例 ④ 与跨 context 内部文件对计数同红。

## 4. 取舍（可推翻）

1. **整份归 source-control，而不是把模板拆给 task-execution**：提示词与代理定义共用输出端口名、必须在一处，而 source-control 的隔离实现要用提示词；
   拆给 task-execution 就要 source-control 反过来依赖它（DAG 上没有这条边）。
2. **`residualConflictMarkers` 随同移入 domain**：它是一行正则，只有这里在用；留在 `util/git` 会让 domain 取 git 模块。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：纯逻辑进 domain；task-execution 经 public 取。**C11**：source-control 的 public 面多三个被消费的模板函数。**C12**：RFC-586 用例 ① 覆盖全部
  说明符，② ③ ④ 只读相关文件。**C13**：legacy 横向文件 63 → 62、`services/` 业务实现 3 → 2，其余计数不升。
- **留下的债**：`util/git.ts` 本身与 platform 里余下的 `runGit` 使用方。
