# A-T5：System Agent 共同核心与选中准备

状态：源码增量候选。沿用已批准的 [选中工厂设计](./agent-invocation-factory.md)，阶段仍为 A-T5；真实根、保留引用消费者、完整 Agent 单元和 A-G 继续实施。

System 的结果、流式取证、辅助 sink 降级、authoritative 会话认领、terminal 重试、超时／取消、unreaped 保留和捕获后清理整体迁到 task-execution application。正常 composition 必须接收已选中的两阶段准备：一次 `compile(intent)`，原 late boundary 调用同一材料的 `bind()`，随后绑定真实执行与回执。正常结果使用 workspace 的逻辑 `retainedRef`。

原 `services/systemAgentRun.ts` 保留完整 native options／result／seed／status API，原材料编译和 wrap-only 规则，以及原 registry 选择、路径和 getter 读时点。它通过同一核心执行，并在 native compatibility 边界把结果和保留诊断的逻辑字段投影回原位置的 `scratchDir`；原 helper 名称继续转出口。原 `onSpawned` 的存在性在原回执安装时点读取，正常 composition 确认所选 owner 回执。共同核心只接收中立调用能力。

两阶段工厂捕获根已选中的 compiler、workspace、binder 和 cleanup，不在编译或绑定阶段重新选择实现。每次编译有独立的一次绑定状态；绑定错误保持原错误边界。未完成绑定时，原 finally 通过同一次材料的 cleanup 释放，保留实际 receiver 和惰性执行时点。native composition 私有保留实际 plan，Task 的 cmd／env snapshot 留在 late binding，取证继续读取同一 plan 的 late env。本机材料定义在 native 选择点经原 runtime 入口取得协议／取证实现，编译直接调用完整原双协议材料函数。

session 事件合同整体归 runtime-management application，原 service 作为 type-only compatibility 转出口。System 的正常需求端口经 RM exact public 消费该合同和原输出证据 DTO，不让 RM offered 面反向承担 TE 联合执行需求。

纯结构 AST 对拍核对整个实际共同业务核心、native 原九项前置读取、完整编译／绑定算法、四个兼容合同、全部原 helper 和完整事件合同。原双协议材料文件只增加原函数的 export token，其余完整字节保持。workspace ENOENT oracle 只迁移实际共同核心地址；PWD oracle 跟随真实 TE binding／共同核心，完整原谓词、断言顺序和预算按逆映射 AST 保持，并增加 native facade 委托断言。Windows 的 push／PR 路径和实际平台 suite 同时登记两个新测试文件。

新增八项准备回归和十四项共同核心回归，覆盖同材料身份、选定实现保持、compile／late bind／cleanup 错误、seed 读取、实际 opaque 回执确认、辅助与 authoritative sink、terminal 重试、capture→cleanup 顺序、unreaped、删除失败及原结果分类。正式执行交确切 SHA hosted CI；当前只运行目标 format／lint 和纯 AST／字节证明。

原 SOURCE18-DOC1 R1 独立功能门的一个 P2／FAIL 保留：native preparation 的两次对象展开丢弃合法 prototype getter／method。后继逐项转发完整 binding 与 scope，并调用原 receiver，optional live lookup 仍在真实消费边界。新增真实 local preparation＋native binder 的 class／private-field 回归，同时确认 late Task cmd／env、late evidence env、原 owner 回执、session／inventory／live 取证及 cleanup；缺可选 location 时保持原无路径输入。Windows 两事件的四处旧 RM binding 地址跟随实际 TE 文件迁移，原路径谓词和平台执行预算保持。

`c835052b` 的 Ubuntu16／Mac4 原地址库存等式还发现已发布 native pairing 迁到 TE 后的两条真实兼容边。只把已在 matching cross-context imports 登记的两个精确地址同步到原 inventory，原 classifier、完整等式与其余断言／预算均保持；没有扩展匹配规则。新 preparation 的材料控制器从 RM exact public compiler 与原 native plan 合同声明，scope 从本地 binder 的已有输入投影，不新增跨 owner implementation 类型导入。

原初次 lint 的三项错误和 proof helper 的 printer／格式诊断保留。后继按原 runtime 入口、const 及结构 AST 修正，没有放宽规则或预算。前次 `221c98ab` Windows37313502767已正式 success，主 CI37313502601为 cancelled；包含它的 `c835052b` 主 CI37313859339为 failure，各原终态保持。这个候选的源码门、matching canonical、精确发布和新确切 SHA CI分别验收。

本批使所有原 System 调用经 compatibility 自动共用同一执行算法。后续仍须贯穿 Task／System／smoke 的所选能力到两种 provider、启动／重装配／HTTP、Intent／Memory／Narrative、MCP 和诊断真实根，并与正常 `retainedRef` 的 reader／cleanup 同批迁移。继续脚本／purpose command、执行权／恢复、全部装配和独立 A-G；随后各 owner 独立 CS adapters，M0 首次实际部署后逐项 M1～M4。当前 AW-in-CS 尚未部署，RFC 保持 In Progress。
