# RFC-310 · PR-0 T0 基线盘点（inventory manifest）

> 状态：✅（2026-08-18 盘点；计数按下方锚定 commit 与源码对拍）。
> 用途：cutover/删除清单（design.md §13）的账本起点；PR-9/PR-10 按本清单逐项销账。
> 各节标注 owner 与 remove wave（`keep` = 不删除，`W9`/`W10` = 在 PR-9/PR-10 处置）。

## 0. exact baseline

- 盘点锚定 commit：`d1f3c854`（RFC-310 裁决修订提交；design.md §0.2 钉的 `2bdfbd51` 之后仅两个文档 commit，无代码漂移）
- 后续每批动手前 `git pull --rebase`，若他人 push 触及下列面则增量修订本账本。

## 1. code-capability 旧调用面（owner: development-automation cutover · W9/W10）

- 模块体量：`modules/code-capability/` 共 108 文件 / 22,377 行（application 31、composition 8、domain 52、infrastructure 11、ports 3、public 3）。
- 五能力联合：`domain/stageContract.ts:26-33` `CODE_CAPABILITIES = mr-review|mr-comment-fix|requirement|ci-fix|mr-monitor`；唯一 parse 入口 `:57`。
- StageDef 四臂：program / script(scriptSlot) / ai(aiSchema+agentSlot) / invoke；hook 注入面 = `StageBase.injectable`（`:72-121`），无独立 hook 字段。
- 删除判据（PR-10 T104/T105）：`CODE_CAPABILITIES` 旧五联合、`mr-monitor` contract、任意 script/hook 写树路径的生产调用清零。

## 2. arbitrate / select 决策脚本入口（W10 删除）

- 槽位名单：`application/monitorScripts.ts:26` `MONITOR_SCRIPTS = ['collect','classify','arbitrate','select']`。
- 唯一运行时执行器：`application/monitorLoop.ts:166 runMonitorWake`（arbitrate 段 `:285-300`、select 段 `:352-365`）。
- 契约声明：`domain/capabilityRegistry.ts:391-450 CI_FIX_CONTRACT`；绑定点 `composition/scriptStages.ts:77 buildScriptStages`（`SCHEMA_BY_SLOT.arbitrate` `:58`）。
- 解析：`services/codeCapabilityScripts.ts:86 resolveMonitorScripts`；持久化列注释 `db/schema.ts:4460`。
- 生产 `arbitrate` 词频 35 处，全部收敛于上述两条链（monitorLoop 运行时 + registry/scriptStages 声明）。

## 3. 通用 code-host action 调用面（W10 收缩为 closed union）

- 定义：`modules/code-capability/ports/codeHostPort.ts:22-38` `CodeHostCall{action: string; params: Record<string,string>}`（38 行 mega-port；shared 闭合枚举 `packages/shared/src/codeHost/actions.ts:29` 存在但 port 故意退化为 string）。
- 唯一实现 `infrastructure/codeHostAdapter.ts:53`；`.call(` 生产调用 27 处 / 11 文件（fetchDiff、invalidatePending、monitorLoop、mrVoice×4、publishReview×9、recoverPublishIntents、mrCommentFixStages×3、mrReviewStages×4、requirementStages×2 + services/codeCapabilityWake、codeCiEventTarget:87）。
- 实际 action 字面量 12 个：comment.create/list/update/reply-thread、thread.resolve、mr.create/get/diff/list、review.submit/draft-create/draft-discard/draft-publish。
- RFC-310 新路径改用 closed `DevelopmentCodeHostEffect`（无 merge/approve/resolve/custom）；T7 ratchet 禁止新路径消费 `CodeHostCall`。

## 4. 旧 writer 入口（W9 freeze、W10 删除）

- HTTP：`routes/code.ts:406-433` `POST /api/code/rounds`（`code-rounds:launch`）+ 同文件另 9 条 `/api/code/*` 路由。
- `openRound` 唯一定义 `infrastructure/sqliteMonitorStore.ts:153`；生产调用 4 处：`launchRoundCommand.ts:225`、`monitorLoop.ts:385`、`services/codeCapabilityWake.ts:470`、`services/codeCapabilitySupersede.ts:284`。
- webhook 链：`services/webhook/webhookDispatch.ts:13/38` → wake → openRound；任务化 `services/codeRoundLaunch.ts:47/74`（execution kind `code-round`，trigger 侧 `services/codeCapabilityTrigger.ts:34/65`）。

## 5. cross-context import 现状与既有 ratchet（keep，扩展）

- code-capability 跨模块 import 仅 3 处，全部 `@/modules/task-execution/public/participants`（type-only，合法）；大量 `@/services/*`/`@/db/*` 依赖属横向平铺债，随 cutover 收敛。
- 核心 ratchet：`tests/rfc294-architecture-preflight.test.ts`（1278 行）——public 入口恰为五名、跨 context 深 import（含 type-only/dynamic/re-export）、敏感类型泄漏、god-port 度量；`:1253` `toEqual` 钉 2 条跨 context 债 + `:1264` 1 条非 exact 入口债（integration/public/mrTerminalControl.ts）。**新增/删除一条即红 ⇒ RFC-310 各批必须显式修订账本**。
- 其余相关 ratchet：`depcheck-gate`（第一方边零未解析）、`rfc217-architecture-locks`、`rfc282-a1-eslint-boundary`（runtime 目录唯一门面）、`rfc284-spawn-site-ratchet`（spawn 站点 allowlist，**新 spawn 需登记**）、`rfc303/305-architecture-lock`、`rfc294-background-worker-boundary`。depcruise 配置 `.dependency-cruiser.cjs`（含 `no-production-to-system-mocks`）。

## 6. RFC-294 骨架惯例参照（T1 遵循）

- `identity-access`：public 五入口齐全（commands 3 / queries 1 / participants 16 / events 2 / types 5）+ `composition.ts:43 composeIdentityAccess(db)`；装配散点 `server.ts:30`、`auth/actor.ts:14`、`services/users.ts:18`。
- `source-control`：participants-only（participants 3 / types 7）+ `composition.ts` 3 个 bind 函数；装配散点 scheduler/fusion/commitPushRunner/task。
- **全仓无 `bootstrap/` 单点、无 `composition/required-ports.ts` 先例**——RFC-310 首创 required-ports 约定；装配沿用「exact composition entrypoint + 既有装配散点」惯例，不在本 RFC 造全局 bootstrap 目录（偏离记录见 pr0-go-no-go.md A1）。
- task-execution 有 `inbound/`（唯一）；integration 的 `public/mrTerminalControl.ts` 是被 preflight 记账的存量债，勿模仿。

## 7. runtime env / Git identity 注入锚点（T4/T44 对象）

- OpenCode：`services/runtime/opencode/spawn.ts:162 buildOpencodeEnv`（`{...process.env, PWD, OPENCODE_CONFIG_CONTENT…}`，字面量被 `opencode-spawn-pwd-env.test.ts` 源码锁）；**Git identity 注入 `:218-225`**（gitName/gitEmail 双非空才写 GIT*AUTHOR/COMMITTER*\*）。
- Claude：`services/runtime/claudeCode/spawn.ts:284 assembleClaudeEnv`（复制 process.env + PWD + 可选 IS_SANDBOX）；**identity 注入 `:298-303`**；sandbox 设置 `boundary.ts:103/107`（allowWrite 含 gitMetaDirs）。
- 门面：`services/runtime/index.ts:31 getRuntimeDriver`（刻意非 barrel）。
- 其他 git identity 写点（平台侧，keep）：`util/git.ts:72-74/111-113/1171`、`modules/source-control/application/repositoryCommit.ts:217-223`、`services/commitPushRunner.ts:588-593`、`services/scriptRun.ts:400-402`。
- 数字员工 profile（T43/T44）：不调用 identity 注入分支；env 继承现状保留（2026-08-18 裁决）。

## 8. system-mocks 包现状（裁决④落点，T6/T36/T70 扩展）

- `packages/system-mocks/`（`@agent-workflow/system-mocks`，44 文件，runnable：bin `agent-workflow-system-mocks`，`src/cli.ts` → `startSystemMockSuite`）。
- 聚合网关 `src/suite.ts:97 SystemMockGateway`（单端口按 service 前缀分发）；现有能力：code-host（gitlab+github stateful，seed/mutate/reset 控制面）、webhook 投递、真 git smart-HTTP remote（`src/git/http.ts:69`）、OIDC/OAuth、包 registry、MCP http+stdio、external-http、SCIP。
- **fake runtime**：`src/runtime/dispatch.ts` + 15 个 `mode-*.ts` 场景，被 81 个 backend 测试引用；T4 probe 与后续 Agent E2E 在此新增 mode。
- RFC-310 需新增：requirement provider mock、pipeline provider mock（多 gate、大流式日志、partial/outage/head race）→ 新 service 前缀挂进 suite。
- 生产隔离由 depcruise `no-production-to-system-mocks` 锁定。

## 9. exact-key codec 既有惯例（T3 遵循）

- 无共享 codec helper；惯例 = zod `.strict()` + 独立语义 check（`domain/reviewEnvelope.ts:28/45/86` 是分层范本）；code-capability domain 内 27 处 `.strict()` / 7 文件。
- unknown-key 报账现成实现：`packages/shared/src/capabilityParams.ts:270/319-323 unknownKeys`。
- 旧 envelope 文本通道 `services/envelope.ts`（694 行，`:443 parseEnvelope`）与 zod 路线并存——RFC-310 Agent envelope 沿 zod strict 路线，不复用旧文本通道。

## 10. migration 序号现状

- 目录 `packages/backend/db/migrations/`（不在 src/db）；最大编号 `0175_rfc309_template_base_snapshot.sql` ⇒ **RFC-310 从 `0176_` 起**。加迁移必 bump `upgrade-rolling.test.ts` journal-count；`when` 用上条 +86400000。

## 11. workspaceConvention 现状（T32 扩展）

- `packages/shared/src/workspaceConvention.ts:7-11` 官方子目录恰 3 个：inputs/runs/fusion；10 个导出；消费者 14 文件（生产 9 + 测试 5）；code-capability 下 0 消费者。
- T32：新增 `pipeline` kind 与 `inputs/requirements` safe helper，保持零依赖。

## 12. determinismGuard 两级尝试台账现状（复用）

- `modules/code-capability/application/determinismGuard.ts`：`RetryBudget{sameSession, freshSession}`（默认 `{2,1}`，`composition/capabilityWiring.ts:61`）；计数器 `rerunSeq`（fresh 轮）/`attemptSeq`（同会话序）；`:122 runGuardedAiStage` 双层循环，`:137-138` fresh 轮清 session/feedback；台账表 `code_ai_attempts`（`infrastructure/sqliteAttemptRecorder.ts`）。
- RFC-310 `AgentAttempt.rerunSeq/attemptSeq`（design §7.1）与此命名对齐；PR-4 T49/T50 在新 context 重建台账并补 whole-workspace 回退。

## 13. 真实 runtime 子进程测试惯例（T4/T52 遵循）

- 主流形态：stub runtime（`system-mocks/src/runtime/dispatch.ts`）+ **生产 spawn builder 推导 invocation**（`tests/e2e-runtime-scenario-stub.test.ts:13-14` 用 `buildClaudeSpawn`/`buildCommand`），golden 落 `tests/fixtures/stub-goldens/`。
- opt-in 真二进制：`tests/integration-opencode/*.integration.test.ts`（`RUN_OPENCODE_INTEGRATION=1` + 真凭据，nightly workflow）。
- 发版级：`e2e/release-runtime.spec.ts`（`RUN_LIVE_RUNTIME_E2E=1`）。
- 辅助：`tests/helpers/testCommand.ts:23 runTestCommand`（异步 spawn+竞速 SIGKILL）、`helpers/gitHttpRemote.ts`（真 smart-HTTP remote）。
- T4 probe 形态：生产 spawn builder 组装 env/argv + stub runtime 新增攻击 mode + `helpers/rfc310MetaSnapshot.ts` 对拍。
