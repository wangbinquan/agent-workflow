# RFC-233 平台隔离准入单一事实源与在线策略一致性 — proposal

状态：Done（2026-07-27；设计门与实现门均 APPROVED / 0 open P0-P2，待 exact-SHA 远端门禁）。

## 1. 问题

Linux 管理员在 Settings 中看到 bwrap 探测为绿色，并把隔离策略选为 `warn`，OpenCode
执行却仍以：

> 本次 OpenCode 运行要求平台隔离，但所需能力当前不可用。请启用受支持的隔离 provider；
> 也可显式选择「警告」或「关闭」接受降级运行。

终止。这不是一个文案或单分支判断错误，而是三套事实彼此分裂：

1. 通用 Linux 探测只执行 `bwrap --bind / / -- /bin/true`
   （`services/sandbox/probe.ts:59-70`），它通过后，OpenCode containment 层便直接把三项
   baseline capability 全标为 `strong`（`runtime/opencode/containment.ts:75-86`）。
2. 真正构建 verified plan 时，又执行一套更严格的 root-owned、权限位、完整 namespace、
   有界退出与进程组回收证明（`verifiedPlanCore.ts:92-98`、
   `sealedSubprocess.ts:594-695`）。这一步失败仍抛
   `execution-identity-sandbox-required`，没有重新经过 `warn` 真值表。
3. Settings 的 radio 读取并写入 `config.json`，但 daemon 的 `SandboxProvider.mode`
   只在启动时安装一次（`cli/start.ts:210-217`）；`PUT /api/config`
   （`routes/config.ts:29-98`）保存后不更新运行内存。页面可以显示 `warn`，实际新执行仍沿用
   旧的 `enforce`。

此外，OpenCode plan 构建、runner 外层包装、Runtime Test、memory distiller、任务 preflight
和 status route 都会各自读取 module-global provider。一次执行的 child provider、outer
wrapper、告警与状态因此可能来自不同时间点，无法证明它们采用了同一个策略和同一份能力证据。

## 2. 根因

现有设计把四个不同概念压成一个 `{ mode, status.available, mechanism }` 对象：

- **发现**：PATH 上是否存在一个叫 bwrap 的程序；
- **资格**：这个具体 provider 是否满足当前安全前提；
- **策略**：管理员要求 `enforce`、`warn` 还是 `off`；
- **执行计划**：本次 spawn 实际采用哪一个 outer/child topology。

于是“弱探测绿色”被误当成“强能力已证明”，保存意图被误当成运行时生效值，一次 spawn
又可以在多个时点重新读取全局状态。只在 `requireRootOwnedBwrap()` 外面补一个 `try/catch`
会暂时修复当前报错，却保留上述事实分裂，下一条 runtime、provider 或配置热更新路径仍会复发。

## 3. 产品合同

### 3.1 绿色的含义

隔离状态显示“可用/绿色”，必须绑定一个明确的 runtime requirement profile，并表示当前
provider 已通过与该 profile 生产准入相同的、provider 自己拥有的精确资格检查；仅发现二进制、
执行弱化参数或根据 platform/mechanism 名称推断 capability，都不能显示绿色。provider 可以对
filesystem profile 可用、对 OpenCode verified profile 不可用；此时必须显示 partial，并在
对应 OpenCode runtime 行显示 degraded/blocked，不能用一个全局绿色掩盖差异。

状态同时显示最后一次精确探测时间和结构化原因。状态是可观测快照，不替代每次 spawn 的最终准入。

### 3.2 三种模式

| mode      | 所需能力全部为 strong  | provider 缺失、资格失败或 baseline 不完整 |
| --------- | ---------------------- | ----------------------------------------- |
| `enforce` | 按已证明 topology 运行 | 在 runtime 私有文件变更和 spawn 前阻断    |
| `warn`    | 按已证明 topology 运行 | 明确选择无平台隔离运行，并产生降级告警    |
| `off`     | 不探测、不包装         | 不探测、不包装，也不产生降级告警          |

本 RFC 不保留“outer 看似可用、child 已降为 none”的半隔离状态。对一个 requirement profile，
要么 provider 返回满足全部 required capability 的原子 topology，要么 `warn` 选择明确的
`none` topology。`descendantLifetimeBound` 等 optional capability 可以保持
`best-effort`，不会把满足 baseline 的 macOS provider 错判为不可用。

`warn` 的可用性承诺只覆盖 **spawn 前** 的 provider 发现/资格/准备失败。一旦已尝试启动包装后的
命令，执行是否已经产生副作用就可能不确定；此时不得自动裸跑重试，而应按 bootstrap failure
失败关闭。

### 3.3 在线切换

通过 Settings 成功保存 `sandboxMode` 后，同一个 HTTP 响应返回前必须更新 daemon 的生效策略；
不要求重启。保存完成前已经取得准入收据的 spawn 保持其出生策略，保存完成后的新准入采用新策略。
已经运行的进程不会被追溯包装、解包或终止。

离线 CLI 直接改 `config.json` 时无法原子更新另一个已运行进程，必须明确显示“下次启动生效”；
API/status 同时暴露 `configuredMode` 与 `effectiveMode`，两者不一致时不得让 UI 冒充已经生效。

### 3.4 一次 spawn，一份收据

每次 business run、Runtime Test 和 memory distiller spawn 都只做一次策略准入，得到不可变的
admission receipt。runtime child plan、runner outer renderer、topology、日志、失败码与降级
告警必须消费同一份收据；后续阶段不得再次读取全局 provider 来重做策略判断。

## 4. 目标

- 引入 daemon-scoped `ContainmentCoordinator`，成为 provider 资格、当前生效 mode 和
  spawn admission 的单一事实源。
- 把 Linux bwrap、macOS Seatbelt 的精确探测、capability 声明、outer renderer 与 child
  renderer 收拢到各自 provider；OpenCode core 不再按 OS/mechanism 名称伪造能力。
- 用显式 `ProbeReceipt` 区分 provider 事实，用 `AdmissionReceipt` 冻结策略决定。
- 让 Settings 在线切换在新准入上立即生效，并明确并发线性化边界。
- 让所有生产 spawn 通过统一 admitted-spawn 装配路径；删除 module-global provider 的多点读取。
- 新生产失败使用 RFC-227 已约定但尚未落地的
  `execution-identity-containment-required`；保留旧
  `execution-identity-sandbox-required` 仅用于读取历史记录。
- 让 Settings、`/api/runtimes/status`、`agent-workflow sandbox` 与 doctor 复用同一个精确
  provider 资格判据，不再出现一处绿、一处红。

## 5. 非目标

- 不改变 `enforce` / `warn` / `off` 的管理员含义，也不自动替用户降低模式。
- 不把 bwrap 打包进发行二进制，不自动安装系统包或修改 user namespace/sysctl。
- 不承诺在 `warn` 下对已经尝试过的失败 spawn 做无隔离重试。
- 不追溯改变已经运行的进程。
- 不完成 Windows Job Object/AppContainer 实现；只保证新 provider 可通过统一接口接入。
- 不改变 OpenCode binary snapshot、config/source/session identity、codec qualification、
  credential bridge 或 task retry 合同。
- 不把原始 provider stderr、绝对用户路径、环境变量或 secret 放进 status/告警/receipt。

## 6. 用户体验

### 6.1 Settings

- radio 显示 daemon `effectiveMode`；保存成功后立即切换。
- 若配置文件被离线修改导致 `configuredMode !== effectiveMode`，显示“当前 daemon 尚未采用该
  配置”，同时给出“立即应用 configured mode”动作（PUT 同一个值）和“重启”说明；而不是显示
  一个虚假的已生效选项。banner 仍展示配置文件中的 desired value，radio 不拿 desired value
  冒充 effective value。
- provider 状态显示 `ready / unavailable / probing`、provider 名称、最后精确检查时间与安全的
  原因说明。
- `warn + unavailable` 显示“将无平台隔离运行并告警”，不显示会阻断的错误。
- `enforce + unavailable` 显示“新执行将阻断”。

### 6.2 执行

- 当前事故组合（Linux、弱发现可通过、root-owned/full-namespace 精确资格失败、mode=`warn`）
  必须进入明确的 `degraded + none` 收据，OpenCode 正常继续并产生一次 task-level 降级告警。
- 同一组合在 `enforce` 下以
  `execution-identity-containment-required` 在 runtime 私有布局/二进制 seal 等副作用前阻断。
- `off` 不启动 provider probe，也不产生“provider 不可用”告警。
- 每条 spawn 结构化日志都携带非敏感的 policy generation、probe generation、profile、
  decision、providerId 和 reason codes，便于把页面状态与具体执行对齐。

## 7. 验收标准

1. `warn + generic discovery green + exact bwrap qualification red` 不再抛 containment-required；
   实际 outer/child 都为 none，执行继续且出现降级告警。
2. 同一精确失败在 `enforce` 下阻断，且不创建本次 runtime 私有 layout、binary snapshot、
   FFF artifact 或子进程。
3. `off` 路径零 provider probe、零 wrapper、零降级告警。
4. status 的绿色来自与执行相同的 provider qualification 实现；弱 discovery 只能作为安装提示。
5. bwrap outer 和 OpenCode child 使用同一份资格收据选出的 canonical executable；executable
   及其从 `/` 到 parent 的目录链都满足 root-owned/不可由非 root 写入，不再分别用 PATH
   `bwrap` 与另一个严格路径。
6. 一次 spawn 的 outer、child、topology、diagnostics 和 alert 使用同一个 admission receipt；
   任一阶段不得重新读取 daemon-global provider。
7. Settings 把 `enforce` 改为 `warn` 后无需重启，响应完成后的新 launch/resume/retry/
   auto-resume/Runtime Test/distiller 均采用 `warn`。
8. mode 在异步 probe 期间切换时，以 receipt 最终提交的线性化点决定；已提交 receipt 不被追改。
9. 已经尝试过包装 spawn 后失败时，不以 `warn` 裸跑重试。
10. Linux 精确资格按 capability/atomic topology 区分 filesystem 与 full OpenCode trial，并
    区分 not-found、非 root owner、不安全 parent/mode、namespace trial 非零/超时、生命周期
    回收未证明等稳定 reason code；外部响应不泄露原始 stderr。
11. macOS topology 保持 RFC-227 T14：有 model-controlled child 的 verified plan 使用
    child-only Seatbelt；无该 child 的 plan 使用 runner outer；不重新引入嵌套 Seatbelt。
12. 新 provider 只需实现 provider contract/registry，不修改 OpenCode core 的 OS 分支。
13. 旧 `execution-identity-sandbox-required` 事件仍可解析和显示；新生产路径不再写它。
14. CLI sandbox/doctor 仍为诊断操作，不改配置，并与 Settings 使用同一精确资格判据。
15. 单元、集成、Linux 真实 bwrap、macOS 真实 Seatbelt、config 热更新和全量质量门全部通过。

## 8. 兼容性与替代关系

- 本 RFC supersede RFC-205 中“boot 时一次弱探测 + module-global provider + mode 需随重启刷新”的
  生命周期设计；RFC-205 的 filesystem policy、路径 canonicalization 与最后一刻包装原则保留。
- 本 RFC supersede RFC-227 中由通用 `SandboxStatus.available` 推导 OpenCode capability、
  child/outer 可分别决定以及生产仍写 legacy sandbox failure code 的实现部分；RFC-227 的
  threat model、capability-based admission、mode 真值表和 macOS 单层 topology 保留。
- status wire 采用 additive 字段并保留一轮 legacy `mode/available/mechanism` 派生字段，
  以便旧前端读取；新前端只消费 probe/admission/effective-mode 字段。
- 不需要数据库 migration。历史 task/run/alert 不回填 admission receipt。
