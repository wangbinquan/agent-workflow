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
| D3 | 归档文件落 `{appHome}/runs/{taskId}/ports/{nodeRunId}/{portName}/item_{i}{ext}`；引用落 `node_run_outputs.archive_json` 新列 | 与 doc_versions 的「文件在 runs/ 下 + DB 存相对引用」模式同构（`review.ts:297-309`、schema 注释 1238）；DB 保持小、markdown 可 grep。单值端口统一 `item_0`，list 端口 `item_{i}`（i 与 `splitListItems` 行序一致），单/多形态一套代码 |
| D4 | `archive_json` 形态：`{ v: 1, items: [{ path, file, size, truncated }] }` | `path`=**容器相对**规范源路径；`file`=appHome 相对归档路径；`size`=源文件字节数；`truncated`=是否截断。`v` 留演进空间 |
| D5 | `content` 列语义不变：仍存路径文本（规范化后） | 下游 `{{port}}` 渲染、fanout 分片器、review inputSource 全都按「路径字符串」消费；把内容搬进 content 会破坏工作区语义。阅读语义由 archive_json 承载，各归其位 |
| D6 | **K2 规范化**：入库前把 content 重写为规范容器相对路径（单值一行；list 逐行、行序不变） | handler 校验已产出 worktree 相对 `sourcePath`（envelope.ts:444-445 既有承诺）；容器相对 = `join(repos[0].worktreeDirName, sourcePath)`（单 repo `dirName=''` 时即原值）。绝对路径 / `./` 前缀从此不再泄漏下游 |
| D7 | **K1 必达**：`snapshotFullState` 新增 `forceIncludePaths?: string[]`——`add -A` 后对清单逐路径 `git add -f`；清单 = 本 run 校验通过的 path 形端口源文件（repo0 相对） | gitignored port 文件从此必进 node_tree → merge-back → scope canonical → 下游 iso。精确 pathspec 不会卷进 node_modules。`add -f` 对已收录文件幂等；对已消失文件降级 warn（快照如实反映，阅读语义已有归档兜底） |
| D8 | 消费收敛：新读取原语 `readPortArtifact(...)`，回退链 `archive_json → scope worktree → miss` | 所有读内容的消费方（review、归档 API）走同一原语；存量数据（archive_json NULL）由回退链承接。worktree 可能已 GC，回退是**必要设计**而非过渡（无法 backfill 不存在的文件） |
| D9 | **scopeRoot**（原 PR-0 止血并入）：`SchedulerState.scopeRoot` — 顶层 = `task.worktreePath`；git/loop `innerState.scopeRoot = wrapperIso.containerPath`（passthrough 沿用外层）；`dispatchReviewNode` 增参 | 归档制下 review 主路径不再读 worktree，scopeRoot 只服务回退链（存量 run）+ 未来需要工作区根的场景。`containerPath` 与 `task.worktreePath` 的容器语义同构（单 repo 时 = 唯一 repo 根，`nodeIsolation.ts:82-90`）。fanout 不建私有 canonical（shard 直用 `state.repos`，scheduler.ts:4823），沿用所在 scope 的 scopeRoot |
| D10 | 归档读取 API：`GET /api/tasks/:taskId/port-artifacts/:nodeRunId/:portName?item=N`；前端预览/下载优先走它，404/无归档回退现行 worktree-files | ACL 对齐 worktree-files 的成员制门（`worktree-files.ts:45-59`：`canViewTask`）。挂在 tasks 命名空间下便于复用 task 行加载 |
| D11 | 多 repo：规范路径 = 容器相对；校验根维持 repos[0] 不变 | 校验根（repos[0] iso）与消费根（task.worktreePath 容器）的错位由「归档 + 容器相对规范化」吸收：归档时转换一次，消费方不再拼根。改校验根是另一个议题（非目标） |
| D12 | 尺寸上限复用 `WORKTREE_FILE_MAX_BYTES`（2 MiB，`shared/worktree-files.ts:12`）：超限截断存 + `truncated: true`；**必达 merge-back 不受上限影响** | 阅读语义与 worktree-files 预览口径一致；git 对象存储压缩良好，工作区语义不打折 |
| D13 | doc_versions 机制不动，仅 body 来源换成 `readPortArtifact` | review 的版本历史 / iterate prompt / 锚定评论全部照旧 |
| D14 | workgroup host run（`persistDeclaredOutputs === false`，runner.ts:1390-1393）不归档 | 归档引用挂在 node_run_outputs 行上；不落库的协议端口没有挂载点，孤儿归档无意义 |
| D15 | 归档写失败 → 节点 fail（`port-artifact-archive-failed`，可重试） | 校验已过而 appHome 写失败属环境级故障；静默跳过会让「有 archive_json 才可信」的读取契约变成概率题 |

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
`resolvePortContentDetailed`（envelope.ts:454）透传 items。

### 4.3 归档写入（`services/portArtifacts.ts`，新模块）

```ts
/** runner 校验通过后调用；返回写入 node_run_outputs.archive_json 的 JSON 与必达清单。 */
export async function archivePortArtifacts(opts: {
  appHome: string
  taskId: string
  nodeRunId: string
  portName: string
  /** 单值端口长度 1；list 端口按行序。 */
  items: Array<{ body: string; sourcePath: string }>
  /** repos[0] 的 worktreeDirName（容器相对化前缀；单 repo ''）。 */
  worktreeDirName: string
}): Promise<{ archiveJson: string; portFilePaths: string[] }>

/** 消费原语：归档 → 回退 worktree → miss。 */
export function readPortArtifact(opts: {
  appHome: string
  archiveJson: string | null
  content: string          // 规范化路径（回退时用）
  kind: string | null
  fallbackWorktreeRoot: string | null   // review 传 scopeRoot；API 传 task.worktreePath
}): { items: Array<{ path: string | null; body: string; truncated: boolean; source: 'archive' | 'worktree' | 'missing' }> }
```

归档文件名：`item_{i}` + 源文件扩展名（无扩展名 → `.txt`）。目录已存在时幂等覆写（envelope
followup 重试同一 nodeRunId 重新校验 → 重新归档，后写覆盖前写，与 `onConflictDoUpdate` 的
content 覆写语义对齐）。

### 4.4 runner（runner.ts 校验循环改造）

- `resolvePortContent` → `resolvePortContentDetailed`；对 path 形端口（`parsed.kind === 'path'`
  或 `list` 且 `item.kind === 'path'`，含 `markdown_file` 折叠）：
  - `archivePortArtifacts(...)` → 拿 `archiveJson` + `portFilePaths`
  - content 规范化：单值 = `join(dirName, sourcePath)`；list = items 的容器相对路径按行拼接
- INSERT 增列 `archiveJson`；`RunResult` 增 `portFilePaths?: string[]`（repo0 相对，供必达）。
- 非 path 形端口（string/markdown/list<markdown>/signal）：零变化（content 即 body，自足）。

### 4.5 必达 merge-back

- `git.ts snapshotFullState(worktreePath, opts)` 增 `forceIncludePaths?: string[]`：
  `add -A` 后逐路径 `git add -f --`（同一 `GIT_INDEX_FILE` 临时 index）；单路径失败 warn 不抛。
- `nodeIsolation.ts snapshotNodeIsoFinal(handle, log, forceIncludePaths?)`：只对
  `worktreeDirName === handle.repos[0].worktreeDirName` 的 repo 传入（校验根即 repos[0]）。
- `isolatedAgentRun.ts mergeBackAndSettle` args 增 `forceIncludePaths?: string[]`（live 快照分支
  透传；replay 分支 nodeTrees 已持久化、快照跳过，无需清单——crash 于快照前的 run 不进 replay）。
- scheduler 各 live 站点从 `lastResult.portFilePaths` 透传。

### 4.6 review 切换（review.ts）

- `DispatchReviewArgs` 增 `scopeRoot: string`；`scheduler.ts:2437` 传 `state.scopeRoot`。
- 单文档（review.ts:466-482）：`resolvePortContentDetailed` 整段换 `readPortArtifact`
  （fallbackWorktreeRoot=scopeRoot）；`resolvedSourcePath` 取 items[0].path。
- 多文档（review.ts:646-664）：`readFileSync(join(task.worktreePath, itemPath))` 换
  `readPortArtifact` 的逐 item body；`source === 'missing'` 沿用现占位文案（review.ts:662）。
- `task.worktreePath` 在 review.ts 中清零（AC-7 文本锁目标）。

### 4.7 归档读取 API + 前端

- `GET /api/tasks/:taskId/port-artifacts/:nodeRunId/:portName?item=N`：
  - 门：task 行加载 + `canViewTask`（对齐 worktree-files.ts:45-59）；nodeRun 归属校验
    （nodeRunId 必须属于该 task，防跨任务读）。
  - 返回：`{ items: [{ path, truncated, size }] }`（元数据）或 `?item=N` 时该 item 的 body
    （`text/markdown`）；无归档且 worktree 回退失败 → 404 `port-artifact-missing`。
- 前端：`TaskOutputPanel` 预览/下载与 `tasks.preview.tsx` 的 file 模式改为优先请求
  port-artifacts（需要 sourceRunId——`OutputDetail` 已有该 prop，TaskOutputPanel.tsx:142）；
  404 时回退现行 `downloadWorktreeFile` / worktree-files 预览路径。i18n 补
  `outputs.artifactTruncated` 截断横幅 key（zh/en 双语）。

## 5. 失败模式

| 场景 | 行为 |
|---|---|
| 归档写盘失败（appHome 满/权限） | 节点 fail `port-artifact-archive-failed`（D15），可重试 |
| 源文件 >2 MiB | 截断归档 + `truncated: true`；review/前端显示截断横幅；merge-back 全量必达 |
| `add -f` 单路径失败（文件校验后被删等） | warn + 继续（快照如实反映；阅读语义有归档） |
| 存量 run（archive_json NULL）+ worktree 在 | 回退链读 scopeRoot/task.worktreePath——不劣于现状，wrapper 场景优于现状（scopeRoot 指对了根） |
| 存量 run + worktree 已 GC / wrapper iso 已灭 | review 占位 body / API 404——现状同样是坏的，且有明确文案 |
| envelope followup 重试（同 nodeRunId 二次校验） | 归档幂等覆写，archive_json 随 INSERT `onConflictDoUpdate` 一起覆写 |
| 任务删除 / GC | 归档随 `runs/{taskId}` 目录跟随现行清理策略（与 doc_versions 一致，本 RFC 不新增清理义务） |

## 6. 测试策略（必写 case）

后端（bun test）：

1. **runner 归档**：path<md> 端口（相对 / 绝对指 iso 内 / `./` 前缀）→ archive_json 形态正确、
   content 规范化为容器相对、归档文件 body 与源一致。
2. **list<path<md>> 逐项归档**：item 顺序与 `splitListItems` 一致；content 逐行规范化行序不变。
3. **oversized**：>2 MiB 截断 + truncated 标记；INSERT 后行可读。
4. **K1 必达（集成）**：agent 在 iso 写 gitignored 文件并输出端口 → merge-back 后 scope
   canonical 可见该文件（现状红）。
5. **wrapper 内 review（主回归，现状红）**：git/loop wrapper 内 agent 产出 path<md> → review
   弹出的 doc_version body = 文件内容而非占位（单文档 + 多文档两条）。
6. **回退链**：archive_json NULL + scopeRoot 下文件在 → body 来自 worktree；两者皆无 →
   `source: 'missing'` + 现占位文案。
7. **API**：成员可读 / 非成员 403（与 worktree-files 同形）/ 跨任务 nodeRunId 404 /
   无归档回退 404。
8. **workgroup host run 不归档**（persistDeclaredOutputs=false 路径零 archive 文件）。
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
