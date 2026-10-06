# System 家族接线 CI fixture 修复

`388b4d9230e67f2c2bdfea5d50e224c641d33484` 的主 CI `37410742559`／job `112098398567` Typecheck 报出本批三类 fixture 类型问题：Narrative 的动态 properties 未参与 Object.defineProperties 的目标推断；两个原 queued recovery 用例仍把 native resolver 直接传给普通 dispatcher；W29 的嵌套 visitor 不保留外层 object-literal 窄化。Windows `37410742470`／job `112098397943` 正式 failure：一个新 fixture 断言硬编码 POSIX join，两个新 native spawn-failed 用例误认早退结果会携带 declared。

本批只补六个测试／helper 文件：Narrative 显式指定 object generic；W29 在既有、已验证的 object-literal 位置补同一类型断言，AST 恢复算法不变；两个 queued 用例只迁 import 到完整 native family fixture，其整段测试正文、全部断言与预算保持。新 helper 复用原普通 dispatcher 和两查询 native resolver，绑定同一个 runtime reference owner 与显式 fixture family，原 queued admission、DB／events／catalog 和异步派发均由原完整实现运行。

Windows fixture 改用原 node:path.join 判定实际 parent。native 用例继续真实创建 workspace／seed、编译完整 persona 并尝试不存在的 executable，保留 status／retainedRef／retention／seed／release 全部断言；增加实际 `binary failed to start:` 诊断以区分 scratch／compile 失败，并明确断言原早退结果不带 declared。这里修正新用例对原合同的错误预期，不改变唯一共同 core 或 native／selected 生产结果。原 core 的编译位于 `task-execution/application/systemAgentRun.ts:215`，declared 缓存虽已填写，原 early spawn failure 在同文件 `:423` 调用不带 declared 的 fail；只有正常终态 base 在 `:501` 投影该字段。

纯 TS AST 对拍核对两个 queued 用例完整 import 后正文、Narrative／W29 类型补正，以及所有未修改生产源码。目标 format／lint 与独立有限实现门补验；无本机 AW tests／typecheck／build／services，真实执行只由新确切 SHA hosted CI 验收。生产 population、四条原生成规则和12份 canonical 及原 status 未变，不重跑 census；下一普通后继仅退役上一批六个已消费匹配增长许可，保留129行顺序／why／baseline、原债／SPI／SCC与完整 sourceDigest。

原 Typecheck／Windows 失败正式留证，不记绿。Runtime 下一批仍处设计门；MCP、专用入口、H7／A-T7／A-G、CS 独立 adapter、M0 首次实际部署和 M1～M4 继续，AW 尚未部署到 CS，RFC 仍进行中。
