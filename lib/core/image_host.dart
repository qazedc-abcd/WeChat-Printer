import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'models.dart';
import 'network.dart';
import 's3_signer.dart';

class ImageHost {
  ImageHost(this.network);
  final Network network;
  Future<String> upload(
    Uint8List png,
    HostSettings config, {
    DateTime? at,
  }) async {
    final errors = config.validate();
    if (errors.isNotEmpty) throw FormatException(errors.join('；'));
    if (png.isEmpty || png.length > 20 * 1024 * 1024) {
      throw const FormatException('上传图片需在 20 MiB 以内');
    }
    if (config.provider == 'custom') {
      final request = http.MultipartRequest(
        'POST',
        Uri.parse(config.uploadUrl),
      );
      if (config.authorization.isNotEmpty) {
        request.headers['authorization'] = config.authorization;
      }
      request.files.add(
        http.MultipartFile.fromBytes(
          config.fileField,
          png,
          filename: 'receipt.png',
          contentType: MediaType('image', 'png'),
        ),
      );
      final response = await network.send(request);
      if (!response.ok) {
        throw FormatException('自定义图床上传失败（HTTP ${response.status}）');
      }
      dynamic value;
      try {
        value = response.json;
      } catch (_) {
        throw const FormatException('图床没有返回 JSON');
      }
      for (final field in config.responseUrlPath.split('.')) {
        if (value is Map) {
          value = value[field];
        } else if (value is List) {
          final index = int.tryParse(field);
          value = index != null && index >= 0 && index < value.length
              ? value[index]
              : null;
        } else {
          value = null;
        }
      }
      if (value is! String || value.trim().isEmpty) {
        throw const FormatException('没有找到配置路径中的图片直链');
      }
      final direct = Uri.parse(config.uploadUrl).resolve(value);
      if (!['http', 'https'].contains(direct.scheme) ||
          direct.userInfo.isNotEmpty) {
        throw const FormatException('图床返回的图片地址必须是 HTTP(S)');
      }
      return direct.toString();
    }
    final date = (at ?? DateTime.now()).toUtc();
    final day = date.toIso8601String().substring(0, 10).replaceAll('-', '/');
    final key = [
      config.prefix.replaceAll(RegExp(r'^/+|/+$'), ''),
      day,
      '${sha256Hex(png).substring(0, 24)}.png',
    ].where((s) => s.isNotEmpty).join('/');
    final endpoint = Uri.parse(config.endpoint);
    final origin = config.forcePathStyle
        ? endpoint.origin
        : '${endpoint.scheme}://${config.bucket}.${endpoint.authority}';
    final path =
        '${endpoint.path.replaceAll(RegExp(r'/+$'), '')}/${config.forcePathStyle ? '${awsEncode(config.bucket)}/' : ''}${awsPath(key)}';
    final target = Uri.parse('$origin$path');
    final signed = signS3(
      url: target,
      body: png,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      contentType: 'image/png',
      date: date,
    );
    final response = await network.request(
      'PUT',
      target,
      headers: signed.headers,
      body: png,
    );
    if (!response.ok) {
      final code = RegExp(
        r'<Code>([a-zA-Z0-9_-]+)</Code>',
      ).firstMatch(response.text)?.group(1);
      throw FormatException(
        'S3 上传失败（HTTP ${response.status}${code == null ? '' : ' / $code'}），请核对 Endpoint、Region 与权限',
      );
    }
    return '${config.publicBaseUrl.replaceAll(RegExp(r'/+$'), '')}/${awsPath(key)}';
  }
}
