# RFC-370：原 SQL 方言语料的重复解析修复

精确 `f54fa4ae3c16e36f350fa4e676f10446e7e7ed16` 的 Mac 后端 shard 12 job `113978235651` 正式失败：原 `rfc359-w5-t20-dialect-completeness.test.ts` 的「可移植核心无过期条目」case 在 `5245.93ms` 后触及默认 `5000ms` 预算。该分片实际 `1472 pass / 2 skip / 1 fail`、194 文件，失败全文保留。前一 SHA `03a0687c` 的主 CI 72/72 和完整 Windows 1/1 已全部成功；这不代签新 SHA 总绿。

本文件原模块采数已经对同一 `SURFACE` 中的非渲染器调用 `sqlFunctionNames(file.path, file.text)`，J2 反向断言又在 case 内重新解析全部语料。现在在原模块采数处取得同一函数数组，一方面仍交给原非渲染器声明检查，另一方面收集完整语料的已用函数集合。收集在原渲染器 `continue` 之前，包含原矩阵和所有渲染器文件；未用非渲染器集合代替完整人口。原 `SURFACE` 读取／排序／归类、字面量提取、关键字／CTE 排除、方言词汇表、shim、原渲染器豁免及所有账本保持。

原反向 case 只读取该全量集合，不再解析相同文本。原 stale 计算、matcher、负 fixture、13 个原 case 和其全部断言及默认 5 秒预算保持；没有改变 SQL 判据、增加预算或复跑取绿。完整旧全文与精确 inverse 作为保留证据，独立功能门与新精确 SHA hosted 主 CI／完整 Windows 另验。

无生产实现、架构 metadata 或四个原 census 规则改动，无本机 AW tests／typecheck／build／E2E、TypeChecker 或新 census。生命周期 L 的 69 项 SOURCE18-R2 材料保持，L census 未启动；H7／A-G、各层 CS adapter、M0～M4 和 RFC 仍开放。
