import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialContent,
  validateContent,
  publicContent,
  stageIsOpen,
  latestOpenStage,
  israelToUtc,
  utcToIsraelInput,
  normalizeFormUrl,
  validInstant,
  cleanContent,
  separateFileInstructions,
  removeDraftFile,
  newestInstructions,
} from '../../website/js/domain.js';
test('35 groups have unique stable IDs and numbers, and 5 unscheduled draft stages', () => {
  const data = initialContent();
  assert.equal(data.groups.length, 35);
  assert.equal(new Set(data.groups.map((x) => x.id)).size, 35);
  assert.equal(data.groups.at(-1).number, 35);
  assert.equal(data.stages.length, 5);
  assert.ok(data.stages.every((s) => !s.published && s.opensAt === null));
  assert.deepEqual(validateContent(data), []);
});
test('draft stages, draft instructions, inactive groups and unreferenced files are never public', () => {
  const data = initialContent();
  data.groups[0].active = false;
  data.instructions.push({
    ...data.instructions[0],
    id: 'private',
    published: false,
    body: 'secret',
  });
  data.instructions.push({
    ...data.instructions[0],
    id: 'future-private',
    stageId: 'stage-1',
    body: 'unpublished stage',
  });
  const result = publicContent(data);
  assert.equal(result.groups.length, 34);
  assert.equal(result.stages.length, 0);
  assert.equal(result.instructions.length, 1);
  assert.equal(result.files.length, 0);
});
test('future published content is served, with client-side opening exactly at device time', () => {
  const data = initialContent();
  const stage = data.stages[0];
  stage.published = true;
  stage.opensAt = '2026-10-21T10:00:00Z';
  assert.equal(publicContent(data).stages.length, 1);
  assert.equal(stageIsOpen(stage, Date.parse('2026-10-21T09:59:59Z')), false);
  assert.equal(stageIsOpen(stage, Date.parse(stage.opensAt)), true);
  assert.equal(latestOpenStage(data.stages, Date.parse('2026-10-21T11:00:00Z')), stage.id);
  stage.published = false;
  assert.equal(stageIsOpen(stage, Date.parse('2027-01-01T00:00:00Z')), false);
});
test('Israel summer and winter times convert to unambiguous UTC and round trip', () => {
  assert.equal(israelToUtc('2026-07-01T12:00'), '2026-07-01T09:00:00.000Z');
  assert.equal(israelToUtc('2026-12-01T12:00'), '2026-12-01T10:00:00.000Z');
  assert.equal(utcToIsraelInput('2026-07-01T09:00:00.000Z'), '2026-07-01T12:00');
});
test('invalid and DST gap/overlap dates are rejected', () => {
  assert.throws(() => israelToUtc('2026-02-30T12:00'));
  assert.throws(() => israelToUtc('2026-03-27T02:30'));
  assert.throws(() => israelToUtc('2026-10-25T01:30'));
  assert.equal(validInstant('2026-02-30T10:00:00Z'), false);
  assert.equal(validInstant('2026-10-21T12:00:00+03:00'), false);
});
test('publishing requires valid schedule, unique IDs, valid assignments and actual instruction content', () => {
  const data = initialContent();
  data.stages[0].published = true;
  data.groups[1].number = 1;
  data.stages[1].id = data.stages[0].id;
  data.instructions[0].groupId = 'missing';
  data.instructions[0].body = '';
  const errors = validateContent(data);
  assert.ok(errors.length >= 5);
});
test('only full HTTPS Google Forms URLs are accepted and embed HTML is discarded', () => {
  const result = normalizeFormUrl(
    '<iframe src="https://docs.google.com/forms/d/e/ABC_123/viewform?embedded=true&amp;foo=bar" onload="evil()"></iframe>',
  );
  assert.equal(result.openUrl, 'https://docs.google.com/forms/d/e/ABC_123/viewform');
  assert.equal(result.embedUrl, result.openUrl + '?embedded=true');
  for (const url of [
    'javascript:alert(1)',
    'https://evil.com/forms/d/e/X/viewform',
    'https://docs.google.com.evil.com/forms/d/X/viewform',
    'https://forms.gle/x',
    'http://docs.google.com/forms/d/X/viewform',
    'https://docs.google.com:444/forms/d/X/viewform',
  ])
    assert.throws(() => normalizeFormUrl(url));
});
test('server schema removes arbitrary HTML attributes and hidden fields, preserving text as data', () => {
  const data = initialContent();
  data.instructions[0].body = '<script>alert(1)</script>';
  data.instructions[0].html = '<img onerror="evil()">';
  data.activity.secret = 'no';
  const clean = cleanContent(data);
  assert.equal(clean.instructions[0].html, undefined);
  assert.equal(clean.activity.secret, undefined);
  assert.equal(clean.instructions[0].body, data.instructions[0].body);
});

test('legacy attachments become separate file blocks without changing text, scope or publication', () => {
  const data = initialContent();
  data.files = ['first', 'second', 'unattached'].map((id) => ({
    id, name: `${id}.pdf`, size: 50, version: 'a'.repeat(64),
  }));
  Object.assign(data.instructions[0], {
    groupId: 'group-3', fileIds: ['first', 'second'],
  });
  const before = structuredClone(data);
  const result = separateFileInstructions(data);
  const text = result.instructions.find((item) => item.id === 'welcome');
  assert.equal(text.body, data.instructions[0].body);
  assert.deepEqual(text.fileIds, []);
  const files = result.instructions.filter((item) => item.fileIds.length);
  assert.equal(files.length, 3);
  assert.ok(files.every((item) => item.body === '' && item.fileIds.length === 1));
  for (const file of files.filter((item) => item.fileIds[0] !== 'unattached')) {
    assert.equal(file.groupId, 'group-3');
    assert.equal(file.stageId, null);
    assert.equal(file.published, true);
  }
  assert.equal(files.find((item) => item.fileIds[0] === 'unattached').published, false);
  assert.equal(new Set(result.instructions.map((item) => item.id)).size, result.instructions.length);
  assert.deepEqual(separateFileInstructions(result), result);
  assert.deepEqual(validateContent(result), []);
  assert.deepEqual(data, before);
});

test('file deletion preserves text, other files and the source draft', () => {
  const data = initialContent();
  data.files = ['first', 'second'].map((id) => ({
    id, name: `${id}.pdf`, size: 50, version: 'a'.repeat(64),
  }));
  data.instructions[0].fileIds = ['first', 'second'];
  const result = removeDraftFile(data, 'first');
  assert.equal(result.instructions.find((item) => item.id === 'welcome').body, data.instructions[0].body);
  assert.ok(result.instructions.every((item) => !item.fileIds.includes('first')));
  assert.deepEqual(result.files.map((file) => file.id), ['second']);
  assert.equal(result.instructions.filter((item) => item.fileIds.includes('second')).length, 1);
  assert.deepEqual(validateContent(result), []);
  assert.equal(data.files.length, 2);
});

test('editor instructions use creation time descending regardless of student display order', () => {
  const instructions = [
    { id: 'legacy-first', order: 100 },
    { id: 'legacy-second', order: 1 },
    { id: 'text', order: 20, createdAt: '2026-10-21T10:00:00.000Z' },
    { id: 'pdf', order: 5, createdAt: '2026-10-21T11:00:00.000Z' },
    { id: 'another-text', order: 2, createdAt: '2026-10-21T11:00:00.000Z' },
  ];
  const before = structuredClone(instructions);
  assert.deepEqual(newestInstructions(instructions).map((item) => item.id), [
    'another-text', 'pdf', 'text', 'legacy-second', 'legacy-first',
  ]);
  assert.deepEqual(instructions, before);
  const data = initialContent();
  data.instructions[0].createdAt = '2026-10-21T10:00:00.000Z';
  const saved = cleanContent(data);
  assert.equal(saved.instructions[0].createdAt, data.instructions[0].createdAt);
  assert.deepEqual(validateContent(saved), []);
});
