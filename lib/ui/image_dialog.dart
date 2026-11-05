import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import '../app_controller.dart';

class ImageResult {
  const ImageResult(this.bytes, this.source);
  final Uint8List bytes, source;
}

class ImageEditorDialog extends StatefulWidget {
  const ImageEditorDialog({
    super.key,
    required this.source,
    required this.controller,
    required this.name,
  });
  final Uint8List source;
  final AppController controller;
  final String name;
  @override
  State<ImageEditorDialog> createState() => _ImageEditorDialogState();
}

class _ImageEditorDialogState extends State<ImageEditorDialog> {
  String fit = 'contain';
  double gamma = 1, contrast = 0, zoom = 1, x = 0, y = 0;
  bool dither = true, busy = true;
  Uint8List? preview;
  String? error;
  Timer? timer;
  int revision = 0;
  @override
  void initState() {
    super.initState();
    process();
  }

  @override
  void dispose() {
    timer?.cancel();
    revision++;
    super.dispose();
  }

  void schedule() {
    timer?.cancel();
    setState(() => busy = true);
    timer = Timer(const Duration(milliseconds: 200), process);
  }

  Future<void> process() async {
    final token = ++revision;
    try {
      final bytes = await widget.controller.process(widget.source, {
        'fit': fit,
        'gamma': gamma,
        'contrast': contrast,
        'zoom': zoom,
        'x': x,
        'y': y,
        'dither': dither,
      });
      if (!mounted || token != revision) return;
      setState(() {
        preview = bytes;
        busy = false;
        error = null;
      });
    } catch (e) {
      if (!mounted || token != revision) return;
      setState(() {
        busy = false;
        error = e is FormatException ? e.message : '图片处理失败，请换一张图片重试';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620, maxHeight: 820),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.tune_rounded),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Text(
                      '调整打印图片',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
              Text(
                widget.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 16),
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 280),
                          child: AspectRatio(
                            aspectRatio: 1,
                            child: Stack(
                              fit: StackFit.expand,
                              children: [
                                Container(
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    border: Border.all(
                                      color: scheme.outlineVariant,
                                    ),
                                  ),
                                  child: preview != null
                                      ? Image.memory(
                                          preview!,
                                          fit: BoxFit.contain,
                                          gaplessPlayback: true,
                                        )
                                      : const SizedBox(),
                                ),
                                if (busy)
                                  Container(
                                    color: Colors.white.withValues(alpha: .55),
                                    alignment: Alignment.center,
                                    child: const CircularProgressIndicator(),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      SegmentedButton<String>(
                        segments: const [
                          ButtonSegment(
                            value: 'contain',
                            label: Text('完整留白'),
                            icon: Icon(Icons.fit_screen_rounded),
                          ),
                          ButtonSegment(
                            value: 'crop',
                            label: Text('方形裁剪'),
                            icon: Icon(Icons.crop_square_rounded),
                          ),
                        ],
                        selected: {fit},
                        onSelectionChanged: (value) {
                          fit = value.first;
                          schedule();
                        },
                      ),
                      const SizedBox(height: 8),
                      Text(
                        fit == 'contain'
                            ? '保持原图比例，四周填入纸白。长图会缩小，细节可能看不清。'
                            : '选择要保留的方形区域，图片不会被拉伸。',
                        style: TextStyle(
                          color: scheme.onSurfaceVariant,
                          fontSize: 12,
                          height: 1.5,
                        ),
                      ),
                      if (fit == 'crop') ...[
                        _slider('放大', zoom, 1, 4, (v) {
                          zoom = v;
                          schedule();
                        }),
                        _slider('水平位置', x, -1, 1, (v) {
                          x = v;
                          schedule();
                        }),
                        _slider('垂直位置', y, -1, 1, (v) {
                          y = v;
                          schedule();
                        }),
                      ],
                      _slider('亮度', gamma, .3, 3, (v) {
                        gamma = v;
                        schedule();
                      }),
                      _slider('对比度', contrast, -100, 100, (v) {
                        contrast = v;
                        schedule();
                      }),
                      SwitchListTile.adaptive(
                        contentPadding: EdgeInsets.zero,
                        title: const Text('保留灰阶层次'),
                        subtitle: const Text('通过黑白抖动呈现明暗，透明区域合成白底'),
                        value: dither,
                        onChanged: (v) {
                          dither = v;
                          schedule();
                        },
                      ),
                      if (error != null)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Text(
                            error!,
                            style: TextStyle(color: scheme.error),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 12),
                  FilledButton.icon(
                    onPressed: busy || preview == null || error != null
                        ? null
                        : () => Navigator.pop(
                            context,
                            ImageResult(preview!, widget.source),
                          ),
                    icon: const Icon(Icons.check_rounded),
                    label: const Text('使用图片'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _slider(
    String label,
    double value,
    double min,
    double max,
    ValueChanged<double> change,
  ) => Row(
    children: [
      SizedBox(
        width: 72,
        child: Text(label, style: const TextStyle(fontSize: 13)),
      ),
      Expanded(
        child: Slider(value: value, min: min, max: max, onChanged: change),
      ),
    ],
  );
}
