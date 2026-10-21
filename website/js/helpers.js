import { API_BASE, CONTENT_URL, USE_API } from './config.js?v=20261021-hosting-1';
import { byOrder, normalizeFormUrl, separateFileInstructions } from './domain.js?v=20261021-file-blocks-2';
export const $ = (query, root = document) => root.querySelector(query);
export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function apiUrl(path) {
  const match = path.match(/^\/api\/public\/files\/([a-zA-Z0-9_-]+)(\?.*)?$/);
  if (!USE_API && match)
    return new URL('../data/files/' + match[1] + '.pdf' + (match[2] || ''), import.meta.url).href;
  return API_BASE + path;
}
export async function loadContent() {
  return api(USE_API ? '/api/public/content' : CONTENT_URL);
}
export async function api(path, options = {}) {
  const response = await fetch(path.startsWith('/api/') ? apiUrl(path) : path, {
    cache: 'no-store',
    credentials: path.startsWith('/api/admin/') ? 'same-origin' : 'omit',
    ...options,
  });
  const result = await response.json().catch(() => ({ error: 'השירות החזיר תשובה שאינה תקינה.' }));
  if (!response.ok) {
    const error = new Error([result.error, ...(result.details || [])].join('\n'));
    error.status = response.status;
    throw error;
  }
  return result;
}
export function message(text, error = false, target = $('#messages')) {
  target.className = `notice ${error ? 'notice-error' : 'notice-success'}`;
  target.textContent = text;
  target.hidden = !text;
  target.setAttribute('role', error ? 'alert' : 'status');
}
export function icon(name, size = 22) {
  const paths = {
    arrow: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    external:
      '<path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/>',
    edit: '<path d="m16 3 5 5L8 21H3v-5Z M13 6l5 5"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    file: '<path d="M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8Z M14 2v6h6 M8 13h8 M8 17h5"/>',
    group:
      '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3 M17 4a3 3 0 0 1 0 6 M21 21v-3a6 6 0 0 0-3-5"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Z M2 12l10 5 10-5 M2 17l10 5 10-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    plus: '<path d="M12 5v14 M5 12h14"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5 M4 17v4h16v-4"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.layers}</svg>`;
}
function inline(text, parent) {
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    let node;
    if (match[2]) {
      node = document.createElement('strong');
      node.textContent = match[2];
    } else if (match[3]) {
      node = document.createElement('code');
      node.textContent = match[3];
      node.dir = 'auto';
    } else {
      node = document.createElement('a');
      node.textContent = match[4];
      node.href = match[5];
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
    parent.append(node);
    cursor = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}
export function markdown(text) {
  const root = document.createElement('div');
  root.className = 'prose';
  let list = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) {
      list = null;
      continue;
    }
    let node,
      body = line;
    if (/^[-*] /.test(line)) {
      if (!list) {
        list = document.createElement('ul');
        root.append(list);
      }
      node = document.createElement('li');
      list.append(node);
      body = line.slice(2);
    } else {
      list = null;
      node = document.createElement(/^#{1,3} /.test(line) ? 'h4' : 'p');
      body = line.replace(/^#{1,3} /, '');
      root.append(node);
    }
    inline(body, node);
  }
  return root;
}
export function safeStorage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

const e = escapeHtml;
export function renderRecords(target, data, stageId, groupId, { preview = false } = {}) {
  target.replaceChildren();
  data = separateFileInstructions(data);
  const published = (item) => preview || item.published;
  const common = data.instructions
    .filter((x) => x.stageId === stageId && x.groupId === null && published(x))
    .sort(byOrder);
  const specific = groupId
    ? data.instructions
        .filter((x) => x.stageId === stageId && x.groupId === groupId && published(x))
        .sort(byOrder)
    : [];
  const forms = data.forms
    .filter(
      (x) => x.stageId === stageId && (x.groupId === null || x.groupId === groupId) && published(x),
    )
    .sort(byOrder);
  function instruction(item) {
    const article = document.createElement('article');
    article.className = 'instruction';
    const title = document.createElement('h3');
    title.textContent = item.title;
    article.append(title);
    if (item.body.trim()) article.append(markdown(item.body));
    for (const fileId of item.fileIds) {
      const file = data.files.find((f) => f.id === fileId);
      if (!file) continue;
      const row = document.createElement('div');
      row.className = 'file-row';
      const path = `/api/${preview ? 'admin' : 'public'}/files/${file.id}?v=${file.version}`;
      row.innerHTML = `<span class="file-icon">${icon('file')}</span><div class="file-name"><strong>${e(file.name)}</strong><span>PDF · ${Math.ceil(file.size / 1024)} KB</span></div><div class="file-actions"><a class="btn btn-outline-primary btn-sm" href="${e(apiUrl(path))}" target="_blank" rel="noopener">פתיחת PDF ${icon('external', 16)}</a><a class="icon-button" href="${e(apiUrl(path + '&download=1'))}" aria-label="הורדת PDF: ${e(file.name)}" title="הורדת PDF">${icon('download')}</a></div>`;
      row.querySelector('a[title="הורדת PDF"]').download = file.name;
      article.append(row);
    }
    return article;
  }
  function formCard(form) {
    let urls;
    try {
      urls = normalizeFormUrl(form.openUrl);
    } catch {
      return null;
    }
    const section = document.createElement('section');
    section.className = 'form-card';
    section.innerHTML = `<p class="section-label">${form.responseType === 'group' ? 'מענה קבוצתי' : 'מענה אישי'}</p><h3>${e(form.title)}</h3><p>${e(form.description)}</p><div class="action-row"><button class="btn btn-primary" type="button" data-open-form>פתיחת הטופס כאן</button><a class="btn btn-outline-primary" href="${e(urls.openUrl)}" target="_blank" rel="noopener noreferrer">פתיחת הטופס בכרטיסייה חדשה ${icon('external', 18)}</a></div><div class="form-frame"></div>`;
    section.querySelector('[data-open-form]').addEventListener('click', (event) => {
      const iframe = document.createElement('iframe');
      iframe.src = urls.embedUrl;
      iframe.title = form.title;
      iframe.className = 'google-form';
      iframe.referrerPolicy = 'no-referrer';
      section.querySelector('.form-frame').append(iframe);
      event.currentTarget.hidden = true;
    });
    return section;
  }
  const commonForms = [], groupForms = [];
  for (const form of forms) {
    const card = formCard(form);
    if (card) (form.groupId === null ? commonForms : groupForms).push(card);
  }
  if (common.length) {
    const label = document.createElement('p');
    label.className = 'section-label';
    label.textContent = 'לכל הקבוצות';
    target.append(label);
    for (const x of common) target.append(instruction(x));
  }
  target.append(...commonForms);
  if (stageId !== null || specific.length || groupForms.length) {
    const box = document.createElement('section');
    box.className = 'group-content';
    const group = data.groups.find((g) => g.id === groupId);
    box.innerHTML = `<div class="group-content-title">${icon('group')}<h3>${group ? `המרחב של קבוצה ${e(group.number)}` : 'המרחב של הקבוצה שלכם'}</h3></div>`;
    if (!groupId) {
      const p = document.createElement('p');
      p.textContent = 'בחרו את מספר הקבוצה כדי לראות את התוכן המיועד לכם.';
      box.append(p);
    } else if (!specific.length && !groupForms.length) {
      const p = document.createElement('p');
      p.textContent = 'אין הנחיות נוספות לקבוצה בשלב זה';
      box.append(p);
    } else {
      for (const item of specific) box.append(instruction(item));
      box.append(...groupForms);
    }
    target.append(box);
  }
  if (!target.children.length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'ההנחיות לשלב זה יפורסמו כאן על ידי המרצה.';
    target.append(p);
  }
}
