# 小票台 · Print Only

Android 与 Windows 的纯打印客户端，使用 **Flutter + Material Design 3**。本分支仅保留手动排版、预览、图片处理与打印，不包含 QQ / Telegram 消息监听。

- 分支：`feature/print-only-material`
- Android：底部导航、单列编辑、弹层小票预览。
- Windows：侧边导航、编辑 / 纸面预览双栏，支持窄窗口。
- 两端独立运行，无需 Node.js、电脑服务或 FFmpeg。

**[下载 Android / Windows 预览版](https://github.com/qazedc-abcd/WeChat-Printer/releases/tag/print-only-v0.2.1)** · [保留 QQ 接入的 main 版本](https://github.com/qazedc-abcd/WeChat-Printer/tree/main)

Android 通常选择 arm64-v8a APK；Windows 完整解压 ZIP 后运行 xiaopiao.exe。从 0.1.1 起发布的 Android 预览版使用固定签名。0.1.0 使用临时签名，升级到 0.1.1 需要先导出草稿、保留原设备与图床配置，再卸载旧版安装；卸载会清除本机数据。后续保持同一签名的版本可覆盖更新。

0.1.1 修复 Android 粘贴：正文、SN、SID、图床等输入框右侧均有粘贴按钮，长按菜单保留粘贴并关闭放大镜；Windows 支持 Ctrl+V。“粘贴 JSON”直接读取剪贴板，检查内容后点击“导入”，对话框也支持重新粘贴。设置项的粘贴按钮替换整项，正文、长按菜单和快捷键按光标或选区插入。只在点击粘贴时读取剪贴板。

## 界面预览

Windows：

![Windows Material Design 3 编辑界面](docs/design/windows.png)

Android：

![Android Material Design 3 编辑界面](docs/design/android.png)

## 功能

- 普通文字、自动识别 Markdown、表格、清单、代码与引用。
- 图片选择 / Windows 拖拽；方形裁剪或等比例白底留白；亮度、对比度、黑白抖动。
- 短二维码、固定 divider 分隔线和空白行；内容块可排序。
- Cloudflare R2、S3 兼容签名上传、自定义 HTTP 图床；默认图片前缀为 `xiaopiao`。
- 可选 OpenAI 兼容 AI 检查，默认关闭，建议需预览后手动应用。
- 自动保存草稿、文档导入 / 导出、本机打印记录、浅色 / 深色主题。
- 设备 / 图床 / AI 凭据使用系统安全存储，可导入 SID 助手或旧版配置 JSON。

## 开始使用

1. 打开设置，导入设备 JSON 或填写实际 `device_sn`、`sid` 和 `account_type`。
2. 需要图片时配置图床。R2 的 Region 填 `auto`，公开地址填写图片域名，前缀可填 `xiaopiao`。
3. 使用“上传测试图片”检查上传与公开下载，该操作不会打印。
4. 编辑或导入内容，查看预览，再点击“发送打印”。

[协议与图片实测说明](docs/PRINTAD-PROTOCOL.md) · [两端设计与实现](docs/PRINT-ONLY-DESIGN.md)

设备 SID 有有效期，失效后需要重新获取。接口返回成功只代表请求受理，出纸与完整性以实物为准。

## Markdown 小票排版

一级标题居中并加高，分节标题和正文靠左。需要单独居中的一行可以写成 `<center>谢谢惠顾</center>`。表格沿用 Markdown 分隔行的对齐设置，纯数值列默认靠右。同一张表的各行共用列宽，长内容由打印机在列内换行。预览使用发送给打印机的列宽权重和对齐方式。

本地规则在编辑时生效。需要 AI 建议时，在设置中启用 AI、填写兼容 OpenAI 的基础地址、模型名称和密钥，然后在内容块中请求排版。每次请求使用已保存的模型名称。核对建议后可以手动应用。

如果服务运行在 Windows 本机的 8788 端口，Windows 客户端可填写 `http://127.0.0.1:8788/v1`。Android 真机的回环地址指向手机自身。使用 USB 调试连接电脑时，可以先执行 `adb reverse tcp:8788 tcp:8788`，再在手机中填写同一地址。

## 图片与二维码

设备会将原始长图压成固定方形。本应用会先做方形裁剪或保持比例填入白底，再转换为不透明 PNG，避免设备拉伸与透明区变黑。支持 PNG/JPEG/WebP/GIF 导入，交给设备的最终格式为 PNG。

图片导入 / 下载上限 20 MiB，解码内存保护为 4000 万像素，输出 280×280；这些都是本地策略，不是测得的硬件上限。当前没有长图自动切片或无缝拼接功能。

长内容原生二维码存在实测设备重启风险。本应用在统一发送入口检查 100 UTF-8 字节，不静默截断。该值是保守策略，不构成对所有固件的安全保证。

## 配置与图床

R2 使用限于目标桶的对象读写 Access Key ID / Secret Access Key，Session Token 仅在临时 S3 凭据需要时填写。Cloudflare 管理 API 令牌不填入 Session Token。

公开域名必须允许小票机无 Cookie / 登录访问。S3 Endpoint 与公开域名分别填写；对象按 `xiaopiao/年/月/日/内容哈希.png` 命名。Android 和 Windows 直接签名上传，不需要浏览器 CORS 设置。

自定义 HTTP 图床使用 multipart POST，可配置上传地址、文件字段名、Authorization 和返回 URL 路径（例如 `data.url` 或 `0.url`）。

导入旧版 `config.json` 只迁移设备、图床和 AI 配置，消息机器人设置不会迁移。导出的小票文档不包含配置对象；本机草稿包含用户正文与处理后的图片，请按需管理。

## 构建

开发环境使用 Flutter **3.41.5**、Dart **3.11.3**。Android 最低 API 24；Windows 需要 Visual Studio 的 C++ 桌面开发工具链。

```sh
flutter pub get --enforce-lockfile
flutter analyze
flutter test
flutter build apk --release --split-per-abi
flutter build windows --release
```

CI 工作流为 `.github/workflows/print-only.yml`，产出 Android APK 和 Windows x64 Release 文件，并在 Android API 35 模拟器上验证真实系统剪贴板到正文、SN、SID、JSON 导入的完整链路。Windows 包需要完整解压后运行 `xiaopiao.exe`。

发布签名通过仓库 Actions Secrets `PRINT_ONLY_PREVIEW_KEYSTORE`（JKS 的 Base64）与 `PRINT_ONLY_PREVIEW_PASSWORD` 恢复；别名为 `printonly-preview`。本机构建如需同一签名，设置 `PRINT_ONLY_KEYSTORE_PATH`、`PRINT_ONLY_KEYSTORE_PASSWORD`；没有设置时使用本机 debug 签名，其 APK 不保证能覆盖官方预览版。签名文件、密码及真实设备配置不进入源码或发布包。

全部网络测试使用模拟接口，不会触发实物打印或向真实图床 / AI 发送测试内容。模拟器测试不能代替所有手机厂商系统的验证，实物出纸效果需要使用自己的参数确认。

生成离屏设计预览（Windows 安装字体环境）：

```powershell
$env:GENERATE_PREVIEWS = '1'
flutter test test/app_widget_test.dart
```

## 快捷键

Windows 支持 Ctrl+Enter 发送、Ctrl+O 导入、Ctrl+S 导出。图片与 Markdown / 文本文档可以拖入编辑区。

## 来源与许可

本项目基于 [lemonno2333/WeChat-Printer](https://github.com/lemonno2333/WeChat-Printer) 的协议研究与应用方向，沿用 [MIT License](LICENSE)。本分支以 Dart / Flutter 重新实现纯打印客户端；Flutter 与各依赖保留其自身许可证，可在随构建附带的许可文件及依赖包中查阅。
