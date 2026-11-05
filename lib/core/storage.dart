import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'models.dart';

abstract class AppStore {
  Future<AppSettings> loadSettings();
  Future<void> saveSettings(AppSettings settings);
  Future<List<ReceiptBlock>> loadDraft();
  Future<void> saveDraft(List<ReceiptBlock> blocks);
  Future<List<PrintRecord>> loadHistory();
  Future<void> saveHistory(List<PrintRecord> records);
}

class LocalStore implements AppStore {
  static const _secretsKey = 'wechat-printer.print-only.settings.v1';
  static const _draftKey = 'wechat-printer.print-only.draft.v1';
  static const _historyKey = 'wechat-printer.print-only.history.v1';
  final FlutterSecureStorage secure = const FlutterSecureStorage();
  @override
  Future<AppSettings> loadSettings() async {
    final value = await secure.read(key: _secretsKey);
    return value == null
        ? const AppSettings()
        : AppSettings.fromJson(jsonDecode(value));
  }

  @override
  Future<void> saveSettings(AppSettings settings) =>
      secure.write(key: _secretsKey, value: jsonEncode(settings.toJson()));
  @override
  Future<List<ReceiptBlock>> loadDraft() async {
    final value = (await SharedPreferences.getInstance()).getString(_draftKey);
    return value == null
        ? []
        : (jsonDecode(value) as List)
              .map(
                (item) =>
                    ReceiptBlock.fromJson(Map<String, dynamic>.from(item)),
              )
              .toList();
  }

  @override
  Future<void> saveDraft(List<ReceiptBlock> blocks) async {
    final okay = await (await SharedPreferences.getInstance()).setString(
      _draftKey,
      jsonEncode(blocks.map((block) => block.toJson()).toList()),
    );
    if (!okay) throw const FormatException('草稿保存失败');
  }

  @override
  Future<List<PrintRecord>> loadHistory() async {
    final value = (await SharedPreferences.getInstance()).getString(
      _historyKey,
    );
    return value == null
        ? []
        : (jsonDecode(value) as List)
              .map(
                (item) => PrintRecord.fromJson(Map<String, dynamic>.from(item)),
              )
              .toList();
  }

  @override
  Future<void> saveHistory(List<PrintRecord> records) async {
    final okay = await (await SharedPreferences.getInstance()).setString(
      _historyKey,
      jsonEncode(records.take(50).map((item) => item.toJson()).toList()),
    );
    if (!okay) throw const FormatException('打印记录保存失败');
  }
}

class MemoryStore implements AppStore {
  AppSettings settings = const AppSettings();
  List<ReceiptBlock> draft = [];
  List<PrintRecord> records = [];
  @override
  Future<AppSettings> loadSettings() async => settings;
  @override
  Future<void> saveSettings(AppSettings settings) async {
    this.settings = settings;
  }

  @override
  Future<List<ReceiptBlock>> loadDraft() async => draft;
  @override
  Future<void> saveDraft(List<ReceiptBlock> blocks) async {
    draft = blocks.map((b) => b.copy()).toList();
  }

  @override
  Future<List<PrintRecord>> loadHistory() async => records;
  @override
  Future<void> saveHistory(List<PrintRecord> records) async {
    this.records = records.toList();
  }
}
