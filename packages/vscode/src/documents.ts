import * as path from "node:path";
import type { ViewState } from "@inkmap/core";
import * as vscode from "vscode";

export interface DocState {
  name: string;
  md: string;
  version: string;
  viewState?: ViewState;
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

/** Cursor commands: add a code selection to the chat (as the plan editor does), and Cmd+L on the active text editor. */
const ADD_SELECTION_COMMAND = "composer.addsymbolstocomposer";
const CHAT_COMMAND = "aichat.newchataction";

export async function chatAvailable(): Promise<boolean> {
  const commands = await vscode.commands.getCommands(true);
  return commands.includes(ADD_SELECTION_COMMAND) || commands.includes(CHAT_COMMAND);
}

export const openChat = () => vscode.commands.executeCommand(CHAT_COMMAND);

/**
 * Sends lines of `document` to the Cursor chat, or only the part of them that equals `text`. The selection is
 * handed to the chat directly, so no text editor is opened and the layout (and the size of the mind map) stays
 * as it is. Without that command, the lines are selected in a text editor and sent with Cmd+L instead.
 */
export async function addLinesToChat(document: vscode.TextDocument, startLine: number, endLine: number, text?: string): Promise<void> {
  const last = document.lineCount - 1;
  const start = Math.max(0, Math.min(startLine, last));
  const end = Math.max(start, Math.min(endLine, last));
  let range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
  if (text) {
    // The selection comes from the node's Markdown, so it normally appears verbatim in the node's lines.
    const at = document.getText(range).indexOf(text);
    if (at >= 0) range = new vscode.Range(document.positionAt(document.offsetAt(range.start) + at), document.positionAt(document.offsetAt(range.start) + at + text.length));
  }
  const picked = text || document.getText(range);
  try {
    await vscode.commands.executeCommand(ADD_SELECTION_COMMAND, {
      codeSelections: [
        {
          uri: document.uri,
          range: {
            selectionStartLineNumber: range.start.line + 1,
            selectionStartColumn: range.start.character + 1,
            positionLineNumber: range.end.line + 1,
            positionColumn: range.end.character + 1,
          },
          text: "```markdown\n" + picked + "\n```",
          rawText: picked,
        },
      ],
    });
    return;
  } catch {
    // Fall through to the editor-based route.
  }
  await viaTextEditor(document, range);
}

/** Selects `range` in a text editor and sends it with Cmd+L; an editor opened just for that is closed again and the old split sizes come back. */
async function viaTextEditor(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
  const open = vscode.window.visibleTextEditors.find(e => e.document === document);
  const layout = open ? undefined : await vscode.commands.executeCommand("vscode.getEditorLayout");
  const before = new Set(vscode.window.tabGroups.all.flatMap(g => g.tabs));
  await vscode.window.showTextDocument(document, {
    viewColumn: open?.viewColumn ?? vscode.ViewColumn.Beside,
    selection: range,
    preview: false,
  });
  await openChat();
  if (open) return;
  const opened = vscode.window.tabGroups.all
    .flatMap(g => g.tabs)
    .find(tab => !before.has(tab) && tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString());
  if (opened) await vscode.window.tabGroups.close(opened);
  if (layout) await vscode.commands.executeCommand("vscode.setEditorLayout", layout);
}
