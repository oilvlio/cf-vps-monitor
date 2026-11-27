type StructuredAuditDetail = {
  summary?: unknown;
};

function readStructuredAuditDetail(detail: string): StructuredAuditDetail | null {
  const trimmed = detail.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as StructuredAuditDetail
      : null;
  } catch {
    return null;
  }
}

export function getAuditLogDetailText(detail: unknown) {
  if (typeof detail !== 'string') return '-';
  const trimmed = detail.trim();
  if (!trimmed) return '-';
  const structured = readStructuredAuditDetail(trimmed);
  return typeof structured?.summary === 'string' && structured.summary.trim()
    ? structured.summary.trim()
    : trimmed;
}

export function getAuditLogRawDetailText(detail: unknown) {
  return typeof detail === 'string' && detail.trim() ? detail.trim() : '-';
}

function findJsonValueEnd(text: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// 审计详情里的 JSON 常常是一整行，拖动选择时容易一次选中整段；展示前展开成多行。
function prettyPrintEmbeddedJson(text: string) {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== '{' && char !== '[') {
      result += char;
      index += 1;
      continue;
    }
    const end = findJsonValueEnd(text, index);
    if (end < 0) {
      result += char;
      index += 1;
      continue;
    }
    const candidate = text.slice(index, end + 1);
    try {
      const pretty = JSON.stringify(JSON.parse(candidate), null, 2);
      result = result.replace(/[ \t]+$/, '');
      if (result && !result.endsWith('\n')) result += '\n';
      result += pretty;
      index = end + 1;
      if (index < text.length) {
        result += '\n';
        while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;
      }
    } catch {
      result += char;
      index += 1;
    }
  }
  return result;
}

function formatAuditLogJsonText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // 不是完整 JSON 时继续按文本里的 JSON 片段处理。
    }
  }
  return prettyPrintEmbeddedJson(text);
}

export function formatAuditLogDetailText(detail: unknown) {
  return formatAuditLogJsonText(getAuditLogDetailText(detail));
}

export function formatAuditLogRawDetailText(detail: unknown) {
  return formatAuditLogJsonText(getAuditLogRawDetailText(detail));
}

export function getAuditLogDetailSearchText(detail: unknown) {
  if (typeof detail !== 'string') return '';
  const display = getAuditLogDetailText(detail);
  return display === detail ? detail : `${display} ${detail}`;
}

export function formatAuditLogDetailPreview(detail: unknown, maxLength = 120) {
  const text = getAuditLogDetailText(detail);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
