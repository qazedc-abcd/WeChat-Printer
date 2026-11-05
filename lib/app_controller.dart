import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'core/ai_checker.dart';
import 'core/image_host.dart';
import 'core/image_processing.dart';
import 'core/models.dart';
import 'core/network.dart';
import 'core/print_api.dart';
import 'core/receipt_compiler.dart';
import 'core/storage.dart';

class AppController extends ChangeNotifier {
  AppController({AppStore? store, Network? network})
    : store = store ?? LocalStore(),
      network = network ?? Network();
  final AppStore store;
  final Network network;
  final ReceiptCompiler compiler = ReceiptCompiler();
  List<PrinterNode>? _nodes;
  AppSettings settings = const AppSettings();
  List<ReceiptBlock> blocks = [];
  List<PrintRecord> history = [];
  bool ready = false, sending = false;
  String? notice;
  String progress = '';
  Timer? _saveTimer;
  final Map<String, String> _uploaded = {};
  final Map<String, Future<String>> _uploads = {};
  final Set<String> uploadingImages = {};
  bool _disposed = false;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> initialize() async {
    try {
      settings = await store.loadSettings();
      blocks = await store.loadDraft();
      history = await store.loadHistory();
    } catch (_) {
      notice = '本地数据读取失败，请在设置中重新检查配置';
    }
    if (blocks.isEmpty) blocks = [ReceiptBlock(kind: BlockKind.text)];
    ready = true;
    _notify();
  }

  List<PrinterNode> get nodes => _nodes ??= compiler.compile(blocks);
  String get summary {
    final text = blocks
        .map((b) => b.kind == BlockKind.image ? '[图片]' : b.text)
        .where((s) => s.isNotEmpty)
        .join(' ');
    return text.runes.take(60).map(String.fromCharCode).join();
  }

  void changed() {
    _nodes = null;
    _saveTimer?.cancel();
    final snapshot = blocks.map((b) => b.copy()).toList();
    _saveTimer = Timer(const Duration(milliseconds: 450), () async {
      try {
        await store.saveDraft(snapshot);
      } catch (_) {
        notice = '草稿未能保存，请导出文档备份';
        _notify();
      }
    });
    _notify();
  }

  void add(BlockKind kind, {String text = ''}) {
    blocks.add(
      ReceiptBlock(
        kind: kind,
        text: text,
        align: kind == BlockKind.image || kind == BlockKind.qr ? 1 : 0,
      ),
    );
    changed();
  }

  void remove(ReceiptBlock block) {
    blocks.remove(block);
    if (blocks.isEmpty) add(BlockKind.text);
    changed();
  }

  void move(ReceiptBlock block, int offset) {
    final from = blocks.indexOf(block), to = blocks.indexOf(block) + offset;
    if (from < 0 || to < 0 || to >= blocks.length) return;
    blocks.removeAt(from);
    blocks.insert(to, block);
    changed();
  }

  void newDocument() {
    blocks = [ReceiptBlock(kind: BlockKind.text)];
    changed();
  }

  void example() {
    blocks = [
      ReceiptBlock(
        kind: BlockKind.markdown,
        text:
            '# 今日的小确幸\n\n把想做的事，写在一张小票上。\n\n---\n\n- [ ] 喝一杯喜欢的咖啡\n- [ ] 读完手边的书\n- [ ] 出门走走\n\n| 今日清单 | 数量 |\n| --- | ---: |\n| 热拿铁 | 1 |\n| 好心情 | 无限 |\n\n> 留一点时间，给自己。',
      ),
    ];
    changed();
  }

  Future<void> saveSettings(AppSettings value) async {
    await store.saveSettings(value);
    settings = value;
    _uploaded.clear();
    _notify();
  }

  Future<void> importSettings(Map<String, dynamic> value) async {
    final full = value['device'] is Map || value['imageHost'] is Map;
    final incoming = AppSettings.fromJson(value);
    await saveSettings(
      full ? incoming : settings.copyWith(device: incoming.device),
    );
  }

  Map<String, dynamic> exportDocument() => {
    'format': 'wechat-printer-document',
    'version': 1,
    'blocks': blocks.map((b) => b.toJson()).toList(),
  };
  void importDocument(Map<String, dynamic> value) {
    if (value['format'] != 'wechat-printer-document' ||
        value['blocks'] is! List) {
      throw const FormatException('不是小票台文档，请使用设备 JSON 导入入口');
    }
    final list = value['blocks'] as List;
    if (list.length > 500) throw const FormatException('文档超过本地 500 个编辑块限制');
    final imported = list
        .map((item) => ReceiptBlock.fromJson(Map<String, dynamic>.from(item)))
        .toList();
    blocks = imported.isEmpty ? [ReceiptBlock(kind: BlockKind.text)] : imported;
    changed();
  }

  Future<Uint8List> process(
    Uint8List source,
    Map<String, dynamic> options,
  ) async =>
      (await compute(processImage, {'bytes': source, ...options}))['bytes']
          as Uint8List;
  Future<String> uploadImage(Uint8List png, {HostSettings? host}) async =>
      ImageHost(network).upload(png, host ?? settings.host);
  Future<String> _uploadProcessed(Uint8List png, HostSettings host) async {
    final key = '${jsonEncode(host.toJson())}:${base64Encode(png)}';
    if (_uploaded.containsKey(key)) return _uploaded[key]!;
    final task = _uploads.putIfAbsent(key, () => uploadImage(png, host: host));
    try {
      final direct = await task;
      _uploaded[key] = direct;
      return direct;
    } finally {
      _uploads.remove(key);
    }
  }

  Future<void> uploadBlock(ReceiptBlock block) async {
    final png = block.imageBytes;
    if (png == null) return;
    final host = settings.host;
    uploadingImages.add(block.id);
    _notify();
    try {
      final url = await _uploadProcessed(png, host);
      if (identical(block.imageBytes, png) &&
          jsonEncode(settings.host.toJson()) == jsonEncode(host.toJson())) {
        block.url = url;
        changed();
      }
    } finally {
      uploadingImages.remove(block.id);
      _notify();
    }
  }

  Future<AiSuggestion> checkAi(String text) =>
      AiChecker(network).check(text, settings.ai);
  Future<void> clearHistory() async {
    await store.saveHistory([]);
    history = [];
    _notify();
  }

  String requestPreview() => const JsonEncoder.withIndent(
    '  ',
  ).convert(PrintApi(network).payload(settings.device, nodes, redact: true));
  Future<PrintOutcome> print() async {
    if (sending) throw const FormatException('已有请求正在发送');
    if (!settings.device.configured) {
      throw const FormatException('请先配置设备 SN 和 SID');
    }
    final snapshot = blocks.map((b) => b.copy()).toList();
    final config = settings;
    var prepared = compiler.compile(snapshot);
    // QR safety is checked before image uploads or any real printer request.
    for (final node in prepared) {
      if (node['icon']?['type'] == 1 &&
          utf8.encode(node['icon']['value']).length > nativeQrMaxBytes) {
        throw const FormatException('原生二维码最多 100 UTF-8 字节，请缩短内容');
      }
    }
    if (prepared.isEmpty) throw const FormatException('请先添加打印内容');
    sending = true;
    progress = '正在准备内容';
    notice = null;
    _notify();
    try {
      for (final block in snapshot.where(
        (b) => b.kind == BlockKind.image && b.imageBytes != null,
      )) {
        progress = '正在上传图片';
        _notify();
        block.url = await _uploadProcessed(block.imageBytes!, config.host);
      }
      prepared = compiler.compile(snapshot);
      for (final node in prepared.where((n) => n['icon']?['type'] == 3)) {
        final source = node['icon']['value'] as String;
        final local = snapshot.any(
          (b) =>
              b.kind == BlockKind.image &&
              b.imageBytes != null &&
              b.url == source,
        );
        if (local) continue;
        if (!publicImageUrl(source)) {
          throw const FormatException('图片需要完整的 HTTP(S) 直链');
        }
        progress = '正在处理远程图片';
        _notify();
        final key = '${jsonEncode(config.host.toJson())}:$source';
        if (!_uploaded.containsKey(key)) {
          final bytes = await network.image(source);
          final processed = await process(bytes, {'fit': 'contain'});
          _uploaded[key] = await uploadImage(processed, host: config.host);
        }
        node['icon']['value'] = _uploaded[key];
      }
      compiler.validate(prepared);
      progress = '正在发送打印请求';
      _notify();
      final outcome = await PrintApi(network).send(config.device, prepared);
      history.insert(
        0,
        PrintRecord(
          at: DateTime.now(),
          status: outcome.status,
          summary: summary,
          nodes: prepared.length,
          message: outcome.message,
        ),
      );
      if (history.length > 50) history = history.take(50).toList();
      try {
        await store.saveHistory(history);
      } catch (_) {
        notice = '本次结果未能写入本地记录';
      }
      return outcome;
    } finally {
      sending = false;
      progress = '';
      _notify();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _saveTimer?.cancel();
    network.close();
    super.dispose();
  }
}
