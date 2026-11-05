import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:wechat_printer_print_only/app_controller.dart';
import 'package:wechat_printer_print_only/core/network.dart';
import 'package:wechat_printer_print_only/core/storage.dart';
import 'package:wechat_printer_print_only/printer_app.dart';

/// Shared UI assertions; integration tests supply the real system clipboard.
Future<void> exerciseClipboard(
  WidgetTester tester,
  Future<void> Function(String) copy,
) async {
  final store = MemoryStore();
  final app = AppController(
    store: store,
    network: Network(
      client: MockClient((_) async => throw StateError('No network allowed')),
    ),
  );
  await app.initialize();
  await tester.pumpWidget(PrinterApp(controller: app, enableNativeDrop: false));
  await tester.pumpAndSettle();
  Future<void> tap(Finder target) async {
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    await tester.tap(target);
    await tester.pumpAndSettle();
  }

  await copy('中文正文 😀\n第二行');
  await tap(find.byTooltip('粘贴正文'));
  expect(app.blocks.first.text, '中文正文 😀\n第二行');
  await tap(find.text('设置').last);
  await copy('TEST-SN-001');
  await tap(find.byTooltip('粘贴设备 SN'));
  await copy('TEST-SID-001');
  await tap(find.byTooltip('粘贴设备 SID'));
  // Settings live below the keyboard and scroll viewport on a real phone.
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pumpAndSettle();
  await tap(find.text('保存设置'));
  expect(store.settings.device.sn, 'TEST-SN-001');
  expect(store.settings.device.sid, 'TEST-SID-001');
  await copy('{"device_sn":"JSON-SN-1","sid":"JSON-SID-1","account_type":2}');
  await tap(find.text('粘贴 JSON'));
  final jsonField = find.descendant(
    of: find.byType(AlertDialog),
    matching: find.byType(TextField),
  );
  expect(
    tester.widget<TextField>(jsonField).controller!.text,
    contains('JSON-SN-1'),
  );
  // Prefilling must not commit before the user reviews and presses Import.
  expect(store.settings.device.sn, 'TEST-SN-001');
  await copy(
    '```json\n{"device_sn":"JSON-SN-2","sid":"JSON-SID-2","account_type":2}\n```',
  );
  await tap(find.byTooltip('重新粘贴 JSON'));
  await tap(find.widgetWithText(FilledButton, '导入'));
  expect(store.settings.device.sn, 'JSON-SN-2');
  expect(store.settings.device.sid, 'JSON-SID-2');
  expect(tester.takeException(), isNull);
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 600));
  app.dispose();
}
