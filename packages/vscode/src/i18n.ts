import { detectOsLocale } from "../../cli/src/license";

const zh = {
  openMarkdownFirst: "请先打开一个 Markdown 文件",
  browserOpened: "思维导图已在浏览器打开：{url}",
  copyLink: "复制链接",
  browserFailed: "无法在浏览器打开思维导图：{error}",
  readOnly: "文档无法修改（可能是只读文件）",
  buyPro: "购买 Pro",
  signIn: "登录",
  switchAccount: "切换账号",
  proActiveDetail: "终身会员权益已开通。",
  accountLine: "当前账号：{account}",
  accountConnected: "当前账号：已登录",
  trialExpired: "7 天试用已结束。请购买 Pro，或登录已购买 Pro 的账号。",
  checkoutHint: "在浏览器完成操作，已有 Pro 权益会自动同步。",
  checkoutFailed: "无法打开购买页面。",
  removed: "已退出登录。",
  removeConfirm: "退出当前账号？下次登录时会自动同步 Pro 权益。",
  remove: "退出登录",
  saveExport: "导出",
};

type Key = keyof typeof zh;

const en: Record<Key, string> = {
  openMarkdownFirst: "Open a Markdown file first",
  browserOpened: "Mind map opened in the browser: {url}",
  copyLink: "Copy link",
  browserFailed: "Could not open the mind map in the browser: {error}",
  readOnly: "The document cannot be modified (it may be read-only)",
  buyPro: "Buy Pro",
  signIn: "Sign In",
  switchAccount: "Switch Account",
  proActiveDetail: "Lifetime Pro membership is active.",
  accountLine: "Account: {account}",
  accountConnected: "Account: Signed in",
  trialExpired: "Your 7-day trial has ended. Buy Pro or sign in to an account that has Pro.",
  checkoutHint: "Continue in your browser. Any existing Pro access will sync automatically.",
  checkoutFailed: "Could not open checkout.",
  removed: "Signed out.",
  removeConfirm: "Sign out? Your Pro access will sync the next time you sign in.",
  remove: "Sign Out",
  saveExport: "Export",
};

export const isChinese = () => detectOsLocale() === "zh";

export function t(key: Key, vars: Record<string, string> = {}): string {
  return (isChinese() ? zh : en)[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
