# v1.1 实现与验证

## 模块划分

| 文件 | 责任 |
| --- | --- |
| `image-host-settings.js` | 浏览器 / Node 共用的图床配置归一化与校验 |
| `upload-provider.js` | R2 / S3 SigV4 PUT、自定义 HTTP multipart 上传、直链生成 |
| `http-client.js` | 有超时、响应体上限的 HTTP(S) 请求；不跟随上传 / AI 重定向 |
| `markdown-engine.js` | markdown-it 解析、自动识别、本地提示、小票节点与安全预览 |
| `ai-markdown.js` | 可选 OpenAI Chat Completions 兼容检查，解析并归一化建议 |
| `enhancements.js` | 图床与 AI 设置界面、Markdown 编辑器、拖拽 / 粘贴、裁剪队列与上传状态 |
| `server.js` | 本地 API、持久化、FFmpeg 远程图片处理与 OneBot Markdown 接入 |

运行需要 Node.js 22+。不需要安装运行时 npm 依赖；Markdown、图标和二维码脚本位于 `vendor`，附带各自许可证。`package.json` 的 jsdom 仅用于开发交互检查。

## 新增 API

均在默认的 `http://127.0.0.1:4180`，JSON 请求与响应：

| 方法 / 路径 | 输入与行为 |
| --- | --- |
| `GET /api/app/info` | 返回版本与功能标识 |
| `POST /api/settings/image-host` | 更新当前运行图床，保留现有保存逻辑 |
| `POST /api/image-host/upload` | `{dataUrl,settings}`；返回 `{directUrl,pageUrl,remotePath?}` |
| `POST /api/image-host/test` | `{settings?}`；上传 1 像素 PNG，不会打印 |
| `POST /api/markdown/analyze` | `{text}`；返回 `detected/valid/characters/lines/issues/summary/nodes` |
| `POST /api/markdown/image` | `{url,settings?}`；下载、FFmpeg 白底抖动、上传，按来源与图床缓存 |
| `POST /api/settings/ai` | `{enabled,baseUrl,model,apiKey}`；只更新运行配置，响应不回传 Key |
| `POST /api/markdown/check-ai` | `{text,settings?}`；显式检查，返回 `summary/issues/revisedMarkdown` |

配置持久化仍使用 `/api/config`，新增 `ai` 与 `onebot.markdownEnabled`。浏览器模式在调用时提交当前配置；本地模式写入 `config.json`。切换保存模式会搬移配置；它不是加密存储。

### R2 / S3

`imageHost.provider` 新增 `r2`、`s3`、`custom`，原有 `imgchr/cfbed` 保留。

```json
{
  "provider": "r2",
  "endpoint": "https://ACCOUNT_ID.r2.cloudflarestorage.com",
  "bucket": "wechat-printer",
  "region": "auto",
  "accessKeyId": "YOUR_ACCESS_KEY_ID",
  "secretAccessKey": "YOUR_SECRET_ACCESS_KEY",
  "sessionToken": "",
  "publicBaseUrl": "https://img.example.com",
  "prefix": "wechat-printer",
  "forcePathStyle": true,
  "cacheExpireDays": 7,
  "deleteExpiredCache": false
}
```

S3 使用 SigV4、SHA-256 payload hash、规范化请求头和编码后的对象路径。支持路径式和虚拟主机式；对象键为前缀 / 日期 / 内容哈希。不发送 `public-read` ACL，由桶或 CDN 单独配置公开读取。没有 multipart 大文件上传或远程删除实现。单图最多 20 MB。

签名固定日期、中文路径、空格、临时令牌向量已独立与 AWS SDK 的 `botocore.auth.S3SigV4Auth` 对照。R2/S3 缓存 scope 是配置身份哈希，缓存文件不保存对象存储密钥。

### Markdown 与图片

同一个引擎同时用于网页预览和 QQ 排版。每个 content 节点只包含一行；图片节点使用 `icon.type=3`。原始 HTML 不执行，预览文字转义；图片仅接受完整 HTTP(S) URL。表格超 16 列视为当前打印限制，QQ 自动排版遇到此类错误时回退原文。

远程 Markdown 图片最多下载 20 MB，再复用 280×280 白底 + Floyd–Steinberg + JPEG 处理。普通手动 URL 图片节点保留原来的直接打印行为。本地拖拽图片通过浏览器 Canvas 裁剪和抖动，完成后异步上传，上传失败保留处理结果。多个图片依次进入裁剪队列；同一项上传合并为同一个 Promise，避免打印按钮与后台自动上传重复请求。

### AI

仅手动检查会发出请求。兼容请求使用 `model/messages/stream:false`，不要求 `response_format`；兼容响应使用 `choices[0].message.content`。系统提示区分格式建议、解析能力和打印限制，正文独立作为 user 消息，不拼接设备或图床凭据。

返回内容先按 JSON schema 的基本字段形状检查，再归一化条目与长度。客户端以 textContent 显示摘要、问题和修订全文；须用户点击应用。正文变化会让旧建议失效。支持无 Key 的本地兼容服务。单次最多 60000 字符、60 秒；不会自动检查收到的 QQ 聊天。

## 验证与边界

```sh
node --test
npm ci
npm run test:ui
```

目前 13 项 Node 测试全部通过，另有 DOM 交互验证。设置 `WECHAT_PRINTER_FFMPEG` 后，集成测试覆盖实际 FFmpeg 解码、白底缩放、抖动编码、JPEG 上传与缓存命中。OneBot 使用本地模拟 WebSocket，打印使用本地模拟 HTTP；外部打印请求被测试 hook 阻止。

DOM 验证涵盖启动、R2 保存、自动识别 / 原文切换、本地检查、AI 预览 / 手动应用、批量拖拽 / 裁剪 / 上传以及 Markdown 图片复用。它不代表不同浏览器的像素级视觉验收。

Windows 包应在全新目录通过自带 Node 启动，检查静态依赖、新 API、默认监听停止、配置无真实凭据。包包含可重建源码与 SHA-256 文件；不附带 FFmpeg。

未使用真实 R2 / S3 或 AI 账户进行付费 / 联网检查，未触发实物小票打印。真实账户需在设置中填写凭据后用上传测试确认直链与权限。
