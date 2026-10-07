# RFC-371：原生采集选择的驱动能力修复

原 `86c28e48624b7c0e23803bf92b825c282b2d1c81` 的 Windows CI（`37564594925`）在既有 RFC-143 能力回归用例中失败：Task 的原生采集装配直接比较 `runtime.protocol` 与 `opencode`。原守卫、白名单、断言和预算保持，不新增豁免。

实际修复由 runtime-management 的原本机材料定义读取所选驱动的 `prepareNativeUsageCapture` 能力，经 exact `public/queries` 提供布尔查询。Task 装配仅询问该能力，再核对原冻结注册 ID／配置修订；不在业务层按协议名称分支，也不创建第二份驱动注册表。原 OpenCode 驱动提供该方法，原 Claude Code 驱动没有该方法。

原已选注册、修订匹配、Task 上下文、完整根集合和 baseline reader 都保持。缺少 runtime、能力不可用、注册或修订不符仍不接入；空安装配置默认 OFF；旧直接 factory 未提供 admissions 时仍可使用。此变化不筛选统计人口，不改变四类 Token、人民币价格、原来源或完整读取语义。

新增回归直接查询两个实际驱动的能力，原双 provider 的选择、不可变修订及 10001 配置条目用例全部保留。原 RFC-143 全树能力守卫继续作为禁止业务协议分支的回归。仅执行本片文件格式、lint 和无断言静态语法检查；本机不运行 AW 测试、类型检查、构建、E2E 或压测，原失败证据保留，功能结果以提交后的确切 SHA hosted CI 为准。

SOURCE 和匹配 canonical 登记分别复核实际候选；共享启动根及其并行 Task 配置依赖按原提交分工保留。原生采集的真实新建／续接／并行验证、完整规模验收与两个 RFC 仍待完成，不将本片修复称为 RFC 完工。
