export const TIME_ZONE = 'Asia/Jerusalem';
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const STAGE_NAMES = [
  'היכרות והתנעה',
  'תיק לקוח ופיתוח',
  'חיבור למוודל',
  'שינוי דרישות וייעוץ',
  'סיכום ותיעוד',
];
export const clone = (value) => structuredClone(value);
export const byOrder = (a, b) => a.order - b.order || a.id.localeCompare(b.id);
export function newestInstructions(instructions) {
  return instructions
    .map((item, index) => ({ item, index, time: validInstant(item.createdAt) ? Date.parse(item.createdAt) : null }))
    .sort((a, b) => {
      if (a.time !== b.time) {
        if (a.time === null) return 1;
        if (b.time === null) return -1;
        return b.time - a.time;
      }
      return b.index - a.index;
    })
    .map(({ item }) => item);
}
export function separateFileInstructions(content) {
  const data = clone(content);
  const usedIds = new Set(
    ['groups', 'stages', 'instructions', 'forms', 'files'].flatMap((key) => data[key].map((x) => x.id)),
  );
  function nextId(fileId) {
    const base = `instruction-${fileId}`.slice(0, 72);
    let candidate = base, counter = 1;
    while (usedIds.has(candidate)) candidate = `${base}-${counter++}`;
    usedIds.add(candidate);
    return candidate;
  }
  const files = new Map(data.files.map((file) => [file.id, file]));
  let split = false;
  data.instructions = data.instructions.flatMap((item) => {
    if (!item.fileIds.length) return [item];
    if (item.fileIds.length === 1 && !item.body.trim()) return [{ ...item, body: '' }];
    split = true;
    const text = item.body.trim() ? [{ ...item, fileIds: [] }] : [];
    const blocks = item.fileIds.map((fileId, index) => ({
      ...item,
      id: !text.length && index === 0 ? item.id : nextId(fileId),
      title: !text.length && index === 0 ? item.title : files.get(fileId)?.name || item.title,
      body: '',
      fileIds: [fileId],
      createdAt: files.get(fileId)?.createdAt || item.createdAt,
    }));
    return [...text, ...blocks];
  });
  if (split) {
    data.instructions.sort((a, b) => a.order - b.order);
    data.instructions.forEach((item, index) => { item.order = index + 1; });
  }
  const referenced = new Set(data.instructions.flatMap((item) => item.fileIds));
  let order = Math.max(0, ...data.instructions.map((item) => item.order));
  for (const file of data.files) {
    if (referenced.has(file.id)) continue;
    data.instructions.push({
      id: nextId(file.id), title: file.name, body: '', fileIds: [file.id],
      stageId: null, groupId: null, order: ++order, published: false,
      createdAt: file.createdAt,
    });
  }
  return data;
}
export function removeDraftFile(content, fileId) {
  const data = separateFileInstructions(content);
  data.instructions = data.instructions.filter((item) => !item.fileIds.includes(fileId));
  data.files = data.files.filter((file) => file.id !== fileId);
  return data;
}
export function initialContent() {
  return {
    schemaVersion: 1,
    activity: {
      title: 'מפתחים תוצר למידה',
      description: 'מרחב הפעילות הקבוצתית · תכנות אינטראקציה ואנימציה',
      timeZone: TIME_ZONE,
    },
    groups: Array.from({ length: 35 }, (_, i) => ({
      id: `group-${i + 1}`,
      number: i + 1,
      name: '',
      active: true,
    })),
    stages: STAGE_NAMES.map((title, i) => ({
      id: `stage-${i + 1}`,
      title,
      description: '',
      order: i + 1,
      opensAt: null,
      published: false,
    })),
    instructions: [
      {
        id: 'welcome',
        title: 'ברוכים הבאים למרחב הפעילות',
        body: 'כאן יופיעו ההנחיות המשותפות והחומרים של הקבוצה שלכם. בחרו את מספר הקבוצה כדי לצפות בתוכן המיועד לה. מועדי הפעילות והחומרים יפורסמו על ידי המרצה.',
        stageId: null,
        groupId: null,
        order: 1,
        published: true,
        fileIds: [],
      },
    ],
    forms: [],
    files: [],
  };
}
export function publicContent(content) {
  const data = separateFileInstructions(content);
  data.groups = data.groups.filter((g) => g.active);
  data.stages = data.stages.filter((s) => s.published).sort(byOrder);
  const groups = new Set(data.groups.map((g) => g.id)),
    stages = new Set(data.stages.map((s) => s.id));
  const visible = (x) =>
    x.published && (!x.groupId || groups.has(x.groupId)) && (!x.stageId || stages.has(x.stageId));
  data.instructions = data.instructions.filter(visible).sort(byOrder);
  data.forms = data.forms.filter(visible).sort(byOrder);
  const used = new Set(data.instructions.flatMap((x) => x.fileIds));
  data.files = data.files
    .filter((f) => used.has(f.id))
    .map(({ id, name, size, version }) => ({ id, name, size, version }));
  return data;
}
export function stageIsOpen(stage, now = Date.now()) {
  return (
    !!stage.published && validInstant(stage.opensAt) && Date.parse(stage.opensAt) <= Number(now)
  );
}
export function latestOpenStage(stages, now = Date.now()) {
  return (
    stages
      .filter((s) => stageIsOpen(s, now))
      .sort(byOrder)
      .at(-1)?.id ?? null
  );
}
export function validInstant(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
  );
}
const localParts = (instant) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (type) => parts.find((x) => x.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
};
export function israelToUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('יש לבחור תאריך ושעה תקינים.');
  const nominal = Date.parse(`${value}:00Z`);
  const candidates = [2, 3]
    .map((offset) => new Date(nominal - offset * 3600000).toISOString())
    .filter((x) => localParts(x) === value);
  if (!candidates.length)
    throw new Error('השעה אינה קיימת בשעון ישראל, ייתכן שזהו מעבר לשעון קיץ. בחרו שעה אחרת.');
  if (candidates.length > 1)
    throw new Error('השעה חוזרת במעבר לשעון חורף. בחרו שעה מחוץ לשעת המעבר.');
  return candidates[0];
}
export const utcToIsraelInput = (value) => (validInstant(value) ? localParts(value) : '');
export const formatDate = (value) =>
  validInstant(value)
    ? new Intl.DateTimeFormat('he-IL', {
        timeZone: TIME_ZONE,
        dateStyle: 'long',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'מועד טרם נקבע';
export function normalizeFormUrl(value) {
  const raw = String(value).trim();
  const src = raw.startsWith('<iframe')
    ? raw.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]?.replaceAll('&amp;', '&')
    : raw;
  let url;
  try {
    url = new URL(src);
  } catch {
    throw new Error('יש להזין קישור הטמעה תקין של Google Forms.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'docs.google.com' ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/forms\/(?:d\/e\/|d\/)[a-zA-Z0-9_-]+\/viewform\/?$/.test(url.pathname)
  ) {
    throw new Error(
      'נתמכים רק קישורי HTTPS מלאים של Google Forms המסתיימים ב־viewform. העתיקו את קישור ההטמעה מגוגל.',
    );
  }
  const open = new URL(url.origin + url.pathname);
  const embed = new URL(open);
  embed.searchParams.set('embedded', 'true');
  return { openUrl: open.href, embedUrl: embed.href };
}
export function validateContent(data) {
  const errors = [];
  if (
    !data ||
    data.schemaVersion !== 1 ||
    !data.activity ||
    !['groups', 'stages', 'instructions', 'forms', 'files'].every((k) => Array.isArray(data[k]))
  )
    return ['מבנה הנתונים אינו תקין.'];
  if (
    ['groups', 'stages', 'instructions', 'forms', 'files'].some((key) =>
      data[key].some((item) => !item || typeof item !== 'object' || Array.isArray(item)),
    )
  )
    return ['מבנה הרשומות אינו תקין.'];
  const required = (value, name, max = 200) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      errors.push(`${name}: נדרש טקסט באורך עד ${max} תווים.`);
  };
  required(data.activity.title, 'שם הפעילות');
  if (
    typeof data.activity.description !== 'string' ||
    data.activity.description.length > 4000 ||
    data.activity.timeZone !== TIME_ZONE
  )
    errors.push('תיאור הפעילות או אזור הזמן אינו תקין.');
  const allIds = new Set();
  for (const [key, items] of Object.entries(data).filter(([, v]) => Array.isArray(v))) {
    if (items.length > 1000) errors.push(`${key}: יותר מדי רשומות.`);
    for (const item of items) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
        allIds.has(item.id)
      )
        errors.push('נמצא מזהה חסר, לא תקין או כפול.');
      allIds.add(item?.id);
    }
  }
  const groupIds = new Set(data.groups.map((x) => x.id)),
    stageIds = new Set(data.stages.map((x) => x.id)),
    fileIds = new Set(data.files.map((x) => x.id));
  const numbers = new Set();
  for (const g of data.groups) {
    if (!Number.isSafeInteger(g.number) || g.number < 1 || numbers.has(g.number))
      errors.push('מספרי קבוצות חייבים להיות מספרים חיוביים וייחודיים.');
    numbers.add(g.number);
    if (typeof g.active !== 'boolean' || typeof g.name !== 'string' || g.name.length > 200)
      errors.push('פרטי הקבוצה אינם תקינים.');
  }
  for (const stage of data.stages) {
    required(stage.title, 'שם השלב');
    if (
      typeof stage.published !== 'boolean' ||
      typeof stage.description !== 'string' ||
      stage.description.length > 4000 ||
      !Number.isSafeInteger(stage.order)
    )
      errors.push('פרטי השלב אינם תקינים.');
    if (stage.published && !validInstant(stage.opensAt))
      errors.push(`${stage.title}: שלב לפרסום חייב לכלול מועד UTC תקין.`);
    if (stage.opensAt !== null && !validInstant(stage.opensAt))
      errors.push(`${stage.title}: מועד אינו תקין.`);
  }
  for (const record of [...data.instructions, ...data.forms]) {
    required(record.title, 'כותרת תוכן');
    if (typeof record.published !== 'boolean' || !Number.isSafeInteger(record.order))
      errors.push('מצב התוכן או סדר התצוגה אינו תקין.');
    if (record.groupId !== null && !groupIds.has(record.groupId))
      errors.push(`${record.title}: הקבוצה אינה קיימת.`);
    if (record.stageId !== null && !stageIds.has(record.stageId))
      errors.push(`${record.title}: השלב אינו קיים.`);
  }
  for (const item of data.instructions) {
    if (
      typeof item.body !== 'string' ||
      item.body.length > 40000 ||
      !Array.isArray(item.fileIds) ||
      item.fileIds.some((id) => !fileIds.has(id))
    )
      errors.push(`${item.title}: טקסט או קובץ משויך אינו תקין.`);
    if (item.createdAt !== undefined && !validInstant(item.createdAt))
      errors.push(`${item.title}: מועד היצירה אינו תקין.`);
    if (item.published && !item.body?.trim() && !item.fileIds?.length)
      errors.push(`${item.title}: יש להוסיף טקסט או קובץ לפני הפרסום.`);
  }
  for (const f of data.forms) {
    try {
      normalizeFormUrl(f.openUrl);
    } catch (e) {
      errors.push(`${f.title}: ${e.message}`);
    }
    if (
      !['group', 'individual'].includes(f.responseType) ||
      typeof f.description !== 'string' ||
      f.description.length > 4000
    )
      errors.push(`${f.title}: פרטי טופס אינם תקינים.`);
  }
  for (const f of data.files) {
    if (
      typeof f.name !== 'string' ||
      !f.name.trim() ||
      f.name.length > 200 ||
      !Number.isSafeInteger(f.size) ||
      f.size < 1 ||
      f.size > MAX_PDF_BYTES ||
      !/^[a-f0-9]{64}$/.test(f.version)
    )
      errors.push('פרטי PDF אינם תקינים.');
    if (f.createdAt !== undefined && !validInstant(f.createdAt))
      errors.push('מועד העלאת הקובץ אינו תקין.');
  }
  return [...new Set(errors)];
}
export function cleanContent(input) {
  // Pick the allowed schema. Rich text is stored as plain Markdown and rendered as DOM text.
  const pick = (item, keys) => Object.fromEntries(keys.map((key) => [key, item[key]]));
  return separateFileInstructions({
    schemaVersion: 1,
    activity: pick(input.activity, ['title', 'description', 'timeZone']),
    groups: input.groups.map((x) => pick(x, ['id', 'number', 'name', 'active'])),
    stages: input.stages.map((x) =>
      pick(x, ['id', 'title', 'description', 'order', 'opensAt', 'published']),
    ),
    instructions: input.instructions.map((x) =>
      pick(x, ['id', 'title', 'body', 'stageId', 'groupId', 'order', 'published', 'fileIds', 'createdAt']),
    ),
    forms: input.forms.map((x) => ({
      ...pick(x, [
        'id',
        'title',
        'description',
        'stageId',
        'groupId',
        'order',
        'published',
        'responseType',
      ]),
      ...normalizeFormUrl(x.openUrl),
    })),
    files: input.files.map((x) => pick(x, ['id', 'name', 'size', 'version', 'createdAt'])),
  });
}
