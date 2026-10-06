# RFC-370 Task Run 根选择的旧 MCP 正文检查兼容

50229ddd7aaebdf753ba17fa6271ee8202a12258 已上库，发布后 main 与 origin/main 0/0、index 空。Windows37533303831 completed/failure，Windows platform surface 的 RFC-254 platform suites 步骤失败。本批新 Task Run root selection、root content、workspace exclude selected 三组实际回归均通过；功能失败位于既有 rfc370-mcp-diagnostics-family 的 native MCP root completeness，旧完整正文逆变换尚未收编这次 Task Run 根选择的装配差异。

本修复只给该既有测试补充精确 Task Run binding 逆变换：核对并还原三个具名声明、两处内容选择、原四个 runtime 成员，以及 SQLite daemon 的两条透传字段。原 MCP 参数哈希、完整正文哈希、56／164／180 个原 statement、既有 behavioral 用例及预算保留；另断言新增转换次数，不改生产代码或通过更新期望值绕过旧正文检查。后续 script inverse 读取原生或新建 identifier 的结构字段，保持原方法名要求。

纯 AST 证明对发布基线的三个完整 root 正文分别恢复原哈希和 statement；目标格式和 lint 已完成。私有证明脚本首版的缺括号错误及修正记录保留，不属于 AW 应用或测试执行。未运行本机 AW tests／typecheck／build／service，也没有新源码 census。独立有限功能门、修复上库及新 exact-SHA hosted CI 另行确认；旧 CI failure 不改写为通过。

purpose 九操作实现的全部 WIP 保留且不纳入本次修复提交。完整 H7／A-G、独立 CS adapters 和首次 M0 部署仍开放，RFC 持续。
