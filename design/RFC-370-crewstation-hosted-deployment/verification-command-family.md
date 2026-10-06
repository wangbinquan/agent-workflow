# DA 验证命令的完整效果家族

本增量属于已批准 RFC-370 阶段 A 的专用命令切面，承接 Script 家族。它只分离既有验证效果；完整 A-G、各层独立 CS adapter、M0 首次部署及 M1～M4 顺序保持。此次不增加验证能力或改变已有 profile 的含义。

## 原行为与切面

实际生产入口是 development-automation/composition.ts 的 verificationExecution.run；现每次调用创建 repo resolver，然后解析 profile，并调用 infrastructure/verificationRunner.ts。后者同时拥有完整 AW 规则和本机 resolver、临时输出文件、Bun.spawn、超时树杀、尾部及 file-glob 证据收集。已有 application/ports/reconcilerPorts.ts 的 VerificationExecutionPort 是上层任务合同，不能以替换它并分别复制规则完成适配。

唯一共同规则迁入 DA application/verificationRunner.ts：按原顺序逐 step 执行，解析失败产生同一零时长失败行，按 successExitCodes 与 timedOut 判断结果，原 first-failure／collect-all、串行 maxParallel=1、最终 ok 及 receiptDigest 投影完全保持。Date.now 的开始与结束读取保留在原位置；时长继续不参加摘要。stdout 文本不参与成功判断。

新增 application/ports/verificationCommandEffects.ts。整个所选家族覆盖 resolveProgram、execute 与 collectFiles；解析结果是 owner 持有的不透明 object 引用，workspace 字符串只作为已有工作区 owner 给出的引用转发，普通规则不解释 argv、路径或 PID。execute 返回 exitCode／timedOut／outputTailRef 三个原事实，collectFiles 返回原 selector／path／sha256／bytes 事实。resolveProgram 可同步或异步；共同规则等解析完成后才执行，异常保持原位置向调用者传播。执行接收完整原 step 对象，以保持 timeout 的原读取位置；networkProfileRef、argsRef 与 maxParallel 的原实现边界保持，不新造网络或并行规则。

VerificationCommandEffectsFactory.create 接收本次模块使用的同一 EvidenceArtifactPort，返回完整家族；每次 verificationExecution.run 创建家族，保持原 resolver 创建时点以及 profile 解析先后。所有成员以对象方法调用，保留 prototype／private receiver。选中家族缺成员或拒绝时不回落本机。

## 本机配对与真实根

infrastructure/local/verificationCommandEffects.ts 保存原 resolver、执行及 collectGlob 完整机制。原程序对象由私有 WeakMap 保留，解析时不读取 argv；执行才在原位置读取 argv，完整 spawn 参数不变。原临时目录、stdout／stderr 直连文件、detached、TERM→KILL 的 2000ms 宽限、2000ms reap、各 64KiB tail、合并输出、finally 删除，以及每个 selector 最多 64 个文件和路径排序逐项保持。原 spawn／await 错误边界不扩大、不挪入新 finally。

composition/localVerificationCommands.ts 是显式 native 装配入口。DA 模块选项必须提供 verificationCommands 工厂；SQLite HTTP／CLI 和 PG 三个真实根接受可选覆写并显式选择完整 local 默认值，CLI 初始／重装与 PG 入口全程转发同一选择。直接模块 fixture 显式选择 local 工厂；不以模块内部默认本机效果掩盖遗漏接线。

旧 infrastructure/verificationRunner.ts 保留 createRepoScriptResolver、ResolvedVerificationProgram、VerificationProgramResolver、VerificationStepResult、VerificationRunReceipt 及 runVerificationProfile 的准确公开名字和原参数形状。它作为 native compatibility facade 选择给定 resolver／evidence，并委托唯一共同规则；普通生产装配不再导入该 facade。

## 功能验收

原 RFC310 真子进程测试、名称、断言及时间预算保持；实际 spawn 地址登记只从旧 runner 移到 local 文件，原扫描器和判断不变。三真实根及 W29／MCP 完整根摘要仅逆掉准确的新工厂选择和透传，保留全部原 body／参数／语句数／摘要，另有双向工厂接线断言。

新增共同规则用例覆盖 opaque program/workspace、异步解析与执行 ACK、prototype/private receiver、解析 null、解析／执行／采集异常、首错停止、collect-all、自定义退出码、timeout、原 stdout-tail 不另收文件、多个 selector 顺序及摘要排除 duration。新增真实 SQLite／PostgreSQL 模块链路用例沿原 verification action 触发所选家族，检查原验证事实与发布链先后；有限 fixture 不能替代实际 CS 或远端耐久性证据。

设计门和实现门限定本批文件与必要原 control；本机只做目标 format/lint、纯源码／AST／字节／JSON及一次必要原 matching census。正式执行交 exact-SHA hosted CI，保留此前 CI 的成功／失败／取消状态。此增量不关闭专用命令余项、执行权／恢复、A-T7、A-G 或完整 RFC，也不声称 AW 已部署到 CS。

## 实现候选核对

24个本片路径包含9个生产源码。共同规则、完整 local 机制、旧 native facade 和必选工厂均已落位；SQLite HTTP 的实际默认选择在 composeFallbackDevelopmentAutomation，PG 与 CLI 在各自原根。CLI 的 PostgreSQL 透传使用实际 composePostgresqlProviderSession，初始及 SQLite HTTP 重装保留同一工厂。

纯源码证明覆盖12组完整原 resolver／collectGlob／interfaces／常量／physical mechanism／共同策略／兼容签名，14份绑定前像的完整 AST，以及5份实际 composition／透传函数的全函数体和参数：原语句数分别为7／164／180／44／5。W29、MCP、spawn登记与Windows workflow完整逆向证明保留所有原判据、摘要和预算。8个真正的直接模块fixture共11次调用显式选 local；RFC359-T3中的两个文本引用没有实际调用，完整原文件保持，不将其算作已接线入口。

新增13个共同规则用例、8种实际模块验证情形在SQLite／PostgreSQL各执行，以及5个组合合同用例，交正式CI。模块链路覆盖完整发布的profile／policy、真实mission／attempt／snapshot，所有正常和异常结果均等待stage cleanup的异步ACK，之后才生成原验证事实或向调用者传播原异常。stdout里的“passed”不参与成功判定。本机只做自有format／lint与纯AST／字节核对，未执行AW测试／类型检查／构建／服务。

候选内容证明不等于独立实现门或hosted CI通过。7ebdc4f的Windows仍是TS2352正式失败，唯一ownerless类型擦除不变的后继修复独立发布；不与本家族混提。一次原matching census、有限元数据门、发布和新精确SHA CI随后分别留证。doctor／其余命令、H7 authority/recovery／background、A-T7/A-G继续；CS adapter尚未开始，AW未部署到CS，RFC保持In Progress。
