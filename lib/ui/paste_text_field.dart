import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Read only after a paste gesture. Android uses the foreground Activity so
/// rich clipboard text does not depend on Clipboard.hasStrings/menu discovery.
Future<String?> readClipboardText() async {
  if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
    try {
      final text = await const MethodChannel('xyz.wechatprinter.files')
          .invokeMethod<String>('readClipboardText')
          .timeout(const Duration(seconds: 3));
      if (text != null) return text;
    } on MissingPluginException {
      // Widget tests and older hosts can use the standard Flutter bridge.
    } on PlatformException {
      // Fall back to the platform clipboard when coercion is unavailable.
    } on TimeoutException {
      // A slow provider must not leave the paste button disabled indefinitely.
    }
  }
  return (await Clipboard.getData(
    Clipboard.kTextPlain,
  ).timeout(const Duration(seconds: 3)))?.text;
}

TextEditingValue pastedValue(
  TextEditingValue current,
  String incoming, {
  bool replaceAll = false,
  bool multiline = true,
}) {
  final text = multiline
      ? incoming
      : incoming.replaceAll(RegExp(r'[\r\n]+'), ' ');
  final selection = current.selection;
  final valid =
      selection.isValid &&
      selection.start <= current.text.length &&
      selection.end <= current.text.length;
  final start = replaceAll
      ? 0
      : valid
      ? selection.start
      : current.text.length;
  final end = replaceAll
      ? current.text.length
      : valid
      ? selection.end
      : current.text.length;
  return TextEditingValue(
    text: current.text.replaceRange(start, end, text),
    selection: TextSelection.collapsed(offset: start + text.length),
    composing: TextRange.empty,
  );
}

class PasteTextField extends StatefulWidget {
  const PasteTextField({
    super.key,
    required this.controller,
    this.onChanged,
    this.decoration = const InputDecoration(),
    this.minLines,
    this.maxLines = 1,
    this.obscureText = false,
    this.keyboardType,
    this.autocorrect = true,
    this.enableSuggestions = true,
    this.autofocus = false,
    this.style,
    this.pasteReplacesAll = false,
    this.pasteTooltip = '粘贴',
  });
  final TextEditingController controller;
  final ValueChanged<String>? onChanged;
  final InputDecoration decoration;
  final int? minLines, maxLines;
  final bool obscureText,
      autocorrect,
      enableSuggestions,
      autofocus,
      pasteReplacesAll;
  final TextInputType? keyboardType;
  final TextStyle? style;
  final String pasteTooltip;
  @override
  State<PasteTextField> createState() => _PasteTextFieldState();
}

class _PasteTextFieldState extends State<PasteTextField> {
  final focus = FocusNode();
  bool pasting = false;
  @override
  void dispose() {
    focus.dispose();
    super.dispose();
  }

  Future<void> paste({bool? replaceAll}) async {
    if (pasting) return;
    setState(() => pasting = true);
    try {
      final text = await readClipboardText();
      if (!mounted) return;
      if (text == null || text.isEmpty) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('剪贴板中没有可粘贴的文字，请重新复制后再试')));
        return;
      }
      if (text.length > 2 * 1024 * 1024) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('剪贴板文字过大，请改用文件导入')));
        return;
      }
      final next = pastedValue(
        widget.controller.value,
        text,
        replaceAll: replaceAll ?? widget.pasteReplacesAll,
        multiline: widget.maxLines != 1,
      );
      widget.controller.value = next;
      widget.onChanged?.call(next.text);
      focus.requestFocus();
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('暂时无法读取系统剪贴板，请重新复制后再试')));
      }
    } finally {
      if (mounted) setState(() => pasting = false);
    }
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.keyV, control: true): () {
        unawaited(paste(replaceAll: false));
      },
      const SingleActivator(LogicalKeyboardKey.keyV, meta: true): () {
        unawaited(paste(replaceAll: false));
      },
    },
    child: TextField(
      controller: widget.controller,
      focusNode: focus,
      onChanged: widget.onChanged,
      minLines: widget.minLines,
      maxLines: widget.maxLines,
      obscureText: widget.obscureText,
      keyboardType: widget.keyboardType,
      autocorrect: widget.autocorrect,
      enableSuggestions: widget.enableSuggestions,
      autofocus: widget.autofocus,
      enableInteractiveSelection: true,
      magnifierConfiguration: TextMagnifierConfiguration.disabled,
      style: widget.style,
      decoration: widget.decoration.copyWith(
        suffixIcon: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (widget.decoration.suffixIcon != null)
              widget.decoration.suffixIcon!,
            IconButton(
              tooltip: widget.pasteTooltip,
              onPressed: pasting
                  ? null
                  : () {
                      unawaited(paste());
                    },
              icon: pasting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.content_paste_rounded, size: 20),
            ),
          ],
        ),
      ),
      contextMenuBuilder: (context, editable) =>
          AdaptiveTextSelectionToolbar.buttonItems(
            anchors: editable.contextMenuAnchors,
            buttonItems: [
              ContextMenuButtonItem(
                type: ContextMenuButtonType.paste,
                label: '粘贴',
                onPressed: () {
                  editable.hideToolbar();
                  unawaited(paste(replaceAll: false));
                },
              ),
              ...editable.contextMenuButtonItems.where(
                (item) => item.type != ContextMenuButtonType.paste,
              ),
            ],
          ),
    ),
  );
}
