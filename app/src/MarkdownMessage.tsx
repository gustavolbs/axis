import { Fragment, type ReactNode } from 'react';

function safeHref(value: string): string | undefined {
  const href = value.trim();
  return /^(https?:|mailto:)/i.test(href) ? href : undefined;
}

function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const token = /(\[[^\]\n]+\]\([^\s)]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  while ((match = token.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const value = match[0];
    const key = `${keyPrefix}-${part++}`;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
    if (link) {
      const href = safeHref(link[2]);
      nodes.push(href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{link[1]}</a>
        : <Fragment key={key}>{link[1]}</Fragment>);
    } else if (value.startsWith('`')) {
      nodes.push(<code key={key}>{value.slice(1, -1)}</code>);
    } else if (value.startsWith('**') || value.startsWith('__')) {
      nodes.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    } else if (value.startsWith('~~')) {
      nodes.push(<del key={key}>{value.slice(2, -2)}</del>);
    } else {
      nodes.push(<em key={key}>{value.slice(1, -1)}</em>);
    }
    cursor = match.index + value.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function isTableDivider(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function structuralStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (!line.trim()) return true;
  if (/^```/.test(line.trim())) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*[-*+]\s+/.test(line)) return true;
  if (/^\s*\d+[.)]\s+/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (line.includes('|') && isTableDivider(lines[index + 1] ?? '')) return true;
  return false;
}

export function MarkdownMessage({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let block = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```\s*([^\s`]*)\s*$/.exec(line.trim());
    if (fence) {
      const language = fence[1];
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`b-${block++}`}><code data-language={language || undefined}>{code.join('\n')}</code></pre>);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const children = inlineNodes(heading[2], `h-${block}`);
      const key = `b-${block++}`;
      if (level === 1) blocks.push(<h1 key={key}>{children}</h1>);
      else if (level === 2) blocks.push(<h2 key={key}>{children}</h2>);
      else if (level === 3) blocks.push(<h3 key={key}>{children}</h3>);
      else if (level === 4) blocks.push(<h4 key={key}>{children}</h4>);
      else if (level === 5) blocks.push(<h5 key={key}>{children}</h5>);
      else blocks.push(<h6 key={key}>{children}</h6>);
      index += 1;
      continue;
    }

    if (line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(<div className="markdown-table-wrap" key={`b-${block++}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inlineNodes(cell, `th-${block}-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineNodes(row[cellIndex] ?? '', `td-${block}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*[-*+]\s+(.+)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(<ul key={`b-${block++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineNodes(item, `ul-${block}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(<ol key={`b-${block++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineNodes(item, `ol-${block}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const quote = /^\s*>\s?(.*)$/.exec(lines[index]);
        if (!quote) break;
        quoted.push(quote[1]);
        index += 1;
      }
      blocks.push(<blockquote key={`b-${block++}`}>{quoted.map((item, itemIndex) => <p key={itemIndex}>{inlineNodes(item, `q-${block}-${itemIndex}`)}</p>)}</blockquote>);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`b-${block++}`} />);
      index += 1;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !structuralStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`b-${block++}`}>{inlineNodes(paragraph.join(' '), `p-${block}`)}</p>);
  }

  return <div className="markdown-message">{blocks}</div>;
}

export function stripMarkdownForSpeech(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
