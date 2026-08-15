# WeBot

> 部署说明：[本地部署与 Linux 服务器部署](docs/DEPLOYMENT.md)

不安装 OpenClaw，直接连接腾讯微信 iLink 通道的独立 TypeScript
Adapter。目前的 MVP 支持：

- 微信二维码登录与验证码流程
- 本地私密保存登录凭证（文件权限 `0600`）
- `getupdates` 长轮询及游标持久化
- 文本、引用消息与语音消息解析
- 微信 SILK 语音下载、解密、WAV 转码和可配置语音识别
- 使用当前消息的 `context_token` 回复文本
- 自动聚合同一用户短时间内连续发送的多条消息
- 微信聊天模式可把一次回复连续发送为多个独立气泡
- Agent 可理解微信图片、生成并发送新图片，也可逐字转发用户消息中已有的公开 HTTPS 图片直链
- 模型处理期间显示并续期微信“正在输入”状态
- 用户自定义 Agent 名称和身份
- 每个用户独立选择当前 Agent
- 每个「用户 × Agent」单独持久化记忆
- Character Card V2/V3 JSON 导入与 V3 导出
- 性格、场景、开场白、示例对话、系统提示词和角色世界书
- 完整归档、短期对话、滚动摘要、结构化事实与关键经历
- 按当前话题筛选长期记忆，避免无关旧事把聊天带偏
- 运行时创建、切换、修改和删除 Agent
- OpenAI Responses API、DeepSeek 和自定义 OpenAI-compatible API
- OpenAI Responses / DeepSeek 原生 Tool Call 与受限只读工具注册表
- 聊天中按需查询实时天气，以及按 Agent 配置每日天气消息
- 每个 Agent 独立选择 Provider 和模型
- 有来源、优先级和输入预算的 Prompt Plan，超限时确定性裁剪
- 私密保存最近模型调用的 Prompt Trace、耗时、用量和失败信息
- 本机可视化后台管理 Agent、记忆和 API Key
- 中断、重试、会话失效处理
- 模型无关的 `AgentFramework` 和可替换执行器

> 当前支持私聊文字、多气泡回复、读取引用内容、语音输入、图片理解与输出和“正在输入”状态。
> 视频、普通文件、语音输出和多账号将在后续阶段加入。

## 要求

- Node.js 22 或更高版本
- 可访问 `https://ilinkai.weixin.qq.com`
- 微信账号具备 ClawBot / iLink 授权入口

## 快速开始

没有部署经验时，直接运行交互式安装器：

```bash
bash deploy/setup.sh
```

Windows 10/11 请在 PowerShell 中运行：

```powershell
powershell -NoProfile -File .\deploy\setup-windows.ps1
```

安装器会用中文菜单引导完成配置、扫码和启动；macOS/Linux 入口还支持 Linux
服务器常驻部署和可选的 Codex 图片
能力。安装器不会把 API Key 显示在屏幕上，也不会覆盖已有聊天记忆。完整说明见
[部署指南](docs/DEPLOYMENT.md)。

熟悉 Node.js 时也可以手动执行：

```bash
npm install
npm run login
npm run start
```

`login` 会在终端显示二维码。扫码并在手机微信上确认后，凭证默认保存到
`~/.webot/credential.json`。没有配置模型密钥时，`start` 会使用多 Agent
回声 Provider：

```text
你：你好
Bot：[默认助手] 收到：你好
```

首次启动时，`start` 会输出一条仅用于初始化的管理链接。在同一台电脑的浏览器
中打开并设置管理密码；以后直接访问 `/admin` 输入密码即可，不再需要复制令牌。
登录状态保存在 HttpOnly Cookie 中，管理密码只以加盐哈希形式保存。后台只监听
`127.0.0.1`，不会直接暴露到局域网或公网。

停止服务时按 `Ctrl+C`。

## 可视化管理后台

只启动后台、不连接微信：

```bash
npm run admin
```

后台支持：

- 可随内容自然向下滚动的两栏人物工作台，顶部导航保持可见，完整设定和 AI 助手通过人物设定弹窗按需打开
- 按微信用户查看、新建、切换和删除 Agent
- 通过弹窗阅读并修改每个 Agent 当前已保存的身份、性格、场景和表达规则
- 新建 Agent 时指定独立身份、Provider 和模型
- 使用该 Agent 的已配置模型生成人设修改草稿，逐项查看修改前后内容并一键应用保存
- 为每个 Agent 单独设置只在情景模式生效的“导演事件”，让人物无条件接受既定事件前提，并用 AI 补全事件与世界设定
- 使用每个 Agent 独立的私有“故事书”保存多篇作品，并让 AI 把剧情构想写成完整正文、续写或局部改写
- 直接阅读当前工作记忆中的逐条对话
- 在完整聊天窗口中按关键词搜索、浏览和导出原始记录
- 查看 LLM 摘要、长期事实、完整事件记忆档案和压缩次数，并可从原始聊天重建旧事件
- 查看每个 Agent 自动生成的自主经历、心境、重要度和主动联系状态，并可单独开关或立即生成
- 为每个 Agent 设置每日天气的地点、时间与时区，预览消息或手动测试发送
- 为每个 Agent 设置关闭发图、仅响应明确请求或自然分享图片，并配置主动联系配图和稳定视觉身份
- 按 Agent 查看模型实际收到的 Prompt、各区块来源及裁剪原因
- 导入、通过 AI 修改和导出 Character Card V2/V3 角色卡
- 查看世界书条目数量
- 保存或清除 OpenAI、DeepSeek 和自定义 Provider 的 API Key
- 查看当前可用 Provider 和本机安全边界

API Key 保存到 `~/.webot/api-keys.json`，文件权限为 `0600`。已有密钥只
显示“已配置”，服务端不会把明文返回给浏览器。环境变量中的密钥优先级更高，
且不能通过后台清除。

人物编辑器顶部的“查看完整设定与 AI 修改”入口会打开独立弹窗：左侧展示当前
已保存的完整人物设定，右侧内嵌人物设定助手。助手在你确认前不会修改 Agent、
世界书或记忆，也不会把 API Key 返回给浏览器。它会以当前已保存的人物设定为
基础，把修改结果作为预览返回，并完整展示每个字段的修改前后内容。点击“应用并
保存”会直接把确认过的草稿写入当前 Agent。主页不再重复展示整套人物字段，只
保留每日天气、自主生活、记忆调试、导出和 Agent 操作。
为尽量忠实保留用户原词和表达强度，每次修改都会经过单独一轮忠实度复核；发现
弱化、擅加条件或越界改动时会自动纠错一次并再次复核，仍不合格则拒绝返回草稿。

人物编辑器中的“导演事件”入口用于临时指定当前剧情。启用后，事件前提被视为
已经成立：人物性格仍会影响情绪、说话方式和人物自己的行动，但不能再以性格为
理由拒绝、犹豫、回避或拖延进入事件。最近真实对话代表事件已经推进到的位置，
系统不会在每轮回复中重播事件开场；同时仍严格保留用户自主权，不会替用户编写
对白、行动、心理或选择。事件标题、前提和世界场景可以手动填写，也可以交给同一
Agent 的模型生成忠实草稿，只有应用并保存后才会生效。关闭事件只停止注入，内容
仍会保留以便再次启用；清空全部字段则会删除事件。导演事件属于本机运行状态，
不会随 Character Card 导出。

“故事书”与导演事件是两套独立能力：导演事件保存的是实时角色扮演要遵循的剧情
大纲和既定前提；故事书保存的是可直接阅读的完整作品正文，不会注入聊天 Prompt，
也不会改变人物记忆。每个人物可以保存多篇故事，包含标题、用户剧情构想与完整
正文。AI 写作先返回预览，应用到编辑器后还需要明确保存；作品只写入本机私有状态
目录，不随 Character Card 导出，也不应提交到代码仓库。生成或修改正文时，故事
助手会读取当前人物设定，以及该 Agent 独立的长期摘要、事实、关键经历和最近聊天，
用它们保持性格、关系与事件连续；这些上下文不会跨 Agent 混用。

管理入口首次由 `~/.webot/admin-token` 完成初始化，设置密码后带令牌链接会立即
停用，后续使用普通密码页面登录。密码哈希保存在权限为 `0600` 的
`~/.webot/admin-password.json`；后台不会保存或返回密码明文。页面右上角可主动
退出并清除登录 Cookie。可选配置：

```dotenv
WEBOT_ADMIN_ENABLED=true
WEBOT_ADMIN_PORT=3210
WEBOT_PROMPT_BUDGET_TOKENS=24000
WEBOT_PROMPT_TRACE_RETENTION=20
WEBOT_MESSAGE_DEBOUNCE_MS=1500
WEBOT_MESSAGE_MAX_WAIT_MS=5000
WEBOT_BUBBLE_BASE_DELAY_MS=800
WEBOT_BUBBLE_MS_PER_CHARACTER=120
WEBOT_BUBBLE_MIN_DELAY_MS=1000
WEBOT_BUBBLE_MAX_DELAY_MS=7000
WEBOT_CONTEXT_TOKEN_MAX_AGE_HOURS=24
WEBOT_WEATHER_CATCH_UP_MINUTES=180
WEBOT_REMINDER_CATCH_UP_HOURS=24
```

设置 `WEBOT_ADMIN_ENABLED=false` 可以在正常启动时关闭后台。
Prompt Trace 默认每个 Agent 保留最近 20 次，只在点击“查看 Prompt”时按需
载入；它与聊天记忆同属私密数据，清空 Agent 记忆时也会一并删除。

## 在微信中管理 Agent

忘记指令时直接发送：

```text
/help
```

也可以发送 `/help agent`、`/help memory`、`/help story`、`/help life`、
`/help reminder` 或 `/help model` 查看分类帮助。

首次收到消息时会自动为该微信用户创建“默认助手”。创建自定义身份：

```text
/agent create 论文助手 你是严谨的学术论文编辑，优先检查论证和引用
```

创建后会自动切换到新 Agent。常用命令：

```text
/agent list
/agent show
/agent use 默认助手
/agent update 你是擅长中文科技论文的资深编辑
/agent rename 学术助手
/agent model openai
/agent model deepseek deepseek-v4-pro
/agent model default
/agent mode wechat
/agent mode roleplay
/agent delete 学术助手
/agent help
```

Agent 名称不能包含空格，身份描述可以包含空格。不能删除当前 Agent，需先
切换到另一个 Agent。

故事书可以直接在微信聊天中阅读：

```text
/story
/story send 1
```

`/story` 会列出当前 Agent 私有故事书中的作品；`/story send <序号>` 会把
对应作品的完整原文发送到聊天框。长篇正文会按段落拆成多条消息，且不会经过
人物模型改写，也不会被写入人物聊天记忆。作品的创建、AI 完善、编辑和删除仍在
管理后台完成。

每个 Agent 可以独立选择聊天表现。`wechat` 模式只输出像真人在线打字的
聊天文字，不写动作、神态、心理或环境旁白；`roleplay` 模式保留沉浸式的
场景和动作描写。也可以在管理后台的 Agent 编辑页直接切换，切换不会清空
角色设定或独立记忆。旧角色卡保持沉浸扮演模式，新建 Agent 默认使用微信
聊天模式。每轮对话会记录生成时使用的表现模式；切换后，其他模式下发生的
内容仍作为共同经历保留，但不会再作为当前文风的示例，因此新模式会从下一条
回复立即生效，而不是经过几轮逐渐过渡。

微信聊天模式下，Agent 可以像真人连续打字一样发送多个独立气泡，气泡数量
不设固定上限；模型本轮生成的有效气泡会全部按顺序发送。第一条生成后立即
发送，后续气泡会按即将发送的字数等待：默认基础 800 毫秒，每个可见字符再
增加 120 毫秒，单次等待限制在 1–7 秒；等待时保持“正在输入”。简单回答仍
只发一条，回复总长度仍受所选模型的单次输出长度限制。每个气泡都会作为一条独立
的 Agent 消息写入完整聊天和工作记忆，因此后台查看、后续回忆和记忆压缩都
与手机上实际看到的顺序一致。沉浸情景模式不会拆分回复。可通过
`WEBOT_BUBBLE_BASE_DELAY_MS`、`WEBOT_BUBBLE_MS_PER_CHARACTER`、
`WEBOT_BUBBLE_MIN_DELAY_MS`、`WEBOT_BUBBLE_MAX_DELAY_MS` 调整节奏。旧的
`WEBOT_BUBBLE_DELAY_MS` 仍可作为基础等待时间使用。

Agent 现在可以转发已有图片。把一条直接返回 PNG、JPG、GIF 或 WebP 的
公开 HTTPS 图片直链发给它，并明确要求“把这张图发给我”即可。Agent 只能
逐字使用当前或近期用户消息里已经出现的链接；模型自行编造链接或修改路径、
查询参数时不会发起请求。图片最大 20 MB；普通网页、本地文件、内网地址、
`data:` URL、伪装成图片的 HTML/SVG 都会被拒绝。每一跳重定向都会重新
检查，下载和上传都有超时与大小限制。
配置 `cliproxy` 后，Agent 还可以理解微信里直接发送的图片。处于“仅明确请求”
模式时，只有用户本轮明确提出“生成图片”“画一张”等要求才会调用文生图模型；
处于“自然发送”模式时，人物也可在当前对话确有视觉分享价值时自行判断是否
发图。图片内容、旧记忆或引用消息本身不能伪造用户的明确授权。发送
`/help image` 可查看手机端说明。

管理后台的“图片行为”按 Agent 独立保存三种策略：

- **关闭**：不生成新图片，但仍可理解用户发来的图片；
- **仅明确请求**：只有用户本轮明确要求画图时才生成；
- **自然发送**：除明确请求外，人物也可在分享当下所见、正在进行的活动，或
  图片明显比文字更适合表达时自然生成一张图。普通问答、填补沉默、转移话题
  或为了结束对话不会成为发图理由。

图片生成不设时间间隔，也不设每日图片上限。用户本轮拒绝、取消或说不想看图时，
服务端会强制阻止调用。同一“用户 × Agent”的图片生成仍会串行处理，避免并发
重复发送。

每个 Agent 还可以保存独立的视觉身份要求。只有画面确实包含当前 Agent 本人时，
这段可信配置才会交给图片模型；纯风景、物件或其他人物图片不会携带人物私设。
生成后的二进制图片不会进入记忆或 Prompt Trace，记忆只保留一条有界的文字描述。
启用“主动联系时配图”后，自主生活只有在本来就满足主动联系条件时才可能附图；
它仍受免打扰时段、新鲜 iLink 会话凭证和主动联系频率约束，这些是联系策略，
不是每日图片配额。

同一用户连续发送普通消息时，WeBot 会等到最后一条之后安静 1.5 秒，再按原
顺序合并为一次输入交给 Agent；每条新消息都会重新计时，连续输入最长等待
5 秒。这样把一句话拆成多个微信气泡时，Agent 不会抢答半句话，也只调用一次
模型。以 `/` 开头的 WeBot 指令不会参与合并，也没有这段人为等待。可通过
`WEBOT_MESSAGE_DEBOUNCE_MS` 和 `WEBOT_MESSAGE_MAX_WAIT_MS` 调整。

记忆命令：

```text
/memory show
/memory show 20
/memory history 1
/memory turn 42 1
/memory summary 1
/memory facts 1
/memory episodes 1
/memory status
/memory clear
```

`/memory show` 会展示当前 Agent 的四层记忆总览。`/memory history 1`
从私有 JSONL 归档读取完整聊天，第 1 页是最新一页、页内仍按实际聊天顺序
显示；继续发送 `/memory history 2`、`3` 可以向前翻阅。多气泡回复按一整轮
显示，不会拆到两页。特别长的单轮会在列表中明确标记缩略，并给出
`/memory turn <轮号> 1`，可继续分页阅读该轮的完整原文。长期摘要、当前事实
和关键经历分别使用 `summary`、`facts`、`episodes` 分页完整查看。旧的
`/memory show 20` 仍可查看工作窗口中的最近消息，但不代表完整归档。

普通消息和 Agent 回复会写入当前 Agent 的记忆。切换 Agent 后只加载目标
Agent 自己的历史；切换回来时会恢复原记忆。不同微信用户的档案、活动选择
和记忆也互相隔离。

记忆分为四层：

- 完整聊天：每条用户消息和每个 Agent 回复气泡永久追加到私有 JSONL 归档；
- 工作窗口：默认达到 40 条消息时触发压缩，压缩后保留最近 20 条原文；
- 长期摘要与事实：当前 Agent 使用的 LLM 重新判断哪些事实值得保存，并可
  合并、修正或删除旧信息；
- 关键经历：LLM 保存影响关系连续性、承诺、边界、共同目标和未解决情节的
  重要事件；新一轮只增量新增或修正事件，不再整体覆盖旧事件。

生成回复时，微信聊天模式会把最近六轮对话作为真实的用户/
Agent 消息传给模型，便于理解“这个”“刚才”之类指代。长期摘要、
事实和共同经历会按当前输入与最近用户话题在本地筛选；默认最多带入
5 条事实和 2 条经历。Agent 自己曾经引入、但用户没有接续的话题不会反过来
影响筛选；姓名、关系、边界和安全词等必须一致的信息会少量保留。

每次成功压缩都会把当时的摘要、事实和关键经历另外保存为不可变版本。管理
控制台中的“当前生效摘要”仍表示下一轮会使用的最新版本；点击“查看全部摘要
版本”可以按时间查看、搜索此前每一次整理结果。升级前的版本过去没有单独
落盘，因此只能迁移升级时仍保存的最后一版；完整原始聊天不会受此影响。
“查看全部事件记忆”会把各次整理中的关键事件去重后平铺展示。旧版本已经覆盖
掉的事件无法恢复原来的精确措辞，但可在该窗口启动后台重建：系统会把完整
JSONL 聊天分批交给当前 Agent 的模型重新提炼，并把结果标为“聊天重建”。

压缩在后台进行，不阻塞当前回复。失败时待压缩消息继续留在工作窗口，完整
聊天归档不会丢失，并会在后续聊天时重试。阈值可通过
`WEBOT_MEMORY_COMPRESSION_THRESHOLD` 和 `WEBOT_MEMORY_RETAIN_MESSAGES`
调整。清空记忆会同时删除完整聊天、工作窗口、所有长期记忆和对应的
Prompt Trace。

### 自主生活与主动联系

当前 Agent 可以在用户离线后形成不依赖聊天的新经历：

```text
/life on
/life status
/life show
/life now
/life off
```

自主经历按用户和 Agent 分开保存，并在后续聊天时作为该角色自己的记忆
交给模型，所以在沉浸情景和微信聊天模式之间切换时保持一致。生成器明确把
用户视为不在场，不会虚构用户说过或做过的事。默认离线 6 小时后检查，
之后最多每 6 小时检查一次；如果这段时间只有起床、吃饭、收拾等没有产生
具体变化的日常，系统会跳过而不是凑一篇流水账。保存下来的经历会带有事件
类型、可聊性、具体可聊点和可选的未决线索，后续生成可以自然延续已有线索。
只有重要度达到 4/5、确有联系理由、处于非
免打扰时段且当天未超过上限时，才会尝试主动发送。
在免打扰时段生成的待发送消息会保留，并在时段结束后再次判断。

管理后台的人物编辑页会按当前选中的 Agent 展示最近自主经历，包括检查时间、
生成时间、心境、重要度、可聊点、未决线索和联系状态。可以在这里为任意 Agent 单独开启或关闭定时生成，
也可以点击“立即生成”只创建一段新经历；手动生成不会主动给微信发送消息，
关闭功能也不会删除已经形成的经历。

iLink 回复依赖最近会话的 `context_token`，因此主动消息只能尽力发送：接口
接受请求不代表微信客户端一定收到，令牌过期时也可能失败。它不适合作为
可靠通知或报警渠道。默认每天最多尝试一次，22:30–09:00（上海时区）不
发送。相关设置见 `.env.example`；功能默认关闭，由用户对当前 Agent 发送
`/life on` 开启。

### 备忘与定点提醒

当用户在聊天里提到带有完整日期与具体时刻（或“两小时后”这类精确相对
时长）的待办事件时，Agent 可以提出一个待确认提醒。例如：

```text
用户：我明天下午三点要交报告
Agent：要我在 2026年7月29日 15:00 提醒你交报告吗？回复“确认提醒 a1b2c3d4”。
用户：确认提醒 a1b2c3d4
Agent：已设置提醒 a1b2c3d4：2026/07/29周三 15:00｜交报告
```

模型只能提出候选，不能直接创建正式提醒。日期和时刻由本地程序从本轮用户
原话重新解析，事项也必须逐字来自本轮消息；只有用户完整回复
`确认提醒 <短ID>` 后才会生效。候选 30 分钟后过期，避免一句无关的“好”
误建提醒。当前 Agent 的提醒可以这样管理：

```text
/reminder list
/reminder add 2026-07-30 15:00 交报告
/reminder confirm <短ID>
/reminder cancel <短ID>
/reminder help
```

提醒按用户和创建它的 Agent 隔离。即使之后切换到其他 Agent，到点仍由原
Agent 使用自己的固定人物语气发送，并把实际发出的消息写入该 Agent 的记忆。
当前版本只支持上海时区的单次提醒，不支持周期提醒。

定时提醒与其他 iLink 主动消息一样依赖近期 `context_token`。没有新鲜凭证时
会等待用户再次发消息；默认最多补发 24 小时。一次提交后不会因结果不明确而
自动重复发送，因此它适合日常备忘，但不能替代手机系统闹钟、服药报警或其他
安全关键通知。私密状态保存在 `~/.webot/reminders/`，不会写入角色卡或仓库。

### Tool Call 与每日天气

正常聊天会向支持原生工具调用的 Provider 提供只读
`weather_current` 工具。用户询问今天或明天的天气时，模型可以先调用工具，
再根据真实结果回答。DeepSeek 使用 Chat Completions 的 `tool_calls` 回合；
OpenAI 使用 Responses API 的 `function_call` / `function_call_output` 回合。
工具中间消息不会写入人物记忆，记忆只保存用户原话和最终回复。

工具注册表目前开放天气查询和“待确认提醒候选”。天气工具遵循：

- 地点和日期会在本地再次严格校验，模型不能传入 URL、请求头或请求方法；
- 聊天气象地点必须与本轮用户原话中的天气请求直接对应，不能从人物设定、
  记忆、历史消息或模型猜测中取得；
- 网络请求只允许访问 Open-Meteo 的固定 HTTPS 主机，禁止重定向并限制超时
  和响应大小；
- 外部响应只提取数值和天气码，中文描述由本地映射，远端任意文字不会作为
  指令进入模型；
- 每轮最多执行一次工具，结果回合禁止再次递归调用，防止失控循环。

管理后台的“每日天气”卡片可以为每个 Agent 单独设置地点、`HH:mm` 时间和
IANA 时区（例如 `Asia/Shanghai`），也可预览或明确点击“立即测试发送”。
天气事实由本地模板直接使用工具结果生成，不交给人物模型改写。人物模型会根据
当前 Agent 的名称、身份、性格和最近几条由 Agent 自己发送的微信回复，现场生成
一条简短的个性化评论，再由程序追加到权威天气事实之后。模型只会看到白名单化
的天气字段和语气样本，不会收到用户原话、完整记忆、场景 Prompt 或 iLink 凭证；
评论也不能包含天气数值、链接、控制标记、姓名标签或动作旁白。非法输出和模型
故障都会回退到中性安全模板。DeepSeek 的这次轻量生成会关闭思考模式，偶发空
结果时只重试一次；最终评论不会缓存，因此每天和每次预览都可以自然变化。
任务默认关闭，配置保存在 `~/.webot/weather-schedules/` 私密目录，不进入
角色卡和 Git 仓库。定时器使用“任务 + 当地日期”去重，服务重启或重复 tick
不会在同一天重复发送；停机后的补发窗口默认 180 分钟。

每日天气仍受 iLink 限制：只有最近收到过用户消息并持有新鲜
`context_token` 时才会尝试发送，默认把超过 24 小时的 token 视为过期。
没有新鲜 token 时任务会等待用户再次发消息；超过补发窗口则跳过当天，
不会虚构天气或无限重试。后台的“微信接口已接受”也只表示服务端接受请求，
不承诺客户端必达。

## 导入角色扮演角色

在管理后台选择微信用户，然后点击“导入角色卡”。目前接受 Character Card
V2 和 V3 JSON 文件。导入后会创建并自动切换到新的 Agent。

支持字段：

- `name`、`description`、`personality`、`scenario`
- `first_mes`、`alternate_greetings`、`mes_example`
- `system_prompt`、`post_history_instructions`
- `character_book` 角色专属世界书
- `tags`、`creator`、`character_version`、`nickname`

提示词支持 `{{char}}`、`{{user}}`、`<char>`、`<bot>` 和 `<user>` 模板。
世界书会扫描当前输入和最近聊天，按关键词、优先级与 token budget 选择相关
条目。角色卡可以从编辑区域重新导出为 Character Card V3 JSON。

当前支持 JSON 角色卡；将角色数据嵌入 PNG/APNG/CHARX 文件的解析尚未实现。

用户导入或导出的角色卡可能包含完整人物私设，因此 `characters/*.card.json` 默认
不会被 Git 跟踪。示例对话会被解析成真正的 user/assistant 历史轮次，放在角色
定义之后、真实聊天历史之前；历史后指令则位于当前用户消息之后。

## 配置模型 API

WeBot 会自动读取项目根目录下被 Git 忽略的 `.env`：

```bash
cp .env.example .env
```

### OpenAI

在 `.env` 中填写：

```dotenv
WEBOT_DEFAULT_PROVIDER=openai
OPENAI_API_KEY=你的_OpenAI_API_Key
```

默认使用 OpenAI Responses API 和 `gpt-5.6-terra`。也可以在微信中让某个
Agent 覆盖模型：

```text
/agent model openai gpt-5.6-sol
```

ChatGPT 订阅与 OpenAI API Key 是两套独立的认证和计费体系，不能直接把
ChatGPT 登录凭证写入这里。

### DeepSeek

在 `.env` 中填写：

```dotenv
WEBOT_DEFAULT_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的_DeepSeek_API_Key
```

默认模型为当前的 `deepseek-v4-flash`：

```text
/agent model deepseek
/agent model deepseek deepseek-v4-pro
```

### Codex / CLIProxyAPI 视觉理解与图片生成

WeBot 内置了独立的 `cliproxy` Provider，用于让人物模型继续负责聊天与人设，
同时由和 WeBot 位于同一台机器的 CLIProxyAPI 完成图片理解和图片生成。默认路由为：

```text
视觉理解：gpt-5.6-sol
图片生成：gpt-image-2
API Base：http://127.0.0.1:8317/v1
```

在管理后台的 **API Providers** 页面找到“Codex（本机 CLIProxyAPI）”，只需
保存普通 API Key。密钥进入状态目录下权限为 `0600` 的私密存储，不会回显，
也不应写入 Git；CLIProxyAPI 的管理密钥不需要交给 WeBot。

也可以通过未提交的 `.env` 配置：

```dotenv
CLIPROXY_API_KEY=你的_CLIProxyAPI_普通_API_Key
WEBOT_VISION_PROVIDER=cliproxy
WEBOT_VISION_MODEL=gpt-5.6-sol
WEBOT_IMAGE_GENERATION_PROVIDER=cliproxy
WEBOT_IMAGE_GENERATION_MODEL=gpt-image-2
```

`127.0.0.1` 始终指运行 WeBot 的机器。如果 WeBot 部署在云服务器，而
CLIProxyAPI 只运行在 Mac，云端无法直接访问这个地址。服务器上的媒体 Provider
需要由服务器自身能够正常访问；相关网络基础设施配置不属于本项目文档范围。

### 自定义 OpenAI-compatible API

复制配置示例到私密状态目录：

```bash
cp providers.example.json ~/.webot/providers.json
```

修改其中的 `baseUrl`、`model` 和 `apiKeyEnv`，然后只把真实密钥放入
`.env` 对应环境变量。支持：

- `chat-completions`：`POST <baseUrl>/chat/completions`
- `openai-responses`：`POST <baseUrl>/responses`
- Bearer Token 或自定义 `apiKeyHeader` / `apiKeyPrefix`
- 自定义超时、最大输出、温度、固定非敏感请求头
- 可选 `toolCalling: "native"`，明确声明兼容原生函数调用
- 使用 `WEBOT_PROVIDERS_FILE` 指定其他配置路径

例如配置 ID 为 `custom` 后：

```text
/agent model custom
```

查看 Provider 状态：

```text
/provider list
/provider show
```

`●` 表示密钥和基础配置齐全，`○` 表示缺少密钥。通过后台保存的 API Key
会立即生效；修改 `.env` 或 Provider 配置文件后仍需重启进程。

自定义 Provider 默认不发送工具定义，因为许多“OpenAI-compatible”服务只
兼容普通文本。只有确认服务实现了所选 API 的原生工具协议后，才在私密
`providers.json` 中设置 `"toolCalling": "native"`。

## 语音输入

iLink 如果直接附带语音转写文字，WeBot 会直接使用。没有附带文字时，WeBot
会下载并解密微信 SILK 语音、转换为 WAV，再调用 OpenAI-compatible 的
`POST /audio/transcriptions` 接口。

默认使用后台中配置的 OpenAI API Key 和 `gpt-4o-mini-transcribe`。可选配置：

```dotenv
WEBOT_STT_PROVIDER=openai
WEBOT_STT_MODEL=gpt-4o-mini-transcribe
WEBOT_STT_LANGUAGE=zh
WEBOT_STT_ENDPOINT=audio/transcriptions
```

也可以把 `WEBOT_STT_PROVIDER` 指向 `providers.json` 中支持该接口的自定义
Provider。DeepSeek 聊天模型本身不能替代语音识别服务；只有 DeepSeek Key
时，仍可使用 iLink 已附带文字的语音，缺少文字的语音则会提示改用文字。

其他命令：

```bash
npm run status
npm run logout
npm test
npm run check
npm run build
```

可通过 `WEBOT_STATE_DIR` 把凭证放到其他私密目录：

```bash
WEBOT_STATE_DIR=/private/path npm run login
WEBOT_STATE_DIR=/private/path npm run start
```

## 接入模型或自己的 Agent

内置 `LlmProviderExecutor` 已处理身份、历史和用户输入。若要接入完全不同
的模型 SDK，也只需替换 `executor` 和可选的 `memoryCompressor`，iLink 和
Agent 管理代码无需修改：

```ts
import {
  AgentFramework,
  AgentStore,
  WeixinAdapter,
} from "webot-ilink-adapter";

const adapter = new WeixinAdapter();
await adapter.initialize();

const agents = new AgentFramework({
  store: new AgentStore({ stateDir: adapter.store.stateDir }),
  executor: async ({ agent, memory, input, userId }) => {
    return callYourModel({
      userId,
      system: agent.identity,
      messages: [
        ...memory.map(({ role, content }) => ({ role, content })),
        { role: "user", content: input },
      ],
    });
  },
  memoryCompressor: async (request) => {
    return callYourMemoryModel(request);
  },
});

await adapter.start(async (message) => {
  return agents.handle(message.senderId, message.text);
});
```

执行器会收到当前 Agent 的 `identity` 和该 Agent 的独立 `memory`。模型
成功回复后，框架自动把本轮用户消息和回复写入完整归档。CLI 内置接法会把
`LlmProviderExecutor.compressMemory` 注册为整理器；自定义接法未提供
`memoryCompressor` 时会使用本地保底摘要。

Agent 数据默认保存于：

```text
~/.webot/agents/<用户哈希>/
├── profiles.json
├── memory/
│   └── <agent-id>.json       工作窗口与 LLM 整理后的长期记忆
├── history/
│   └── <agent-id>.jsonl      只追加的完整原始聊天
├── memory-summaries/
│   └── <agent-id>/           每次成功压缩的不可变整理版本
└── memory-episode-rebuilds/
    └── <agent-id>.json       从完整聊天重新提炼的事件记忆

~/.webot/autonomy/
└── <用户哈希>.json          各 Agent 的自主经历及最近会话上下文

~/.webot/weather-schedules/
└── <用户哈希>.json          各 Agent 的每日天气私密配置与运行状态

~/.webot/reminders/
└── <用户哈希>.json          各 Agent 的待确认候选与单次提醒

~/.webot/prompt-traces/<用户哈希>/
└── <agent-id>.json          最近模型调用、Prompt Plan 与裁剪记录
```

目录使用用户 ID 的 SHA-256 摘要命名，状态文件权限为 `0600`。Prompt
Trace 默认每个 Agent 最多 20 条、单条最多 256 KiB；过大的正文会明确标记为
存储裁剪，不会静默无限增长。

## 目录

架构演进和同类开源项目的长期对照见
[WeBot 开源框架对照研究](docs/open-source-framework-reference.md)。

```text
src/
├── agent-framework.ts 多 Agent 命令、执行与记忆编排
├── agent-store.ts     用户档案和独立记忆持久化
├── agent-types.ts     Agent 执行器公共类型
├── autonomy-scheduler.ts 自主经历调度与主动联系策略
├── autonomy-store.ts  自主经历和最近会话上下文持久化
├── character-card.ts  Character Card V2/V3 与世界书兼容层
├── llm-executor.ts    Responses 与 Chat Completions 调用
├── prompt-compiler.ts 有预算、来源和裁剪记录的 Prompt Plan
├── prompt-trace-store.ts 私密模型调用记录
├── message-buffer.ts 连续入站消息聚合与按用户排队
├── reply-sequence.ts 微信回复气泡切分规则
├── reply-parts.ts    结构化文本/图片回复解析
├── image-input.ts    iLink 入站图片下载、解密与格式校验
├── image-media.ts    安全图片下载、加密上传与发送
├── media-ai.ts       多模态理解与图片生成 Provider 调用
├── provider-registry.ts Provider 配置、密钥和模型路由
├── provider-secrets.ts 后台 API Key 私密存储
├── provider-types.ts  Provider 公共类型
├── tool-registry.ts   受限工具注册表、天气查询与提醒候选
├── reminder-time.ts   中文日期与具体时刻的确定性解析
├── reminder-store.ts  待确认候选与单次提醒私密状态
├── reminder-scheduler.ts 单次提醒调度与原 Agent 投递
├── weather-scheduler.ts 每日天气调度、预览与主动投递
├── weather-schedule-store.ts 每 Agent 私密任务状态
├── admin-server.ts    本机管理 API、登录和静态页面
├── adapter.ts         长轮询与消息分发
├── api-client.ts      iLink HTTP 客户端
├── cli.ts             login/start/status/logout
├── message-parser.ts  入站文本标准化
├── qr-login.ts        扫码及验证码流程
├── storage.ts         凭证与游标持久化
└── types.ts           协议和公共类型

public/
├── admin.html         管理后台页面
├── admin.css          响应式视觉样式
└── admin.js           Agent 与 Provider 管理交互
```

## 安全说明

- 不要提交 `~/.webot/credential.json`，其中包含 `bot_token`。
- `~/.webot/agents` 可能包含私密对话记忆，也不应提交或公开。
- `~/.webot/prompt-traces` 包含模型实际看到的人设、记忆和用户输入，也不得
  提交、共享或暴露到公网。
- `characters/*.card.json` 默认被忽略；公开仓库前仍应检查是否有角色卡以其他
  文件名或格式保存在仓库中。
- 不要把真实 API Key 写入 `providers.json`；使用其中的 `apiKeyEnv` 引用
  `.env`、进程环境变量或本机后台的私密 Key 存储。
- 管理后台只为本机运维设计，不要修改监听地址或将它直接暴露到公网。
- 发送给第三方模型的内容包括 Agent 身份、对应 Agent 的最近记忆和当前
  用户消息，以及命中的世界书和按当前话题筛选后的长期摘要、结构化事实、
  关键经历。触发记忆
  压缩时，待整理的较早原始对话也会发送给当前 Agent 选择的 Provider。
  使用前请确认所选 Provider 的隐私政策。
- 导入第三方角色卡前请检查其中的 system prompt、历史后指令和世界书内容；
  它们会成为发送给模型的提示词，但不会获得系统工具权限。
- 角色卡、记忆和模型正文都不能注册新工具或改变工具权限；当前天气工具也
  不能访问任意网址、文件、Shell、API Key 或 iLink 会话令牌。
- Adapter 不会在日志中输出 token 或完整响应体。
- `context_token` 是当前会话的回复上下文，不应当作永久主动推送凭证。
- 默认只处理扫码授权者发来的消息。公开 Bot 需显式传入
  `new WeixinAdapter({ allowFrom: "any" })`，请先做好上层权限控制。
- 本项目使用官方维护通道，但不代表腾讯承诺任何使用方式都永不受限。
- `npm run logout` 只删除本地凭证；彻底解绑还需在微信授权入口操作。

## 协议来源

实现参考腾讯公开的
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)
`2.4.6`，固定参考提交见 `THIRD_PARTY_NOTICES.md`。上游采用 MIT
许可证。本仓库没有依赖 OpenClaw，也不是腾讯官方产品。

模型接口参考：

- [OpenAI Responses API 与模型指南](https://developers.openai.com/api/docs/guides/latest-model)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)
- [Open-Meteo Forecast API](https://open-meteo.com/en/docs)
- [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api)
