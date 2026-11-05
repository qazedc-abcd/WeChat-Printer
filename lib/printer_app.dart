import 'package:flutter/material.dart';
import 'app_controller.dart';
import 'ui/home.dart';
import 'ui/theme.dart';

class PrinterApp extends StatefulWidget {
  const PrinterApp({super.key, this.controller, this.enableNativeDrop = true});
  final AppController? controller;
  final bool enableNativeDrop;
  @override
  State<PrinterApp> createState() => _PrinterAppState();
}

class _PrinterAppState extends State<PrinterApp> {
  late final AppController app = widget.controller ?? AppController();
  @override
  void initState() {
    super.initState();
    if (!app.ready) app.initialize();
  }

  @override
  void dispose() {
    if (widget.controller == null) app.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: app,
    builder: (_, _) => MaterialApp(
      title: '小票台',
      debugShowCheckedModeBanner: false,
      theme: printerTheme(Brightness.light),
      darkTheme: printerTheme(Brightness.dark),
      themeMode: app.settings.theme == 'light'
          ? ThemeMode.light
          : app.settings.theme == 'dark'
          ? ThemeMode.dark
          : ThemeMode.system,
      home: app.ready
          ? PrinterHome(
              controller: app,
              enableNativeDrop: widget.enableNativeDrop,
            )
          : const Scaffold(body: Center(child: CircularProgressIndicator())),
    ),
  );
}
