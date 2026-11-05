import 'dart:math' as math;
import 'dart:typed_data';
import 'package:image/image.dart' as img;

const imageByteLimit = 20 * 1024 * 1024;
const processedImageSize = 280;

/// Runs in a compute isolate. Input may be PNG/JPEG/WebP/GIF; output is opaque PNG.
Map<String, dynamic> processImage(Map<String, dynamic> options) {
  final bytes = options['bytes'] as Uint8List;
  if (bytes.isEmpty || bytes.length > imageByteLimit) {
    throw const FormatException('单张图片请控制在 20 MiB 以内');
  }
  final decoder = img.findDecoderForData(bytes);
  final info = decoder?.startDecode(bytes);
  if (info == null) {
    throw const FormatException('无法识别图片，请使用 PNG、JPEG、WebP 或 GIF');
  }
  if (info.width * info.height > 40000000) {
    throw const FormatException('图片超过本地 4000 万像素内存保护限制，请先缩小');
  }
  final decoded = decoder!.decodeFrame(0);
  if (decoded == null) throw const FormatException('图片解码失败');
  var source = img
      .bakeOrientation(decoded)
      .convert(format: img.Format.uint8, numChannels: 4);
  final fit = options['fit'] as String? ?? 'contain';
  if (fit == 'crop') {
    final zoom = (options['zoom'] as num? ?? 1).toDouble().clamp(1.0, 4.0);
    final side = math.max(
      1,
      (math.min(source.width, source.height) / zoom).round(),
    );
    final x =
        (((options['x'] as num? ?? 0).toDouble().clamp(-1.0, 1.0) + 1) /
                2 *
                (source.width - side))
            .round();
    final y =
        (((options['y'] as num? ?? 0).toDouble().clamp(-1.0, 1.0) + 1) /
                2 *
                (source.height - side))
            .round();
    source = img.copyCrop(source, x: x, y: y, width: side, height: side);
  }
  final factor = processedImageSize / math.max(source.width, source.height);
  final resized = img.copyResize(
    source,
    width: math.max(1, (source.width * factor).round()),
    height: math.max(1, (source.height * factor).round()),
    interpolation: img.Interpolation.average,
  );
  final left = (processedImageSize - resized.width) ~/ 2;
  final top = (processedImageSize - resized.height) ~/ 2;
  final gray = Float32List(processedImageSize * processedImageSize)
    ..fillRange(0, processedImageSize * processedImageSize, 255);
  final gamma = (options['gamma'] as num? ?? 1).toDouble().clamp(0.3, 3.0);
  final contrast = (options['contrast'] as num? ?? 0).toDouble().clamp(
    -100.0,
    100.0,
  );
  final contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  for (var y = 0; y < resized.height; y++) {
    for (var x = 0; x < resized.width; x++) {
      final p = resized.getPixel(x, y);
      final alpha = p.a / 255;
      var luminance =
          (0.299 * p.r + 0.587 * p.g + 0.114 * p.b) * alpha + 255 * (1 - alpha);
      luminance =
          255 * math.pow(luminance.clamp(0, 255) / 255, 1 / gamma).toDouble();
      luminance = (contrastFactor * (luminance - 128) + 128)
          .clamp(0, 255)
          .toDouble();
      gray[(top + y) * processedImageSize + left + x] = luminance;
    }
  }
  final output = img.Image(
    width: processedImageSize,
    height: processedImageSize,
    numChannels: 3,
  );
  final dither = options['dither'] != false;
  final threshold = (options['threshold'] as num? ?? 128).toDouble();
  void add(int x, int y, double value) {
    if (x >= 0 && x < processedImageSize && y >= 0 && y < processedImageSize) {
      gray[y * processedImageSize + x] += value;
    }
  }

  for (var y = 0; y < processedImageSize; y++) {
    for (var x = 0; x < processedImageSize; x++) {
      final old = gray[y * processedImageSize + x];
      final next = old < threshold ? 0 : 255;
      output.setPixelRgb(x, y, next, next, next);
      if (dither) {
        final error = old - next;
        add(x + 1, y, error * 7 / 16);
        add(x - 1, y + 1, error * 3 / 16);
        add(x, y + 1, error * 5 / 16);
        add(x + 1, y + 1, error / 16);
      }
    }
  }
  return {
    'bytes': Uint8List.fromList(img.encodePng(output)),
    'width': info.width,
    'height': info.height,
  };
}
