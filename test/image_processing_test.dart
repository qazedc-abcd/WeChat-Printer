import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:wechat_printer_print_only/core/image_processing.dart';

void main() {
  test(
    'transparent pixels become white and output is opaque 280-square PNG',
    () {
      final source = img.Image(width: 16, height: 64, numChannels: 4);
      final result = processImage({
        'bytes': Uint8List.fromList(img.encodePng(source)),
        'fit': 'contain',
      });
      final output = img.decodePng(result['bytes'])!;
      expect(output.width, 280);
      expect(output.height, 280);
      expect(output.numChannels, 3);
      for (final pixel in output) {
        expect(pixel.r, 255);
        expect(pixel.g, 255);
        expect(pixel.b, 255);
      }
    },
  );
  test(
    'contain keeps image geometry and crop fills a square without stretching',
    () {
      final source = img.Image(width: 40, height: 160, numChannels: 3);
      final bytes = Uint8List.fromList(img.encodePng(source));
      final contained = img.decodePng(
        processImage({'bytes': bytes, 'fit': 'contain'})['bytes'],
      )!;
      expect(contained.getPixel(0, 140).r, 255);
      expect(contained.getPixel(140, 140).r, 0);
      final cropped = img.decodePng(
        processImage({
          'bytes': bytes,
          'fit': 'crop',
          'zoom': 2,
          'x': 1,
          'y': -1,
        })['bytes'],
      )!;
      expect(cropped.getPixel(0, 0).r, 0);
      expect(cropped.getPixel(279, 279).r, 0);
    },
  );
  test(
    'JPEG input converts to deterministic binary PNG; bad data is rejected',
    () {
      final source = img.Image(width: 32, height: 32, numChannels: 3);
      for (final pixel in source) {
        pixel.setRgb(pixel.x * 8, pixel.x * 8, pixel.x * 8);
      }
      final bytes = Uint8List.fromList(img.encodeJpg(source));
      final a = processImage({'bytes': bytes})['bytes'];
      final b = processImage({'bytes': bytes})['bytes'];
      expect(a, b);
      final output = img.decodePng(a)!;
      expect(output.any((pixel) => pixel.r == 0), true);
      expect(output.any((pixel) => pixel.r == 255), true);
      expect(output.every((pixel) => pixel.r == 0 || pixel.r == 255), true);
      expect(
        () => processImage({
          'bytes': Uint8List.fromList([1, 2, 3]),
        }),
        throwsFormatException,
      );
    },
  );
}
