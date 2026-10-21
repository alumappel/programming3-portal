import {
  formatDate,
  stageIsOpen,
  latestOpenStage,
  byOrder,
} from './domain.js?v=20261021-file-blocks-2';
import {
  $,
  loadContent,
  escapeHtml as e,
  icon,
  message,
  safeStorage,
} from './helpers.js?v=20261021-hosting-1';
import { ADMIN_URL, USE_API } from './config.js?v=20261021-hosting-1';
import { renderRecords } from './helpers.js?v=20261021-hosting-1';
let live,
  groupId = safeStorage('portal.group') || '',
  selected = null,
  pending = null,
  busy = false;
$('#editor-link').href = ADMIN_URL;
$('#editor-link').innerHTML = icon('edit', 19);
$('#picker-icon').innerHTML = icon('group', 28);
$('#general-icon').innerHTML = icon('layers');
const hasOpenForm = () => !!document.querySelector('iframe.google-form');
function allowTransition() {
  return !hasOpenForm() || confirm('טופס פתוח בעמוד. מעבר עלול למחוק מענה שלא נשלח. להמשיך במעבר?');
}
function renderStages() {
  const stages = live.content.stages.sort(byOrder),
    open = stages.filter((s) => stageIsOpen(s));
  $('#journey-summary').textContent = stages.length
    ? `${open.length} מתוך ${stages.length} שלבים זמינים`
    : 'המועדים יפורסמו בהמשך';
  $('#stages').innerHTML = stages.length
    ? stages
        .map((s, i) => {
          const available = stageIsOpen(s);
          return `<button class="stage-step ${selected === s.id ? 'selected' : ''} ${available ? 'is-open' : 'is-locked'}" type="button" data-stage="${e(s.id)}" aria-current="${selected === s.id ? 'step' : 'false'}"><span class="step-number">${String(i + 1).padStart(2, '0')}</span><span class="step-info"><strong>${e(s.title)}</strong><span>${e(formatDate(s.opensAt))}</span><span class="step-state">${icon(available ? 'check' : 'lock', 15)} ${available ? 'זמין לצפייה' : 'ייפתח בהמשך'}</span></span><span class="step-arrow">${icon(available ? 'arrow' : 'lock', 18)}</span></button>`;
        })
        .join('')
    : '<div class="empty-timeline"><span class="section-symbol">' +
      icon('clock', 30) +
      '</span><h3>המסלול מתכונן</h3><p>השלבים ומועדי הפתיחה יופיעו כאן לאחר פרסומם.</p></div>';
}
function renderContent(focus = false) {
  renderRecords($('#general-content'), live.content, null, groupId);
  const stage = live.content.stages.find((s) => s.id === selected);
  if (!stage) {
    $('#stage-heading').textContent = 'נתראה בתחילת הדרך';
    $('#stage-description').textContent = 'ההנחיות והמועדים יפורסמו על ידי המרצה.';
    $('#selected-label').textContent = 'הפעילות בהכנה';
    $('#stage-content').innerHTML =
      `<div class="waiting-state"><span class="waiting-art" aria-hidden="true">${icon('layers', 64)}</span><h3>כל שלב, בזמן שלו</h3><p>בחרו קבוצה וקראו את ההנחיות הכלליות. כשהפעילות תיפתח, החומרים יופיעו במרחב הזה.</p></div>`;
  } else {
    const available = stageIsOpen(stage);
    $('#stage-heading').textContent = stage.title;
    $('#selected-label').textContent = available
      ? `שלב ${live.content.stages.indexOf(stage) + 1} · זמין לצפייה`
      : 'השלב עדיין נעול';
    $('#stage-description').textContent = available
      ? stage.description
      : `פתיחה: ${formatDate(stage.opensAt)}`;
    if (available) renderRecords($('#stage-content'), live.content, stage.id, groupId);
    else
      $('#stage-content').innerHTML =
        `<div class="waiting-state"><span class="waiting-art" aria-hidden="true">${icon('lock', 48)}</span><h3>עוד קצת ונפתחים</h3><p>תוכן השלב יהיה זמין ב־${e(formatDate(stage.opensAt))}.</p></div>`;
  }
  if (focus) $('#stage-heading').focus();
}
function render() {
  const data = live.content;
  if (USE_API) {
    document.title = `${data.activity.title} · מרחב הפעילות`;
    $('#activity-title').textContent = data.activity.title;
    $('#activity-description').textContent = data.activity.description;
  }
  if (!data.groups.some((g) => g.id === groupId)) {
    groupId = '';
    safeStorage('portal.group', null);
  }
  $('#group-select').innerHTML =
    '<option value="">בחירת קבוצה</option>' +
    data.groups
      .sort((a, b) => a.number - b.number)
      .map(
        (g) =>
          `<option value="${e(g.id)}">קבוצה ${e(g.number)}${g.name ? ' · ' + e(g.name) : ''}</option>`,
      )
      .join('');
  $('#group-select').value = groupId;
  $('#group-select').disabled = !data.groups.length;
  if (!data.groups.length) message('טרם הוגדרו קבוצות פעילות. ניתן לקרוא את ההנחיות המשותפות.');
  if (!data.stages.some((s) => s.id === selected))
    selected = latestOpenStage(data.stages) || data.stages.sort(byOrder)[0]?.id || null;
  renderStages();
  renderContent();
}
function applyUpdate() {
  live = pending;
  pending = null;
  render();
  message('התוכן עודכן לגרסה האחרונה.');
}
async function refresh() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    const result = await loadContent();
    if (!live) {
      live = result;
      render();
    } else if (
      result.version !== live.version ||
      (!USE_API && JSON.stringify(result.content) !== JSON.stringify(live.content))
    ) {
      pending = result;
      if (hasOpenForm()) {
        message('פורסם תוכן חדש. הטופס הפתוח נשאר כפי שהוא.');
        const button = document.createElement('button');
        button.className = 'btn btn-outline-primary ms-2';
        button.textContent = 'עדכון התוכן';
        button.addEventListener('click', () => {
          if (allowTransition()) applyUpdate();
        });
        $('#messages').append(' ', button);
      } else applyUpdate();
    }
  } catch (error) {
    message(
      live
        ? 'לא ניתן לבדוק עדכונים כרגע. מוצגת הגרסה האחרונה שנטענה. ננסה שוב אוטומטית.'
        : error.message,
      true,
    );
    if (!live) {
      $('#stage-content').innerHTML =
        '<div class="waiting-state"><h3>התוכן לא נטען</h3><p>בדקו את החיבור ונסו שוב.</p><button class="btn btn-primary" id="retry" type="button">ניסיון חוזר</button></div>';
      $('#retry').onclick = refresh;
    }
  } finally {
    busy = false;
  }
}
$('#group-select').addEventListener('change', (event) => {
  if (!allowTransition()) {
    event.target.value = groupId;
    return;
  }
  groupId = event.target.value;
  safeStorage('portal.group', groupId);
  renderContent();
});
$('#stages').addEventListener('click', (event) => {
  const button = event.target.closest('[data-stage]');
  if (!button || button.dataset.stage === selected || !allowTransition()) return;
  selected = button.dataset.stage;
  renderStages();
  renderContent(true);
});
function tick() {
  if (!live || document.hidden) return;
  const previous = $('#selected-label').textContent;
  renderStages();
  const stage = live.content.stages.find((s) => s.id === selected);
  if (stage && stageIsOpen(stage) && previous === 'השלב עדיין נעול' && !hasOpenForm())
    renderContent();
}
setInterval(() => {
  tick();
  refresh();
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    tick();
    refresh();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (hasOpenForm()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
refresh();
