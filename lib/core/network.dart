import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;

class NetResult {
  NetResult(this.status, this.headers, this.bytes);
  final int status;
  final Map<String, String> headers;
  final Uint8List bytes;
  bool get ok => status >= 200 && status < 300;
  String get text => utf8.decode(bytes, allowMalformed: true);
  dynamic get json => jsonDecode(text);
}

class Network {
  Network({http.Client? client}) : client = client ?? http.Client();
  final http.Client client;
  Future<NetResult> send(
    http.BaseRequest request, {
    int maxBytes = 2 * 1024 * 1024,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    request.followRedirects = false;
    Future<NetResult> operation() async {
      final response = await client.send(request);
      if ((response.contentLength ?? 0) > maxBytes) {
        throw const FormatException('接口响应超过本地大小限制');
      }
      final chunks = BytesBuilder(copy: false);
      await for (final part in response.stream) {
        if (chunks.length + part.length > maxBytes) {
          throw const FormatException('接口响应超过本地大小限制');
        }
        chunks.add(part);
      }
      return NetResult(
        response.statusCode,
        response.headers,
        chunks.takeBytes(),
      );
    }

    return operation().timeout(timeout);
  }

  Future<NetResult> request(
    String method,
    Uri url, {
    Map<String, String>? headers,
    List<int>? body,
    int maxBytes = 2 * 1024 * 1024,
    Duration timeout = const Duration(seconds: 30),
  }) {
    final request = http.Request(method, url);
    if (headers != null) request.headers.addAll(headers);
    if (body != null) request.bodyBytes = body;
    return send(request, maxBytes: maxBytes, timeout: timeout);
  }

  Future<Uint8List> image(String source, {int redirects = 0}) async {
    final uri = Uri.tryParse(source);
    if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      throw const FormatException('图片需要完整的 HTTP(S) 地址');
    }
    if (redirects > 5) throw const FormatException('图片重定向次数过多');
    final response = await request('GET', uri, maxBytes: 20 * 1024 * 1024);
    if (response.status >= 300 &&
        response.status < 400 &&
        response.headers['location'] != null) {
      return image(
        uri.resolve(response.headers['location']!).toString(),
        redirects: redirects + 1,
      );
    }
    if (!response.ok) throw FormatException('图片下载失败（HTTP ${response.status}）');
    return response.bytes;
  }

  void close() => client.close();
}
