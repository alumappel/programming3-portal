import {
  formatDate,
  utcToIsraelInput,
  israelToUtc,
  validateContent,
  byOrder,
  stageIsOpen,
  separateFileInstructions,
  removeDraftFile,
  newestInstructions,
} from './domain.js?v=20261021-file-blocks-2';
import { $, api, apiUrl, escapeHtml as e, icon, message } from './helpers.js?v=20261021-file-blocks-2';
import { renderRecords } from './helpers.js?v=20261021-file-blocks-2';
import { PUBLIC_SITE_URL, ADMIN_URL, IS_ADMIN_ORIGIN } from './config.js?v=20261021-vanilla-1';
$('#student-link').href = PUBLIC_SITE_URL;
let state,
  draft,
  csrf = '',
  dirty = false,
  tab = 'overview',
  working = false,
  pendingOperation = null;
const panel = $('#editor-panel');
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const request = (path, method = 'GET', body) =>
  api(`/api/admin/${path}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'X-CSRF-Token': csrf,
    },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
const checked = (value) => (value ? 'checked' : '');
const options = (items, value, label, empty) =>
  `<option value="">${e(empty)}</option>` +
  items
    .map(
      (x) =>
        `<option value="${e(x.id)}" ${x.id === value ? 'selected' : ''}>${e(label(x))}</option>`,
    )
    .join('');
function field(collection, item, key, label, type = 'text', extra = '') {
  const uid = `${item.id || collection}-${key}`;
  const data = `data-collection="${collection}" data-id="${e(item.id || '')}" data-field="${key}" id="${e(uid)}"`;
  if (type === 'checkbox')
    return `<label class="check-label"><input type="checkbox" class="form-check-input" ${data} ${checked(item[key])}>${e(label)}</label>`;
  if (type === 'textarea')
    return `<div class="mb-3"><label class="form-label" for="${e(uid)}">${e(label)}</label><textarea class="form-control" ${data} rows="${key === 'body' ? 7 : 3}" ${extra}>${e(item[key])}</textarea></div>`;
  return `<div class="mb-3"><label class="form-label" for="${e(uid)}">${e(label)}</label><input class="form-control" ${data} type="${type}" value="${e(type === 'datetime-local' ? utcToIsraelInput(item[key]) : item[key])}" ${extra}></div>`;
}
function setDirty() {
  dirty = true;
  updateStatus();
}
function updateStatus() {
  $('#save-status').textContent = dirty
    ? 'יש שינויים שטרם נשמרו'
    : state.savedAt
      ? `הטיוטה נשמרה · ${formatDate(state.savedAt)}`
      : 'נתוני פתיחה · 35 קבוצות מוכנות';
  $('#save-status').classList.toggle('unsaved', dirty);
}
function loadState(result) {
  state = result;
  draft = separateFileInstructions(result.draft);
  dirty = JSON.stringify(draft) !== JSON.stringify(result.draft);
  updateStatus();
}
async function run(action) {
  if (working) return;
  working = true;
  const buttons = [$('#save'), $('#publish'), $('#logout'), $('#login-form button[type="submit"]'), $('#setup-form button[type="submit"]')];
  buttons.forEach((b) => (b.disabled = true));
  panel.setAttribute('aria-busy', 'true');
  panel.inert = true;
  try {
    await action();
  } catch (error) {
    message(error.message, true);
    if (error.status === 401 && state) $('#login-panel').hidden = false;
  } finally {
    working = false;
    buttons.forEach((b) => (b.disabled = false));
    panel.removeAttribute('aria-busy');
    panel.inert = false;
  }
}
function downloadDraft() {
  const blob = new Blob(
    [
      JSON.stringify(
        { exportedAt: new Date().toISOString(), baseRevision: state.revision, content: draft },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = `portal-draft-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveDraft() {
  if (pendingOperation)
    throw new Error('מצב הפרסום הקודם טרם הובהר. השתמשו בבדיקת מצב לפני שמירת שינוי נוסף.');
  const errors = validateContent(draft);
  if (errors.length) throw new Error(errors.join('\n'));
  const result = await request('draft', 'PUT', { revision: state.revision, content: draft });
  loadState(result.state);
  message('הטיוטה נשמרה. התצוגה החיה לא השתנתה.');
}
function scopeFields(collection, item) {
  return `<div class="row g-3"><div class="col-md-6"><label for="${e(item.id)}-stage" class="form-label">שיוך לשלב</label><select id="${e(item.id)}-stage" class="form-select" data-collection="${collection}" data-id="${e(item.id)}" data-field="stageId">${options(draft.stages, item.stageId, (x) => x.title, 'הנחיה כללית לפעילות')}</select></div><div class="col-md-6"><label for="${e(item.id)}-group" class="form-label">למי מיועד התוכן?</label><select id="${e(item.id)}-group" class="form-select" data-collection="${collection}" data-id="${e(item.id)}" data-field="groupId">${options(draft.groups, item.groupId, (x) => `קבוצה ${x.number}${x.active ? '' : ' (לא פעילה)'}`, 'לכל הקבוצות')}</select></div></div>`;
}
function removeButton(collection, item, label = 'הסרת הרשומה') {
  return `<button class="btn btn-outline-danger btn-sm" data-remove="${collection}" data-id="${e(item.id)}" type="button">${label}</button>`;
}
function instructionCard(item) {
  const file = item.fileIds.length ? draft.files.find((f) => f.id === item.fileIds[0]) : null;
  const scope = item.groupId
    ? 'לקבוצה ' + e(draft.groups.find((g) => g.id === item.groupId)?.number)
    : 'לכל הקבוצות';
  const remove = file
    ? `<button class="btn btn-outline-danger btn-sm" data-remove-file="${e(file.id)}" type="button">מחיקת הקובץ</button>`
    : removeButton('instructions', item, 'מחיקת ההנחיה');
  const body = file
    ? `<div class="file-row"><span class="file-icon">${icon('file')}</span><div class="file-name"><strong>${e(file.name)}</strong><span>PDF · ${Math.ceil(file.size / 1024)} KB</span></div><a class="btn btn-outline-primary btn-sm" href="${e(apiUrl(`/api/admin/files/${file.id}?v=${file.version}`))}" target="_blank" rel="noopener">פתיחת PDF ${icon('external', 16)}</a></div>`
    : field('instructions', item, 'body', 'טקסט ההנחיה', 'textarea', 'maxlength="40000"');
  return `<section class="editor-card" data-instruction="${e(item.id)}"><div class="card-top"><span class="tag">${file ? 'הנחיית קובץ' : 'הנחיית טקסט'} · ${scope}</span>${remove}</div>${field('instructions', item, 'title', 'כותרת ההנחיה', 'text', 'maxlength="200"')}${scopeFields('instructions', item)}<div class="mt-3">${body}</div>${field('instructions', item, 'order', 'סדר התצוגה', 'number', 'min="1"')}${field('instructions', item, 'published', 'לכלול את ההנחיה בפרסום הבא', 'checkbox')}</section>`;
}
function render() {
  $('#admin-tabs')
    .querySelectorAll('[data-tab]')
    .forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  if (tab === 'overview') {
    panel.innerHTML = `<div class="metric-row"><div class="metric-card"><span>${icon('group')}</span><strong>${draft.groups.filter((g) => g.active).length}</strong><p>קבוצות פעילות</p></div><div class="metric-card"><span>${icon('layers')}</span><strong>${draft.stages.length}</strong><p>שלבי פעילות</p></div><div class="metric-card"><span>${icon('file')}</span><strong>${draft.instructions.length}</strong><p>הנחיות בטיוטה</p></div></div><section class="editor-card"><p class="eyebrow">הבסיס לפעילות</p><h2>פרטי הפעילות</h2>${field('activity', draft.activity, 'title', 'שם הפעילות', 'text', 'maxlength="200"')}${field('activity', draft.activity, 'description', 'תיאור קצר', 'textarea', 'maxlength="4000"')}<p class="small muted">שינויים בטיוטה מוצגים לסטודנטים רק לאחר פרסום הפעילות.</p></section><section class="editor-card"><h2>הגרסה החיה</h2><p>${state.live.publishedAt ? 'פורסמה ב־' + e(formatDate(state.live.publishedAt)) : 'טרם בוצע פרסום ראשון'}</p><p class="small ltr">${e(state.live.version)}</p><button class="btn btn-outline-primary" data-action="status">בדיקת מצב</button><button class="btn btn-outline-primary ms-2" data-action="reload">טעינת גרסה עדכנית</button></section>`;
  } else if (tab === 'stages') {
    panel.innerHTML =
      `<div class="section-heading"><h2>שלבים ומועדים</h2><button class="btn btn-outline-primary" data-add="stages">${icon('plus', 18)} הוספת שלב</button></div><p class="muted">הזינו תאריך ושעה לפי שעון ישראל. שינוי הסדר אינו משנה את מועד הפתיחה.</p>` +
      draft.stages
        .sort(byOrder)
        .map(
          (s) =>
            `<section class="editor-card"><div class="card-top"><span class="tag">שלב ${e(s.order)}</span>${removeButton('stages', s)}</div><div class="row g-3"><div class="col-md-9">${field('stages', s, 'title', 'שם השלב', 'text', 'maxlength="200"')}</div><div class="col-md-3">${field('stages', s, 'order', 'סדר', 'number', 'min="1"')}</div></div>${field('stages', s, 'description', 'תיאור השלב', 'textarea', 'maxlength="4000"')}${field('stages', s, 'opensAt', 'מועד פתיחה לפי שעון ישראל', 'datetime-local')}${field('stages', s, 'published', 'לכלול את השלב בפרסום הבא', 'checkbox')}</section>`,
        )
        .join('');
  } else if (tab === 'groups') {
    panel.innerHTML =
      `<div class="section-heading"><h2>הקבוצות בפעילות</h2><button class="btn btn-outline-primary" data-add="groups">${icon('plus', 18)} הוספת קבוצה</button></div><p class="muted">מספרי הקבוצות ייחודיים. שינוי המספר שומר על שיוכי התוכן.</p><div class="row g-3">` +
      draft.groups
        .sort((a, b) => a.number - b.number)
        .map(
          (g) =>
            `<div class="col-md-6 col-xl-4"><section class="editor-card group-editor"><h3>קבוצה ${e(g.number)}</h3>${field('groups', g, 'number', 'מספר הקבוצה', 'number', 'min="1"')}${field('groups', g, 'name', 'שם תצוגה או נושא (רשות)', 'text', 'maxlength="200"')}${field('groups', g, 'active', 'קבוצה פעילה', 'checkbox')}</section></div>`,
        )
        .join('') +
      '</div>';
  } else if (tab === 'instructions') {
    panel.innerHTML =
      `<div class="section-heading"><h2>הנחיות וקבצי PDF</h2><button class="btn btn-outline-primary" data-add="instructions">${icon('plus', 18)} הוספת הנחיית טקסט</button></div><p class="muted">ההנחיות מוצגות כאן מהחדש לישן. סדר התצוגה לסטודנטים נקבע בשדה ״סדר התצוגה״.</p><p class="muted">עריכה בטקסט בטוח: כותרת באמצעות ##, רשימה באמצעות -, הדגשה באמצעות **טקסט**, וקישור באמצעות [שם](https://…). אפשר להדביק טקסט מ־Word.</p><section class="upload-panel"><label for="pdf-upload" class="form-label">העלאת PDF כהנחיה נפרדת · עד 5MB</label><input class="form-control" type="file" id="pdf-upload" accept="application/pdf,.pdf"><p id="upload-status" class="small muted mt-2 mb-0" aria-live="polite">כל קובץ יוצר בלוק הנחיה משלו. לאחר ההעלאה בחרו שלב וקבוצה וסמנו אם לכלול אותו בפרסום.</p></section>` +
      newestInstructions(draft.instructions)
        .map(instructionCard)
        .join('');
  } else if (tab === 'forms') {
    panel.innerHTML =
      `<div class="section-heading"><h2>טפסי Google Forms</h2><button class="btn btn-outline-primary" data-add="forms">${icon('plus', 18)} הוספת טופס</button></div><p class="muted">הטפסים נכתבים ומנוהלים בגוגל. הפורטל מציג אותם ואינו קורא תשובות או מציג השלמת מענה.</p>` +
      draft.forms
        .map(
          (f) =>
            `<section class="editor-card"><div class="card-top"><span class="tag">Google Forms</span>${removeButton('forms', f)}</div>${field('forms', f, 'title', 'שם הטופס', 'text', 'maxlength="200"')}${field('forms', f, 'description', 'הסבר קצר', 'textarea', 'maxlength="4000"')}${field('forms', f, 'openUrl', 'קישור מלא או קוד הטמעה מגוגל', 'textarea', 'dir="ltr"')}${scopeFields('forms', f)}<div class="my-3"><label class="form-label" for="${e(f.id)}-type">סוג המענה</label><select class="form-select" id="${e(f.id)}-type" data-collection="forms" data-id="${e(f.id)}" data-field="responseType"><option value="group" ${f.responseType === 'group' ? 'selected' : ''}>קבוצתי</option><option value="individual" ${f.responseType === 'individual' ? 'selected' : ''}>אישי</option></select></div>${field('forms', f, 'order', 'סדר התצוגה', 'number', 'min="1"')}${field('forms', f, 'published', 'לכלול את הטופס בפרסום הבא', 'checkbox')}</section>`,
        )
        .join('');
  } else if (tab === 'preview') {
    panel.innerHTML = `<section class="preview-banner"><h2>${icon('eye')} תצוגה מקדימה של הטיוטה</h2><p>תצוגה פרטית למרצה. גם שינויים שטרם נשמרו מוצגים כאן; הם אינם משנים את האתר החי.</p><div class="row g-3"><div class="col-md-4"><label class="form-label" for="preview-group">קבוצה</label><select class="form-select" id="preview-group">${options(draft.groups, 'group-1', (g) => `קבוצה ${g.number}`, 'ללא קבוצה')}</select></div><div class="col-md-4"><label class="form-label" for="preview-stage">שלב</label><select class="form-select" id="preview-stage">${options(draft.stages, null, (s) => s.title, 'הנחיות כלליות')}</select></div><div class="col-md-4"><label class="form-label" for="preview-time">זמן הדמיה בשעון ישראל</label><input class="form-control" id="preview-time" type="datetime-local" value="${utcToIsraelInput(new Date().toISOString())}"></div></div><p class="small mt-3 mb-0" id="preview-availability"></p></section><div class="stage-panel" id="preview-content"></div>`;
    renderPreview();
  } else if (tab === 'history') {
    panel.innerHTML =
      `<h2>פרסום וגרסאות</h2><p class="muted">השחזור טוען תוכן שפורסם לטיוטה בלבד. בדקו את המועדים והקבצים בתצוגה המקדימה, ואז פרסמו כגרסה חדשה.</p><div class="action-row mb-4"><button class="btn btn-outline-primary" data-action="status">בדיקת מצב</button><button class="btn btn-outline-primary" data-action="reload">טעינת גרסה עדכנית</button></div>` +
      [state.live, ...state.history]
        .map(
          (h, i) =>
            `<section class="editor-card"><div class="card-top"><span class="tag">${i === 0 ? 'הגרסה החיה' : 'גרסה קודמת'}</span><span>${e(h.publishedAt ? formatDate(h.publishedAt) : 'נתוני פתיחה')}</span></div><p class="small ltr">${e(h.version)}</p><p>${h.content.groups.length} קבוצות · ${h.content.stages.length} שלבים · ${h.content.instructions.length} הנחיות · ${h.content.files.length} קבצים</p><ul>${h.content.stages.map((s) => `<li>${e(s.title)} · ${e(formatDate(s.opensAt))}</li>`).join('')}</ul><button class="btn btn-outline-primary" data-restore="${e(h.version)}">שחזור התוכן לטיוטה</button></section>`,
        )
        .join('');
  }
}
function renderPreview() {
  try {
    const stageId = $('#preview-stage').value || null,
      groupId = $('#preview-group').value || null;
    const stage = draft.stages.find((s) => s.id === stageId),
      now = israelToUtc($('#preview-time').value);
    const available = !stage || stageIsOpen({ ...stage, published: true }, Date.parse(now));
    $('#preview-availability').textContent = stage
      ? `${stage.published ? 'מסומן לפרסום' : 'שלב טיוטה'} · ${available ? 'זמין בזמן ההדמיה' : 'נעול בזמן ההדמיה'} · ${formatDate(stage.opensAt)}`
      : 'הנחיות כלליות לפעילות';
    if (available) renderRecords($('#preview-content'), draft, stageId, groupId, { preview: true });
    else
      $('#preview-content').innerHTML =
        '<div class="waiting-state"><h3>השלב נעול בזמן ההדמיה</h3><p>קבעו מועד פתיחה לשלב ובחרו זמן הדמיה מאוחר ממנו כדי לבדוק את התוכן.</p></div>';
  } catch (error) {
    message(error.message, true);
  }
}
async function authenticate() {
  const auth = await request('session');
  csrf = auth.csrf;
  const current = await request('state');
  // Reauthentication retains an unsaved editor buffer and its original revision.
  if (!dirty) loadState(current);
  $('#login-panel').hidden = true;
  $('#setup-panel').hidden = true;
  $('#workspace').hidden = false;
  $('#logout').hidden = false;
  render();
}
$('#show-password').addEventListener('change', (event) => {
  $('#password').type = event.target.checked ? 'text' : 'password';
});
$('#show-setup-password').addEventListener('change', (event) => {
  const type = event.target.checked ? 'text' : 'password';
  $('#setup-password').type = type;
  $('#setup-confirm').type = type;
});
$('#setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const password = $('#setup-password').value;
    if (password !== $('#setup-confirm').value) throw new Error('הסיסמאות אינן זהות. הקלידו אותן שוב.');
    try {
      await api('/api/local/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
    } catch (error) {
      if (error.status === 409) { $('#setup-panel').hidden = true; $('#login-panel').hidden = false; }
      throw error;
    }
    await request('login', 'POST', { username: 'Admin', password });
    $('#setup-password').value = '';
    $('#setup-confirm').value = '';
    await authenticate();
    message('הסיסמה נשמרה. אפשר להתחיל לערוך.');
  });
});
$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const result = await request('login', 'POST', {
      username: $('#username').value,
      password: $('#password').value,
    });
    csrf = result.csrf;
    $('#password').value = '';
    await authenticate();
    message('התחברתם לעורך.');
  });
});
$('#logout').addEventListener('click', () =>
  run(async () => {
    if (dirty && !confirm('יש שינויים שלא נשמרו. לצאת מהעורך?')) return;
    await request('logout', 'POST', {});
    dirty = false;
    state = null;
    draft = null;
    csrf = '';
    $('#workspace').hidden = true;
    $('#login-panel').hidden = false;
    $('#logout').hidden = true;
    message('יצאתם מהעורך.');
  }),
);
$('#save').addEventListener('click', () =>
  run(async () => {
    await saveDraft();
    render();
  }),
);
$('#export-draft').addEventListener('click', downloadDraft);
$('#publish').addEventListener('click', () =>
  run(async () => {
    if (pendingOperation) {
      const current = await request('state'),
        known = current.operations.find((x) => x.id === pendingOperation.id);
      if (known) {
        pendingOperation = null;
        if (!dirty) {
          loadState(current);
          render();
        }
        message(
          `הפרסום הקודם הושלם: ${known.version.slice(0, 8)}.${dirty ? ' יש שינויים שלא נשמרו. גבו אותם לפני טעינת גרסה עדכנית.' : ''}`,
        );
        return;
      }
      if (dirty || current.revision !== pendingOperation.revision)
        throw new Error(
          'לא אותר אישור לפרסום הקודם. הורידו עותק של העריכה וטעינו גרסה עדכנית לפני ניסיון נוסף.',
        );
    }
    if (dirty) await saveDraft();
    const changed = draft.stages.filter((s) => {
      const old = state.live.content.stages.find((x) => x.id === s.id);
      return old && old.opensAt !== s.opensAt;
    });
    const impact = changed
      .map(
        (s) => `${s.title}: ${formatDate(s.opensAt)} (${stageIsOpen(s) ? 'פתוח כעת' : 'נעול כעת'})`,
      )
      .join('\n');
    if (
      !confirm(
        `לפרסם את הטיוטה לכל הקבוצות?${impact ? '\nשינויים במועדים:\n' + impact : ''}\nרק רשומות המסומנות לפרסום ייכללו.`,
      )
    )
      return;
    pendingOperation ||= { id: crypto.randomUUID(), revision: state.revision };
    const result = await request('publish', 'POST', {
      revision: pendingOperation.revision,
      operationId: pendingOperation.id,
    });
    loadState(result.state);
    message('מצב הפרסום בבדיקה…');
    const live = await api('/api/public/content');
    if (live.version !== result.version)
      throw new Error('הפרסום טרם אומת. השתמשו בבדיקת מצב לפני פרסום נוסף.');
    pendingOperation = null;
    message(result.warning || 'פורסם באתר. הגרסה החיה אומתה.', !!result.warning);
    render();
  }),
);
$('#admin-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (button && !working) {
    tab = button.dataset.tab;
    render();
  }
});
panel.addEventListener('input', (event) => {
  const input = event.target;
  if (!input.dataset.field) return;
  const collection = input.dataset.collection,
    item =
      collection === 'activity'
        ? draft.activity
        : draft[collection].find((x) => x.id === input.dataset.id);
  const key = input.dataset.field,
    old = item[key];
  let value =
    input.type === 'checkbox'
      ? input.checked
      : input.type === 'number'
        ? Number(input.value)
        : input.value;
  if (['groupId', 'stageId'].includes(key)) value = value || null;
  if (key === 'active' && !value) {
    const count = [...draft.instructions, ...draft.forms].filter(
      (x) => x.groupId === item.id,
    ).length;
    if (
      !confirm(
        `הוצאת קבוצה ${item.number} משימוש תסתיר אותה ואת ${count} פריטי התוכן המשויכים לה לאחר פרסום. הקבצים יישמרו. להמשיך?`,
      )
    ) {
      input.checked = true;
      return;
    }
  }
  if (key === 'opensAt') {
    try {
      value = value ? israelToUtc(value) : null;
      input.setCustomValidity('');
    } catch (error) {
      input.setCustomValidity(error.message);
      input.reportValidity();
      return;
    }
  }
  item[key] = value;
  if (old !== value) setDirty();
});
panel.addEventListener('change', (event) => {
  const input = event.target;
  if (input.id.startsWith('preview-')) {
    renderPreview();
    return;
  }
  if (input.id === 'pdf-upload' && input.files[0])
    run(async () => {
      const file = input.files[0];
      if (file.size > 5 * 1024 * 1024) throw new Error('ניתן להעלות PDF עד 5MB.');
      if (dirty) await saveDraft();
      $('#upload-status').textContent = 'מעלים ובודקים את הקובץ…';
      const form = new FormData();
      form.set('file', file);
      form.set('revision', state.revision);
      const result = await request('upload', 'POST', form);
      loadState(result.state);
      render();
      const card = [...panel.querySelectorAll('[data-instruction]')].find(
        (element) => element.dataset.instruction === result.instruction.id,
      );
      card?.scrollIntoView({ block: 'nearest' });
      card?.querySelector('input')?.focus({ preventScroll: true });
      message(`הקובץ ${result.file.name} הועלה כהנחיה חדשה ונשמר בטיוטה. בחרו שלב וקבוצה וסמנו אם לכלול אותו בפרסום.`);
    });
});
panel.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || working) return;
  if (button.dataset.removeFile) {
    const file = draft.files.find((item) => item.id === button.dataset.removeFile);
    if (!file) return;
    const uses = draft.instructions.filter((item) => item.fileIds.includes(file.id)).length;
    if (confirm(`למחוק את הקובץ ״${file.name}״ ואת ${uses} בלוקי ההנחיה שלו מהטיוטה? השינוי יופיע לסטודנטים לאחר שמירה ופרסום. גרסאות קודמות יישמרו לשחזור.`)) {
      draft = removeDraftFile(draft, file.id);
      setDirty();
      render();
      message('הקובץ הוסר מהטיוטה. שמרו את הטיוטה ופרסמו כדי לעדכן את אתר הסטודנטים.');
    }
    return;
  }
  if (button.dataset.add) {
    const key = button.dataset.add,
      number = draft[key].length + 1;
    if (key === 'stages')
      draft.stages.push({
        id: id('stage'),
        title: 'שלב חדש',
        description: '',
        opensAt: null,
        order: number,
        published: false,
      });
    if (key === 'groups')
      draft.groups.push({
        id: id('group'),
        number: Math.max(0, ...draft.groups.map((g) => g.number)) + 1,
        name: '',
        active: true,
      });
    if (key === 'instructions')
      draft.instructions.push({
        id: id('instruction'),
        createdAt: new Date().toISOString(),
        title: 'הנחיה חדשה',
        body: '',
        stageId: null,
        groupId: null,
        fileIds: [],
        order: Math.max(0, ...draft.instructions.map((item) => item.order)) + 1,
        published: false,
      });
    if (key === 'forms')
      draft.forms.push({
        id: id('form'),
        title: 'טופס חדש',
        description: '',
        openUrl: '',
        responseType: 'group',
        stageId: null,
        groupId: null,
        order: number,
        published: false,
      });
    setDirty();
    render();
    panel.querySelector(key === 'instructions' ? '[data-instruction] input' : '.editor-card:last-child input')?.focus();
  }
  if (button.dataset.remove) {
    const key = button.dataset.remove,
      record = draft[key].find((x) => x.id === button.dataset.id);
    const linked =
      key === 'stages'
        ? [...draft.instructions, ...draft.forms].filter((x) => x.stageId === record.id).length
        : 0;
    if (linked) {
      message(`לשלב משויכים ${linked} פריטי תוכן. שנו את שיוכם לפני הסרת השלב.`, true);
      return;
    }
    if (
      confirm(
        `להסיר את ״${record.title}״ מהטיוטה? השינוי יופיע לסטודנטים לאחר פרסום.`,
      )
    ) {
      draft[key] = draft[key].filter((x) => x.id !== record.id);
      setDirty();
      render();
    }
  }
  if (button.dataset.action === 'reload')
    run(async () => {
      if (
        !dirty ||
        confirm(
          'טעינת הגרסה העדכנית תחליף שינויים שלא נשמרו. הורידו עותק עריכה לפני ההמשך. להמשיך?',
        )
      ) {
        loadState(await request('state'));
        pendingOperation = null;
        render();
        message('נטענה הגרסה העדכנית.');
      }
    });
  if (button.dataset.action === 'status')
    run(async () => {
      const status = await request('status');
      const live = await api('/api/public/content');
      if (pendingOperation) {
        const current = await request('state'),
          known = current.operations.find((x) => x.id === pendingOperation.id);
        if (known) {
          pendingOperation = null;
          if (!dirty) {
            loadState(current);
            render();
          }
          message(
            `הפרסום הקודם אותר בגרסה ${known.version.slice(0, 8)}.${dirty ? ' יש שינויים שלא נשמרו; גבו אותם לפני טעינת הגרסה העדכנית.' : ''}`,
          );
          return;
        }
      }
      message(
        `גרסה חיה: ${status.version.slice(0, 8)} · ${status.version === live.version ? 'הפרסום אומת' : 'הפרסום עדיין בבדיקה'} · ${status.storage === 'local' ? 'אחסון מקומי' : 'GitHub פרטי'}${status.revision !== state.revision ? ' · קיימת טיוטה חדשה יותר; גבו את העריכה וטעינו גרסה עדכנית.' : ''}`,
      );
    });
  if (button.dataset.restore)
    run(async () => {
      if (
        !confirm(
          'שחזור יחליף את הטיוטה. גבו שינויים שלא נשמרו. לאחר השחזור יש לבדוק את המועדים והקבצים בתצוגה המקדימה ולפרסם בנפרד. להמשיך?',
        )
      )
        return;
      const result = await request('restore', 'POST', {
        revision: state.revision,
        version: button.dataset.restore,
      });
      loadState(result.state);
      tab = 'preview';
      render();
      message('הגרסה שוחזרה לטיוטה. התצוגה החיה לא השתנתה.');
    });
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
if (IS_ADMIN_ORIGIN) {
  async function openEditor() {
    const address = new URL(ADMIN_URL);
    if (address.hostname === '127.0.0.1' && address.protocol === 'http:') {
      const status = await api('/api/local/setup');
      if (status.needsSetup) {
        $('#login-panel').hidden = true;
        $('#setup-panel').hidden = false;
        $('#setup-password').focus();
        return;
      }
    }
    await authenticate();
  }
  openEditor().catch((error) => { if (error.status !== 401) message(error.message, true); });
} else {
  $('#login-form button[type="submit"]').disabled = true;
  message('לשמירה ולפרסום יש לפתוח את העורך המחובר לשירות הניהול.');
  const link = document.createElement('a');
  link.href = ADMIN_URL;
  link.textContent = 'פתיחת העורך המחובר';
  link.className = 'btn btn-outline-primary ms-2';
  link.target = '_blank';
  link.rel = 'noopener';
  $('#messages').append(' ', link);
}
