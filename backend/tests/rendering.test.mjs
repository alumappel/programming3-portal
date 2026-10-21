import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialContent } from '../../website/js/domain.js';
import { renderRecords } from '../../website/js/helpers.js';

// A small DOM substitute for renderer unit tests. No browser is opened or controlled.
class Element {
  children = [];
  className = '';
  textContent = '';
  innerHTML = '';
  parts = new Map();
  listeners = new Map();

  constructor(tagName) { this.tagName = tagName; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  querySelector(selector) {
    if (!['[data-open-form]', '.form-frame', 'a[title="הורדת PDF"]'].includes(selector)) return null;
    if (!this.parts.has(selector)) this.parts.set(selector, new Element('div'));
    return this.parts.get(selector);
  }
}

function fixture(t) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (textContent) => ({ textContent }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  return { target: new Element('div'), data: initialContent() };
}

const form = (overrides = {}) => ({
  id: 'personal-form', title: 'Personal form', description: '',
  stageId: 'stage-1', groupId: 'group-3', responseType: 'individual',
  order: 1, published: true,
  openUrl: 'https://docs.google.com/forms/d/e/FORM_123/viewform',
  ...overrides,
});
const tree = (node) => [node, ...(node.children || []).flatMap(tree)];
const cards = (target) => tree(target).filter((node) => node.className === 'form-card');
const emptyGroupMessage = (target) => tree(target).some(
  (node) => node.textContent === 'אין הנחיות נוספות לקבוצה בשלב זה',
);

test('a group with only a personal form has content, without an empty instructions message', (t) => {
  const { target, data } = fixture(t);
  data.forms = [form()];
  renderRecords(target, data, 'stage-1', 'group-3');
  const group = target.children.find((node) => node.className === 'group-content');
  assert.equal(emptyGroupMessage(target), false);
  assert.equal(cards(group).length, 1);
  const card = cards(group)[0];
  assert.match(card.innerHTML, /מענה אישי/);
  assert.match(card.innerHTML, /Personal form/);
  assert.doesNotMatch(card.innerHTML, /אם נדרש מספר קבוצה|אישור השליחה מתקבל מ־Google Forms/);
  const button = card.querySelector('[data-open-form]');
  button.listeners.get('click')({ currentTarget: button });
  const iframe = card.querySelector('.form-frame').children[0];
  assert.equal(iframe.src, data.forms[0].openUrl + '?embedded=true');
  assert.equal(iframe.title, 'Personal form');
  assert.equal(button.hidden, true);
});

test('common forms and group forms keep their stage, group and publication filters', (t) => {
  const { target, data } = fixture(t);
  data.forms = [
    form({ id: 'common', groupId: null }),
    form(),
    form({ id: 'other-group', groupId: 'group-4' }),
    form({ id: 'draft', published: false }),
    form({ id: 'other-stage', stageId: 'stage-2' }),
  ];
  renderRecords(target, data, 'stage-1', 'group-3');
  assert.equal(cards(target).length, 2);
  const group = target.children.find((node) => node.className === 'group-content');
  assert.equal(cards(group).length, 1);
  assert.equal(target.children.filter((node) => node.className === 'form-card').length, 1);
  renderRecords(target, data, 'stage-1', 'group-2');
  assert.equal(cards(target).length, 1);
  assert.equal(emptyGroupMessage(target), true);
  renderRecords(target, data, 'stage-1', '');
  assert.equal(cards(target).length, 1);
  assert.equal(emptyGroupMessage(target), false);
  renderRecords(target, data, 'stage-1', 'group-3', { preview: true });
  assert.equal(cards(target).length, 3);
});

test('a group form without a stage appears in the general group area', (t) => {
  const { target, data } = fixture(t);
  data.forms = [form({ stageId: null })];
  renderRecords(target, data, null, 'group-3');
  const group = target.children.find((node) => node.className === 'group-content');
  assert.ok(group);
  assert.equal(cards(group).length, 1);
  assert.equal(emptyGroupMessage(target), false);
});

test('a group with only a PDF has content and download links, without an empty message', (t) => {
  const { target, data } = fixture(t);
  data.files = [{ id: 'file-only', name: 'instructions.pdf', size: 100, version: 'a'.repeat(64) }];
  data.instructions = [{
    id: 'pdf-instruction', title: 'PDF instructions', body: '', fileIds: ['file-only'],
    stageId: 'stage-1', groupId: 'group-3', published: true, order: 1,
  }];
  renderRecords(target, data, 'stage-1', 'group-3');
  assert.equal(emptyGroupMessage(target), false);
  const group = target.children.find((node) => node.className === 'group-content');
  const instruction = group.children.find((node) => node.className === 'instruction');
  assert.ok(instruction);
  assert.equal(instruction.children.some((node) => node.className === 'prose'), false);
  const row = instruction.children.find((node) => node.className === 'file-row');
  assert.match(row.innerHTML, /instructions\.pdf/);
  assert.match(row.innerHTML, /data\/files\/file-only\.pdf/);
  assert.equal(row.querySelector('a[title="הורדת PDF"]').download, 'instructions.pdf');
  renderRecords(target, data, 'stage-1', 'group-2');
  assert.equal(emptyGroupMessage(target), true);
  data.instructions[0].published = false;
  renderRecords(target, data, 'stage-1', 'group-3');
  assert.equal(emptyGroupMessage(target), true);
  renderRecords(target, data, 'stage-1', 'group-3', { preview: true });
  assert.equal(emptyGroupMessage(target), false);
});

test('legacy text and two attachments render as three independent instruction blocks', (t) => {
  const { target, data } = fixture(t);
  data.files = ['first', 'second'].map((id) => ({
    id, name: `${id}.pdf`, size: 100, version: 'a'.repeat(64),
  }));
  Object.assign(data.instructions[0], {
    stageId: 'stage-1', groupId: 'group-3', fileIds: ['first', 'second'],
  });
  renderRecords(target, data, 'stage-1', 'group-3');
  const instructions = tree(target).filter((node) => node.className === 'instruction');
  assert.equal(instructions.length, 3);
  assert.deepEqual(instructions.map(
    (node) => node.children.filter((child) => child.className === 'file-row').length,
  ), [0, 1, 1]);
  assert.equal(emptyGroupMessage(target), false);
});
