import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../app_controller.dart';
import '../core/models.dart';
import '../core/receipt_compiler.dart';
import 'image_dialog.dart';

class BlockEditor extends StatefulWidget {
  const BlockEditor({
    super.key,
    required this.block,
    required this.index,
    required this.controller,
    required this.openSettings,
  });
  final ReceiptBlock block;
  final int index;
  final AppController controller;
  final VoidCallback openSettings;
  @override
  State<BlockEditor> createState() => _BlockEditorState();
}

class _BlockEditorState extends State<BlockEditor> {
  late final TextEditingController text;
  Timer? timer;
  List<MarkdownIssue> issues = [];
  bool aiBusy = false;
  ReceiptBlock get block => widget.block;
  AppController get app => widget.controller;
  @override
  void initState() {
    super.initState();
    text = TextEditingController(
      text: block.kind == BlockKind.image ? block.url : block.text,
    );
    check();
  }

  @override
  void didUpdateWidget(BlockEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    final value = block.kind == BlockKind.image ? block.url : block.text;
    if (text.text != value) {
      text.value = TextEditingValue(
        text: value,
        selection: TextSelection.collapsed(offset: value.length),
      );
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    text.dispose();
    super.dispose();
  }

  bool get markdown =>
      block.kind == BlockKind.markdown ||
      block.kind == BlockKind.text &&
          block.autoMarkdown &&
          app.compiler.detectsMarkdown(block.text);
  void check() {
    issues = markdown ? app.compiler.lint(block.text) : [];
  }

  void changed(String value) {
    if (block.kind == BlockKind.image) {
      block.url = value;
      block.imageBytes = null;
      block.sourceBytes = null;
    } else {
      block.text = value;
    }
    app.changed();
    timer?.cancel();
    timer = Timer(const Duration(milliseconds: 250), () {
      if (mounted) setState(check);
    });
  }

  void message(String value) {
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(value)));
    }
  }

  Future<void> aiCheck() async {
    if (!app.settings.ai.enabled || app.settings.ai.model.isEmpty) {
      message('先在设置中启用 AI 检查并填写模型');
      widget.openSettings();
      return;
    }
    final source = block.text;
    setState(() => aiBusy = true);
    try {
      final result = await app.checkAi(source);
      if (!mounted) return;
      final apply = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('AI 检查建议'),
          content: SizedBox(
            width: 600,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    result.summary,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 16),
                  for (final issue in result.issues)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(issue),
                    ),
                  const Divider(),
                  const Text(
                    '建议全文',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 12),
                  SelectableText(result.revised),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('保留原文'),
            ),
            FilledButton(
              onPressed: block.text == source
                  ? () => Navigator.pop(context, true)
                  : null,
              child: const Text('应用建议'),
            ),
          ],
        ),
      );
      if (apply == true && mounted && block.text == source) {
        block.text = result.revised;
        text.text = block.text;
        app.changed();
        setState(check);
      }
    } catch (error) {
      message(error is FormatException ? error.message : 'AI 检查失败，原文已保留');
    } finally {
      if (mounted) setState(() => aiBusy = false);
    }
  }

  Future<void> editImage() async {
    final source = block.sourceBytes ?? block.imageBytes;
    if (source == null) {
      message('从文件导入图片后可以调整裁剪与色调');
      return;
    }
    final result = await showDialog<ImageResult>(
      context: context,
      builder: (_) =>
          ImageEditorDialog(source: source, controller: app, name: block.name),
    );
    if (result == null || !mounted) return;
    block.imageBytes = result.bytes;
    block.sourceBytes = result.source;
    block.url = '';
    app.changed();
    if (app.settings.host.validate().isEmpty) await upload();
  }

  Future<void> upload() async {
    try {
      await app.uploadBlock(block);
      message('图片已上传到当前图床');
    } catch (error) {
      message(
        error is FormatException
            ? '${error.message}；图片已保留，可重试'
            : '图片上传失败，处理结果已保留，可重试',
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final labels = {
      BlockKind.text: '文字',
      BlockKind.markdown: 'Markdown',
      BlockKind.image: '图片',
      BlockKind.qr: '二维码',
      BlockKind.divider: '分隔线',
      BlockKind.spacer: '空白行',
    };
    final icons = {
      BlockKind.text: Icons.notes_rounded,
      BlockKind.markdown: Icons.description_outlined,
      BlockKind.image: Icons.image_outlined,
      BlockKind.qr: Icons.qr_code_rounded,
      BlockKind.divider: Icons.horizontal_rule_rounded,
      BlockKind.spacer: Icons.space_bar_rounded,
    };
    final bytes = utf8.encode(block.text.trim()).length;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: scheme.secondaryContainer.withValues(alpha: .6),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    icons[block.kind],
                    size: 18,
                    color: scheme.onSecondaryContainer,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    '${labels[block.kind]}  ${widget.index + 1}',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                IconButton(
                  tooltip: '上移',
                  visualDensity: VisualDensity.compact,
                  onPressed: widget.index == 0
                      ? null
                      : () => app.move(block, -1),
                  icon: const Icon(Icons.arrow_upward_rounded, size: 18),
                ),
                IconButton(
                  tooltip: '下移',
                  visualDensity: VisualDensity.compact,
                  onPressed: widget.index == app.blocks.length - 1
                      ? null
                      : () => app.move(block, 1),
                  icon: const Icon(Icons.arrow_downward_rounded, size: 18),
                ),
                IconButton(
                  tooltip: '删除内容',
                  visualDensity: VisualDensity.compact,
                  onPressed: () => app.remove(block),
                  icon: const Icon(Icons.close_rounded, size: 19),
                ),
              ],
            ),
            const SizedBox(height: 16),
            if ([
              BlockKind.text,
              BlockKind.markdown,
              BlockKind.qr,
            ].contains(block.kind))
              TextField(
                controller: text,
                minLines: block.kind == BlockKind.qr ? 2 : 4,
                maxLines: 18,
                onChanged: changed,
                decoration: InputDecoration(
                  hintText: block.kind == BlockKind.qr
                      ? '输入网址或简短文字'
                      : block.kind == BlockKind.markdown
                      ? '# 标题\n\n写一份清单，或粘贴 Markdown…'
                      : '写下想打印的内容…\n也能自动识别 Markdown。',
                  errorText:
                      block.kind == BlockKind.qr && bytes > nativeQrMaxBytes
                      ? '超过 100 UTF-8 字节，请缩短；不会自动截断'
                      : null,
                  counterText: block.kind == BlockKind.qr
                      ? '$bytes / $nativeQrMaxBytes UTF-8 字节'
                      : '${block.text.runes.length} 字符',
                ),
                style: TextStyle(
                  fontSize: 14,
                  height: 1.8,
                  fontFamily: block.kind == BlockKind.markdown
                      ? 'Consolas'
                      : null,
                  fontFamilyFallback: const [
                    'Microsoft YaHei',
                    'Noto Sans CJK SC',
                    'sans-serif',
                  ],
                ),
              ),
            if (block.kind == BlockKind.text &&
                app.compiler.detectsMarkdown(block.text))
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 8,
                  children: [
                    Icon(
                      block.autoMarkdown
                          ? Icons.check_circle_outline_rounded
                          : Icons.text_fields_rounded,
                      size: 17,
                      color: scheme.primary,
                    ),
                    Text(
                      block.autoMarkdown ? '已自动识别 Markdown' : '按原文打印',
                      style: TextStyle(fontSize: 12, color: scheme.primary),
                    ),
                    TextButton(
                      onPressed: () {
                        block.autoMarkdown = !block.autoMarkdown;
                        app.changed();
                        setState(check);
                      },
                      child: Text(block.autoMarkdown ? '保留原文' : '启用排版'),
                    ),
                  ],
                ),
              ),
            if (markdown) ...[
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Icon(
                    issues.any((issue) => issue.error)
                        ? Icons.error_outline_rounded
                        : Icons.check_circle_outline_rounded,
                    size: 17,
                    color: issues.any((issue) => issue.error)
                        ? scheme.error
                        : scheme.primary,
                  ),
                  Text(
                    issues.isEmpty ? '本地检查未发现排版问题' : '${issues.length} 条排版提示',
                    style: TextStyle(
                      fontSize: 12,
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                  TextButton.icon(
                    onPressed: aiBusy ? null : aiCheck,
                    icon: const Icon(Icons.auto_awesome_outlined, size: 16),
                    label: Text(aiBusy ? '检查中…' : 'AI 检查'),
                  ),
                ],
              ),
              for (final issue in issues.take(5))
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    '第 ${issue.line} 行 · ${issue.message}',
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.6,
                      color: issue.error
                          ? scheme.error
                          : scheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
            if (block.kind == BlockKind.image) ...[
              if (block.imageBytes != null)
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.memory(
                        block.imageBytes!,
                        width: 104,
                        height: 104,
                        fit: BoxFit.contain,
                        colorBlendMode: BlendMode.srcOver,
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            block.name.isEmpty ? '打印图片' : block.name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w500),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            '方形白底 · 黑白打印',
                            style: TextStyle(
                              fontSize: 12,
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 4,
                            children: [
                              TextButton.icon(
                                onPressed: editImage,
                                icon: const Icon(Icons.tune_rounded, size: 16),
                                label: const Text('调整'),
                              ),
                              TextButton(
                                onPressed:
                                    app.uploadingImages.contains(block.id)
                                    ? null
                                    : upload,
                                child: Text(
                                  app.uploadingImages.contains(block.id)
                                      ? '上传中…'
                                      : block.url.isEmpty
                                      ? '上传'
                                      : '重新上传',
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                )
              else
                TextField(
                  controller: text,
                  onChanged: changed,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(
                    labelText: '图片直链',
                    hintText: 'https://images.example.com/photo.jpg',
                    helperText: '发送前会自动合成白底并转换格式。',
                    helperMaxLines: 2,
                  ),
                ),
              if (block.url.isNotEmpty && block.imageBytes != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Row(
                    children: [
                      Icon(
                        Icons.cloud_done_outlined,
                        color: scheme.primary,
                        size: 16,
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          '已上传到图床',
                          style: TextStyle(color: scheme.primary, fontSize: 12),
                        ),
                      ),
                      TextButton(
                        onPressed: () {
                          Clipboard.setData(
                            ClipboardData(text: '![图片](${block.url})'),
                          );
                          message('已复制 Markdown 图片链接');
                        },
                        child: const Text('复制链接'),
                      ),
                    ],
                  ),
                ),
            ],
            if (block.kind == BlockKind.divider)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Divider(thickness: 1),
              ),
            if (block.kind == BlockKind.spacer)
              Text(
                '输出一行空白，为内容留一点呼吸。',
                style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13),
              ),
            if (block.kind == BlockKind.qr)
              Text(
                '内容按 UTF-8 字节计数，中文通常占 3 字节。',
                style: TextStyle(
                  color: scheme.onSurfaceVariant,
                  fontSize: 12,
                  height: 1.6,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
