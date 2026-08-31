#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const consoleDist = path.join(root, 'console-dist');
const sizes = [
  [760, 560],
  [900, 640],
  [1120, 720],
  [1440, 900]
];
const zoomFactors = [0.8, 1, 1.25, 1.5];

function mime(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function staticServer() {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/jobs') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end('{"jobs":[]}');
      return;
    }
    if (pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      response.write(': layout smoke\n\n');
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(consoleDist, relative);
    if (!resolved.startsWith(`${consoleDist}${path.sep}`) && resolved !== path.join(consoleDist, 'index.html')) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = fs.readFileSync(resolved);
      response.writeHead(200, { 'content-type': mime(resolved) });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve layout smoke server port.');
  return `http://127.0.0.1:${address.port}`;
}

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
    };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return {
      viewport,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      titlebar: rect('.desktop-titlebar'),
      switcher: rect('.surface-switcher'),
      surface: rect('.surface-viewport'),
      shell: rect('.app-shell'),
      sidebar: rect('.sidebar'),
      main: rect('.main'),
      mainOverflowY: getComputedStyle(document.querySelector('.main')).overflowY,
      sidebarOverflowY: getComputedStyle(document.querySelector('.sidebar')).overflowY
    };
  })()`, true);
}

function withinViewport(name, rect, viewport) {
  if (!rect) throw new Error(`${name} is missing from rendered UI.`);
  const epsilon = 1.5;
  if (rect.left < -epsilon || rect.top < -epsilon || rect.right > viewport.width + epsilon || rect.bottom > viewport.height + epsilon) {
    throw new Error(`${name} escaped viewport: ${JSON.stringify({ rect, viewport })}`);
  }
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`${name} has invalid dimensions: ${JSON.stringify(rect)}`);
}

function assertLayout(result, size, zoom) {
  const { viewport } = result;
  const epsilon = 2;
  if (result.documentScrollWidth > viewport.width + epsilon || result.bodyScrollWidth > viewport.width + epsilon) {
    throw new Error(`horizontal page overflow at ${size.join('x')} zoom ${zoom}: ${JSON.stringify(result)}`);
  }
  withinViewport('desktop titlebar', result.titlebar, viewport);
  withinViewport('surface switcher', result.switcher, viewport);
  withinViewport('surface viewport', result.surface, viewport);
  withinViewport('agent shell', result.shell, viewport);
  withinViewport('main pane', result.main, viewport);
  withinViewport('session navigation', result.sidebar, viewport);
  if (!['auto', 'scroll'].includes(result.mainOverflowY)) {
    throw new Error(`main pane is not independently scrollable at ${size.join('x')} zoom ${zoom}: ${result.mainOverflowY}`);
  }
  if (!['auto', 'scroll', 'hidden'].includes(result.sidebarOverflowY)) {
    throw new Error(`sidebar has unsafe vertical overflow at ${size.join('x')} zoom ${zoom}: ${result.sidebarOverflowY}`);
  }
}

const server = staticServer();
let window;

try {
  if (!fs.existsSync(path.join(consoleDist, 'index.html'))) {
    throw new Error('console-dist/index.html is missing. Run npm run build before the layout smoke.');
  }
  const url = await listen(server);
  await app.whenReady();

  window = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 320,
    minHeight: 320,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  await window.loadURL(url);

  const checks = [];
  for (const [width, height] of sizes) {
    window.setSize(width, height, false);
    for (const zoom of zoomFactors) {
      window.webContents.setZoomFactor(zoom);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const result = await measure(window);
      assertLayout(result, [width, height], zoom);
      checks.push({ width, height, zoom, viewport: result.viewport });
    }
  }

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  if (window && !window.isDestroyed()) window.destroy();
  await new Promise((resolve) => server.close(resolve));
  app.quit();
}
