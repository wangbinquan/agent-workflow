# RFC-193 — 技术设计

## 1. 现状与断链机制（锚点）

产出侧（全部以「节点自己的 iso」为根）：

- 校验：`runner.ts:1343-1384` 对每个声明了 kind 的端口调 `resolvePortContent`，其
  `worktreePath = opts.worktreePath` = 节点 iso（`scheduler.ts:3365`，多 repo 时是
  `repos[0].isoWorktreePath`）。path handler 校验 containment/ext/非空并**读到了文件内容**
  （`shared/outputKinds/path.ts:148` 返回 `{ body, sourcePath }`），但 runner 用的是薄封装
  `resolvePortContent`——body 被丢弃，只留「校验通过」布尔。
- 入库：`runner.ts:1393-1410` 把 **agent 原样输出的路径字符串** 写进
  `node_run_outputs.content`（绝对路径 / `./` 前缀原样保留）。
- 快照：`git.ts:1186` `snapshotFullState` 用 `git add -A`（遵守 .gitignore）→ 被 ignore 的
  port 文件不进 node_tree，merge-back（`isolatedAgentRun.ts:151-186` → `nodeIsolation.ts:296`）
  后 scope canonical 里没有。

消费侧（各拼各的根）：

- review：`review.ts:471`（单文档）/ `review.ts:658`（多文档逐 item `readFileSync`）恒用
  `task.worktreePath`。wrapper 内 review 死锁断链：git/loop 的 `innerState` 只换 `repos`
  （`scheduler.ts:5760-5772` / `3965-3977`），`task` 透传，而上游文件在 wrapper-canonical。
- 前端预览/下载：`TaskOutputPanel.tsx:157/175`、`tasks.preview.tsx:144` → worktree-files API
  （`worktreeFiles.ts:28` 以 `task.worktreePath` 为根）。worktree GC 后历史任务永久断。
- 下游 agent / fanout 分片：拿 content 里的路径去自己 iso 找文件——gitignored / 绝对路径断。

## 2. 决策表

| # | 决策 | 理由 |
|---|---|---|
| D1 | **archive-at-emit**：runner 校验窗口内归档 path 形端口的文件内容 | 该窗口是全生命周期唯一 100% 可读的时刻：根=agent cwd 无需猜、gitignore 无关、绝对路径也可读后规范化。校验 handler 已经读出 body（path.ts:148），归档零额外 IO |
| D2 | **两种语义分离**：阅读语义走归档；工作区语义走「必达 merge-back」 | 读内容的消费方不该依赖 worktree 生命周期；要编辑文件的下游 agent 需要文件真实在 worktree 里——两者保障机制不同，不能互相替代 |
| D3 | 归档文件落 `{appHome}/runs/{taskId}/ports/{nodeRunId}/{portEnc}/item_{i}{ext}`；引用落 `node_run_outputs.archive_json` 新列。**`portEnc` = portName 的 percent-encode**（非 `[A-Za-z0-9._-]` 字符全部编码；写盘前对最终路径做 containment 断言） | 与 doc_versions 的「文件在 runs/ 下 + DB 存相对引用」模式同构（`review.ts:297-309`、schema 注释 1238）。`AgentSchema.outputs` 目前仅 `z.array(z.string())`——端口名可含 `/`、`../`，原样拼目录可写出归档根之外（Codex 设计门 P1），percent-encode + containment 双保险；API 路由段用同一编码往返。单值端口统一 `item_0`，list 端口 `item_{i}`（i 与 `splitListItems` 行序一致） |
| D4 | `archive_json` 形态：`{ v: 1, items: [{ path, file, size, truncated }] }` | `path`=**容器相对**规范源路径（多 repo 带 `worktreeDirName/` 前缀——供阅读语义消费方与必达清单用）；`file`=appHome 相对归档路径（超限二进制时为 null，见 D12）；`size`=源文件字节数；`truncated`=是否截断。`v` 留演进空间 |
| D5 | `content` 列语义不变：仍存路径文本（规范化后） | 下游 `{{port}}` 渲染、fanout 分片器、review inputSource 全都按「路径字符串」消费；把内容搬进 content 会破坏工作区语义。阅读语义由 archive_json 承载，各归其位 |
| D6 | **K2 规范化**：入库前把 content 重写为 **repo0 相对**（= agent cwd 相对）规范路径（单值一行；list 逐行、行序不变）；**容器相对形态只存 archive_json.items[].path** | handler 校验已产出 worktree 相对 `sourcePath`（envelope.ts:444-445 既有承诺）。**不能把 content 写成容器相对**（Codex 设计门 P1）：多 repo 下游 agent 的 cwd 是 repos[0] 的 iso 而非容器根，`{{port}}` 渲染 `repoA/report.md` 会被解析成 `repoA/repoA/report.md`。两种消费方各取所需：agent（cwd 相对）读 content，review/API/必达清单（容器语义）读 archive_json。单 repo `dirName=''` 时二者相同。绝对路径 / `./` 前缀从此不再泄漏下游 |
| D7 | **K1 必达**：`snapshotFullState` 新增 `forceIncludePaths?: string[]`（`add -A` 后逐路径 `git add -f`）；**必达清单注入 `IsoHandle`**（`handle.forcedPaths: Record<worktreeDirName, string[]>`，来源 = 按 taskId 聚合 `node_run_outputs.archive_json` 的 items[].path），nodeIsolation 内部**所有**全状态快照统一携带 | 单点（仅节点 final 快照）`add -f` 是不够的——gitignored 文件进了 node_tree、materialize 到 canonical 工作区后，**下游 iso 是从「base snapshot」（`createNodeIso` 对 canonical 的 `add -A` 快照，nodeIsolation.ts:150）checkout 的，这一跳又会把它漏掉**（git checkout 只物化 tree 内文件；ignore 只影响 add，不影响已入 tree 的物化）。`snapshotFullState` 的 10 个调用点全部收敛在 nodeIsolation.ts 内部，handle 注入一处即 base/final/ours/conflict-resolve 快照全覆盖。archive_json 本身就是持久清单（容器相对），无需新列。`add -f` 对已收录文件幂等；对已消失文件降级 warn |
| D8 | 消费收敛：新读取原语 `readPortArtifact(...)`，回退链 `archive_json → scope worktree → miss` | 所有读内容的消费方（review、归档 API）走同一原语；存量数据（archive_json NULL）由回退链承接。worktree 可能已 GC，回退是**必要设计**而非过渡（无法 backfill 不存在的文件） |
| D9 | **scopeRoot**（原 PR-0 止血并入）：`SchedulerState.scopeRoot` — 顶层 = `task.worktreePath`；git/loop `innerState.scopeRoot = wrapperIso.containerPath`（passthrough 沿用外层）；`dispatchReviewNode` 增参 | 归档制下 review 主路径不再读 worktree，scopeRoot 只服务回退链（存量 run）+ 未来需要工作区根的场景。`containerPath` 与 `task.worktreePath` 的容器语义同构（单 repo 时 = 唯一 repo 根，`nodeIsolation.ts:82-90`）。fanout 不建私有 canonical（shard 直用 `state.repos`，scheduler.ts:4823），沿用所在 scope 的 scopeRoot |
| D10 | 归档读取 API：`GET /api/tasks/:taskId/port-artifacts/:nodeRunId/:portName?item=N`；前端预览/下载优先走它，404/无归档回退现行 worktree-files | ACL 对齐 worktree-files 的成员制门（`worktree-files.ts:45-59`：`canViewTask`）。挂在 tasks 命名空间下便于复用 task 行加载 |
| D11 | 多 repo：规范路径 = 容器相对；校验根维持 repos[0] 不变 | 校验根（repos[0] iso）与消费根（task.worktreePath 容器）的错位由「归档 + 容器相对规范化」吸收：归档时转换一次，消费方不再拼根。改校验根是另一个议题（非目标） |
| D12 | **归档以原始字节 copy**（`copyFile` 语义，跟随 symlink 物化目标内容），非 UTF-8 string 落盘。尺寸上限复用 `WORKTREE_FILE_MAX_BYTES`（2 MiB，`shared/worktree-files.ts:12`）：超限**文本**截断存 + 截断点注入不可忽略的警告行（`> ⚠️ [RFC-193] truncated at 2 MiB — full file: {path}`）；超限**二进制**（NUL 探测，与 `nodeIsolation.ts:603` 同款）只记元数据（`file: null`），下载走回退链；**必达 merge-back 不受上限影响** | `path<png>`/`path<pdf>`/`path<*>` 是合法 kind，按 UTF-8 解码归档会把无效字节替换掉、GC 后下载到损坏文件（Codex 设计门 P1）。截断警告注入 body 让 reviewer 一定看见「文档不完整」（doc_versions 无 truncated 列，注入优于加列——Codex 设计门 P2）；损坏的截断二进制无消费价值，不如诚实回退 |
| D13 | doc_versions 机制不动，仅 body 来源换成 `readPortArtifact` | review 的版本历史 / iterate prompt / 锚定评论全部照旧 |
| D14 | workgroup host run（`persistDeclaredOutputs === false`，runner.ts:1390-1393）不归档 | 归档引用挂在 node_run_outputs 行上；不落库的协议端口没有挂载点，孤儿归档无意义 |
| D15 | **两阶段提交**：全部声明端口校验通过后才写归档 + INSERT（校验 fail-fast 阶段零磁盘写入）；归档写失败 → 节点 fail（`port-artifact-archive-failed`，可重试） | fail-fast 循环中途归档会在「第一个端口过、第二个端口挂」时留下孤儿归档，违反 AC-2（Codex 设计门 P2）。校验已过而 appHome 写失败属环境级故障；静默跳过会让「有 archive_json 才可信」的读取契约变成概率题。写归档中途 crash 的孤儿文件由 `runs/{taskId}` 目录清理策略兜底（无引用即不可达，无害） |
| D16 | **派生输出行透传归档引用**：wrapper 输出投影（`upsertWrapperOutput` 等）、output 虚拟节点快照（scheduler.ts:2408-2417）、review 决策产物等**所有**从上游行复制 content 的路径，同步复制 `kind` + `archive_json`（引用同一归档文件，不复制文件本体） | 这些行不经 runner INSERT，archive_json 天然 NULL——按派生 runId 查 API 会 404，worktree GC 后新产物照样断（Codex 设计门 P1）。现状部分投影连 kind 都不复制，一并补齐 |
| D17 | **RunResult.outputs 同步规范化**：校验循环完成后用规范化值回写 RunResult.outputs（与入库 content 一致） | fanout / wrapper 直接消费 RunResult.outputs（不读 DB），只改入库值时 wrapper 会继续提升 agent 原始输出的绝对 / `./` 路径，iso 销毁即断链（Codex 设计门 P1） |
| D18 | **嵌套 list 含 path 形 kind 在 validator 层拒绝**（新校验码 `output-kind-nested-list-path-unsupported`，agent 保存时报错） | `list<list<path<md>>>` 语法合法但归档/必达/分片全都只认单层——放行等于制造「过校验却悬挂」的暗角（Codex 设计门 P2）。现实工作流无此形态，禁止优于递归实现 |
| D19 | **symlink 产物**：归档物化链接**目标内容**（copyFile 跟随）；必达清单在链接目标为 worktree 内相对路径时**追加目标路径**；绝对目标链接归档照做、工作区语义 warn 不承诺 | 校验放行「解析后在 worktree 内」的链接但 `git add -f` 只收录链接对象——目标被 ignore 或为绝对路径（指向生产者 iso）时下游链接失效（Codex 设计门 P2）。阅读语义由物化兜底；绝对目标本质是 agent 越界，warn 可见 |

## 3. 数据流

```
agent 进程（cwd = 节点 iso）
  │ 写文件 report.md（可能被 .gitignore 覆盖；可能输出绝对路径）
  ▼
runner 校验循环（runner.ts:1361-1384，节点 iso 存活）
  │ resolvePortContentDetailed → { body, sourcePath }（path.ts 既有产出）
  │ ① 归档：body → {appHome}/runs/{task}/ports/{run}/{port}/item_i.md（>2MiB 截断+标记）
  │ ② 规范化：content := 容器相对路径（单值/逐行）
  │ ③ 记清单：portFilePaths += sourcePath（repo0 相对）
  ▼
node_run_outputs INSERT（content=规范路径, kind, archive_json）
  ▼
RunResult.portFilePaths → scheduler → mergeBackAndSettle(forceIncludePaths)
  │ snapshotNodeIsoFinal → snapshotFullState(repos[0], { forceIncludePaths })
  │   add -A ＋ add -f -- <清单>          ← K1 必达
  ▼
scope canonical（wrapper-canonical 或任务主 worktree）
  ├─→ 下游节点 iso 分叉：文件在，{{port}} 相对路径直接可用（工作区语义）
  └─→ wrapper 完成后随总 delta 到任务主 worktree

消费（阅读语义，一律走 readPortArtifact）
  review dispatchReviewNode ──┐
  GET /api/tasks/.../port-artifacts ──┤→ archive_json → 读归档文件
  （回退：scopeRoot/task.worktreePath 下按 content 路径读 → 再 miss 则占位）
```

## 4. 接口契约

### 4.1 schema（migration 0096）

```sql
ALTER TABLE node_run_outputs ADD COLUMN archive_json TEXT;
```

nullable、无 backfill（worktree 可能已 GC，无从补）；存量行走回退链。
**注意**：`upgrade-rolling.test.ts` journal 计数断言 95→96 同步 bump。

### 4.2 shared：ValidateResult 扩展（`outputKinds/types.ts`）

```ts
export interface ValidateOk {
  ok: true
  body: string
  sourcePath?: string
  /** list<T> 逐项产出（item handler 的 body/sourcePath），行序=splitListItems。 */
  items?: Array<{ body: string; sourcePath?: string }>
}
```

`list.ts` 的 validate 在逐项校验循环（list.ts:153-163）里顺手收集 items（item handler 本来
就返回了 body/sourcePath，现在只是不再丢弃）。非 list handler 不设 items。
`resolvePortContentDetailed`（envelope.ts:454）透传 items。单层假设由 D18 的 validator 禁令
保证（嵌套 list 含 path 形 kind 在 agent 保存时被拒，`workflow.validator` 同步校验工作流内
引用），归档层无需递归。

### 4.3 归档写入（`services/portArtifacts.ts`，新模块）

```ts
/** 全部端口校验通过后调用（D15 两阶段）；字节级 copy（D12），返回 archive_json 与必达清单。 */
export async function archivePortArtifacts(opts: {
  appHome: string
  taskId: string
  nodeRunId: string
  portName: string          // 磁盘/路由键用 percent-encode（D3），写盘前 containment 断言
  /** 单值端口长度 1；list 端口按行序。sourceAbs 用于字节 copy（跟随 symlink，D19）。 */
  items: Array<{ sourceAbs: string; sourcePath: string }>
  /** repos[0] 的 worktreeDirName（容器相对化前缀；单 repo ''）。 */
  worktreeDirName: string
}): Promise<{ archiveJson: string; portFilePaths: string[] }>

/** 消费原语：归档 → 回退 worktree → miss。 */
export function readPortArtifact(opts: {
  appHome: string
  taskId: string            // 归档 file 字段的 containment 前缀校验
  archiveJson: string | null
  content: string           // repo0 相对路径（回退时结合 worktreeDirName 再拼容器相对）
  kind: string | null
  fallbackWorktreeRoot: string | null   // review 传 scopeRoot；API 传 task.worktreePath
}): {
  items: Array<{
    path: string | null     // 容器相对源路径
    body: string            // 文本消费面（UTF-8 解码只发生在这里）
    bytes?: Uint8Array      // 二进制消费面（下载走这个，D12）
    size: number            // 源文件原始字节数（archive_json 透传——API 不得绕开原语拿 size）
    truncated: boolean
    source: 'archive' | 'worktree' | 'missing'
  }>
}
```

归档文件名：`item_{i}` + 源文件扩展名（无扩展名 → `.txt`）。目录已存在时幂等覆写（envelope
followup 重试同一 nodeRunId 重新校验 → 重新归档，后写覆盖前写，与 `onConflictDoUpdate` 的
content 覆写语义对齐）。

**containment（RFC-103 T7 同款，两个读取面都要）**：`archive_json.items[].file` 读取前校验
lexical 前缀在 `runs/{taskId}/ports/` 内（防 DB 污染 `../` 逃逸）；回退读 worktree 面复用
worktree-files 的 lexical + realpath 双重 containment（`worktreeFiles.ts:28-36` 模式，防
worktree 内 symlink 指向外部的读穿）。

### 4.4 runner（runner.ts 校验循环改造，两阶段 D15）

- **阶段一（纯校验，零磁盘写）**：`resolvePortContent` → `resolvePortContentDetailed`，逐端口
  fail-fast（现状不变）；path 形端口（`parsed.kind === 'path'` 或 `list` 且
  `item.kind === 'path'`，含 `markdown_file` 折叠）收集 `items[{ sourceAbs, sourcePath }]`。
- **阶段二（全过后）**：逐 path 形端口 `archivePortArtifacts(...)`（字节 copy）→ 拿
  `archiveJson` + `portFilePaths`；content 规范化为 **repo0 相对**（D6：单值 = sourcePath；
  list = 逐行 sourcePath，行序不变）；INSERT 带 `archiveJson`。
- **`RunResult.outputs` 同步回写规范化值**（D17——fanout/wrapper 直接消费该 map，不读 DB）；
  `RunResult` 增 `portFilePaths?: string[]`（repo0 相对，供必达）。
- 非 path 形端口（string/markdown/list<markdown>/signal）：零变化（content 即 body，自足）。

### 4.5 必达 merge-back

**传播链认知（决定注入形态）**：ignored 文件 F 要从产出节点 A 到达下游节点 B 的 iso，要过三跳
——① A 的 final 快照（进 node_tree）→ ② merge-back materialize（落 canonical 工作区）→
③ B 分叉时对 canonical 的 **base snapshot**（进 base tree，checkout 才会物化进 B 的 iso）。
①③ 都是 `add -A` 快照，单修 ① 时 F 会永远趴在 canonical 工作区但进不了任何 tree。因此清单
必须对**所有**全状态快照生效：

- `git.ts snapshotFullState(worktreePath, opts)` 增 `forceIncludePaths?: string[]`：
  `add -A` 后逐路径 `git add -f --`，**带 `GIT_LITERAL_PATHSPECS=1`**（`--` 只终止选项解析、
  不关闭 pathspec magic——`:` 开头的合法文件名会被解释为 `:(glob)` 等模式，可能强制收录整棵
  ignored 树，Codex 设计门 P2）；同一 `GIT_INDEX_FILE` 临时 index；单路径失败 warn 不抛
  （文件可能已被后续节点删除——快照如实反映，阅读语义有归档兜底）。
- symlink 端口文件（D19）：清单在链接自身外**追加其 worktree 内相对目标**（realpath 相对化后
  仍在 worktree 内时）；绝对目标不追加、warn。
- 聚合器 `forcedPortPathsForTask(db, taskId): Record<worktreeDirName, string[]>`（新，
  portArtifacts.ts）：扫该任务 `node_run_outputs.archive_json` 的 items[].path（容器相对），
  按 `worktreeDirName` 前缀拆成 per-repo 相对路径。
- **注入点 = IsoHandle**：`createNodeIso` / `rebuildIsoHandle` / wrapper 的
  `createOrRebuildWrapperIso`（复用 createNodeIso，scheduler.ts:5564）创建 handle 时聚合一次，
  存 `handle.forcedPaths`；nodeIsolation.ts 内部 10 处 `snapshotFullState` 全部改为携带对应
  repo 的清单（base / final / ours / conflict-resolve / human-resume 快照一致覆盖）。
  handle 为 per-node-run 短命对象，每次 dispatch 重建 → 清单天然最新；**wrapper 的 final 快照
  是唯一长命例外**（wrapper handle 跨内层节点存活，期间内层新增归档）→ wrapper done 的
  `snapshotNodeIsoFinal` 前重新聚合一次。
- 产出节点自己的 final 快照额外并上 `RunResult.portFilePaths`（本 run 刚产出、archive_json
  与 RunResult 同源，避免读己写竞态）。

### 4.6 review 切换（review.ts）

- `DispatchReviewArgs` 增 `scopeRoot: string`；`scheduler.ts:2437` 传 `state.scopeRoot`。
- 单文档（review.ts:466-482）：`resolvePortContentDetailed` 整段换 `readPortArtifact`
  （fallbackWorktreeRoot=scopeRoot）；`resolvedSourcePath` 取 items[0].path。
- 多文档（review.ts:646-664）：`readFileSync(join(task.worktreePath, itemPath))` 换
  `readPortArtifact` 的逐 item body；`source === 'missing'` 沿用现占位文案（review.ts:662）。
- `task.worktreePath` 在 review.ts 中清零（AC-7 文本锁目标）。
- 截断文档：归档 body 已带截断警告行（D12），doc_version 原样归档——reviewer 必见，无需
  doc_versions 加列。
- **S1 修复路径（scheduler 之外的生产调用方，Codex 设计门 P2）**：`lifecycleRepair` 的
  「recreate doc_version」直接调 `dispatchReviewNode`——归档制下主路径读 archive_json，
  scopeRoot 仅回退链用。S1 侧 scopeRoot 推导：review run 属 wrapper scope（`containerOf`）
  时取该 wrapper 最新 run 的 `isoWorktreePathFor(appHome, taskId, wrapperRunId, '')`，
  否则 `task.worktreePath`（存量 + 顶层不劣于现状）。附 S1 回归测试。

### 4.7 归档读取 API + 前端

- `GET /api/tasks/:taskId/port-artifacts/:nodeRunId/:portName?item=N`（`:portName` 段
  percent-encode 往返，D3）：
  - 门：task 行加载 + `canViewTask`（对齐 worktree-files.ts:45-59）；nodeRun 归属校验
    （nodeRunId 必须属于该 task，防跨任务读）。
  - 返回：`{ items: [{ path, truncated, size }] }`（元数据，size 经 `readPortArtifact` 透传
    ——API 不绕开原语）或 `?item=N` 时该 item 内容——MIME 按源扩展名（md→`text/markdown`、
    png→`image/png`…，兜底 `application/octet-stream`），二进制走 `bytes` 面；无归档且
    worktree 回退失败 → 404 `port-artifact-missing`。
  - 全部读取过 `readPortArtifact`（archive containment + worktree lexical/realpath 双防御）。
- 前端：preview source 新增 **`{ kind: 'artifact', runId, port, item, path }`**（Codex 设计门
  P1：现 `{ kind: 'file', path }` 不携带 runId/port，独立 `tasks.preview` 深链路由无从构造
  artifact URL）——`TaskOutputPanel` / `tasks.preview.tsx` 的输出预览与下载走 artifact 源，
  404 回退现行 `downloadWorktreeFile` / worktree-files 预览；`WorktreeFilesPanel` 的
  path-only 浏览模式保留（浏览「当前 worktree」本来就是它的职责）。i18n 补
  `outputs.artifactTruncated` 截断横幅 key（zh/en 双语）。

### 4.8 派生输出投影透传（D16）

从上游行复制 content 的**全部**投影路径同步复制 `kind` + `archive_json`：

- wrapper 输出提升（loop/git 的 outputBindings → `upsertWrapperOutput` 一族）；
- output 虚拟节点快照（scheduler.ts:2408-2417 —— 现状连 kind 都不带，一并补）；
- review 决策产物端口（approve 的 accepted 等，凡 content 为路径转写的行）；
- fanout 聚合行若按 shard 行拼接 content（list 形），archive_json 逐 shard 合并 items
  （行序 = 聚合 dict 序）。

grep 锚：全仓搜 `nodeRunOutputs).values` / `insert(nodeRunOutputs)` 逐点核对，防漏。

## 5. 失败模式

| 场景 | 行为 |
|---|---|
| 归档写盘失败（appHome 满/权限） | 节点 fail `port-artifact-archive-failed`（D15），可重试 |
| 部分端口校验失败 | 两阶段（D15）：阶段一 fail-fast 时零磁盘写入，无孤儿归档 |
| 源文本文件 >2 MiB | 截断归档 + body 注入截断警告行（D12）+ `truncated: true`；review 文档自带警告、前端横幅；merge-back 全量必达 |
| 源二进制文件 >2 MiB | 只记元数据（`file: null`）；下载回退 worktree，GC 后 404（诚实缺失优于交付损坏字节，D12） |
| 端口名含 `/`、`../` 等 | percent-encode 磁盘/路由键 + 写盘前 containment 断言（D3），无路径注入 |
| `add -f` 单路径失败（文件校验后被删等） | warn + 继续（快照如实反映；阅读语义有归档） |
| `:` 开头文件名 | `GIT_LITERAL_PATHSPECS=1` 按字面处理，不触发 pathspec magic（§4.5） |
| symlink 端口值 | 归档物化目标内容；相对 worktree 内目标追加进必达清单；绝对目标 warn、工作区语义不承诺（D19） |
| 派生行（wrapper 提升 / output 节点 / review 产物） | kind + archive_json 随投影透传（D16），API 按派生 runId 可读 |
| S1 修复重建 doc_version（wrapper 内存量 review） | scopeRoot 从 wrapper run 谱系推导（§4.6），失败退 task.worktreePath（不劣于现状） |
| 存量 run（archive_json NULL）+ worktree 在 | 回退链读 scopeRoot/task.worktreePath——不劣于现状，wrapper 场景优于现状（scopeRoot 指对了根） |
| 存量 run + worktree 已 GC / wrapper iso 已灭 | review 占位 body / API 404——现状同样是坏的，且有明确文案 |
| envelope followup 重试（同 nodeRunId 二次校验） | 归档幂等覆写，archive_json 随 INSERT `onConflictDoUpdate` 一起覆写 |
| 任务删除 / GC | 归档随 `runs/{taskId}` 目录跟随现行清理策略（与 doc_versions 一致，本 RFC 不新增清理义务） |

## 6. 测试策略（必写 case）

后端（bun test）：

1. **runner 归档**：path<md> 端口（相对 / 绝对指 iso 内 / `./` 前缀）→ archive_json 形态正确、
   content 规范化为容器相对、归档文件 body 与源一致。
2. **list<path<md>> 逐项归档**：item 顺序与 `splitListItems` 一致；content 逐行规范化行序不变。
3. **oversized**：>2 MiB 文本截断 + body 尾部警告行 + truncated 标记；>2 MiB 二进制只记
   元数据；INSERT 后行可读。
3b. **两阶段无孤儿**：首端口为 path 形且文件合法、次端口校验失败 → 节点 fail 且磁盘零归档
   文件（D15，现状 fail-fast 顺序下红）。
3c. **二进制往返**：`path<png>` 端口归档后经 API 下载字节与源一致（UTF-8 解码路径会损坏，
   D12 锁定）。
3d. **portName 注入**：端口名含 `../x` 时归档文件仍落在该 nodeRun 归档根内（containment
   断言生效）。
3e. **RunResult.outputs 规范化回写**：agent 输出绝对路径时 RunResult.outputs 与入库 content
   同为 repo0 相对（D17，fanout 提升面）。
3f. **多 repo content 相对性**：dirName 非空时 content = repo0 相对（不带 dirName 前缀）、
   archive_json.items[].path = 容器相对（带前缀）——两面各自正确（D6）。
4. **K1 必达（集成）**：agent 在 iso 写 gitignored 文件并输出端口 → merge-back 后 scope
   canonical 可见该文件（现状红）。
4b. **K1 跨节点传播（集成，US-2 的真断言）**：节点 A 产出 gitignored port 文件 → 节点 B 的
   iso（base snapshot checkout）里该文件存在且内容一致（单修 final 快照时红——锁 §4.5 的
   三跳传播链）。
5. **wrapper 内 review（主回归，现状红）**：git/loop wrapper 内 agent 产出 path<md> → review
   弹出的 doc_version body = 文件内容而非占位（单文档 + 多文档两条）。
6. **回退链**：archive_json NULL + scopeRoot 下文件在 → body 来自 worktree；两者皆无 →
   `source: 'missing'` + 现占位文案。
7. **API**：成员可读 / 非成员 403（与 worktree-files 同形）/ 跨任务 nodeRunId 404 /
   无归档回退 404 / 元数据 size=源字节数（截断 item 亦然）/ portName 编码往返。
8. **workgroup host run 不归档**（persistDeclaredOutputs=false 路径零 archive 文件）。
8b. **派生投影透传**：wrapper 提升行 / output 虚拟节点行携带上游 kind + archive_json，
   API 按派生 runId 200（D16，现状红）。
8c. **validator 嵌套禁令**：`list<list<path<md>>>` 声明保存被拒（D18 新校验码）。
8d. **S1 修复回归**：wrapper 内存量 review 经 S1 recreate doc_version 不再落
   「file not found」占位（scopeRoot 谱系推导）。
8e. **literal pathspec**：`:` 开头文件名 add -f 按字面收录单文件（§4.5）。
8f. **symlink**：相对 worktree 内目标的链接端口 → 下游 iso 链接可解析；归档 body=目标内容
   （D19）。
9. **migration**：journal 计数 95→96 bump（`upgrade-rolling.test.ts`）。

前端（vitest）：

10. 预览/下载优先 port-artifacts、404 回退 worktree-files；截断横幅渲染。

源码锁：

11. `review.ts` 不得出现 `task.worktreePath`（文本断言，锁 AC-7 / 防「再拼一次根」回归）。

## 7. 与相邻 RFC 的关系

- **RFC-188**：归档插在 runner.ts 校验循环内（`runIsolatedAgent` 原语内部），五个装配站点自动
  受益；必达清单沿 `mergeBackAndSettle` 的既有参数面透传，不新增裸原语调用（不触碰其
  allowlist 锁）。
- **RFC-005 T14（per-shard review）**：未实现，不受影响；将来实现时消费面直接用
  `readPortArtifact`，天然免疫 scope 问题。
- **RFC-079/081 多文档 review**：wire 语义（splitListItems / MARKDOWN_DOC_BOUNDARY）不变，
  仅 body 来源切换。
