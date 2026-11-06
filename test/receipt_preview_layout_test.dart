import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wechat_printer_print_only/core/receipt_compiler.dart';
import 'package:wechat_printer_print_only/ui/receipt_preview.dart';

void main() {
  testWidgets('paper preview uses the printer column weights and alignment', (
    tester,
  ) async {
    final compiler = ReceiptCompiler();
    final table = compiler.content(['商品', '价格'], align: [0, 2]);
    table['content']['column_align'][0]['column_width'] = 3;
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: ReceiptPreview(
            nodes: [
              ...compiler.markdown('# 标题\n\n<center>门店</center>\n\n正文'),
              table,
            ],
          ),
        ),
      ),
    );
    TextAlign? align(String text) =>
        tester.widget<Text>(find.text(text)).textAlign;
    expect(align('标题'), TextAlign.center);
    expect(align('门店'), TextAlign.center);
    expect(
      tester.getSize(find.text('标题')).height,
      closeTo(2 * tester.getSize(find.text('正文')).height, 1),
    );
    expect(align('正文'), TextAlign.left);
    expect(align('价格'), TextAlign.right);
    final productWidth = tester.getSize(find.text('商品')).width;
    final priceWidth = tester.getSize(find.text('价格')).width;
    expect(productWidth, closeTo(3 * priceWidth, .01));
  });
}
