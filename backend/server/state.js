import { initialContent, publicContent } from '../../website/js/domain.js';
export function initialState() {
  const draft = initialContent();
  return {
    revision: crypto.randomUUID(),
    draft,
    live: { version: 'initial', publishedAt: null, content: publicContent(draft) },
    history: [],
    operations: [],
  };
}
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const conflict = () =>
  new HttpError(409, 'קיימת גרסה חדשה יותר. שמרו עותק של העריכה לפני טעינת הגרסה העדכנית.');
