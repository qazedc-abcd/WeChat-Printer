import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import '../test/support/clipboard_flow.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Android system clipboard reaches body, SN, SID and JSON import', (
    tester,
  ) async {
    await exerciseClipboard(tester, (text) async {
      await Clipboard.setData(ClipboardData(text: text));
      // No mock channel: verify MainActivity reads the actual system clipboard.
      expect(
        await const MethodChannel(
          'xyz.wechatprinter.files',
        ).invokeMethod<String>('readClipboardText'),
        text,
      );
    });
    await Clipboard.setData(const ClipboardData(text: ''));
  });
}
