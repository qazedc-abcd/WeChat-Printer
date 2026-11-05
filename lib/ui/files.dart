import 'dart:io';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/services.dart';

Future<bool> saveUserFile(String name, Uint8List bytes) async {
  if (Platform.isAndroid) {
    final result = await const MethodChannel(
      'xyz.wechatprinter.files',
    ).invokeMethod<bool>('saveDocument', {'name': name, 'bytes': bytes});
    return result == true;
  }
  final location = await getSaveLocation(
    suggestedName: name,
    acceptedTypeGroups: const [
      XTypeGroup(label: 'JSON 文档', extensions: ['json']),
    ],
  );
  if (location == null) return false;
  await XFile.fromData(
    bytes,
    name: name,
    mimeType: 'application/json',
  ).saveTo(location.path);
  return true;
}
