/* UI helpers loaded before app.js; init runs after the existing editor is ready. */
const PrinterEnhancements = (() => {
  const Host = PrinterImageHost;
  const MD = PrinterMarkdown;
  const AI_KEY = 'wechat-printer.ai-settings';
  let cropQueue = [], cropInFlight = false, dragDepth = 0;
  const aiResultByItem = new WeakMap();
  const uploadByItem = new WeakMap();
  const esc = MD.escapeHtml;

  function normalizeAiClient(value = {}) {
    return { enabled: value.enabled === true, baseUrl: String(value.baseUrl || 'https://api.openai.com/v1').trim(), model: String(value.model || '').trim(), apiKey: String(value.apiKey || '').trim() };
  }
  function readAiSettings() { try { return normalizeAiClient(JSON.parse(localStorage.getItem(AI_KEY) || '{}')); } catch { return normalizeAiClient(); } }
  function renderAiSettings() {
    $('aiEnabled').checked = aiSettings.enabled;
    $('aiBaseUrl').value = aiSettings.baseUrl;
    $('aiModel').value = aiSettings.model;
    $('aiApiKey').value = aiSettings.apiKey;
    $('aiPrivacyHint').textContent = aiSettings.enabled ? '已启用。仅点击“AI 检查”时发送当前正文；建议不会自动覆盖原文。' : '默认关闭，Markdown 自动识别和基础检查均在本机完成。';
  }
  function imageHostFormSettings() {
    const provider = $('imageHostProvider').value;
    return Host.normalizeImageHost({
      provider, baseUrl: $('cfBedBaseUrl').value, token: $('cfBedToken').value, authCode: $('cfBedAuthCode').value, uploadChannel: $('cfBedUploadChannel').value,
      endpoint: $('s3Endpoint').value, bucket: $('s3Bucket').value, region: $('s3Region').value, accessKeyId: $('s3AccessKeyId').value, secretAccessKey: $('s3SecretAccessKey').value, sessionToken: $('s3SessionToken').value,
      publicBaseUrl: $('s3PublicBaseUrl').value, prefix: $('s3Prefix').value, forcePathStyle: $('s3PathStyle').checked,
      uploadUrl: $('customUploadUrl').value, fileField: $('customFileField').value, responseUrlPath: $('customResponsePath').value, authorization: $('customAuthorization').value,
      cacheExpireDays: provider === 'cfbed' ? $('cfBedCacheExpireDays').value : $('objectCacheDays').value,
      deleteExpiredCache: provider === 'cfbed' && $('cfBedDeleteExpiredCache').checked,
    });
  }
  function providerVisibility() {
    const provider = $('imageHostProvider').value;
    $('cfBedFields').classList.toggle('hidden-view', provider !== 'cfbed');
    $('s3Fields').classList.toggle('hidden-view', !['r2', 's3'].includes(provider));
    $('customHostFields').classList.toggle('hidden-view', provider !== 'custom');
    $('objectCacheField').classList.toggle('hidden-view', !['r2', 's3', 'custom'].includes(provider));
    $('s3ProviderHint').textContent = provider === 'r2' ? 'R2 Region 使用 auto。Endpoint 用于签名上传，公开访问地址用于小票机下载，二者分别填写。' : '兼容 AWS S3、MinIO 等服务。Region 与寻址方式需和服务端一致。';
  }
  function renderImageHostSettings() {
    const settings = Host.normalizeImageHost(imageHostSettings);
    $('imageHostProvider').value = settings.provider;
    const values = { cfBedBaseUrl: 'baseUrl', cfBedToken: 'token', cfBedAuthCode: 'authCode', cfBedUploadChannel: 'uploadChannel', s3Endpoint: 'endpoint', s3Bucket: 'bucket', s3Region: 'region', s3AccessKeyId: 'accessKeyId', s3SecretAccessKey: 'secretAccessKey', s3SessionToken: 'sessionToken', s3PublicBaseUrl: 'publicBaseUrl', s3Prefix: 'prefix', customUploadUrl: 'uploadUrl', customFileField: 'fileField', customResponsePath: 'responseUrlPath', customAuthorization: 'authorization' };
    for (const [id, key] of Object.entries(values)) $(id).value = settings[key] || (key === 'region' ? settings.provider === 'r2' ? 'auto' : 'us-east-1' : key === 'fileField' ? 'file' : key === 'responseUrlPath' ? 'url' : '');
    $('s3PathStyle').checked = settings.forcePathStyle !== false;
    $('objectCacheDays').value = settings.cacheExpireDays;
    $('cfBedCacheExpireDays').value = settings.cacheExpireDays;
    $('cfBedDeleteExpiredCache').checked = settings.deleteExpiredCache === true;
    providerVisibility();
    const name = Host.NAMES[settings.provider];
    $('imageHostStatus').textContent = name;
    setSettingsNotice('', `当前图床：${name}`, ['r2', 's3'].includes(settings.provider) ? '图片由本机服务签名上传。请确保公开访问地址无需登录即可下载；可用“上传测试图片”检查。' : settings.provider === 'custom' ? '图片以 multipart/form-data 发往自定义接口，再按配置的 JSON 路径提取直链。' : settings.provider === 'cfbed' ? '使用已配置的 ImgBed 站点上传与缓存设置。' : '无需额外配置；可以切换为自己的 R2、S3 或 HTTP 图床。');
  }

  function isMarkdownItem(item) {
    return item.type === 'markdown' || (item.type === 'text' && item.markdownMode !== 'plain' && textColumnValues(item).length === 1 && MD.detectMarkdown(textColumnValues(item)[0]));
  }
  function itemSource(item) { return item.type === 'markdown' ? String(item.text || '') : textColumnValues(item)[0] || ''; }
  function markdownNodes(item) {
    const nodes = MD.markdownToNodes(itemSource(item));
    if (item.markdownImageScope === JSON.stringify(imageHostSettings)) for (const node of nodes) {
      if (node.icon?.type === 3 && item.markdownImageMap?.[node.icon.value]) node.icon.value = item.markdownImageMap[node.icon.value];
    }
    return nodes;
  }
  function statusHtml(result) {
    const issues = result.issues.map(issue => `<li class="md-issue ${issue.severity}"><strong>第 ${issue.line} 行</strong> ${esc(issue.message)}${issue.suggestion ? `<small>${esc(issue.suggestion)}</small>` : ''}</li>`).join('');
    return `<div class="md-check-summary ${result.valid ? 'valid' : 'invalid'}">${result.detected ? '已识别 Markdown' : '按 Markdown 模式排版'} · ${result.characters} 字符 · ${esc(result.summary)}</div>${issues ? `<ul class="md-issues">${issues}</ul>` : ''}`;
  }
  function markdownEditor(item, index) {
    const result = MD.analyzeMarkdown(item.text || '');
    return `<div class="content-item markdown-item" data-content-index="${index}">
      <div class="content-item-title"><span><i data-lucide="file-code-2"></i>Markdown 排版 <small>#${index + 1}</small></span><button class="icon-button remove-content" type="button" aria-label="删除 Markdown 节点"><i data-lucide="trash-2"></i></button></div>
      <textarea class="markdown-source" rows="9" spellcheck="false" placeholder="# 标题\n\n可以输入 **粗体**、列表、表格或代码块。" aria-label="Markdown 内容 ${index + 1}">${esc(item.text || '')}</textarea>
      <div class="md-toolbar"><button type="button" class="table-action-button markdown-ai"><i data-lucide="sparkles"></i>AI 检查</button><button type="button" class="table-action-button markdown-apply" disabled>应用 AI 建议</button><span>本地检查自动运行</span></div>
      <div class="markdown-diagnostics" role="status" aria-live="polite">${statusHtml(result)}</div><div class="markdown-ai-result" role="status"></div>
    </div>`;
  }
  function updateMarkdownStatus(element, item) {
    const area = element.querySelector('.markdown-diagnostics');
    if (area) area.innerHTML = statusHtml(MD.analyzeMarkdown(itemSource(item)));
  }
  function bindItem(element, item) {
    if (item.type === 'markdown') {
      let timer;
      element.querySelector('.markdown-source').addEventListener('input', event => {
        item.text = event.target.value; aiResultByItem.delete(item);
        element.querySelector('.markdown-apply').disabled = true;
        clearTimeout(timer); timer = setTimeout(() => { updateMarkdownStatus(element, item); render(); }, 250);
      });
      element.querySelector('.markdown-ai').addEventListener('click', async event => {
        const button = event.currentTarget, resultArea = element.querySelector('.markdown-ai-result');
        if (!aiSettings.enabled || !aiSettings.model) { setNotice('', '先配置 AI 检查', '在设置中启用可选 AI，填写兼容接口地址、模型和所需密钥。'); switchView('settingsView'); $('aiModel').focus(); return; }
        button.disabled = true; resultArea.textContent = '正在检查，原文会保留…';
        const source = item.text;
        try {
          const response = await fetch('/api/markdown/check-ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: source, settings: aiSettings }) });
          const result = await response.json(); if (!response.ok) throw new Error(result.error || 'AI 检查失败');
          resultArea.replaceChildren();
          const summary = document.createElement('p'); summary.textContent = result.summary; resultArea.append(summary);
          for (const issue of result.issues || []) { const line = document.createElement('p'); line.textContent = `第 ${issue.line} 行：${issue.message}${issue.suggestion ? ' — ' + issue.suggestion : ''}`; resultArea.append(line); }
          if (result.revisedMarkdown) { const details = document.createElement('details'), label = document.createElement('summary'), preview = document.createElement('pre'); label.textContent = '查看建议全文'; preview.textContent = result.revisedMarkdown; details.append(label, preview); resultArea.append(details); }
          aiResultByItem.set(item, { source, revised: result.revisedMarkdown }); element.querySelector('.markdown-apply').disabled = !result.revisedMarkdown || item.text !== source;
        } catch (error) { resultArea.textContent = error.message; } finally { button.disabled = false; }
      });
      element.querySelector('.markdown-apply').addEventListener('click', () => {
        const suggestion = aiResultByItem.get(item);
        if (!suggestion || suggestion.source !== item.text) return;
        item.text = suggestion.revised; renderContentList(); render(); setNotice('success', '已应用建议', '请检查排版后再发送打印。');
      });
    }
    if (item.type === 'text') {
      const hint = document.createElement('div'); hint.className = 'text-markdown-hint';
      const refresh = () => {
        const source = itemSource(item);
        hint.replaceChildren();
        if (!MD.detectMarkdown(source) || textColumnValues(item).length !== 1) return;
        const text = document.createElement('span'); text.textContent = item.markdownMode === 'plain' ? '当前按原文打印。' : '已自动识别 Markdown，将按小票样式排版。';
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'table-action-button'; toggle.textContent = item.markdownMode === 'plain' ? '启用排版' : '保留原文';
        toggle.onclick = () => { item.markdownMode = item.markdownMode === 'plain' ? 'auto' : 'plain'; refresh(); render(); };
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'table-action-button'; edit.textContent = '打开检查器';
        edit.onclick = () => { item.type = 'markdown'; item.text = source; renderContentList(); render(); };
        hint.append(text, toggle, edit);
      };
      element.append(hint); element.addEventListener('input', refresh); refresh();
    }
    if (item.type === 'image') {
      element.classList.add('image-drop-target');
      element.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); element.classList.add('drag-active'); } });
      element.addEventListener('dragleave', () => element.classList.remove('drag-active'));
      element.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); element.classList.remove('drag-active'); enqueueImages(event.dataTransfer.files, item); });
      const actions = document.createElement('div'); actions.className = 'image-extra-actions';
      const upload = document.createElement('button'); upload.type = 'button'; upload.className = 'table-action-button'; upload.textContent = uploadByItem.has(item) ? '上传中…' : item.uploadedUrl ? '已上传 · 重试上传' : '上传到图床'; upload.disabled = !item.processedDataUrl || uploadByItem.has(item); upload.onclick = () => uploadItem(item);
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'table-action-button'; copy.textContent = '复制 Markdown 链接'; copy.disabled = !item.uploadedUrl && !item.url;
      copy.onclick = async () => { try { await navigator.clipboard.writeText(`![图片](${item.uploadedUrl || item.url})`); setNotice('success', '已复制', '可粘贴到 Markdown 排版区。'); } catch { setNotice('error', '复制失败', '请从图片地址输入框手动复制。'); } };
      actions.append(upload, copy); element.append(actions);
    }
  }

  function cropQueueStatus() {
    $('imageQueueStatus').textContent = cropInFlight || cropQueue.length ? `图片处理中，等待 ${cropQueue.length} 张` : '拖入图片可依次裁剪，完成后自动上传；也支持粘贴截图。';
    $('cancelImageQueue').hidden = !cropQueue.length;
  }
  function cropClosed() { cropInFlight = false; cropQueueStatus(); setTimeout(nextImage, 0); }
  function enqueueImages(files, target = null) {
    let accepted = 0;
    for (const file of Array.from(files || [])) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setNotice('error', '不支持的图片', '请选择 PNG、JPEG、WebP 或 GIF 文件。'); continue; }
      if (file.size > 20 * 1024 * 1024) { setNotice('error', '图片过大', '单张图片请控制在 20 MB 以内。'); continue; }
      cropQueue.push({ file, target: accepted++ === 0 ? target : null });
    }
    cropQueueStatus(); nextImage();
  }
  function nextImage() {
    if (cropInFlight || cropState || !cropQueue.length) return;
    const entry = cropQueue.shift();
    let item = entry.target;
    if (!item || !contentItems.includes(item)) { item = { type: 'image', url: '', alignment: 1, gamma: 1, contrast: 0 }; contentItems.push(item); }
    cropInFlight = true; renderContentList(); render(); cropQueueStatus(); openCropModal(entry.file, contentItems.indexOf(item));
  }
  async function uploadItem(item) {
    if (!item.processedDataUrl) return;
    if (uploadByItem.has(item)) return uploadByItem.get(item);
    const validation = Host.validateImageHost(imageHostSettings);
    if (!validation.valid) { setNotice('error', '先完善图床设置', validation.errors.join('；')); return; }
    const source = item.processedDataUrl;
    const task = (async () => {
      try {
        const response = await fetch('/api/image-host/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: source, settings: imageHostSettings }) });
        const result = await response.json(); if (!response.ok || !result.directUrl) throw new Error(result.error || '上传未返回图片直链');
        if (item.processedDataUrl !== source) return;
        item.url = item.uploadedUrl = result.directUrl; setNotice('success', '图片已上传', '可继续编辑、复制 Markdown 链接，或发送打印。');
      } catch (error) { setNotice('error', '图片上传失败', `${error.message}；处理后的图片已保留，可重试。`); }
      finally { uploadByItem.delete(item); renderContentList(); render(); }
    })();
    uploadByItem.set(item, task); renderContentList(); return task;
  }

  function validatePrintContent() {
    for (const item of contentItems) if (isMarkdownItem(item)) {
      const result = MD.analyzeMarkdown(itemSource(item));
      if (!result.valid) { setNotice('error', '请先修正排版问题', result.issues.filter(issue => issue.severity === 'error').map(issue => `第 ${issue.line} 行：${issue.message}`).join('；')); return false; }
    }
    return true;
  }

  async function prepareMarkdownImages() {
    for (const item of contentItems) if (isMarkdownItem(item)) {
      const scope = JSON.stringify(imageHostSettings);
      if (item.markdownImageScope !== scope) { item.markdownImageMap = {}; item.markdownImageScope = scope; }
      const images = MD.markdownToNodes(itemSource(item)).filter(node => node.icon?.type === 3);
      if (!images.length) continue;
      item.markdownImageMap ||= {};
      for (const node of images) {
        const source = node.icon.value;
        if (item.markdownImageMap[source]) continue;
        setNotice('', '正在处理 Markdown 图片', '图片会经过黑白处理并上传到所选图床。');
        const response = await fetch('/api/markdown/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: source, settings: imageHostSettings }) });
        const result = await response.json(); if (!response.ok || !result.directUrl) throw new Error(result.error || 'Markdown 图片处理失败');
        item.markdownImageMap[source] = result.directUrl;
      }
    }
  }

  function init() {
    $('imageHostProvider').addEventListener('change', () => { if ($('imageHostProvider').value === 'r2') $('s3Region').value = 'auto'; else if ($('s3Region').value === 'auto') $('s3Region').value = 'us-east-1'; providerVisibility(); });
    $('testImageHost').addEventListener('click', async event => {
      const settings = imageHostFormSettings(), validation = Host.validateImageHost(settings);
      if (!validation.valid) { setSettingsNotice('error', '配置未完成', validation.errors.join('；')); return; }
      const button = event.currentTarget; button.disabled = true; $('imageHostTestResult').textContent = '正在上传一张测试图片…';
      try {
        const response = await fetch('/api/image-host/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || '测试失败');
        const url = new URL(result.directUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('图床返回的直链无效');
        const link = document.createElement('a'); link.href = url.toString(); link.textContent = '上传成功，打开图片直链检查'; link.target = '_blank'; link.rel = 'noreferrer'; $('imageHostTestResult').replaceChildren(link);
      } catch (error) { $('imageHostTestResult').textContent = error.message; } finally { button.disabled = false; }
    });
    $('aiSettingsForm').addEventListener('submit', async event => {
      event.preventDefault(); const button = $('saveAiSettings'); button.disabled = true;
      const draft = normalizeAiClient({ enabled: $('aiEnabled').checked, baseUrl: $('aiBaseUrl').value, model: $('aiModel').value, apiKey: $('aiApiKey').value });
      if (draft.enabled && !draft.model) { button.disabled = false; setSettingsNotice('error', '请填写模型', '模型名称由你的兼容接口提供商决定。'); return; }
      try {
        const response = await fetch('/api/settings/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || '设置保存失败');
        aiSettings = draft;
        if (storageMode === 'local') await saveCurrentConfigToFile(currentConfig()); else writeBrowserConfig(currentConfig());
        renderAiSettings(); setSettingsNotice('success', 'AI 设置已保存', '本次没有调用模型；仅在点击“AI 检查”时发送正文。');
      } catch (error) { setSettingsNotice('error', 'AI 设置保存失败', error.message); } finally { button.disabled = false; }
    });
    $('addMarkdown').addEventListener('click', () => { contentItems.push({ type: 'markdown', text: '' }); renderContentList(); render(); $('contentList').querySelector('.markdown-item:last-child textarea')?.focus(); });
    $('markdownExample').addEventListener('click', () => { contentItems.push({ type: 'markdown', text: '# 今日清单\n\n**欢迎光临**\n\n- 手冲咖啡\n- 今日甜点\n\n| 商品 | 数量 |\n| --- | ---: |\n| 咖啡 | 1 |\n\n> 检查预览后再打印。' }); renderContentList(); render(); });
    $('importMarkdown').addEventListener('change', async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      if (file.size > 2 * 1024 * 1024) { setNotice('error', '文档过大', '请选择 2 MB 以内的 Markdown / 文本文件。'); return; }
      contentItems.push({ type: 'markdown', text: await file.text() }); renderContentList(); render();
    });
    const zone = $('imageDropZone');
    zone.addEventListener('click', event => { if (!event.target.closest('button')) $('bulkImageInput').click(); });
    zone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('bulkImageInput').click(); } });
    $('bulkImageInput').addEventListener('change', event => { enqueueImages(event.target.files); event.target.value = ''; });
    $('cancelImageQueue').addEventListener('click', event => { event.stopPropagation(); cropQueue = []; cropQueueStatus(); });
    document.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { dragDepth++; zone.classList.add('drag-active'); } });
    document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove('drag-active'); } });
    document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
    document.addEventListener('drop', event => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault(); dragDepth = 0; zone.classList.remove('drag-active');
      const files = Array.from(event.dataTransfer.files);
      const markdown = files.filter(file => /\.(md|markdown|txt)$/i.test(file.name) && file.size <= 2 * 1024 * 1024);
      for (const file of markdown) file.text().then(text => { contentItems.push({ type: 'markdown', text }); renderContentList(); render(); });
      const images = files.filter(file => file.type.startsWith('image/')); if (images.length) enqueueImages(images);
      if (!images.length && !markdown.length) setNotice('error', '文件类型不支持', '可拖入图片或 Markdown / 文本文件。');
    });
    document.addEventListener('paste', event => { const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); enqueueImages(files); } });
    renderAiSettings(); cropQueueStatus();
    fetch('/api/app/info').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(info => { $('appVersion').textContent = `v${info.version}`; }).catch(() => setNotice('', '需要重启本地服务', '新图床与 Markdown 功能需要新版服务。先停止旧服务，再重新启动工具并刷新页面。'));
  }
  return { AI_KEY, readAiSettings, normalizeAiClient, renderAiSettings, imageHostFormSettings, renderImageHostSettings, providerVisibility, markdownEditor, bindItem, isMarkdownItem, itemSource, markdownNodes, validatePrintContent, prepareMarkdownImages, uploadItem, cropClosed, init };
})();
