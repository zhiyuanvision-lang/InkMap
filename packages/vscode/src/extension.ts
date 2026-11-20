import { hasAccess } from "@inkmap/core";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, watch } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { BrowserServers } from "./browser";
import { chatAvailable, targetUri } from "./documents";
import { t } from "./i18n";
import { extensionLicense } from "./license";
import { MindmapEditorProvider } from "./mindmapEditor";

function insideOrEqual(root: string, target: string): boolean {
  if (root === target) return true;
  const rel = relative(root, target);
  return Boolean(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function resolveEditorUri(filePath: string): vscode.Uri {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderPath = folder.uri.fsPath || folder.uri.path;
    if (folderPath && insideOrEqual(folderPath, filePath)) {
      const rel = relative(folderPath, filePath).split(sep).join("/");
      return rel ? vscode.Uri.joinPath(folder.uri, rel) : folder.uri;
    }
  }
  const first = vscode.workspace.workspaceFolders?.[0];
  if (first && first.uri.scheme !== "file") {
    return first.uri.with({ path: filePath });
  }
  return vscode.Uri.file(filePath);
}

function findColumnForFile(fileUri: vscode.Uri): vscode.ViewColumn {
  const targetFs = fileUri.fsPath || fileUri.path;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri && (input.uri.fsPath === targetFs || input.uri.path === targetFs)) {
        return group.viewColumn;
      }
      if (tab.label && targetFs.endsWith(sep + tab.label.replace(/^Preview\s+/i, ""))) {
        return group.viewColumn;
      }
    }
  }
  return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
}

function localEditorUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function openUrlInEditorPane(url: string) {
  await vscode.commands.executeCommand("workbench.action.openBrowserEditor", {
    url,
    preserveFocus: false,
    inactive: false,
    reuseExistingUrlTab: true,
  });
}

async function openFileInEditorPane(filePath: string) {
  const fileUri = resolveEditorUri(filePath);
  const viewColumn = findColumnForFile(fileUri);
  await vscode.commands.executeCommand("vscode.openWith", fileUri, MindmapEditorProvider.viewType, {
    viewColumn,
    preserveFocus: false,
  });
}

function startMcpTargetBridge(): vscode.Disposable {
  const inkmapDir = process.env.INKMAP_HOME || join(homedir(), ".inkmap");
  const targetPath = join(inkmapDir, "antigravity-target.json");
  const ackPath = join(inkmapDir, "antigravity-target-ack.json");
  let lastSeq = Date.now() - 10_000;
  let debounceTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const syncInitialSeq = async () => {
    try {
      const raw = JSON.parse(await readFile(targetPath, "utf8"));
      if (typeof raw?.seq === "number" && raw.seq < Date.now() - 8000) {
        lastSeq = raw.seq;
      }
    } catch {}
    await checkTarget();
  };

  const alreadyAcked = async (seq: number) => {
    try {
      const ack = JSON.parse(await readFile(ackPath, "utf8"));
      return Boolean(ack && ack.ok === true && Number(ack.seq) >= seq);
    } catch {
      return false;
    }
  };

  const checkTarget = async () => {
    if (disposed) return;
    let claimedSeq = 0;
    try {
      const raw = JSON.parse(await readFile(targetPath, "utf8"));
      if (!raw || raw.openInEditorPane !== true) return;
      const seq = Number(raw.seq) || 0;
      if (seq <= lastSeq || typeof raw.file !== "string" || !/\.md$/i.test(raw.file)) return;
      if (await alreadyAcked(seq)) {
        lastSeq = seq;
        return;
      }

      const info = await lstat(raw.file).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 5 * 1024 * 1024) return;
      const realTarget = await realpath(raw.file).catch(() => raw.file as string);
      if (!/\.md$/i.test(realTarget)) return;

      const folders = vscode.workspace.workspaceFolders ?? [];
      let matchesFolder = false;
      for (const folder of folders) {
        const folderPath = folder.uri.fsPath || folder.uri.path;
        if (!folderPath) continue;
        const realFolder = await realpath(folderPath).catch(() => folderPath);
        if (insideOrEqual(realFolder, realTarget)) {
          matchesFolder = true;
          break;
        }
      }
      if (!matchesFolder) {
        if (!vscode.window.state.focused) return;
        // Let any sibling window whose workspace actually owns `realTarget` claim it first.
        await new Promise(r => setTimeout(r, 70));
        if (disposed || (await alreadyAcked(seq))) {
          lastSeq = seq;
          return;
        }
      }

      lastSeq = seq;
      claimedSeq = seq;
      const editorUrl = localEditorUrl(raw.editorUrl);
      if (editorUrl) await openUrlInEditorPane(editorUrl);
      else await openFileInEditorPane(realTarget);
      await writeFile(ackPath, JSON.stringify({
        seq,
        file: realTarget,
        ok: true,
        handledAt: Date.now(),
      }, null, 2), { mode: 0o600 }).catch(() => {});
    } catch (err) {
      // No target file yet (or a half-written one) is normal; only report failures for a request this window took.
      if (!claimedSeq) return;
      await writeFile(ackPath, JSON.stringify({
        seq: claimedSeq,
        ok: false,
        error: String(err instanceof Error ? err.message : err),
        handledAt: Date.now(),
      }, null, 2), { mode: 0o600 }).catch(() => {});
    }
  };

  void syncInitialSeq();
  try {
    if (!existsSync(inkmapDir)) mkdirSync(inkmapDir, { recursive: true, mode: 0o700 });
    const watcher = watch(inkmapDir, (_event, filename) => {
      if (filename && filename !== "antigravity-target.json") return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void checkTarget();
      }, 60);
    });
    watcher.on("error", () => {});
    const pollFallback = setInterval(() => {
      void checkTarget();
    }, 1200);
    return {
      dispose() {
        disposed = true;
        clearTimeout(debounceTimer);
        clearInterval(pollFallback);
        watcher.close();
      },
    };
  } catch {
    return { dispose() { disposed = true; } };
  }
}

// ---- DeepSeek Harness -----------------------------------------------------
// Inkmap can add its plugin to DeepSeek Harness's desktop profile, but only when the user agrees: once through a
// one-time prompt the first time Harness is found without the plugin, or later with "Inkmap: Install in DeepSeek Harness".

const HARNESS_INDEX_URL = "https://zhiyuanv.com/dsh-index.json";
const HARNESS_MARKET_BUNDLE = "@deepseek-ai/dsh-experimental-plugin-market-bundle";
const HARNESS_PROMPTED = "inkmap.deepseekHarnessPrompted";

interface HarnessProfile {
  dir: string;
  patch: string;
  pkg?: { dsh?: { profile?: { bundles?: string[] } }; dependencies?: Record<string, string> };
  /** The profile has no plugin-market entry yet (one that someone else added is left alone). */
  needsIndex: boolean;
  needsBundle: boolean;
  needsPlugin: boolean;
}

const harnessProfileDir = () => join(process.env.DSH_HOME || join(homedir(), ".dsh"), "profiles", "desktop");

async function readHarnessProfile(dir: string): Promise<HarnessProfile> {
  const patchPath = join(dir, "cordis.patch.yml");
  const patch = existsSync(patchPath) ? await readFile(patchPath, "utf8").catch(() => "") : "";
  let pkg: HarnessProfile["pkg"];
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {}
  const bundles = pkg?.dsh?.profile?.bundles;
  return {
    dir,
    patch,
    pkg,
    needsIndex: !patch.includes(HARNESS_INDEX_URL) && !/^\s*-\s*id:\s*plugin-market\b/m.test(patch),
    needsBundle: Array.isArray(bundles) && !bundles.includes(HARNESS_MARKET_BUNDLE),
    needsPlugin: Boolean(pkg) && !pkg?.dependencies?.["dsh-inkmap"],
  };
}

const harnessSetUp = (profile: HarnessProfile) => !profile.needsIndex && !profile.needsBundle && !profile.needsPlugin;

function harnessCli(): string | undefined {
  return [
    process.platform === "darwin" ? "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" : "",
    process.platform === "darwin" ? join(homedir(), "Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh") : "",
    process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd") : "",
  ].find(candidate => candidate && existsSync(candidate));
}

function runHarnessCli(cli: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // `%` is escaped outside the quotes so cmd.exe cannot expand `%VAR%` in a path.
    const q = (s: string) => `"${s.replace(/"/g, '""').replace(/%/g, '"^%"')}"`;
    const child = process.platform === "win32" && !cli.toLowerCase().endsWith(".exe")
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[cli, ...args].map(q).join(" ")}"`], {
          stdio: "ignore",
          windowsVerbatimArguments: true,
          windowsHide: true,
        })
      : spawn(cli, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("dsh did not finish in time"));
    }, 180_000);
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`dsh exited with code ${code}`));
    });
  });
}

/**
 * Adds the Inkmap plugin index to the desktop profile and installs `dsh-inkmap` with the DeepSeek Harness CLI.
 * Returns "configured" when the CLI was not found, so the user still has to install the plugin from Harness.
 */
async function installIntoHarness(profile: HarnessProfile): Promise<"installed" | "configured"> {
  if (profile.needsIndex) {
    const snippet = `- id: plugin-market\n  name: "@deepseek-ai/dsh-plugin-market"\n  config:\n    indexes:\n      - ${HARNESS_INDEX_URL}\n`;
    const trimmed = profile.patch.trim();
    // Append a new block instead of editing YAML by regex, which could corrupt another plugin's settings.
    const next = !trimmed || trimmed === "[]" ? snippet : profile.patch.replace(/\n*$/, "\n\n") + snippet;
    await writeFile(join(profile.dir, "cordis.patch.yml"), next, "utf8");
  }
  if (profile.needsBundle && profile.pkg?.dsh?.profile?.bundles) {
    profile.pkg.dsh.profile.bundles.push(HARNESS_MARKET_BUNDLE);
    await writeFile(join(profile.dir, "package.json"), JSON.stringify(profile.pkg, null, 2) + "\n", "utf8");
  }
  if (!profile.needsPlugin) return "installed";
  const cli = harnessCli();
  if (!cli) return "configured";
  const staged = join(process.env.INKMAP_HOME || join(homedir(), ".inkmap"), "dsh-inkmap");
  await runHarnessCli(cli, ["plugin", "--profile", "desktop", "add", existsSync(join(staged, "package.json")) ? staged : "dsh-inkmap"]);
  return "installed";
}

/** Installs Inkmap into DeepSeek Harness with progress and a result message (the command and the prompt use it). */
async function installInDeepSeekHarness() {
  const dir = harnessProfileDir();
  if (!existsSync(dir)) return void vscode.window.showWarningMessage(t("harnessNotFound"));
  try {
    const profile = await readHarnessProfile(dir);
    if (harnessSetUp(profile)) return void vscode.window.showInformationMessage(t("harnessAlready"));
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t("harnessInstalling") },
      () => installIntoHarness(profile),
    );
    void vscode.window.showInformationMessage(t(result === "installed" ? "harnessInstalled" : "harnessConfigured"));
  } catch (err) {
    void vscode.window.showErrorMessage(t("harnessFailed", { error: err instanceof Error ? err.message : String(err) }));
  }
}

/** Asks once, the first time DeepSeek Harness is found without the Inkmap plugin; never changes Harness unasked. */
async function offerDeepSeekHarnessSetup(context: vscode.ExtensionContext) {
  try {
    if (context.globalState.get<boolean>(HARNESS_PROMPTED)) return;
    const dir = harnessProfileDir();
    if (!existsSync(dir) || harnessSetUp(await readHarnessProfile(dir))) return;
    await context.globalState.update(HARNESS_PROMPTED, true);
    const install = t("harnessInstall");
    const pick = await vscode.window.showInformationMessage(t("harnessOffer"), install, t("harnessNoThanks"));
    if (pick === install) await installInDeepSeekHarness();
  } catch {}
}

export function activate(context: vscode.ExtensionContext) {
  void offerDeepSeekHarnessSetup(context);
  const log = vscode.window.createOutputChannel("Inkmap");
  const license = extensionLicense(context);
  license.track?.("plugin_activate");
  const browsers = new BrowserServers(context, vscode.Uri.joinPath(context.extensionUri, "dist", "web").fsPath, log, license);

  const withUri = (run: (uri: vscode.Uri) => unknown) => (arg?: unknown) => {
    const uri = targetUri(arg);
    if (!uri) return vscode.window.showWarningMessage(t("openMarkdownFirst"));
    return run(uri);
  };

  const openToSide = withUri(uri =>
    vscode.commands.executeCommand("vscode.openWith", uri, MindmapEditorProvider.viewType, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    }),
  );

  const openDemo = async () => {
    const dir = context.globalStorageUri?.fsPath || join(tmpdir(), "inkmap-welcome");
    mkdirSync(dir, { recursive: true });
    const demoPath = join(dir, "Inkmap-Welcome.md");
    if (!existsSync(demoPath)) await writeFile(demoPath, t("welcomeDoc"), "utf8");
    await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(demoPath), MindmapEditorProvider.viewType, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
    });
  };

  const maybeOfferOnboarding = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.languageId !== "markdown" || editor.document.uri.scheme !== "file") return;
    if (context.globalState.get<boolean>("inkmap.hasOpenedMap") || context.globalState.get<boolean>("inkmap.onboardingPrompted")) return;
    void context.globalState.update("inkmap.onboardingPrompted", true);
    license.track?.("onboarding_view");
    const docUri = editor.document.uri;
    void vscode.window.showInformationMessage(t("onboardingTip"), t("onboardingAction")).then(pick => {
      if (pick) {
        license.track?.("onboarding_open");
        void openToSide(docUri);
      }
    });
  };

  const maybeOfferWelcome = () => {
    const active = vscode.window.activeTextEditor;
    if (active?.document.languageId === "markdown" && active.document.uri.scheme === "file") {
      maybeOfferOnboarding(active);
      return;
    }
    if (
      context.globalState.get<boolean>("inkmap.hasOpenedMap") ||
      context.globalState.get<boolean>("inkmap.welcomePrompted") ||
      context.globalState.get<boolean>("inkmap.onboardingPrompted")
    ) {
      return;
    }
    void context.globalState.update("inkmap.welcomePrompted", true);
    license.track?.("onboarding_view");
    void vscode.window.showInformationMessage(t("welcomeTip"), t("welcomeAction")).then(pick => {
      if (pick) {
        license.track?.("onboarding_open");
        void openDemo();
      }
    });
  };

  const statusBar = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 100);
  if (statusBar) {
    statusBar.text = t("statusBarLabel");
    statusBar.tooltip = t("statusBarTooltip");
    statusBar.command = "inkmap.openToSide";
    const updateStatusBar = (editor: vscode.TextEditor | undefined) => {
      if (editor?.document.languageId === "markdown" && editor.document.uri.scheme === "file") statusBar.show();
      else statusBar.hide();
    };
    updateStatusBar(vscode.window.activeTextEditor);
    context.subscriptions.push(statusBar, vscode.window.onDidChangeActiveTextEditor(updateStatusBar));
  }

  const editors = new MindmapEditorProvider(context, license);
  chatAvailable().then(available => vscode.commands.executeCommand("setContext", "inkmap.chatAvailable", available));
  maybeOfferWelcome();

  if (vscode.languages?.registerCodeLensProvider) {
    const lensEmitter = vscode.EventEmitter ? new vscode.EventEmitter<void>() : undefined;
    const lensProvider: vscode.CodeLensProvider = {
      ...(lensEmitter && { onDidChangeCodeLenses: lensEmitter.event }),
      provideCodeLenses(document) {
        if (document.uri.scheme !== "file") return [];
        if (vscode.workspace.getConfiguration("inkmap", document.uri).get<boolean>("codeLens", true) === false) {
          return [];
        }
        const top = new vscode.Range(0, 0, 0, 0);
        return [
          new vscode.CodeLens(top, {
            title: t("codeLensOpen"),
            tooltip: t("codeLensOpenTooltip"),
            command: "inkmap.codeLensOpen",
            arguments: [document.uri],
          }),
          new vscode.CodeLens(top, {
            title: t("codeLensBrowser"),
            tooltip: t("codeLensBrowserTooltip"),
            command: "inkmap.openInBrowser",
            arguments: [document.uri],
          }),
        ];
      },
    };
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "markdown", scheme: "file" }, lensProvider));
    if (lensEmitter) {
      context.subscriptions.push(lensEmitter);
      if (vscode.workspace.onDidChangeConfiguration) {
        context.subscriptions.push(
          vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("inkmap.codeLens")) lensEmitter.fire();
          }),
        );
      }
    }
  }

  context.subscriptions.push(
    log,
    license,
    browsers,
    startMcpTargetBridge(),
    vscode.window.onDidChangeActiveTextEditor(maybeOfferOnboarding),
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        if (uri.path === "/open") {
          const target = new URLSearchParams(uri.query).get("path")?.trim();
          if (!target || !isAbsolute(target) || !/\.md$/i.test(target)) return;
          const info = await lstat(target).catch(() => null);
          if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 5 * 1024 * 1024) return;
          void openFileInEditorPane(target);
        }
      },
    }),
    vscode.window.registerCustomEditorProvider(MindmapEditorProvider.viewType, editors, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("inkmap.addToChat", () => editors.requestChat()),
    vscode.commands.registerCommand("inkmap.open", openToSide),
    vscode.commands.registerCommand("inkmap.openToSide", openToSide),
    vscode.commands.registerCommand("inkmap.codeLensOpen", (arg?: unknown) => {
      if (!context.globalState.get<boolean>("inkmap.hasOpenedMap")) {
        license.track?.("onboarding_open");
      }
      return openToSide(arg);
    }),
    vscode.commands.registerCommand(
      "inkmap.showSource",
      withUri(uri => vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false })),
    ),
    vscode.commands.registerCommand(
      "inkmap.openInBrowser",
      withUri(async uri => {
        if (!hasAccess(await license.state())) {
          await openToSide(uri);
          editors.openAccount(uri);
          return;
        }
        try {
          license.track?.("feature_browser");
          const url = await browsers.open(uri);
          const pick = await vscode.window.showInformationMessage(t("browserOpened", { url }), t("copyLink"));
          if (pick) await vscode.env.clipboard.writeText(url);
        } catch (err) {
          vscode.window.showErrorMessage(t("browserFailed", { error: err instanceof Error ? err.message : String(err) }));
        }
      }),
    ),
    vscode.commands.registerCommand("inkmap.installDeepSeekHarness", installInDeepSeekHarness),
    vscode.commands.registerCommand("inkmap.openDemo", openDemo),
    vscode.commands.registerCommand("inkmap.upgrade", async (arg?: unknown) => {
      if (editors.openAccount()) return;
      const uri = targetUri(arg);
      if (!uri) return vscode.window.showWarningMessage(t("openMarkdownFirst"));
      await openToSide(uri);
      editors.openAccount(uri);
    }),
  );
}

export function deactivate() {}
