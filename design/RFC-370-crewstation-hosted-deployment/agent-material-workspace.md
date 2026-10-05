# RFC-370 原生材料生命周期切面

本片属于 A-T5：将 Task、System Agent 和 runtime smoke 的真实目录准备、seed 写入及删除，收归 runtime-management 的材料生命周期端口和 local adapter。普通合同只包含内容引用、相对 seed 内容及 prepare／discard；既有 native API 继续使用私有位置投影。材料编译、取证、执行及回执的完整 selected 组合和所有装配根尚未完成，本片不关闭 A-T5／A-G，也没有 CS adapter 或 AW-in-CS 部署。

## 原行为保持

- Task 的 run root 仍为原 app-home／task／node 路径，构造和 prepare 不提前建目录。既有材料 builder 的失败边界保持；capture 后仍先调用原 plan cleanup，再 best-effort 删除同一 run root，不删除工作树。
- System 的原 feature／随机名称、显式 scratchName、parent 读取顺序、worktree／run 布局和 seed 字节保持。seed reader 仍在目录创建后惰性读取；准备失败仍沿原 catch 删除，执行失败或未 reap 保留，成功按原 retainScratchOnSuccess 决策删除。原 cleanup 首错、保留标记、sink complete／incomplete 与重试算法不变。
- Smoke 的 nonce、目录随机名称顺序、app-home scratch 布局保持。prepare 仍在原 builder try 外；准备／spawn 失败沿原删除策略，unreaped 保留，完成后的删除失败仍按原结果分类。
- releaseSystemAgentScratch、assertSafeSeedPath 整体原函数移入 local 实现，旧服务导出指向同一实现，没有增加新规则。

## 验证

纯 AST 对拍证明，除明确的目录／seed／删除映射外，Task、System、smoke 三份完整原算法相等；两个迁移函数完整 AST 相等。PWD 原检查跟随实际 local 布局，其余用例与预算保持。六个新增真实文件用例覆盖惰性创建、原 seed 字节、名称／reader 时机、准备失败后由 caller 决定删除、工作树保留和 smoke 内容生命周期。

Windows push／PR 对称增加三个实际路径，原 suite 追加新测试，逆变换后其余 workflow 原字节相等。source 候选独立功能门、matching architecture 投影和新 exact-SHA CI 分别验收；没有本机 AW tests、typecheck、build 或服务。生成只使用已提交基线和已审候选，排除并保留并行 WIP，旧 FAIL／cancelled 记录保持。

下一步仍是匹配材料／取证／生命周期／执行／receipt 的完整组合、真实 composition 传递和非本机 fixture；随后脚本、执行权／恢复及 A-G。A-G 之后才进入 M0 必需 CS adapters、首次部署和 M1～M4 增量接入。
