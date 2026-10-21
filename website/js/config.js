// הגדרות האתר. לעריכת HTML ו־CSS עם Live Server אין צורך לשנות כאן דבר.
export const settings = {
  // false: קוראים את data/content.json המקומי. true: קוראים תוכן מהשירות.
  readFromApi: false,
  // כתובת שירות הניהול. אינה נחוצה לצפייה בפרונט עם Live Server.
  backendUrl: 'http://127.0.0.1:4173',
};

export const API_BASE = settings.backendUrl.replace(/\/$/, '');
export const ADMIN_URL = `${API_BASE}/admin.html`;
export const IS_ADMIN_ORIGIN = globalThis.location?.origin === API_BASE;
export const USE_API = settings.readFromApi || IS_ADMIN_ORIGIN;
export const CONTENT_URL = new URL('../data/content.json', import.meta.url).href;
export const PUBLIC_SITE_URL = new URL('../index.html', import.meta.url).href;
