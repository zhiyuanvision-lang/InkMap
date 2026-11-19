(function () {
  // The sidecar injects `data-os-locale` from the computer's OS timezone/language; UI language never decides it.
  const osLocale = () => document.documentElement?.dataset?.osLocale || "";
  const isZh = () => osLocale() ? osLocale() === "zh" : /^zh(?:[-_.]|$)/i.test(navigator.language || "");
  const text = (zh, en) => (isZh() ? zh : en);

  // Each panel names itself, so the sidecar resolves this panel's images against the document it shows.
  const panelId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  window.INKMAP_ASSET_BASE = "/api/doc-asset?panel=" + encodeURIComponent(panelId) + "&path=";
  window.INKMAP_ACCOUNT_MODE = "restore";

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
    let body = options.body;
    if (method !== "GET" && typeof body === "string") {
      try {
        body = JSON.stringify({ ...JSON.parse(body), panel: panelId });
      } catch {}
    }
    const res = await fn(path, {
      ...options,
      body,
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

  let fileTriggerBtn = null;
  let fileTriggerNameEl = null;
  let fileTriggerDirEl = null;
  let filePopoverEl = null;
  let fileSearchInputEl = null;
  let fileTreeBodyEl = null;
  let cachedFiles = [];
  const expandedKeys = new Set();
  let initializedExpansionForFile = "";
  let openRawBtn = null;
  let splitMdBtn = null;
  let mdPaneEl = null;
  let mdTextareaEl = null;
  let mdTitleEl = null;
  let mdLineBadgeEl = null;
  let mdCloseBtnEl = null;
  let mdGutterEl = null;
  let mdBandEl = null;
  let splitOpen = false;
  let splitWidthPct = 42;
  let mdEditTimer = 0;
  let activeStartLine = 0;
  let activeEndLine = 0;
  let lastGutterKey = "";

  function parseFileEntry(item) {
    const label = typeof item.label === "string" ? item.label : "";
    const sepIdx = label.indexOf(" / ");
    if (sepIdx > 0) {
      const project = label.slice(0, sepIdx).trim();
      const rel = label.slice(sepIdx + 3).replace(/\\/g, "/");
      return { project, rel, item };
    }
    const rel = (label || (item.path || "").split(/[\\/]/).pop() || "").replace(/\\/g, "/");
    const normPath = (item.path || "").replace(/\\/g, "/");
    const suffix = "/" + rel;
    let project = text("当前项目", "Workspace");
    if (normPath.endsWith(suffix)) {
      const rootDir = normPath.slice(0, normPath.length - suffix.length);
      project = rootDir.split("/").filter(Boolean).pop() || project;
    }
    return { project, rel, item };
  }

  function buildProjectTree(files, filterText = "") {
    const q = filterText.trim().toLowerCase();
    const projectMap = new Map();

    for (const raw of files) {
      const { project, rel, item } = parseFileEntry(raw);
      if (q && !project.toLowerCase().includes(q) && !rel.toLowerCase().includes(q)) continue;
      let proj = projectMap.get(project);
      if (!proj) {
        proj = {
          name: project,
          key: `proj:${project}`,
          active: item.group === "active",
          count: 0,
          root: { name: "", key: `proj:${project}`, folders: new Map(), files: [] },
        };
        projectMap.set(project, proj);
      }
      if (item.group === "active") proj.active = true;
      proj.count++;

      const parts = rel.split("/").filter(Boolean);
      const fileName = parts.pop() || rel;
      let curr = proj.root;
      let pathAcc = `proj:${project}`;
      for (const seg of parts) {
        pathAcc += `/${seg}`;
        let next = curr.folders.get(seg);
        if (!next) {
          next = { name: seg, key: pathAcc, folders: new Map(), files: [] };
          curr.folders.set(seg, next);
        }
        curr = next;
      }
      curr.files.push({
        name: fileName,
        path: item.path,
        rel,
        project,
        isMarkmap: /\.markmap\.md$/i.test(fileName),
      });
    }

    function compactAndSort(folder) {
      const compacted = [];
      for (const child of folder.folders.values()) {
        while (child.files.length === 0 && child.folders.size === 1) {
          const onlySub = [...child.folders.values()][0];
          child.name = `${child.name}/${onlySub.name}`;
          child.key = onlySub.key;
          child.folders = onlySub.folders;
          child.files = onlySub.files;
        }
        compactAndSort(child);
        compacted.push(child);
      }
      compacted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      folder.sortedFolders = compacted;
      folder.files.sort((a, b) => {
        if (a.isMarkmap !== b.isMarkmap) return a.isMarkmap ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      });
      let total = folder.files.length;
      for (const c of compacted) total += c.totalFiles || 0;
      folder.totalFiles = total;
    }

    const projects = [...projectMap.values()];
    for (const p of projects) compactAndSort(p.root);
    projects.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    return projects;
  }

  function ensureSelectedAncestorsExpanded(projects, selectedPath) {
    if (!selectedPath || initializedExpansionForFile === selectedPath) return;
    initializedExpansionForFile = selectedPath;
    for (const p of projects) {
      if (p.active) expandedKeys.add(p.key);
      function markFolder(folder) {
        let hasSelected = folder.files.some(f => f.path === selectedPath);
        for (const sub of folder.sortedFolders || []) {
          if (markFolder(sub)) hasSelected = true;
        }
        if (hasSelected) expandedKeys.add(folder.key);
        return hasSelected;
      }
      if (markFolder(p.root)) {
        expandedKeys.add(p.key);
      }
    }
  }

  function renderTreeDom() {
    if (!fileTreeBodyEl) return;
    const filterText = fileSearchInputEl ? fileSearchInputEl.value : "";
    const isFiltering = Boolean(filterText.trim());
    const projects = buildProjectTree(cachedFiles, filterText);
    ensureSelectedAncestorsExpanded(projects, currentFile);

    fileTreeBodyEl.innerHTML = "";
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "ag-tree-empty";
      empty.textContent = isFiltering
        ? text("无匹配的 Markdown 文件", "No matching Markdown files")
        : text("未找到 Markdown 文件", "No Markdown files");
      fileTreeBodyEl.appendChild(empty);
      return;
    }

    const chevronSvg = `<svg class="ag-tree-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`;
    const folderSvg = `<svg class="ag-tree-icon ag-icon-folder" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-5.5A1.75 1.75 0 0 0 14.25 4.5H7.82a.25.25 0 0 1-.177-.073L6.28 3.063A1.75 1.75 0 0 0 5.043 2.5H1.75Z"/></svg>`;
    const mapFileSvg = `<svg class="ag-tree-icon ag-icon-map" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="3.5" cy="8" r="1.75"/><circle cx="12.5" cy="4" r="1.75"/><circle cx="12.5" cy="12" r="1.75"/><path d="M5.25 7.3L10.75 4.7M5.25 8.7l5.5 2.6"/></svg>`;
    const mdFileSvg = `<svg class="ag-tree-icon ag-icon-md" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1.5Z"/><path d="M9.5 1.5v4h4"/></svg>`;

    const renderFolderContents = (folder, container, depth) => {
      for (const sub of folder.sortedFolders || []) {
        const isOpen = isFiltering || expandedKeys.has(sub.key);
        const folderWrap = document.createElement("div");
        folderWrap.className = "ag-tree-group";

        const row = document.createElement("button");
        row.type = "button";
        row.className = `ag-tree-row ag-tree-folder ${isOpen ? "is-open" : ""}`;
        row.style.paddingLeft = `${10 + depth * 14}px`;
        row.innerHTML = `${chevronSvg}${folderSvg}<span class="ag-tree-label"></span><span class="ag-tree-count">${sub.totalFiles}</span>`;
        row.querySelector(".ag-tree-label").textContent = sub.name;
        row.title = sub.name;
        row.addEventListener("click", e => {
          e.stopPropagation();
          if (expandedKeys.has(sub.key)) expandedKeys.delete(sub.key);
          else expandedKeys.add(sub.key);
          renderTreeDom();
        });
        folderWrap.appendChild(row);

        if (isOpen) {
          const childrenBox = document.createElement("div");
          childrenBox.className = "ag-tree-children";
          renderFolderContents(sub, childrenBox, depth + 1);
          folderWrap.appendChild(childrenBox);
        }
        container.appendChild(folderWrap);
      }

      for (const file of folder.files) {
        const isSelected = file.path === currentFile;
        const fileBtn = document.createElement("button");
        fileBtn.type = "button";
        fileBtn.className = `ag-tree-row ag-tree-file ${isSelected ? "is-selected" : ""}`;
        fileBtn.style.paddingLeft = `${10 + depth * 14}px`;
        fileBtn.innerHTML = `<span class="ag-tree-Check">${isSelected ? "✓" : ""}</span>${file.isMarkmap ? mapFileSvg : mdFileSvg}<span class="ag-tree-label"></span>${file.isMarkmap ? `<span class="ag-tree-tag">${text("导图", "Map")}</span>` : ""}`;
        fileBtn.querySelector(".ag-tree-label").textContent = file.name;
        fileBtn.title = `${file.project} / ${file.rel}`;
        fileBtn.addEventListener("click", e => {
          e.stopPropagation();
          closeFilePopover();
          void switchFile(file.path);
        });
        container.appendChild(fileBtn);
      }
    };

    for (const proj of projects) {
      const isOpen = isFiltering || expandedKeys.has(proj.key) || projects.length === 1;
      const projWrap = document.createElement("div");
      projWrap.className = "ag-tree-project";

      if (projects.length > 1 || !proj.active) {
        const headerBtn = document.createElement("button");
        headerBtn.type = "button";
        headerBtn.className = `ag-tree-row ag-tree-proj-header ${isOpen ? "is-open" : ""}`;
        headerBtn.innerHTML = `${chevronSvg}${folderSvg}<span class="ag-tree-label"></span>${proj.active ? `<span class="ag-tree-active-badge">${text("当前工作区", "Workspace")}</span>` : ""}<span class="ag-tree-count">${proj.count}</span>`;
        headerBtn.querySelector(".ag-tree-label").textContent = proj.name;
        headerBtn.addEventListener("click", e => {
          e.stopPropagation();
          if (expandedKeys.has(proj.key)) expandedKeys.delete(proj.key);
          else expandedKeys.add(proj.key);
          renderTreeDom();
        });
        projWrap.appendChild(headerBtn);
      } else {
        const topHeader = document.createElement("div");
        topHeader.className = "ag-tree-proj-banner";
        topHeader.innerHTML = `${folderSvg}<span class="ag-tree-label"></span><span class="ag-tree-active-badge">${text("当前工作区", "Workspace")}</span><span class="ag-tree-count">${proj.count}</span>`;
        topHeader.querySelector(".ag-tree-label").textContent = proj.name;
        projWrap.appendChild(topHeader);
      }

      if (isOpen) {
        const body = document.createElement("div");
        body.className = "ag-tree-proj-body";
        renderFolderContents(proj.root, body, projects.length > 1 ? 1 : 0);
        projWrap.appendChild(body);
      }
      fileTreeBodyEl.appendChild(projWrap);
    }
  }

  function closeFilePopover() {
    if (!filePopoverEl || filePopoverEl.hidden) return;
    filePopoverEl.hidden = true;
    if (fileTriggerBtn) fileTriggerBtn.setAttribute("aria-expanded", "false");
  }

  function toggleFilePopover() {
    if (!filePopoverEl) return;
    const nextOpen = filePopoverEl.hidden;
    if (nextOpen) {
      renderTreeDom();
      filePopoverEl.hidden = false;
      if (fileTriggerBtn) fileTriggerBtn.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => {
        const selectedRow = fileTreeBodyEl?.querySelector(".ag-tree-file.is-selected");
        if (selectedRow) selectedRow.scrollIntoView({ block: "nearest" });
        fileSearchInputEl?.focus();
      });
    } else {
      closeFilePopover();
    }
  }

  function renderMdGutterAndBand(scrollOnly = false) {
    if (!mdTextareaEl) return;
    const totalLines = Math.max(1, mdTextareaEl.value.split("\n").length);
    const sLine = Math.max(0, Math.min(activeStartLine, totalLines - 1));
    const eLine = Math.max(sLine, Math.min(activeEndLine, totalLines - 1));
    if (!scrollOnly) {
      if (mdLineBadgeEl) {
        const label = sLine === eLine ? `${sLine + 1}` : `${sLine + 1}–${eLine + 1}`;
        mdLineBadgeEl.textContent = text(`行 ${label}`, `Ln ${label}`);
      }
      if (mdGutterEl) {
        const key = `${totalLines}:${sLine}:${eLine}`;
        if (key !== lastGutterKey) {
          lastGutterKey = key;
          const nums = [];
          for (let i = 0; i < totalLines; i++) {
            const active = i >= sLine && i <= eLine;
            nums.push(`<div class="ag-gutter-ln${active ? " is-active" : ""}">${i + 1}</div>`);
          }
          mdGutterEl.innerHTML = nums.join("");
        }
      }
    }
    if (mdGutterEl) {
      mdGutterEl.scrollTop = mdTextareaEl.scrollTop;
    }
    if (mdBandEl) {
      const lineHeight = 20.8;
      const padTop = 12;
      const top = padTop + sLine * lineHeight - mdTextareaEl.scrollTop;
      const height = Math.max(1, eLine - sLine + 1) * lineHeight;
      mdBandEl.style.transform = `translateY(${top}px)`;
      mdBandEl.style.height = `${height}px`;
    }
  }

  function syncMdPaneContent(md = currentMd, force = false) {
    if (mdTitleEl) {
      const fileName = currentFile ? currentFile.split(/[\\/]/).pop() : "Markdown";
      mdTitleEl.textContent = fileName;
      mdTitleEl.title = currentFile || fileName;
    }
    if (!mdTextareaEl) return;
    if (force || document.activeElement !== mdTextareaEl) {
      const normalized = String(md || "").replace(/\r\n?/g, "\n");
      if (mdTextareaEl.value !== normalized) mdTextareaEl.value = normalized;
    }
    renderMdGutterAndBand();
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
    if (openRawBtn) {
      openRawBtn.textContent = text("原文件", "Raw");
      openRawBtn.title = text("在编辑器中打开 Markdown 原文件（也可关闭原文件仅留导图）", "Open raw Markdown file in editor");
    }
    if (mdCloseBtnEl) {
      mdCloseBtnEl.textContent = text("× 关闭MD", "× Close MD");
    }
    if (fileSearchInputEl) {
      fileSearchInputEl.placeholder = text("搜索项目 Markdown 文件…", "Filter Markdown files…");
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
    cachedFiles = Array.isArray(files) ? files : [];
    if (openRawBtn) openRawBtn.disabled = !selected;
    if (fileTriggerBtn) {
      fileTriggerBtn.disabled = !cachedFiles.length;
      const found = cachedFiles.find(f => f.path === selected) || cachedFiles[0];
      if (!found) {
        if (fileTriggerNameEl) fileTriggerNameEl.textContent = text("未找到 Markdown 文件", "No Markdown files");
        if (fileTriggerDirEl) fileTriggerDirEl.hidden = true;
      } else {
        const { project, rel } = parseFileEntry(found);
        const parts = rel.split("/").filter(Boolean);
        const fileName = parts.pop() || rel;
        const dirHint = parts.length ? `${project}/${parts[parts.length - 1]}` : project;
        if (fileTriggerNameEl) fileTriggerNameEl.textContent = fileName;
        if (fileTriggerDirEl) {
          fileTriggerDirEl.textContent = dirHint;
          fileTriggerDirEl.hidden = false;
        }
        fileTriggerBtn.title = `${project} / ${rel}`;
      }
    }
    if (filePopoverEl && !filePopoverEl.hidden) {
      renderTreeDom();
    }
  }

  async function flushPendingEdits() {
    if (mdEditTimer) {
      clearTimeout(mdEditTimer);
      mdEditTimer = 0;
      await window.inkmap?.load?.(currentMd, true);
    }
    await window.inkmap?.flushSave?.();
  }

  async function switchFile(filePath) {
    if (!filePath || filePath === currentFile) return;
    try {
      await flushPendingEdits();
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
    if (!bar || document.getElementById("ag-file-trigger")) return;

    const style = document.createElement("style");
    style.textContent = `
      html, body { margin: 0; height: 100%; overflow: hidden; background: var(--ink-bg) !important; color: var(--ui-text) !important; }
      #map { position: fixed; inset: 0; width: 100vw; height: 100vh; transition: left .12s ease, width .12s ease; }
      :root.ag-split-active #bar {
        top: 0 !important; left: 0 !important; right: 0 !important;
        min-height: 44px; border-radius: 0 !important;
        border-top: none !important; border-left: none !important; border-right: none !important;
        border-bottom: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)) !important;
        box-shadow: none !important; padding: 4px 10px !important;
        background: var(--ui-solid, #fff) !important;
      }
      :root.ag-split-active #map {
        top: var(--toolbar-height, 44px) !important;
        left: var(--ag-split-left, 42vw) !important;
        width: calc(100vw - var(--ag-split-left, 42vw)) !important;
        height: calc(100vh - var(--toolbar-height, 44px)) !important;
      }
      .ag-file-picker-wrap { position: relative; display: inline-flex; align-items: center; }
      #ag-file-trigger {
        display: inline-flex; align-items: center; gap: 5px; max-width: 210px; height: 28px;
        padding: 0 9px; border-radius: 7px; border: 1px solid var(--ui-border-strong, rgba(31,35,41,.14));
        background: var(--ui-subtle, rgba(31,35,41,.04)); color: var(--ui-text, #1f2329);
        font-size: 12.5px; cursor: pointer; transition: background .12s, border-color .12s;
      }
      #ag-file-trigger:hover:not(:disabled), #ag-file-trigger[aria-expanded="true"] {
        background: var(--ui-hover, rgba(31,35,41,.08));
        border-color: color-mix(in srgb, var(--ui-primary, #336df4) 45%, var(--ui-border-strong, rgba(31,35,41,.2)));
      }
      .ag-trigger-icon { flex: none; color: var(--ui-primary, #336df4); display: inline-flex; }
      .ag-trigger-name {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
      }
      .ag-trigger-dir {
        font-size: 11px; color: var(--ui-muted, #646a73); background: color-mix(in srgb, var(--ui-text, #1f2329) 7%, transparent);
        padding: 1px 5px; border-radius: 4px; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none;
      }
      .ag-trigger-caret { flex: none; opacity: .65; transition: transform .15s ease; }
      #ag-file-trigger[aria-expanded="true"] .ag-trigger-caret { transform: rotate(180deg); }
      #ag-file-tree-popover {
        position: fixed; top: calc(var(--toolbar-height, 40px) + 14px); left: 10px;
        width: min(360px, calc(100vw - 24px)); max-height: min(72vh, 520px); z-index: 120;
        display: flex; flex-direction: column;
        background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.16)); border-radius: 11px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
        overflow: hidden;
      }
      #ag-file-tree-popover[hidden] { display: none !important; }
      .ag-tree-header {
        display: flex; align-items: center; gap: 6px; padding: 8px 10px;
        border-bottom: 1px solid var(--ui-border, rgba(31,35,41,.08));
        background: var(--ui-subtle, #f8f9fb);
      }
      .ag-tree-search-wrap {
        flex: 1; display: flex; align-items: center; gap: 6px;
        background: var(--ui-solid, #fff); border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15));
        border-radius: 6px; padding: 4px 8px;
      }
      .ag-tree-search-wrap:focus-within {
        border-color: var(--ui-primary, #336df4);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary, #336df4) 18%, transparent);
      }
      .ag-tree-search-icon { color: var(--ui-muted, #646a73); flex: none; }
      .ag-tree-search {
        flex: 1; border: 0; outline: none; background: transparent; color: var(--ui-text, #1f2329);
        font-size: 12px; min-width: 0; padding: 0;
      }
      .ag-tree-body {
        flex: 1; overflow-y: auto; padding: 6px 6px 8px;
        scrollbar-width: thin;
      }
      .ag-tree-project + .ag-tree-project {
        margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--ui-border, rgba(31,35,41,.08));
      }
      .ag-tree-proj-banner, .ag-tree-proj-header {
        display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box;
        padding: 5px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 650;
        color: var(--ui-muted, #646a73); letter-spacing: .01em;
      }
      .ag-tree-proj-header {
        border: 0; background: transparent; cursor: pointer; text-align: left;
      }
      .ag-tree-proj-header:hover { background: var(--ui-hover, rgba(31,35,41,.06)); color: var(--ui-text, #1f2329); }
      .ag-tree-active-badge {
        font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 4px;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4);
      }
      .ag-tree-row {
        display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box;
        min-height: 27px; padding: 3px 8px; border: 0; border-radius: 6px;
        background: transparent; color: var(--ui-text, #1f2329); font-size: 12.5px;
        cursor: pointer; text-align: left; transition: background .1s;
      }
      .ag-tree-row:hover { background: var(--ui-hover, rgba(31,35,41,.06)); }
      .ag-tree-folder { font-weight: 550; color: var(--ui-text, #1f2329); }
      .ag-tree-chevron {
        flex: none; color: var(--ui-muted, #646a73); transition: transform .14s ease;
      }
      .ag-tree-folder.is-open > .ag-tree-chevron,
      .ag-tree-proj-header.is-open > .ag-tree-chevron {
        transform: rotate(90deg);
      }
      .ag-tree-icon { flex: none; }
      .ag-icon-folder { color: #e09f3e; }
      :root[data-theme="dark"] .ag-icon-folder { color: #f0b454; }
      .ag-icon-map { color: var(--ui-primary, #336df4); }
      .ag-icon-md { color: var(--ui-muted, #646a73); }
      .ag-tree-label {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ag-tree-count {
        flex: none; font-size: 10.5px; color: var(--ui-muted, #646a73);
        background: color-mix(in srgb, var(--ui-text, #1f2329) 6%, transparent);
        padding: 0 5px; border-radius: 999px; font-weight: 500;
      }
      .ag-tree-Check {
        width: 12px; flex: none; font-size: 11px; font-weight: 700;
        color: var(--ui-primary, #336df4); text-align: center;
      }
      .ag-tree-tag {
        flex: none; font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 4px;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4);
      }
      .ag-tree-file.is-selected {
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4); font-weight: 600;
      }
      .ag-tree-empty {
        padding: 20px 12px; text-align: center; font-size: 12px; color: var(--ui-muted, #646a73);
      }
      #ag-open-raw, #ag-split-md { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
      #ag-split-md[data-active="true"] { background: color-mix(in srgb, var(--ui-primary, #336df4) 14%, transparent); color: var(--ui-primary, #336df4); font-weight: 600; }
      #ag-md-pane {
        position: fixed; top: var(--toolbar-height, 44px); left: 0; bottom: 0;
        width: var(--ag-split-left, 42vw); z-index: 30;
        display: flex; flex-direction: column;
        background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        border-right: 1px solid var(--ui-border-strong, rgba(31,35,41,.16));
        border-radius: 0; box-shadow: none; overflow: hidden;
      }
      #ag-md-pane[hidden] { display: none !important; }
      .ag-md-header {
        display: flex; align-items: center; justify-content: space-between; gap: 6px;
        height: 34px; padding: 0 10px; box-sizing: border-box;
        border-bottom: 1px solid var(--ui-border, rgba(31,35,41,.09));
        background: var(--ui-subtle, #f6f7f9); font-size: 12px; flex: none;
      }
      .ag-md-title {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
      }
      .ag-md-line-badge {
        font-size: 11px; font-weight: 560; font-variant-numeric: tabular-nums;
        padding: 1px 6px; border-radius: 4px;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4); flex: none;
      }
      .ag-md-actions { display: inline-flex; align-items: center; gap: 4px; flex: none; }
      .ag-md-close {
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)); background: var(--ui-solid, #fff);
        color: var(--ui-muted, #646a73); border-radius: 5px; padding: 2px 7px; font-size: 11px; cursor: pointer;
      }
      .ag-md-close:hover { background: var(--ui-hover, rgba(31,35,41,.06)); color: var(--ui-text, #1f2329); }
      .ag-md-body {
        position: relative; flex: 1; display: flex; min-height: 0; overflow: hidden;
        background: var(--ui-solid, #fff);
      }
      #ag-md-gutter {
        width: 38px; flex: none; overflow: hidden; user-select: none;
        padding: 12px 5px 12px 0; box-sizing: border-box; text-align: right;
        background: color-mix(in srgb, var(--ui-subtle, #f6f7f9) 65%, var(--ui-solid, #fff));
        border-right: 1px solid var(--ui-border, rgba(31,35,41,.08));
        font: 11px/20.8px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        color: var(--ui-muted, #646a73); font-variant-numeric: tabular-nums;
      }
      .ag-gutter-ln { height: 20.8px; padding-right: 3px; }
      .ag-gutter-ln.is-active {
        color: var(--ui-primary, #336df4); font-weight: 700;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
      }
      .ag-md-editor-stage {
        position: relative; flex: 1; min-width: 0; height: 100%; overflow: hidden;
      }
      #ag-md-band {
        position: absolute; left: 0; right: 0; top: 0; height: 20.8px; pointer-events: none;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 10%, transparent);
        border-left: 2.5px solid var(--ui-primary, #336df4);
        transition: transform .06s ease-out, height .06s ease-out;
      }
      #ag-md-textarea {
        position: relative; z-index: 1; width: 100%; height: 100%; box-sizing: border-box;
        border: 0; outline: none; resize: none;
        padding: 12px 12px; background: transparent; color: var(--ui-text, #1f2329);
        font: 13px/20.8px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        tab-size: 2; white-space: pre; overflow: auto;
      }
      #ag-md-resizer {
        position: absolute; top: 0; right: 0; bottom: 0; width: 5px; z-index: 5; cursor: col-resize;
        background: transparent; transition: background .12s ease;
      }
      #ag-md-resizer:hover, #ag-md-resizer:active { background: var(--ui-primary, #336df4); }
    `;
    document.head.appendChild(style);

    const pickerWrap = document.createElement("div");
    pickerWrap.className = "ag-file-picker-wrap";

    fileTriggerBtn = document.createElement("button");
    fileTriggerBtn.id = "ag-file-trigger";
    fileTriggerBtn.type = "button";
    fileTriggerBtn.setAttribute("aria-haspopup", "tree");
    fileTriggerBtn.setAttribute("aria-expanded", "false");
    fileTriggerBtn.innerHTML = `
      <span class="ag-trigger-icon"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-5.5A1.75 1.75 0 0 0 14.25 4.5H7.82a.25.25 0 0 1-.177-.073L6.28 3.063A1.75 1.75 0 0 0 5.043 2.5H1.75Z"/></svg></span>
      <span class="ag-trigger-name">Markdown</span>
      <span class="ag-trigger-dir" hidden></span>
      <svg class="ag-trigger-caret" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>
    `;
    fileTriggerNameEl = fileTriggerBtn.querySelector(".ag-trigger-name");
    fileTriggerDirEl = fileTriggerBtn.querySelector(".ag-trigger-dir");
    fileTriggerBtn.addEventListener("click", e => {
      e.stopPropagation();
      toggleFilePopover();
    });

    filePopoverEl = document.createElement("div");
    filePopoverEl.id = "ag-file-tree-popover";
    filePopoverEl.hidden = true;
    filePopoverEl.innerHTML = `
      <div class="ag-tree-header">
        <div class="ag-tree-search-wrap">
          <svg class="ag-tree-search-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14" stroke-linecap="round"/></svg>
          <input type="search" class="ag-tree-search" placeholder="${text("搜索项目 Markdown 文件…", "Filter Markdown files…")}" />
        </div>
      </div>
      <div class="ag-tree-body" role="tree"></div>
    `;
    fileSearchInputEl = filePopoverEl.querySelector(".ag-tree-search");
    fileTreeBodyEl = filePopoverEl.querySelector(".ag-tree-body");
    fileSearchInputEl.addEventListener("input", () => renderTreeDom());
    filePopoverEl.addEventListener("click", e => e.stopPropagation());
    document.body.appendChild(filePopoverEl);

    document.addEventListener("pointerdown", e => {
      if (!filePopoverEl || filePopoverEl.hidden) return;
      if (filePopoverEl.contains(e.target) || fileTriggerBtn.contains(e.target)) return;
      closeFilePopover();
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && filePopoverEl && !filePopoverEl.hidden) {
        closeFilePopover();
      }
    });

    pickerWrap.append(fileTriggerBtn);

    splitMdBtn = document.createElement("button");
    splitMdBtn.id = "ag-split-md";
    splitMdBtn.type = "button";
    splitMdBtn.addEventListener("click", () => {
      splitOpen = !splitOpen;
      if (splitOpen) {
        void apiFetch("/api/telemetry", {
          method: "POST",
          body: JSON.stringify({ event: "split_view" }),
        }).catch(() => {});
      }
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

    bar.prepend(pickerWrap, splitMdBtn, openRawBtn, sep);

    mdPaneEl = document.createElement("aside");
    mdPaneEl.id = "ag-md-pane";
    mdPaneEl.hidden = true;
    mdPaneEl.innerHTML = `
      <div class="ag-md-header">
        <span class="ag-md-title" id="ag-md-title">Markdown</span>
        <span class="ag-md-line-badge" id="ag-md-line-badge">Ln 1</span>
        <div class="ag-md-actions">
          <button type="button" class="ag-md-close" id="ag-md-close"></button>
        </div>
      </div>
      <div class="ag-md-body">
        <div id="ag-md-gutter" aria-hidden="true"></div>
        <div class="ag-md-editor-stage">
          <div id="ag-md-band" aria-hidden="true"></div>
          <textarea id="ag-md-textarea" spellcheck="false"></textarea>
        </div>
      </div>
      <div id="ag-md-resizer" title="拖拽调整分屏宽度"></div>
    `;
    document.body.appendChild(mdPaneEl);
    mdTitleEl = document.getElementById("ag-md-title");
    mdLineBadgeEl = document.getElementById("ag-md-line-badge");
    mdCloseBtnEl = document.getElementById("ag-md-close");
    mdGutterEl = document.getElementById("ag-md-gutter");
    mdBandEl = document.getElementById("ag-md-band");
    mdTextareaEl = document.getElementById("ag-md-textarea");
    if (mdCloseBtnEl) {
      mdCloseBtnEl.textContent = text("× 关闭MD", "× Close MD");
      mdCloseBtnEl.title = text("关闭左侧 Markdown 面板，只保留思维导图", "Close Markdown pane and keep mind map only");
      mdCloseBtnEl.addEventListener("click", () => {
        splitOpen = false;
        applySplitLayout(true);
      });
    }
    if (mdTextareaEl) {
      mdTextareaEl.addEventListener("scroll", () => {
        renderMdGutterAndBand(true);
      });
      const handleCursorMove = () => {
        if (!mdTextareaEl) return;
        const startPos = mdTextareaEl.selectionStart ?? 0;
        const endPos = mdTextareaEl.selectionEnd ?? startPos;
        const startLine = mdTextareaEl.value.slice(0, startPos).split("\n").length - 1;
        const endLine = mdTextareaEl.value.slice(0, endPos).split("\n").length - 1;
        activeStartLine = startLine;
        activeEndLine = Math.max(startLine, endLine);
        renderMdGutterAndBand();
        emitToEditor({ type: "reveal", line: startLine });
      };
      mdTextareaEl.addEventListener("click", handleCursorMove);
      mdTextareaEl.addEventListener("keyup", e => {
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
          handleCursorMove();
        }
      });
      mdTextareaEl.addEventListener("input", () => {
        const nextMd = mdTextareaEl.value;
        currentMd = nextMd;
        const startPos = mdTextareaEl.selectionStart ?? 0;
        const startLine = nextMd.slice(0, startPos).split("\n").length - 1;
        activeStartLine = startLine;
        activeEndLine = startLine;
        renderMdGutterAndBand();
        clearTimeout(mdEditTimer);
        mdEditTimer = window.setTimeout(() => {
          // The edit is being applied now; Cmd+S must not treat it as still pending.
          mdEditTimer = 0;
          if (window.inkmap?.load) {
            void window.inkmap.load(nextMd, true).then(() => {
              emitToEditor({ type: "reveal", line: startLine });
            });
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
  let magicPollInterval = 0;
  let magicPollStop = 0;

  async function refreshLicenseState() {
    const state = await apiFetch("/api/license", { method: "GET" }).catch(() => null);
    if (state) {
      lastLicense = state;
      emitToEditor({ type: "license", state });
    }
    return state;
  }

  function stopTemporaryLicensePoll() {
    clearInterval(magicPollInterval);
    clearTimeout(magicPollStop);
    magicPollInterval = 0;
    magicPollStop = 0;
  }

  /**
   * Polls the license while the user finishes signing in or paying from the email. It runs until Pro is active, for
   * as long as the sidecar checks the email's tokens quickly (30 minutes); a slower check covers later payments.
   */
  function startTemporaryLicensePoll(durationMs = 30 * 60_000) {
    stopTemporaryLicensePoll();
    magicPollInterval = window.setInterval(async () => {
      const state = await refreshLicenseState();
      if (state?.pro) stopTemporaryLicensePoll();
    }, 2500);
    magicPollStop = window.setTimeout(stopTemporaryLicensePoll, durationMs);
  }

  window.addEventListener("focus", () => {
    if (initialDocSent) void refreshLicenseState();
  });
  // A payment made after the quick-poll window still unlocks the open panel.
  setInterval(() => {
    if (initialDocSent && !lastLicense?.pro && !magicPollInterval) void refreshLicenseState();
  }, 20_000);

  function pushDocToEditor(doc, license = lastLicense) {
    if (!doc) return;
    if (license) lastLicense = license;
    syncMdPaneContent(doc.md, true);
    if (!initialDocSent) {
      if (!readyReceived) return;
      initialDocSent = true;
      emitToEditor({
        type: "doc",
        doc,
        license: lastLicense || { pro: false },
        chat: true,
      });
    } else {
      emitToEditor({ type: "change", doc });
    }
  }

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange(async nextUris => {
      workspaceUris = Array.isArray(nextUris) ? nextUris : [];
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
      } catch {}
    });
  }

  // Poll for external file edits or AI tool file switches.
  let polling = false;
  setInterval(async () => {
    if (!initialDocSent || saving || polling) return;
    polling = true;
    const polledFile = currentFile;
    const polledVersion = currentVersion;
    try {
      const res = await apiFetch("/api/poll", {
        method: "POST",
        body: JSON.stringify({
          ...(polledFile && { file: polledFile }),
          ...(polledVersion && { version: polledVersion }),
          targetSeq: String(targetSeq),
          workspaceUris,
        }),
      });
      if (res.targetSeq) targetSeq = res.targetSeq;
      if (saving) return;
      if (res.switchedFile && res.doc) {
        clearTimeout(mdEditTimer);
        mdEditTimer = 0;
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
      } else if (res.changed && res.doc && currentFile === polledFile && currentVersion === polledVersion) {
        if (res.doc.version === currentVersion) return;
        currentVersion = res.doc.version;
        currentMd = res.doc.md;
        pushDocToEditor(res.doc);
      }
    } catch {} finally {
      polling = false;
    }
  }, 1200);

  function sliceLines(md, startLine, endLine, subText) {
    if (subText) return subText;
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    const s = Math.max(0, Math.min(startLine ?? 0, Math.max(0, lines.length - 1)));
    const e = Math.max(s, Math.min(endLine ?? s, Math.max(0, lines.length - 1)));
    return lines.slice(s, e + 1).join("\n");
  }

  window.acquireVsCodeApi = () => ({
    async postMessage(msg) {
      if (!msg || typeof msg !== "object") return;
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
          case "mapMarkdownChange": {
            if (typeof msg.md === "string") {
              currentMd = msg.md;
              syncMdPaneContent(currentMd, false);
            }
            return;
          }
          case "select": {
            activeStartLine = Math.max(0, Number(msg.line) || 0);
            activeEndLine = Math.max(activeStartLine, Number(msg.endLine ?? msg.line) || activeStartLine);
            if (mdTextareaEl && splitOpen) {
              const lines = mdTextareaEl.value.split("\n");
              const last = Math.max(0, lines.length - 1);
              const sLine = Math.max(0, Math.min(activeStartLine, last));
              const eLine = Math.max(sLine, Math.min(activeEndLine, last));
              let startOffset = 0;
              for (let i = 0; i < sLine; i++) startOffset += lines[i].length + 1;
              let endOffset = startOffset;
              for (let i = sLine; i <= eLine; i++) {
                endOffset += lines[i].length + (i < eLine ? 1 : 0);
              }
              const lineHeight = 20.8;
              const padTop = 12;
              const target = Math.max(0, padTop + sLine * lineHeight - mdTextareaEl.clientHeight * 0.35);
              if (document.activeElement === mdTextareaEl) {
                try { mdTextareaEl.setSelectionRange(startOffset, Math.max(startOffset, endOffset)); } catch {}
              }
              mdTextareaEl.scrollTop = target;
              mdTextareaEl.scrollLeft = 0;
              requestAnimationFrame(() => {
                if (!mdTextareaEl?.isConnected) return;
                mdTextareaEl.scrollTop = target;
                mdTextareaEl.scrollLeft = 0;
              });
              renderMdGutterAndBand();
            }
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
          case "openInBrowser": {
            await apiFetch("/api/open-browser", {
              method: "POST",
              body: JSON.stringify({ file: currentFile, workspaceUris }),
            });
            return;
          }
          case "addToChat": {
            if (!currentFile) return;
            const hasRange = msg.startLine !== undefined;
            const sOne = (msg.startLine ?? 0) + 1;
            const eOne = (msg.endLine ?? msg.startLine ?? 0) + 1;
            const snippet = hasRange ? sliceLines(currentMd, msg.startLine, msg.endLine, msg.text) : "";
            if (window.sidecar?.ui?.addArtifactComment && currentFileUri) {
              window.sidecar.ui.addArtifactComment({
                uri: currentFileUri,
                comment: hasRange ? snippet : text(`请结合 ${currentFile} 进行分析`, `Analyze ${currentFile}`),
                ...(hasRange && {
                  selection: {
                    startLine: sOne,
                    endLine: eOne,
                  },
                }),
                pageTitle: currentFile.split(/[\\/]/).pop() || "Inkmap",
              });
            } else if (window.sidecar?.agent?.sendMessage && window.sidecar.conversationId) {
              const prompt = hasRange
                ? text(`来自 \`${currentFile}\`（第 ${sOne}–${eOne} 行）：`, `From \`${currentFile}\` (lines ${sOne}–${eOne}):`) +
                  `\n\`\`\`markdown\n${snippet}\n\`\`\``
                : text(`请结合思维导图文件 \`${currentFile}\` 进行分析。`, `Please use the mind map file \`${currentFile}\` as context.`);
              await window.sidecar.agent.sendMessage(prompt, window.sidecar.conversationId);
            }
            return;
          }
          case "checkout": {
            const locale = osLocale() || undefined;
            const res = await apiFetch("/api/checkout", {
              method: "POST",
              body: JSON.stringify({ mode: "restore", locale }),
            });
            emitToEditor({ type: "checkout", id: msg.id });
            startTemporaryLicensePoll();
            if (res.url && !window.sidecar) window.open(res.url, "_blank", "noopener,noreferrer");
            return;
          }
          case "sendPhoneCode": {
            const locale = osLocale() || undefined;
            const { result } = await apiFetch("/api/phone-send", {
              method: "POST",
              body: JSON.stringify({ phone: msg.phone, locale }),
            });
            emitToEditor({ type: "phoneCodeSent", id: msg.id, result });
            if (result?.ok) startTemporaryLicensePoll();
            return;
          }
          case "signInByPhone": {
            const locale = osLocale() || undefined;
            const { result } = await apiFetch("/api/phone-verify", {
              method: "POST",
              body: JSON.stringify({ phone: msg.phone, code: msg.code, locale }),
            });
            if (result?.ok && result.value) lastLicense = result.value;
            emitToEditor({ type: "phoneSignIn", id: msg.id, result });
            // A verified email without Pro waits for payment in the sidecar; watch for it here too.
            if (!result?.value?.pro) startTemporaryLicensePoll();
            return;
          }
          case "signOut": {
            const { state } = await apiFetch("/api/signout", { method: "POST", body: "{}" });
            if (state) lastLicense = state;
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
          case "telemetry": {
            void apiFetch("/api/telemetry", {
              method: "POST",
              body: JSON.stringify({ event: msg.event }),
            }).catch(() => {});
            return;
          }
        }
      } catch (err) {
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

  // Restore keyboard undo/redo and flush split-pane edits on Cmd+S
  window.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      if (mdEditTimer) {
        e.preventDefault();
        void flushPendingEdits();
        return;
      }
    }
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
