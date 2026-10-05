# H4 Agent 中立执行接口与本机回执投影

这是 execution-material-implementation.md 已批准 R3 设计中的本机兼容增量。当前 SOURCE11-R2 候选覆盖 Task、System Agent 和 runtime smoke 三条实际调用链。独立功能门、匹配元数据、精确提交 CI 分别记录；本片不关闭 A-T5、A-G 或 RFC，也没有 CS adapter 或实际 AW-in-CS 部署。

## 实际接口与职责

task-execution/application/ports/executionEffect.ts 只暴露当前三个消费者真正使用的 submit。请求携带 execution、material、workspace 三个逻辑引用以及原 timeout、abort、capture ACK、admission 和 cleanup；开始回执只包含逻辑 executionRef 与原开始时刻。结果保留原六类 outcome、exitCode、原 stdout/stderr、duration 及原可选错误／完整性字段，PID、binary、nonce、argv、env 和 stdin 不进入这个接口。inspect、readEvents、sendMessage、cancel 随实际恢复或传输消费者在剩余 A-T5/A-T6 中接线，当前没有闲置方法或假实现。

task-execution/infrastructure/local/agentExecutionEffect.ts 保存选定本机 binding 的物理材料读取、原回执和 terminal 事实。它只委托现有 platform/execution/local/agentProcess.ts，由原 managedProcess 和 launcher 继续负责 gated/direct、stdin、stream pump、取消、timeout、TERM/KILL/reap 和 cleanup；没有第二套计时器、进程机制或 Task 状态机。

runtime-management 的本机材料编译器把真实一次编译得到的 materialRef 与实际 plan 关联。System 的 wrap-only plan 保留同一个来源引用。显式 legacy／测试 raw plan 只有对该对象的本机引用，不读取 registry／Paths，不被声明为 hosted 材料。runNode、runSystemAgent、smokeRuntime 目前仍在本机兼容路径选择该 binding；完整 selected material／evidence／lifecycle／execution／receipt 组合和所有实际 composition roots 继续实施，不能用这个本机选择点证明非本机组合已经可替换。

## 原持久事实和时序

Task 的原 application process observer 继续拥有 effect claim、Task／node／operation generation、资源占用、ACK 和 settlement。私有本机 projection 从 opaque receipt 取回同一原 native receipt，继续生成原 requestHash、workspace resource fingerprint、recovery class、nonce 和 v1 receipt JSON。没有 observation owner 时，原 nodeExecution.patch 只在实际 fallback 分支按原时序读取并写入。逻辑 executionRef 只标识当前 binding，不替代原业务认领或 CS 的未来持久 requestKey。

SOURCE10-R1 功能门发现 runner 的实际 observer policy 缺少原分类器识别的 resourceKeys 接线。R2 为 application observer 增加可选的逻辑资源 resolver，并由 runner 显式传入。原资源认领回调在原时点只调用一次 projection.describe，再把同一 description 交 resolver；没有 resolver 的既有调用者继续使用原 description.resourceKeys。完整原请求 hash、generation、resource、recovery 和持久回执保持，未改变原分类器或提前读取材料。新增回归直接验证此选择后的实际 effect claim。

Task 保留 required receipt：ACK 前不激活 target，不投递 stdin，不消费输出；receipt 拒绝保留原 spawn-failed。System／MCP direct 保留 target 已启动而 stdin／output pump 等待原 owner ACK 的行为；owner 接收原三个字段和原 receiver，失败后的原 domain 分类由原调用者保持。smoke 仍无 owner callback，直接运行并在 reap 后 cleanup。unreaped 的原 PID 诊断和原错误文本留在本机实现，普通结果保持逻辑引用。

## 验证范围和余项

候选新增 12 个功能回归，其中五个使用原 native 进程验证 Task held／rejected receipt、System direct held／rejected receipt 和 ownerless smoke。其余验证真实单次编译引用、派生 plan、原物理 getter 与 pipe 双读取、回调身份、原 PID／nonce 持久投影、完整 v1 JSON／hash／resource、owner receiver、原 unreaped 文本和实际逻辑资源 resolver。真实执行只交给 GitHub CI，本机没有运行 AW tests、typecheck、build 或服务。

纯 AST／字节证据覆盖三份消费者完整原函数、原 compiler 和 registry、原 invocation 用例／断言／预算；原 native process、projection 和 composition 控制文件字节保持。R2 application observer 经精确逆变换核对完整原算法，原 SOURCE10 的 11 个用例和全部断言／预算保持。Windows push／PR 对称增加四个实际路径，现有 platform suite 追加新测试，原完整步骤和预算保留。该静态证据与 format／lint 不替代独立功能门或 hosted CI。

SOURCE11-R2 独立有限功能门 PASS，首末 31 项字节稳定，指纹 f1e93fb5c900664b92d5b785490f3a0aff8e6e52645ae82dbe205054f6ad46fb；SOURCE10-R1 原 FAIL 回执保留。原 scoped census 在 committed fb7a27bd 加冻结 11 路径上生成一次，其他源码只读原提交，排除且保留并行 WIP；sourceDigest 为 sha256:3214e2700604b4d1a74728b6928a694a5158477cba10dd8354697cd70e100baa。13 份匹配产物通过原 validator，status.md 保持原 renderer 的完整字节。129 原有序库存／why 保留；实际 imports 6325→6339、exceptions 5615→5629、owners 26744→26758 三项增长具名登记，随后按正常后继退役。原 309 条导入债保留，新增八个真实 R1 兼容分组，总数 317，A-T7 收口时退役。匹配元数据门和新 exact-SHA hosted CI 另行记录。

后续必须完成同次编译的完整材料／取证／lifecycle／execution／receipt 组合、非本机 fixture 与全部真实根、脚本和专用命令、执行权与恢复生命周期、A-T7 边界收口及 A-G。之后按 M0 必要 CS adapter → 首次实际部署 → M1 远程任务 → M2/M3 能力／事件／运维 → M4 迁移／回退与全量验收推进。未交付的能力继续明确保持开放。
