import 'dart:async';
import 'dart:convert';
import 'models.dart';
import 'network.dart';
import 'receipt_compiler.dart';

class PrintOutcome {
  const PrintOutcome(this.status, this.message, {this.code});
  final String status, message;
  final int? code;
  bool get accepted => status == 'accepted';
}

PrintOutcome interpretResponse(int httpStatus, dynamic value) {
  if (value is! Map) {
    return const PrintOutcome('unknown', '接口返回内容无法识别，结果未知；请检查设备后再决定是否重发');
  }
  final message = '${value['msg'] ?? value['errmsg'] ?? value['error'] ?? ''}';
  if (message.contains('session_key失效') ||
      message.toLowerCase().contains('invalid sid')) {
    return const PrintOutcome('failed', 'SID 已失效，请重新抓取并更新设备配置');
  }
  final code = value['errcode'] ?? value['retcode'];
  if (httpStatus < 200 || httpStatus >= 300) {
    return PrintOutcome(
      'failed',
      '接口返回 HTTP $httpStatus',
      code: code is num ? code.toInt() : null,
    );
  }
  if (code == 0) {
    return const PrintOutcome('accepted', '请求已受理，是否完整出纸请以设备为准', code: 0);
  }
  if (code == 268435461) {
    return const PrintOutcome('failed', '请求字段或枚举值不合法，请检查内容配置', code: 268435461);
  }
  if (code == 268697729) {
    if (message.contains('其他打印任务')) {
      return const PrintOutcome('failed', '设备正在打印，请等待任务结束后再试', code: 268697729);
    }
    if (message.contains('关机') || message.contains('网络中断')) {
      return const PrintOutcome('failed', '设备关机或网络中断，请检查小票机', code: 268697729);
    }
    return const PrintOutcome('failed', '设备或服务暂时繁忙，请检查设备后再试', code: 268697729);
  }
  if (code is num && code != 0) {
    return PrintOutcome(
      'failed',
      message.isEmpty ? '请求未被受理（错误码 $code）' : message,
      code: code.toInt(),
    );
  }
  return const PrintOutcome('unknown', '接口没有返回明确的业务结果，请检查设备后再决定是否重发');
}

class PrintApi {
  PrintApi(this.network, {Uri? endpoint})
    : endpoint =
          endpoint ??
          Uri.parse('https://payapp.wechatpay.cn/smartqr/printerad/printad');
  final Network network;
  final Uri endpoint;
  Map<String, dynamic> payload(
    DeviceSettings device,
    List<PrinterNode> nodes, {
    bool redact = false,
  }) => {
    'device_sn': redact ? '<DEVICE_SN>' : device.sn.trim(),
    'sid': redact ? '<SID>' : device.sid.trim(),
    'account_type': device.accountType,
    'ad_content': {
      'user_define_template': {'root': nodes},
    },
  };
  Future<PrintOutcome> send(
    DeviceSettings device,
    List<PrinterNode> nodes,
  ) async {
    if (!device.configured) throw const FormatException('请先在设置中填写设备 SN 和 SID');
    ReceiptCompiler().validate(nodes);
    final target = endpoint.replace(
      queryParameters: {...endpoint.queryParameters, 'sid': device.sid.trim()},
    );
    try {
      final response = await network.request(
        'POST',
        target,
        headers: {'content-type': 'application/json'},
        body: utf8.encode(jsonEncode(payload(device, nodes))),
        timeout: const Duration(seconds: 35),
      );
      dynamic decoded;
      try {
        decoded = response.json;
      } catch (_) {
        return const PrintOutcome('unknown', '接口响应无法解析，结果未知；请检查设备，避免重复发送');
      }
      final outcome = interpretResponse(response.status, decoded);
      var message = outcome.message;
      for (final secret in [device.sid, device.sn]) {
        if (secret.isNotEmpty) message = message.replaceAll(secret, '[已隐藏]');
      }
      return PrintOutcome(outcome.status, message, code: outcome.code);
    } on TimeoutException {
      return const PrintOutcome('unknown', '请求超时，受理状态未知；不会自动重发，请先检查设备');
    } catch (_) {
      return const PrintOutcome('unknown', '连接中断，受理状态未知；请先检查设备再决定是否重发');
    }
  }
}
