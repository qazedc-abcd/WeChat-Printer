# OneBot v11 / QQ 适配版 v1.0.0

- 将 Telegram Bot API 接入替换为 OneBot v11 正向 WebSocket，适配本地 NapCat / LLOneBot。
- 支持 QQ 私聊文字、图片及 CQ 码，按消息段顺序排版，保留限流、黑名单和管理员指令。
- 使用 get_login_info、send_private_msg、get_image；保留图床和小票编辑功能。
- 默认本地页面改为 127.0.0.1:4180，OneBot 地址默认 ws://127.0.0.1:3001，访问令牌可留空。
- Windows 免安装包自带 Node.js；源码运行需 Node.js 22+。

解压后双击根目录 start-local.bat。图片需另装 FFmpeg，并配置可用图床；本包未包含 FFmpeg。

已通过 WebSocket、事件转换、权限、模拟打印接口和停止行为测试，并对本机 NapCat 完成只读登录状态检查。未向真实联系人发送测试消息，未完成 QQ 图片到实物打印机的完整实测。

详细配置见 README.md，实现与验证边界见 ONEBOT_TECHNICAL_HANDOFF.md。发行包不含设备 SID、QQ 账号配置或聊天记录。
