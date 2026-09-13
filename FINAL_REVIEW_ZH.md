# ProofOrder 本地交付与复查

## 交付定位
基于 PR #1 合入后的 `main`：`1c6ffdebdd4358086f38db19cb191bec5b816516`，当前工作分支为 `feat/chris-workflow-completion`。此次是可运行的本地可信验证者原型补全，不是生产版本，也不是全部参赛交付完成。
本次新增内容来自 AI 实现与 AI 复查；Chris 在本次代码切片中没有被记录为作者，也没有独立批准安全关键实现。按仓库责任表，Chris 仍是 Teammate B，Qy 仍负责冻结 OrderSpec、证明陈述和最终买方流程。不得把本次 AI 提交当作任何成员已完成的人工贡献或验收。

## 主要交付
- 冻结任务常量、规范化 OrderSpec、独立买方 checkpoint 校验。
- buyer/provider/verifier 分开的 CLI 进程；初始化、付款、提交、验算签名、验证、结算、退款、离线恢复。
- provider 校验链上订单与本地摘要；重复提交不重写密文；初始化拒绝覆盖已有状态。
- 无交付包也能走超时退款，状态区分验收、支付和可观察交付。
- 验证者认证解密实际密文、重新计算规则和 evidence 后才签名。
- 14 个新增合约对抗测试。现有结算合约逻辑未改动，不为制造人工改动而重写。
- ethers 依赖更新、构建产物路径兼容处理。

## 主助手复查发现并修复
子任务曾保留 plaintext-only 验证分支。它只能验证另一份明文，不能建立其与密文的关系。因此主助手将该分支改为 UNBOUND_PLAINTEXT_REFUSED：只允许对实际密文认证解密的路径。先运行回归测试观察失败，再修复。对应测试日志：delivery-logs/parent-plaintext-red.log。原先仅传明文的非法分配测试也改为真的加密非法分配后验证拒绝，避免只覆盖接口参数。
CLI 的 --verification-result-file 不作为可成功验收的方式；即使仍可解析该旧参数，明文单独提交也会被拒绝。应使用 --verification-key-file。

## 最终实跑
Codex 在 Ubuntu WSL 的 Linux 文件系统临时副本中重新执行 `bash scripts/reproduce.sh`；退出码 0。环境为 Node v26.5.1、npm 11.17.0、Foundry v1.8.1，所有 Anvil 流程都只连接本地 31337 链。
- `npm test`：196 通过，0 失败。
- `forge test -vv`：38 通过，0 失败，3 个 suite。
- 单独 CLI 流程：5 通过，0 失败；这 5 项已包含在 196 项中。
- `npm run demo` 与 `npm run demo:failures`：均通过。
- WSL 的 `npm ci --ignore-scripts` 和 `npm audit` 因代理连接错误无法访问 npm registry；Windows 执行的干净 `npm ci --ignore-scripts` 成功，随后 Windows `npm audit` 在同一 lockfile 上报告 0 vulnerabilities。测试和演示是在 WSL 运行的。
- 完整日志：[0017-codex-wsl-reproduce.log](evidence/runs/0017-codex-wsl-reproduce.log)。日志已扫描私钥/助记词标记；匹配项仅为测试名称，不含私钥材料。

演示报告显示主流程状态为 `Settled`、固定 payee 收到 1 ETH、托管余额归零、买方 checkpoint 后 nonce 不变且无买方交易；失败流程的两笔退款均进入 `Refunded`，退款模拟拒绝调用没有改变状态、余额或 nonce。报告继续将公平交换标记为未实现的反例。以上是 AI 运行和复核，不是 Chris 或其他成员的独立人工复现。

## 如何运行
需要 Node.js 22+、npm、Foundry 的 forge/anvil 在 PATH。源码包内包含 forge-std 源码，不包含 node_modules、编译产物、运行时私钥或 .git。

```sh
npm ci --ignore-scripts
bash scripts/reproduce.sh
```
单独查看新 CLI 自动化流程：
```sh
npm run test:cli
```
具体手动命令见 DELIVERY_REPORT.md。全部命令只对本地专用 Anvil 运行，不使用真实钱包或主网资金。公开演示使用本地解锁账户；这不构成用户、进程或文件系统级安全隔离。

## 仍未完成／不得宣传
- 真实人工理解、修改决策与签字、T20 独立人工验收。
- ZK：当前是可信 ECDSA 验证者，不是零知识证明。
- 公平交换：先披露可被免费取得结果；付款后披露可能被提供方扣留，机制边界仍存在。
- 验证者目前取得演示用解密能力，可看到结果，不保证对验证者保密。
- 真实采购数据与商业需求、UI、真实 Agent/LLM 自主调用集成、公网测试链部署、参赛视频与最终资料。
- 正式安全审计、高并发、多设备故障恢复、链重组与生产服务加固。

## 文件
- 源码 ZIP：可阅读及本地运行。
- 补丁 PATCH：针对上述 PR HEAD，仅含代码与文档，不含运行生成密钥。
- 保留 BASELINE.txt、原有 LICENSE 和贡献来源。
本报告不替代独立人工 review、T20 或 Qy 的最终验收；这些仍按仓库责任表待完成。当前 PR 中的 commit、分支和状态以 GitHub PR 页面为准。
