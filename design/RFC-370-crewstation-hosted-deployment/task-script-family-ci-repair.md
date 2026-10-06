# Script 家族的 CI 类型配套修复

464ae3290984faeca3afc355bfd2c2c270a2cb74 的 Windows37447284274／job112215066583 正式 failure：新增 Script fixture 的条件展开将 executionContext 推导为 optional，与 TaskDriveRequest 的 required 合同不符，TS2345 定位 rfc370-task-script-family.test.ts:422。该 job 在类型检查前实际运行了15个 SQLite 场景及一条 constructor identity 回归，全部通过；它仍是正式失败，不能用这些用例代替完整 CI。

本片只拆分 fixture 的调用：有实际 context 的14个场景保留 required 参数并交正常 provider drive；唯一既有 ownerless 兼容场景用明确 fixture 类型投影保留原来缺字段的运行时输入。没有修改生产合同或原 ownerless 行为，所有原场景、断言及预算保持。逆向这一个有限调用改写后可恢复旧测试全文件；新增断言仍验实际所选家族、真实数据库与收据顺序。

同 SHA 主37447284205 的完整终态为 cancelled：7 success、36 cancelled、2 failure，包含 Static scans 和汇总；维护压力37447284199 为 success。先前只读取 status 而遗漏 conclusion 的临时统计不作为通过证据。旧失败／取消回执保留，本批新的 exact-SHA hosted CI另验；不读取或分析 Static scans 的日志。

生产源码人口与 sourceDigest 完全不变，本片不重复原 census；只按既定一次性规则退役上一发布已消费的四项增长声明，全部129条库存、why、实际 counter及其余 canonical保持。STATE新增本片事实并保留完整旧字节与并行输出。仅目标 format/lint及纯字节／AST／JSON核对，无本机 AW tests/typecheck/build/service。

验证命令家族另在设计门；其未提交文档保留且不纳入这片修复。专用命令余项、执行权／恢复、A-T7/A-G、CS adapter、M0首部署与M1～M4继续，AW尚未部署CS，RFC不记Done。
