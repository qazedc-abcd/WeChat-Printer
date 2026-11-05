# OneBot v11 适配技术说明

上游基线：`lemonno2333/WeChat-Printer`，提交 `d68e8de`。改动在独立分支 `feature/onebot11`。

核心替换：

- `telegram-admin.js`、`telegram-layout.js` 迁移为 `onebot-admin.js`、`onebot-layout.js`；管理规则与打印节点语义保留，所有模块导出和调用同步改名。
- 新增 `onebot-client.js`，仅使用 Node.js 内置 WebSocket / crypto，最低 Node.js 22。正向 WS 根路径提供 API + 事件；默认 `ws://127.0.0.1:3001/`。
- `get_login_info` 检查登录；`send_private_msg` 以 text 消息段回复；`get_image` 用于图像定位；使用 echo 关联并发响应并设请求超时。
- token 独立输入并通过标准 access_token 查询参数鉴权。连接错误不会回显带 token 的 URL。
- OneBot message 数组或 CQ 字符串转换为现有打印队列使用的内部消息结构。一个事件按消息段顺序拆成 text/image/text 等连续项，保留同一发送者。
- 按 self_id、message_type、message_id 做有界去重；过滤 self 消息和非 message 事件。群聊继续由业务层忽略，避免改变原项目私聊使用范围。
- RPC pending、消息等待者、去重和消息队列都有界限；关闭与等待的竞争条件已覆盖测试。传输失败由现有业务循环重试，三次失败后停止。
- Telegram 的 HTTP 长轮询、getFile、Bot API 文件地址、命令菜单注册和 HTTP 代理被删除。WebP/WebM sticker 专用界面和视频抽帧逻辑删除；QQ 自定义表情作为 image 消息处理。
- 浏览器键名、配置节点、API 路径、管理员环境变量与持久化文件改为 onebot；旧 Telegram 的凭据和管理员列表不会自动迁移为 QQ 设置。
- 默认本地端口改成 4180，启动脚本同步。原 4173 版本可继续独立使用。

媒体处理沿用上游 FFmpeg + Floyd–Steinberg + 图床流程。OneBot 图片可从 URL 下载，或从可信的本地 OneBot `get_image` 结果读取本地文件；不会从聊天段中的 file:// 路径直接读取文件。下载限制 20 MB，最多五次重定向。

前端移除了旧 Token、代理和贴纸选项，替换为本地正向 WebSocket、可选访问令牌和管理员 QQ 号。CloudFlare ImgBed 上传渠道的 `telegram` 值保持原样，避免破坏第三方图床协议。

运行时隐私文件不通过静态文件接口提供，并加入 Git 忽略规则。发行包只携带源码和 Node.js，不包含真实设备、QQ 号、令牌或聊天记录。默认不自动连接、不自动打印；用户点击开始监听后才进入业务流程。

验证：

1. 原有四组测试迁移后执行。
2. CQ 转义、消息段次序、昵称、URL、群聊标记、self/meta 过滤。
3. 本地 WebSocket mock：RPC echo、token、失败码、超时、去重、断开重连、立即停止竞争。
4. 独立子进程服务器 + mock OneBot + mock 打印接口：无 token 启动、whoami 回复、管理权限、群聊/self/心跳忽略、打印队列与去重、停止后不再打印、旧 Telegram 路径已移除。
5. 实际本机 NapCat：只读 `get_login_info` 成功，未向真实联系人发消息，未调用真实打印接口。

尚未做真实 QQ 图片经 FFmpeg、图床、小票机全链路实测。发行包未含 FFmpeg，需要用户另外安装或通过 `WECHAT_PRINTER_FFMPEG` 配置。
