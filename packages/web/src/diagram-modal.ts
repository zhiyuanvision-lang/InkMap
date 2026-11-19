import { $ } from "./dom";

/** The 20px padding on every side of `#diagram-modal-img`. */
const DIAGRAM_MODAL_PAD = 40;

/**
 * The full-window viewer for a rendered Mermaid diagram (`#diagram-modal` in index.html): zoom with its buttons, the
 * wheel or +/−, pan by dragging or with the arrow keys, fit with F or 1, reset with 0 and close with Esc.
 */
export function createDiagramModal() {
  const diagramModal = $("#diagram-modal");
  const diagramStage = $<HTMLDivElement>("#diagram-modal-stage");
  const diagramWorld = $<HTMLDivElement>("#diagram-modal-world");
  const diagramModalImg = $<HTMLImageElement>("#diagram-modal-img");
  const diagramZoomLevel = $("#diagram-zoom-level");
  let diagramBaseWidth = 0;
  let diagramBaseHeight = 0;
  let diagramScale = 1;
  let diagramTx = 0;
  let diagramTy = 0;
  let diagramPanning: { pointerId: number; x: number; y: number; tx: number; ty: number } | null = null;

  function clampDiagramScale(next: number) {
    return Math.max(0.15, Math.min(8, next));
  }
  function applyDiagramView() {
    // tx/ty are the offset of the padded image card center from the stage center.
    const ox = diagramTx - ((diagramBaseWidth + DIAGRAM_MODAL_PAD) * diagramScale) / 2;
    const oy = diagramTy - ((diagramBaseHeight + DIAGRAM_MODAL_PAD) * diagramScale) / 2;
    diagramWorld.style.transform = `translate(${ox}px, ${oy}px) scale(${diagramScale})`;
    diagramZoomLevel.textContent = `${Math.round(diagramScale * 100)}%`;
  }
  function stagePoint(clientX: number, clientY: number) {
    const rect = diagramStage.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }
  function zoomDiagramAt(clientX: number, clientY: number, nextScale: number) {
    const { x, y } = stagePoint(clientX, clientY);
    const scale = clampDiagramScale(nextScale);
    const k = scale / diagramScale;
    diagramTx = x - (x - diagramTx) * k;
    diagramTy = y - (y - diagramTy) * k;
    diagramScale = scale;
    applyDiagramView();
  }
  function zoomDiagramBy(factor: number, clientX?: number, clientY?: number) {
    const rect = diagramStage.getBoundingClientRect();
    zoomDiagramAt(
      clientX ?? rect.left + rect.width / 2,
      clientY ?? rect.top + rect.height / 2,
      diagramScale * factor,
    );
  }
  function fitDiagramModal() {
    const rect = diagramStage.getBoundingClientRect();
    const pad = 48;
    const stageW = Math.max(120, rect.width - pad);
    const stageH = Math.max(120, rect.height - pad);
    diagramScale = clampDiagramScale(
      Math.min(1, stageW / (diagramBaseWidth + DIAGRAM_MODAL_PAD), stageH / (diagramBaseHeight + DIAGRAM_MODAL_PAD)),
    );
    diagramTx = 0;
    diagramTy = 0;
    applyDiagramView();
  }
  function resetDiagramModal() {
    diagramScale = 1;
    diagramTx = 0;
    diagramTy = 0;
    applyDiagramView();
  }
  function openDiagramModal(img: HTMLImageElement) {
    diagramBaseWidth = Number(img.dataset.naturalWidth) || img.naturalWidth || img.width || 600;
    diagramBaseHeight = Number(img.dataset.naturalHeight) || img.naturalHeight || img.height || 400;
    diagramModalImg.src = img.src;
    diagramModalImg.style.width = `${diagramBaseWidth}px`;
    diagramModalImg.style.height = `${diagramBaseHeight}px`;
    diagramModal.hidden = false;
    diagramStage.focus({ preventScroll: true });
    requestAnimationFrame(fitDiagramModal);
  }
  const closeDiagramModal = () => {
    diagramPanning = null;
    diagramStage.classList.remove("is-panning");
    diagramModal.hidden = true;
    try { document.body.focus({ preventScroll: true }); } catch {}
  };
  $("#diagram-zoom-in").addEventListener("click", () => zoomDiagramBy(1.25));
  $("#diagram-zoom-out").addEventListener("click", () => zoomDiagramBy(1 / 1.25));
  $("#diagram-zoom-fit").addEventListener("click", fitDiagramModal);
  $("#diagram-zoom-reset").addEventListener("click", resetDiagramModal);
  $("#diagram-modal-close").addEventListener("click", closeDiagramModal);
  diagramStage.addEventListener("wheel", e => {
    if (diagramModal.hidden) return;
    e.preventDefault();
    // Trackpad pinch / ctrl+wheel → zoom toward cursor; two-finger scroll → pan
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.01);
      zoomDiagramAt(e.clientX, e.clientY, diagramScale * factor);
      return;
    }
    const line = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? diagramStage.clientHeight : 1;
    diagramTx -= e.deltaX * line;
    diagramTy -= e.deltaY * line;
    applyDiagramView();
  }, { passive: false });
  diagramStage.addEventListener("pointerdown", e => {
    if (e.button !== 0 && e.button !== 1) return;
    diagramPanning = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, tx: diagramTx, ty: diagramTy };
    diagramStage.classList.add("is-panning");
    diagramStage.setPointerCapture(e.pointerId);
  });
  diagramStage.addEventListener("pointermove", e => {
    if (!diagramPanning || e.pointerId !== diagramPanning.pointerId) return;
    diagramTx = diagramPanning.tx + (e.clientX - diagramPanning.x);
    diagramTy = diagramPanning.ty + (e.clientY - diagramPanning.y);
    applyDiagramView();
  });
  const endDiagramPan = (e: PointerEvent) => {
    if (!diagramPanning || e.pointerId !== diagramPanning.pointerId) return;
    diagramPanning = null;
    diagramStage.classList.remove("is-panning");
  };
  diagramStage.addEventListener("pointerup", endDiagramPan);
  diagramStage.addEventListener("pointercancel", endDiagramPan);
  diagramStage.addEventListener("dblclick", e => {
    if ((e.target as HTMLElement).closest(".diagram-modal-bar")) return;
    zoomDiagramBy(diagramScale >= 2.5 ? 1 / diagramScale : 1.6, e.clientX, e.clientY);
  });
  window.addEventListener("keydown", e => {
    if (diagramModal.hidden || !$("#upgrade").hidden || document.documentElement.classList.contains("trial-expired")) return;
    const pan = (dx: number, dy: number) => { diagramTx += dx; diagramTy += dy; applyDiagramView(); };
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDiagramModal(); return; }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); e.stopPropagation(); zoomDiagramBy(1.25); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); e.stopPropagation(); zoomDiagramBy(1 / 1.25); }
    else if (e.key === "0") { e.preventDefault(); e.stopPropagation(); resetDiagramModal(); }
    else if (e.key === "1" || e.key === "f" || e.key === "F") { e.preventDefault(); e.stopPropagation(); fitDiagramModal(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); pan(48, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); pan(-48, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); pan(0, 48); }
    else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); pan(0, -48); }
  }, true);

  return {
    open: openDiagramModal,
    close: closeDiagramModal,
    isOpen: () => !diagramModal.hidden,
  };
}
