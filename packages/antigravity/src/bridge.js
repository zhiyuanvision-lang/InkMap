(function () {
  const isZh = () => /^zh\b/i.test(localStorage.getItem("inkmap.language") || navigator.language || "zh");
  const text = (zh, en) => (isZh() ? zh : en);

  window.INKMAP_ASSET_BASE = "/api/doc-asset?path=";
  window.INKMAP_LOCALE = navigator.language;

  const params = new URLSearchParams(window.location.search);
  const initialRequestedFile = params.get("file") || "";

  let workspaceUris = [];
  let currentFile = null;
  let currentFileUri = null;
  let currentVersion = "";
  let currentMd = "";
  let targetSeq = 0;
  let saving = false;

  const apiFetch = async (path, options = {}) => {
    const fn = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : window.fetch.bind(window);
    const method = (options.method || "GET").toUpperCase();
    const res = await fn(path, {
      ...options,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${path}: ${res.status}`);
    return data;
  };

  const debugLog = (event, detail = {}) => {
    void apiFetch("/api/debug", {
      method: "POST",
      body: JSON.stringify({ event, ...detail, href: window.location.href, ts: Date.now() }),
    }).catch(() => {});
  };

  window.addEventListener("error", e => {
    debugLog("window.error", { message: e.message, filename: e.filename, lineno: e.lineno });
  });
  window.addEventListener("unhandledrejection", e => {
    debugLog("unhandledrejection", { reason: String(e.reason?.stack || e.reason) });
  });
  window.addEventListener("message", e => {
    if (e.data && typeof e.data === "object" && e.data.type === "__inkmap_debug") {
      debugLog(e.data.event || "client.debug", e.data);
    }
  });
  debugLog("bridge.loaded");

  const emitToEditor = msg => {
    window.postMessage(msg, "*");
  };

  async function resolveWorkspaces() {
    if (!window.sidecar?.getWorkspaceUris) return workspaceUris;
    try {
      const uris = await Promise.race([
        window.sidecar.getWorkspaceUris(),
        new Promise(resolve => setTimeout(() => resolve([]), 600)),
      ]);
      if (Array.isArray(uris) && uris.length) workspaceUris = uris;
    } catch {}
    return workspaceUris;
  }

  let fileSelectEl = null;
  let openRawBtn = null;
  let splitMdBtn = null;
  let mdPaneEl = null;
  let mdTextareaEl = null;
  let mdTitleEl = null;
  let splitOpen = false;
  let splitWidthPct = 42;
  let mdEditTimer = 0;

  function syncMdPaneContent(md = currentMd, force = false) {
    if (mdTitleEl) {
      const fileName = currentFile ? currentFile.split(/[\\/]/).pop() : "Markdown";
      mdTitleEl.textContent = fileName;
      mdTitleEl.title = currentFile || fileName;
    }
    if (!mdTextareaEl) return;
    if (force || document.activeElement !== mdTextareaEl) {
      if (mdTextareaEl.value !== md) mdTextareaEl.value = md;
    }
  }

  function applySplitLayout(fitAfter = false) {
    document.documentElement.classList.toggle("ag-split-active", splitOpen);
    document.documentElement.style.setProperty("--ag-split-left", `${splitWidthPct}vw`);
    if (mdPaneEl) mdPaneEl.hidden = !splitOpen;
    if (splitMdBtn) {
      splitMdBtn.dataset.active = splitOpen ? "true" : "false";
      splitMdBtn.textContent = splitOpen ? text("仅留导图", "Map Only") : text("左MD/右导图", "Split MD");
      splitMdBtn.title = splitOpen
        ? text("关闭左侧 Markdown，仅保留右侧思维导图", "Close left Markdown pane and keep mind map only")
        : text("开启左 Markdown 文件、右思维导图分屏对比与编辑", "Split screen: Markdown on left, Mind Map on right");
    }
    if (splitOpen) syncMdPaneContent(currentMd, true);
    requestAnimationFrame(() => {
      try {
        window.inkmap?.mindMap?.resize();
        if (fitAfter) window.inkmap?.mindMap?.view?.fit();
      } catch {}
    });
  }

  function renderFilePicker(files = [], selected = currentFile) {
    if (!fileSelectEl) return;
    fileSelectEl.innerHTML = "";
    if (!files.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = text("未找到 Markdown 文件", "No Markdown files");
      fileSelectEl.appendChild(opt);
      fileSelectEl.disabled = true;
      if (openRawBtn) openRawBtn.disabled = true;
      return;
    }
    fileSelectEl.disabled = false;
    if (openRawBtn) openRawBtn.disabled = !selected;

    const activeFiles = files.filter(f => f.group === "active");
    const projectFiles = files.filter(f => f.group !== "active");

    const appendOptions = (parent, list) => {
      for (const item of list) {
        const opt = document.createElement("option");
        opt.value = item.path;
        opt.textContent = item.label;
        opt.title = item.path;
        if (item.path === selected) opt.selected = true;
        parent.appendChild(opt);
      }
    };

    if (activeFiles.length && projectFiles.length) {
      const g1 = document.createElement("optgroup");
      g1.label = text("当前工作区", "Active Workspace");
      appendOptions(g1, activeFiles);
      const g2 = document.createElement("optgroup");
      g2.label = text("其他项目", "Other Projects");
      appendOptions(g2, projectFiles);
      fileSelectEl.append(g1, g2);
    } else {
      appendOptions(fileSelectEl, files);
    }
  }

  async function switchFile(filePath) {
    if (!filePath || filePath === currentFile) return;
    try {
      const data = await apiFetch("/api/open", {
        method: "POST",
        body: JSON.stringify({ workspaceUris, file: filePath }),
      });
      currentFile = data.currentFile;
      currentFileUri = data.currentFileUri;
      currentVersion = data.doc.version;
      currentMd = data.doc.md;
      targetSeq = data.targetSeq || targetSeq;
      renderFilePicker(data.files, currentFile);
      pushDocToEditor(data.doc);
      setTimeout(() => {
        try { window.inkmap?.mindMap?.view?.fit(); } catch {}
      }, 120);
    } catch (err) {
      console.error("Failed to switch file:", err);
    }
  }

  function mountToolbarControls() {
    const bar = document.getElementById("bar");
    if (!bar || document.getElementById("ag-file-select")) return;

    const style = document.createElement("style");
    style.textContent = `
      html, body { margin: 0; height: 100%; overflow: hidden; background: var(--ink-bg) !important; color: var(--ui-text) !important; }
      #map { position: fixed; inset: 0; width: 100vw; height: 100vh; transition: left .12s ease, width .12s ease; }
      :root.ag-split-active #map { left: var(--ag-split-left, 42vw); width: calc(100vw - var(--ag-split-left, 42vw)); }
      #ag-file-select { max-width: 200px; font-weight: 550; text-overflow: ellipsis; overflow: hidden; }
      #ag-open-raw, #ag-split-md { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
      #ag-split-md[data-active="true"] { background: color-mix(in srgb, var(--ui-primary, #336df4) 14%, transparent); color: var(--ui-primary, #336df4); font-weight: 600; }
      #ag-md-pane {
        position: fixed; top: calc(var(--toolbar-height, 40px) + 18px); left: 12px; bottom: 12px;
        width: calc(var(--ag-split-left, 42vw) - 16px); z-index: 30;
        display: flex; flex-direction: column;
        background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)); border-radius: 10px;
        box-shadow: var(--ui-shadow, 0 4px 16px rgba(31,35,41,.08)); overflow: hidden;
      }
      #ag-md-pane[hidden] { display: none !important; }
      .ag-md-header {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 7px 10px; border-bottom: 1px solid var(--ui-border, rgba(31,35,41,.09));
        background: var(--ui-subtle, #f6f7f9); font-size: 12px;
      }
      .ag-md-title {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
      }
      .ag-md-actions { display: inline-flex; align-items: center; gap: 4px; flex: none; }
      .ag-md-close {
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)); background: var(--ui-solid, #fff);
        color: var(--ui-text, #1f2329); border-radius: 5px; padding: 2px 8px; font-size: 11.5px; cursor: pointer;
      }
      .ag-md-close:hover { background: var(--ui-hover, rgba(31,35,41,.06)); }
      #ag-md-textarea {
        flex: 1; width: 100%; box-sizing: border-box; border: 0; outline: none; resize: none;
        padding: 12px 14px; background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        tab-size: 2;
      }
      #ag-md-resizer {
        position: absolute; top: 0; right: 0; bottom: 0; width: 5px; cursor: col-resize;
        background: transparent;
      }
      #ag-md-resizer:hover { background: color-mix(in srgb, var(--ui-primary, #336df4) 35%, transparent); }
    `;
    document.head.appendChild(style);

    fileSelectEl = document.createElement("select");
    fileSelectEl.id = "ag-file-select";
    fileSelectEl.setAttribute("aria-label", text("选择 Markdown 文件", "Select Markdown file"));
    fileSelectEl.title = text("切换要编辑的 Markdown 导图文件", "Switch Markdown file");
    fileSelectEl.addEventListener("change", () => {
      if (fileSelectEl.value) void switchFile(fileSelectEl.value);
      fileSelectEl.blur();
    });

    splitMdBtn = document.createElement("button");
    splitMdBtn.id = "ag-split-md";
    splitMdBtn.type = "button";
    splitMdBtn.addEventListener("click", () => {
      splitOpen = !splitOpen;
      applySplitLayout(true);
      splitMdBtn.blur();
    });

    openRawBtn = document.createElement("button");
    openRawBtn.id = "ag-open-raw";
    openRawBtn.type = "button";
    openRawBtn.textContent = text("原文件", "Raw");
    openRawBtn.title = text("在编辑器中打开 Markdown 原文件（也可关闭原文件仅留导图）", "Open raw Markdown file in editor");
    openRawBtn.addEventListener("click", () => {
      if (currentFileUri) {
        if (window.sidecar?.openUrl) {
          window.sidecar.openUrl(currentFileUri);
        } else if (window.sidecar?.ui?.toggleAuxPane) {
          window.sidecar.ui.toggleAuxPane({ tabType: "fileView", uri: currentFileUri });
        }
      }
      openRawBtn.blur();
    });

    const sep = document.createElement("span");
    sep.className = "sep";

    bar.prepend(fileSelectEl, splitMdBtn, openRawBtn, sep);

    mdPaneEl = document.createElement("aside");
    mdPaneEl.id = "ag-md-pane";
    mdPaneEl.hidden = true;
    mdPaneEl.innerHTML = `
      <div class="ag-md-header">
        <span class="ag-md-title" id="ag-md-title">Markdown</span>
        <div class="ag-md-actions">
          <button type="button" class="ag-md-close" id="ag-md-close"></button>
        </div>
      </div>
      <textarea id="ag-md-textarea" spellcheck="false"></textarea>
      <div id="ag-md-resizer" title="拖拽调整分屏宽度"></div>
    `;
    document.body.appendChild(mdPaneEl);
    mdTitleEl = document.getElementById("ag-md-title");
    mdTextareaEl = document.getElementById("ag-md-textarea");
    const closeBtn = document.getElementById("ag-md-close");
    if (closeBtn) {
      closeBtn.textContent = text("× 关闭MD（仅留导图）", "× Close MD");
      closeBtn.title = text("关闭左侧 Markdown 面板，只保留思维导图", "Close Markdown pane and keep mind map only");
      closeBtn.addEventListener("click", () => {
        splitOpen = false;
        applySplitLayout(true);
      });
    }
    if (mdTextareaEl) {
      mdTextareaEl.addEventListener("input", () => {
        const nextMd = mdTextareaEl.value;
        currentMd = nextMd;
        clearTimeout(mdEditTimer);
        mdEditTimer = window.setTimeout(() => {
          if (window.inkmap?.load) {
            void window.inkmap.load(nextMd, true);
          }
        }, 320);
      });
    }
    const resizer = document.getElementById("ag-md-resizer");
    if (resizer) {
      resizer.addEventListener("pointerdown", e => {
        e.preventDefault();
        resizer.setPointerCapture(e.pointerId);
        const onMove = ev => {
          const pct = Math.max(24, Math.min(68, (ev.clientX / Math.max(1, window.innerWidth)) * 100));
          splitWidthPct = Math.round(pct * 10) / 10;
          applySplitLayout(false);
        };
        const onUp = () => {
          resizer.removeEventListener("pointermove", onMove);
          resizer.removeEventListener("pointerup", onUp);
          resizer.removeEventListener("pointercancel", onUp);
          try { window.inkmap?.mindMap?.view?.fit(); } catch {}
        };
        resizer.addEventListener("pointermove", onMove);
        resizer.addEventListener("pointerup", onUp);
        resizer.addEventListener("pointercancel", onUp);
      });
    }
    applySplitLayout(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountToolbarControls);
  } else {
    mountToolbarControls();
  }

  let readyReceived = false;
  let initialDocSent = false;
  let lastLicense = { pro: false };

  function pushDocToEditor(doc, license = lastLicense) {
    if (!doc) return;
    if (license) lastLicense = license;
    syncMdPaneContent(doc.md, true);
    if (!initialDocSent) {
      if (!readyReceived) return;
      initialDocSent = true;
      debugLog("emit.doc", { name: doc.name, mdLen: doc.md?.length });
      emitToEditor({
        type: "doc",
        doc,
        license: lastLicense || { pro: false },
        ads: [],
        chat: true,
      });
      setTimeout(() => {
        const mapEl = document.getElementById("map");
        debugLog("map.check.500ms", {
          hasInkmap: Boolean(window.inkmap),
          mapChildren: mapEl ? mapEl.children.length : -1,
          mapRect: mapEl ? mapEl.getBoundingClientRect() : null,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          bodyText: document.body?.innerText?.slice(0, 120),
        });
      }, 500);
      setTimeout(() => {
        const mapEl = document.getElementById("map");
        debugLog("map.check.2500ms", {
          hasInkmap: Boolean(window.inkmap),
          mapChildren: mapEl ? mapEl.children.length : -1,
          mapRect: mapEl ? mapEl.getBoundingClientRect() : null,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          bodyText: document.body?.innerText?.slice(0, 120),
        });
      }, 2500);
    } else {
      debugLog("emit.change", { name: doc.name, mdLen: doc.md?.length });
      emitToEditor({ type: "change", doc });
    }
  }

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange(async nextUris => {
      workspaceUris = Array.isArray(nextUris) ? nextUris : [];
      debugLog("workspace.change", { workspaceUris });
      try {
        const data = await apiFetch("/api/init", {
          method: "POST",
          body: JSON.stringify({ workspaceUris }),
        });
        if (data.targetSeq) targetSeq = data.targetSeq;
        if (data.license) lastLicense = data.license;
        renderFilePicker(data.files, currentFile || data.currentFile);
        if (!currentFile && data.currentFile) {
          currentFile = data.currentFile;
          currentFileUri = data.currentFileUri;
          currentVersion = data.doc.version;
          currentMd = data.doc.md;
          pushDocToEditor(data.doc, data.license);
        }
      } catch (err) {
        debugLog("workspace.change.err", { error: String(err) });
      }
    });
  }

  // Poll for external file edits or AI skill file switches (`select.mjs`).
  setInterval(async () => {
    if (!initialDocSent || saving) return;
    try {
      const res = await apiFetch("/api/poll", {
        method: "POST",
        body: JSON.stringify({
          ...(currentFile && { file: currentFile }),
          ...(currentVersion && { version: currentVersion }),
          targetSeq: String(targetSeq),
        }),
      });
      if (res.targetSeq) targetSeq = res.targetSeq;
      if (res.switchedFile && res.doc) {
        currentFile = res.switchedFile;
        currentFileUri = res.currentFileUri;
        currentVersion = res.doc.version;
        currentMd = res.doc.md;
        const initData = await apiFetch("/api/init", {
          method: "POST",
          body: JSON.stringify({ workspaceUris, requestedFile: currentFile }),
        }).catch(() => null);
        if (initData?.files) renderFilePicker(initData.files, currentFile);
        pushDocToEditor(res.doc, initData?.license);
        setTimeout(() => {
          try { window.inkmap?.mindMap?.view?.fit(); } catch {}
        }, 120);
      } else if (res.changed && res.doc) {
        currentVersion = res.doc.version;
        currentMd = res.doc.md;
        pushDocToEditor(res.doc);
      }
    } catch {}
  }, 1200);

  function sliceLines(md, startLine, endLine, subText) {
    if (subText) return subText;
    const lines = String(md || "").split("\n");
    const s = Math.max(0, Math.min(startLine ?? 0, lines.length - 1));
    const e = Math.max(s, Math.min(endLine ?? s, lines.length - 1));
    return lines.slice(s, e + 1).join("\n");
  }

  window.acquireVsCodeApi = () => ({
    async postMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      debugLog("postMessage", { type: msg.type });
      try {
        switch (msg.type) {
          case "ready": {
            readyReceived = true;
            await resolveWorkspaces();
            mountToolbarControls();
            const data = await apiFetch("/api/init", {
              method: "POST",
              body: JSON.stringify({ workspaceUris, requestedFile: initialRequestedFile }),
            });
            currentFile = data.currentFile;
            currentFileUri = data.currentFileUri;
            currentVersion = data.doc.version;
            currentMd = data.doc.md;
            targetSeq = data.targetSeq || 0;
            lastLicense = data.license || { pro: false };
            renderFilePicker(data.files, currentFile);
            pushDocToEditor(data.doc, lastLicense);
            return;
          }
          case "save": {
            saving = true;
            try {
              const res = await apiFetch("/api/save", {
                method: "POST",
                body: JSON.stringify({
                  workspaceUris,
                  file: currentFile,
                  md: msg.md,
                  baseVersion: msg.baseVersion,
                }),
              });
              if (res.conflict && res.doc) {
                currentVersion = res.doc.version;
                currentMd = res.doc.md;
                syncMdPaneContent(currentMd, true);
                emitToEditor({ type: "conflict", id: msg.id, doc: res.doc });
              } else {
                currentVersion = res.version;
                currentMd = msg.md;
                syncMdPaneContent(currentMd, false);
                emitToEditor({ type: "saved", id: msg.id, version: res.version });
              }
            } finally {
              saving = false;
            }
            return;
          }
          case "viewState": {
            if (!currentFile) return;
            void apiFetch("/api/view", {
              method: "POST",
              body: JSON.stringify({ workspaceUris, file: currentFile, state: msg.state }),
            }).catch(() => {});
            return;
          }
          case "undo": {
            window.inkmap?.mindMap?.execCommand("BACK");
            return;
          }
          case "redo": {
            window.inkmap?.mindMap?.execCommand("FORWARD");
            return;
          }
          case "addToChat": {
            if (!currentFile) return;
            const snippet = sliceLines(currentMd, msg.startLine, msg.endLine, msg.text);
            if (window.sidecar?.ui?.addArtifactComment && currentFileUri) {
              window.sidecar.ui.addArtifactComment({
                uri: currentFileUri,
                comment: snippet,
                selection: {
                  startLine: (msg.startLine ?? 0) + 1,
                  endLine: (msg.endLine ?? msg.startLine ?? 0) + 1,
                },
                pageTitle: currentFile.split(/[\\/]/).pop() || "Inkmap",
              });
            } else if (window.sidecar?.agent?.sendMessage && window.sidecar.conversationId) {
              await window.sidecar.agent.sendMessage(
                `来自 \`${currentFile}\`（第 ${(msg.startLine ?? 0) + 1}–${(msg.endLine ?? 0) + 1} 行）：\n\`\`\`markdown\n${snippet}\n\`\`\``,
                window.sidecar.conversationId,
              );
            }
            return;
          }
          case "checkout": {
            const res = await apiFetch("/api/checkout", {
              method: "POST",
              body: JSON.stringify({ mode: msg.mode }),
            });
            emitToEditor({ type: "checkout", id: msg.id });
            // Poll license state after checkout link opens
            const checkTimer = setInterval(async () => {
              const state = await apiFetch("/api/license", { method: "GET" }).catch(() => null);
              if (state) emitToEditor({ type: "license", state });
              if (state?.pro || state?.connected) clearInterval(checkTimer);
            }, 3000);
            setTimeout(() => clearInterval(checkTimer), 120_000);
            if (res.url && !window.sidecar) window.open(res.url, "_blank", "noopener,noreferrer");
            return;
          }
          case "orderPro": {
            const { result } = await apiFetch("/api/order-pro", {
              method: "POST",
              body: "{}",
            });
            emitToEditor({ type: "proOrder", id: msg.id, result });
            if (result?.status === "qr" || result?.status === "redirect") {
              const checkTimer = setInterval(async () => {
                const state = await apiFetch("/api/license", { method: "GET" }).catch(() => null);
                if (state) emitToEditor({ type: "license", state });
                if (state?.pro) clearInterval(checkTimer);
              }, 3000);
              setTimeout(() => clearInterval(checkTimer), 15 * 60_000);
            }
            return;
          }
          case "sendPhoneCode": {
            const { result } = await apiFetch("/api/phone-send", {
              method: "POST",
              body: JSON.stringify({ phone: msg.phone }),
            });
            emitToEditor({ type: "phoneCodeSent", id: msg.id, result });
            return;
          }
          case "signInByPhone": {
            const { result } = await apiFetch("/api/phone-verify", {
              method: "POST",
              body: JSON.stringify({ phone: msg.phone, code: msg.code }),
            });
            emitToEditor({ type: "phoneSignIn", id: msg.id, result });
            return;
          }
          case "signOut": {
            const { state } = await apiFetch("/api/signout", { method: "POST", body: "{}" });
            emitToEditor({ type: "signedOut", id: msg.id });
            if (state) emitToEditor({ type: "license", state });
            return;
          }
          case "saveFile": {
            const a = document.createElement("a");
            a.href = msg.dataUrl;
            a.download = msg.name;
            a.click();
            emitToEditor({ type: "fileSaved", id: msg.id, saved: true });
            return;
          }
        }
      } catch (err) {
        debugLog("postMessage.error", { type: msg.type, error: String(err?.stack || err) });
        if ("id" in msg) {
          emitToEditor({
            type: "error",
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  });

  // Restore keyboard undo/redo since VsCodeHost removes simple-mind-map's default Control+z / Control+y
  window.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.isComposing) return;
    const tag = (e.target?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        window.inkmap?.mindMap?.execCommand("BACK");
      } else if ((k === "z" && e.shiftKey) || (k === "y" && !e.shiftKey)) {
        e.preventDefault();
        window.inkmap?.mindMap?.execCommand("FORWARD");
      }
    }
  });
})();
