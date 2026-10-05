# A-T5 完整 Task 共同核心：第一批实现

本批实现已批准的 `task-agent-common-core.md`，拆出完整共同算法、显式 native compatibility 和正常材料 preparation。五个生产调用点仍调用原兼容出口，正常 Task purpose 尚未贯穿真实根；本批不关闭 A-T5、A-G 或部署验收。

`application/taskAgentRun.ts` 保留原完整 `runNode` 与纯 helper。原 `RunNodeOptions` 的 51 个成员及注释保留在 native 类型；正常 policy 保留原 43 个业务成员。`services/runner.ts` 保留原 14 个导出，并将运行入口委托给同一个共同核心。原 plugin-load decoder 整体归入 native 实现。共同核心只在 15 个已设计的位置改为必选 purpose，并将该次 workspace 传给选中 preparation；其他业务语句保持。

purpose 在原初始化位置提供 prompt、archive、workspace 和 Git observation，在原 nonce await 后选择材料，在原独立 mount 位置准备挂载。材料读取和 compile 继续位于原 catch，compiled handle 在原位置 bind 一次。原 command snapshot、late evidence environment、日志原任意 diagnostics、实际 MCP getter、native fixture 省略状态和 cleanup receiver 留在显式 native compatibility。正常 preparation 显式组装完整 intent，保留有序 profiles、可选成员的省略和 receiver，使用同次已选 compiler、binding 和 diagnostics。R1 独立有限门的一项 P2 保留：资源对象展开会遗漏 prototype getter 并覆盖业务 injection；R2 仅按存在性显式读取 plugins/skills，补 class private 字段 getter、原读取顺序和 MCP identity 回归。执行 participant 在原 receipt 位置颁发；已有 local 实现只补强其原返回类型，颁发函数体不变。输出校验与归档使用同一 purpose 的 workspace reference。

39 个既有测试文件的源码读取跟随实际 implementation；原测试的其他 AST、断言和预算完整保留。源码 helper 只读取当前共同核心、native binding、完整 options 和原 plugin decoder，不读取历史或生成快照。RFC-282 的业务消费方检查覆盖真实核心和 native 实现，原 facade 专用导出检查继续检查 facade。RFC-080 的 output-validation 地址另跟随前批已迁出的完整 policy。

新增 14 个用例：正常双 runtime／双 provider 的共同核心成功链路四例，双 provider 的 mount／compile 错误边界四例，完整 normal preparation 三例，native compatibility 三例。成功链路经过真实共同核心、正常 preparation 和实际 persistence，验证一次 compile/bind、完整 intent、有序引用、receipt／owner acknowledgement 先于 activation、串行输出及异步 validation/archive 同引用；错误用例验证原抛错身份、原 running／failed 状态和不提前清理。选中执行 fixture 不替代五个真实入口或 journal owner 的部署证明。

纯源文／AST 对拍已核对完整原函数的有限逆向替换、完整原声明和 helper、legacy export 集合、local participant 颁发函数体及 39 个测试的有限地址迁移。owned format/lint 通过。本机不运行 AW tests/typecheck/build/service；独立源码门、一次原 scoped census、matching metadata 门和 hosted exact-SHA CI 分别验收。原失败、取消和所有并行内容保持。

Windows 4bb78e49 的确切运行 37365764280 成功，其主运行 37365764307 在执行 jobs 前取消；后继 eef1e3ad 主运行 37366048964 的两个实际失败 job 是旧 RFC-080 和 envelope prefix-swap 源码地址守卫：本批 RFC-080 两个读地址已迁到真实 policy/core，原全部断言保持；并行 bfe27e75 已保留对 prefix-swap 读地址的修复。本批不代替后继 CI 的正式验证。既有 PostgreSQL question-set stash 失败仍未证实原因，不用本批重构宣告修复。

下一步给 nodeMechanics 三处和 wrapperMechanics 两处真实 Task 调用显式接线，并贯穿全部实际根；System／smoke／retention／RC-MCP 与脚本、authority/recovery 联合收口后才到 A-G。之后按各层独立 CS adapter，先完成 M0 实际部署，再逐项 M1～M4。当前 AW 尚未部署到 CS，RFC 保持 In Progress。
