/* Photomosaic — client-side mosaic generator.
   Everything runs in the browser; no uploads, no server. */
(() => {
  "use strict";

  // ---- element refs ----
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");
  const canvasWrap = $("canvasWrap");
  const placeholder = $("placeholder");
  const stageMeta = $("stageMeta");

  const targetInput = $("targetInput");
  const tilesInput = $("tilesInput");
  const folderInput = $("folderInput");

  const tileCountEl = $("tileCount");
  const progress = $("progress");
  const progressBar = $("progressBar");
  const progressLabel = $("progressLabel");

  const generateBtn = $("generateBtn");
  const downloadBtn = $("downloadBtn");

  const controls = {
    cols: $("cols"), rows: $("rows"), cell: $("cell"),
    blend: $("blend"), repeat: $("repeat"),
  };
  const outs = {
    cols: $("colsOut"), rows: $("rowsOut"), cell: $("cellOut"),
    blend: $("blendOut"), repeat: $("repeatOut"),
  };

  // ---- state ----
  let targetBitmap = null;          // ImageBitmap of the source picture
  let tiles = [];                   // [{ id, bitmap, rgb:[r,g,b], uses }]
  let mosaicCanvas = null;          // full-resolution output
  let activeView = "target";
  let busy = false;

  // reusable offscreen canvas for averaging tile colours
  const avgCanvas = document.createElement("canvas");
  avgCanvas.width = avgCanvas.height = 8;
  const avgCtx = avgCanvas.getContext("2d", { willReadFrequently: true });

  // ============================================================
  // Tile + target loading
  // ============================================================

  async function loadTarget(file) {
    try {
      const bmp = await createImageBitmap(file);
      targetBitmap?.close?.();
      targetBitmap = bmp;
      activeView = "target";
      setSeg("target");
      render();
      refresh();
    } catch {
      flashHint("That image couldn't be opened. Try a JPEG or PNG.");
    }
  }

  async function addTiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;

    showProgress(true);
    let done = 0;
    const batch = 8; // decode a few at a time
    for (let i = 0; i < files.length; i += batch) {
      const slice = files.slice(i, i + batch);
      const loaded = await Promise.all(slice.map(decodeTile));
      for (const t of loaded) if (t) tiles.push(t);
      done += slice.length;
      setProgress(done / files.length, `${done}/${files.length}`);
    }
    showProgress(false);
    tileCountEl.textContent = String(tiles.length);
    refresh();
  }

  async function decodeTile(file) {
    try {
      const bitmap = await createImageBitmap(file);
      return { id: file.name, bitmap, rgb: averageColor(bitmap), uses: 0 };
    } catch {
      return null;
    }
  }

  /** Average colour of an image, via an 8×8 downscale. */
  function averageColor(src) {
    avgCtx.clearRect(0, 0, 8, 8);
    avgCtx.drawImage(src, 0, 0, 8, 8);
    const d = avgCtx.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    return [r / n, g / n, b / n];
  }

  // ============================================================
  // Mosaic engine
  // ============================================================

  /** Redmean-weighted squared colour distance — cheap perceptual approximation. */
  function distanceSq(a, b) {
    const rm = (a[0] + b[0]) / 2;
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
  }

  function nearestTile(rgb, penalty) {
    let best = tiles[0], bestScore = Infinity;
    for (const t of tiles) {
      const score = distanceSq(rgb, t.rgb) + t.uses * penalty;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    best.uses++;
    return best;
  }

  async function generate() {
    if (busy || !targetBitmap || !tiles.length) return;
    busy = true;
    setControlsEnabled(false);

    const cols = +controls.cols.value;
    const rows = +controls.rows.value;
    const cell = +controls.cell.value;
    const blend = +controls.blend.value / 100;
    const penalty = +controls.repeat.value;

    const outW = cols * cell, outH = rows * cell;

    // One pixel per cell = that cell's average colour.
    const small = document.createElement("canvas");
    small.width = cols; small.height = rows;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(targetBitmap, 0, 0, cols, rows);
    const cellData = sctx.getImageData(0, 0, cols, rows).data;

    const out = document.createElement("canvas");
    out.width = outW; out.height = outH;
    const octx = out.getContext("2d");
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";

    for (const t of tiles) t.uses = 0;

    showProgress(true);
    for (let ry = 0; ry < rows; ry++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = (ry * cols + cx) * 4;
        const rgb = [cellData[i], cellData[i + 1], cellData[i + 2]];
        const tile = nearestTile(rgb, penalty);
        const px = cx * cell, py = ry * cell;
        octx.drawImage(tile.bitmap, px, py, cell, cell);
        if (blend > 0) {
          octx.fillStyle = `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${blend})`;
          octx.fillRect(px, py, cell, cell);
        }
      }
      setProgress((ry + 1) / rows, `${Math.round(((ry + 1) / rows) * 100)}%`);
      await raf(); // keep the UI responsive
    }
    showProgress(false);

    mosaicCanvas = out;
    activeView = "mosaic";
    setSeg("mosaic");
    render();
    refresh();
    busy = false;
    setControlsEnabled(true);
  }

  // ============================================================
  // Rendering
  // ============================================================

  function render() {
    const cw = canvasWrap.clientWidth, ch = canvasWrap.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = cw * dpr; canvas.height = ch * dpr;
    canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const src = activeView === "mosaic" ? mosaicCanvas : targetBitmap;
    updatePlaceholder(src);
    updateMeta();
    if (!src) return;

    const scale = Math.min(cw / src.width, ch / src.height);
    const dw = src.width * scale, dh = src.height * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }

  function updatePlaceholder(src) {
    const has = !!src;
    placeholder.classList.toggle("is-hidden", has);
    if (!has) {
      const title = placeholder.querySelector(".placeholder__title");
      const sub = placeholder.querySelector(".placeholder__sub");
      if (activeView === "mosaic" && targetBitmap) {
        title.textContent = "Ready when you are";
        sub.textContent = "Add some tile photos, then hit Generate mosaic.";
      } else {
        title.textContent = "Start with a target image";
        sub.textContent = "Then add the photos to build it from — or drop an image here.";
      }
    }
  }

  function updateMeta() {
    if (activeView === "mosaic" && mosaicCanvas) {
      stageMeta.textContent = `${mosaicCanvas.width}×${mosaicCanvas.height}px · ${tiles.length} tiles`;
    } else if (activeView === "target" && targetBitmap) {
      stageMeta.textContent = `${targetBitmap.width}×${targetBitmap.height}px`;
    } else {
      stageMeta.textContent = "";
    }
  }

  // ============================================================
  // UI plumbing
  // ============================================================

  function refresh() {
    generateBtn.disabled = busy || !targetBitmap || !tiles.length;
    downloadBtn.disabled = !mosaicCanvas;
  }

  function setControlsEnabled(on) {
    Object.values(controls).forEach((c) => (c.disabled = !on));
    generateBtn.disabled = !on || !targetBitmap || !tiles.length;
  }

  function setSeg(view) {
    document.querySelectorAll(".seg").forEach((s) =>
      s.classList.toggle("is-active", s.dataset.view === view));
  }

  function showProgress(on) {
    progress.hidden = !on;
    if (!on) setProgress(0, "");
  }
  function setProgress(p, label) {
    progressBar.style.setProperty("--p", `${Math.round(p * 100)}%`);
    progressLabel.textContent = label;
  }

  function flashHint(msg) {
    stageMeta.textContent = msg;
  }

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  function download() {
    if (!mosaicCanvas) return;
    mosaicCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mosaic.png";
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  // ---- events ----
  $("targetBtn").addEventListener("click", () => targetInput.click());
  $("tilesBtn").addEventListener("click", () => tilesInput.click());
  $("folderBtn").addEventListener("click", () => folderInput.click());

  targetInput.addEventListener("change", (e) => { if (e.target.files[0]) loadTarget(e.target.files[0]); });
  tilesInput.addEventListener("change", (e) => addTiles(e.target.files));
  folderInput.addEventListener("change", (e) => addTiles(e.target.files));

  generateBtn.addEventListener("click", generate);
  downloadBtn.addEventListener("click", download);

  document.querySelectorAll(".seg").forEach((s) =>
    s.addEventListener("click", () => { activeView = s.dataset.view; setSeg(activeView); render(); }));

  // live range readouts
  const fmt = {
    cols: (v) => v, rows: (v) => v,
    cell: (v) => `${v}\u00A0px`, blend: (v) => `${v}%`, repeat: (v) => v,
  };
  for (const key of Object.keys(controls)) {
    const sync = () => (outs[key].innerHTML = fmt[key](controls[key].value));
    controls[key].addEventListener("input", sync);
    sync();
  }

  // drag & drop a target image onto the stage
  ["dragenter", "dragover"].forEach((t) =>
    canvasWrap.addEventListener(t, (e) => { e.preventDefault(); canvasWrap.classList.add("is-drop"); }));
  ["dragleave", "drop"].forEach((t) =>
    canvasWrap.addEventListener(t, (e) => { e.preventDefault(); canvasWrap.classList.remove("is-drop"); }));
  canvasWrap.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith("image/")) loadTarget(f);
  });

  // re-render on resize
  let resizeRaf;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(render);
  });

  // ---- PWA: install prompt + service worker ----
  let deferredPrompt = null;
  const installBtn = $("installBtn");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => { installBtn.hidden = true; });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  // first paint
  render();
})();
