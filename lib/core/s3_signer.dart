import 'dart:convert';
import 'package:crypto/crypto.dart';

String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();
String awsEncode(String value) => Uri.encodeComponent(value).replaceAllMapped(
  RegExp(r"[!'()*]"),
  (m) => '%${m[0]!.codeUnitAt(0).toRadixString(16).toUpperCase()}',
);
String awsPath(String value) => value.split('/').map(awsEncode).join('/');

class SignedS3Request {
  SignedS3Request(this.headers, this.signature, this.canonical);
  final Map<String, String> headers;
  final String signature, canonical;
}

SignedS3Request signS3({
  required Uri url,
  String method = 'PUT',
  required List<int> body,
  required String region,
  required String accessKeyId,
  required String secretAccessKey,
  String sessionToken = '',
  String? contentType,
  DateTime? date,
}) {
  final time = (date ?? DateTime.now()).toUtc().toIso8601String().replaceAll(
    RegExp(r'[:-]|\.\d+'),
    '',
  );
  final day = time.substring(0, 8);
  final headers = <String, String>{
    'host': url.authority,
    'x-amz-content-sha256': sha256Hex(body),
    'x-amz-date': time,
  };
  if (contentType != null) headers['content-type'] = contentType;
  if (sessionToken.isNotEmpty) headers['x-amz-security-token'] = sessionToken;
  final names = headers.keys.toList()..sort();
  final canonicalHeaders = names
      .map(
        (key) =>
            '$key:${headers[key]!.trim().replaceAll(RegExp(r'\s+'), ' ')}\n',
      )
      .join();
  final query = <String>[];
  url.queryParametersAll.forEach((key, values) {
    for (final value in values) {
      query.add('${awsEncode(key)}=${awsEncode(value)}');
    }
  });
  query.sort();
  final canonical = [
    method,
    url.path.isEmpty
        ? '/'
        : url.toString().split('?').first.substring(url.origin.length),
    query.join('&'),
    canonicalHeaders,
    names.join(';'),
    sha256Hex(body),
  ].join('\n');
  final scope = '$day/$region/s3/aws4_request';
  final toSign = [
    'AWS4-HMAC-SHA256',
    time,
    scope,
    sha256Hex(utf8.encode(canonical)),
  ].join('\n');
  List<int> hmac(List<int> key, String value) =>
      Hmac(sha256, key).convert(utf8.encode(value)).bytes;
  final key = hmac(
    hmac(hmac(hmac(utf8.encode('AWS4$secretAccessKey'), day), region), 's3'),
    'aws4_request',
  );
  final signature = Hmac(sha256, key).convert(utf8.encode(toSign)).toString();
  headers['authorization'] =
      'AWS4-HMAC-SHA256 Credential=$accessKeyId/$scope, SignedHeaders=${names.join(';')}, Signature=$signature';
  return SignedS3Request(headers, signature, canonical);
}
