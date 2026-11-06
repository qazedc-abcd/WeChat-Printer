import 'dart:convert';
import 'dart:math' as math;
import 'package:markdown/markdown.dart' as md;
import 'models.dart';

typedef PrinterNode = Map<String, dynamic>;
const nativeQrMaxBytes = 100;
const localTableMaxColumns = 16;

String printableText(String value) => String.fromCharCodes(
  value.runes.where(
    (rune) =>
        !(rune >= 0x1f000 && rune <= 0x1ffff) &&
        ![0x200d, 0xfe0f].contains(rune),
  ),
);
bool publicImageUrl(String value) {
  final uri = Uri.tryParse(value);
  return uri != null &&
      ['http', 'https'].contains(uri.scheme) &&
      uri.host.isNotEmpty &&
      uri.userInfo.isEmpty;
}

class MarkdownIssue {
  const MarkdownIssue(this.line, this.message, {this.error = false});
  final int line;
  final String message;
  final bool error;
}

class _CenterLineSyntax extends md.BlockSyntax {
  const _CenterLineSyntax();

  @override
  RegExp get pattern => _marker;
  static final _marker = RegExp(
    r'^ {0,3}<center>(.+)</center>[ \t]*$',
    caseSensitive: false,
  );

  @override
  md.Node parse(md.BlockParser parser) {
    final text = _marker.firstMatch(parser.current.content)![1]!;
    parser.advance();
    return md.Element('center', [md.UnparsedContent(text)]);
  }
}

class ReceiptCompiler {
  md.Document get parser => md.Document(
    blockSyntaxes: const [_CenterLineSyntax()],
    extensionSet: md.ExtensionSet.gitHubFlavored,
    encodeHtml: false,
  );
  PrinterNode content(
    List<String> columns, {
    List<int>? align,
    List<int>? weights,
    int height = 0,
  }) => {
    'content': {
      'maxcolumn': columns.length,
      'column_align': List.generate(
        columns.length,
        (i) => {
          'column_width': weights?[i] ?? 1,
          'style': {'justification': align?[i] ?? 0},
        },
      ),
      'lines': {
        'linelist': [
          {'column': columns.map(printableText).toList()},
        ],
      },
      'style': {'height': height, 'width': 0},
    },
  };
  PrinterNode get spacer => {
    'text': {
      'column': [
        {'value': '__EOL__'},
      ],
      'column_align': [{}],
    },
  };
  PrinterNode get divider => {
    'divider': {
      'style': {'justification': 0, 'width': 0, 'height': 0},
    },
  };

  bool detectsMarkdown(String value) {
    if (RegExp(r'(^|\n)\s{0,3}#{1,6}[^#\s]').hasMatch(value)) return true;
    bool hasMarkup(md.Node node) =>
        node is md.Element &&
        (!['p', 'br'].contains(node.tag) ||
            (node.children ?? []).any(hasMarkup));
    return parser.parseLines(value.split('\n')).any(hasMarkup);
  }

  List<MarkdownIssue> lint(String source) {
    final issues = <MarkdownIssue>[];
    String? fence;
    int fenceLine = 1;
    for (final (i, line) in source.split('\n').indexed) {
      final marker = RegExp(r'^\s{0,3}(`{3,}|~{3,})').firstMatch(line);
      if (marker != null) {
        if (fence == null) {
          fence = marker[1];
          fenceLine = i + 1;
        } else if (marker[1]!.startsWith(fence[0]) &&
            marker[1]!.length >= fence.length) {
          fence = null;
        }
        continue;
      }
      if (fence != null) continue;
      if (RegExp(r'^\s{0,3}#{1,6}[^#\s]').hasMatch(line)) {
        issues.add(MarkdownIssue(i + 1, '标题标记后建议添加空格'));
      }
    }
    if (fence != null) {
      issues.add(MarkdownIssue(fenceLine, '代码围栏未显式闭合；会延续到文档末尾'));
    }
    final nodes = markdown(source);
    for (final node in nodes) {
      if (node['icon']?['type'] == 3 &&
          !publicImageUrl(node['icon']['value'])) {
        issues.add(const MarkdownIssue(1, '图片需要完整的 HTTP(S) 直链', error: true));
      }
      final cols = node['content']?['maxcolumn'] as int? ?? 0;
      if (cols > localTableMaxColumns) {
        issues.add(const MarkdownIssue(1, '超过本地 16 列限制，请拆分表格', error: true));
      } else if (cols >= 5) {
        issues.add(const MarkdownIssue(1, '5 列以上在实测设备上可能出现间距异常，建议控制在 4 列内'));
      }
    }
    return issues.take(30).toList();
  }

  List<PrinterNode> markdown(String source) {
    final output = <PrinterNode>[];
    void line(String text, {int align = 0, int height = 0}) {
      if (text.isNotEmpty) {
        output.add(content([text], align: [align], height: height));
      }
    }

    String flat(md.Node node) => node is md.Text
        ? node.text
        : (node as md.Element).tag == 'img'
        ? (node.attributes['alt'] ?? '[图片]')
        : (node.children ?? []).map(flat).join();
    void inline(
      List<md.Node> nodes, {
      String prefix = '',
      int align = 0,
      int height = 0,
    }) {
      var buffer = prefix;
      void flush() {
        line(buffer, align: align, height: height);
        buffer = '';
      }

      void visit(md.Node node) {
        if (node is md.Text) {
          buffer += node.text.replaceAll('\n', ' ');
          return;
        }
        final el = node as md.Element;
        if (el.tag == 'img') {
          flush();
          output.add({
            'icon': {
              'type': 3,
              'value': el.attributes['src'] ?? '',
              'style': {'justification': 1},
            },
          });
        } else if (el.tag == 'br') {
          flush();
        } else if (el.tag == 'a') {
          final text = el.textContent, href = el.attributes['href'] ?? '';
          buffer += text;
          if (href.isNotEmpty && href != text) buffer += ' ($href)';
        } else {
          for (final child in el.children ?? <md.Node>[]) {
            visit(child);
          }
        }
      }

      for (final node in nodes) {
        visit(node);
      }
      flush();
    }

    void tableRows(md.Element table) {
      final rows = [
        for (final section in table.children!.whereType<md.Element>())
          for (final row in section.children!.whereType<md.Element>())
            row.children!.whereType<md.Element>().toList(),
      ];
      if (rows.isEmpty) return;
      final values = rows.map((row) => row.map(flat).toList()).toList();
      final weights = <int>[], alignments = <int>[];
      final numeric = RegExp(
        r'^[¥￥$€£]?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$',
      );
      for (final (index, header) in rows.first.indexed) {
        var width = 2;
        for (final row in values) {
          // The printer wraps long cells. Limit their influence on other columns.
          final cells = printableText(
            row[index],
          ).runes.fold<int>(0, (sum, rune) => sum + (rune >= 0x2e80 ? 2 : 1));
          width = math.max(width, cells.clamp(2, 18));
        }
        weights.add(width);
        final data = values
            .skip(1)
            .map((row) => row[index].trim())
            .where((v) => v.isNotEmpty);
        alignments.add(switch (header.attributes['align']) {
          'center' => 1,
          'right' => 2,
          'left' => 0,
          _ => data.isNotEmpty && data.every(numeric.hasMatch) ? 2 : 0,
        });
      }
      for (final row in values) {
        output.add(content(row, align: alignments, weights: weights));
      }
    }

    void block(md.Node node, {String prefix = ''}) {
      if (node is md.Text) {
        line(prefix + node.text);
        return;
      }
      final el = node as md.Element, children = el.children ?? <md.Node>[];
      if (el.tag == 'hr') {
        output.add(divider);
      } else if (el.tag == 'table') {
        tableRows(el);
      } else if (el.tag == 'ul' || el.tag == 'ol') {
        var index = int.tryParse(el.attributes['start'] ?? '1') ?? 1;
        for (final child in children.whereType<md.Element>()) {
          final marker = el.tag == 'ol' ? '${index++}. ' : '- ';
          if ((child.children ?? []).any(
            (n) => n is md.Element && ['p', 'ul', 'ol'].contains(n.tag),
          )) {
            var first = true;
            for (final nested in child.children ?? <md.Node>[]) {
              block(nested, prefix: '$prefix${first ? marker : '  '}');
              first = false;
            }
          } else {
            inline(child.children ?? [], prefix: prefix + marker);
          }
        }
      } else if (el.tag == 'blockquote') {
        for (final child in children) {
          block(child, prefix: '$prefix> ');
        }
      } else if (el.tag == 'pre') {
        for (final text
            in el.textContent.replaceFirst(RegExp(r'\n$'), '').split('\n')) {
          output.add(text.isEmpty ? spacer : content([prefix + text]));
        }
      } else {
        inline(
          children,
          prefix: prefix,
          align: el.tag == 'h1' || el.tag == 'center' ? 1 : 0,
          height: el.tag == 'h1' ? 1 : 0,
        );
      }
    }

    for (final node in parser.parseLines(
      source.replaceAll('\r\n', '\n').split('\n'),
    )) {
      block(node);
    }
    return output;
  }

  List<PrinterNode> compile(List<ReceiptBlock> blocks) {
    final root = <PrinterNode>[];
    for (final block in blocks) {
      switch (block.kind) {
        case BlockKind.text:
          if (block.autoMarkdown && detectsMarkdown(block.text)) {
            root.addAll(markdown(block.text));
          } else if (block.text.trim().isNotEmpty) {
            root.add(content([block.text], align: [block.align]));
          }
        case BlockKind.markdown:
          root.addAll(markdown(block.text));
        case BlockKind.image:
          if (block.imageBytes != null || block.url.trim().isNotEmpty) {
            root.add({
              'icon': {
                'type': 3,
                'value': block.url.trim().isEmpty
                    ? 'local-image://${block.id}'
                    : block.url.trim(),
                'style': {'justification': block.align},
              },
            });
          }
        case BlockKind.qr:
          if (block.text.trim().isNotEmpty) {
            root.add({
              'icon': {
                'type': 1,
                'value': printableText(block.text.trim()),
                'style': {'justification': block.align},
              },
            });
          }
        case BlockKind.divider:
          root.add(divider);
        case BlockKind.spacer:
          root.add(spacer);
      }
    }
    return root;
  }

  void validate(List<PrinterNode> nodes) {
    if (nodes.isEmpty) throw const FormatException('请先添加要打印的内容');
    for (final node in nodes) {
      final icon = node['icon'];
      if (icon?['type'] == 1 &&
          utf8.encode(icon['value'] as String).length > nativeQrMaxBytes) {
        throw const FormatException(
          '原生二维码最多 100 UTF-8 字节，请缩短内容；长内容在实测设备上曾导致重启',
        );
      }
      if (icon?['type'] == 3 && !publicImageUrl(icon['value'])) {
        throw const FormatException('图片需要先处理并上传到图床');
      }
      if ((node['content']?['maxcolumn'] as int? ?? 0) > localTableMaxColumns) {
        throw const FormatException('表格超过本地 16 列限制，请拆分');
      }
    }
  }
}
