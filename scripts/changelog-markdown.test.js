'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { insertChangelogEntry } = require('./changelog-markdown');

const entry = (date, title = \`entry \${date}\`) => ({
  date,
  title,
  category: 'Backend',
  description: \`Description for \${title}.\`,
  priority: 'medium',
  status: 'completed'
});

const base = [
  '# Changelog',
  '',
  '## Recent Updates',
  '',
  'Entries are listed newest first.',
  '',
  '### October 2026',
  '',
  '#### existing newer entry',
  '',
  '**2026-10-22 · Backend · completed · Priority: medium**',
  '',
  'Newer description.',
  '',
  '#### existing older entry',
  '',
  '**2026-10-18 · Backend · completed · Priority: medium**',
  '',
  'Older description.',
  '',
  '### September 2026',
  '',
  '#### September entry',
  '',
  '**2026-09-30 · Backend · completed · Priority: medium**',
  '',
  'September description.',
  '',
  '### May 2026',
  '',
  '#### May entry',
  '',
  '**2026-05-20 · Backend · completed · Priority: medium**',
  '',
  'May description.',
  '',
  '## Categories',
  '',
  'Backend'
].join('\n');

test('inserts a new entry in descending date order within an existing month', () => {
  const result = insertChangelogEntry(base, entry('2026-10-20'));
  const dates = [...result.matchAll(/^\*\*(\d{4}-\d{2}-\d{2}) ·/gm)].map(match => match[1]);
  assert.deepEqual(dates, ['2026-10-22', '2026-10-20', '2026-10-18', '2026-09-30']);
  assert.match(result, /#### entry 2026-10-20\n\n\*\*2026-10-20 · Backend · completed · Priority: medium\*\*/);
  assert.doesNotMatch(result, /^\[2026-10-20\] - Backend/m);
});

test('creates a missing month between existing month sections', () => {
  const result = insertChangelogEntry(base, entry('2026-09-12'));
  const months = [...result.matchAll(/^### ((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4})$/gm)]
    .map(match => match[1]);
  assert.deepEqual(months, ['October 2026', 'September 2026']);
  const september = result.indexOf('### September 2026');
  const mayNotPresent = result.includes('### May 2026');
  assert.equal(mayNotPresent, false);
  assert.ok(result.indexOf('#### entry 2026-09-12') > september);
  assert.ok(result.indexOf('#### entry 2026-09-12') < result.indexOf('#### September entry'));
});

test('adds an older month before the category appendix', () => {
  const result = insertChangelogEntry(base, entry('2026-04-20'));
  assert.ok(result.indexOf('### April 2026') > result.indexOf('### May 2026'));
  assert.ok(result.indexOf('### April 2026') < result.indexOf('## Categories'));
  assert.ok(result.indexOf('#### entry 2026-04-20') < result.indexOf('## Categories'));
});

test('rejects invalid calendar dates instead of creating malformed headings', () => {
  assert.throws(() => insertChangelogEntry(base, entry('2026-02-30')), /valid YYYY-MM-DD/);
});
