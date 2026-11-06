import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../core/models.dart';
import '../core/receipt_compiler.dart';

class ReceiptPreview extends StatelessWidget {
  const ReceiptPreview({
    super.key,
    required this.nodes,
    this.blocks = const [],
  });
  final List<PrinterNode> nodes;
  final List<ReceiptBlock> blocks;
  Uint8List? localImage(String source) {
    for (final block in blocks) {
      if (block.imageBytes != null && block.url == source) {
        return block.imageBytes;
      }
    }
    if (!source.startsWith('local-image://')) return null;
    final id = source.substring('local-image://'.length);
    for (final block in blocks) {
      if (block.id == id) return block.imageBytes;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    const ink = Color(0xff303430);
    return Semantics(
      label: '小票内容预览，实物效果以设备为准',
      child: Container(
        width: 304,
        decoration: BoxDecoration(
          color: const Color(0xfffffefa),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: .07),
              blurRadius: 28,
              offset: const Offset(0, 10),
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const _PaperEdge(),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 22, 22, 30),
              child: DefaultTextStyle(
                style: const TextStyle(
                  fontFamily: 'Microsoft YaHei',
                  fontSize: 12,
                  height: 1.7,
                  color: ink,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: nodes.isEmpty
                      ? [
                          const SizedBox(height: 32),
                          const Icon(
                            Icons.receipt_outlined,
                            size: 38,
                            color: Color(0xffb1bab0),
                          ),
                          const SizedBox(height: 16),
                          const Text(
                            '下一张小票\n从这里开始',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: Color(0xff8a958a),
                              height: 1.9,
                            ),
                          ),
                          const SizedBox(height: 48),
                        ]
                      : nodes.map((node) {
                          if (node.containsKey('divider')) {
                            return const Padding(
                              padding: EdgeInsets.symmetric(vertical: 8),
                              child: Divider(
                                height: 1,
                                color: Color(0xff454b44),
                                thickness: 1,
                              ),
                            );
                          }
                          if (node.containsKey('text')) {
                            return const SizedBox(height: 22);
                          }
                          final icon = node['icon'];
                          if (icon != null) {
                            final source = icon['value'] as String;
                            final align =
                                icon['style']?['justification'] as int? ?? 1;
                            Widget image;
                            if (icon['type'] == 1) {
                              image =
                                  utf8.encode(source).length > nativeQrMaxBytes
                                  ? const Padding(
                                      padding: EdgeInsets.all(12),
                                      child: Text(
                                        '二维码内容过长，请缩短后打印',
                                        style: TextStyle(
                                          color: Color(0xffba1a1a),
                                        ),
                                      ),
                                    )
                                  : QrImageView(
                                      data: source,
                                      size: 100,
                                      padding: const EdgeInsets.all(4),
                                      backgroundColor: Colors.white,
                                    );
                            } else {
                              final bytes = localImage(source);
                              final placeholder = Container(
                                height: 180,
                                color: const Color(0xfff1f3ed),
                                alignment: Alignment.center,
                                child: const Icon(
                                  Icons.image_outlined,
                                  color: Color(0xff8a958a),
                                  size: 36,
                                ),
                              );
                              image = bytes != null
                                  ? Image.memory(
                                      bytes,
                                      width: 250,
                                      height: 250,
                                      fit: BoxFit.contain,
                                      gaplessPlayback: true,
                                    )
                                  : publicImageUrl(source)
                                  ? Image.network(
                                      source,
                                      width: 250,
                                      height: 250,
                                      fit: BoxFit.contain,
                                      loadingBuilder: (_, child, progress) =>
                                          progress == null
                                          ? child
                                          : placeholder,
                                      errorBuilder: (_, _, _) => placeholder,
                                    )
                                  : placeholder;
                            }
                            return Padding(
                              padding: const EdgeInsets.symmetric(vertical: 8),
                              child: Align(
                                alignment: align == 0
                                    ? Alignment.centerLeft
                                    : align == 2
                                    ? Alignment.centerRight
                                    : Alignment.center,
                                child: image,
                              ),
                            );
                          }
                          final content = node['content'];
                          if (content == null) return const SizedBox.shrink();
                          final columns =
                              (content['lines']['linelist'][0]['column']
                                      as List)
                                  .cast<String>();
                          final aligns = content['column_align'] as List;
                          return Padding(
                            padding: const EdgeInsets.symmetric(vertical: 3),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: List.generate(
                                columns.length,
                                (i) => Expanded(
                                  flex: aligns[i]['column_width'] as int? ?? 1,
                                  child: _PaperText(
                                    text: columns[i],
                                    height:
                                        content['style']?['height'] as int? ??
                                        0,
                                    width:
                                        content['style']?['width'] as int? ?? 0,
                                    textAlign:
                                        switch (aligns[i]['style']?['justification'] ??
                                        content['style']?['justification']) {
                                          1 => TextAlign.center,
                                          2 => TextAlign.right,
                                          _ => TextAlign.left,
                                        },
                                  ),
                                ),
                              ),
                            ),
                          );
                        }).toList(),
                ),
              ),
            ),
            const _PaperEdge(bottom: true),
          ],
        ),
      ),
    );
  }
}

class _PaperText extends StatelessWidget {
  const _PaperText({
    required this.text,
    required this.height,
    required this.width,
    required this.textAlign,
  });
  final String text;
  final int height, width;
  final TextAlign textAlign;

  @override
  Widget build(BuildContext context) {
    if (width == 0 && height == 0) return Text(text, textAlign: textAlign);
    final fontSize = DefaultTextStyle.of(context).style.fontSize ?? 12;
    final xScale = (1 + width) / (1 + height);
    // Lay out with the printed glyph width before stretching its height.
    return FractionallySizedBox(
      widthFactor: 1 / xScale,
      alignment: Alignment.topLeft,
      child: Transform.scale(
        alignment: Alignment.topLeft,
        scaleX: xScale,
        child: Text(
          text,
          textAlign: textAlign,
          style: TextStyle(fontSize: fontSize * (1 + height)),
        ),
      ),
    );
  }
}

class _PaperEdge extends StatelessWidget {
  const _PaperEdge({this.bottom = false});
  final bool bottom;
  @override
  Widget build(BuildContext context) => SizedBox(
    height: 8,
    child: CustomPaint(size: const Size(304, 8), painter: _EdgePainter(bottom)),
  );
}

class _EdgePainter extends CustomPainter {
  _EdgePainter(this.bottom);
  final bool bottom;
  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()..moveTo(0, bottom ? 0 : 8);
    for (var x = 0.0; x < size.width; x += 12) {
      path.lineTo(x + 6, bottom ? 8 : 0);
      path.lineTo(x + 12, bottom ? 0 : 8);
    }
    path
      ..lineTo(size.width, bottom ? 0 : 8)
      ..close();
    canvas.drawPath(path, Paint()..color = const Color(0xfffffefa));
  }

  @override
  bool shouldRepaint(_EdgePainter oldDelegate) => oldDelegate.bottom != bottom;
}
