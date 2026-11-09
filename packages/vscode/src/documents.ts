import * as path from "node:path";
import * as vscode from "vscode";

export interface DocState {
  name: string;
  md: string;
  version: string;
}

export function docName(uri: vscode.Uri) {
  return path.basename(uri.path).replace(/\.md$/i, "").replace(/\.markmap$/i, "");
}

/** Directory that relative image paths in the document resolve against. */
export function docDir(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === "untitled") return vscode.workspace.workspaceFolders?.[0]?.uri;
  return vscode.Uri.joinPath(uri, "..");
}

/** Replaces the document text with the smallest edit, so the cursor in a text editor stays put. */
export async function replaceText(document: vscode.TextDocument, next: string): Promise<boolean> {
  const prev = document.getText();
  if (prev === next) return true;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && prev.charCodeAt(prev.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(start), document.positionAt(prev.length - end)),
    next.slice(start, next.length - end),
  );
  return vscode.workspace.applyEdit(edit);
}

/** The URI the user means: a menu argument, the active text editor, or the active custom editor tab. */
export function targetUri(arg?: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const editor = vscode.window.activeTextEditor;
  if (editor) return editor.document.uri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
  return undefined;
}
