import 'dart:convert';
import 'dart:typed_data';

enum BlockKind { text, markdown, image, qr, divider, spacer }

class ReceiptBlock {
  ReceiptBlock({
    String? id,
    required this.kind,
    this.text = '',
    this.url = '',
    this.align = 0,
    this.autoMarkdown = true,
    this.imageBytes,
    this.sourceBytes,
    this.name = '',
  }) : id = id ?? '${DateTime.now().microsecondsSinceEpoch}-${_next++}';
  static int _next = 0;
  final String id;
  BlockKind kind;
  String text;
  String url;
  int align;
  bool autoMarkdown;
  Uint8List? imageBytes;
  Uint8List? sourceBytes;
  String name;
  Map<String, dynamic> toJson() => {
    'id': id,
    'kind': kind.name,
    'text': text,
    'url': url,
    'align': align,
    'autoMarkdown': autoMarkdown,
    'name': name,
    if (imageBytes != null) 'image': base64Encode(imageBytes!),
  };
  factory ReceiptBlock.fromJson(Map<String, dynamic> value) => ReceiptBlock(
    id: value['id'] as String?,
    kind: BlockKind.values.firstWhere(
      (kind) => kind.name == value['kind'],
      orElse: () => BlockKind.text,
    ),
    text: '${value['text'] ?? ''}',
    url: '${value['url'] ?? ''}',
    align: (value['align'] as num?)?.toInt().clamp(0, 2) ?? 0,
    autoMarkdown: value['autoMarkdown'] != false,
    name: '${value['name'] ?? ''}',
    imageBytes: value['image'] is String ? base64Decode(value['image']) : null,
  );
  ReceiptBlock copy() =>
      ReceiptBlock.fromJson(toJson())..sourceBytes = sourceBytes;
}

class DeviceSettings {
  const DeviceSettings({this.sn = '', this.sid = '', this.accountType = 2});
  final String sn, sid;
  final int accountType;
  bool get configured => sn.trim().isNotEmpty && sid.trim().isNotEmpty;
  factory DeviceSettings.fromJson(Map<String, dynamic> value) => DeviceSettings(
    sn: '${value['sn'] ?? value['device_sn'] ?? ''}',
    sid: '${value['sid'] ?? ''}',
    accountType:
        int.tryParse('${value['accountType'] ?? value['account_type'] ?? 2}') ??
        2,
  );
  Map<String, dynamic> toJson({bool secrets = true}) => {
    'sn': secrets ? sn : '',
    'sid': secrets ? sid : '',
    'accountType': accountType,
  };
}

class HostSettings {
  const HostSettings({
    this.provider = 'r2',
    this.endpoint = '',
    this.bucket = '',
    this.region = 'auto',
    this.accessKeyId = '',
    this.secretAccessKey = '',
    this.sessionToken = '',
    this.publicBaseUrl = '',
    this.prefix = 'xiaopiao',
    this.forcePathStyle = true,
    this.uploadUrl = '',
    this.fileField = 'file',
    this.responseUrlPath = 'url',
    this.authorization = '',
  });
  final String provider,
      endpoint,
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      publicBaseUrl,
      prefix,
      uploadUrl,
      fileField,
      responseUrlPath,
      authorization;
  final bool forcePathStyle;
  factory HostSettings.fromJson(Map<String, dynamic> value) => HostSettings(
    provider: ['r2', 's3', 'custom'].contains(value['provider'])
        ? value['provider']
        : 'r2',
    endpoint: '${value['endpoint'] ?? ''}',
    bucket: '${value['bucket'] ?? ''}',
    region:
        '${value['region'] ?? (value['provider'] == 's3' ? 'us-east-1' : 'auto')}',
    accessKeyId: '${value['accessKeyId'] ?? ''}',
    secretAccessKey: '${value['secretAccessKey'] ?? ''}',
    sessionToken: '${value['sessionToken'] ?? ''}',
    publicBaseUrl: '${value['publicBaseUrl'] ?? ''}'.replaceAll(
      RegExp(r'/+$'),
      '',
    ),
    prefix: '${value['prefix'] ?? 'xiaopiao'}'.replaceAll(
      RegExp(r'^/+|/+$'),
      '',
    ),
    forcePathStyle: value['forcePathStyle'] != false,
    uploadUrl: '${value['uploadUrl'] ?? ''}',
    fileField: '${value['fileField'] ?? 'file'}',
    responseUrlPath: '${value['responseUrlPath'] ?? 'url'}',
    authorization: '${value['authorization'] ?? ''}',
  );
  Map<String, dynamic> toJson({bool secrets = true}) => {
    'provider': provider,
    'endpoint': endpoint,
    'bucket': bucket,
    'region': region,
    'accessKeyId': secrets ? accessKeyId : '',
    'secretAccessKey': secrets ? secretAccessKey : '',
    'sessionToken': secrets ? sessionToken : '',
    'publicBaseUrl': publicBaseUrl,
    'prefix': prefix,
    'forcePathStyle': forcePathStyle,
    'uploadUrl': uploadUrl,
    'fileField': fileField,
    'responseUrlPath': responseUrlPath,
    'authorization': secrets ? authorization : '',
  };
  List<String> validate() {
    final errors = <String>[];
    bool validUrl(String value, {bool query = false}) {
      final uri = Uri.tryParse(value);
      return uri != null &&
          ['http', 'https'].contains(uri.scheme) &&
          uri.host.isNotEmpty &&
          uri.userInfo.isEmpty &&
          !uri.hasFragment &&
          (query || !uri.hasQuery);
    }

    if (provider == 'custom') {
      if (!validUrl(uploadUrl, query: true)) errors.add('请填写有效的 HTTP(S) 上传接口');
      if (!RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(fileField)) {
        errors.add('文件字段名不正确');
      }
      if (!RegExp(r'^[a-zA-Z0-9_.-]+$').hasMatch(responseUrlPath) ||
          responseUrlPath
              .split('.')
              .any(
                (key) =>
                    ['__proto__', 'constructor', 'prototype', ''].contains(key),
              )) {
        errors.add('请填写有效的返回 URL 路径，例如 data.url');
      }
      if (authorization.contains(RegExp(r'[\r\n]'))) {
        errors.add('Authorization 不能包含换行');
      }
    } else {
      if (!validUrl(endpoint)) errors.add('请填写有效的 S3 Endpoint');
      if (!validUrl(publicBaseUrl)) errors.add('请填写公开访问地址');
      if (!RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$').hasMatch(bucket)) {
        errors.add('请填写 Bucket 名称');
      }
      if (accessKeyId.trim().isEmpty || secretAccessKey.trim().isEmpty) {
        errors.add('请填写 Access Key ID 和 Secret Access Key');
      }
      if (!RegExp(r'^[a-zA-Z0-9-]+$').hasMatch(region)) {
        errors.add('Region 不正确；R2 使用 auto');
      }
      if (prefix.split('/').any((part) => part == '.' || part == '..')) {
        errors.add('前缀不能包含 . 或 .. 路径段');
      }
      if ('$accessKeyId$sessionToken'.contains(RegExp(r'[\r\n]'))) {
        errors.add('凭据不能包含换行');
      }
    }
    return errors;
  }
}

class AiSettings {
  const AiSettings({
    this.enabled = false,
    this.baseUrl = 'https://api.openai.com/v1',
    this.model = '',
    this.apiKey = '',
  });
  final bool enabled;
  final String baseUrl, model, apiKey;
  factory AiSettings.fromJson(Map<String, dynamic> value) => AiSettings(
    enabled: value['enabled'] == true,
    baseUrl: '${value['baseUrl'] ?? 'https://api.openai.com/v1'}',
    model: '${value['model'] ?? ''}',
    apiKey: '${value['apiKey'] ?? ''}',
  );
  Map<String, dynamic> toJson({bool secrets = true}) => {
    'enabled': enabled,
    'baseUrl': baseUrl,
    'model': model,
    'apiKey': secrets ? apiKey : '',
  };
}

class AppSettings {
  const AppSettings({
    this.device = const DeviceSettings(),
    this.host = const HostSettings(),
    this.ai = const AiSettings(),
    this.theme = 'system',
  });
  final DeviceSettings device;
  final HostSettings host;
  final AiSettings ai;
  final String theme;
  AppSettings copyWith({
    DeviceSettings? device,
    HostSettings? host,
    AiSettings? ai,
    String? theme,
  }) => AppSettings(
    device: device ?? this.device,
    host: host ?? this.host,
    ai: ai ?? this.ai,
    theme: theme ?? this.theme,
  );
  Map<String, dynamic> toJson({bool secrets = true}) => {
    'device': device.toJson(secrets: secrets),
    'imageHost': host.toJson(secrets: secrets),
    'ai': ai.toJson(secrets: secrets),
    'theme': theme,
  };
  factory AppSettings.fromJson(Map<String, dynamic> value) => AppSettings(
    device: DeviceSettings.fromJson(
      Map<String, dynamic>.from(value['device'] as Map? ?? value),
    ),
    host: HostSettings.fromJson(
      Map<String, dynamic>.from(value['imageHost'] as Map? ?? {}),
    ),
    ai: AiSettings.fromJson(
      Map<String, dynamic>.from(value['ai'] as Map? ?? {}),
    ),
    theme: '${value['theme'] ?? 'system'}',
  );
}

class PrintRecord {
  PrintRecord({
    required this.at,
    required this.status,
    required this.summary,
    required this.nodes,
    required this.message,
  });
  final DateTime at;
  final String status, summary, message;
  final int nodes;
  Map<String, dynamic> toJson() => {
    'at': at.toIso8601String(),
    'status': status,
    'summary': summary,
    'nodes': nodes,
    'message': message,
  };
  factory PrintRecord.fromJson(Map<String, dynamic> value) => PrintRecord(
    at: DateTime.parse(value['at']),
    status: value['status'],
    summary: value['summary'],
    nodes: value['nodes'],
    message: value['message'],
  );
}
