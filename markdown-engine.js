(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/markdown-it.min'), require('./printable-text'));
  else root.PrinterMarkdown = factory(root.markdownit, root.PrinterTextCompatibility);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MarkdownIt, compatibility) {
  const parser = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false, maxNesting: 50 });
  const clean = text => compatibility.printableText(String(text ?? ''));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const safeImage = url => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };
  const plainInline = children => (children || []).map(token => token.type === 'image' ? token.content || '[图片]' : ['text', 'code_inline'].includes(token.type) ? token.content : ['softbreak', 'hardbreak'].includes(token.type) ? '\n' : '').join('');

  function detectMarkdown(value, parsedTokens) {
    const text = String(value || '');
    // Include likely incomplete markup so the user can open the checker and fix it.
    if (/(^|\n)\s{0,3}#{1,6}[^#\s]|!?\[[^\]\n]+\]\([^\n]*$|(^|\s)\*\*\S/m.test(text)) return true;
    const tokens = parsedTokens || parser.parse(text, {});
    return tokens.some(token => ['heading_open', 'table_open', 'hr', 'blockquote_open', 'fence', 'code_block', 'bullet_list_open', 'ordered_list_open'].includes(token.type)
      || token.type === 'inline' && (token.children || []).some(child => ['em_open', 'strong_open', 's_open', 'code_inline', 'image'].includes(child.type) || child.type === 'link_open' && child.markup !== 'linkify'));
  }

  function analyzeMarkdown(value) {
    const text = String(value ?? '').replace(/\r\n?/g, '\n');
    const issues = [];
    const add = (line, code, message, suggestion, severity = 'warning') => { if (issues.length < 100) issues.push({ line, code, severity, message, suggestion }); };
    const lines = text.split('\n');
    let fence = null;
    let lastHeading = 0;
    lines.forEach((line, index) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length, line: index + 1 };
        else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        return;
      }
      if (fence) return;
      const heading = line.match(/^\s{0,3}(#{1,6})(?:\s+|$)/);
      if (/^\s{0,3}#{1,6}[^#\s]/.test(line)) add(index + 1, 'heading-space', '标题标记后缺少空格，通常会按普通文字处理', '在 # 和标题正文之间添加空格');
      if (heading) {
        if (lastHeading && heading[1].length > lastHeading + 1) add(index + 1, 'heading-order', '标题层级有跳跃', '按层级组织标题，或保留当前写法');
        lastHeading = heading[1].length;
      }
      const withoutCode = line.replace(/`+[^`]*`+/g, '').replace(/\\./g, '');
      if ((withoutCode.match(/\*\*/g) || []).length % 2) add(index + 1, 'unpaired-strong', '疑似未闭合的粗体标记', '成对使用 **；若要显示星号可用反斜杠转义');
      if (/!?\[[^\]]+\]\([^)]*$/.test(withoutCode)) add(index + 1, 'unclosed-link', '疑似未闭合的链接或图片地址', '补全右括号，或将括号转义');
      if (/<\/?[a-z][^>]*>/i.test(line)) add(index + 1, 'html-as-text', 'HTML 标签会作为文字显示，不执行 HTML', '优先使用 Markdown 排版', 'info');
    });
    if (fence) add(fence.line, 'unclosed-fence', '代码围栏未显式闭合；CommonMark 允许延续到文档末尾', '建议补上与开头相同的代码围栏');
    const tokens = parser.parse(text, {});
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      const token = tokens[tokenIndex];
      if (token.type === 'inline') for (const child of token.children || []) {
        if (child.type === 'image' && !safeImage(child.attrGet('src'))) add((token.map?.[0] || 0) + 1, 'image-address', '小票图片需要完整的 HTTP(S) 公开地址', '改用公开图片直链，或先拖入图片上传到图床', 'error');
      }
      if (token.type === 'tr_open') {
        let columns = 0;
        for (let i = tokenIndex + 1; i < tokens.length && tokens[i].type !== 'tr_close'; i++) if (['th_open', 'td_open'].includes(tokens[i].type)) columns++;
        if (columns > 16) add((token.map?.[0] || 0) + 1, 'printer-table-columns', '小票表格最多支持 16 列', '拆分表格，或减少列数', 'error');
      }
    }
    return { detected: detectMarkdown(text, tokens), valid: !issues.some(issue => issue.severity === 'error'), characters: Array.from(text).length, lines: lines.length, issues, summary: !issues.length ? '本地检查未发现排版问题' : `发现 ${issues.length} 条排版提示` };
  }

  function wrapText(value, capacity = 32) {
    const output = [];
    for (const paragraph of clean(value).replace(/\t/g, '    ').split('\n')) {
      let line = '', width = 0;
      for (const char of paragraph) {
        const size = char.codePointAt(0) > 255 ? 2 : 1;
        if (width + size > capacity && line) { output.push(line); line = ''; width = 0; }
        line += char; width += size;
      }
      output.push(line);
    }
    return output;
  }

  function markdownToNodes(value, options = {}) {
    const tokens = parser.parse(String(value ?? ''), {});
    const nodes = [];
    const lists = [];
    let quoteDepth = 0, heading = 0, itemPrefix = '', inRow = false, row = [], aligns = [], inHeader = false;
    const rowNode = (columns, style = {}, justifications = []) => ({ content: {
      maxcolumn: columns.length, column_align: columns.map((_, i) => ({ column_width: Math.max(1, Math.floor(32 / columns.length)), style: { justification: justifications[i] || 0 } })),
      lines: { linelist: [{ column: columns.map(clean) }] }, style: { height: 0, width: 0, justification: 0, ...style },
    } });
    const appendText = (text, bold = false) => {
      const style = heading === 1 ? { height: 1, width: 1 } : heading || bold ? { height: 1, width: 0 } : {};
      const prefix = '> '.repeat(quoteDepth) + itemPrefix;
      const lines = wrapText(prefix + text, style.width ? 16 : 32);
      for (const line of lines) nodes.push(line ? rowNode([line], style) : { text: { column: [{ value: '__EOL__' }], column_align: [{}] } });
      itemPrefix = '';
    };
    if (options.sender) appendText(String(options.sender) + '：');
    for (const token of tokens) {
      switch (token.type) {
        case 'heading_open': heading = Number(token.tag.slice(1)); break;
        case 'heading_close': heading = 0; break;
        case 'blockquote_open': quoteDepth++; break;
        case 'blockquote_close': quoteDepth = Math.max(0, quoteDepth - 1); break;
        case 'bullet_list_open': lists.push({ ordered: false, next: 1 }); break;
        case 'ordered_list_open': lists.push({ ordered: true, next: Number(token.attrGet('start')) || 1 }); break;
        case 'bullet_list_close': case 'ordered_list_close': lists.pop(); break;
        case 'list_item_open': {
          const list = lists[lists.length - 1];
          itemPrefix = '  '.repeat(Math.max(0, lists.length - 1)) + (list?.ordered ? `${list.next++}. ` : '- '); break;
        }
        case 'thead_open': inHeader = true; break;
        case 'thead_close': inHeader = false; break;
        case 'tr_open': inRow = true; row = []; aligns = []; break;
        case 'th_open': case 'td_open': {
          const align = token.attrGet('style') || '';
          aligns.push(align.includes('right') ? 2 : align.includes('center') ? 1 : 0); break;
        }
        case 'tr_close': if (row.length && row.length <= 16) nodes.push(rowNode(row, inHeader ? { height: 1 } : {}, aligns)); inRow = false; break;
        case 'fence': case 'code_block': for (const line of token.content.replace(/\n$/, '').split('\n')) appendText(line); break;
        case 'hr': appendText('--------------------------------'); break;
        case 'inline': {
          if (inRow) { row.push(plainInline(token.children)); break; }
          let text = '', bold = false;
          const flush = () => { if (text) { appendText(text, bold); text = ''; bold = false; } };
          for (const child of token.children || []) {
            if (['text', 'code_inline'].includes(child.type)) text += child.content;
            else if (['softbreak', 'hardbreak'].includes(child.type)) text += '\n';
            else if (child.type === 'strong_open') bold = true;
            else if (child.type === 'image') { flush(); const src = child.attrGet('src'); if (safeImage(src)) nodes.push({ icon: { type: 3, value: src, style: { justification: 1 } } }); else appendText(child.content || '[图片地址无效]'); }
            else if (child.type === 'link_close') {
              const opening = (token.children || []).slice(0, token.children.indexOf(child)).reverse().find(part => part.type === 'link_open');
              const href = opening?.attrGet('href');
              if (href && !text.includes(href)) text += ` (${href})`;
            }
          }
          flush(); break;
        }
      }
    }
    return nodes;
  }

  function receiptHtml(nodes) {
    return nodes.map(node => {
      if (node.icon?.type === 3 && safeImage(node.icon.value)) return `<div class="md-image"><img loading="lazy" src="/api/image?url=${encodeURIComponent(node.icon.value)}" alt="Markdown 图片" /></div>`;
      if (node.text) return '<div class="receipt-eol" aria-label="空行"></div>';
      if (!node.content) return '';
      const content = node.content;
      const columns = content.lines.linelist[0].column;
      return `<div class="md-receipt-row font-height-${content.style.height || 0} font-width-${content.style.width || 0}" style="grid-template-columns:repeat(${columns.length},minmax(0,1fr))">${columns.map((text, i) => `<span style="text-align:${['left', 'center', 'right'][content.column_align[i]?.style?.justification || 0]}">${escape(text) || '&nbsp;'}</span>`).join('')}</div>`;
    }).join('');
  }

  return { detectMarkdown, analyzeMarkdown, markdownToNodes, receiptHtml, escapeHtml: escape };
});
