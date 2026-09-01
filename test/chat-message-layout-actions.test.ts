import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const css = read('app/src/lc-fixes.css');
const platform = read('app/src/chat-platform.ts');
const native = read('app/src/native.ts');
const main = read('app/src/main.tsx');
const desktop = read('desktop/main.mjs');
const preload = read('desktop/preload.cjs');

test('chat transcript and composer share one horizontal rail', () => {
  assert.match(css, /\.lc-shell-content-shell \.lc-agent-thread\s*\{[^}]*padding-inline:\s*0/);
  assert.match(css, /\.lc-shell-content-shell \.thread-user-turn,[\s\S]*?\.lc-shell-content-shell \.thread-assistant-turn\s*\{[^}]*width:\s*min\(760px, calc\(100% - 40px\)\)/);
});

test('user bubble owns the action-row width and does not split normal words', () => {
  assert.match(css, /\.user-turn-shell\s*\{[^}]*width:\s*fit-content[^}]*max-width:\s*min\(88%, 650px\)/);
  assert.match(css, /\.user-turn-shell \.user-message\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*break-word[^}]*word-break:\s*normal/);
  assert.match(css, /\.user-turn-shell \.message-actions\s*\{[^}]*width:\s*100%[^}]*justify-content:\s*flex-end/);
});

test('message copy uses the native Electron clipboard instead of relying on renderer permission', () => {
  assert.match(native, /copyText\(text: string\): Promise<boolean>/);
  assert.match(preload, /copyText:\s*\(text\) => ipcRenderer\.invoke\('local-coder:copy-text'/);
  assert.match(desktop, /clipboard,/);
  assert.match(desktop, /ipcMain\.handle\('local-coder:copy-text'/);
  assert.match(desktop, /clipboard\.writeText\(text\)/);
  assert.match(platform, /bridge\.copyText\(String\(text\)\)/);
  assert.match(main, /installChatPlatformEnhancements\(\)/);
});

test('read aloud chooses a language-matched local natural voice before speaking', () => {
  assert.match(platform, /PORTUGUESE_HINTS/);
  assert.match(platform, /QUALITY_VOICE/);
  assert.match(platform, /voice\.localService && QUALITY_VOICE\.test\(voice\.name\)/);
  assert.match(platform, /utterance\.voice = voice/);
  assert.match(platform, /utterance\.lang = voice\?\.lang \?\? language/);
  assert.match(platform, /utterance\.rate = 0\.96/);
  assert.match(platform, /originalSpeak\(utterance\)/);
});
