# 上游与社区调研记录（2026-11-27）

> 背景：在 Antigravity 2.35.2 上为 agy-max 排定后续改进顺序前，联网补查了官方更新日志、Hooks 文档、SDK、三个上游项目（agy-fast / agy-powertools / obsidian-prism）以及社区反馈。
>
> 最大的新发现：**Antigravity 11 月 17 日的 v2.33.0 自带了 SSH 远程开发**，和我们 v1.4.0 的招牌功能 SSH 项目正面重叠，因此调整了推荐顺序。

## 1. 官方已内置 SSH（影响最大）

来源：[官方更新日志](https://antigravity.google/docs/changelog/)

- **v2.33.0（2026-11-17）**：可以从侧栏、项目菜单或命令面板连接远程 64 位 Linux 机器。读取 `~/.ssh/config`，自动在远端安装服务；项目、Git worktree、Agent 和终端都直接运行在服务器上，关闭窗口也不会断开。
- **v2.35.0（2026-11-23）**：输入框中的 Environment 选择器移到 Project 和 Branch 前面，SSH Host 直接放进了这个菜单。

打个比方：我们自己修了一条通往服务器的小路，官方刚修好一条正式公路。继续加固小路之前，需要先想清楚：

- 我们的 SSH 项目与原生 SSH 各有什么不同？
- 在 2.35.2 的输入框里，两套入口会不会冲突？

## 2. Hooks 能力比我们用到的多（支撑第 1、2 项）

来源：[官方 Hooks 文档](https://antigravity.google/docs/hooks?app=antigravity)

- `PreToolUse` 的 matcher 支持正则，`"*"` 表示匹配所有工具。
- 除 `deny` 外，还可返回：
  - `ask`
  - `force_ask`：无论之前是否点过“总是允许”，都会弹出确认
  - `deny_unless_prior_grant`
  - 还可以用 `overwrite` 改写参数
- 钩子输入中包含 `workspacePaths` 和 `artifactDirectoryPath`，做白名单时可直接用来放行 artifact 目录。
- 官方 SDK 的 [policy.py](https://raw.githubusercontent.com/google-antigravity/antigravity-sdk-python/main/google/antigravity/hooks/policy.py) 在策略异常时采用 *"failing closed"*（出错即拦截），与第 1 项的修改方向一致，可作为官方先例引用。

## 3. 第 2 项（白名单）更紧迫了

v2.35.0 新增：**Auto 权限模式会自动批准读取项目外的文件**。

用户若开启 Auto，一旦我们的黑名单漏掉某个工具，连“弹窗确认”这道最后防线也没有了。

## 4. MCP 读/写标注，Antigravity 多半不认

来源：[SDK issue #62](https://github.com/google-antigravity/antigravity-sdk-python/issues/62)（未关闭）

- 钩子拿到的 MCP 工具调用只有 `name` 和 `args`，没有 `readOnlyHint` / `destructiveHint` 等标注，不能指望客户端按标注分级确认。
- 更实在的做法：在我们自己的钩子里，对 `ssh_run_command`、`ssh_write_file`、`ssh_job_kill` 返回 `ask`。标注照样可以加，仅作为文档。
- 该 issue 中提到的安全工具名为 `list_directory`，不一定是猜测的 `list_dir`。这也说明白名单比黑名单可靠：不需要去猜工具名。

## 5. 官方其他相关改动

- **v2.35.0 新增对话管理 API**：可新建、列出、重命名、归档、打标签、删除对话。
  - 验收时清理测试会话可直接调用，无需操作界面。
  - “升级哨兵”可减少对 DOM 选择器的依赖。
- **v2.35.1 重启后自动恢复进行中的对话**：降低了“装完新版必须重启客户端”的风险，但需验证重启就绪 ACK 是否与自动恢复冲突。
- **v2.35.0 本地历史默认不再删除**（以前超过 500 条会删除）：旧 `.db` 被清理导致统计掉数的情况会减少，但统计防回退仍需要做。

## 6. 三个上游项目现状

### agy-fast

- 最新正式版仍为 [v0.3.2](https://github.com/INK-Q/agy-fast/releases)。
- `mcp-config --host antigravity` 可直接生成 Antigravity 配置。
- `--tools` 可减少暴露的工具、节省 token，升级时可顺手使用。

### agy-powertools

- [Releases 页](https://github.com/WhiteBr1ck/agy-powertools/releases)顶部显示 v2.16.7，比已看到的 v2.16.9 更旧，应为页面缓存，未发现更新版本。
- v2.16.5 的说明给出了第 4、5 项（用量统计、补翻词条）的具体做法：
  - 检查点拦截“归零或回退”的扫描结果。
  - 看板按 Gemini、Claude、Argon 各自的周重置时间分开计算（拆分 argon 池后需核对）。
  - 请求归档保留 90 天，最多 20,000 条。
  - 需补翻的 5 个词条：
    - `Search shortcuts...`
    - `Settings for conversations outside of projects`
    - `Hide breakdown`
    - `Notification settings`
    - `Automatic check for updates`

### obsidian-prism

- 仍为 [v1.0.8-beta.3](https://github.com/RMvdesi/obsidian-prism/releases)，号称完整兼容 Antigravity 2.35.2。

## 7. 社区痛点（Reddit 与官方论坛）

- **原生远程 SSH 不稳定**：大约 30 分钟断开、language server 起不来（[Reddit](https://www.reddit.com/r/google_antigravity/comments/1peoo36/is_remote_development_broken/)）。如果我们的 SSH 项目更稳，这就是差异化卖点。
- **IDE 与 App 共用同一账号**：升级后切换一边另一边也跟着变（[Reddit 10-29](https://www.reddit.com/r/google_antigravity/comments/1xigxse/antigravity_ide_is_now_using_the_same_account_i/)）。我们的多账号切换值得在这种场景下测一次。
- **周额度消耗过快、排队消息消失、Diff 出现重复行**（[官方论坛 11-12](https://discuss.ai.google.dev/t/critical-issues-with-the-latest-antigravity-ide-update-quota-bug-unresponsive-ui-missing-diff-broken-agent-connection/197377/7)）。统计准确性正是大家在意的点，用量统计这一项价值更高了。

## 调整后的顺序

| 顺序 | 做什么 | 变化 |
|---|---|---|
| **0（新增）** | **对比原生 SSH 与我们的 SSH 项目**：在 2.35.2 上确认两套入口是否冲突，再定路线：继续做“更稳、能管住 AI 的围栏版”，还是退一步让给原生 | 新增，决定第 1、2、6、7 项是否值得做 |
| 1 | 钩子出错即拦截（fail-closed） | 不变，已有官方 fail-closed 先例 |
| 2 | 改为白名单：matcher `"*"` + 放行列表 | 更紧迫，Auto 模式会自动批准读取项目外文件 |
| 3 | agy-fast 升级到 0.3.2，顺手使用 `mcp-config --host antigravity` | 不变 |
| 4 | 用量统计（按 powertools v2.16.5 的三点做法） | 提前，社区最在意 |
| 5 | 补翻 5 个词条，限定侧栏菜单作用域 | 提前，词条名单已齐 |
| 6 | 钩子对危险 SSH 工具返回 `ask` | 替代原来的“标注 MCP 读/写” |
| 7 | 真实 sshd 端到端测试 + 远端早期启动容错 | 等第 0 步结论 |
| 8 | macOS 钥匙串存储大凭据 | 不变 |
| 9 | 升级哨兵，能用对话管理 API 的地方改用 API | 新增 API 方向 |

## 仍未查到 / 注意事项

- **仍未查到**：
  - 我们自己仓库的 issue 和 PR（`gh` 尚未登录）。
  - Antigravity 原生只读工具的完整名单；官方文档中只能确认 `run_command`、`view_file`。
- **检索过程问题**：前几轮约一半请求的参数被截断，后改为每次只抓取一个页面才拿到结果。powertools 的版本号可能仍是缓存数据。

## 进度（分支 `feat/upstream-hardening`）

| 项 | 状态 | 提交 | 说明 |
|---|---|---|---|
| 0 对比原生 SSH | 待做 | — | 需在真实 2.35.2 客户端上手动验证 |
| 1 钩子出错即拦截 | 完成 | `0437633` | SSH 项目内出错 deny，普通项目不受影响；loader 加载失败改为 `ask` |
| 2 白名单 | 完成 | `0437633` | 带路径参数的工具一律查路径；未知且无路径的工具返回 `ask` |
| 3 agy-fast 0.3.2 | 完成 | `b08b005` | 11 个文件按 tag 原样替换，MCP 冒烟通过 |
| 4 用量统计 | 部分完成 | `d0d5972` | 已做：扫描不归零、不回退；分池周重置原本已支持；90 天 / 2 万条归档未做（与“删 .db 即剔除”的现有约定冲突）；peakTps 虚高不适用：我们按整次请求计时（已有测试），上游 v2.16.9 修的是只算流式窗口的问题 |
| 5 补翻 5 个词条 | 完成 | `f2b1b76` | 仅加了词条；“限定侧栏菜单作用域”未做、未验证（现有排除规则只作用于插件市场翻译） |
| 6 危险 SSH 工具 `ask` | 暂缓 | — | 与 ADR-0002“远端命令遵循原生权限”冲突，需决策 |
| 7 真 sshd 端到端 | 待做 | — | 等第 0 步结论 |
| 8 钥匙串存大凭据 | 完成 | `56a1f3c` | 复现：hex 后约 2 KB 即被 security -i 4096 字节行缓冲截断；改为三档写入（hex / 纯文本 / JXA），JXA 部分原样取自 powertools v2.16.10；临时钥匙串实测 1.2 KB、3 KB 读写一致，JXA 仅编译校验未写入登录钥匙串 |
| 9 升级哨兵改用 API | 待做 | — | 对话管理 API 细节尚未从官方文档确认 |
