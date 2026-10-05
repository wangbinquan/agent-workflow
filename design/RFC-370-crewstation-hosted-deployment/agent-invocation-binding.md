# RFC-370：三入口的同材料 native invocation binding

状态：A-T5 的独立源码候选；不是 A-T5／A-G 完成或 CS 部署验收。沿用已批准的 execution-material-implementation.md DESIGN2-R3，不新增 CS 实现或执行算法。

本批将 runner、systemAgentRun、runtimeSmoke 已有材料执行的编译结果、workspace、取证、纯协议视图、生命周期和不透明 execution/receipt participant 放入同一个 invocation binding。三入口实际消费它；native factory 只接收那次已经编译的 plan、显式 scope 与 owner，不重选 driver、不重编译 declared、不读全局 Paths。

## 实际合同与边界

runtime-management/application/ports/agentInvocationBinding.ts 只提供 materialRef、同计算的 declared、workspace/evidence、纯协议、生命周期及 bindExecution。task-execution/application/ports/agentExecutionBinding.ts 属于执行 owner，其 public/participants 精确提供实际被材料组合消费的两个类型。正常合同没有 argv、env、cwd、PID、nonce 或 CS DTO；native implementation 才解释物理事实并复用原 agentExecutionEffect。

SOURCE13-R1 独立功能门发现正常参与者输入仍传递两个完整 native persistence 类型，导致选定非本机执行方也必须携带 PID/nonce 方法；原 P2/FAIL 回执保留。R2 将参与者改为 TE owner-issued opaque handle；原 persistence、node receipt writer 和 read-only reader 只绑定在 native owner 的私有 WeakMap。材料组合只解析同一 native owner 实际签发的 handle，不选择其他 target；不相容 handle 在任何 native 创建前失败。原完整 executor/projection 函数体不改，正常 public 合同不再传递 native receipt 方言。

纯协议视图只包含 kind/capabilities、parseEvent、normalizeUsage、observeSystemEvent、parseTerminalResultError。optional 方法在原消费点读取，缺省保持缺省；parse/observer 保留原 driver receiver，Task 原本提取后裸调用的 normalizeUsage 保留原函数身份。legacy driver singleton、unknown-kind throw 和真实双协议 builder 未改。

Task 在原 cmd/env 解构点仍保存完全相同的引用；取证 env 仍在原消费点读 plan.env。effect participant 仍在原 Git 控制快照之后装配，cwd、read-only 决策和 writer cwd 的原读取顺序保持，原 requestHash v1、资源 hash、receipt DB 字段和结算由原 native participant 计算。材料引用到执行绑定点才读取；正常编译已有引用不变，原 raw fixture 在同一点 mint。

System 的 beforeStart callback 原样进入 executor；direct owner 仍在真实 target 创建后 ACK，原 rejection/fatal classification 未改。普通辅助 eventSink append failure 与 terminal complete/incomplete retry 的整段逻辑保持。cleanup 在 post-exit capture 后用原 plan receiver 调用；尚未取得 invocation 的既有准备异常仍按原 preparedPlan 清理。

Smoke 继续 ownerless direct；不增加 required receipt 或 onStarted。beforeStart 和 cleanup 仍向 executor 传同一个原函数，保持该入口原 receiver。nonce、目录准备、结果分类、原输出预算、reap/drain 与保留顺序不变。每个新 invocation 只允许绑定一次 execution，单次 submit 的既有检查继续由原 adapter 执行。

## 功能验证范围

新用例覆盖同编译引用与 lazy 声明、原 workspace、unsupported evidence 不读物理 scope、Task 早期 snapshot 和后期 env、完整原 hash/资源及 PID/nonce 持久投影、原 direct owner receiver/rejection、ownerless 模式、原 cleanup Promise/throw/receiver、双协议纯解析及 accessor 原失败位置；另补不相容 handle 创建前拒绝与原 read-only 空资源两分支。原 execution/material/evidence/workspace 回归仍保留；新增 Windows 对称触发路径及同一测试命令，不减少旧套件或预算。

三入口完整非 import AST 可逆投影回原算法；三个原源码门仅跟随真实新绑定位置并增加实际绑定相连断言，旧名称、计数、预算和其他整段 AST 保持。Windows 全旧字节可逆恢复。原 executor、effect projection、compiler、legacy bridge、evidence、workspace、双 driver 与原机制九份控制源码完整保持；native agentExecutionEffect 只加 opaque 参与者装配，其原完整函数体保持。私有证明脚本的前两次 layout/scanner 诊断失败保留，最终采用完整 AST 节点结构及 literal/declaration flags 比较；没有运行 AW 本机 tests/typecheck/build/service。

f3f28e466 的 Windows run 37280896928 正式 success；主 CI 37280896960 正式 cancelled（22 success／2 failure／26 cancelled）。唯一测试失败是并行 run-observability/public/participants 的 DB type import，另有 required job failure。ad19fc17b 已精确发布三项 consumed growth 退役、远端 0/0／index empty；其主 CI 37282107521 尚未终态。这些不是本批源码正式 CI 通过，旧失败与取消不改写。

## 仍开放的完整交付

本批 native binding 不代表完成选择面：三个 legacy 入口仍在原位置准备 native workspace、选择 driver 和 buildSpawn；完整 AgentMaterialIntent 的 owner projection、composition 所选完整 compiler/factory、非本机 fixture 和所有 Task/Intent/Memory/Narrative/MCP/smoke 根接线仍待下一批。MCP buildCtx/wrapPlan 未删、未改为 fixture。纯协议类型的 legacy 兼容 owner 和实际库存仍按原 canonical 登记。

随后继续脚本／专用 command、authority/recovery/background 与 A-T7 全装配、债务及 A-G。完整 A-G 后编写各层独立 CS adapters，M0 首先实际部署，再 M1～M4 逐项收编；当前没有 AW-in-CS 部署，不关闭 RFC。
