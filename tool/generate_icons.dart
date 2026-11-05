import 'dart:io';
import 'dart:typed_data';
import 'package:image/image.dart' as img;

void main() {
  final icon = img.Image(width: 256, height: 256, numChannels: 4);
  for (var y = 0; y < 256; y++) {
    for (var x = 0; x < 256; x++) {
      final cx = x.clamp(52, 203), cy = y.clamp(52, 203);
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= 52 * 52) {
        icon.setPixelRgba(x, y, 56, 107, 92, 255);
      }
      if (x >= 73 && x <= 183 && y >= 50 && y <= 198) {
        final notch = y > 185 && ((x - 73) ~/ 14).isOdd;
        if (!notch) icon.setPixelRgba(x, y, 247, 249, 243, 255);
      }
      if (x >= 94 &&
          x <= 162 &&
          ((y >= 83 && y <= 91) ||
              (y >= 113 && y <= 121) ||
              (y >= 143 && y <= 151))) {
        icon.setPixelRgba(x, y, 56, 107, 92, 255);
      }
    }
  }
  final sizes = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
  };
  sizes.forEach((density, size) {
    File(
      'android/app/src/main/res/mipmap-$density/ic_launcher.png',
    ).writeAsBytesSync(
      img.encodePng(img.copyResize(icon, width: size, height: size)),
    );
  });
  final png = img.encodePng(icon);
  final header = ByteData(22)
    ..setUint16(2, 1, Endian.little)
    ..setUint16(4, 1, Endian.little)
    ..setUint16(10, 1, Endian.little)
    ..setUint16(12, 32, Endian.little)
    ..setUint32(14, png.length, Endian.little)
    ..setUint32(18, 22, Endian.little);
  File(
    'windows/runner/resources/app_icon.ico',
  ).writeAsBytesSync([...header.buffer.asUint8List(), ...png]);
}
