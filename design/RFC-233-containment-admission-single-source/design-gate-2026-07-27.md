# RFC-233 设计门（2026-07-27）

结论：**APPROVED（6 个 P1、3 个 P2 已全部折入三件套；0 open P0/P1/P2，待用户批准实施）**。

审查由当前 Codex 会话在本地只读完成，没有调用外部子进程或委派 agent。审查逐项重读
RFC-233 三件套与 live source 的 boot probe、SandboxProvider/global reads、config PUT、
runtime status、business/smoke/distiller spawn、Linux strict bwrap supervisor、outer/child
renderers、FFF、verified manifest/session identity、task preflight、RFC-205/227 真值表与现有
回归。

## Findings

| 级别 | 问题                                                                                                                                                                                                                                                                                                                        | 裁决 / 修正                                                                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | 初稿把当前最大化 Linux trial 直接提升为 provider 唯一 exact probe；如果 `--unshare-net` 失败，它会把仍可安全提供 filesystem outer 的 provider 整体打红，继续违背 RFC-227 的 capability-based 目标，并误伤 Claude 等较弱 profile。                                                                                           | qualification 改为 capability + atomic-topology evidence：分别证明 filesystem 与 full OpenCode topology；允许 public `partial`，但 UI 绿色绑定具体 profile preview。OpenCode required baseline 不全仍原子降 none/阻断，filesystem profile 可独立 contained。                          |
| P1   | 当前 strict check 只验证 canonical target 的 uid/mode（`sealedSubprocess.ts:609-619`），没有验证 ancestor；root-owned 文件若位于同 UID 可写目录，admission 后仍可被换路径，所谓 canonical executable 不是稳定事实。                                                                                                         | Linux provider 把从 `/` 到 executable parent 的整条 canonical chain 纳入 opaque evidence：全部 root-owned directory、非 group/other writable；outer/child 共用 canonical path，FFF 前重验 target+ancestor identity，新增 `provider-parent-unsafe` 与回归。                            |
| P1   | 初稿 backend-only plan 仍引用 OpenCode 的 `RuntimeChildProviderPlan`，而 hidden manifest 只分别 parse receipt/child；driver 或 manifest 可形成 decision/topology/child/FFF 自相矛盾的组合，future provider 仍要侵入 OpenCode core。                                                                                         | 通用 child plan/schema 移到 sandbox/provider 域；provider registry 只接受随可信发行物注册的完整 descriptor（qualification、outer、child schema、hidden renderer）。manifest codec 升级并穷尽校验 receipt/profile demand/topology/child/FFF 跨字段不变量。                             |
| P1   | `describeContainment(ctx)` 与后续 `buildSpawn(ctx)` 是两次独立派生：driver 可先声明“无 model child”取得 outer-only plan，materialize 时再加入 Bash/local MCP，macOS 会把 child 留在 Seatbelt 外。当前 verified builder 也在 strict admission 前先创建 run root/scratch（`verifiedPlan.ts:656-695`），没有真正的副作用边界。 | driver 先生成不可变、无 runtime-FS 副作用的 `RuntimeSpawnDescriptor`，包含 child surface 与 demand digest；coordinator admission 后才 materialize。SpawnPlan/manifest 必须回显 digest，`sealSpawnContainment` 在 spawn 前复核 descriptor/receipt/child/topology/scope。               |
| P1   | 当前 task sandbox gate 位于读取 workflow 之前（`task.ts:1325-1357`），无法知道 mixed-runtime workflow 的真实 profile；用 generic/OpenCode baseline 都会出现漏挡或误挡。另写一套 runtime 推导还会与 dispatcher 冻结事实漂移。                                                                                                | preflight 移到 workflow snapshot 与 execution-policy closure 解析后，复用 canonical runtime resolver，preview 全部 distinct profile；仍留在 multipart/pre-created cleanup ownership try 内。它只做早期 UX，最终每个 spawn 仍 fresh admission。                                        |
| P1   | admission 带 mode、boot id 与 probe/policy generation；若把整份 receipt 顺手并入 OpenCode persistent `identityDigest`/owner equality，daemon 重启或在线 mode 切换会把合法 resume 误判 session mismatch。                                                                                                                    | 明确把 receipt 定义为每进程易变事实，只进入本次 private manifest/log/alert，不进入 persistent session identity/session contract/owner equality；new/resume 每个进程重新 admission。                                                                                                   |
| P2   | daemon-local generation 在每次重启从头计数，单看 `probeGeneration=1` 无法判断两条日志是否同一代。                                                                                                                                                                                                                           | receipt/status 增加非敏感 `coordinatorBootId`，用 boot id + generation 关联。                                                                                                                                                                                                         |
| P2   | 若 legacy `mechanism` 直接由新 `providerId` 派生，内建 wire 会从 `bwrap/seatbelt` 变成 `linux-bwrap/macos-seatbelt`，旧前端/脚本发生不必要兼容回归。                                                                                                                                                                        | trusted provider descriptor 显式带 `legacyMechanism`；compat projection 保持精确旧值，legacy `available` 只在 probe `ready` 时为 true，partial 安全显示 unavailable。                                                                                                                 |
| P2   | 每个 60 秒 status poll 都 fresh exact probe 会让多浏览器客户端连续启动 capability supervisor；而离线 config mismatch 下只显示 effective radio 又缺少把 desired value 应用进 daemon 的动作。                                                                                                                                 | 安全 admission 永远 fresh、只做 concurrent single-flight；status 仅使用有明确 max-age 的 exact observability snapshot/显式 refresh，不作为安全边界。mismatch banner 显示 desired 并提供“立即应用 configured mode”的同值 PUT；`setMode` 仅在 effective value 真变化时递增 generation。 |

## 已核实的不变量

- RFC-227 明确要求 `warn` 在 provider missing/partial 时继续 degraded，只有 `enforce` 阻断；
  当前 bug 是 strict bwrap qualification 位于该真值表之后，不是用户配置错误。
- Linux weak boot trial 只有 `--bind / /`，确实没有证明 root ownership、network/PID namespace、
  bounded lifecycle 或 cleanup。
- generic outer 当前执行 PATH 字符串 `bwrap`，OpenCode child 使用 strict check 返回的 canonical
  path；两层 executable identity 确实分裂。
- business runner、Runtime Test 与 distiller 都在 build/wrap 两侧分别读取 global provider；
  status/preflight 又是另外的读取点。
- config PUT 的最后写点只调用 `applyConfigPatch()`；唯一 production
  `setSandboxProvider()` 在 daemon boot。
- `VerifiedLaunchManifest` 当前只锁 `linux-bwrap ↔ FFF present`，没有 admission decision、
  profile/demand 或 topology 的跨字段合同。
- 当前 persistent OpenCode identity digest 不含 containment，保留这一分离可让 resume 在重新
  admission 后维持 session identity。
- macOS 嵌套 Seatbelt 已有真实事故与 RFC-227 T14 单层合同；topology 必须由同一 prepared
  provider plan 冻结，不能让 runner 另算。

## 范围裁决

- RFC-233 是 RFC-205/227 containment lifecycle/admission 的定向 supersession，不弱化
  RFC-224 binary/config/source/session identity。
- `warn` baseline 不完整时本 RFC选择明确 none，而不是保留半个 outer/child；这是故意消除
  “看似有隔离但 capability 不闭合”的状态。
- FFF 保留为实际 Linux child boundary bootstrap attestation，但不再拥有 policy/mode 决策权。
- status 缓存只服务可观测性；per-spawn qualification 不消费 TTL。
- provider registry 是可信编译扩展点，不是让普通用户加载任意 renderer 的插件接口。
- 零 DB migration；receipt 的逐 spawn 证据在结构化日志，degraded 安全 projection 进入现有
  task lifecycle alert。
