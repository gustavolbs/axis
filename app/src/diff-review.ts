type DiffLineKind = 'context' | 'add' | 'remove' | 'meta';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  id: string;
  path: string;
  oldPath?: string;
  newPath?: string;
  hunks: DiffHunk[];
  additions: number;
  removals: number;
}

function cleanPath(value: string): string | undefined {
  const clean = value.trim().split('\t')[0]?.trim();
  if (!clean || clean === '/dev/null') return undefined;
  return clean.replace(/^[ab]\//, '');
}

function stableId(path: string, index: number): string {
  const safe = path.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `axis-diff-${index}-${safe || 'file'}`;
}

export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let currentHunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let pendingOldPath: string | undefined;

  function ensureFile(path = 'Changes'): DiffFile {
    if (current) return current;
    current = {
      id: stableId(path, files.length),
      path,
      hunks: [],
      additions: 0,
      removals: 0
    };
    files.push(current);
    return current;
  }

  for (const sourceLine of raw.replace(/\r\n/g, '\n').split('\n')) {
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(sourceLine);
    if (gitHeader) {
      const path = cleanPath(`b/${gitHeader[2]}`) ?? cleanPath(`a/${gitHeader[1]}`) ?? 'Changes';
      current = {
        id: stableId(path, files.length),
        path,
        oldPath: cleanPath(`a/${gitHeader[1]}`),
        newPath: cleanPath(`b/${gitHeader[2]}`),
        hunks: [],
        additions: 0,
        removals: 0
      };
      files.push(current);
      currentHunk = undefined;
      pendingOldPath = undefined;
      continue;
    }

    if (sourceLine.startsWith('--- ')) {
      pendingOldPath = cleanPath(sourceLine.slice(4));
      if (current) current.oldPath = pendingOldPath;
      continue;
    }

    if (sourceLine.startsWith('+++ ')) {
      const nextPath = cleanPath(sourceLine.slice(4));
      const file = ensureFile(nextPath ?? pendingOldPath ?? 'Changes');
      file.newPath = nextPath;
      file.oldPath ??= pendingOldPath;
      if (nextPath) file.path = nextPath;
      continue;
    }

    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(sourceLine);
    if (hunkHeader) {
      const file = ensureFile();
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[3]);
      currentHunk = { header: sourceLine, lines: [] };
      file.hunks.push(currentHunk);
      continue;
    }

    if (!current) continue;
    if (!currentHunk) {
      if (sourceLine && !sourceLine.startsWith('index ')) {
        currentHunk = { header: 'File metadata', lines: [] };
        current.hunks.push(currentHunk);
        currentHunk.lines.push({ kind: 'meta', text: sourceLine });
      }
      continue;
    }

    if (sourceLine.startsWith('+') && !sourceLine.startsWith('+++')) {
      currentHunk.lines.push({ kind: 'add', text: sourceLine.slice(1), newLine });
      current.additions += 1;
      newLine += 1;
      continue;
    }
    if (sourceLine.startsWith('-') && !sourceLine.startsWith('---')) {
      currentHunk.lines.push({ kind: 'remove', text: sourceLine.slice(1), oldLine });
      current.removals += 1;
      oldLine += 1;
      continue;
    }
    if (sourceLine.startsWith(' ')) {
      currentHunk.lines.push({ kind: 'context', text: sourceLine.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (sourceLine.startsWith('\\ No newline at end of file')) {
      currentHunk.lines.push({ kind: 'meta', text: sourceLine });
      continue;
    }
    if (sourceLine) currentHunk.lines.push({ kind: 'meta', text: sourceLine });
  }

  return files.filter((file) => file.hunks.length > 0 || file.additions > 0 || file.removals > 0);
}

function lineNumber(value: number | undefined): string {
  return value === undefined ? '    ' : String(value).padStart(4, ' ');
}

function appendRenderedLine(pre: HTMLPreElement, line: DiffLine): void {
  const span = document.createElement('span');
  if (line.kind === 'add') span.className = 'validation-ok';
  if (line.kind === 'remove') span.className = 'validation-fail';
  const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : line.kind === 'context' ? ' ' : '·';
  span.textContent = `${lineNumber(line.oldLine)} ${lineNumber(line.newLine)} ${prefix} ${line.text}`;
  pre.append(span, document.createTextNode('\n'));
}

function renderFile(file: DiffFile, open: boolean): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'assistant-details';
  details.id = file.id;
  details.open = open;

  const summary = document.createElement('summary');
  summary.textContent = `${file.path} · +${file.additions} −${file.removals}`;
  details.append(summary);

  const pre = document.createElement('pre');
  pre.className = 'thread-diff';
  pre.setAttribute('aria-label', `Diff for ${file.path}`);
  for (const hunk of file.hunks) {
    const header = document.createElement('span');
    header.textContent = hunk.header;
    pre.append(header, document.createTextNode('\n'));
    for (const line of hunk.lines) appendRenderedLine(pre, line);
  }
  details.append(pre);
  return details;
}

function enhanceDiff(details: HTMLDetailsElement): void {
  if (details.dataset.diffReview === 'structured') return;
  const summary = details.querySelector(':scope > summary');
  if (summary?.textContent?.trim() !== 'Diff') return;
  const rawPre = details.querySelector<HTMLPreElement>(':scope > pre.thread-diff');
  if (!rawPre) return;

  const raw = rawPre.textContent ?? '';
  const files = parseUnifiedDiff(raw);
  if (files.length === 0) return;

  summary.textContent = 'Review changes · Last turn';
  details.dataset.diffScope = 'last-turn';

  const review = document.createElement('div');
  review.className = 'diff-review-pane';
  review.setAttribute('aria-label', 'File changes review');

  if (files.length > 1) {
    const navigation = document.createElement('details');
    navigation.className = 'assistant-details';
    navigation.open = true;
    const navigationSummary = document.createElement('summary');
    navigationSummary.textContent = `${files.length} changed files`;
    const list = document.createElement('ul');
    for (const file of files) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-secondary';
      button.textContent = `${file.path} (+${file.additions} −${file.removals})`;
      button.addEventListener('click', () => {
        const target = document.getElementById(file.id) as HTMLDetailsElement | null;
        if (!target) return;
        target.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      item.append(button);
      list.append(item);
    }
    navigation.append(navigationSummary, list);
    review.append(navigation);
  }

  files.forEach((file, index) => review.append(renderFile(file, index === 0)));

  const rawDetails = document.createElement('details');
  rawDetails.className = 'assistant-details';
  const rawSummary = document.createElement('summary');
  rawSummary.textContent = 'Raw unified diff';
  rawPre.remove();
  rawDetails.append(rawSummary, rawPre);
  review.append(rawDetails);

  details.append(review);
  details.dataset.diffReview = 'structured';
}

export function installDiffReviewEnhancements(): void {
  const root = document.getElementById('root');
  if (!root) return;

  const apply = () => {
    for (const details of root.querySelectorAll<HTMLDetailsElement>('details.assistant-details')) {
      enhanceDiff(details);
    }
  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(root, { childList: true, subtree: true });
}
