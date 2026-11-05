# 自定义图床：Cloudflare R2、S3 与 HTTP 上传接口

图床负责保存处理后的图片并提供公开直链。小票机从直链下载图片，所以 **上传 Endpoint** 和 **公开访问地址** 要分别填写。Android 与 Windows 应用直接发起上传，凭据只发送给你配置的服务。

## Cloudflare R2 配置教程

### 1. 创建存储桶

在 Cloudflare 控制台进入 **R2 Object Storage**，创建一个桶，例如 `wechat-printer`。按控制台提示完成账户开通；费用和额度以 Cloudflare 当前页面为准。

### 2. 开启公开读取

进入桶的设置，选择一种公开访问方式：

- **自定义域名**：绑定自己的域名，例如 `https://img.example.com`，适合长期使用。
- **Public Development URL / r2.dev**：开启后复制控制台给出的 `https://pub-…r2.dev` 地址，可用于试用。Cloudflare 将它定位为受限速的开发用途；正式使用建议绑定自定义域名。[官方说明](https://developers.cloudflare.com/r2/buckets/public-buckets/)

桶默认并不公开。图片域名不能要求 Cloudflare Access 登录、Cookie 或额外请求头，小票机不会携带这些凭据。只需公开读取对象，不要对公网开放写入权限。

### 3. 创建 R2 S3 凭据

在 R2 的 **Manage R2 API Tokens / 管理 R2 API 令牌** 创建令牌：

1. 选择 **Object Read & Write / 对象读写**。
2. 范围限制为刚才的桶。
3. 保存 **Access Key ID** 与 **Secret Access Key**。Secret 通常只展示一次。
4. 复制 S3 API Endpoint，通常是 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`。若桶使用 EU/FedRAMP 等辖区，使用控制台对应的 Endpoint。[官方令牌教程](https://developers.cloudflare.com/r2/api/tokens/)

这里需要 S3 Access Key 与 Secret，不是粘贴一个 Cloudflare 通用 Bearer API Token。

### 4. 填写工具设置

打开工具的“设置 → 图床设置”：

| 字段 | R2 示例 |
| --- | --- |
| 图床服务 | Cloudflare R2 |
| S3 API Endpoint | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| Bucket | `wechat-printer` |
| Region | `auto` |
| Access Key ID / Secret Access Key | 第 3 步生成的凭据 |
| 公开访问地址 | `https://img.example.com` 或控制台给出的 `r2.dev` 域名 |
| 对象前缀 | `wechat-printer`，也可留空 |
| 路径式寻址 | 勾选 |
| Session Token | 普通 R2 凭据留空；使用临时凭据时按提供方填写 |

R2 的 Region 使用 `auto`。[R2 S3 API 文档](https://developers.cloudflare.com/r2/api/s3/api/)

Endpoint 中不追加桶名。公开地址也不追加对象前缀，程序会拼接 `前缀/年/月/日/内容哈希.jpg`。如果公开站点在路径下映射桶，可填写相应的公开路径。

### 5. 测试并保存

先点击“上传测试图片”。它只上传一张很小的 PNG，不会打印。点击返回的直链，确认能直接显示图片；上传成功不代表公开域名一定配对正确。然后点击“保存图床设置”。

回到编辑器，拖入一张图片，完成裁剪与黑白处理后会自动上传。上传失败会保留处理结果，可点击“上传到图床”重试。也可复制 Markdown 图片链接。

上传由本机应用完成，因此本功能不需要为浏览器配置 R2 上传 CORS。应用直接显示已处理的本机图片或公开图片直链。

## S3 兼容服务

选择“S3 兼容存储”，填写服务实际提供的 Endpoint、Region、桶和凭据。程序使用 **AWS Signature Version 4** 签名 `PutObject`，支持临时 Session Token。

| 服务示例 | Endpoint | Region | 寻址方式 | 公开访问地址示例 |
| --- | --- | --- | --- | --- |
| AWS S3 | `https://s3.us-east-1.amazonaws.com` | 桶实际 Region | 通常取消路径式 | `https://my-bucket.s3.us-east-1.amazonaws.com` 或 CDN 域名 |
| MinIO | `http://127.0.0.1:9000` | 实际设置，常见为 `us-east-1` | 通常勾选路径式 | 必须填写小票机可访问的域名，例如 `https://img.example.com/my-bucket` |
| 其他 S3 服务 | 服务文档中的 S3 API 地址 | 服务要求的值 | 按服务要求 | 对象的公开 CDN / 域名 |

上表是配置形状示例，不保证服务默认开启公开读取。MinIO 的 API 可以在本机，但公开图片域名必须能由小票机访问。S3 的公有访问策略、CDN 和 HTTPS 证书由存储服务配置。

## 自定义 HTTP 图床

选择“自定义 HTTP 图床”：

| 字段 | 示例 |
| --- | --- |
| 上传接口 | `https://img.example.com/api/upload` |
| 文件字段名 | `file` |
| 响应中 URL 的 JSON 路径 | `data.url`；数组示例为 `0.url` |
| Authorization | 可选，例如 `Bearer YOUR_TOKEN`，按接口原样填写 |

工具向接口发送 `POST multipart/form-data`，包含一个图片文件字段。示例响应：

```json
{"data":{"url":"https://img.example.com/images/receipt.jpg"}}
```

支持绝对 HTTP(S) 直链和相对上传接口的地址。需要额外表单字段、动态签名、非 Authorization 鉴权等私有协议的服务，需要自行提供一个适配上传接口；本功能不支持任意脚本执行。

## 缓存、配置与常见错误

- 凭据使用系统安全存储，正文草稿保存在应用本机数据中。旧版 config.json 可通过设置导入，不要把自己的配置上传 GitHub。
- 本分支使用 Dart 在本机处理图片，不依赖 FFmpeg；Android 可从系统选择图片，Windows 支持拖入图片。
- 本分支在当前会话复用已上传图片，R2/S3/自定义 HTTP 图床不会被工具自动删除远程对象；如需回收空间，请在存储服务设置生命周期规则。公开对象被删除后，旧直链会失效。
- `SignatureDoesNotMatch`：核对 Endpoint、Region、密钥、系统时间和寻址方式，避免反向代理重写请求路径。
- `AccessDenied`：核对凭据是否有目标桶的对象写权限。
- 上传成功但直链 403/404：核对公开访问设置和公开地址；不要把 API Endpoint 当公开域名。
- 图床显示正常但小票机不打印：检查设备可达性、URL 长度、SID 和图片格式。Markdown 图片会在发送前白底缩放并抖动成黑白 PNG；本分支远程图片也会经过白底处理与 PNG 转换。

## 设备图片能力实测补充

上传成功与直链 HTTP 200 只验证图床，不能证明设备出纸。设备侧推荐 PNG/JPEG，透明图片先合成白底，非方形图片先裁剪或等比例填入方形画布。原图直接交给 `icon.type=3` 会被拉伸为固定方形，长图也一样，不能靠 icon.style 的尺寸参数恢复比例。

当前 20 MiB 是工具限制，图片最大体积和像素边界仍未知。部分复杂图案用例约 17.5 秒后返回系统繁忙，不能将其简单归因于文件大小；不应自动重试打印请求。[完整图片与协议说明](PRINTAD-PROTOCOL.md)
