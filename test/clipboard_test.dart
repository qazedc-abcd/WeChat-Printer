import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wechat_printer_print_only/ui/paste_text_field.dart';
import 'support/clipboard_flow.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  String? clipboard;
  var reads = 0;
  setUp(() {
    clipboard = null;
    reads = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('xyz.wechatprinter.files'),
          (call) async {
            if (call.method == 'readClipboardText') {
              reads++;
              return clipboard;
            }
            return null;
          },
        );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.hasStrings') return {'value': false};
          if (call.method == 'Clipboard.getData') {
            reads++;
            return {'text': clipboard};
          }
          return null;
        });
  });

  test('selection, emoji, whole-field and single-line paste', () {
    const current = TextEditingValue(
      text: 'A😀BC',
      selection: TextSelection(baseOffset: 1, extentOffset: 3),
    );
    final next = pastedValue(current, '汉字');
    expect(next.text, 'A汉字BC');
    expect(next.selection.baseOffset, 3);
    expect(
      pastedValue(current, '新\n值', replaceAll: true, multiline: false).text,
      '新 值',
    );
    expect(pastedValue(const TextEditingValue(text: 'a'), 'b').text, 'ab');
    expect(pastedValue(current, '').text, 'ABC');
  });

  testWidgets('body, secret settings and reviewed JSON update actual models', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await exerciseClipboard(tester, (text) async {
      clipboard = text;
    });
  });

  testWidgets(
    'long press paste is present even when platform says no strings; Ctrl+V replaces selection',
    (tester) async {
      final controller = TextEditingController(text: 'abcdef');
      addTearDown(controller.dispose);
      String? changed;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PasteTextField(
              controller: controller,
              onChanged: (text) => changed = text,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        reads,
        0,
        reason: 'Never read private clipboard merely on app startup',
      );
      expect(
        tester.widget<TextField>(find.byType(TextField)).magnifierConfiguration,
        TextMagnifierConfiguration.disabled,
      );
      clipboard = '粘贴';
      await tester.longPress(find.byType(TextField));
      await tester.pumpAndSettle();
      final menu = find.byType(AdaptiveTextSelectionToolbar);
      expect(menu, findsOneWidget);
      final item = tester
          .widget<AdaptiveTextSelectionToolbar>(menu)
          .buttonItems!
          .first;
      expect(item.type, ContextMenuButtonType.paste);
      item.onPressed!();
      await tester.pumpAndSettle();
      expect(changed, contains('粘贴'));
      controller.value = const TextEditingValue(
        text: 'abcdef',
        selection: TextSelection(baseOffset: 1, extentOffset: 4),
      );
      clipboard = '中';
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pumpAndSettle();
      expect(controller.text, 'a中ef');
      expect(changed, 'a中ef');
      clipboard = '';
      await tester.tap(find.byTooltip('粘贴'));
      await tester.pumpAndSettle();
      expect(controller.text, 'a中ef');
      expect(find.text('剪贴板中没有可粘贴的文字，请重新复制后再试'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
