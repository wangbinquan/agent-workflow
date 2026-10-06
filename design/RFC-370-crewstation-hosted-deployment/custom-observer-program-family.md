# RFC-370 自定义事件观察程序效果家族

状态：阶段 A 的 A-T5／A-T7 功能设计候选；未实现，不包含 CS adapter。本片沿用已批准的先独立切面、再独立 CS adapter 顺序。

## 1. 当前实际入口

`event-center/infrastructure/customEventObserverProgram.ts` 同时拥有观察器业务规则和原生解释器／临时目录／文件／进程效果。`createCustomEventObserverProgram` 的 run 与 validate 都进入同一个 execute；它只在 `event-center/composition.ts` 装配一次。实际消费者是 SQLite CLI、PostgreSQL CLI 和 standalone SQLite HTTP 三根的 Event Center，以及沿这三个根进入的观察 worker 和人工 validation。

现 `CustomEventObserverProgramPort.run／validate` 已是高层业务合同，但不能在编写 CS adapter 时复制其中的 envelope／cursor／event／fixture 判据。现 `composeEventCenterWithPorts` 虽选择 persistence，仍固定创建原生 observer；必须补齐它的完整效果选择。通用 `observer` 是另一种非 custom 来源，不能用它的 override 绕过 custom validation。

原 `rfc310-event-center.test.ts` 的真实脚本 validate→publish→subscribe→observe→dedupe 链及原 `rfc359-w12-event-center-composition.test.ts` 双 provider 回归完整保留；不改变 source／revision、现 observer lease、cursor 或 delivery 状态机。本片不是 CS EventDelivery webhook 接入，也不新建事件中心。

## 2. 归属与独立目录

| 内容                                                  | 归属与层次                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| cursorValue／normalizedCursor／dedupeKey 三个原纯函数 | event-center/domain/customObserverProgram.ts，整函数 AST 与规则保持              |
| 执行输入、结果、opaque 引用和完整效果 factory         | event-center/application/ports/customObserverProgram.ts                          |
| 唯一 execute 与 run／validate 业务程序                | event-center/application/customObserverProgram.ts                                |
| 原生解释器、目录、文件、env、受管进程、清理           | event-center/infrastructure/local/customObserverProgram.ts                       |
| 显式普通组合与 local 选择                             | event-center/composition/customObserverProgram.ts、localCustomObserverProgram.ts |
| 旧基础设施公开 factory                                | 原地址仅作准确兼容转发，旧名／参数／返回合同保持，可增可选选择项                 |

本片复用已迁址的 platform/execution/local 进程机制和原解释器 resolver，不另造 command runner。common 不依赖 FS／OS／path／process／scriptRun／managedProcess；local 和以后 CS 的效果分别位于本 owner 的 infrastructure 子目录。wire DTO、路径、argv、PID 不进入 common 合同。

## 3. 完整所选合同

每次原 execute 到解释器读取点时，同步调用所选 factory.create(input) 一次，获得完整七成员家族；local create 只捕获原 input，不提前读取 getter、查询配置或做效果。

| 成员                                   | 共用程序的用途                                                | 原生对应效果                                                            |
| -------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| resolveProgram()                       | 返回 opaque programRef 或 null；null 保持原解释器不可用错误   | 原 resolveScriptInterpreter(language, {})，解释器对象保留到原 argv 时点 |
| allocateWorkspace()                    | 取得 opaque workspaceRef，成功后才进入原 try/finally          | 原 mkdtempSync(join(tmpdir(), 'aw-event-observer-'))                    |
| prepareWorkspace(workspaceRef)         | 在原 envelope 解析前等待目录准备                              | 原 inputFile／runDir 选择和 mkdirSync                                   |
| writeInput(workspaceRef, envelopeJson) | 原 schema／cursor／deadline 和 canonicalJson 规则之后等待写入 | 原 writeFileSync(inputFile, json, 'utf8')                               |
| writeProgram(workspaceRef)             | 保持原读取 language／source 时点及 write ACK                  | 原 INTERPRETER_SPEC、observer.ext 路径和 writeFileSync                  |
| run(workspaceRef, programRef)          | 等待原执行结果，交 common 保持原输出政策                      | 原 argv／cwd／env／timeoutMs／captureRawStdout 调用                     |
| disposeWorkspace(workspaceRef)         | 原 finally 等清理完成后返回或抛错                             | 原 rmSync(directory, { recursive: true, force: true })                  |

programRef／workspaceRef 的合同类型为 object；允许类实例、prototype 方法及抛错属性，common 不读取其中任何物理字段、枚举或序列化。local 用每次 create 私有的 WeakMap 解释配对，foreign refs 在读取后续原输入／运行命令前产生配对错误。缺成员或调用错误直接显露，不热读全局选择，不借 local 回退。

结果只暴露原 common 已使用的 outcome、exitCode、stderrTail、rawStdout、truncated.stdout；不导入原生 ManagedProcessResult。outcome 保持现五个原值及其错误文本：exited／timeout／aborted／spawn-failed／child-unkillable。取消／超时／reap／输出预算仍由已存在的本机受管进程实现负责，本片不改变该算法。

## 4. 唯一业务顺序与错误边界

共同 application 继续保持下列原 sequence，三纯 helper 完整迁址，其余政策块整 AST 保留。

1. 取得完整家族，等待 resolveProgram；null 抛原错误，没有临时目录或清理。
2. 等待 allocateWorkspace；失败不进入 finally。成功后进入原 try，等待 prepareWorkspace。
3. 原 schema parse：protocol／sourceRef／subjects／JSON cursor／deadlineAt；在原位置 canonicalJson，再等待 writeInput、writeProgram 和 run。
4. 原非零／非 exited 错误及最后 2000 字符 stderr、stdout 截断、trim／空串／exact JSON envelope、schema 检验保持。
5. 原 event key 和 input subject 归属判据、Date.parse、dedupe digest、summary／artifact／parameters、cursor 64KB 和 ObserverBatch schema 保持；stdoutDigest 仍取 trim 后同一 stdout。
6. 原 finally 等 disposeWorkspace；同步抛错／异步拒绝保持 cleanup 的原覆盖错误政策，不私自加入补偿吞错或新预算。

run 保持先读取原 published source，失败不创建家族；其后在原 now() 时点创建同一 execute input。validate 保持 fixture 非空／每个 subject type 覆盖判据先行，执行后 observation 非空／每个 event 输出证明及 draftDigest／validatedAt／stdoutDigest 不变。共同逻辑只有一套，替换效果不意味着替换业务程序。

## 5. 全部真实装配入口

`composeEventCenterWithPorts` 普通输入必须具有 complete customObserverProgram factory，由 common composition 传入共享 application。现带 db 的 compatibility `composeEventCenter` 可保留 optional selected 参数，但在 wrapper 外层以 undefined-only 规则明确选择 local，然后调用普通组合；不能在 application 内设置 native 默认。

同一 optional 选择从 StartOptions→sessionInput→两个 provider 装配贯穿；PostgreSQL application 在其实际 composeEventCenter 处选择，SQLite CLI 在自己的 composeEventCenter 处选择。standalone HTTP 在 SqliteAppDeps 与 composeApplicationEventCenter 同一根选择；已有完整 module 注入时原 fallback 条件不变。原非 custom observer、routing、delivery／automation／configuration／readiness 的全部参数和规则保持。

W29 只增加新效果选择的准确 inverse，旧根摘要、void／语句数量、三个阶段和预算全部保持；完整受触 roots 的 SourceFile AST 可按准确 selection／type／property 增量逆向为本片前像。其它旧测试、原生脚本人口和所有断言／预算完整保留。

## 6. 回归与功能门

新测试必须验证 complete selected factory 和 prototype receiver、opaque refs、每个七成员 ACK／失败／缺失、不回退、每次 execute 新实例、同步实现，以及 allocate 前后 cleanup 边界。业务场景覆盖 interpreter null、cursor JSON／64KB、deadline、五类 outcome／exitCode／stderr suffix、stdout 截断／空串／多个 JSON／schema 错误、unknown event key／input subject、dedupe／cursor／receipt、run published 不存在和全部 fixture 判据。

新增真实双 provider Event Center 场景通过同一所选实现完成 validate／publish／run／cursor／dedupe，明确命令入口与 worker 都没有原生兜底；原真实 native 脚本测试完整保留。测试事实与源代码 inverse／原生机制整 AST 证据分别记录。Windows 增加本片路径和适用套件，旧 workflow 逐字 inverse 和预算保持。

先独立设计门，再实现门、一次对应实际源码人口的原 scoped census、有限 matching 门和精确路径上库；功能运行仅由正式 exact-SHA hosted CI 验证，本机只 scoped format／lint、纯 AST／字节／JSON 和原静态生成。完整 H7／A-T7／A-G、CS adapters／M0 部署及最终 RFC 验收不由本片代签。

## 7. 有限范围与遗留

不修改原 event source revision／validation receipt／observer state 或事件投递状态机，不改变已支持的语言／协议／预算。不将其它 purpose 命令、integration adapter runner、indexer、plugin installer 或 CS producer 接入当成本片完成；它们按自己的现有合同与真实消费者继续核对。保留所有并行共享输出，不改原扫描规则或泛化豁免。实际迁址债由原分类器登记，最后 A-T7 全根继续收口。
