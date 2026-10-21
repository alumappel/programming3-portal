// הגדרות האתר. לעריכת HTML ו־CSS עם Live Server אין צורך לשנות כאן דבר.
export const settings = {
  // false: קוראים את data/content.json המקומי. true: קוראים תוכן מהשירות.
  readFromApi: false,
  // כתובת שירות הניהול. אינה נחוצה לצפייה בפרונט עם Live Server.
  backendUrl: 'http://127.0.0.1:4173',
  // הכתובות המקוונות. Live Server ממשיך להשתמש בכתובת המקומית ובקובץ התוכן.
  productionBackendUrl: 'https://programming3-editor.alumappel.workers.dev',
  publicSiteUrl: 'https://alumappel.github.io/programming3-portal/',
};

export function connectionFor(location) {
  const local = !location || location.protocol === 'file:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const apiBase = (local ? settings.backendUrl : settings.productionBackendUrl).replace(/\/$/, '');
  const isAdminOrigin = location?.origin === apiBase;
  return {
    apiBase,
    adminUrl: `${apiBase}/admin.html`,
    isAdminOrigin,
    useApi: settings.readFromApi || isAdminOrigin || !local,
    publicSiteUrl: local ? new URL('../index.html', import.meta.url).href : settings.publicSiteUrl,
  };
}

const connection = connectionFor(globalThis.location);
export const API_BASE = connection.apiBase;
export const ADMIN_URL = connection.adminUrl;
export const IS_ADMIN_ORIGIN = connection.isAdminOrigin;
export const USE_API = connection.useApi;
export const CONTENT_URL = new URL('../data/content.json', import.meta.url).href;
export const PUBLIC_SITE_URL = connection.publicSiteUrl;
