import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:wechat_printer_print_only/app_controller.dart';
import 'package:wechat_printer_print_only/core/models.dart';
import 'package:wechat_printer_print_only/core/network.dart';
import 'package:wechat_printer_print_only/core/storage.dart';
import 'package:wechat_printer_print_only/printer_app.dart';

Future<AppController> fixture({
  bool sample = false,
  String theme = 'light',
}) async {
  final store = MemoryStore()..settings = AppSettings(theme: theme);
  final controller = AppController(
    store: store,
    network: Network(
      client: MockClient(
        (_) async =>
            throw StateError('No network calls allowed in layout tests'),
      ),
    ),
  );
  await controller.initialize();
  if (sample) {
    controller.blocks = [
      ReceiptBlock(
        kind: BlockKind.markdown,
        text:
            '# 今日清单\n\n把想做的事，写在一张小票上。\n\n- 喝一杯喜欢的咖啡\n- 读完手边的书\n\n---\n\n| 项目 | 数量 |\n| --- | ---: |\n| 热拿铁 | 1 |\n| 好心情 | 无限 |\n\n> 给生活留一点温柔。',
      ),
    ];
    controller.changed();
  }
  return controller;
}

void main() {
  testWidgets(
    'phone navigation, automatic Markdown, plain toggle and local QR error',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final app = await fixture();
      addTearDown(app.dispose);
      await tester.pumpWidget(
        PrinterApp(controller: app, enableNativeDrop: false),
      );
      await tester.pumpAndSettle();
      expect(find.byType(NavigationBar), findsOneWidget);
      expect(find.byType(NavigationRail), findsNothing);
      await tester.enterText(find.byType(TextField).first, '# 标题');
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('已自动识别 Markdown'), findsOneWidget);
      await tester.tap(find.text('保留原文'));
      await tester.pumpAndSettle();
      expect(app.blocks.first.autoMarkdown, false);
      await tester.tap(find.text('预览'));
      await tester.pumpAndSettle();
      expect(find.text('小票预览'), findsOneWidget);
      await tester.tap(find.byTooltip('关闭预览'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('设置'));
      await tester.pumpAndSettle();
      expect(find.text('打印设备'), findsOneWidget);
      expect(find.text('图片图床'), findsOneWidget);
      await tester.tap(find.text('记录'));
      await tester.pumpAndSettle();
      expect(find.text('还没有打印记录'), findsOneWidget);
      await tester.tap(find.text('打印'));
      await tester.pumpAndSettle();
      app.blocks = [ReceiptBlock(kind: BlockKind.qr, text: '中' * 34)];
      app.changed();
      await tester.pumpAndSettle();
      expect(find.text('超过 100 UTF-8 字节，请缩短；不会自动截断'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  for (final size in [const Size(360, 800), const Size(1440, 960)]) {
    testWidgets('Material layout fits ${size.width.toInt()} pixels', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final app = await fixture(sample: true);
      addTearDown(app.dispose);
      await tester.pumpWidget(
        PrinterApp(controller: app, enableNativeDrop: false),
      );
      await tester.pumpAndSettle();
      expect(find.text('写下一张小票'), findsOneWidget);
      if (size.width > 840) {
        expect(find.byType(NavigationRail), findsOneWidget);
        expect(find.text('小票预览'), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('render Android and Windows design previews without a browser', (
    tester,
  ) async {
    if (Platform.environment['GENERATE_PREVIEWS'] != '1') return;
    final font = File(
      '${Platform.environment['SystemRoot'] ?? 'C:/Windows'}/Fonts/msyh.ttc',
    );
    if (font.existsSync()) {
      final loader = FontLoader('Microsoft YaHei')
        ..addFont(Future.value(ByteData.sublistView(font.readAsBytesSync())));
      await tester.runAsync(loader.load);
    }
    final output = Directory('test/visual-output')..createSync(recursive: true);
    final key = GlobalKey();
    for (final entry in {
      'android': const Size(390, 844),
      'windows': const Size(1440, 960),
    }.entries) {
      tester.view.physicalSize = entry.value;
      tester.view.devicePixelRatio = 1;
      final app = await fixture(sample: true);
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: PrinterApp(controller: app, enableNativeDrop: false),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final render =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      await tester.runAsync(() async {
        final image = await render.toImage(pixelRatio: 1);
        final bytes = (await image.toByteData(
          format: ui.ImageByteFormat.png,
        ))!.buffer.asUint8List();
        File('${output.path}/${entry.key}.png').writeAsBytesSync(bytes);
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    }
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}
