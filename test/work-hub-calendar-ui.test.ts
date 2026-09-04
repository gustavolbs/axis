import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const workHub = read('app/src/GlobalWorkHubLauncher.tsx');
const fixes = read('app/src/lc-fixes.css');

test('Work Hub Calendar renders a seven-day time grid instead of stacked day lists', () => {
  assert.match(workHub, /className="work-hub-week-scroll"/);
  assert.match(workHub, /className="work-hub-week-header"/);
  assert.match(workHub, /className="work-hub-all-day"/);
  assert.match(workHub, /className="work-hub-week-grid"/);
  assert.match(workHub, /<foreignObject/);
  assert.match(workHub, /placeCalendarEvents/);
  assert.match(workHub, /work-hub-now/);
  assert.doesNotMatch(workHub, /work-hub-list work-hub-week-list/);
});

test('Calendar event detail tooltip paints above neighboring SVG event blocks', () => {
  assert.match(workHub, /className="work-hub-calendar-tooltip" role="tooltip"/);
  assert.match(workHub, /activeCalendarEventKey/);
  assert.match(workHub, /paintedCalendarPlacements/);
  assert.match(workHub, /Number\(calendarEventKey\(left\.event\) === activeCalendarEventKey\)/);
  assert.match(workHub, /onMouseEnter=\{\(\) => setActiveCalendarEventKey\(key\)\}/);
  assert.match(workHub, /onFocus=\{\(\) => setActiveCalendarEventKey\(key\)\}/);
  assert.match(fixes, /\.work-hub-week-grid foreignObject\s*\{\s*overflow: visible;/);
  assert.match(fixes, /\.work-hub-calendar-tooltip\s*\{[\s\S]*?z-index:\s*20;/);
});
