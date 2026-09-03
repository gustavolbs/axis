import fs from 'node:fs';

function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not find start of ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Could not find end of ${label}`);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

{
  const file = 'scripts/capture-api-key-lifecycle-visual.mjs';
  let source = fs.readFileSync(file, 'utf8');

  const initialBlock = [
    "  const initialRequestCount = requests.length;",
    "  await clickText(cdp, '.api-key-manage-dialog button', 'Test connection');",
    "  await waitFor(cdp, \"document.querySelector('.api-key-manage-dialog')?.textContent?.includes('HTTPS is required by policy.') === true\", 'initial unsafe endpoint rejection');",
    "  await sleep(250);",
    "  if (requests.length !== initialRequestCount) throw new Error(`Unsafe local provider endpoint escaped network policy: ${JSON.stringify(safeRequests())}`);",
    "  const initialDenied = await evaluate(cdp, `(() => ({ text: document.querySelector('.settings-endpoint-result')?.textContent?.replace(/\\\\s+/g, ' ').trim() ?? '', busy: [...document.querySelectorAll('.api-key-manage-dialog button')].some((button) => button.textContent?.includes('Testing…')) }))()`);",
    "  console.log(`api-lifecycle-initial-network-denial ${JSON.stringify(initialDenied)}`);",
    "  if (!initialDenied?.text.includes('HTTPS is required by policy.') || initialDenied.busy) throw new Error(`Unsafe endpoint denial UI contract failed: ${JSON.stringify(initialDenied)}`);",
    "",
    ""
  ].join('\n');

  source = replaceBetween(
    source,
    '  const initialRequestCount = requests.length;',
    '  await evaluate(cdp, `(() => { const dialog = document.querySelector(\'.api-key-manage-dialog\');',
    initialBlock,
    'initial API-key connection smoke block'
  );

  const rotatedBlock = [
    "  const rotationDeadline = Date.now() + 10_000;",
    "  while (Date.now() < rotationDeadline && credentials.resolve(firstCredentialId) !== rotatedSecret) await sleep(100);",
    "  if (credentials.resolve(firstCredentialId) !== rotatedSecret) throw new Error('Rotated API key was not persisted to the shared macOS Keychain item.');",
    "  if (credentials.resolve(siblingCredentialId) !== siblingSecret) throw new Error('Rotating one API key changed its sibling credential.');",
    "",
    "  const rotatedRequestStart = requests.length;",
    "  await clickText(cdp, '.api-key-manage-dialog button', 'Test connection');",
    "  await waitFor(cdp, \"document.querySelector('.api-key-manage-dialog')?.textContent?.includes('HTTPS is required by policy.') === true\", 'post-rotation unsafe endpoint rejection');",
    "  await sleep(250);",
    "  if (requests.length !== rotatedRequestStart) throw new Error(`Rotated credential escaped network policy: ${JSON.stringify(safeRequests())}`);",
    "",
    ""
  ].join('\n');

  source = replaceBetween(
    source,
    '  const rotatedRequestStart = requests.length;',
    '  await evaluate(cdp, `(() => { const button = document.querySelector(\'.api-key-manage-dialog button[aria-label="Disable API Key connection"]\');',
    rotatedBlock,
    'post-rotation API-key connection smoke block'
  );

  const finalLog = "  console.log(`api-lifecycle-requests ${JSON.stringify(safeRequests())}`);";
  if (!source.includes(finalLog)) throw new Error('Could not find lifecycle request log');
  source = source.replace(finalLog, [
    "  if (requests.length !== 0) throw new Error(`Cloud provider smoke unexpectedly reached loopback: ${JSON.stringify(safeRequests())}`);",
    finalLog
  ].join('\n'));

  fs.writeFileSync(file, source, 'utf8');
}

{
  const file = 'CHANGELOG.md';
  let source = fs.readFileSync(file, 'utf8');
  const bullet = '- Fixed the API Key lifecycle Electron smoke so it validates the current cloud-provider network boundary: unsafe loopback/insecure endpoints must fail closed before any request, while edit/rotation/sibling isolation remain verified through UI and Keychain state.\n';
  if (!source.includes(bullet.trim())) {
    const anchor = '- Fixed a product integration mismatch where Cowork could advertise managed-worktree tools even though its immutable product session contained no authorized worktree storage/task-checkout root capable of satisfying those tool contracts.\n';
    if (!source.includes(anchor)) throw new Error('Could not find current 0.23.1 Fixed section');
    source = source.replace(anchor, `${anchor}${bullet}`);
    fs.writeFileSync(file, source, 'utf8');
  }
}

for (const file of ['scripts/apply-p1-visual-smoke-hardening.mjs', '.github/workflows/p1-visual-smoke-hardening.yml']) {
  if (fs.existsSync(file)) fs.rmSync(file);
}
