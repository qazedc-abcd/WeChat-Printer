import 'dart:convert';
import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../app_controller.dart';
import '../core/image_processing.dart';
import '../core/models.dart';
import 'block_editor.dart';
import 'files.dart';
import 'history_page.dart';
import 'image_dialog.dart';
import 'receipt_preview.dart';
import 'settings_page.dart';
import 'theme.dart';

class PrinterHome extends StatefulWidget {
  const PrinterHome({
    super.key,
    required this.controller,
    this.enableNativeDrop = true,
  });
  final AppController controller;
  final bool enableNativeDrop;
  @override
  State<PrinterHome> createState() => _PrinterHomeState();
}

class _PrinterHomeState extends State<PrinterHome> {
  AppController get app => widget.controller;
  int page = 0;
  bool dragging = false, choosingFiles = false;
  void message(String value) {
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(value)));
    }
  }

  void settings() => setState(() => page = 2);
  Future<void> print() async {
    if (app.sending) return;
    if (!app.settings.device.configured) {
      message('先配置设备 SN 和 SID，再发送打印');
      settings();
      return;
    }
    try {
      final result = await app.print();
      message(result.message);
    } catch (error) {
      message(error is FormatException ? error.message : '内容准备失败，请检查图片图床和网络');
    }
  }

  Future<void> pickImages() async {
    if (choosingFiles) return;
    try {
      final files = await openFiles(
        acceptedTypeGroups: const [
          XTypeGroup(
            label: '图片',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
            mimeTypes: ['image/*'],
          ),
        ],
      );
      await handleFiles(files);
    } catch (_) {
      message('图片选择失败，请重试');
    }
  }

  Future<void> handleFiles(List<XFile> files) async {
    if (choosingFiles || files.isEmpty) return;
    choosingFiles = true;
    try {
      for (final file in files) {
        if (!mounted) break;
        if (app.sending) {
          message('发送完成后再添加图片');
          break;
        }
        final name = file.name.toLowerCase();
        try {
          if (name.endsWith('.md') ||
              name.endsWith('.markdown') ||
              name.endsWith('.txt') ||
              name.endsWith('.json')) {
            await importFile(file);
            continue;
          }
          if (!RegExp(
                r'\.(png|jpe?g|webp|gif)$',
                caseSensitive: false,
              ).hasMatch(name) &&
              !(file.mimeType ?? '').startsWith('image/')) {
            message('支持图片、Markdown、文本和小票 JSON 文件');
            continue;
          }
          if (await file.length() > imageByteLimit) {
            message('${file.name} 超过本地 20 MiB 限制');
            continue;
          }
          final source = await file.readAsBytes();
          if (!mounted) break;
          final result = await showDialog<ImageResult>(
            context: context,
            builder: (_) => ImageEditorDialog(
              source: source,
              controller: app,
              name: file.name,
            ),
          );
          if (result == null) continue;
          final block = ReceiptBlock(
            kind: BlockKind.image,
            imageBytes: result.bytes,
            sourceBytes: result.source,
            name: file.name,
            align: 1,
          );
          if (app.blocks.length == 1 &&
              app.blocks[0].kind == BlockKind.text &&
              app.blocks[0].text.isEmpty) {
            app.blocks.clear();
          }
          app.blocks.add(block);
          app.changed();
          if (app.settings.host.validate().isEmpty) {
            try {
              await app.uploadBlock(block);
            } catch (_) {
              message('图片已保留，上传失败；可在图片卡片中重试');
            }
          }
        } catch (error) {
          message(
            error is FormatException ? error.message : '${file.name} 读取失败',
          );
        }
      }
    } finally {
      choosingFiles = false;
    }
  }

  Future<void> importFile(XFile file) async {
    if (await file.length() > 2 * 1024 * 1024) {
      throw const FormatException('文档请控制在 2 MiB 以内');
    }
    final source = await file.readAsString();
    if (file.name.toLowerCase().endsWith('.json')) {
      final value = jsonDecode(source);
      if (value is! Map) throw const FormatException('小票文档需要是 JSON 对象');
      app.importDocument(Map<String, dynamic>.from(value));
    } else {
      if (app.blocks.length == 1 &&
          app.blocks[0].kind == BlockKind.text &&
          app.blocks[0].text.isEmpty) {
        app.blocks.clear();
      }
      app.add(
        file.name.toLowerCase().endsWith('.txt')
            ? BlockKind.text
            : BlockKind.markdown,
        text: source,
      );
    }
    message('文档已导入');
  }

  Future<void> importDocument() async {
    try {
      final file = await openFile(
        acceptedTypeGroups: const [
          XTypeGroup(
            label: '小票文档',
            extensions: ['md', 'markdown', 'txt', 'json'],
            mimeTypes: ['text/*', 'application/json'],
          ),
        ],
      );
      if (file != null) await importFile(file);
    } catch (error) {
      message(error is FormatException ? error.message : '文档导入失败');
    }
  }

  Future<void> exportDocument() async {
    try {
      final now = DateTime.now();
      final name =
          '小票-${now.year}${now.month.toString().padLeft(2, '0')}${now.day.toString().padLeft(2, '0')}-${now.hour.toString().padLeft(2, '0')}${now.minute.toString().padLeft(2, '0')}.json';
      final okay = await saveUserFile(
        name,
        Uint8List.fromList(
          utf8.encode(
            const JsonEncoder.withIndent('  ').convert(app.exportDocument()),
          ),
        ),
      );
      if (okay) message('小票文档已导出，不包含设备和图床配置');
    } catch (_) {
      message('文档导出失败，请重试');
    }
  }

  Future<void> newDocument() async {
    if (app.blocks.any(
      (block) =>
          block.text.isNotEmpty ||
          block.imageBytes != null ||
          block.url.isNotEmpty ||
          [BlockKind.divider, BlockKind.spacer].contains(block.kind),
    )) {
      final yes = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('新建一张小票？'),
          content: const Text('当前内容会被替换，可以先导出文档保存。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('新建'),
            ),
          ],
        ),
      );
      if (yes != true) return;
    }
    app.newDocument();
  }

  Future<void> requestPreview() async {
    final source = app.requestPreview();
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('打印请求预览'),
        content: SizedBox(
          width: 640,
          child: SingleChildScrollView(
            child: SelectableText(
              source,
              style: const TextStyle(
                fontFamily: 'Consolas',
                fontSize: 12,
                height: 1.6,
              ),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: source));
              message('已复制脱敏请求模板');
            },
            child: const Text('复制模板'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  Future<void> preview() => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .85,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 4, 12, 12),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      '小票预览',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '请求预览',
                    onPressed: requestPreview,
                    icon: const Icon(Icons.data_object_rounded),
                  ),
                  IconButton(
                    tooltip: '关闭预览',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: Center(
                  child: ReceiptPreview(nodes: app.nodes, blocks: app.blocks),
                ),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(24, 0, 24, 20),
              child: Text(
                '预览仅供排版参考，字号与出纸效果以设备为准。',
                style: TextStyle(fontSize: 11),
              ),
            ),
          ],
        ),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final compact = MediaQuery.sizeOf(context).width < 840;
    final pages = [
      composer(compact),
      HistoryPage(controller: app),
      SettingsPage(controller: app),
    ];
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.enter, control: true): () {
          if (page == 0) print();
        },
        const SingleActivator(LogicalKeyboardKey.keyO, control: true):
            importDocument,
        const SingleActivator(LogicalKeyboardKey.keyS, control: true):
            exportDocument,
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          appBar: compact
              ? AppBar(
                  title: const Row(
                    children: [
                      AppMark(size: 34),
                      SizedBox(width: 12),
                      Text(
                        '小票台',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  actions: [
                    IconButton(
                      tooltip: '使用帮助',
                      onPressed: help,
                      icon: const Icon(Icons.help_outline_rounded),
                    ),
                  ],
                )
              : null,
          body: Row(
            children: [
              if (!compact)
                Container(
                  width: 188,
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerLow,
                    border: Border(
                      right: BorderSide(
                        color: scheme.outlineVariant.withValues(alpha: .4),
                      ),
                    ),
                  ),
                  child: Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 30, 20, 32),
                        child: Row(
                          children: [
                            const AppMark(size: 42),
                            const SizedBox(width: 12),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '小票台',
                                  style: Theme.of(context).textTheme.titleLarge
                                      ?.copyWith(fontWeight: FontWeight.w700),
                                ),
                                Text(
                                  'PRINT ONLY',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: 8,
                                    letterSpacing: .6,
                                    color: scheme.onSurfaceVariant,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                      Expanded(
                        child: NavigationRail(
                          extended: true,
                          minExtendedWidth: 188,
                          backgroundColor: Colors.transparent,
                          selectedIndex: page,
                          onDestinationSelected: (value) =>
                              setState(() => page = value),
                          destinations: const [
                            NavigationRailDestination(
                              icon: Icon(Icons.edit_note_rounded),
                              selectedIcon: Icon(Icons.edit_note_rounded),
                              label: Text('打印'),
                            ),
                            NavigationRailDestination(
                              icon: Icon(Icons.history_rounded),
                              label: Text('记录'),
                            ),
                            NavigationRailDestination(
                              icon: Icon(Icons.settings_outlined),
                              selectedIcon: Icon(Icons.settings_rounded),
                              label: Text('设置'),
                            ),
                          ],
                        ),
                      ),
                      TextButton.icon(
                        onPressed: help,
                        icon: const Icon(Icons.help_outline_rounded, size: 18),
                        label: const Text('使用帮助'),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          '简单排版，轻松打印\n草稿自动保存在本机',
                          style: TextStyle(
                            fontSize: 11,
                            color: scheme.onSurfaceVariant,
                            height: 1.8,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              Expanded(
                child: Column(
                  children: [
                    if (app.notice != null)
                      MaterialBanner(
                        content: Text(app.notice!),
                        leading: const Icon(Icons.info_outline_rounded),
                        actions: [
                          TextButton(
                            onPressed: () {
                              app.notice = null;
                              setState(() {});
                            },
                            child: const Text('知道了'),
                          ),
                        ],
                      ),
                    Expanded(
                      child: IndexedStack(index: page, children: pages),
                    ),
                  ],
                ),
              ),
            ],
          ),
          bottomNavigationBar: compact
              ? NavigationBar(
                  selectedIndex: page,
                  onDestinationSelected: (value) =>
                      setState(() => page = value),
                  destinations: const [
                    NavigationDestination(
                      icon: Icon(Icons.edit_note_rounded),
                      label: '打印',
                    ),
                    NavigationDestination(
                      icon: Icon(Icons.history_rounded),
                      label: '记录',
                    ),
                    NavigationDestination(
                      icon: Icon(Icons.settings_outlined),
                      selectedIcon: Icon(Icons.settings_rounded),
                      label: '设置',
                    ),
                  ],
                )
              : null,
        ),
      ),
    );
  }

  Widget composer(bool compact) {
    final scheme = Theme.of(context).colorScheme;
    final editor = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(
            compact ? 20 : 32,
            compact ? 8 : 30,
            compact ? 12 : 24,
            12,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '写下一张小票',
                      style: Theme.of(context).textTheme.headlineMedium
                          ?.copyWith(
                            fontWeight: FontWeight.w700,
                            letterSpacing: -1,
                          ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '一句话、一份清单，或一张喜欢的照片。',
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.6,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              PopupMenuButton<String>(
                tooltip: '文档操作',
                onSelected: (value) {
                  switch (value) {
                    case 'new':
                      newDocument();
                    case 'import':
                      importDocument();
                    case 'export':
                      exportDocument();
                    case 'example':
                      app.example();
                    case 'request':
                      requestPreview();
                  }
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'new', child: Text('新建小票')),
                  PopupMenuItem(value: 'import', child: Text('导入文档')),
                  PopupMenuItem(value: 'export', child: Text('导出文档')),
                  PopupMenuItem(value: 'example', child: Text('载入示例')),
                  PopupMenuItem(value: 'request', child: Text('查看请求')),
                ],
                icon: const Icon(Icons.more_horiz_rounded),
              ),
            ],
          ),
        ),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: compact ? 20 : 32),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              tool(Icons.notes_rounded, '文字', () => app.add(BlockKind.text)),
              tool(
                Icons.description_outlined,
                'Markdown',
                () => app.add(BlockKind.markdown),
              ),
              tool(Icons.image_outlined, '图片', pickImages),
              tool(Icons.qr_code_rounded, '二维码', () => app.add(BlockKind.qr)),
              tool(
                Icons.horizontal_rule_rounded,
                '分隔线',
                () => app.add(BlockKind.divider),
              ),
              tool(
                Icons.space_bar_rounded,
                '空行',
                () => app.add(BlockKind.spacer),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Expanded(
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(
              compact ? 20 : 32,
              8,
              compact ? 20 : 32,
              24,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final (i, block) in app.blocks.indexed)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: BlockEditor(
                      key: ValueKey(block.id),
                      block: block,
                      index: i,
                      controller: app,
                      openSettings: settings,
                    ),
                  ),
                InkWell(
                  onTap: pickImages,
                  borderRadius: BorderRadius.circular(20),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    padding: const EdgeInsets.symmetric(
                      vertical: 22,
                      horizontal: 20,
                    ),
                    decoration: BoxDecoration(
                      color: dragging
                          ? scheme.secondaryContainer
                          : scheme.surfaceContainerLow,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(
                        color: dragging
                            ? scheme.primary
                            : scheme.outlineVariant,
                      ),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          Icons.add_photo_alternate_outlined,
                          color: scheme.primary,
                          size: 28,
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                compact ? '从手机选择图片' : '拖入图片，或点击选择',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w600,
                                  fontSize: 13,
                                ),
                              ),
                              const SizedBox(height: 5),
                              Text(
                                '裁剪或完整留白，处理后自动上传到已配置图床',
                                style: TextStyle(
                                  color: scheme.onSurfaceVariant,
                                  fontSize: 11,
                                  height: 1.6,
                                ),
                              ),
                            ],
                          ),
                        ),
                        Icon(
                          Icons.arrow_forward_rounded,
                          color: scheme.primary,
                          size: 20,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        Container(
          padding: EdgeInsets.fromLTRB(
            compact ? 20 : 32,
            14,
            compact ? 20 : 32,
            18,
          ),
          decoration: BoxDecoration(
            color: scheme.surface,
            border: Border(
              top: BorderSide(
                color: scheme.outlineVariant.withValues(alpha: .6),
              ),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (app.sending)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Row(
                    children: [
                      const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          app.progress,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                ),
              Row(
                children: [
                  Expanded(
                    child: InkWell(
                      onTap: settings,
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Row(
                          children: [
                            Icon(
                              app.settings.device.configured
                                  ? Icons.print_outlined
                                  : Icons.settings_outlined,
                              size: 18,
                              color: scheme.primary,
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                app.settings.device.configured
                                    ? '设备已配置'
                                    : '先连接打印设备',
                                style: TextStyle(
                                  color: scheme.onSurfaceVariant,
                                  fontSize: 12,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  if (compact) ...[
                    OutlinedButton(onPressed: preview, child: const Text('预览')),
                    const SizedBox(width: 10),
                  ],
                  FilledButton.icon(
                    onPressed: app.sending || app.nodes.isEmpty ? null : print,
                    icon: const Icon(Icons.print_rounded, size: 20),
                    label: Text(app.sending ? '发送中…' : '发送打印'),
                  ),
                ],
              ),
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  '请求受理不代表完整出纸，请以小票机实际输出为准。',
                  style: TextStyle(
                    fontSize: 10,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
    Widget area = editor;
    if (widget.enableNativeDrop &&
        defaultTargetPlatform == TargetPlatform.windows) {
      area = DropTarget(
        onDragEntered: (_) => setState(() => dragging = true),
        onDragExited: (_) => setState(() => dragging = false),
        onDragDone: (details) {
          setState(() => dragging = false);
          handleFiles(details.files);
        },
        child: editor,
      );
    }
    return LayoutBuilder(
      builder: (_, constraints) {
        if (compact || constraints.maxWidth < 850) return area;
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: area),
            Container(
              width: 374,
              decoration: BoxDecoration(
                color: scheme.surfaceContainerLow.withValues(alpha: .65),
                border: Border(
                  left: BorderSide(
                    color: scheme.outlineVariant.withValues(alpha: .5),
                  ),
                ),
              ),
              child: Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(28, 28, 16, 10),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            '小票预览',
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(fontWeight: FontWeight.w600),
                          ),
                        ),
                        IconButton(
                          tooltip: '查看请求',
                          onPressed: requestPreview,
                          icon: const Icon(Icons.data_object_rounded, size: 20),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 24),
                    child: Text(
                      '${app.nodes.length} 个打印节点 · 实物字号以设备为准',
                      style: TextStyle(
                        fontSize: 11,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  Expanded(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(28, 4, 28, 32),
                      child: ReceiptPreview(
                        nodes: app.nodes,
                        blocks: app.blocks,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget tool(IconData icon, String label, VoidCallback action) => ActionChip(
    avatar: Icon(icon, size: 17),
    label: Text(label, style: const TextStyle(fontSize: 12)),
    onPressed: app.sending ? null : action,
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
    side: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
  );
  Future<void> help() => showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('开始使用小票台'),
      content: const SingleChildScrollView(
        child: Text(
          '1. 在设置中导入设备 JSON，或填写 SN、SID 和实际 account_type。\n\n2. 配置 R2 / S3 / 自定义图床。图片目录前缀可填写 xiaopiao，并用“上传测试图片”验证直链。\n\n3. 输入文字或 Markdown，添加图片和短二维码，在预览中检查后发送。\n\n图片会转换成方形白底黑白图，原生长图无法保留纵向比例。长内容二维码在实测设备上存在重启风险，本应用按 100 UTF-8 字节做保守保护。\n\nAndroid 和 Windows 可独立运行，无需电脑服务或 FFmpeg。Windows 支持拖入图片与文档；Ctrl+Enter 发送，Ctrl+O 导入，Ctrl+S 导出。\n\n本应用仅提供手动打印，不包含 QQ / Telegram 消息监听。',
          style: TextStyle(height: 1.7),
        ),
      ),
      actions: [
        FilledButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('知道了'),
        ),
      ],
    ),
  );
}
