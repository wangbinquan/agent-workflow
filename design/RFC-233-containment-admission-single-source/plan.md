# RFC-233 平台隔离准入单一事实源与在线策略一致性 — plan

状态：Done（2026-07-27；设计门与实现门均 APPROVED / 0 open P0-P2，待 exact-SHA 远端门禁）。

## 任务

- [x] **RFC-233-T1 事故复现与事实清单**：核对 weak boot probe、OpenCode strict bwrap
      qualification、mode boot snapshot、config PUT、business/smoke/distiller/status/preflight
      全部 global reads、outer/child executable 分裂、FFF 二次 admission 与现有测试空洞。
- [x] **RFC-233-T2 设计门与批准**：当前 Codex 会话只读审查三件套与 live source；6 个 P1、
      3 个 P2 已全部折入，0 open P0/P1/P2；用户已于 2026-07-27 批准实施并要求提交上库。
- [x] **RFC-233-T3 红回归与 shared contract**：先落“weak green + strict red + warn 当前错误
      阻断”的稳定红测；新增 probe/admission receipt、reason code、decision/profile 与
      boot id/requirement digest、`execution-identity-containment-required` additive schemas，
      保留 legacy mechanism/failure 读取。
- [x] **RFC-233-T4 coordinator 与 built-in providers**：实现 daemon-scoped
      `ContainmentCoordinator`、bounded/cancelable concurrent single-flight、
      LinuxBwrap/MacSeatbelt provider capability/atomic-topology qualification；Linux
      executable+ancestor identity；注入式合同矩阵。
- [x] **RFC-233-T5 admitted-spawn 单源**：RuntimeDriver frozen spawn descriptor/demand
      digest + `buildAdmittedSpawn`；business runner、Runtime
      Test、memory distiller 全接同一 prepared plan；SpawnPlan 明确携带
      receipt/renderer/topology，移除 build/spawn 二次 global read。
- [x] **RFC-233-T6 OpenCode child/FFF 迁移**：OpenCode core 只消费 prepared child plan；
      Linux outer/child 共用 canonical executable；FFF 校验 prepared evidence 并把漂移归为
      bootstrap failure，不再重新做 policy admission；升级 manifest codec 并锁
      receipt/demand/topology/child/FFF 跨字段一致性；保持 macOS 单层 topology。
- [x] **RFC-233-T7 config/status/UI/CLI**：Settings PUT 同 turn 更新 effective mode；
      status 暴露 configured/effective generation、exact probe 与 profile preview；UI 诚实显示
      probing/degraded/blocked/mismatch；sandbox/doctor CLI 复用 provider qualification。
- [x] **RFC-233-T8 删除双事实路径**：删除 production `get/setSandboxProvider`、weak
      readiness→strong 推断、runner 独立 enforce/renderer 决策、legacy failure writer；
      source/inventory guards 锁住所有 production spawn 与 provider 分支。
- [x] **RFC-233-T9 自动化与真实平台验证**：pure/provider/wiring/alert/UI 测试；Linux real
      bwrap + strict-fail regression、macOS real Seatbelt、business/resume/retry/auto-resume/
      smoke/distiller；全量门禁与 binary smoke。
- [x] **RFC-233-T10 实现门与收尾**：Codex 实现门闭合 P0/P1/P2，更新 RFC/STATE/index/docs，
      精确核对共享工作树归属；用户已明确要求提交上库。

## 依赖与顺序

```text
T1 → T2 设计门 → 用户批准
                  ↓
             T3 contract/red
                  ↓
             T4 coordinator/providers
                  ↓
        ┌─────────┴─────────┐
        T5 admitted spawn   T7 config/status base
        ↓                   │
        T6 OpenCode/FFF ─────┤
        └─────────┬─────────┘
                  T8 delete dual facts
                  ↓
             T9 platform/full gates
                  ↓
             T10 impl gate/收尾
```

T5/T6 与 T7 可在不同文件批次推进，但在 T8 完成前不得把中间状态视为可发布：新旧 provider
事实源同时存在时，当前事故仍可能发生。单 RFC、单 PR；commit 可按 contract/provider、
wiring、observability 三个可编译批次组织。

## 计划改动面

### Shared

- `packages/shared/src/executionIdentity.ts`
- `packages/shared/src/schemas/runtime.ts`
- shared exports、failure/i18n contract tests

### Backend：containment

- `packages/backend/src/services/sandbox/`：coordinator、provider contract、built-in providers、
  reason/public projection、policy renderer
- `packages/backend/src/cli/start.ts`
- `packages/backend/src/cli/sandbox.ts`
- `packages/backend/src/cli/doctor.ts`
- `packages/backend/src/routes/config.ts`
- `packages/backend/src/routes/runtimes.ts`
- `packages/backend/src/server.ts` / scheduler/runtime service dependency threading

### Backend：spawn/runtime

- `packages/backend/src/services/runtime/types.ts`
- `packages/backend/src/services/runtime/{opencode,claudeCode}/driver.ts`
- `packages/backend/src/services/runtime/opencode/{containment,verifiedPlan,verifiedPlanCore,
sealedSubprocess,fffCapability,verifiedLauncher,verifiedManifest}.ts`
- `packages/backend/src/services/runner.ts`
- `packages/backend/src/services/runtimeSmoke.ts`
- `packages/backend/src/services/memoryDistiller.ts`
- `packages/backend/src/services/task.ts`
- related unit/integration/source-guard tests

### Frontend/docs

- `packages/frontend/src/components/settings/SandboxCard.tsx`
- `packages/frontend/src/i18n/{zh-CN,en-US}.ts`
- Settings/status tests与必要 Playwright
- `docs/sandbox.md`
- `docs/OPENCODE_CONFIG.md`
- RFC-205/RFC-227 勘误/替代说明
- `CLAUDE.md` process-isolation 摘要（实现完成时）

不新增数据库 migration，不修改 `config.json` 的 `sandboxMode` wire。

## 不变约束

- `warn` 的 pre-spawn containment 不可用永不阻断；`enforce` 永不无隔离继续；`off` 零探测。
- warn degraded 的 outer 和 child 必须同时 none，不允许一个层使用 stale provider。
- 每次 spawn 只有一个 admission receipt；后续不读 global provider、不重做 mode truth table。
- provider strong capability 只能来自 provider exact qualification，不能由 mechanism/platform 推导。
- capability strong 不代表任意组合可用；admission 只能选择 provider 明确证明的 atomic topology。
- Linux outer/child 必须使用同一 canonical root-owned safe-mode bwrap，且 canonical ancestor
  chain 不可由非 root 替换。
- macOS verified child topology 不得嵌套 `sandbox-exec`。
- FFF 保留实际边界证明，但不再决定 mode/topology/failure taxonomy。
- config PUT 文件成功 + effective mode 更新对响应完成后的 admission 原子可见。
- 已提交 receipt 和已运行进程不被 mode 热切换追改。
- receipt/boot/policy/probe generation 不进入持久 OpenCode session identity；resume 每进程
  重做 containment admission，但不伪造 session mismatch。
- 已尝试包装 spawn 后禁止 raw retry。
- status/alert/log 不泄露原始 provider stderr、绝对用户路径、env/secret。
- task preflight 是 UX 优化，不替代最终 spawn admission。
- OpenCode binary/config/source/session/codec identity 合同不弱化。
- 共享工作树中 RFC-230/231/232 与其它 session WIP 必须原样保留。

## 验收清单

- [x] **AC-1** warn + weak green + exact red → degraded none、执行继续、task alert。
- [x] **AC-2** enforce + exact red → side-effect 前 containment-required。
- [x] **AC-3** off → qualification/render/alert 调用计数均为 0。
- [x] **AC-4** status green、CLI green 与执行 qualification 同源。
- [x] **AC-5** outer/child/topology/diagnostics/alert 同 receipt、同 canonical provider。
- [x] **AC-6** Settings 热切换对后续所有 spawn path 即时生效。
- [x] **AC-7** probe 中/receipt 后 mode race 满足线性化合同。
- [x] **AC-8** post-spawn failure 不做无隔离重试。
- [x] **AC-9** Linux 稳定 reason code 与 bounded cleanup 全覆盖。
- [x] **AC-10** macOS child-only/outer topology 与真实 deny/allow 回归通过。
- [x] **AC-11** future fake provider 无需修改 OpenCode OS/provider core 分支。
- [x] **AC-12** legacy failure/status 可读，新生产只写新 failure code。
- [x] **AC-13** production global getter/weak readiness/legacy writer inventory 为 0。
- [x] **AC-14** full test/typecheck/lint/format/depcheck/binary + platform integrations 通过。
- [x] **AC-15** 实现门 0 open P0/P1/P2，STATE/index/docs 与真实结果一致。

## 提交与发布边界

- 用户批准 RFC 只授权进入实现，不自动授权 commit/push。
- 如后续明确要求提交，按 AGENTS.md 为实际参与实现的 AI 添加真实
  `Co-Authored-By` trailer，并在 push 前执行 `git show -s --format=%B HEAD` 核验。
- 共享 `main` 只精确 stage 本 RFC/实现路径；不使用 `git add -A`，不 amend/rebase/
  force-push，不清理其它 session 的未跟踪文件或修改。
