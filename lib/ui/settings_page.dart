import 'dart:convert';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../app_controller.dart';
import '../core/models.dart';
import 'theme.dart';
import 'paste_text_field.dart';
import 'device_json_dialog.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.controller});
  final AppController controller;
  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final fields = <String, TextEditingController>{};
  final revealed = <String>{};
  late String provider, theme;
  late bool pathStyle, aiEnabled;
  bool saving = false, testing = false;
  @override
  void initState() {
    super.initState();
    load();
  }

  void load() {
    final settings = widget.controller.settings;
    final values = <String, dynamic>{
      ...settings.host.toJson(),
      'sn': settings.device.sn,
      'sid': settings.device.sid,
      'accountType': settings.device.accountType.toString(),
      'aiBaseUrl': settings.ai.baseUrl,
      'aiModel': settings.ai.model,
      'aiApiKey': settings.ai.apiKey,
    };
    for (final entry in values.entries.where(
      (entry) => entry.value is String,
    )) {
      fields.putIfAbsent(entry.key, () => TextEditingController()).text =
          entry.value;
    }
    provider = settings.host.provider;
    pathStyle = settings.host.forcePathStyle;
    aiEnabled = settings.ai.enabled;
    theme = settings.theme;
  }

  @override
  void dispose() {
    for (final field in fields.values) {
      field.dispose();
    }
    super.dispose();
  }

  String value(String key) => fields[key]?.text.trim() ?? '';
  AppSettings draft() => AppSettings(
    device: DeviceSettings(
      sn: value('sn'),
      sid: value('sid'),
      accountType: int.tryParse(value('accountType')) ?? 2,
    ),
    host: HostSettings.fromJson({
      'provider': provider,
      'forcePathStyle': pathStyle,
      for (final key in [
        'endpoint',
        'bucket',
        'region',
        'accessKeyId',
        'secretAccessKey',
        'sessionToken',
        'publicBaseUrl',
        'prefix',
        'uploadUrl',
        'fileField',
        'responseUrlPath',
        'authorization',
      ])
        key: value(key),
    }),
    ai: AiSettings(
      enabled: aiEnabled,
      baseUrl: value('aiBaseUrl'),
      model: value('aiModel'),
      apiKey: value('aiApiKey'),
    ),
    theme: theme,
  );
  void message(String text) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
    }
  }

  Future<void> save() async {
    if (saving) return;
    if (int.tryParse(value('accountType')) == null) {
      message('account_type 需要填写抓包中的整数值');
      return;
    }
    if (value('sn').isEmpty != value('sid').isEmpty) {
      message('设备 SN 和 SID 需要一起填写');
      return;
    }
    final settings = draft();
    final hostConfigured = provider == 'custom'
        ? settings.host.uploadUrl.isNotEmpty
        : settings.host.endpoint.isNotEmpty ||
              settings.host.accessKeyId.isNotEmpty;
    if (hostConfigured && settings.host.validate().isNotEmpty) {
      message(settings.host.validate().join('；'));
      return;
    }
    if (aiEnabled) {
      final url = Uri.tryParse(settings.ai.baseUrl);
      if (settings.ai.model.isEmpty ||
          url == null ||
          !['https', 'http'].contains(url.scheme) ||
          url.host.isEmpty ||
          url.userInfo.isNotEmpty ||
          url.hasQuery ||
          url.hasFragment) {
        message('请填写有效的 AI 基础地址和模型名称');
        return;
      }
    }
    setState(() => saving = true);
    try {
      await widget.controller.saveSettings(settings);
      message('设置已保存到本机');
    } catch (_) {
      message('设置保存失败，请检查系统安全存储是否可用');
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> importFile() async {
    try {
      final file = await openFile(
        acceptedTypeGroups: const [
          XTypeGroup(
            label: 'JSON 配置',
            extensions: ['json'],
            mimeTypes: ['application/json'],
          ),
        ],
      );
      if (file == null) return;
      if (await file.length() > 2 * 1024 * 1024) {
        throw const FormatException('配置文件请控制在 2 MiB 以内');
      }
      await importJson(await file.readAsString());
    } catch (error) {
      message(error is FormatException ? error.message : '配置导入失败，请检查文件内容');
    }
  }

  Future<void> importJson(String source) async {
    final cleaned = source
        .trim()
        .replaceFirst(RegExp(r'^```(?:json)?\s*'), '')
        .replaceFirst(RegExp(r'\s*```$'), '')
        .replaceFirst('\uFEFF', '');
    final decoded = jsonDecode(cleaned);
    if (decoded is! Map) throw const FormatException('配置需要是 JSON 对象');
    final device = DeviceSettings.fromJson(
      Map<String, dynamic>.from(decoded['device'] as Map? ?? decoded),
    );
    if (!device.configured) {
      throw const FormatException('JSON 中未找到完整的设备 SN 与 SID');
    }
    await widget.controller.importSettings(Map<String, dynamic>.from(decoded));
    if (mounted) setState(load);
    message('配置已导入并保存');
  }

  Future<void> pasteJson() async {
    String? clipboard;
    try {
      clipboard = await readClipboardText();
    } catch (_) {
      /* Keep manual entry available. */
    }
    if (!mounted) return;
    final text = await showDialog<String>(
      context: context,
      builder: (context) => DeviceJsonDialog(initialText: clipboard ?? ''),
    );
    if (text == null || text.trim().isEmpty) return;
    try {
      await importJson(text);
    } catch (error) {
      message(error is FormatException ? error.message : 'JSON 配置导入失败');
    }
  }

  Future<void> testUpload() async {
    final host = draft().host;
    if (host.validate().isNotEmpty) {
      message(host.validate().join('；'));
      return;
    }
    setState(() => testing = true);
    try {
      final pixel = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJesAAAAASUVORK5CYII=',
      );
      final url = await widget.controller.uploadImage(
        Uint8List.fromList(pixel),
        host: host,
      );
      final download = await widget.controller.network.image(url);
      if (base64Encode(download) != base64Encode(pixel)) {
        throw const FormatException('上传已完成，但公开直链未返回同一张图片，请检查公开域名');
      }
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          icon: const Icon(Icons.cloud_done_outlined),
          title: const Text('图床连接正常'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('测试图片上传及公开下载均已验证，本次没有调用打印接口。'),
              const SizedBox(height: 16),
              SelectableText(url, style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: url));
              },
              child: const Text('复制直链'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('完成'),
            ),
          ],
        ),
      );
    } catch (error) {
      message(
        error is FormatException ? error.message : '图床测试失败，请检查网络、凭据与公开域名',
      );
    } finally {
      if (mounted) setState(() => testing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 920),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SectionTitle('设置', subtitle: '连接自己的设备和图床，凭据保存在系统安全存储中。'),
              _section(Icons.print_outlined, '打印设备', '手动打印与所有内容块共用这组设备参数。', [
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      onPressed: importFile,
                      icon: const Icon(Icons.file_open_outlined),
                      label: const Text('导入设备 / 旧版配置'),
                    ),
                    TextButton.icon(
                      onPressed: pasteJson,
                      icon: const Icon(Icons.content_paste_rounded),
                      label: const Text('粘贴 JSON'),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                field('sn', '设备 SN', hint: '设备序列号', secret: true),
                field('sid', '设备 SID', hint: '从自己设备的打印请求获取', secret: true),
                field(
                  'accountType',
                  'account_type',
                  hint: '以实际抓包值为准',
                  keyboard: TextInputType.number,
                ),
                Text(
                  'SID 失效后重新抓取并更新。这里不显示在线状态，是否出纸以设备为准。',
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.6,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ]),
              const SizedBox(height: 20),
              _section(
                Icons.cloud_upload_outlined,
                '图片图床',
                '图片先在本机处理成方形白底黑白图，再上传为公开直链。',
                [
                  DropdownButtonFormField<String>(
                    key: ValueKey('host-$provider'),
                    initialValue: provider,
                    decoration: const InputDecoration(labelText: '图床服务'),
                    items: const [
                      DropdownMenuItem(
                        value: 'r2',
                        child: Text('Cloudflare R2'),
                      ),
                      DropdownMenuItem(value: 's3', child: Text('S3 兼容存储')),
                      DropdownMenuItem(
                        value: 'custom',
                        child: Text('自定义 HTTP 图床'),
                      ),
                    ],
                    onChanged: (v) {
                      if (v == null) return;
                      setState(() {
                        provider = v;
                        if (v == 'r2') {
                          fields['region']!.text = 'auto';
                        } else if (value('region') == 'auto') {
                          fields['region']!.text = 'us-east-1';
                        }
                      });
                    },
                  ),
                  const SizedBox(height: 16),
                  if (provider != 'custom') ...[
                    field(
                      'endpoint',
                      'S3 API Endpoint',
                      hint: 'https://账户ID.r2.cloudflarestorage.com',
                      keyboard: TextInputType.url,
                    ),
                    _pair(
                      field('bucket', 'Bucket', hint: 'photo-bed'),
                      field(
                        'region',
                        'Region',
                        hint: provider == 'r2' ? 'auto' : 'us-east-1',
                      ),
                    ),
                    field('accessKeyId', 'Access Key ID', secret: true),
                    field('secretAccessKey', 'Secret Access Key', secret: true),
                    field(
                      'publicBaseUrl',
                      '公开访问地址',
                      hint: 'https://img.example.com',
                      keyboard: TextInputType.url,
                    ),
                    field(
                      'prefix',
                      '图片目录前缀',
                      hint: 'xiaopiao',
                      helper: '图片按“前缀 / 年 / 月 / 日 / 文件名”保存。',
                    ),
                    ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      title: const Text('高级设置'),
                      children: [
                        SwitchListTile.adaptive(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('路径式寻址'),
                          subtitle: const Text('R2 / MinIO 通常启用'),
                          value: pathStyle,
                          onChanged: (v) => setState(() => pathStyle = v),
                        ),
                        field(
                          'sessionToken',
                          'Session Token（可选）',
                          secret: true,
                          helper: '仅临时 S3 凭据需要，不是 Cloudflare 管理 API 令牌。',
                        ),
                      ],
                    ),
                    if (provider == 'r2')
                      ExpansionTile(
                        tilePadding: EdgeInsets.zero,
                        title: const Text('R2 怎么填写？'),
                        children: const [
                          Padding(
                            padding: EdgeInsets.only(bottom: 16),
                            child: Text(
                              '1. 创建桶并开启公开域名。\n2. 创建仅针对该桶的对象读写凭据。\n3. Endpoint 填 S3 地址，Region 填 auto。\n4. 公开访问地址填图片域名，不是 Endpoint。\n5. 前缀可填 xiaopiao，再点击上传测试图片。',
                              style: TextStyle(height: 1.8),
                            ),
                          ),
                        ],
                      ),
                  ] else ...[
                    field(
                      'uploadUrl',
                      '上传接口',
                      hint: 'https://img.example.com/upload',
                      keyboard: TextInputType.url,
                    ),
                    _pair(
                      field('fileField', '文件字段名', hint: 'file'),
                      field('responseUrlPath', '响应 URL 路径', hint: 'data.url'),
                    ),
                    field(
                      'authorization',
                      'Authorization（可选）',
                      hint: 'Bearer 你的令牌',
                      secret: true,
                    ),
                    const Text(
                      '使用 multipart/form-data POST 上传，返回 JSON 中的 URL 必须可公开下载。',
                      style: TextStyle(fontSize: 12, height: 1.6),
                    ),
                  ],
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton.icon(
                      onPressed: testing ? null : testUpload,
                      icon: testing
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.cloud_done_outlined),
                      label: Text(testing ? '正在验证…' : '上传测试图片'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              _section(
                Icons.auto_awesome_outlined,
                '可选 AI 检查',
                'Markdown 基础检查在本机完成。只有手动点击 AI 检查，才发送当前正文。',
                [
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('启用 AI 检查'),
                    value: aiEnabled,
                    onChanged: (value) => setState(() => aiEnabled = value),
                  ),
                  if (aiEnabled) ...[
                    field(
                      'aiBaseUrl',
                      '兼容 OpenAI 的基础地址',
                      hint: 'https://api.example.com/v1',
                      keyboard: TextInputType.url,
                    ),
                    field('aiModel', '模型名称'),
                    field('aiApiKey', 'API Key（本地无鉴权时可留空）', secret: true),
                  ],
                ],
              ),
              const SizedBox(height: 20),
              _section(
                Icons.palette_outlined,
                '外观',
                '手机与桌面使用一致的 Material Design 3。',
                [
                  DropdownButtonFormField<String>(
                    key: ValueKey('theme-$theme'),
                    initialValue: theme,
                    decoration: const InputDecoration(labelText: '颜色模式'),
                    items: const [
                      DropdownMenuItem(value: 'system', child: Text('跟随系统')),
                      DropdownMenuItem(value: 'light', child: Text('浅色')),
                      DropdownMenuItem(value: 'dark', child: Text('深色')),
                    ],
                    onChanged: (value) =>
                        setState(() => theme = value ?? 'system'),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton.icon(
                  onPressed: saving ? null : save,
                  icon: const Icon(Icons.check_rounded),
                  label: Text(saving ? '保存中…' : '保存设置'),
                ),
              ),
              const SizedBox(height: 24),
              Text(
                '小票台 · Print Only 0.1.1\n本地草稿和记录可随时导出或清除。图片公开访问与设备出纸需要分别确认。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  height: 1.8,
                  color: scheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }

  Widget field(
    String key,
    String label, {
    String? hint,
    String? helper,
    bool secret = false,
    TextInputType? keyboard,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: PasteTextField(
      controller: fields[key]!,
      pasteReplacesAll: true,
      pasteTooltip: '粘贴$label',
      obscureText: secret && !revealed.contains(key),
      keyboardType: keyboard,
      autocorrect: !secret,
      enableSuggestions: !secret,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        helperText: helper,
        helperMaxLines: 3,
        suffixIcon: secret
            ? IconButton(
                tooltip: revealed.contains(key) ? '隐藏' : '显示',
                onPressed: () => setState(() {
                  if (!revealed.remove(key)) revealed.add(key);
                }),
                icon: Icon(
                  revealed.contains(key)
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                ),
              )
            : null,
      ),
    ),
  );
  Widget _pair(Widget first, Widget second) => LayoutBuilder(
    builder: (_, constraints) => constraints.maxWidth < 520
        ? Column(children: [first, second])
        : Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: first),
              const SizedBox(width: 16),
              Expanded(child: second),
            ],
          ),
  );
  Widget _section(
    IconData icon,
    String title,
    String subtitle,
    List<Widget> children,
  ) => Card(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(icon, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 12),
              Text(
                title,
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            subtitle,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 12,
              height: 1.6,
            ),
          ),
          const SizedBox(height: 22),
          ...children,
        ],
      ),
    ),
  );
}
