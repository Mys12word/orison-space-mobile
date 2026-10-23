# 0.3.0-mobile.24

本版把 .20～.23 与本次修复合并为一个版本（.20/.21/.22/.23 未单独发布）：

- **修复「保存版本」保存不完整**：快照时遇到磁盘上已删除的文件会抛 `NotFoundError` 并中断整次提交，界面只剩「N 个未提交的更改」清不掉。现在删除的文件改走 `git remove`，单个文件失败不再中断快照，提交后还会再检查并补一轮（保存时仍在写入也不会漏）。
- Agent「只说不做」续推（.20）：模型只回一句旁白、没调工具时自动催它执行，最多 2 次。
- `No output generated` 空输出容错（.21）：上游只回思考/断流时不再整轮报错，交回主循环续推；真正的错误会带上 HTTP 状态与底层原因。
- 正文流式显示（.23）：模型边写边渲染到 Agent 面板，另加 150 秒静默看门狗，不再无限转圈。

# 0.3.0-mobile.23

- 正文改成「边写边显示」。之前一次回复要整段生成完才落到界面上，写一章 2000-3000 字就是几分钟只有三个小点在转，看起来像卡死。现在模型每吐一段就实时画到 Agent 面板里（最终消息仍以完整版本落盘）。
- 新增「静默看门狗」：流式请求 150 秒没有任何新内容就主动断开，并给出中文原因（已输出多少字 / 一点没输出），不再无限转圈。

# 0.3.0-mobile.21

- 修复「No output generated. Check the stream for errors.」：中转偶尔只回「思考」不给正文时，AI SDK 会抛这个错，整轮直接失败。现在两种情况分开处理——流本身没报错就当作空响应交回主循环续推（最多 2 次）；真的报错则把底层原因（错误类型、内层 cause、HTTP 状态）拼进提示，不再只剩一句英文。
- 空响应走到尽头的提示改成能看懂的话：说明可能是中转断流或模型只输出思考，建议重试或换模型。

# 0.3.0-mobile.20

- 修复 Agent「只说不做」导致的半途而停：模型有时只回一句旁白（"I will check the worldbuilding doc first" / "我先看一下世界观设定"）就结束回合，一个工具都没调用，界面看起来像「思考到一半自己停了」。主循环现在能识别这种「计划式回复」，也会识别上游声称调用了工具但调用丢失的情况，并再推模型一次去真正执行工具（最多 2 次）；仍然只说不做时才会停止，并留下一条明确说明，不再无声中断。
- 运行时提示消息不再伪装成「你说的话」：聊天区和「对话总览」都会隐藏它们，模型侧看到的仍是纯文本提示。
- Agent 系统提示新增「Act, don't narrate」：需要读文件/写章节时必须在同一轮内直接调用工具，不能用描述意图代替调用。

# 更新日志 · Changelog

本项目所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
# 0.3.0-mobile.19

本版把三处修复合并为一个版本（0.17 / 0.18 未单独发布）：

- 写作页新增「章节条」：编辑器上方的横向章节胶囊，点一下切换章节并高亮当前章，不用再去文件抽屉里翻。
- 修复 Agent 报 `Directory not found: "."`：部分模型会把工具参数再 JSON 编码一层（`dirPath` 变成带引号的 `"."`），现在解析后会脱一层壳，正文类字段（content/text/markdown）保持原样。
- 修复 Agent「思考一半自己停」：上游偶发返回空响应（流被截断）时，旧逻辑直接把这一轮当成结束；现在会自动提示模型继续（最多 2 次），仍为空则给出一条明确的停止提示，不再毫无解释地断掉。
# 0.3.0-mobile.16

- Agent 的系统提示新增「Saving chapters」：写/续写章节必须调用 chapter_write 把正文落盘到 chapters/<id>.md，先 chapter_list 复用已有 id；只给走向/大纲时要在回复里说明「尚未保存」。

# 0.3.0-mobile.15

- 写作页在项目还没有章节时不再静默退回大纲：新增起始页与「新建第一章」按钮，点了会创建 chapters/ch-001.md、自动登记章节并打开编辑器；openWriting 的兜底也改为进入该页面。

# 0.3.0-mobile.14

- 模型请求改为流式（streamText）：非流式请求会一直静默到整段生成完，长上下文很容易触发 Cloudflare 的 100 秒源站超时（HTTP 524）。流式边生成边回传可绕开；中转不支持 stream（400）时自动回退为非流式。
# 0.3.0-mobile.13

- Agent 报错现在能看到真实原因。此前只显示「Failed after 3 attempts. Last error:」，因为 AI SDK 的重试封装把底层错误吞掉了；现在会在消息里带上 HTTP 状态码、网络错误码（ECONNRESET / ENOTFOUND / TLS 证书类）、对端响应体前 200 字，并按类型给出提示（例如代理/VPN 相关）。

# 0.3.0-mobile.12

- Agent 面板新增「对话总览」：右上角目录按钮打开你发送过的消息列表（按顺序编号、两行摘要），点任意一条平滑滚动到对应消息。
- Agent 面板新增「跳到最新」悬浮按钮：向上翻阅历史时会出现在右下角，一键回到底部并跟随新消息。
- 这两项在手机全屏 Agent 和桌面侧栏都可用。

# 0.3.0-mobile.11

- 修复「保存版本」报 `Could not find git root for /`：新建项目只建目录、不会初始化 git 仓库，
  而快照直接去 findRoot。现在 `git:create-node` 会先确保仓库存在（缺 `.git` 就 `git.init`），
  首次快照本身就成为时间线的起点，概览里的「无版本历史」提示也随之消失。
  （消息里的 `/` 是 isomorphic-git 向上走到根的路径，不是项目路径，容易误判。）
- 修复界面显示原始 i18n key 的问题：补上 topbar.saveFailed、findReplace.toggleReplace 等缺失文案，
  并把封面保存失败的 key 从 creative.* 改到实际存在的 overview.*。
- 模型刷新提示现在正确显示「已刷新 N 个模型」。
- Agent 输入框：手机端 Enter 改为换行、Ctrl/Cmd+Enter 发送（软键盘没有 Shift+Enter）；
  新增「撤回上一条」按钮，会删掉最后一轮并把它回填到输入框。
- 修复 Agent 报「Cannot read properties of undefined (reading 'createAgentSession')」：
  shared/api/* 在模块加载期捕获 window.orisonDesktop，而手机版原先把 installBridge() 放在
  main.tsx 函数体，早于它执行的是静态 import 的依赖图；新增 bridgeBoot.ts 作为第一个 import。
- 修复「删除项目」失败：项目在共享存储、应用回收站在内部存储，跨文件系统 rename 会 EXDEV；
  现在优先移到项目同卷的隐藏回收站 `.orison-trash`，失败再回退到复制+删除。

# 0.3.0-mobile.10

- 补上模型配置缺失的三条中英文文案（modelsRefreshed / missingUrlOrKey / noModelsWarning），
  刷新模型后不再显示原始的 `settings.modelsRefreshed` key。

# 0.3.0-mobile.9

- 修复「获取模型不完全」：模型列表现在会跟随 Anthropic 的 has_more/last_id 分页（默认每页 20 条），
  首次请求直接要 limit=1000；同时兼容 {data:[]} / {models:[]} / 裸数组等返回结构并去重。

# 0.3.0-mobile.8

- 模型配置：点「模型库」的 + 新建配置时给出 Toast 提示（表单本来就在「添加模型」状态时，
  再点一次会重置表单，此前看起来像按钮没反应）。
- 说明：模型列表来自远端接口——填好 Base URL / API Key 后点「刷新」，选好模型再保存。

# 0.3.0-mobile.7

- Agent 全屏面板增加顶部「收起」并修正层级：手机端的抽屉/Agent 面板改用 Portal 渲染到 body，
  不再被顶栏的层叠上下文压住，打开后可以直接返回工作台。
- 外观设置增加实时预览块；「编辑器行高」终于接入 CSS（此前变量设置了但从没被消费）。
- Agent 消息正文跟随阅读字体/行高设置。
- 已知问题：字体选择、字重、字号对编辑器正文仍不生效（预览块会变），下个版本处理。
- 预编译 APK 不随仓库提交（体积约 38MB，超过网页上传限制），请发 Release 附件。

# 0.3.0-mobile.6

- 修复 APK 内「新建/打开项目」文件夹选择器报「目录不在手机版允许访问的范围内」：
  目录白名单现在显式包含主机传入的作品根目录，不再依赖环境变量重算。
- 本地服务启动改为自动选择空闲端口，避免与开发模式主机冲突。
- 已在真机验证：选择器可进入作品目录、项目页与工作台正常、顶栏菜单完整展开。

# 0.3.0-mobile.4

- 修复手机版顶栏「文件 / 编辑 / 视图 / 帮助」下拉菜单被裁切、无法完整展开的问题
  （顶部菜单栏不再建立 overflow 滚动容器，下拉面板改为相对顶栏定位并限制最大高度）。
- 首次启动提示「正在解包内置运行时」；错误页文本可选中复制；版本号与 APK 一致。


This project's notable changes are documented here, following [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Agent Skill 改为 OpenCode 风格按需加载：`skill` tool 只加载 `SKILL.md` 内容和资源清单，不再将任意 `SKILL.md` 编译执行为 workflow DAG；后端开始强制执行 session mode 与 skill `allowed-tools` 权限。

## [0.3.0]

### 新增 · Added
- 总览/大纲页重构：Hero 封面区、快捷行动条、阶段进度、活动流
- Agent 渐次披露：工具元数据映射、参数摘要、工作步骤分组折叠、child 事件嵌套渲染
- 时间线初始化入口：`git:init` IPC + 空状态引导卡
- 资产作为 Agent 引用（attach 菜单）
- 设置「关于」页（项目主页/开发者/反馈/QQ群 + 免费开源声明）
- Motion token 系统、a11y 增强、主题微调
- 架构边界 CI 闸门（dependency-cruiser 升级为可执行规则）

### 变更 · Changed
- 移除 Auto Mode / Orchestration 空壳（降级为实验功能，待后续重建）
- 合并三份 `atomicWriteFileSync` 到 `@orison/shared-contracts`
- 拆分 `projectIpc.ts` 为 projectIpc + projectFileIpc + projectMetaIpc
- 删除 `features/creative/`、`EditorArea`、`InspectorPanel` 等死代码

### 修复 · Fixed
- Agent Panel 一轮影响体验的会话 UX 问题
- skill `_reference` 读取失败与会话内模型切换
- 封面保存失败不再静默 — 弹错误 toast 并回滚内存指针
- 换封面时先删旧 `cover.*`，保证只存在一个封面文件
- 总览/大纲同步 bug（projectSubscription 按 path 判断切项目）
- 标签栏滚轮横滚、字体离线渲染、保存反馈
- `chapter_write` / `memory_update` 补发 `file:changed`，编辑器自动刷新
- 损坏 `project.yaml` / memory / tag 读取自愈，不再卡死保存
- 切项目串台、外部文件同步、资产库导入等编辑器体验问题
- IDE 体验第二轮修复 — 数据安全 / Minimap / 编辑器 / Agent / 稳定性

## [0.2.0]

### 新增 · Added
- 跨平台构建与发布：Windows / macOS（Intel x64 + Apple Silicon arm64）/ Linux
- 应用内更新流程（config IPC + release pipeline）
- 基于 isomorphic-git 的「时间线」版本管理：提交节点、分支、diff
- 项目文件树导入与文件监听（watcher）
- Agent 编排：Skill / Workflow / 子代理嵌套调用，`ToolResult.terminal` 标记避免 skill 重复收尾
- 设置项：内置中文字体预设 + 字体导入实时预览
- 会话级模型选择，禁用的模型不再被调用

### 变更 · Changed
- 生成链路统一收敛到桌面主进程模型网关，`apiKey` 不再进入 agent
- 项目配置初始化统一收敛到 `project.yaml`
- skill 加载统一到 `loadSkillFromDir`

### 修复 · Fixed
- 编辑器 Ctrl+Z 撤销失效与撤销后光标位置
- 自愈创建 `project.yaml` 并保留概览元信息
- 新增 `closeDb()`，测试清理前释放 SQLite 句柄

[Unreleased]: https://github.com/LumenStorm/OrisonSpace/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/LumenStorm/OrisonSpace/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LumenStorm/OrisonSpace/releases/tag/v0.2.0
