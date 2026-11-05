# WeChat Printer · QQ / OneBot v11

把 QQ 私聊打印成微信小票，也可以在网页中手动编辑、预览和发送小票。

本项目基于 [lemonno2333/WeChat-Printer](https://github.com/lemonno2333/WeChat-Printer)，保留原有小票编辑、图片处理和图床功能，将消息接入改为 **OneBot v11 正向 WebSocket**。适用于本地运行的 NapCat、LLOneBot 等 QQ / OneBot 服务。

**[下载 Windows 免安装版 v1.1.0](https://github.com/qazedc-abcd/WeChat-Printer/releases/tag/onebot-v1.1.0)** · **[R2 / S3 教程](docs/R2-S3-SETUP.md)** · **[Markdown 使用说明](docs/MARKDOWN.md)** · **[SID 获取工具](https://github.com/qazedc-abcd/WeChat-SID-Tool)**

## 能做什么

- **手动打印**：编辑文字、放大文字、空行、二维码、图片和表格，实时预览，也支持直接编辑请求 JSON。
- **QQ 消息打印**：接收私聊文字和图片，显示发送者昵称，按消息段顺序排版，合并连续消息。
- **图片处理**：本地图片可裁剪、缩放和调整对比度；QQ 图片经白底缩放、黑白抖动处理后上传图床，再交给小票机打印。
- **自定义图床**：支持 Cloudflare R2、S3 兼容 API、自定义 HTTP 上传接口，也保留 Imgchr / CloudFlare ImgBed；提供上传测试与配置教程。
- **拖拽与粘贴**：批量拖入图片后依次裁剪并自动上传，失败可重试；可复制 Markdown 图片链接。
- **Markdown**：手动输入与 QQ 文字自动识别，实时本地检查、预览，支持导入文档；可切换为原文打印。可选 AI 检查支持 OpenAI 兼容接口，默认关闭，建议需手动应用。
- **打印管理**：设置单用户打印频率、单任务字数、回复文案、黑名单和管理员指令。
- **本地运行**：默认只监听 `127.0.0.1`，配置可保存在浏览器或本地文件。

本工具是 OneBot 客户端；QQ 登录和消息上报由你已经安装的 NapCat / LLOneBot 等服务负责。

## 开始前准备

| 项目 | 要求 |
| --- | --- |
| 小票机 | 已绑定微信收款设备，并能在微信收款小程序中正常打印 |
| 设备参数 | `device_sn`、`sid`、`account_type` |
| QQ 接入 | 已登录 QQ 的 OneBot v11 服务，启用正向 WebSocket 的 API + 事件接口 |
| 浏览器 | 现代浏览器 |
| 源码运行 | Node.js **22 或更高版本**；Windows 免安装包已自带 Node.js |
| QQ / Markdown 远程图片处理 | FFmpeg，以及可用的公开图床或 R2 / S3 存储 |

可以先用文字验证打印链路，再配置图片。SID 有有效期，失效后需要重新获取。

## 快速开始

### 1. 启动本地工具

**Windows 免安装版**

1. 在 [Release](https://github.com/qazedc-abcd/WeChat-Printer/releases/tag/onebot-v1.1.0) 下载 `WeChat-Printer-OneBot11-windows-x64-v1.1.0.zip`。
2. 完整解压，双击根目录的 `start-local.bat`。不要直接在压缩包内运行。
3. 浏览器会打开 **<http://127.0.0.1:4180>**，使用期间保留服务窗口。

免安装包自带 Node.js，无需安装 Python 或执行 `npm install`。只启动服务、不自动打开浏览器时，运行根目录的 `start-server.bat`。

**源码运行**

```sh
git clone https://github.com/qazedc-abcd/WeChat-Printer.git
cd WeChat-Printer
node start-local.js
```

项目无需安装运行时 npm 依赖，Markdown、图标和二维码浏览器脚本已随源码附带。只启动服务可执行 `node server.js`；按 `Ctrl+C` 结束服务。

升级时先停止旧服务，在新目录解压新版，按需复制旧 `app` 目录中的 `config.json`、`.onebot-admin.json` 和 `.onebot-media-cache.json`。浏览器配置由同一浏览器与地址继续使用；更换端口会变成另一个存储位置。启动新版本并刷新页面，避免新旧服务占用同一端口。

### 2. 配置小票机

在“文本打印 → 设备与接口”填写设备 SN、SID 和 `account_type`，或点击“从 JSON 导入”：

```json
{
  "device_sn": "YOUR_DEVICE_SN",
  "sid": "YOUR_DEVICE_SID",
  "account_type": 2
}
```

`account_type` 请使用实际请求中的值，示例中的 `2` 仅用于演示。设备参数由手动打印和 QQ 消息监听共用。

如果还没有这些参数，可使用独立的 [微信小票机 SID 助手](https://github.com/qazedc-abcd/WeChat-SID-Tool)：抓取自己设备的一次推广位打印请求，导出设备 JSON 后在这里导入。该工具另有自己的使用说明和 Release。

先在网页中发送一条简单文字，确认设备参数可用。

### 3. 连接 QQ

在 NapCat / LLOneBot 中登录 QQ，启用 **OneBot v11 正向 WebSocket 服务**。界面名称可能不同，关键是同时提供 API 调用和事件推送。

然后在本工具“消息监听”中填写：

| 设置 | 示例 / 说明 |
| --- | --- |
| OneBot v11 正向 WebSocket 地址 | `ws://127.0.0.1:3001`；以 QQ 框架实际配置为准 |
| 访问令牌 | QQ 框架配置了令牌就填写相同值；未配置鉴权则留空 |
| 接收设备 | 复用上一步的小票机参数 |

使用提供 API + 事件的根路径。只提供单一能力的 `/api`、`/event` 地址不能用于本工具。无需配置反向 WebSocket 或反向 HTTP 回调，也无需 Telegram Bot Token。

点击“开始监听”，工具会调用 `get_login_info` 检查 QQ 登录。连接成功后，用另一个 QQ 账号给已登录的机器人 QQ 发送私聊文字，即可进入打印队列。

停止接收时点击“停止监听”，或结束本地服务。**仅关闭网页不会停止后台监听。**

## QQ 消息如何处理

| 消息 / 事件 | 行为 |
| --- | --- |
| 私聊文字 | 打印发送者昵称与正文；没有昵称时使用 QQ 号 |
| 私聊图片、自定义表情图片 | 按图片处理，需要 FFmpeg 和图床 |
| 图文混排 | 保持文字、图片和后续文字的原始顺序 |
| QQ 内置表情 | 以 `[表情:ID]` 文字标记打印 |
| @、链接分享 | 转换为文字；符合长度限制的链接可生成二维码 |
| 回复引用 | 忽略引用元数据，继续处理实际消息正文 |
| 群聊、机器人自己发送的消息、心跳 | 忽略 |
| 文件、语音、视频等未支持类型 | 跳过，并按设置回复 |

支持 OneBot 消息段数组与 CQ 码字符串。连续消息默认在 **500 ms 没有新消息后**按队列顺序合并；重复上报的同一消息会去重。连接中断后最多重试三次，仍失败则停止，可在页面重新开始。

本版本接收 **QQ 私聊**，不提供群聊打印开关。

## 图片与图床

QQ 图片会优先使用 OneBot 上报的 HTTP(S) 地址；需要时通过 `get_image` 查询图片位置。工具将图片缩放到 **280 × 280** 的白底画布，并使用 Floyd–Steinberg 抖动转成黑白图，再上传到所选图床。

1. 安装 FFmpeg，并让 `ffmpeg` 命令可用；也可用 `WECHAT_PRINTER_FFMPEG` 环境变量指定完整路径。
2. 在“图床设置”选择 R2 / S3、自定义 HTTP 图床、Imgchr 或 CloudFlare ImgBed，填写相应配置。
3. 确认图床可用后，在“消息监听”中开启图片打印。

**Windows 免安装包未包含 FFmpeg。** 图片处理失败时，先检查 FFmpeg 和图床；文字打印不依赖 FFmpeg。

CloudFlare ImgBed 支持上传渠道、缓存天数和过期图片清理。其渠道列表中的 Telegram 是图床的存储渠道，不是 Telegram 消息监听。

**[Cloudflare R2 / S3 逐步配置教程](docs/R2-S3-SETUP.md)** 包含创建桶、生成对象读写凭据、公开域名、Region、寻址方式和错误排查。“上传测试图片”不会打印；上传后请点击返回的直链确认能公开下载。R2 / S3 的远程对象由存储服务生命周期管理，本工具不自动删除。

### 图片实测补充

2026-11-05 的实物研究确认：`icon.type=3` 会把横图、竖图和长图压成固定方形；调整 `icon.style.height/width` 没有改变输出尺寸。上传前应裁剪为方形或保持比例填入方形白底画布；直接发送长图不会得到等比例长条输出。透明 PNG 的透明区会变黑，需要先合成白底。

设备输入推荐 **PNG/JPEG**。本轮 GIF/WebP 直接打印为空白，BMP 用例返回系统繁忙；本地导入后转换成 PNG/JPEG 仍可使用。20 MiB 与 280×280 是工具策略，设备的文件大小和像素上限仍未测得。图片 URL 已测到 6000 字符可用、12000 字符失败，但精确边界未知。

**接口受理不等于实际打印成功。** 本轮 `errcode=0` 也出现在空节点和 404 图片用例。错误码 `268697729` 不仅表示离线，也可能表示正在打印或系统繁忙，应结合消息判断。[完整协议与图片实测说明](docs/PRINTAD-PROTOCOL.md)

**原生二维码长内容存在设备重启记录。** OneBot 保留 100 UTF-8 字节保护；v1.1.0 手动二维码请自行控制在 100 UTF-8 字节以内。该值是保守策略，不是已证明的硬件安全阈值。

## Markdown 与 AI 检查

在文字节点输入 Markdown 会自动识别；可点击“保留原文”或“打开检查器”。也可以新建 Markdown 节点，导入或拖入文档。标题、列表、引用、代码、表格和图片会转换为小票节点。

检查器把格式建议与打印限制分开显示：缺少空格、未闭合标记等给出提示，非公开图片地址和超过 16 列的表格需要调整。Markdown 允许许多写法作为普通文字解析，本地检查不会把所有提示都当成语法错误。

AI 默认关闭。需要时在设置中填写兼容 OpenAI 的基础地址、模型和 Key，在 Markdown 节点手动点击“AI 检查”。保存配置、自动识别与 QQ 接收不会调用模型；只有当前节点正文被发送。建议全文可预览，手动点击才会应用。[完整说明](docs/MARKDOWN.md)

## 限流、回复与管理员

在“回复与限制”中可以设置单用户每分钟任务数、单任务字数、重复触发后的封禁时长，以及打印中、完成、失败和限流回复。任务数或字数填 `0` 表示不限制。

管理员指在本工具中配置的 **QQ 号**。可在页面填写，或使用环境变量 `ONEBOT_ADMIN_USER_IDS`，多个 QQ 号用逗号分隔。

普通用户可发送 `/whoami` 查看自己的 QQ 号。管理员可在私聊使用以下指令，指令不会进入打印队列：

| 指令 | 用途 |
| --- | --- |
| `/help` | 查看管理帮助 |
| `/users`、`/user <QQ号>` | 查看用户及详情 |
| `/messages <QQ号>` | 查看最近消息和处理结果 |
| `/limits`、`/limit` | 查看或调整限流规则，具体参数见 `/help` |
| `/blacklist` | 查看黑名单 |
| `/block <QQ号> [时长] [原因]` | 封禁用户 |
| `/unblock <QQ号>` | 解除封禁 |
| `/status`、`/logs` | 查看运行状态和日志 |

## 配置保存

默认可使用浏览器存储，也可在设置中切换为程序目录的 `config.json`。完整示例见 [config.example.json](config.example.json)，消息接入配置位于 `onebot` 节点。

| 文件 | 内容 |
| --- | --- |
| `config.json` | 设备参数、OneBot 令牌、图床与可选 AI 设置 |
| `.onebot-admin.json` | QQ 用户、消息预览、限流、黑名单和管理审计 |
| `.onebot-media-cache.json` | 已处理 QQ 图片的图床缓存 |

免安装包中的本地数据文件位于 `app` 目录。配置和消息记录可能包含凭据或隐私内容，请保存在自己的电脑上；它们已加入 Git 忽略规则，发行包不包含个人数据。

旧版 Telegram Token 和管理员 ID 不会自动转换为 QQ 设置，需要重新配置 OneBot 地址与管理员 QQ 号。

## 常见问题

**网页打不开或端口被占用**

确认服务窗口没有退出，手动访问 <http://127.0.0.1:4180>。源码版可在 PowerShell 中更换端口：

```powershell
$env:PORT = '4181'
node start-local.js
```

**OneBot 连接失败**

检查 QQ 是否已登录、正向 WebSocket 服务是否启用、地址与端口是否一致、访问令牌是否匹配。确认使用 API + 事件接口，而非 `/api` 或 `/event` 单独接口。源码运行还需确认 Node.js 为 22+。

**连接成功，但收不到打印任务**

使用另一个账号发送私聊消息。群聊和机器人自身发送的消息会被忽略；同时检查用户是否被限流或拉黑，以及页面日志中的处理结果。

**打印失败或提示 SID 失效**

先用“文本打印”发送简单文字。检查 SN、SID、`account_type` 与网络；SID 失效后重新获取，并更新共用设备参数。

**图片打印失败**

运行 `ffmpeg -version` 确认安装成功，再检查图床上传结果。图片下载限制为 20 MB，过期的 QQ 图片链接也可能导致获取失败。

## 开发与验证

源码运行需要 Node.js 22+。在项目根目录执行全部测试：

```powershell
node --test
```

测试覆盖文本兼容性、SID 错误识别、管理员规则、票面排版、OneBot 接入，以及 S3 签名上传、自定义 HTTP 图床、Markdown 和 AI 兼容接口。集成测试使用本地模拟 OneBot、图床、AI 与打印接口，不会向真实联系人发送消息或调用真实打印机。设置 `WECHAT_PRINTER_FFMPEG` 后，集成测试也会验证远程图片的实际编码与缓存。

可选的页面交互验证需要开发依赖（不影响直接运行工具）：

```sh
npm ci
npm run test:ui
```

它使用 jsdom 检查配置保存、Markdown 切换、AI 建议确认、批量拖拽裁剪与上传，不操作浏览器或打印机。

Windows x64 打包使用 PowerShell 7 和官方 x64 Node.js 22+：

```powershell
pwsh -File .\build-windows.ps1
```

产物位于 `dist`，包含免安装包、源码包和 SHA-256 校验文件。重复构建需使用新的输出目录，例如 `-Output .\dist-new`。

本机已完成模拟接口、FFmpeg 处理、DOM 交互和免安装包启动验证。**R2 / S3、AI 提供商的真实账号连通性与新版实物打印链路尚未验证。** 实现说明见 [v1.1 技术说明](docs/TECHNICAL-NOTES-v1.1.md) 和 [OneBot 技术交接](ONEBOT_TECHNICAL_HANDOFF.md)，协议参考 [OneBot 11 标准](https://github.com/botuniverse/onebot-11)。

## 致谢与许可

小票编辑、排版、图床和基础界面来自 [lemonno2333/WeChat-Printer](https://github.com/lemonno2333/WeChat-Printer)，本仓库在此基础上新增 OneBot v11 / QQ 适配。沿用 [MIT License](LICENSE)。
