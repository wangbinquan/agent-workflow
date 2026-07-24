# RFC-227 Codex 实现门（2026-07-24）

结论：**APPROVED / 0 open findings**。

本实现门审查当前工作树中的 RFC-227 生产、migration、测试、CI 配置、UI 与文档变更。
工作树中并发存在的 RFC-225 frontend/e2e 草稿、RFC-218 未追踪报告及 auth/OIDC 改动不属于
本结论，也未由本 RFC 修改或清理。

## 合同拆分

OpenCode 准入现在由四个正交事实组成，reported version 不参与其中：

1. **availability**：selected executable 是否存在且可启动；`--version` 仅采集 nullable
   telemetry；
2. **behavior**：当前进程是否满足 `opencode-direct-v1` endpoint/schema/event 与
   same-instance identity 合同；
3. **bytes identity**：每次运行 resolve、exclusive snapshot、copy 后 re-hash、launch
   前复验；session owner/recovery 比较 digest + codec，而不比较版本；
4. **containment**：核心只消费 provider capability/receipt；`enforce` fail closed，
   `warn` degraded 执行，`off` 按管理员选择不包装。

## Finding 收口

| 关注面                   | 裁决                                                                                                                                         | 主要证据                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| minimum/exact/range gate | 已删除；old/current/new/future/non-semver 的成功 probe 均 available                                                                          | `util/opencode.ts`、OpenCode driver `minVersion: null`、`rfc227-version-neutral-probe.test.ts` |
| official build allowlist | 已由 admin-selected executable snapshot/digest 取代；SHA 只冻结 bytes，不表示供应商签名                                                      | `runtimeBinary.ts`、原 `officialBuilds.ts` 删除、snapshot race/mutation tests                  |
| protocol identity        | 版本不进 manifest、control、session expectation 或 codec identity；final review 删除 live preflight 的 `1.18.3` expectation                  | `directApiSchemas.ts`、`directCodec.ts`、integration preflight                                 |
| resume/recovery          | owner migration 保留 lease/identity，同时改为 runtime binary digest + protocol codec + nullable telemetry；恢复不读版本 pin                  | migration `0121`、`opencodeSessionOwner.ts`、`opencodeStoreRecovery.ts`                        |
| Linux-only admission     | verified core 无 OS-name gate，只接 opaque provider plan；Linux bwrap 与 macOS Seatbelt 是 built-in provider                                 | `containment.ts`、`verifiedPlanCore.ts`、`sealedSubprocess.ts`                                 |
| policy mode collapse     | `enforce/warn/off` 真值表恢复；missing/partial capability 只在 enforce 阻断                                                                  | containment provider tests                                                                     |
| status catch-all         | 七态区分 missing、unlaunchable、unverified、protocol、containment、degraded、ready；只有真实 missing 显示“未找到”                            | shared runtime schema、runtime routes、Homepage/Settings tests                                 |
| future Windows           | custom provider + child renderer 可在不改 verified OpenCode core 的情况下注册；不宣称当前已有完整 Windows port                               | provider contract/source guard tests                                                           |
| dormant version wording  | 未接线的 `opencodeSupportsResume` / `unsupported-opencode-version` 已改为行为能力合同 `supportsSessionResume` / `session-resume-unsupported` | `sessionModeFallback.ts`、scheduler/frontend parser tests                                      |

最终 verified-production admission graph 扫描未发现 `MIN_OPENCODE_VERSION`、
`PINNED_OPENCODE_VERSION`、official digest allowlist、reported-version equality/range
比较或 OpenCode core 的 OS-name admission。`1.18.3` 只保留在历史 RFC/migration fixture、
telemetry fixture 与 integration matrix 的历史行为样本；该 matrix 同时跑 `latest`，两者都不是
allowlist。未验证的 test/mock legacy CLI seam 仍用 `1.18.0` 只选择 `--auto` 与旧参数拼写；
它不拒绝任何版本，也不会进入 verified production execution。

## 平台事实

| 平台    | 当前交付                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | bwrap capability/provenance、FFF、native supervisor、PID namespace recovery 与 real integration workflow 已接 provider；本次在 macOS 本机未执行 Linux real job。              |
| macOS   | Seatbelt outer/inner profile 已接真实 verified plan；gated real test 证明 app secret 与 child loopback 被拒、worktree 可写、seal 不可写；后代 lifetime 如实标为 best-effort。 |
| Windows | 已交付开放 provider schema、opaque plan 与 renderer registration contract seam；完整 Windows executable/path/process/signal adapter 仍是后续产品移植，不在本 RFC 中冒充完成。 |

## 门禁证据

- backend 全量：**7318 pass / 25 explicit env-gated skip / 0 fail**，898 files，
  24,613 assertions；
- shared 全量：**1438 pass / 0 fail**；
- frontend 全量：**5277 pass / 0 fail**；
- final targeted 回归（version/provider/source/migration/direct schema+codec/session fallback/
  integration self-gates）：**68 pass / 6 opt-in integration skip / 0 fail**；
- macOS Seatbelt gated real integration：**1 pass / 0 fail**；
- typecheck、lint、format check、dependency check 与 `git diff --check` 全绿；
- `bun run build:binary` 成功，生成 92.5 MiB
  `dist/agent-workflow-macos-arm64`，内置 version smoke 成功。

第一次 sandbox 内全量 backend 出现 local-listen/process timing 噪声；同一测试集在允许
本机进程/监听的执行环境中以 7318 / 0 fail 完整通过，因此以后者为权威本地证据。

## 最终裁决

实现满足“不绑定 OpenCode 版本”和“核心不能只允许 Linux”的用户合同。版本只作展示，
任意旧版、新版或 fork 都先按实际行为判断；协议不兼容或 containment 不足仍会基于真实能力
失败。Linux/macOS 已有 provider 路径，Windows 扩展点不要求再次修改 OpenCode identity
core，但完整 Windows 产品支持仍需后续平台移植。

本地未创建 commit、未 push，也没有可归属于本工作树的远端 exact-SHA CI 结果。
