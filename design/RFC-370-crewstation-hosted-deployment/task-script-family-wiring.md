# A-T5：完整 Task 脚本效果家族

本增量属于已批准 RFC-370 阶段 A，承接 MCP 完整效果家族；只抽出脚本效果和本机配对，不改变工作流规则、现有脚本能力或部署阶段顺序。CS 独立 adapter 在完整 A-G 后实现，M0 先实际部署，脚本执行在 M2 逐项开放。

## 原入口与必须保持的行为

唯一脚本业务编排仍是 task-execution 的 `composition/nodeMechanics.ts` 中 `runScriptNode` 与 `runOneScriptAttempt`。前者拥有 upstream、pending 行、重试、独立 script semaphore、每次重试重建 iso、merge/discard 和最后状态；后者拥有依赖安装失败分类、running 先落库再广播、stdout/nonce 端口提取、错误分类、输出持久化、readonly settle 及 terminal/effect settlement 顺序。不得由 local 与 CS 分别复制这些算法。

当前缺口不只是 `runScriptProcess`：同一业务入口还直接解析解释器、读取宿主工具状态、计算/创建 run directory、安装依赖环境，并在 start callback 中解释 PID、binary 与 launchNonce。所有这些效果都应由同一 selected family 完整提供。

保留现有 `services/scriptRun.ts` 全部公开函数、INTERPRETER_SPEC、Windows 候选与完整原算法，以及 `services/scriptDepsEnv.ts` 的错误身份、缓存、inFlight、原子发布、manifest 和 collector；原生机制完整迁到 TE `infrastructure/local`，旧 service 仅转导同一实现。正常效果入口不通过旧 service 获取默认本机实现。

## 合同与分层

新增 TE `application/ports/taskScriptRunFamily.ts`，提供完整 `TaskScriptRunFamily`。中立目标、run-content、依赖环境和 start/result 身份由各自 owner 引用表示；普通业务不将这些引用当作路径、binary 或 PID。已有 SC mount/workspace 字符串只作为 owner 所给 reference 转交，不自行解析或访问。

家族覆盖以下原作用点：

- `resolveInterpreter` 在原解释器调用处接收 language 和原 override 值，返回 opaque target 及原显示/version 信息，或 null；异常继续在原位置传播。只在原 null 分支调用解释器诊断，不能提前探测或缓存失败原因。
- `prepareRunContent` 在原 `runRootFor`/mkdir 的位置准备同一 task/nodeRun 内容引用，原调用和错误位置保持。
- `ensureDependencies` 只在 specs 非空时调用，原 timeout、signal、按行持久化 ACK、原错误类型/detail、缓存和语言行为保持。返回 opaque environment 与原 hash；普通业务不持 libDir/rootDir。
- `execute` 接收完整原节点/输入/identity、run-content、workspace/repo reference、所选 interpreter/environment、nonce、Git 身份、timeout/signal、日志和按行 callback。材料、env/spill file、完整 managed launcher 与 capture 仍复用唯一原生实现。结果提供原业务实际消费的 outcome/exitCode/rawStdout/stderrTail/truncated/错误事实和不透明 settlement identity，不把 PID/binary 送进普通业务。
- 启动时提供该次执行的 `ProcessEffectProjection<opaque receipt, neutral result>`，业务仍调用既有 application `createProcessEffectAttemptObserver`。beforeStart 原位置准备/取得效果，启动 receipt ACK 先于输出读取；原 ownerless fixture 分支由选定家族的 unowned-start writer 保持。native projection 将 opaque receipt/result 解析为完整原值，复用原 PID/launchNonce 持久化和原完整 settlement JSON。正常入口不获得本机 projection 默认值。

`composition/taskScriptRunFamily.ts` 只负责 selected 家族贯穿；`composition/localTaskScriptRunFamily.ts` 显式选择本机完整配对，所有 native 解释放在 local infrastructure。选中非本机家族不会因成员缺失回落宿主解释器、文件或进程实现。

## 真实根与继承

沿现有 `TaskExecutionRuntimeParticipantsInput.taskAgentRunsFor` 模式增加完整 script family factory；同一 drive 为当前 effective request 装配家族，普通 BoundRunTaskOptions 显式持有选择。SQLite HTTP、SQLite CLI、PG 的三个真实根选择 local factory；helper/直接 legacy fixtures 明确选择本机 family。子任务在自己的 drive 重新选择，不把该家族序列化进继承配置。

新增选择只在对应原消费位置被使用，不前移原语言校验、pending 行、resolve、ISO、nonce、running、spawn、persist、settle、broadcast 和释放的顺序。native target/environment 必须保持完整原对象身份及 getter 读取次序；不得把 display label 当 binary 使用。callback 保持 class/private receiver 和既有 await 错误边界。

## 验证与证据

完整逆向 AST/字节对拍原两个 script policy 体、原生 runner/deps 全文件及三个真实根完整参数/语句；只允许 purpose/effect 调用、类型和 owner 地址迁移。原 RFC-253/254/276/287 功能测试、所有名称、断言、预算和 Windows 用例保持；实际旧源码读取 oracle 仅跟随真正 owner，原判据不放宽。

新增真实双 provider：选中 opaque interpreter/content/environment/start/result 的成功输出；完整输入、nonce 和 Git identity；独立 script pool与重试/readonly；安装错误；取消/超时/非零/truncated/envelope 错误；start receipt 和每行 ACK；effect/ownerless fixture 两条写入；selected class receiver；未选择/缺失成员不回落。native 保留真实 Node/Bash/Python、Windows 与依赖 cache 原回归，不以 remote fixture 冒充 CS durability。

本机仅自有 format/lint、纯 AST/字节/JSON 与必要匹配静态生成；不运行 AW tests/typecheck/build/service。功能设计门和实现门限定明确候选及必要 control，正式行为由 GitHub exact-SHA CI 判定。完整 A-T7、公有出口与余下 native bridge、doctor/command、H7、A-G 仍逐项收口；本增量不单独关闭阶段 A 或 RFC。

## 2026-10-06 实现候选

普通策略改为显式 `opts.taskScriptRuns`；选定家族在原作用点解析解释器、准备内容、安装依赖及执行，原 running／start ACK／输出／terminal／effect settlement 顺序保持。native family 用 owner 私有 WeakMap 留住原完整 interpreter、环境、启动及 result，路径和 PID 只在 local 解释。原两个 services 是同名 identity reexports，唯一原错误 constructor 迁入中立 port；兼容身份有独立回归。

完整 native 逆向证明保留两个原文件的全部算法及19／6个公开 value/type 名字；唯一错误 class 原体保持。完整 policy＋wiring 对拍11文件／44个精确迁移组，三真实根全部原声明、体与参数保留。原四个 source oracle／Windows 全文件逆向保持旧断言、计数、hash、名称和预算；MCP 三真实根锁也只逆掉精确成对选择的一个 Script factory，其全原参数／体打印hash与56／164／180语句保持。逆向 helper 的首轮布尔结合性不匹配及后继精确恢复记录保留，不改变生产或旧规则。

新增15种场景×真实 SQLite／PostgreSQL以及一条兼容constructor身份例，共31个预期用例：Node成功、Bash无依赖成功、Python依赖成功、ownerless、一次失败后重试换树、writable合并、安装失败、解释器缺失、取消、timeout、非零、truncated、nonce envelope不匹配、所选resolver或executor缺失。所选class/private receiver、输入／nonce／Git／原节点材料、真实start持久化ACK先于stdout以及effect settlement均直接断言；缺失成员必须产生对应Task错误，不得回落native。原独立script pool与Native三语言／Windows／cache功能回归保持，helper显式选local完整家族。新用例加入Windows的两个触发列表和实际suite，原完整workflow字节逆向一致。

目前只有目标format/lint和纯AST／字节／JSON核对；Source26独立实现门、匹配canonical、发布及新exact-SHA CI仍待完成。已发布MCP CI配套修复a26c9ec88e660112b734934263219d16587e8841的Windows37438991856已正式success；主37438991921尚未取得终态，不能把候选或旧失败记成整套正式通过。并行RFC371全部保留并排除。本增量不关闭A-G、CS adapter或RFC，也不称AW已经部署到CS。

## SOURCE26-R1 功能修正

首门有效且稳定 FAIL，唯一 finding 是子任务继承测试新增 dropped disposition 后，完整预期集合遗漏 taskScriptRuns。保留原32个预期项，补入该唯一新键；原断言、测试名和预算保持。旧71项首末 witness、组合指纹及完整机械证明保留。修正后的完整 policy／wiring 精确迁移组为45组；配套集合必须与实际 disposition 双向相等，机械原体保留本身不能证明新增接线齐全。

a26c9ec8 主37438991921现已终态 cancelled，真实PG成功，普通分片和typecheck未全部完成；Windows终态success不替代主CI。Markdown作业112187769005实际报告80处历史Actions链接502，涉及多个RFC，不是本增量的本地文件链接错误；原失败保留，不批量移除历史证据或放宽检查。后继本增量的确切SHA CI仍需正式验收。

## 匹配生成的作用点接线补正

SOURCE26-R2有效稳定PASS后，原scoped census首次执行在原canonical验证处失败：task-execution effect ledger has unknown act sites；没有生成完整13份结果、没有发布。原四条规则和首轮输入／日志／started标记完整保留。新Script observer使用projection中既有resourceKeys，但原作用点登记要求显式resolver；仅补resourceKeys: (description) => description.resourceKeys，仍在原acquisition位置读取同一description的同一数组，不增加原生键解释或额外describe调用。现有selected双provider、可写脚本与receipt／settlement回归覆盖该完整路径；不改变业务算法、原Task effects分母或生成判据。完整policy／wiring仍45个迁移组，后继只复核这一生产差额及文档追加。
