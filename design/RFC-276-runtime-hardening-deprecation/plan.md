# RFC-276 · 实施计划

> 状态：Done（2026-08-10）。自然 runtime 与默认关闭的 `IS_SANDBOX` 兼容开关已发布，
> exact-SHA CI/visual 终态成功。

## 1. 依赖与硬边界

- 先完成 RFC 三件套、索引、STATE 与用户实施批准，之后才能改 production/test。
- RFC-272 已于 2026-08-10 完成，且与本 RFC 重叠 OpenCode driver/launcher/identity/MCP readiness/
  skill addressing；实施前重读最终 diff/test，保留其 runtime-independent MCP/skill 用户目标。
- RFC-275 已于 2026-08-10 完成 DB boot/schema admission；开工时重读 `schema.ts`、
  `db/migrations/meta/_journal.json` 与最新 migration，严禁预占编号或改历史 SQL/meta。
- RFC-273/274 已完成；其 intent/workgroup 业务改动与本 RFC 无关，任何重叠文件按 live source 调和，不回滚。
- auth/ACL、secret/redaction、input/path/zip、DB recovery、process lifecycle、explicit permission/
  readonly 是禁止误删区；Claude CLI 的 `IS_SANDBOX=1` 改为 runtime profile 显式兼容开关，默认关闭，
  且不得被描述或实现为 sandbox 防护。
- 不落 `runtimeHardening=false`、`legacyProductionPath` 或双生产路径。可在隔离分支分批开发，
  但 shared main/release 只接受完整原子切换。
- 未经另行授权不 commit/push。

## 2. 任务分解

| 任务            | 内容                                                                                                                                                                                                                                               | 主要验收                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **RFC-276-T1**  | 三件套、RFC 索引、STATE、外部 OpenCode 1.18.14 源码锚、清理/保留/能力影响确认                                                                                                                                                                      | proposal C1–C12 与 AC-1–24；用户批准实施 |
| **RFC-276-T2**  | 锁定 live inventory/import graph；按 delete/transform/preserve 标注每个生产文件、测试、配置、API、UI、DB 列、doc；重验 RFC-272/275 完成态                                                                                                          | 无未归类命中；完成态差异已吸收           |
| **RFC-276-T3**  | 提取中性 `managedProcess`；移除 sandbox 参数/wrapper，保留 stream/PID/timeout/cancel/kill/drain/ENOENT/Windows tree                                                                                                                                | AC-11、AC-23；lifecycle mutation 必红    |
| **RFC-276-T4**  | OpenCode business 自然 CLI 唯一路径：inline config、selected resources、inventory/memory、full env、PWD、permission、resume                                                                                                                        | AC-1、AC-3、AC-5、AC-6、AC-9、AC-10      |
| **RFC-276-T5**  | OpenCode system/MCP playground/model listing/smoke 改自然路径；删除 direct verified launcher/readiness/control barrier                                                                                                                             | AC-1、AC-9、AC-13                        |
| **RFC-276-T6**  | Claude business/system/MCP playground 改自然 config/store/env；保留用户 permission mapping；managed skill attachment + worktree skill/独立 agent projection；output-only disposable workspace；`isSandbox` 兼容标记按冻结 runtime profile 显式开启 | AC-2、AC-4、AC-6、AC-7、AC-9、AC-10      |
| **RFC-276-T7**  | script 自然 env；删除 agent/script network；readonly 改 disposable iso/no-merge；接入 managed process                                                                                                                                              | AC-7、AC-8、AC-11、AC-24                 |
| **RFC-276-T8**  | 删除 containment/sandbox/verified/hermetic/sealed/netless/binary snapshot 源码与调用图；移除 coordinator wiring                                                                                                                                    | AC-1、AC-2、AC-17、AC-19                 |
| **RFC-276-T9**  | config/API/CLI/status/UI/i18n/error/event/docs 清理；旧 config 三键 atomic migration；runtime UI/API 增加默认关闭且明确非防护的 Claude `isSandbox` 兼容开关                                                                                        | AC-2、AC-16、AC-18、AC-21、AC-22         |
| **RFC-276-T10** | 前向 DB migration：中性 business/playground lease、去 provenance/store 列、active native-session reset、精确 private-store backup/cleanup                                                                                                          | AC-12–15、C7、C12                        |
| **RFC-276-T11** | RFC-272 自然能力 E2E；更新受影响 RFC 状态；删除/转换旧专属测试/fixture/snapshot，落 reverse architecture guard                                                                                                                                     | AC-9、AC-10、AC-17–19                    |
| **RFC-276-T12** | 点名 preservation gates、三平台测试、full local gate、真实 runtime probes、对抗性实现门、findings 闭环、升级/回滚演练                                                                                                                              | AC-1–24 全部可证伪                       |

## 3. 批次与提交建议

RFC 仍对应一个集成 PR/一次原子 shared-main 合入；内部按下列批次留可审阅 commit：

### Batch A · 可靠性原语与自然 OpenCode

- T3 + T4；
- 先把进程 lifecycle 从 sandbox 依赖拆出，再把现有 test-only natural OpenCode 分支提升为 production；
- commit 自身带 natural business real fixture 与 managed-process 回归；
- 隔离分支内允许旧 verified 文件暂时还在，但 production dispatch 已由同批测试锁定。

### Batch B · 其余 runtime 面

- T5 + T6；
- system/intent 的 disposable workspace 必须与 forced tool profile 删除同批完成；
- Claude natural config/store 与 project resource 投影同批：不改用户 config/auth env，同时把 skill
  临时投影到 worktree 项目 config，并将每个 dependent 单独写成 `agents/<name>.md`，避免兼容 fork
  在“删私有 config”后丢 selected skill/agent 或把多个 prompt 合并；
- MCP playground session reset fixture先红后绿。

### Batch C · script 与 containment 断边

- T7 + T8；
- readonly disposable iso 必须先绿，才能删除 OS readonly containment；
- network schema/UI/data migration 与 provider/profile 删除同批；
- 整文件删除前用 import graph 证明产品协议已迁走。

### Batch D · 产品面与数据迁移

- T9 + T10；
- config backup/rewrite、DB pre-migration backup、session reset、private-store cleanup 作为一个升级事务设计；
- 先用复制的存量 fixture 演练，不在开发机真实 appHome 上试删；
- migration 编号只从 Batch D 开工时的 live journal 分配。

### Batch E · 反向清理与交付门

- T11 + T12；
- 删除旧测试并不算完成：每个混合测试必须证明其正确性断言已迁入自然路径；
- 更新 RFC 状态和 active docs；
- full gate、三平台、真实 runtime、implementation gate、upgrade/rollback 全部闭环后才合入。

任何 batch 都不得单独发布到用户正在运行的 main；若仓库流程只能直接写 shared main，则改在临时
worktree/branch 完成，最终用一个经过全门的 containing commit 集成。

## 4. 预计文件范围

### 4.1 backend 删除候选

- `packages/backend/src/services/sandbox/*`
- `packages/backend/src/services/containmentComposition.ts`
- `packages/backend/src/services/runtime/opencode/verified*.ts`
- `packages/backend/src/services/runtime/opencode/{hermetic,storeHygiene,sourceGuard,sealedInputs,sealedSubprocess,fffCapability,executionIdentity,containment,failure,machineConfig,mcpReadiness}.ts`
- 经 import graph 证明为 launcher-only 的
  `runtime/opencode/{directClient,directApiSchemas,directCodec,sse,controlProtocol,runtimeBinary}.ts`
- `packages/backend/src/services/runtime/{binarySnapshot,netlessProjection,mcpTestExecutionMaterial}.ts`
  中专属实现
- `packages/backend/src/services/runtime/claudeCode/netlessMcp.ts`
- `packages/backend/src/cli/sandbox.ts`
- `packages/frontend/src/components/settings/SandboxCard.tsx`

### 4.2 backend/shared/frontend 转换候选

- `runtime/opencode/{driver,spawn,inlineConfig,models,mcpTest,events}.ts`
- `runtime/claudeCode/{driver,spawn,config,inject,mcpTest,permissionMap,events}.ts`
- `runtime/{types,index}.ts`、`runtimeRegistry.ts`
- `runner.ts`、`systemAgentRun.ts`、`runtimeSmoke.ts`、`mcpRuntimeTest*.ts`
- `execution/containedSpawn.ts` → `execution/managedProcess.ts`
- `scriptRun.ts`、`scriptDepsEnv.ts`、node isolation/lifecycle call sites
- `opencodeSessionOwner.ts` / recovery → neutral session lease service
- `db/schema.ts` + 新 forward migration + journal append
- `cli/{start,doctor}.ts`、`server.ts`、config/runtimes/launch routes与 services
- shared `schemas/{config,runtime,agent,workflow}.ts`、`agent-md*.ts`、`scriptNode.ts`、
  lifecycle alerts/error codes
- Settings/Agent/script inspector/runtime status/i18n/tests
- docs/OPENCODE_CONFIG、skill/MCP/script/troubleshooting/upgrade 文档

### 4.3 禁止误删/需点名复核

- auth/OIDC/user session/PAT/permission catalog；
- resource ACL、owner revision/fence、secretBox/redaction；
- `gitCredential.ts` 与 `util/gitHardening.ts`；
- `safePath/fileTrust/win32Acl/windowsJobObject/process` 的非 seal 用途；
- node isolation、snapshot/merge-back、DB tx/recovery/schemaAdmission；
- upload/zip/import/YAML/prompt/envelope guards；
- script author permission、dependency determinism；
- `stageSkills` whole-tree copy 与 `.claude-plugin` 类型排除。

## 5. 数据迁移实施清单

### 5.1 开工前

- [x] RFC-275 已完成。
- [ ] 实施开工时重读 RFC-275 完成态 schema/journal。
- [ ] 记录 live migration head/hash/physical manifest。
- [ ] 用生产同形 fixture 列出旧 owner/session/private-store roots，不读取 secret 内容。
- [ ] 验证 upgrade backup 同时覆盖 DB、config 与待删 private runtime stores。
- [ ] 验证 rollback 能恢复三者，不只恢复 DB。

### 5.2 forward migration

- [ ] 创建 `runtime_session_leases`，不复制旧 verified owner。
- [ ] 重建 `mcp_runtime_test_sessions`，去 identity/store provenance，保留产品/并发字段。
- [ ] 创建 `mcp_runtime_test_session_leases`。
- [ ] active/ending playground sessions → ended + `runtime-session-reset`。
- [ ] 删除旧 owner 表和 security-only indexes/checks。
- [ ] 保留历史 node_run/event session ids。
- [ ] append 新 journal entry，不修改历史 migration/meta。

### 5.3 文件与 config cleanup

- [ ] exact target + realpath/no-symlink/root-bound 验证。
- [ ] boot reaper 证明目标 store 无 live process/lock。
- [ ] backup receipt 已持久化。
- [ ] atomic config rewrite 只删三项旧 key，保留并发字段。
- [ ] 删除验证过的 private stores；任何歧义停止，不扩大 target。
- [ ] fresh/upgrade/rollback/physical-schema 四条演练。

## 6. AC → 证据追踪

| AC       | 必需证据                                                                                     |
| -------- | -------------------------------------------------------------------------------------------- |
| AC-1/2   | production dispatch/import graph + OpenCode/Claude real spawn                                |
| AC-3/4   | machine + project + platform overlay real fixture；multi-agent 独立 argv/file/context oracle |
| AC-5/6   | explicit permission allow/deny E2E + mutation                                                |
| AC-7     | disposable workspace canonical-diff oracle + merge mutation                                  |
| AC-8     | schema/API/YAML/UI negative tests + upgraded DB zero field                                   |
| AC-9/10  | 两 runtime MCP tool-call + skill sibling read；Claude worktree 投影/cleanup/auth-env oracle  |
| AC-11    | managed-process unit/integration + timeout/orphan/Windows                                    |
| AC-12    | lease contention/crash recovery + mutation                                                   |
| AC-13/14 | pre-cutover session reset fixture + historical event read                                    |
| AC-15    | fresh replay + upgrade + RFC-275 physical manifest                                           |
| AC-16/17 | production reverse `rg` + architecture guard                                                 |
| AC-18/19 | deleted/converted test inventory + no-toggle guard                                           |
| AC-20    | auth/OIDC/session/PAT + ACL/owner suites                                                     |
| AC-21    | secretBox/redaction/Git askpass suites                                                       |
| AC-22    | safe-path/symlink/zip/upload/import/prompt/envelope suites                                   |
| AC-23    | DB tx/recovery/backup/schema admission + orphan recovery                                     |
| AC-24    | Git hardening + skill/plugin type-boundary tests                                             |

空证据不算完成；“full gate 绿”不能替代单项 oracle。

## 7. 测试命令与运行层级

实施时按 live `package.json` 重验命令，至少：

1. 新/改模块的 focused tests；
2. backend + shared + frontend 对应 package suites；
3. migration fresh replay/upgrade/rollback fixture；
4. macOS/Linux/Windows process/runtime contract；
5. gated real OpenCode/Claude probes；
6. Playwright 对 Settings/Agent/script 旧控件消失与真实 workflow；
7. `bun run gate:local`；
8. Codex 对抗性 implementation gate；
9. reverse/mutation 证据。

如果 real provider credential 不适合 CI，测试拆为：

- 无网络的 fake provider/MCP/CLI contract（每次 CI）；
- operator 明确开启的真实 runtime/provider probe（发布门）。

不得把 sandbox/provider 环境缺失造成的 skip 当作自然路径成功证明。

## 8. 完成定义

- [x] 用户已显式批准 RFC-276 实施。
- [x] C1–C12 在 release/upgrade note 中逐项可见。
- [x] AC-1–24 全有自动化或明确 real-machine evidence。
- [x] production 只剩自然 runtime 路径，无 toggle/fallback。
- [x] sandbox/containment/verified/hermetic/sealed/netless execution chain 与产品面已删除。
- [x] config、live DB schema、API/OpenAPI、UI/i18n、active docs 无旧残留。
- [x] business/playground single-writer lease、process lifecycle、readonly no-merge 仍有 mutation 证明。
- [x] auth/ACL、secret/redaction、input/path/zip、DB recovery、Git hardening 点名全绿。
- [x] old native sessions 明确 reset、历史 events 可读、private stores 精确备份后清理。
- [x] RFC-272 的 MCP/skill 目标在自然路径 E2E 通过，相关 RFC 状态已更新。
- [x] full gate、三平台、真实 runtime、implementation gate 与 upgrade/rollback 演练全绿。
- [x] shared main 上任何并发 WIP 均未被覆盖或回滚。
- [x] 未经另行授权不 commit/push。

## 9. 完成记录

RFC-276 于 2026-08-10 完成并发布：

- `70deb522`：原子切换自然 runtime、删除运行期加固链、加入默认关闭且明确非防护的
  Claude `isSandbox` / `IS_SANDBOX=1` 兼容开关；
- `778b1436`：更新设置页 Linux 视觉基线；
- `079c20b9`：关闭 E2E daemon 重启迁移与 gitleaks 历史指纹缺口。

发布证据：final SHA `079c20b9c27bbbaecfdd53bb177d7194a8d1066b` 与 `origin/main` 一致；
[主 CI 31372492430](https://github.com/wangbinquan/agent-workflow/actions/runs/31372492430) 与
[视觉回归 31372492427](https://github.com/wangbinquan/agent-workflow/actions/runs/31372492427)
均为 `completed/success`。实现 SHA 另有
[真实 OpenCode 集成 31369561214](https://github.com/wangbinquan/agent-workflow/actions/runs/31369561214) 与
[Windows 平台门 31369561256](https://github.com/wangbinquan/agent-workflow/actions/runs/31369561256)
终态成功。
