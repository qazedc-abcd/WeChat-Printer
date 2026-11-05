import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:wechat_printer_print_only/core/image_host.dart';
import 'package:wechat_printer_print_only/core/models.dart';
import 'package:wechat_printer_print_only/core/network.dart';
import 'package:wechat_printer_print_only/core/print_api.dart';
import 'package:wechat_printer_print_only/core/receipt_compiler.dart';
import 'package:wechat_printer_print_only/core/s3_signer.dart';

void main() {
  test('SigV4 matches independently checked AWS SDK vector', () {
    final signed = signS3(
      url: Uri.parse(
        'https://test-bucket.s3.us-east-1.amazonaws.com/a%20b/%E4%B8%AD%E6%96%87.png',
      ),
      body: utf8.encode('test payload'),
      region: 'us-east-1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'TEST_TOKEN',
      contentType: 'image/png',
      date: DateTime.utc(2026, 11, 5, 12, 34, 56),
    );
    expect(
      signed.signature,
      '1090af191a259933c8f1defd08350477dd55944e79e652b0ce4fbb99d961b8b2',
    );
    expect(signed.headers['x-amz-date'], '20261105T123456Z');
  });

  test('Markdown, table, image and divider compile with one row per content', () {
    final compiler = ReceiptCompiler();
    final source =
        '# 标题\n\n- 咖啡\n- 茶\n\n---\n\n| 项目 | 数量 |\n| --- | ---: |\n| 咖啡 | 1 |\n\n![照片](https://images.example.com/photo.jpg)';
    final nodes = compiler.markdown(source);
    expect(nodes.any((node) => node.containsKey('divider')), true);
    expect(
      nodes.where((node) => node['icon']?['type'] == 3).single['icon']['value'],
      'https://images.example.com/photo.jpg',
    );
    final table = nodes.firstWhere(
      (node) => node['content']?['maxcolumn'] == 2,
    )['content'];
    expect(table['column_align'][1]['style']['justification'], 2);
    for (final node in nodes.where((node) => node.containsKey('content'))) {
      expect(node['content']['lines']['linelist'].length, 1);
    }
    expect(compiler.detectsMarkdown('# 标题'), true);
    expect(compiler.detectsMarkdown('普通中文文字。'), false);
    expect(
      compiler.lint('![图](relative.png)').any((issue) => issue.error),
      true,
    );
    expect(compiler.lint('```text\ncode').any((issue) => issue.error), false);
    final row = List.filled(17, '列').join('|');
    expect(
      compiler
          .lint('$row\n${List.filled(17, '---').join('|')}')
          .any((issue) => issue.error),
      true,
    );
    final plain = '汉字' * 2048;
    expect(
      compiler.compile([
        ReceiptBlock(kind: BlockKind.text, text: plain),
      ]).single['content']['lines']['linelist'][0]['column'][0],
      plain,
    );
  });

  test(
    'long native QR blocked by UTF-8 bytes before HTTP; request payload retains credentials only for target',
    () async {
      var requests = 0;
      final network = Network(
        client: MockClient((request) async {
          requests++;
          expect(request.url.host, 'payapp.wechatpay.cn');
          expect(request.url.queryParameters['sid'], 'DUMMY_SID');
          final payload = jsonDecode(request.body);
          expect(payload['device_sn'], 'TEST_DEVICE');
          expect(request.followRedirects, false);
          return http.Response('{"errcode":0}', 200);
        }),
      );
      final api = PrintApi(network);
      final compiler = ReceiptCompiler();
      const device = DeviceSettings(sn: 'TEST_DEVICE', sid: 'DUMMY_SID');
      final long = compiler.compile([
        ReceiptBlock(kind: BlockKind.qr, text: '中' * 34),
      ]);
      await expectLater(api.send(device, long), throwsFormatException);
      expect(requests, 0);
      final short = compiler.compile([
        ReceiptBlock(kind: BlockKind.qr, text: 'https://example.com'),
      ]);
      final outcome = await api.send(device, short);
      expect(requests, 1);
      expect(outcome.status, 'accepted');
      expect(outcome.message, contains('以设备为准'));
      final preview = jsonEncode(api.payload(device, short, redact: true));
      expect(preview.contains('DUMMY_SID'), false);
      expect(preview.contains('TEST_DEVICE'), false);
      network.close();
    },
  );

  test(
    'business errors distinguish schema, offline, busy and unknown; no false success',
    () {
      expect(
        interpretResponse(200, {'errcode': 268435461}).message,
        contains('字段'),
      );
      expect(
        interpretResponse(200, {
          'errcode': 268697729,
          'msg': '设备关机或网络中断，请检查机器',
        }).message,
        contains('关机'),
      );
      expect(
        interpretResponse(200, {
          'errcode': 268697729,
          'msg': '小票机正在执行其他打印任务，任务结束后再尝试',
        }).message,
        contains('正在打印'),
      );
      expect(
        interpretResponse(200, {
          'errcode': 268697729,
          'msg': '系统繁忙，请稍后重试',
        }).message,
        contains('繁忙'),
      );
      expect(
        interpretResponse(200, {'msg': 'session_key失效'}).message,
        contains('SID 已失效'),
      );
      expect(interpretResponse(200, {}).status, 'unknown');
      expect(interpretResponse(503, {'errcode': 0}).accepted, false);
    },
  );

  test(
    'R2 upload signs encoded object path and returns public prefix',
    () async {
      final bytes = Uint8List.fromList([137, 80, 78, 71]);
      final network = Network(
        client: MockClient((request) async {
          expect(request.method, 'PUT');
          expect(
            request.url.toString(),
            contains('/bucket/%E6%94%B6%E6%8D%AE/a%20b%21/2026/11/05/'),
          );
          expect(
            request.headers['authorization'],
            contains('/auto/s3/aws4_request'),
          );
          expect(request.headers['x-amz-security-token'], 'TEST_TOKEN');
          expect(request.bodyBytes, bytes);
          expect(request.headers['content-type'], 'image/png');
          return http.Response('', 200);
        }),
      );
      final url = await ImageHost(network).upload(
        bytes,
        const HostSettings(
          endpoint: 'https://account.r2.cloudflarestorage.com',
          bucket: 'bucket',
          accessKeyId: 'TEST_KEY',
          secretAccessKey: 'TEST_SECRET',
          sessionToken: 'TEST_TOKEN',
          prefix: '收据/a b!',
          publicBaseUrl: 'https://images.example.com',
        ),
        at: DateTime.utc(2026, 11, 5),
      );
      expect(
        url,
        startsWith(
          'https://images.example.com/%E6%94%B6%E6%8D%AE/a%20b%21/2026/11/05/',
        ),
      );
      expect(url, endsWith('.png'));
      network.close();
    },
  );

  test(
    'custom multipart honors file field, auth, nested URL and refuses unsafe URL',
    () async {
      var unsafe = false;
      final network = Network(
        client: MockClient((request) async {
          expect(request.headers['authorization'], 'Bearer TEST');
          expect(
            request.headers['content-type'],
            contains('multipart/form-data'),
          );
          expect(
            utf8.decode(request.bodyBytes, allowMalformed: true),
            contains('name="image"; filename="receipt.png"'),
          );
          expect(
            utf8.decode(request.bodyBytes, allowMalformed: true),
            contains('content-type: image/png'),
          );
          return http.Response(
            jsonEncode({
              'data': {'url': unsafe ? 'javascript:alert(1)' : '/public/a.png'},
            }),
            200,
          );
        }),
      );
      const host = HostSettings(
        provider: 'custom',
        uploadUrl: 'https://example.com/upload',
        fileField: 'image',
        responseUrlPath: 'data.url',
        authorization: 'Bearer TEST',
      );
      expect(
        await ImageHost(network).upload(Uint8List.fromList([1, 2, 3]), host),
        'https://example.com/public/a.png',
      );
      unsafe = true;
      await expectLater(
        ImageHost(network).upload(Uint8List.fromList([1, 2, 3]), host),
        throwsFormatException,
      );
      expect(
        HostSettings.fromJson({
          ...host.toJson(),
          'responseUrlPath': '__proto__.url',
        }).validate(),
        isNotEmpty,
      );
      network.close();
    },
  );
}
