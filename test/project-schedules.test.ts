import assert from 'node:assert/strict';
import test from 'node:test';

import { nextProjectScheduleRun } from '../app/src/project-schedules.js';

test('project schedules do not invent runs for paused or manual tasks', () => {
  assert.equal(nextProjectScheduleRun({ frequency: 'manual', enabled: true }), undefined);
  assert.equal(nextProjectScheduleRun({ frequency: 'daily', enabled: false, time: '09:00' }), undefined);
});

test('daily project schedules move to the next matching local wall-clock time', () => {
  const before = new Date(2026, 8, 3, 8, 30, 0, 0);
  const sameDay = new Date(nextProjectScheduleRun({ frequency: 'daily', enabled: true, time: '09:00' }, before)!);
  assert.equal(sameDay.getFullYear(), 2026);
  assert.equal(sameDay.getMonth(), 8);
  assert.equal(sameDay.getDate(), 3);
  assert.equal(sameDay.getHours(), 9);
  assert.equal(sameDay.getMinutes(), 0);

  const after = new Date(2026, 8, 3, 10, 30, 0, 0);
  const nextDay = new Date(nextProjectScheduleRun({ frequency: 'daily', enabled: true, time: '09:00' }, after)!);
  assert.equal(nextDay.getDate(), 4);
  assert.equal(nextDay.getHours(), 9);
  assert.equal(nextDay.getMinutes(), 0);
});

test('weekday schedules skip weekends', () => {
  const fridayAfterRun = new Date(2026, 8, 4, 18, 0, 0, 0);
  const monday = new Date(nextProjectScheduleRun({ frequency: 'weekdays', enabled: true, time: '09:00' }, fridayAfterRun)!);
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getHours(), 9);
  assert.equal(monday.getMinutes(), 0);
});

test('weekly schedules keep the requested weekday and local time', () => {
  const thursday = new Date(2026, 8, 3, 12, 0, 0, 0);
  const monday = new Date(nextProjectScheduleRun({ frequency: 'weekly', enabled: true, weekday: 1, time: '14:30' }, thursday)!);
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getHours(), 14);
  assert.equal(monday.getMinutes(), 30);
});
