import 'package:flutter/material.dart';
import '../app_controller.dart';
import 'theme.dart';

class HistoryPage extends StatelessWidget {
  const HistoryPage({super.key, required this.controller});
  final AppController controller;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 920),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SectionTitle(
                '打印记录',
                subtitle: '最近 50 次发送结果，仅保存在这台设备上。',
                trailing: IconButton(
                  tooltip: '清除记录',
                  onPressed: controller.history.isEmpty
                      ? null
                      : () async {
                          final yes = await showDialog<bool>(
                            context: context,
                            builder: (context) => AlertDialog(
                              title: const Text('清除本机打印记录？'),
                              content: const Text('这不会影响设备上的任务，也不会删除图床图片。'),
                              actions: [
                                TextButton(
                                  onPressed: () =>
                                      Navigator.pop(context, false),
                                  child: const Text('取消'),
                                ),
                                FilledButton(
                                  onPressed: () => Navigator.pop(context, true),
                                  child: const Text('清除'),
                                ),
                              ],
                            ),
                          );
                          if (yes == true) {
                            try {
                              await controller.clearHistory();
                            } catch (_) {
                              if (context.mounted) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(content: Text('记录清除失败')),
                                );
                              }
                            }
                          }
                        },
                  icon: const Icon(Icons.delete_sweep_outlined),
                ),
              ),
              if (controller.history.isEmpty)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      vertical: 72,
                      horizontal: 24,
                    ),
                    child: Column(
                      children: [
                        Icon(
                          Icons.history_rounded,
                          size: 46,
                          color: scheme.outline,
                        ),
                        const SizedBox(height: 20),
                        const Text(
                          '还没有打印记录',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '发送第一张小票后，结果会出现在这里。',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                ),
              for (final item in controller.history)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: item.status == 'accepted'
                                  ? scheme.secondaryContainer
                                  : scheme.errorContainer,
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: Icon(
                              item.status == 'accepted'
                                  ? Icons.outgoing_mail
                                  : item.status == 'unknown'
                                  ? Icons.help_outline_rounded
                                  : Icons.error_outline_rounded,
                              color: item.status == 'accepted'
                                  ? scheme.onSecondaryContainer
                                  : scheme.onErrorContainer,
                            ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  item.summary.isEmpty ? '小票内容' : item.summary,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  item.message,
                                  style: TextStyle(
                                    color: scheme.onSurfaceVariant,
                                    fontSize: 12,
                                    height: 1.6,
                                  ),
                                ),
                                const SizedBox(height: 10),
                                Text(
                                  '${_time(item.at)}  ·  ${item.nodes} 个打印节点',
                                  style: TextStyle(
                                    color: scheme.outline,
                                    fontSize: 11,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  String _time(DateTime value) {
    final d = value.toLocal();
    String pad(int n) => n.toString().padLeft(2, '0');
    return '${d.year}/${pad(d.month)}/${pad(d.day)} ${pad(d.hour)}:${pad(d.minute)}';
  }
}
