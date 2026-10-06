# A-T5／A-T7：Intent 自有 System 执行需求合同

`388b4d9` 的 exact-SHA 主 CI 37410742559，macOS shard 2／job 112098398835，原 offered-edge DAG 守卫报告三条新 public 出边：Intent dispatcher／turnEngine 到 Task Execution，Intent auxiliary port 到 Runtime Management。System 接线的实际执行族保持正确；跨 owner 的需求声明仍需由 Intent 自己拥有。这里补齐已批准 A-T5／A-T7 的合同落位，不改变 DAG、不增豁免、不复制执行算法。

Intent application port `intentSystemAgent.ts` 声明它实际需要的 run、workspace scope capture、retained content release 和结果字段。输入保留实际调用中的 persona／prompt、双 protocol、同一 opaque runtime content identity、原 seed／config-dir／model／marker／signal／sink／cap／timeout／retention。内容 reference 只声明原三 owner 的结构字段，业务不解释 reference／version；scope 保留原逻辑 namespace／name。event sink 使用 Intent 自己的实际 sink 类型。结果保留原完整 status union、event text／diagnostic／duration／session／retained ref／retention 与共同分类需要的输出证据，未消费的 provider 额外字段不在需求中重声明。

这是结构兼容的 consumer-owned port。原 `SystemAgentRunFamily` 必须在类型检查中可直接赋给它：同一对象、method receiver、workspace 和 release owner 全部保持，不加运行时 projection／fallback，也不把 object／any 强制 cast 成另一套 refs。新 Intent reference 结构逐字段等于原 AgentMaterialContentReference；普通 resolver 使用它，native composition 仍颁发原对象。dispatcher／turnEngine 仅迁 type imports，无一个业务语句、回调、read／await／catch 位置变化。新 port 不 import 其他 bounded context 的 public 或内部合同；它只用 shared 与本模块、platform-neutral utility 类型。

`classifyMissingEnvelope` 及完整 MissingEnvelopeReason 原声明移入 shared 的纯协议规则，保留原五类理由和完整分支／比较顺序。输入声明它实际读取的五个证据字段；Runtime Management 完整 output evidence 继续结构兼容。Task Execution 原 application 和 native/public compatibility export 转发同一个函数，Memory 及旧 consumer 入口保持；Intent 从 shared 消费，不通过另一个业务 owner 取得协议分类。旧 helper function 的完整 AST／字符串／运算符／顺序逆向对拍，原 core 剩余全文不变；追加纯分类回归覆盖 undefined、字节 cap、无文本、两种 terminal、assistant stop 与 cap 优先级。

新 hosted 功能用例把真实完整 family 静态赋给 Intent 的需求类型，并经已有真实 Intent／HTTP／queued 用例继续验证，不能只用接口 shape 假实现替代。已有 System caller、native fixture、两个 provider 的 DB／events／receipt／retention 正向和错误断言全部保持。Shared 新规则逐项测试，不降低原测试预算。正式运行仍交确切 SHA hosted CI，本机只做 owned format／lint、纯 AST／字节证明及有效源码门后的唯一 scoped census。

另外，Ubuntu shard 3／job 112098398949 的 `opencode-spawn-pwd-env.test.ts` 仍把已迁出的 Memory parent 物理 join 断言放在 distiller 内。该纯源码 oracle 随实际地址迁移到 Runtime Management 的 selected retained-content owner，原 follower-chain 唯一 name、完整 family 委托、无重建 plan／executor／Bun.spawn 及 cwd／env 配对判据继续保留；不把字符串藏在注释以冒充接线。

这项补正与六文件 CI fixture 修复分开做有限源码门；已通过且未变的候选内容门复用。原三条 offered-edge 应实际消失，不录额外 debt；由原 source census／classifier 和 matching 清单如实记录该批 production delta，四条原规则、129库存顺序／why、其他 guard／SPI／SCC 和并行内容保留。Runtime 诊断族仍是下一增量；MCP／H7／全根／A-G、CS adapter、M0首次部署及 M1～M4继续，不关闭 RFC。
