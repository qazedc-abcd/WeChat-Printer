import 'package:flutter/material.dart';
import 'paste_text_field.dart';

class DeviceJsonDialog extends StatefulWidget {
  const DeviceJsonDialog({super.key, this.initialText = ''});
  final String initialText;
  @override
  State<DeviceJsonDialog> createState() => _DeviceJsonDialogState();
}

class _DeviceJsonDialogState extends State<DeviceJsonDialog> {
  late final editor = TextEditingController(text: widget.initialText);
  @override
  void dispose() {
    editor.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('导入设备 JSON'),
    scrollable: true,
    content: SizedBox(
      width: 460,
      child: PasteTextField(
        controller: editor,
        autofocus: true,
        minLines: 6,
        maxLines: 12,
        keyboardType: TextInputType.multiline,
        pasteReplacesAll: true,
        pasteTooltip: '重新粘贴 JSON',
        decoration: const InputDecoration(
          labelText: '设备 JSON',
          hintText: '可粘贴 SID 助手导出的设备 JSON，或旧版 config.json',
          helperText: '可直接点右侧粘贴按钮，再检查内容并导入。',
          helperMaxLines: 2,
          alignLabelWithHint: true,
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(
        onPressed: () => Navigator.pop(context, editor.text),
        child: const Text('导入'),
      ),
    ],
  );
}
