let rawRows = [];       // original rows (array of objects)
let headers = [];       // header names (strings)
let peakIndices = [];   // 0-based indices of detected peaks
let peakRows = [];      // subset of rows at peak indices

// ---------- Helpers ----------
function toFloatArray(rows, colName) {
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

function populateSelect(selectEl, options, selected = null, includeIndexOption = false) {
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
  if (selected && (options.includes(selected) || (includeIndexOption && selected === "__INDEX__"))) {
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

// IQR-based auto-prominence (robust to zeros/outliers)
function percentile(arr, p) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const pos = (a.length - 1) * p;
  const base = Math.floor(pos), rest = pos - base;
  if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
  return a[base];
}
function autoguessProminence(y) {
  const nonzero = y.filter(v => Number.isFinite(v) && v > 0);
  const base = nonzero.length ? nonzero : y.filter(Number.isFinite);
  const q05 = percentile(base, 0.05);
  const q95 = percentile(base, 0.95);
  if (!Number.isFinite(q05) || !Number.isFinite(q95)) return 0;
  return Math.max((q95 - q05) * 0.10, 0); // 10% of dynamic range
}

// Simple local maxima
function localMaxima(y) {
  const out = [];
  for (let i = 1; i < y.length - 1; i++) {
    if (Number.isFinite(y[i]) && y[i] > y[i - 1] && y[i] > y[i + 1]) out.push(i);
  }
  return out;
}

// Simple prominence: height above the higher of the local left/right minima
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

// Enforce minimum distance in rows (greedy by height)
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

// Enforce minimum separation in chosen X units (irregular sampling supported)
function enforceXSeparation(y, candidates, xVals, minSep) {
  if (!xVals || !Number.isFinite(minSep) || minSep <= 0) return candidates.slice();
  const sorted = candidates.slice().sort((a, b) => y[b] - y[a]); // greedily keep tallest
  const kept = [];
  for (const i of sorted) {
    const xi = xVals[i];
    let farEnough = true;
    for (const k of kept) {
      if (Math.abs(xi - xVals[k]) < minSep) { farEnough = false; break; }
    }
    if (farEnough) kept.push(i);
  }
  kept.sort((a, b) => a - b);
  return kept;
}

// Main peak finder
function findPeaksFlexible(y, { prominence = 0, distRows = 1, xVals = null, xMinSep = null, smoothWin = 0 } = {}) {
  const yDet = movingAverage(y, smoothWin);
  let candidates = localMaxima(yDet);

  if (prominence && prominence > 0) {
    candidates = candidates.filter(i => simpleProminence(yDet, i) >= prominence);
  }

  candidates = enforceRowDistance(yDet, candidates, distRows);

  if (xVals && Number.isFinite(xMinSep) && xMinSep > 0) {
    candidates = enforceXSeparation(yDet, candidates, xVals, xMinSep);
  }
  return { peaks: candidates, yDet };
}

// ---------- UI Wiring ----------

// CSV loader
document.getElementById("file").addEventListener("change", (evt) => {
  const file = evt.target.files[0];
  if (!file) return;
  document.getElementById("status").textContent = "Parsing…";

  Papa.parse(file, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: "greedy",
    worker: true,
    complete: (res) => {
      rawRows = res.data;
      headers = res.meta.fields;

      if (!headers || headers.length === 0 || rawRows.length === 0) {
        document.getElementById("status").textContent = "No data found / empty CSV.";
        return;
      }

      const numHdrs = numericHeaders(rawRows, headers);

      // Defaults tuned for Example data.csv
      populateSelect(document.getElementById("peakSourceCol"), numHdrs, numHdrs.includes("Channel 1") ? "Channel 1" : numHdrs[0]);
      populateSelect(document.getElementById("xSepCol"), headers, headers.includes("Timestamp") ? "Timestamp" : headers[0]);
      populateSelect(document.getElementById("qcXCol"), headers, headers.includes("Timestamp") ? "Timestamp" : "__INDEX__", true);
      populateSelect(document.getElementById("xCol"), headers, headers.includes("Timestamp") ? "Timestamp" : headers[0]);
      populateSelect(document.getElementById("yCol"), headers, headers.includes("Channel 1") ? "Channel 1" : headers[Math.min(1, headers.length - 1)]);

      document.getElementById("status").textContent =
        `Loaded ${rawRows.length} rows × ${headers.length} columns.`;

      peakIndices = [];
      peakRows = [];
      document.getElementById("info").textContent = "";
      document.getElementById("scatterInfo").textContent = "";
      Plotly.purge("qcPlot");
      Plotly.purge("scatterPlot");
    },
    error: (err) => {
      document.getElementById("status").textContent = "Error: " + err.message;
    }
  });
});

// Auto-prominence heuristic
document.getElementById("autoProm").addEventListener("click", () => {
  const peakCol = document.getElementById("peakSourceCol").value;
  if (!peakCol || rawRows.length === 0) return;
  const y = toFloatArray(rawRows, peakCol);
  const guess = autoguessProminence(y);
  if (Number.isFinite(guess)) {
    document.getElementById("prom").value = Math.round(guess * 1000) / 1000;
  }
});

// Detect peaks
document.getElementById("run").addEventListener("click", () => {
  if (rawRows.length === 0) return;

  const peakCol = document.getElementById("peakSourceCol").value;
  const prom = parseFloat(document.getElementById("prom").value || "0");
  const distRows = parseInt(document.getElementById("distRows").value || "1", 10);
  const smoothWin = parseInt(document.getElementById("smoothWin").value || "0", 10);

  const xSepCol = document.getElementById("xSepCol").value;
  const xMinSepStr = document.getElementById("xMinSep").value;
  const xMinSep = xMinSepStr === "" ? null : parseFloat(xMinSepStr);

  const y = toFloatArray(rawRows, peakCol);
  const xForSep = xSepCol ? toFloatArray(rawRows, xSepCol) : null;

  const { peaks, yDet } = findPeaksFlexible(y, {
    prominence: Number.isFinite(prom) ? prom : 0,
    distRows: Number.isFinite(distRows) ? distRows : 1,
    xVals: xForSep,
    xMinSep: Number.isFinite(xMinSep) ? xMinSep : null,
    smoothWin: Number.isFinite(smoothWin) ? smoothWin : 0
  });

  peakIndices = peaks;
  peakRows = peakIndices.map(i => rawRows[i]);
  document.getElementById("info").textContent = `Detected ${peakIndices.length} peaks.`;

  // QC plot — show entire signal with peaks overlay
  const qcXCol = document.getElementById("qcXCol").value;
  const X = (qcXCol && qcXCol !== "__INDEX__") ? toFloatArray(rawRows, qcXCol) : Array.from({ length: y.length }, (_, i) => i);

  const traceSignal = {
    x: X, y: y,
    type: "scattergl", mode: "lines",
    name: "Signal", line: { color: "#4a90e2", width: 1.5 }
  };
  const traceSmoothed = {
    x: X, y: yDet,
    type: "scattergl", mode: "lines",
    name: "Smoothed (for detection)", line: { color: "#7b9ab8", width: 1, dash: "dot" },
    visible: smoothWin > 1 ? true : "legendonly"
  };
  const tracePeaks = {
    x: peakIndices.map(i => X[i]),
    y: peakIndices.map(i => y[i]),
    type: "scattergl", mode: "markers",
    name: "Detected peaks", marker: { color: "#e24a4a", size: 8 }
  };

  Plotly.newPlot("qcPlot", [traceSignal, traceSmoothed, tracePeaks], {
    title: `QC: ${qcXCol === "__INDEX__" ? "Index" : qcXCol} vs ${peakCol}`,
    xaxis: { title: qcXCol === "__INDEX__" ? "Index" : qcXCol },
    yaxis: { title: peakCol },
    margin: { t: 40, r: 20, b: 50, l: 60 }
  }, { responsive: true });
});

// Scatter of peak rows
document.getElementById("plotBtn").addEventListener("click", () => {
  if (peakRows.length === 0) return;

  const xCol = document.getElementById("xCol").value;
  const yCol = document.getElementById("yCol").value;
  const x = toFloatArray(peakRows, xCol);
  const y = toFloatArray(peakRows, yCol);

  const text = peakIndices.map(i => `row ${i}`);

  const trace = {
    x, y, text,
    type: "scattergl", mode: "markers",
    marker: { size: 8, color: "#2a6fd5" },
    hovertemplate: `${xCol}: %{x}<br>${yCol}: %{y}<br>%{text}<extra></extra>`
  };

  Plotly.newPlot("scatterPlot", [trace], {
    title: `Peaks: ${xCol} vs ${yCol}`,
    xaxis: { title: xCol },
    yaxis: { title: yCol },
    margin: { t: 40, r: 20, b: 50, l: 60 }
  }, { responsive: true });

  document.getElementById("scatterInfo").textContent = `Plotting ${peakRows.length} peak rows.`;
});

// Download peak rows
document.getElementById("downloadPeaks").addEventListener("click", () => {
  if (peakRows.length === 0) return;
  const hdrs = headers;
  const csv = [hdrs.join(",")]
    .concat(peakRows.map(r => hdrs.map(h => r[h]).join(",")))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "peak_rows.csv";
  a.click();
  URL.revokeObjectURL(url);
});