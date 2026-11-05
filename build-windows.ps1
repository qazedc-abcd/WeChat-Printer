param([string]$Output = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $nodeExe -p 'process.version').Trim()
$nodeArch = (& $nodeExe -p 'process.arch').Trim()
$nodeMajor = [int](& $nodeExe -p 'process.versions.node.split(".")[0]')
if ($nodeArch -ne 'x64' -or $nodeMajor -lt 22) { throw 'An x64 Node.js 22+ runtime is required.' }
$commit = (& git -C $PSScriptRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Build from a Git checkout.' }
$packageName = 'WeChat-Printer-OneBot11-windows-x64-v1.1.0'
$package = Join-Path $Output $packageName
if (Test-Path -LiteralPath $package) { throw "Output already exists: $package. Choose a fresh Output directory." }
$app = New-Item -ItemType Directory -Path (Join-Path $package 'app') -Force
$runtime = New-Item -ItemType Directory -Path (Join-Path $package 'runtime') -Force
$checksumsUrl = "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt"
$checksums = (Invoke-WebRequest -Uri $checksumsUrl).Content
$match = [regex]::Match($checksums, '(?m)^([a-f0-9]{64})  win-x64/node\.exe\r?$')
$nodeHash = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
if (!$match.Success -or $nodeHash -ne $match.Groups[1].Value) { throw 'Runtime does not match the official Node.js Windows x64 checksum.' }
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $runtime 'node.exe')
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $runtime 'LICENSE.txt')
$checksums | Set-Content -LiteralPath (Join-Path $runtime 'SHASUMS256.txt') -Encoding utf8NoBOM
$files = & git -C $PSScriptRoot ls-files
if ($LASTEXITCODE -ne 0) { throw 'Source file listing failed.' }
foreach ($file in $files) {
    $destination = Join-Path $app $file
    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $destination
}
@'
@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0app\start-local.js"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $package 'start-local.bat') -Encoding ascii
@'
@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0app\server.js"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $package 'start-server.bat') -Encoding ascii
@"
WeChat Printer — OneBot v11 / QQ 免安装版

完整解压后双击根目录 start-local.bat，浏览器会打开 http://127.0.0.1:4180。
本包自带 Node.js $nodeVersion x64，无需另装 Node.js 或 npm。

先填写设备 SN、SID、account_type，或从 SID 助手导出的设备 JSON 导入。
在“消息监听”填写本地 OneBot v11 正向 WebSocket，例如 ws://127.0.0.1:3001。
服务端未配置鉴权时访问令牌留空。点击开始后才会接收并打印 QQ 私聊文字和图片。
群聊、机器人自己发送的消息和心跳不会打印。

图片处理需另外安装 FFmpeg，或设置 WECHAT_PRINTER_FFMPEG 为其完整路径。本包未含 FFmpeg。
本地图片可拖拽或粘贴，裁剪完成后自动上传；图床支持 R2、S3 兼容服务与自定义 HTTP 接口。
R2 / S3 逐步教程见 app\docs\R2-S3-SETUP.md。
Markdown 自动识别与本地检查无需 AI；可选 AI 检查使用兼容 OpenAI 的接口，需手动点击并应用建议。
Markdown 使用说明见 app\docs\MARKDOWN.md。
源码和完整使用说明在 app 目录；本地配置与消息管理文件也保存在 app 目录。
默认浏览器配置只保存在当前浏览器。切换本地保存后将写入 app\config.json。
SID 会过期，失效后重新获取。本包不含任何真实设备、QQ 配置、令牌或聊天记录。

只启动服务而不打开浏览器时，双击 start-server.bat。按 Ctrl+C 结束服务。
若原 4173 端口的版本仍在运行，本版默认使用独立的 4180 端口。

MIT License；原项目 https://github.com/lemonno2333/WeChat-Printer
本仓库 https://github.com/qazedc-abcd/WeChat-Printer
构建提交 $commit
"@ | Set-Content -LiteralPath (Join-Path $package '使用说明.txt') -Encoding utf8BOM
@{
    name = 'WeChat Printer OneBot11'
    version = 'onebot-v1.1.0'
    commit = $commit
    sourceRepository = 'https://github.com/qazedc-abcd/WeChat-Printer'
    sourceBranch = 'main'
    upstreamRepository = 'https://github.com/lemonno2333/WeChat-Printer'
    platform = 'windows-x64'
    nodeVersion = $nodeVersion
    nodeSha256 = $nodeHash
    nodeChecksumSource = $checksumsUrl
    optionalDependenciesNotBundled = @('ffmpeg')
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $package 'build-info.json') -Encoding utf8NoBOM
$archive = Join-Path $Output "$packageName.zip"
Compress-Archive -LiteralPath $package -DestinationPath $archive -CompressionLevel Optimal
$sourceArchive = Join-Path $Output 'WeChat-Printer-OneBot11-source-v1.1.0.zip'
& git -C $PSScriptRoot archive --format=zip --prefix=WeChat-Printer-OneBot11/ --output=$sourceArchive HEAD
if ($LASTEXITCODE -ne 0) { throw 'Source ZIP creation failed.' }
$hashes = foreach ($archivePath in @($archive, $sourceArchive)) {
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $(Split-Path $archivePath -Leaf)"
}
$hashes | Set-Content -LiteralPath (Join-Path $Output 'SHA256SUMS.txt') -Encoding ascii
Get-Item -LiteralPath $archive, $sourceArchive | Select-Object FullName, Length
