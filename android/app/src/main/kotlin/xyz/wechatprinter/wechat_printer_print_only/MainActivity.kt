package xyz.wechatprinter.wechat_printer_print_only

import android.app.Activity
import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var saveResult: MethodChannel.Result? = null
    private var saveBytes: ByteArray? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "xyz.wechatprinter.files")
            .setMethodCallHandler { call, result ->
                if (call.method != "saveDocument") {
                    result.notImplemented()
                } else if (saveResult != null) {
                    result.error("busy", "已有文件保存操作", null)
                } else {
                    val bytes = call.argument<ByteArray>("bytes")
                    if (bytes == null || bytes.size > 10 * 1024 * 1024) {
                        result.error("invalid", "文档为空或超过本地导出限制", null)
                    } else {
                        saveResult = result
                        saveBytes = bytes
                        val name = (call.argument<String>("name") ?: "receipt.json")
                            .substringAfterLast('/').substringAfterLast('\\')
                        try {
                            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = "application/json"
                                putExtra(Intent.EXTRA_TITLE, name)
                            }
                            @Suppress("DEPRECATION")
                            startActivityForResult(intent, 8120)
                        } catch (_: Exception) {
                            saveResult = null
                            saveBytes = null
                            result.error("save", "无法打开系统保存位置", null)
                        }
                    }
                }
            }
    }

    @Deprecated("Legacy result bridge for ACTION_CREATE_DOCUMENT")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 8120) return
        val result = saveResult ?: return
        val bytes = saveBytes
        saveResult = null
        saveBytes = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null || bytes == null) {
            result.success(false)
            return
        }
        try {
            val output = contentResolver.openOutputStream(uri)
                ?: throw IllegalStateException("No output stream")
            output.use { it.write(bytes) }
            result.success(true)
        } catch (_: Exception) {
            result.error("save", "文档保存失败", null)
        }
    }
}
