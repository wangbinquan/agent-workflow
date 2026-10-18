# RFC-377 实施计划

单批次交付（代码、测试、守卫一起），由 Codex 实施、本会话审核后提交。所有改动先全部完成，再集中验证一次（CLAUDE.md 文首硬规则）。

## 任务

| 编号 | 内容 | 文件 |
| --- | --- | --- |
| RFC-377-T1 | 14 个子模块原语原样下沉到 `util/git.ts` 末尾；L7 增加 shared `redactGitUrl` import；`checkoutMergedGitlinks` 改调本地函数，删除其 3 处动态 import | `packages/backend/src/util/git.ts` |
| RFC-377-T2 | `CreateWorktreeOptions` 增加必填 `resolveSubmoduleParams`，另三个入口复用其类型；四个入口在原动态 import 的位置调用 `opts.resolveSubmoduleParams(opts.submoduleMode, opts.submoduleJobs)`；删除其余动态 import 与旧注释；修正 L565-570 陈旧文档；L2765-2767 注释改写时不得在 `.gitmodules` 门之前写出 `runGit(` | `packages/backend/src/util/git.ts` |
| RFC-377-T3 | 门面瘦身：删除已下沉代码，从 `@/util/git` 引入剩余所需符号，只再导出生产在用的 5 个函数与 `SubmoduleMode` 类型；更新头注释与 L167-173 | `packages/backend/src/services/gitSubmodule.ts` |
| RFC-377-T4 | 生产注入：`workspaceMaterializer.ts` L24 import 增加 `resolveSubmoduleParams` 并在 L141 传入；`isolation.ts` 新增 import 并在 8 个调用点传入，修正 L46-47 注释；`gitRepoCache.ts` L56-58 注释改为「util/git 不 import 配置或本模块，由调用方注入」（保持 3 行，避免后续行号漂移） | `modules/source-control/infrastructure/workspaceMaterializer.ts`、`platform/workspace/local/isolation.ts`、`services/gitRepoCache.ts` |
| RFC-377-T5 | shared 注册改注入（design §3），更新 list.ts 头注释 | `packages/shared/src/outputKinds/list.ts`、`registry.ts` |
| RFC-377-T6 | frontend：新建 `RoleBadge.tsx`；`ConversationFlow` 以 children 传入嵌套流并删除原 `RoleBadge`；`SubagentBlock` 接收 `children` | `packages/frontend/src/components/node-session/{RoleBadge,ConversationFlow,SubagentBlock}.tsx` |
| RFC-377-T7 | 既有测试的 40 处直接调用补 `resolveSubmoduleParams`（取自 `@/services/gitRepoCache`，与生产同一函数）：`gc.test.ts:44`；`git.test.ts:138,159,176,184,191,192`；`helpers/repositoryLaunchContracts.ts:197`（并在 L65、L273 的 `Omit<…>` 中加入 `'resolveSubmoduleParams'`）；`rfc098-snapshot-pin.test.ts:107`；`rfc248-git-primitives.test.ts:68,82,89,113`；`rfc303-worktree-abort-cleanup.test.ts:109,163`；`scheduler-audit-gap3-gc-terminal-statuses.test.ts:138`；`worktree-submodule-init.test.ts:93,106,122`；`worktree-working-branch.test.ts:88,100,114,153,177,202,247,294,315,325,346,361`；`rfc130-iso-worktree-primitives.test.ts:85,196,242,275`；`rfc243-registry-mutex.test.ts:81`；`rfc210-nonroot-and-uninitialized-gitlinks.test.ts:261,319,352` | `packages/backend/tests/**` |
| RFC-377-T8 | 只被测试使用的下沉符号改从 `@/util/git` import：`git-submodule.test.ts:12-13`、`rfc210-new-submodule-topology.test.ts:36`、`rfc210-subrepo-snapshot-rollback.test.ts:31-32` | `packages/backend/tests/**` |
| RFC-377-T9 | 新增测试（design §6.1 第 1～5 项） | `packages/backend/tests/rfc377-util-git-leaf-lock.test.ts`、`rfc377-submodule-policy-injection.test.ts`、`rfc210-config-wiring.test.ts`、`packages/shared/tests/output-kinds-registry.test.ts`（以实际位置为准）、`packages/frontend/tests/node-session-recursive-render.test.tsx` |
| RFC-377-T10 | `.dependency-cruiser.cjs`：删除两处 `@ledger KNOWN_VIOLATIONS` 标记块并更新说明文字（design §7） | `.dependency-cruiser.cjs` |
| RFC-377-T11 | 在最终报告中给出 `scripts/depcheck.ts` 的替换文本、`ledger-baselines.json` 与 `guard-manifest.json` 的条目（design §7）；**不直接修改这些文件** | — |
| RFC-377-T12 | 文档更正：RFC-294 `plan.md` W5 行「8 条」→ 7 条并指向本 RFC、§3 S8 小节链接本 RFC；RFC-294 `design.md` §15 中 util/git 物理迁移归 W5 余项（§4.3）。**已由审核方在立项提交中完成，实施方不改 RFC-294 文档**；`status.md` 是生成物、dated review 是快照，均不手改 | — |

依赖：T1 → T2 → T3/T4；T5、T6 独立；T7/T8 依赖 T1～T3；T9 依赖 T1～T6；T10、T11、T12 独立。

## 实施约束

- 只改上表文件与它们直接需要的测试；改动前用 `git status --porcelain -- <path>` 确认文件没有他人未提交改动，有则停下并在报告中说明。
- 不改 `scripts/depcheck.ts`、根目录 `architecture/**`、`tests/architecture/rfc294Canonical.ts` 与 RFC-294 `status.md`。
- 不 `git add` / commit / push；不运行 census。
- 不修改 `services/gitVersion.ts`（去掉两条上行边后它不在任何环上）；不做与本 RFC 无关的清理（例如 RFC-375 的死代码删除）。

## 验收清单

- [ ] `util/git.ts` 无上层 import（锁测试含负例通过）
- [ ] 四个入口的 resolver 注入与时机测试通过；`never` / 默认的生产接线测试通过
- [ ] 门面身份测试通过
- [ ] shared registry 测试通过
- [ ] frontend 渲染测试与既有 node-session 测试通过
- [ ] design §6.2 既有测试通过（SQLite；需要网络的用例由 CI 覆盖）
- [ ] `bun run depcheck` 只报 7 条过期条目（应用 T11 后全绿）
- [ ] 后端 / shared / frontend typecheck 通过（他人在制文件的错误单列）
- [ ] 审核方应用 T11 后提交、生成投影、推送；exact SHA CI 绿

## 提交编排（审核方）

1. 应用 T11 的 `scripts/depcheck.ts` 改动，重跑 depcheck 与锁测试。
2. 按路径提交内容（含 T11 的 `ledger-baselines.json` 与 `guard-manifest.json` 手改）。
3. 旧账本制度下：以内容提交为源跑 census 并提交投影；`cross-context-observed-imports` +1 需一次性 `allowGrowth`，紧接一笔退许可提交，三笔一次推送。RFC-376 已落地时只更新其计数文件。
4. 推送后按 exact SHA 跟踪 GitHub Actions。
