import * as vscode from "vscode";

const zh = {
  openMarkdownFirst: "请先打开一个 Markdown 文件",
  browserOpened: "思维导图已在浏览器打开：{url}",
  copyLink: "复制链接",
  browserFailed: "无法在浏览器打开思维导图：{error}",
  readOnly: "文档无法修改（可能是只读文件）",
  browserLocked: "在浏览器中全屏编辑是 Inkmap Pro 功能。",
  proPitch: "Inkmap Pro 终身会员 {cn} / {intl}：去除广告、浏览器全屏编辑、导出图片、更多结构和配色、查找替换、演示模式，包含后续全部更新。",
  buyCN: "国内购买 {price}",
  buyIntl: "海外购买 {price}",
  enterCode: "输入激活码",
  storeSoon: "购买渠道即将开放，敬请期待。",
  codePrompt: "粘贴 Inkmap Pro 激活码（INK1- 开头）",
  activated: "已激活 Inkmap Pro，感谢支持！",
  alreadyPro: "Inkmap Pro 已激活（编号 {id}，{date}）。",
  removed: "已移除本机的 Inkmap Pro 激活码。",
  removeConfirm: "确定移除 Inkmap Pro 激活码吗？之后需要重新输入激活码才能使用 Pro 功能。",
  remove: "移除",
  "reason.format": "激活码不完整，请从购买记录中完整复制。",
  "reason.signature": "激活码无效，请检查是否复制正确。",
  "reason.revoked": "该激活码已停用，如有疑问请联系我们。",
  saveExport: "导出",
};

type Key = keyof typeof zh;

const en: Record<Key, string> = {
  openMarkdownFirst: "Open a Markdown file first",
  browserOpened: "Mind map opened in the browser: {url}",
  copyLink: "Copy link",
  browserFailed: "Could not open the mind map in the browser: {error}",
  readOnly: "The document cannot be modified (it may be read-only)",
  browserLocked: "Full-screen editing in the browser is an Inkmap Pro feature.",
  proPitch: "Inkmap Pro lifetime {intl} / {cn}: no ads, browser editing, image export, more layouts and themes, find and replace, presentation mode, and every future update.",
  buyCN: "China {price}",
  buyIntl: "Buy {price}",
  enterCode: "Enter license key",
  storeSoon: "The store is opening soon.",
  codePrompt: "Paste your Inkmap Pro license key (starts with INK1-)",
  activated: "Inkmap Pro activated — thank you!",
  alreadyPro: "Inkmap Pro is active (ID {id}, {date}).",
  removed: "Removed the Inkmap Pro license key from this machine.",
  removeConfirm: "Remove the Inkmap Pro license key? You will need to enter it again to use Pro features.",
  remove: "Remove",
  "reason.format": "That key looks incomplete — copy the whole key from your receipt.",
  "reason.signature": "This key is not valid — check that it was copied correctly.",
  "reason.revoked": "This key has been revoked — contact us if this is unexpected.",
  saveExport: "Export",
};

export const isChinese = () => /^zh/i.test(vscode.env.language);

export function t(key: Key, vars: Record<string, string> = {}): string {
  return (isChinese() ? zh : en)[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
