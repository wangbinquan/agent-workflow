# RFC-377 设计：util/git 叶子化与 `KNOWN_VIOLATIONS` 清零

基线 HEAD `b76a88e70`；行号仅作定位提示，实施时以当时源码为准。

## 1. 现状（已核实）

### 1.1 `util/git.ts` 的反向依赖

`util/git.ts` 没有对 `services/`、`modules/`、`platform/` 的静态 import，上行边只有 10 处动态 import：

| 所在函数（HEAD 行号） | import 行 | 取用符号 |
| --- | --- | --- |
| `createWorktree` L992-1202（加 worktree 之后的块 L1134-1191，处在 `try` 内，`catch` 负责清理） | L1147-1148 | `syncSubmodules`、`resolveSubmoduleParams` |
| `createIsolatedWorktree` L2886-2912 | L2908-2909 | `syncSubmodules`、`resolveSubmoduleParams` |
| `alignWorktreeGitlinks` L2933-2949 | L2943 | `resolveSubmoduleParams` |
| `materializeTree` L3176-3254（第 ⑤ 步） | L3223-3224 | `syncSubmodules`、`resolveSubmoduleParams` |
| `checkoutMergedGitlinks`（私有，递归，L3278-3533） | L3304；L3413-3414；L3483 | `readDeclaredSubmodulePaths`；`attachSubmoduleFromPool`、`resolveSubmodulePool`；`snapshotSubmodule`、`subSlug` |

被取符号的真实依赖：

- `syncSubmodules`（`services/gitSubmodule.ts:84-165`）、`readDeclaredSubmodulePaths`（L444-492）、
  `attachSubmoduleFromPool`（L527-617，连同 `submoduleNameForPath` L494-525）、`resolveSubmodulePool`（L361-400，连同
  `submoduleGitDir` L350-359）、`snapshotSubmodule`（L713-742，连同 `SubSnapshot` L703-711，它又回调 util/git 的
  `snapshotFullState`）、`subSlug`（L317-330）：只依赖 `runGit`、fs、`sha1Hex` 与 shared 的 `redactGitUrl`，是纯 git 原语。
- `resolveSubmoduleParams`（`services/gitRepoCache.ts:443-496`）是**唯一真正的上层依赖**：在 `existsSync` 门后
  `loadConfig(Paths.config)` 读设置，并读 `services/gitVersion.ts:48-50` 的进程内能力缓存（`cli/start.ts` 启动时填充）。
  优先级：显式参数 → 设置 → 默认（`auto` / 4 / `remote:false`），再做能力钳制。生产调用全部传 `undefined, undefined`。

### 1.2 四个入口的调用方

- `createWorktree`：生产唯一调用方 `modules/source-control/infrastructure/workspaceMaterializer.ts:141-156`
  （`materializeWorktree` 内；该文件 L24 已从 gitRepoCache import 了 `listAvailableRefs`、`resolveCachedRepo`）。
- `createIsolatedWorktree`、`alignWorktreeGitlinks`、`materializeTree`：生产调用只在
  `platform/workspace/local/isolation.ts`——`createIsolatedWorktree` L447-454、`alignWorktreeGitlinks` L470-474、
  `materializeTree` L1317、L1337、L1426、L1793、L1902、L1949。该文件 L48-63 已静态 import `@/services/gitSubmodule`。
- 测试直接调用共 40 处、12 个文件（清单见 plan T7）。

### 1.3 SCC 结构

上行边只有 util/git → gitSubmodule、util/git → gitRepoCache 两条（都是动态 import）。去掉之后后端 git 族是 DAG：
gitRepoCache → {gitVersion, gitSubmodule} → util/git，无需再拆其他边。

### 1.4 shared 与 frontend

- `packages/shared/src/outputKinds/list.ts:29-34` 值引用 registry 的 `getHandlerForParsedKind`、`splitPortItems`、
  `joinPortItems`；`registry.ts:151` 默认导入 list handler，并在 `PARAMETRIC_HANDLERS`（L154-160）注册。其他 handler 只从
  registry 取类型。
- `ConversationFlow.tsx:9` import `SubagentBlock`（subagent 分支 L106-107）；`SubagentBlock.tsx:9` import `ConversationFlow`
  与 `RoleBadge`（定义在 `ConversationFlow.tsx:111-135`），只在展开时渲染 `<ConversationFlow tree={child} nested />`（L54）。
  没有其他文件 import `RoleBadge` / `RoleVariant`。

## 2. 后端设计：原语下沉，只注入策略

### 2.1 原语下沉到 `util/git.ts`

把下列 14 个顶层符号**原样**移入 `util/git.ts`，追加在文件末尾（`deleteIsoRefs` 之后，避免挪动既有符号的行号）：
`SubmoduleMode`、`SubmoduleSyncOptions`、`SubmoduleSyncResult`、`detectSubmodules`、`defaultRedact`（私有）、`syncSubmodules`、
`readDeclaredSubmodulePaths`、`submoduleNameForPath`、`attachSubmoduleFromPool`、`submoduleGitDir`、`resolveSubmodulePool`、
`SubSnapshot`、`snapshotSubmodule`、`subSlug`。这些名字在 util/git 里都不存在。唯一新增的 import 是 shared 的 `redactGitUrl`。
`checkoutMergedGitlinks` 改为直接调用本文件函数，其三处动态 import 删除。

迁移时保留 RFC-210 的注释，把「为什么放在这里」改写为当前事实（原语归 git 原语层；策略由调用方注入）。

### 2.2 策略注入

在 `CreateWorktreeOptions` 增加**必填**字段：

```ts
resolveSubmoduleParams: (
  mode: SubmoduleMode | undefined,
  jobs: number | undefined,
) => { mode: SubmoduleMode; jobs: number; remote: boolean }
```

`CreateIsolatedWorktreeOptions`、`alignWorktreeGitlinks` 的 opts、`materializeTree` 的 opts 复用
`CreateWorktreeOptions['resolveSubmoduleParams']` 类型（不新增导出符号）。

- **必须是必填**：内置默认值会重现 RFC-210 G9 缺陷（设置被静默忽略，见 `gitRepoCache.ts:448-460` 与
  `rfc210-config-wiring.test.ts` 头注释）。
- **调用位置与原动态 import 完全相同**：`createWorktree` 中仍在加 worktree 之后的 `try` 内调用，resolver 抛错照旧触发
  清理；`materializeTree` 仍在 ①～④ 之后。`syncSubmodules` 的调用形状不变——只有 `createWorktree` 传 `remote`，
  `createIsolatedWorktree` 与 `materializeTree` 不传（RFC-210 G8）。
- `rfc287-t13-deferred-prep.test.ts:1745-1753` 要求 util/git 保留字面量 `return await syncSubmodules(worktreePath, {`
  且 `signal: opts.signal` 出现在下一个 `\n      })` 之前——调用文本保持逐字不变。

### 2.3 注入点

- `workspaceMaterializer.ts`：扩展 L24 的 gitRepoCache import，在 L141 的 options 里加 `resolveSubmoduleParams`。
- `platform/workspace/local/isolation.ts`：新增 `import { resolveSubmoduleParams } from '@/services/gitRepoCache'`，在 §1.2
  列出的 8 个调用点传入；修正 L46-47 的注释。该文件已 import `services/gitSubmodule`，所以不新增依赖方向。

所有入口（主进程、maintenance worker、任务镜像助手）原本就静态加载这两个模块，加载集不变。

### 2.4 门面 `services/gitSubmodule.ts`

删除已下沉的代码，改为从 `@/util/git` 引入剩余代码所需的符号，并**只再导出生产代码在用的下沉符号**：

```ts
export { detectSubmodules, resolveSubmodulePool, subSlug, submoduleGitDir, syncSubmodules } from '@/util/git'
export type { SubmoduleMode } from '@/util/git'
```

只被测试使用的符号不再导出，测试改为从 `@/util/git` 取（避免新增「仅测试使用的再导出」）。更新文件头与 L167-173 注释。

### 2.5 否决的方案

- **由 util/git 拥有的 7 成员端口 + services 侧适配器**：把避环手段固化为永久接口（连 `subSlug` 都要注入），
  `snapshotSubmodule → snapshotFullState` 的回环仍在；若适配器单独成文件，还要在 RFC-294 生成器里登记新的 legacy 文件。
- **模块级 setter**：RFC-294 design §1.3 明确禁止。
- **新建 `util/gitSubmodule.ts`**：它需要 `runGit` 与 `snapshotFullState`，会形成 util 内部新环。
- **把子模块感知的组合函数挪进 platform**：破坏 `rfc243` 的计数锁，且 `createWorktree` 仍无解。
- **在 isolation.ts 的调用方注入**：要改 5 个导出签名，横跨 RFC-370 正在改的文件，并新增跨 context 边。

## 3. shared 设计：注册改为注入

- `list.ts` 导出 `createListHandler(registry)`，参数为内联类型
  `{ getHandlerForParsedKind(p); splitPortItems(p, raw); joinPortItems(p, items) }`；`listValidationPolicy` 成为工厂内闭包；
  函数体除把三个调用改为 `registry.*` 外逐字不变；删除 `const handler` 与 `export default handler`；所有来自 `./registry`
  的 import 改为 `import type`。
- `registry.ts:151` 改为 `import { createListHandler } from './list'`，`PARAMETRIC_HANDLERS` 中把 `listHandler` 换成
  `createListHandler({ getHandlerForParsedKind, splitPortItems, joinPortItems })`。函数声明会提升；工厂只捕获、不立即调用
  registry 函数。
- 结果：handler 顺序、`getHandlerForParsedKind` 身份与行为不变，list 先于 registry 初始化的隐患消失。更新 list.ts 头注释。

## 4. frontend 设计：children 注入

- 新建 `components/node-session/RoleBadge.tsx`，原样移入 `RoleVariant` 与 `RoleBadge`（类名、i18n、CSS 都不变）。
- `ConversationFlow.tsx` 从 `./RoleBadge` 取 `RoleBadge`；subagent 分支改为
  `<SubagentBlock call={message}>{message.child !== null ? <ConversationFlow tree={message.child} nested /> : null}</SubagentBlock>`；
  删除原 `RoleBadge` 定义；更新头注释。
- `SubagentBlock.tsx`：从 `./RoleBadge` 取 `RoleBadge`，props 增加 `children?: ReactNode`，L54 改为渲染 `{children}`；
  `child` 仍用于 `captureMissing` 判定。
- DOM 不变的理由：元素对象虽然提前创建，但只在 `open` 时渲染；插槽位置不变；`false` 与 `null` 渲染相同；空状态仍在
  `ConversationFlow`（`async-state-gate-source-guard.test.ts:122` 要求它只出现一次）。
- 这是纯重构，复用既有组件，不新增样式。

## 5. 为什么本 RFC 不把 util/git 迁入 source-control

util/git 有 53 个 src importer（20 个 legacy、33 个 module）与 194 个测试 importer；迁入模块会制造大量新的 legacy→module 边，
`util/git.ts` 的转发门面本身就是 util→modules 边，`platform/workspace/local/isolation.ts` 还会因此 import 模块（RFC-294
§13.1 禁止 platform → modules），且不少 importer 正被 RFC-370 改动。RFC-294 plan §3 S8 只要求叶子化，物理迁移归 §4.3 W5
余项。本 RFC 同步更正 RFC-294 design §15 中把迁移归给 S8 的那一行。

## 6. 测试策略

### 6.1 新增

1. **`packages/backend/tests/rfc377-util-git-leaf-lock.test.ts`**（锁测试，需登记 guard-manifest）
   - 用 `tests/architecture/census.ts` 的 `sourceUnit` / `importEdges` 扫 `util/git.ts`，`forbiddenEdges(text)` 报告除
     `@agent-workflow/shared`、`@/util/*`、`./*` 以外的任何一方 specifier（值、类型、静态、动态、`import type`、
     `typeof import()`、`export … from` 都算），断言为 `[]`。
   - 负例（字面量源码）：`await import('@/services/gitSubmodule')`、`import type … from '@/modules/source-control/public/types'`、
     `typeof import('@/services/gitRepoCache')`、`export {…} from '@/platform/…'`、`import … from '../services/gitVersion'`，
     以及一个干净样例。
   - 门面身份：`detectSubmodules`、`resolveSubmodulePool`、`subSlug`、`submoduleGitDir`、`syncSubmodules` 在
     `services/gitSubmodule` 与 `util/git` 中 `toBe` 同一对象。
   - `KNOWN_VIOLATIONS` 中 `rule` 为 `no-circular` 或 `no-util-to-upper` 的条目为空；对一个伪造环
     `evaluateCruises([...], KNOWN_VIOLATIONS)` 判为未知违规并阻断（不断言整个清单为空，RFC-376 可能新增规则）。
   - 顶层常量不要命名为 `ALLOWED_*`、`*ALLOWLIST*`、`EXEMPT*`、`*DEBT*`（会被账本类守卫当成账本）。
2. **`packages/backend/tests/rfc377-submodule-policy-injection.test.ts`**（本地仓库、无网络）
   - `createWorktree` 以 `(submoduleMode, submoduleJobs)` 调用 spy resolver 恰好一次，且发生在
     `post-add-before-submodules` 阶段之后。
   - 源仓库提交一个只有 `.gitmodules`、没有 gitlink 的场景：resolver 返回 `never` 时 `hasSubmodules:false`，返回 `auto` 时
     `true`。
   - resolver 抛错时 `createWorktree` 以同一错误 reject，且清理已执行（worktree 路径与分支 ref 都不存在）。
   - `createIsolatedWorktree`、`alignWorktreeGitlinks`、`materializeTree` 各以调用方参数调用 resolver 一次。
3. **生产接线**（加入 `rfc210-config-wiring.test.ts`）：`AGENT_WORKFLOW_HOME` 下 `config.json` 为
   `{ gitRecurseSubmodules: 'never' }` 时，对带 `.gitmodules` 的仓库 `materializeWorktree` 返回
   `hasSubmodules:false, submoduleInitOk:true`；无配置时为 `true`。isolation.ts 至少有一条源码断言：8 处调用传入的是
   从 gitRepoCache import 的 `resolveSubmoduleParams`。
4. **shared**（加入 `output-kinds-registry.test.ts`）：用假 registry 构造 `createListHandler`，校验逐项校验、拆分、合并都委托
   给注入函数；`PARAMETRIC_HANDLERS` 中 list 位置上的 handler 就是 `list<string>` 解析到的 handler。可选：子进程
   `bun -e` 先 import `outputKinds/list` 再 import `registry`，断言 5 个 handler 都有定义。
5. **frontend**：新增 `packages/frontend/tests/node-session-recursive-render.test.tsx`——`SubagentBlock` 只在展开时、在
   `.session-subagent__body` 内回退内容之后渲染 `children`；无 children 时即使 `call.child` 非空也不渲染 `.session-flow`；
   `ConversationFlow` 折叠时无 `.session-flow--nested`，展开后 body 的最后一个子元素是
   `.session-flow.session-flow--nested` 且包含子消息，嵌套树为空时显示空状态；`RoleBadge` 的变体类名与 `aria-hidden` 图标。
   不要往 `subagent-block-nested.test.tsx` 里加 `toEqual([])`、`toHaveLength(0)`、`toBe(0)`、`.not.toContain/toMatch`
   一类断言（会改变它在 guard-manifest 里的分类）。

### 6.2 必须保持全绿的既有测试

- createWorktree / materialize 路径：`git`、`worktree-working-branch`、`worktree-submodule-init`（CI 设 `RUN_GIT_NETWORK=1`）、
  `rfc303-worktree-abort-cleanup`、`rfc248-git-primitives`、`gc`、`rfc098-snapshot-pin`、`scheduler-audit-gap3-gc-terminal-statuses`、
  `rfc362-launch-contracts`、`rfc199-start-task-workflow-race`、`rfc363-frozen-materialization`、
  `rfc363-preparation-process-recovery`、`task-start-pre-worktree`、`rfc287-t13-deferred-prep`、`rfc287-t14b*`。
- isolation / materialize：`rfc130-iso-worktree-primitives`、`rfc243-registry-mutex`、全部 `rfc210-*`、`rfc187-merge-salvage`、
  `rfc356-iso-key-generations`、`rfc370-v3-commit-push-merge-back-race`、`rfc370-v3-hosted-isolation-merge-back`、
  `rfc370-v3-isolation-submodule-agent-paths`、`rfc370-isolation-native-compatibility`、`commit-push-runner`。
- 策略与缓存：`rfc210-config-wiring`、`git-version-caps`、`rfc130-git-version-gate`、`git-repo-cache`、`git-repo-cache-submodule`、
  `cached-repos-http-submodule`、`rfc287-t11*`、`rfc370-submodule-refresh-configuration`。
- 原语：`git-submodule`、`rfc252-git-hardening`、`rfc210-submodule-topology`、`rfc210-subrepo-snapshot-rollback`。
- 文本锁（改动不得破坏）：`rfc287-t13-deferred-prep`（见 §2.2；以及 gitRepoCache 内两处 `syncSubmodules(row.localPath, {`）、
  `rfc210-subrepo-snapshot-rollback.test.ts:199-211`（`hasDirtySubmoduleContent` 中 `.gitmodules'` 门在任何 `runGit(` 之前）、
  `rfc243-registry-mutex.test.ts:96-100`（`withWorktreeRegistryLock(opts.repoPath` 至少 3 处）、`rfc254-git-windows`、
  `rfc254-platform-surface-guard`、`rfc284-git-twin-textlock`、`rfc284-spawn-site-ratchet`、`git-noninteractive-env`、
  `source-text-rfc066-guards`，以及 rfc187 / rfc210 / rfc356 对 isolation.ts 的文本锁。
- shared：`output-kinds-registry`、`rfc080-parametric-runtime-migration`、`rfc193-kind-items-and-nested-guard`、
  `rfc317-port-codec-single-source`、`rfc370-output-validation-policy`。
- frontend：`conversation-flow-render`、`subagent-block-nested`、`session-role-badge`、`status-kind-tables`、
  `async-state-gate-source-guard`、`rfc317-dead-class-invariants`（`session-role-badge__label` 仍只出现一次）、
  `distill-detail-grep`、`session-tab-grep`。node-session 没有视觉基线。
- 架构：`depcheck-gate`、`rfc332-task-engine-contracts`（无 SCC 含 task-execution 文件）。

## 7. 守卫、账本与提交编排

RFC-294 生成器 `tests/architecture/rfc294Canonical.ts` 从**工作树**import `scripts/depcheck.ts` 的 `KNOWN_VIOLATIONS`
（即使 census 用 `--source-ref` 读已提交源码也是如此）。共享工作树上若留着未提交的 `KNOWN_VIOLATIONS` 修改，任何会话
此时跑 census 都会得到与已提交源码不一致的投影。因此：

- **实施方不改 `scripts/depcheck.ts`、根目录 `architecture/**`。** 需要的改动在最终报告里给出精确文本：
  - `scripts/depcheck.ts`：删除 7 条条目（`KNOWN_VIOLATIONS = []`）；重写 L44-48 头注释与 L84-88 说明（清单自 RFC-377 起为空；
    新增条目须带 why / removeWhen / removeWave、cruiser 的 `@ledger` 标记与显式增长理由）；删除分节注释。
  - `architecture/ledger-baselines.json`：`depcheck-known-violations` 7 → 0（旧账本制度仍在时）。
  - `architecture/guard-manifest.json`：新锁测试的条目（字段值用 `census.ts` 的函数算出）。
  审核方在提交时应用这些改动并立即生成投影。
- 实施方可以改 `.dependency-cruiser.cjs`：删除 L122-125 与 L173-176 两处标记块，更新 L119-121 的说明、L129-132 的
  `comment` 字符串、L165-172；新文字一律写在 `name: 'no-circular'` 之前，之后不得出现 `pathNot`（`depcheck-gate.test.ts:300-306`）。
  在 `KNOWN_VIOLATIONS` 由审核方清空之前，`bun run depcheck` 会把 7 条报为过期条目——实施方的验证口径是「depcheck 只报
  这 7 条过期、没有任何其他违规」。
- 旧账本制度下的提交（RFC-376 尚未落地时）：内容提交 → 以该提交为 `--source-ref` / `--seed-ref` / `--snapshot-sha` 跑 census
  的投影提交；本改动会让 `cross-context-observed-imports` +1（`workspaceMaterializer.ts → services/gitRepoCache.ts#resolveSubmoduleParams`，
  任何设计都至少要这一条），需要一次性 `allowGrowth` 与紧随其后的退许可提交。若 RFC-376 已先落地，则只需更新它的计数文件。

## 8. 与 RFC-294 目标架构的对齐

- 落位：source-control 目标 context 的 git 原语层。本 RFC 承担的演进：`util/git` 成为只依赖 util / shared 的叶子，
  子模块**策略**由调用方注入（设置读取仍在 legacy `services/gitRepoCache.ts`）。
- 留下的债：`util/git` 物理迁入 `modules/source-control/infrastructure`（W5 余项）；`platform/workspace/local/isolation.ts`
  仍 import `services/git*`（既有 platform → legacy services 边，不是 platform → modules）；`gitRepoCache` 的设置读取随 W5 归位。
- 无偏离项。

## 9. 失败模式

- resolver 缺省导致设置被忽略：类型上必填，测试锁定生产接线与 `never` 行为。
- 解析时机变化导致清理失效：调用位置与原动态 import 相同，测试覆盖 resolver 抛错时的清理。
- 门面漏导出导致生产 import 失败：typecheck 与门面身份测试兜底。
- 前端渲染差异：新增渲染测试 + 既有 node-session 测试。
