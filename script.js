// ---------------- State ----------------
let rawRows = [];       // original rows (array of objects)
let headers = [];       // header names
let peakIndices = [];   // 0-based indices of detected peaks
let peakRows = [];      // subset rows at peak indices

// Special "Count" token for axis dropdowns (1D histogram)
const AXIS_COUNT = "__COUNT__";

// Cache for last scatter-density plot (for relayout recompute)
let lastDensityState = null;
let relayoutDebounce = null;

// ---------------- Utilities ----------------
function toFloatArray(rows, colName) {
  if (colName === AXIS_COUNT) return []; // not a data column
  if (colName === "__INDEX__") return Array.from({ length: rows.length }, (_, i) => i);
  return rows.map(r => {
    const v = r[colName];
    const num = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(num) ? num : NaN;
  });
}

function numericHeaders(rows, hdrs, sampleN = 200) {
  const out = [];
  for (const h of hdrs) {
    let ok = true;
    const n = Math.min(rows.length, sampleN);
    for (let i = 0; i < n; i++) {
      const v = rows[i][h];
      if (v === "" || v == null) continue;
      if (!Number.isFinite(+v)) { ok = false; break; }
    }
    if (ok) out.push(h);
  }
  return out;
}

function populateSelect(selectEl, options, selected = null, includeIndexOption = false, includeCountOption = false) {
  selectEl.innerHTML = "";
  if (includeIndexOption) {
    const idxOpt = document.createElement("option");
    idxOpt.value = "__INDEX__";
    idxOpt.textContent = "Index (row #)";
    selectEl.appendChild(idxOpt);
  }
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt;
    el.textContent = opt;
    selectEl.appendChild(el);
  }
  if (includeCountOption) {
    const cntOpt = document.createElement("option");
    cntOpt.value = AXIS_COUNT;
    cntOpt.textContent = "Count (histogram)";
    selectEl.appendChild(cntOpt);
  }
  if (selected && (options.includes(selected) || (includeIndexOption && selected === "__INDEX__") || (includeCountOption && selected === AXIS_COUNT))) {
    selectEl.value = selected;
  }
}

function movingAverage(arr, win) {
  if (!win || win <= 1) return arr.slice();
  if (win % 2 === 0) win += 1; // ensure odd
  const out = new Array(arr.length);
  const half = Math.floor(win / 2);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length && Number.isFinite(arr[j])) { s += arr[j]; c++; }
    }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

// Percentile
function percentile(arr, p) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const pos = (a.length - 1) * p;
  const base = Math.floor(pos), rest = pos - base;
  if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
  return a[base];
}

// Suggested prominence (10% of 5–95% non-zero range)
function autoguessProminenceFrom(y) {
  const nonzero = y.filter(v => Number.isFinite(v) && v > 0);
  const base = nonzero.length ? nonzero : y.filter(Number.isFinite);
  const q05 = percentile(base, 0.05);
  const q95 = percentile(base, 0.95);
  if (!Number.isFinite(q05) || !Number.isFinite(q95)) return 0;
  return Math.max((q95 - q05) * 0.10, 0);
}

// ---------------- Scaling helpers ----------------
function autoCofactor(arr) {
  const finite = arr.filter(Number.isFinite);
  if (!finite.length) return 5;
  const p95 = percentile(finite, 0.95);
  const p05 = percentile(finite, 0.05);
  const dyn = Math.max(p95 - p05, 1);
  return Math.max(dyn * 0.05, 1);
}

function axisConfig(scale, raw, cofactorOpt, labelBase) {
  if (scale === "linear") {
    return {
      axis: { type: "linear", title: labelBase },
      data: raw,
      maskValid: raw.map(v => Number.isFinite(v)),
      transformed: false,
      cofactor: null,
      displayForDensity: raw
    };
  }
  if (scale === "log10") {
    const mask = raw.map(v => Number.isFinite(v) && v > 0);
    const display = raw.map(v => (Number.isFinite(v) && v > 0) ? Math.log10(v) : NaN); // for density
    return {
      axis: { type: "log", title: labelBase, exponentformat: "power" },
      data: raw,
      maskValid: mask,
      transformed: false,
      cofactor: null,
      displayForDensity: display
    };
  }
  // logicle (arcsinh)
  const c = (cofactorOpt && Number.isFinite(+cofactorOpt) && +cofactorOpt > 0)
    ? +cofactorOpt
    : autoCofactor(raw);
  const transformed = raw.map(v => Number.isFinite(v) ? Math.asinh(v / c) : NaN);
  const mask = transformed.map(v => Number.isFinite(v));
  return {
    axis: { type: "linear", title: `${labelBase} [arcsinh(c=${c.toFixed(3)})]` },
    data: transformed,
    maskValid: mask,
    transformed: true,
    cofactor: c,
    displayForDensity: transformed
  };
}

function maskPair(x, y, maskX, maskY) {
  const outX = [], outY = [], idx = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (maskX[i] && maskY[i]) { outX.push(x[i]); outY.push(y[i]); idx.push(i); }
  }
  return { x: outX, y: outY, idx };
}

// ---------------- Rectangular-bin density (fast) ----------------
function densityForPoints(xDisp, yDisp, binsX = 60, binsY = 60) {
  const N = Math.min(xDisp.length, yDisp.length);
  if (!N) return { density: [], maxCount: 0 };
  const xf = xDisp.filter(Number.isFinite);
  const yf = yDisp.filter(Number.isFinite);
  if (!xf.length || !yf.length) return { density: new Array(N).fill(0), maxCount: 0 };

  const xmin = Math.min(...xf), xmax = Math.max(...xf);
  const ymin = Math.min(...yf), ymax = Math.max(...yf);
  const epsx = (xmax - xmin) || 1, epsy = (ymax - ymin) || 1;

  const counts = Array.from({ length: binsX }, () => new Array(binsY).fill(0));
  const binXIdx = new Array(N).fill(-1);
  const binYIdx = new Array(N).fill(-1);

  for (let i = 0; i < N; i++) {
    const xv = xDisp[i], yv = yDisp[i];
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    let bx = Math.floor(((xv - xmin) / epsx) * binsX);
    let by = Math.floor(((yv - ymin) / epsy) * binsY);
    if (bx === binsX) bx = binsX - 1;
    if (by === binsY) by = binsY - 1;
    if (bx >= 0 && bx < binsX && by >= 0 && by < binsY) {
      counts[bx][by] += 1;
      binXIdx[i] = bx; binYIdx[i] = by;
    }
  }

  let maxCount = 0;
  const density = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    const bx = binXIdx[i], by = binYIdx[i];
    if (bx >= 0 && by >= 0) {
      const c = counts[bx][by];
      density[i] = c;
      if (c > maxCount) maxCount = c;
    }
  }
  return { density, maxCount };
}

// ---------------- Auto binning helpers (bins mode) ----------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function finiteStats(arr) {
  const a = arr.filter(Number.isFinite);
  const n = a.length;
  if (!n) return { n: 0, min: NaN, max: NaN, iqr: NaN, sd: NaN, range: NaN };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of a) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  const mean = sum / n;
  let varsum = 0; for (const v of a) varsum += (v - mean) * (v - mean);
  const sd = Math.sqrt(varsum / Math.max(1, n - 1));
  const q1 = percentile(a, 0.25);
  const q3 = percentile(a, 0.75);
  const iqr = (Number.isFinite(q3) && Number.isFinite(q1)) ? (q3 - q1) : NaN;
  return { n, min, max, iqr, sd, range: max - min };
}

function autoBins1D(arr, pixels, { minBins = 12, maxBins = 300, pxPerBin = 3 } = {}) {
  const { n, range, iqr, sd } = finiteStats(arr);
  if (n <= 1 || !Number.isFinite(range) || range <= 0) return minBins;

  // Freedman–Diaconis
  let h = (iqr > 0 && Number.isFinite(iqr)) ? (2 * iqr * Math.pow(n, -1 / 3)) : NaN;

  // Scott fallback
  if (!Number.isFinite(h) || h <= 0) {
    const sdFinite = Number.isFinite(sd) && sd > 0 ? sd : (range / 4);
    h = 3.5 * sdFinite * Math.pow(n, -1 / 3);
  }

  // If still degenerate, use sqrt(n)
  let bins = Number.isFinite(h) && h > 0 ? Math.round(range / h) : Math.round(Math.sqrt(n));

  // Constrain by pixels (~ pxPerBin px/bin) and caps
  const pixelCap = pixels ? Math.floor(pixels / Math.max(1, pxPerBin)) : maxBins;
  bins = clamp(bins, minBins, Math.max(minBins, Math.min(maxBins, pixelCap)));
  return bins;
}

function autoBins2D(xDisp, yDisp, plotDiv, opts = {}) {
  const w = plotDiv?.clientWidth || 800;
  const h = plotDiv?.clientHeight || 500;

  let bx = autoBins1D(xDisp, w, opts);
  let by = autoBins1D(yDisp, h, opts);

  // Keep total cells manageable for speed
  const maxCells = opts.maxCells || 120000;
  let cells = bx * by;
  if (cells > maxCells) {
    const scale = Math.sqrt(maxCells / cells);
    bx = Math.max(8, Math.floor(bx * scale));
    by = Math.max(8, Math.floor(by * scale));
  }
  return { binsX: bx, binsY: by };
}

// ---------------- KDE (radial) density on a grid ----------------
function gaussianKernel1D(sigma) {
  const minSigma = 0.6;
  const s = Math.max(sigma, minSigma);
  const radius = Math.max(1, Math.ceil(3 * s));
  const w = new Array(2 * radius + 1);
  const a = 1 / (Math.sqrt(2 * Math.PI) * s);
  const denom = 2 * s * s;
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const val = a * Math.exp(-(k * k) / denom);
    w[k + radius] = val; sum += val;
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return { w, radius };
}

function gaussianBlur1D(src, width, height, sigma, horizontal = true) {
  const { w, radius } = gaussianKernel1D(sigma);
  const dst = new Float32Array(width * height);

  if (horizontal) {
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(width - 1, Math.max(0, x + k));
          acc += src[rowOff + xx] * w[k + radius];
        }
        dst[rowOff + x] = acc;
      }
    }
  } else {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(height - 1, Math.max(0, y + k));
          acc += src[yy * width + x] * w[k + radius];
        }
        dst[y * width + x] = acc;
      }
    }
  }
  return dst;
}

function kdePointDensity(dispX, dispY, plotDiv, opts = {}) {
  const N = Math.min(dispX.length, dispY.length);
  const xf = dispX.filter(Number.isFinite);
  const yf = dispY.filter(Number.isFinite);
  if (!N || !xf.length || !yf.length) return { density: new Array(N).fill(0), max: 0 };

  const wpx = plotDiv?.clientWidth || 800;
  const hpx = plotDiv?.clientHeight || 500;
  const maxCells = opts.maxCells || 350000;
  let gw = Math.max(128, Math.floor(wpx / 1.7));
  let gh = Math.max(128, Math.floor(hpx / 1.7));
  if (gw * gh > maxCells) {
    const s = Math.sqrt(maxCells / (gw * gh));
    gw = Math.max(96, Math.floor(gw * s));
    gh = Math.max(96, Math.floor(gh * s));
  }

  const xmin = Math.min(...xf), xmax = Math.max(...xf);
  const ymin = Math.min(...yf), ymax = Math.max(...yf);
  const rx = (xmax - xmin) || 1;
  const ry = (ymax - ymin) || 1;

  const grid = new Float32Array(gw * gh);
  const gxArr = new Array(N);
  const gyArr = new Array(N);

  for (let i = 0; i < N; i++) {
    const x = dispX[i], y = dispY[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) { gxArr[i] = -1; gyArr[i] = -1; continue; }
    const gx = (x - xmin) / rx * (gw - 1);
    const gy = (y - ymin) / ry * (gh - 1);
    gxArr[i] = gx; gyArr[i] = gy;

    const ix = Math.floor(gx), iy = Math.floor(gy);
    const wx = gx - ix, wy = gy - iy;

    const w00 = (1 - wx) * (1 - wy);
    const w10 = wx * (1 - wy);
    const w01 = (1 - wx) * wy;
    const w11 = wx * wy;

    const ix1 = Math.min(gw - 1, Math.max(0, ix));
    const iy1 = Math.min(gh - 1, Math.max(0, iy));
    const ix2 = Math.min(gw - 1, ix1 + 1);
    const iy2 = Math.min(gh - 1, iy1 + 1);

    grid[iy1 * gw + ix1] += w00;
    grid[iy1 * gw + ix2] += w10;
    grid[iy2 * gw + ix1] += w01;
    grid[iy2 * gw + ix2] += w11;
  }

  // Bandwidth: Scott's rule in 2D, then to grid units
  const sdx = (() => {
    const a = dispX.filter(Number.isFinite);
    if (!a.length) return 1;
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, a.length - 1)) || ((Math.max(...a) - Math.min(...a)) / 4);
    return sd;
  })();
  const sdy = (() => {
    const a = dispY.filter(Number.isFinite);
    if (!a.length) return 1;
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, a.length - 1)) || ((Math.max(...a) - Math.min(...a)) / 4);
    return sd;
  })();

  const n = xf.length;
  const nFactor = Math.pow(Math.max(2, n), -1/6);
  let sigmaX = (sdx / rx) * (gw - 1) * nFactor;
  let sigmaY = (sdy / ry) * (gh - 1) * nFactor;
  sigmaX = clamp(sigmaX, 0.6, Math.max(1.2, gw / 6));
  sigmaY = clamp(sigmaY, 0.6, Math.max(1.2, gh / 6));

  const blurH = gaussianBlur1D(grid, gw, gh, sigmaX, true);
  const blurHV = gaussianBlur1D(blurH, gw, gh, sigmaY, false);

  const density = new Array(N).fill(0);
  let max = 0;
  for (let i = 0; i < N; i++) {
    const gx = gxArr[i], gy = gyArr[i];
    if (!Number.isFinite(gx) || !Number.isFinite(gy) || gx < 0 || gy < 0) { density[i] = 0; continue; }
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const wx = gx - ix, wy = gy - iy;

    const ix1 = Math.min(gw - 1, Math.max(0, ix));
    const iy1 = Math.min(gh - 1, Math.max(0, iy));
    const ix2 = Math.min(gw - 1, ix1 + 1);
    const iy2 = Math.min(gh - 1, iy1 + 1);

    const g00 = blurHV[iy1 * gw + ix1];
    const g10 = blurHV[iy1 * gw + ix2];
    const g01 = blurHV[iy2 * gw + ix1];
    const g11 = blurHV[iy2 * gw + ix2];

    const val = g00 * (1 - wx) * (1 - wy) + g10 * wx * (1 - wy) + g01 * (1 - wx) * wy + g11 * wx * wy;
    density[i] = val;
    if (val > max) max = val;
  }

  return { density, max };
}

// ---------------- Peak detection ----------------
function localMaxima(y) {
  const out = [];
  for (let i = 1; i < y.length - 1; i++) {
    if (Number.isFinite(y[i]) && y[i] > y[i - 1] && y[i] > y[i + 1]) out.push(i);
  }
  return out;
}

function simpleProminence(y, idx) {
  const n = y.length;
  const yi = y[idx];
  if (!Number.isFinite(yi)) return 0;
  let left = idx - 1, right = idx + 1;
  let leftMin = yi, rightMin = yi;
  while (left > 0 && y[left] <= y[left + 1]) { leftMin = Math.min(leftMin, y[left]); left--; }
  while (right < n - 1 && y[right] <= y[right - 1]) { rightMin = Math.min(rightMin, y[right]); right++; }
  const base = Math.max(leftMin, rightMin);
  return yi - base;
}

function enforceRowDistance(y, candidates, distRows) {
  if (!distRows || distRows <= 1) return candidates.slice();
  const sorted = candidates.slice().sort((a, b) => y[b] - y[a]); // tallest first
  const blocked = new Array(y.length).fill(false);
  const kept = [];
  for (const i of sorted) {
    if (blocked[i]) continue;
    kept.push(i);
    const L = Math.max(0, i - (distRows - 1));
    const R = Math.min(y.length - 1, i + (distRows - 1));
    for (let j = L; j <= R; j++) blocked[j] = true;
  }
  kept.sort((a, b) => a - b);
  return kept;
}

function findPeaksFlexible(y, { prominence = 0, distRows = 1, smoothWin = 0 } = {}) {
  const yDet = movingAverage(y, smoothWin);
  let candidates = localMaxima(yDet);
  if (prominence && prominence > 0) {
    candidates = candidates.filter(i => simpleProminence(yDet, i) >= prominence);
  }
  candidates = enforceRowDistance(yDet, candidates, distRows);
  return { peaks: candidates, yDet };
}

// ---------------- CSV Download (top) ----------------
const downloadBtn = document.getElementById("downloadPeaks");
downloadBtn.addEventListener("click", () => {
  if (peakRows.length === 0) return;
  const hdrs = headers;
  const escapeCSV = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [hdrs.map(escapeCSV).join(",")]
    .concat(peakRows.map(r => hdrs.map(h => escapeCSV(r[h])).join(",")))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "peak_rows.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------- CSV Loader ----------------
document.getElementById("file").addEventListener("change", (evt) => {
  const file = evt.target.files[0];
  if (!file) return;
  document.getElementById("status").textContent = "Parsing…";

  Papa.parse(file, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: "greedy",
    worker: false, // safer on file://
    complete: (res) => {
      rawRows = res.data;
      headers = res.meta.fields || [];

      if (!headers.length || !rawRows.length) {
        document.getElementById("status").textContent = "No data found / empty CSV.";
        return;
      }

      const numHdrs = numericHeaders(rawRows, headers);

      // Defaults: Channel 1 & Timestamp if present
      const peakDefault = numHdrs.includes("Channel 1") ? "Channel 1" : numHdrs[0];
      const timeDefault = headers.includes("Timestamp") ? "Timestamp" : "__INDEX__";

      populateSelect(document.getElementById("peakSourceCol"), numHdrs, peakDefault);
      populateSelect(document.getElementById("qcXCol"), headers, "__INDEX__", true, false);

      // Axes for visualization: include Index and Count
      populateSelect(document.getElementById("xCol"), headers, timeDefault, false, true);
      populateSelect(document.getElementById("yCol"), headers, peakDefault, false, true);

      document.getElementById("status").textContent =
        `Loaded ${rawRows.length} rows × ${headers.length} columns.`;

      peakIndices = [];
      peakRows = [];
      lastDensityState = null;
      document.getElementById("info").textContent = "";
      document.getElementById("scatterInfo").textContent = "";
      Plotly.purge("qcPlot");
      Plotly.purge("scatterPlot");
      downloadBtn.disabled = true;

      refreshPlotBtnVisibility(); // ensure correct visibility after load
    },
    error: (err) => {
      document.getElementById("status").textContent = "Error: " + err.message;
    }
  });
});

// ---------------- Peak controls ----------------
document.getElementById("autoProm").addEventListener("click", () => {
  const peakCol = document.getElementById("peakSourceCol").value;
  if (!peakCol || rawRows.length === 0) return;
  const y = toFloatArray(rawRows, peakCol);
  const guess = autoguessProminenceFrom(y);
  if (Number.isFinite(guess)) {
    document.getElementById("prom").value = Math.round(guess * 1000) / 1000;
  }
});

document.getElementById("run").addEventListener("click", () => {
  if (rawRows.length === 0) {
    document.getElementById("status").textContent = "Please load a CSV first.";
    return;
  }

  const peakCol = document.getElementById("peakSourceCol").value;
  const prom = parseFloat(document.getElementById("prom").value || "0");
  const distRows = parseInt(document.getElementById("distRows").value || "1", 10);
  const smoothWin = parseInt(document.getElementById("smoothWin").value || "0", 10);

  const y = toFloatArray(rawRows, peakCol);
  const { peaks, yDet } = findPeaksFlexible(y, {
    prominence: Number.isFinite(prom) ? prom : 0,
    distRows: Number.isFinite(distRows) ? distRows : 1,
    smoothWin: Number.isFinite(smoothWin) ? smoothWin : 0
  });

  peakIndices = peaks;
  peakRows = peakIndices.map(i => rawRows[i]);
  document.getElementById("info").textContent = `Detected ${peakIndices.length} peaks.`;

  // Enable download
  downloadBtn.disabled = peakRows.length === 0;

  // ---- QC Plot ----
  const qcXCol = document.getElementById("qcXCol").value;
  const qcXRaw = (qcXCol && qcXCol !== "__INDEX__")
    ? toFloatArray(rawRows, qcXCol)
    : Array.from({ length: y.length }, (_, i) => i);

  const qcXScale = document.getElementById("qcXScale").value;
  const qcYScale = document.getElementById("qcYScale").value;
  const qcCofactor = document.getElementById("qcCofactor").value;

  const xCfg = axisConfig(qcXScale, qcXRaw, qcCofactor, qcXCol === "__INDEX__" ? "Index" : qcXCol);
  const yCfg = axisConfig(qcYScale, y,        qcCofactor, peakCol);

  // Build traces with masks
  const mask = yCfg.maskValid.map((m, i) => m && xCfg.maskValid[i]);
  const sig = { x: [], y: [] }, smo = { x: [], y: [] };
  const yDetDisplay = (yCfg.transformed && yCfg.cofactor)
    ? y.map(v => Number.isFinite(v) ? Math.asinh(v / yCfg.cofactor) : NaN)
    : yDet;

  for (let i = 0; i < xCfg.data.length; i++) {
    if (mask[i]) {
      sig.x.push(xCfg.data[i]); sig.y.push(yCfg.data[i]);
      smo.x.push(xCfg.data[i]); smo.y.push(yDetDisplay[i]);
    }
  }

  const peaksX = [], peaksY = [];
  for (const i of peakIndices) {
    if (xCfg.maskValid[i] && yCfg.maskValid[i]) {
      peaksX.push(xCfg.data[i]);
      peaksY.push(yCfg.data[i]);
    }
  }

  const traceSignal = {
    x: sig.x, y: sig.y,
    type: "scattergl", mode: "lines",
    name: "Signal", line: { color: "#4a90e2", width: 1.4 }
  };
  const traceSmoothed = {
    x: smo.x, y: smo.y,
    type: "scattergl", mode: "lines",
    name: "Smoothed (for detection)", line: { color: "#7b9ab8", width: 1, dash: "dot" },
    visible: smoothWin > 1 ? true : "legendonly"
  };
  const tracePeaks = {
    x: peaksX, y: peaksY,
    type: "scattergl", mode: "markers",
    name: "Detected peaks", marker: { color: "#e24a4a", size: 8 }
  };

  Plotly.newPlot("qcPlot", [traceSignal, traceSmoothed, tracePeaks], {
    title: `QC: ${xCfg.axis.title} vs ${yCfg.axis.title}`,
    xaxis: xCfg.axis,
    yaxis: yCfg.axis,
    margin: { t: 40, r: 20, b: 50, l: 60 }
  }, { responsive: true });

  // Auto-plot peak rows if non-KDE density or scatter
  if (peakRows.length > 0 && shouldAutoUpdate()) updatePlot();
});

// ---------------- Mode/Method helpers ----------------
function isKDEActive() {
  const mode = document.querySelector("input[name='mode']:checked")?.value;
  const method = document.getElementById("densityMethod")?.value;
  return mode === "scatter-density" && method === "kde";
}
function shouldAutoUpdate() {
  // Auto-update for everything EXCEPT KDE heatmap
  return !isKDEActive();
}
function refreshPlotBtnVisibility() {
  const btn = document.getElementById("plotBtn");
  const hint = document.getElementById("scatterInfo");
  if (!btn) return;
  if (isKDEActive()) {
    btn.style.display = "";
    if (hint) hint.textContent = "KDE heatmap selected — click “Plot Peak Rows” to update.";
  } else {
    btn.style.display = "none";
  }
}

// ---------------- Auto-update wiring (Option C) ----------------
function updatePlot() {
  // Delegate to existing handler by dispatching a click
  const evt = new Event('click');
  document.getElementById("plotBtn").dispatchEvent(evt);
}

const autoUpdateIds = [
  "xCol","yCol","xScale","yScale","cofactor",
  "markerSize","markerAlpha","colorscale","densityMethod"
];
autoUpdateIds.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    refreshPlotBtnVisibility();
    if (peakRows.length === 0) return;
    if (shouldAutoUpdate()) updatePlot();
    // If KDE is active, do nothing (requires manual click)
  });
});

// Render mode radios (scatter / scatter-density)
document.querySelectorAll("input[name='mode']").forEach(r => {
  r.addEventListener("change", () => {
    refreshPlotBtnVisibility();
    if (peakRows.length === 0) return;
    if (shouldAutoUpdate()) updatePlot();
  });
});

// ---------------- Plot peak rows (Scatter / Scatter-density / Histogram) ----------------
document.getElementById("plotBtn").addEventListener("click", () => {
  if (peakRows.length === 0) {
    document.getElementById("scatterInfo").textContent = "No peaks yet. Click Detect Peaks first.";
    return;
  }

  const xCol = document.getElementById("xCol").value;
  const yCol = document.getElementById("yCol").value;

  // If exactly one axis is "Count", render a 1D histogram
  if ((xCol === AXIS_COUNT) ^ (yCol === AXIS_COUNT)) {
    renderHistogram(xCol, yCol);
    return;
  }

  const xRaw = toFloatArray(peakRows, xCol);
  const yRaw = toFloatArray(peakRows, yCol);

  const xScale = document.getElementById("xScale").value;
  const yScale = document.getElementById("yScale").value;
  const cofactor = document.getElementById("cofactor").value;

  const xCfg = axisConfig(xScale, xRaw, cofactor, xCol);
  const yCfg = axisConfig(yScale, yRaw, cofactor, yCol);

  const mode = document.querySelector("input[name='mode']:checked").value;

  if (mode === "scatter") {
    const { x, y } = maskPair(xCfg.data, yCfg.data, xCfg.maskValid, yCfg.maskValid);

    const size  = Math.max(2, Math.min(20, parseInt(document.getElementById("markerSize").value || "7", 10)));
    const alpha = Math.max(0.05, Math.min(1, parseFloat(document.getElementById("markerAlpha").value || "0.9")));

    const trace = {
      x, y,
      type: "scattergl", mode: "markers",
      marker: { size, color: "#2a6fd5", opacity: alpha },
      hovertemplate: `${xCol}: %{x}<br>${yCol}: %{y}<extra></extra>`
    };

    Plotly.newPlot("scatterPlot", [trace], {
      title: `Peaks Scatter: ${xCfg.axis.title} vs ${yCfg.axis.title}`,
      xaxis: xCfg.axis, yaxis: yCfg.axis,
      margin: { t: 40, r: 20, b: 50, l: 60 }
    }, { responsive: true });

    lastDensityState = null;
    document.getElementById("scatterInfo").textContent = `Plotted ${x.length} points.`;

  } else {
    renderScatterDensity(xCfg, yCfg, xCol, yCol);
  }
});

// ---------------- Scatter-density renderer + zoom-aware recompute ----------------
function renderScatterDensity(xCfg, yCfg, xCol, yCol) {
  const colorscale = document.getElementById("colorscale").value;
  const densityMethod = document.getElementById("densityMethod")?.value || "kde";

  const { x: X, y: Y, idx } = maskPair(xCfg.data, yCfg.data, xCfg.maskValid, yCfg.maskValid);
  const dispX = idx.map(i => xCfg.displayForDensity[i]);
  const dispY = idx.map(i => yCfg.displayForDensity[i]);

  const plotDiv = document.getElementById("scatterPlot");

  let density = [], maxVal = 0, binsX = 0, binsY = 0;
  if (densityMethod === "bins") {
    const ab = autoBins2D(dispX, dispY, plotDiv, {
      minBins: 12, maxBins: 300, pxPerBin: 3, maxCells: 120000
    });
    binsX = ab.binsX; binsY = ab.binsY;
    const res = densityForPoints(dispX, dispY, binsX, binsY);
    density = res.density; maxVal = res.maxCount;
  } else {
    const res = kdePointDensity(dispX, dispY, plotDiv, { maxCells: 350000 });
    density = res.density; maxVal = res.max;
  }

  const size  = Math.max(2, Math.min(20, parseInt(document.getElementById("markerSize").value || "7", 10)));
  const alpha = Math.max(0.05, Math.min(1, parseFloat(document.getElementById("markerAlpha").value || "0.9")));
  const colorbarTitle = (densityMethod === "bins") ? "count" : "density";

  const trace = {
    x: X, y: Y,
    type: "scattergl", mode: "markers",
    marker: {
      size,
      opacity: alpha,
      color: density,
      colorscale: colorscale,
      colorbar: { title: colorbarTitle },
      showscale: true
    },
    hovertemplate: (densityMethod === "bins")
      ? `${xCol}: %{x}<br>${yCol}: %{y}<br>count: %{marker.color}<extra></extra>`
      : `${xCol}: %{x}<br>${yCol}: %{y}<br>density: %{marker.color:.4f}<extra></extra>`
  };

  const layout = {
    title: (densityMethod === "bins")
      ? `Peaks Scatter (density colors, bins ${binsX}×${binsY})`
      : `Peaks Scatter (density colors, radial KDE)`,
    xaxis: xCfg.axis, yaxis: yCfg.axis,
    margin: { t: 40, r: 20, b: 50, l: 60 }
  };

  Plotly.newPlot("scatterPlot", [trace], layout, { responsive: true }).then((gd) => {
    lastDensityState = {
      gd, xCol, yCol, colorscale,
      xCfg, yCfg, X, Y, dispX, dispY,
      densityMethod
    };

    const infoTail = (densityMethod === "bins")
      ? `max bin count ${maxVal}, ${binsX}×${binsY} auto-bins`
      : `max density ${maxVal.toFixed(4)}, KDE grid auto-sized`;
    document.getElementById("scatterInfo").textContent =
      `Plotted ${X.length} points; ${infoTail}.` + (densityMethod === "kde" ? " (KDE updates on click only)" : " (Auto-updates on zoom/pan)");

    // Attach relayout listener once; debounce for performance
    if (!gd._hasDensityRelayout) {
      gd._hasDensityRelayout = true;
      gd.on('plotly_relayout', () => {
        if (relayoutDebounce) clearTimeout(relayoutDebounce);
        relayoutDebounce = setTimeout(() => {
          relayoutDebounce = null;
          recomputeDensityForCurrentView();
        }, 80);
      });
    }
  });
}

function recomputeDensityForCurrentView() {
  if (!lastDensityState) return;

  const { gd, xCfg, yCfg, dispX, dispY, colorscale, xCol, yCol, densityMethod } = lastDensityState;

  // Only update auto on bins; KDE is click-only (Option C)
  const mode = document.querySelector("input[name='mode']:checked")?.value;
  if (mode !== "scatter-density" || densityMethod !== "bins") return;

  const xl = gd._fullLayout?.xaxis;
  const yl = gd._fullLayout?.yaxis;
  if (!xl || !yl) return;

  let xr = xl.range || [Math.min(...dispX.filter(Number.isFinite)), Math.max(...dispX.filter(Number.isFinite))];
  let yr = yl.range || [Math.min(...dispY.filter(Number.isFinite)), Math.max(...dispY.filter(Number.isFinite))];

  const xmin = Math.min(xr[0], xr[1]);
  const xmax = Math.max(xr[0], xr[1]);
  const ymin = Math.min(yr[0], yr[1]);
  const ymax = Math.max(yr[0], yr[1]);

  const visIdx = [];
  for (let i = 0; i < dispX.length; i++) {
    const dx = dispX[i], dy = dispY[i];
    if (Number.isFinite(dx) && Number.isFinite(dy) && dx >= xmin && dx <= xmax && dy >= ymin && dy <= ymax) {
      visIdx.push(i);
    }
  }

  let newColors = new Array(dispX.length).fill(0);
  let binsX = 12, binsY = 12, maxCount = 0, info = "";

  if (visIdx.length > 0) {
    const dxv = visIdx.map(i => dispX[i]);
    const dyv = visIdx.map(i => dispY[i]);
    const ab = autoBins2D(dxv, dyv, gd, { minBins: 12, maxBins: 300, pxPerBin: 3, maxCells: 120000 });
    binsX = ab.binsX; binsY = ab.binsY;
    const { density, maxCount: mc } = densityForPoints(dxv, dyv, binsX, binsY);
    maxCount = mc;
    for (let j = 0; j < visIdx.length; j++) newColors[visIdx[j]] = density[j];
    info = `Zoomed view: ${visIdx.length} points, ${binsX}×${binsY} auto-bins (max ${maxCount}).`;
  } else {
    info = "No points in view.";
  }

  Plotly.restyle(gd, {
    'marker.color': [newColors],
    'marker.colorscale': [colorscale]
  }, [0]).then(() => {
    document.getElementById("scatterInfo").textContent = info;
  });
}

// ---------------- Histogram renderer ----------------
function renderHistogram(xCol, yCol) {
  const xScale = document.getElementById("xScale").value;
  const yScale = document.getElementById("yScale").value;
  const cofactor = document.getElementById("cofactor").value;

  let trace, layout;

  if (yCol === AXIS_COUNT) {
    const xRaw = toFloatArray(peakRows, xCol);
    const xCfg = axisConfig(xScale, xRaw, cofactor, xCol);

    trace = {
      type: "histogram",
      x: xCfg.transformed ? xCfg.data : xRaw,
      marker: { color: "#2a6fd5" },
      opacity: 0.85
    };

    layout = {
      title: `Histogram: ${xCfg.axis.title} vs Count`,
      xaxis: xCfg.axis,
      yaxis: { title: "Count (bins)", type: "linear" },
      bargap: 0.03,
      margin: { t: 40, r: 20, b: 50, l: 60 }
    };

  } else {
    const yRaw = toFloatArray(peakRows, yCol);
    const yCfg = axisConfig(yScale, yRaw, cofactor, yCol);

    trace = {
      type: "histogram",
      y: yCfg.transformed ? yCfg.data : yRaw,
      marker: { color: "#2a6fd5" },
      opacity: 0.85,
      orientation: "h"
    };

    layout = {
      title: `Histogram: Count vs ${yCfg.axis.title}`,
      xaxis: { title: "Count (bins)", type: "linear" },
      yaxis: yCfg.axis,
      bargap: 0.03,
      margin: { t: 40, r: 20, b: 50, l: 70 }
    };
  }

  Plotly.newPlot("scatterPlot", [trace], layout, { responsive: true });
  lastDensityState = null;
  document.getElementById("scatterInfo").textContent = "Histogram rendered (auto bins).";
}

// Ensure correct Plot button visibility at startup
refreshPlotBtnVisibility();