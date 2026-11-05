# WeChat Printer · OneBot v11 / QQ

基于 [lemonno2333/WeChat-Printer](https://github.com/lemonno2333/WeChat-Printer) 的 OneBot v11 适配版。保留小票编辑、预览、图片处理、图床、设备 JSON 导入和打印接口，将 Telegram 接入替换为本地 OneBot v11 正向 WebSocket，主要用于 NapCat / LLOneBot 等 QQ 框架。

## 启动

Windows 免安装包完整解压后运行根目录 `start-local.bat`。自带 Node.js，无需安装 npm 依赖。

源码运行需要 **Node.js 22+**，直接执行：

```sh
node start-local.js
```

默认页面：<http://127.0.0.1:4180>。只启动服务用 `node server.js`，Ctrl+C 停止。`HOST` 默认 `127.0.0.1`，`PORT` 可覆盖默认端口。

## 连接 QQ

1. 在“文本打印”中填设备 SN、SID 和 account_type，或从 SID 助手导出的 JSON 导入。SID 有有效期，失效后重新获取。
2. 登录本机 NapCat / LLOneBot，启用 OneBot v11 **正向 WebSocket**，并让接口提供 API 和事件。
3. 打开“消息监听”，填根路径，例如 `ws://127.0.0.1:3001`。不要填写只提供 API 或事件的 `/api`、`/event` 子路径。
4. QQ 框架没有配置鉴权时，访问令牌留空；配置了则填写相同令牌。
5. 点击“开始监听”。启动会通过 `get_login_info` 检查 QQ 登录，不需要 Telegram Bot Token、Telegram 代理或反向事件回调。
6. 给已登录的 QQ 发送私聊文字或图片，即进入打印队列。仅在用户主动开始后监听；关闭页面不会自动停止服务，可在页面点击“停止监听”或结束服务。

OneBot v11 接口与消息格式以 [OneBot 11 标准](https://github.com/botuniverse/onebot-11) 为准。连接中断后最多重试三次；达到上限会停止，可手动重新开始。

## 消息与打印

- 仅处理 QQ 私聊。群聊、机器人自发消息和心跳不会打印。
- 支持标准消息段数组，也支持 CQ 码字符串；正文、图片和后续正文按原顺序处理。
- 发送者使用 QQ 昵称，缺少昵称时使用 QQ 号；同一批连续 500ms 的消息按队列顺序合并。
- QQ 表情以 `[表情:ID]` 文本表示；自定义表情若作为 image 消息段上报，按图片处理。@ 使用文字标记，回复引用元数据忽略，链接可以生成二维码。
- 文件、语音、视频及其他不支持类型会按设置回复并跳过。
- API 回复通过 `send_private_msg` 的纯文本消息段发送，避免把回复正文中的 CQ 片段作为可执行消息段解释。
- 图片优先使用上报的 HTTP(S) URL；需要时调用 `get_image` 获取 URL 或 QQ 框架解析出的本地文件。不会直接读取聊天消息给出的本地路径。
- 图片处理需要另外安装 **FFmpeg**，可通过 `WECHAT_PRINTER_FFMPEG` 指定可执行文件。免安装包未包含 FFmpeg。
- 图片会经过 280×280 白底缩放与 Floyd–Steinberg 黑白抖动，再上传所选图床；保留 Imgchr / CloudFlare ImgBed 设置。QQ 图片链接不会原样直接交给小票机。

## 限流和管理员

保留单用户每分钟任务数、单任务字数、升级封禁、黑名单、管理员审计和状态日志。管理员设置改为 **QQ 号**，或使用 `ONEBOT_ADMIN_USER_IDS` 环境变量，多个以逗号分隔。

用户可私聊发送 `/whoami` 查看 QQ 号；管理员可使用 `/help`、`/users`、`/user`、`/messages`、`/limits`、`/limit`、`/blacklist`、`/block`、`/unblock`、`/status`、`/logs`。非管理员不能执行管理操作。命令不进入打印队列。

## 配置和数据

浏览器保存模式与 `config.json` 本地保存模式均保留。示例见 `config.example.json`，OneBot 配置在 `onebot` 节点。不会把旧 Telegram Token 或管理员 ID 自动当作 QQ 配置使用。

| 文件 | 用途 |
| --- | --- |
| `config.json` | 设备 SID、OneBot 访问令牌、图床设置；不要提交或分享 |
| `.onebot-admin.json` | QQ 用户、消息预览、限流、黑名单和审计记录；不要提交或分享 |
| `.onebot-media-cache.json` | QQ 图片处理后的图床缓存 |
| `config.example.json` | 仅占位值的配置示例 |

这些运行时文件已加入 Git 忽略规则，发布包不包含个人配置。图床上传渠道中的 Telegram 是 CloudFlare ImgBed 自己的存储渠道，保留其合法枚举，不代表仍连接 Telegram Bot API。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/` | 网页界面 |
| POST | `/api/print?sid=...` | 手动打印请求 |
| GET / POST / DELETE | `/api/config` | 本地配置 |
| POST | `/api/onebot/start` | 连接 OneBot v11 并启动监听 |
| POST | `/api/onebot/stop` | 停止监听并关闭连接 |
| GET | `/api/onebot/status` | 状态、日志、队列和限制 |
| GET | `/api/onebot/blacklist` | 黑名单 |
| DELETE | `/api/onebot/blacklist/:userId` | 解除限制 |
| POST | `/api/onebot/logs/clear` | 清空日志 |

原 `/api/telegram/*` 接口已移除。本程序是 OneBot 客户端，不实现 QQ 登录，也不是新的 OneBot 服务端。

## 验证

```powershell
Get-ChildItem *.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { throw $_.Name } }
```

测试包括原有文本、SID 错误识别、管理员和票面排版，以及真实 WebSocket mock 的 RPC echo、访问令牌、事件转换、CQ 码、去重、超时、断线重连、停止竞争条件、模拟打印接口的端到端测试。测试不连接真实 QQ 联系人或打印设备。

本机已对运行中的 NapCat 做过只读 `get_login_info` 连接检查，确认正向 WebSocket 可用；图片真实设备输出仍取决于 FFmpeg、图床和小票机。

## 许可

沿用上游 MIT License，见 `LICENSE`。打印排版、图床和基础界面来自原项目，OneBot 适配为本分支新增。
