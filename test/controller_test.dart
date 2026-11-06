import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:wechat_printer_print_only/app_controller.dart';
import 'package:wechat_printer_print_only/core/models.dart';
import 'package:wechat_printer_print_only/core/network.dart';
import 'package:wechat_printer_print_only/core/storage.dart';

void main() {
  test(
    'automatic upload is reused by print and all requests are simulated',
    () async {
      var uploads = 0, prints = 0;
      final store = MemoryStore()
        ..settings = const AppSettings(
          device: DeviceSettings(sn: 'TEST_DEVICE', sid: 'DUMMY_SID'),
          host: HostSettings(
            endpoint: 'https://account.r2.cloudflarestorage.com',
            bucket: 'bucket',
            accessKeyId: 'TEST_KEY',
            secretAccessKey: 'TEST_SECRET',
            publicBaseUrl: 'https://images.example.com',
          ),
        );
      final network = Network(
        client: MockClient((request) async {
          if (request.method == 'PUT') {
            uploads++;
            return http.Response('', 200);
          }
          if (request.url.host == 'payapp.wechatpay.cn') {
            prints++;
            final body = jsonDecode(request.body);
            expect(
              body['ad_content']['user_define_template']['root'][0]['icon']['value'],
              startsWith('https://images.example.com/xiaopiao/'),
            );
            return http.Response('{"errcode":0}', 200);
          }
          fail(
            'Unexpected mock request: ${request.method} ${request.url.host}',
          );
        }),
      );
      final app = AppController(store: store, network: network);
      await app.initialize();
      final block = ReceiptBlock(
        kind: BlockKind.image,
        imageBytes: Uint8List.fromList([137, 80, 78, 71]),
        name: 'test.png',
      );
      app.blocks = [block];
      app.changed();
      await app.uploadBlock(block);
      expect(uploads, 1);
      final outcome = await app.print();
      expect(outcome.accepted, true);
      expect(uploads, 1);
      expect(prints, 1);
      expect(app.history.single.status, 'accepted');
      expect(jsonEncode(app.exportDocument()), isNot(contains('DUMMY_SID')));
      expect(jsonEncode(app.exportDocument()), isNot(contains('TEST_SECRET')));
      app.dispose();
    },
  );
  test(
    'unsafe QR prevents upload and print; legacy config drops all bot settings',
    () async {
      var calls = 0;
      final app = AppController(
        store: MemoryStore(),
        network: Network(
          client: MockClient((_) async {
            calls++;
            return http.Response('{}', 200);
          }),
        ),
      );
      await app.initialize();
      await app.importSettings({
        'device': {'sn': 'TEST_DEVICE', 'sid': 'DUMMY_SID', 'accountType': 2},
        'onebot': {'token': 'BOT_SECRET'},
        'imageHost': {'provider': 'r2', 'prefix': 'xiaopiao'},
      });
      expect(jsonEncode(app.settings.toJson()), isNot(contains('BOT_SECRET')));
      app.blocks = [ReceiptBlock(kind: BlockKind.qr, text: '中' * 34)];
      app.changed();
      await expectLater(app.print(), throwsFormatException);
      expect(calls, 0);
      app.dispose();
    },
  );
  test(
    'AI is explicit, sends only current document and never applies automatically',
    () async {
      const source = '#标题\r\n苹果 18.50 元\r\n~~~\r\n代码\r\n~~~';
      var calls = 0;
      final app = AppController(
        store: MemoryStore(),
        network: Network(
          client: MockClient((request) async {
            calls++;
            expect(
              request.url.toString(),
              'https://ai.example.com/v1/chat/completions',
            );
            final body = jsonDecode(request.body);
            expect(body['messages'][1]['content'], source);
            expect(body['model'], 'deepseek-v4.1-flash');
            expect(request.headers['authorization'], 'Bearer MOCK_AI_KEY');
            expect(request.body, isNot(contains('DUMMY_SID')));
            return http.Response(
              jsonEncode({
                'choices': [
                  {
                    'message': {
                      'content': jsonEncode({
                        'summary': '添加空格',
                        'issues': [],
                        'layout': [
                          {'line': 1, 'style': 'fixHeading'},
                          {'line': 2, 'style': 'center'},
                          {'line': 4, 'style': 'title'},
                        ],
                        'revisedMarkdown': '正文篡改应被忽略',
                      }),
                    },
                  },
                ],
              }),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }),
        ),
      );
      await app.initialize();
      app.blocks = [ReceiptBlock(kind: BlockKind.markdown, text: source)];
      await expectLater(app.checkAi(source), throwsFormatException);
      expect(calls, 0);
      await app.saveSettings(
        const AppSettings(
          device: DeviceSettings(sn: 'TEST_DEVICE', sid: 'DUMMY_SID'),
          ai: AiSettings(
            enabled: true,
            baseUrl: 'https://ai.example.com/v1/chat/completions',
            model: 'mock-model',
            apiKey: 'MOCK_AI_KEY',
          ),
        ),
      );
      expect(calls, 0);
      final suggestion = await app.checkAi(source);
      expect(calls, 1);
      expect(
        suggestion.revised,
        '# 标题\r\n<center>苹果 18.50 元</center>\r\n~~~\r\n代码\r\n~~~',
      );
      expect(app.blocks.single.text, source);
      app.dispose();
    },
  );
}
