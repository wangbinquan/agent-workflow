# RFC-370 Task Script：匹配清单与发布候选

本批仍属于阶段 A 的 A-T5。完整实现与旧行为 oracle 见 [Script家族接线](./task-script-family-wiring.md)。候选、源码功能门和静态清单各有边界；正式行为只由新确切 SHA 的 GitHub CI 验收。

- SOURCE26-R1 有效稳定 FAIL：子任务 dropped disposition 新增一键，原完整预期集合漏该键；保留原32项后补入。
- SOURCE26-R2 有效稳定 PASS；首轮原 scoped census 在原 canonical 验证处失败，未写完整13结果，也未发布。原输入、规则、日志及 started 标记保留。
- SOURCE26-R3 有效稳定 PASS，26 owned／17 control／16 evidence 共59，组合指纹 dff3da670ee53c02c1218df16cfeba94e48f889ffb26e3c93a411d7ace5281c9。唯一后继生产差额是显式资源 resolver，返回原选定 description.resourceKeys 的同一数组和读取位置。完整策略／接线仍11文件45组，全部 native 算法、原断言／名称／预算与三个完整根保持。
- 新增15场景 × SQLite／PostgreSQL及错误constructor身份，共31个预期用例；同时进入Windows实际suite。覆盖三语言、依赖失败、缺解释器／成员、重试換树、可写合并、取消／超时／非零／truncated／nonce envelope、完整owner身份及start ACK先于输出。

后继有效原 scoped census 只执行一次，以完整 committed 85cdf556e973e26890537035f24988075c190a51 加冻结26 owned为人口，6582个非自有源码从该基准精确blob读取。初次失败属于不同源码人口，留证且不重跑该旧候选。四条原生成规则全部不变；13份完整结果 sourceDigest 为 sha256:0673df097f068e92d2d122b794d09987684684912ccf22cc284bfc1cee36fd28。所有生成输出仅写私有目录，发布临界区必须再次验证共享前像。

保留全部345条旧authored债、129个有序库存及why、214个原guards、40个SPI／69个target、9个Task effects及原SCC。四条新债准确记录两个legacy service向真实local owner的value／type identity reexports；并非新增业务耦合豁免，待A-T7收口。仅实际mutation1915→1917、observed imports6632→6661、exceptions5834→5863、owners27110→27130分别声明匹配一次性增长，下一正常后继退役。其它库存及原规则不变，共享STATE旧全文及并行已提交输出保留。

已发布a26c9ec88e660112b734934263219d16587e8841的Windows37438991856终态success、主37438991921终态cancelled。包含a26的85cdf556主37439571232终态failure：46 success／3 failure／1 cancelled；macOS shard5、真实PG与typecheck作业success，macOS shard6 cancelled。文档／Static／required失败状态保留；不把这些有限证据称为整套CI成功，也不以该旧SHA验证当前Script源码。

本机只有自有format/lint、纯源码／字节／JSON证明和原静态生成，没有AW tests/typecheck/build/service。A-T7／doctor／专用命令／authority／recovery／background及完整A-G仍继续；CS adapter和AW在CS部署尚未开始，M0先实际部署、M1–M4逐项接入的顺序保持，RFC未完成。
