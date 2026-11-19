/** `document.querySelector` for the editor's own elements, which index.html always provides. */
export const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
