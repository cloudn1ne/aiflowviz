/**
 * Frontend: drives the ApexSankey chart from the LiteLLM spend-logs API
 * (via the local backend proxy in server.js).
 *
 * The timeframe preset selects the window; every change refetches /api/sankey
 * and calls sankey.update() — so the chart springs/morphs to the new window.
 * Optional auto-refresh reloads the chart at a preset interval.
 *
 * Flow rendered:  client / virtual key  →  model requested (model_group)
 *                 →  api_base where it was routed.
 */
import ApexSankey from 'apexsankey';

const chartEl = document.getElementById('chart');
const warningsEl = document.getElementById('warnings');
const rangeEl = document.getElementById('range');
const weightEl = document.getElementById('weight');
const refreshBtn = document.getElementById('refresh');
const autoCheck = document.getElementById('autoCheck');
const autoInterval = document.getElementById('autoInterval');

// Persist the dashboard settings (timeframe, edge weight, auto-refresh)
// in localStorage so they are retained across page reloads.
const SETTINGS_KEY = 'sankeyDashboard.settings';
const loadSettings = () => {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { saved = null; }
  if (!saved) return;
  if (saved.range && rangeEl.querySelector(`option[value="${saved.range}"]`)) rangeEl.value = saved.range;
  if (saved.weight && weightEl.querySelector(`option[value="${saved.weight}"]`)) weightEl.value = saved.weight;
  if (typeof saved.auto === 'boolean') autoCheck.checked = saved.auto;
  if (saved.autoInterval && autoInterval.querySelector(`option[value="${saved.autoInterval}"]`)) autoInterval.value = saved.autoInterval;
};
const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      range: rangeEl.value,
      weight: weightEl.value,
      auto: autoCheck.checked,
      autoInterval: autoInterval.value,
    }));
  } catch {}
};


const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
// Display unit label for the selected edge weight, appended to tooltip counts.
const fmtW = (w) =>
  w === 'tokens' ? 'Tokens'
  : w === 'prompt_tokens' ? 'Prompt Tokens'
  : w === 'completion_tokens' ? 'Output Tokens'
  : w === 'spend' ? '$'
  : 'Requests';

// ---------------------------------------------------------------------------
// Sankey chart instance (options mirror the ApexSankey skill)
// ---------------------------------------------------------------------------
// Polyfill crypto.randomUUID for browsers/contexts where it's unavailable
// (non-secure HTTP, older engines). The Sankey library calls it for instance IDs.
if (typeof crypto === 'undefined' || !crypto.randomUUID) {
  const _crypto = (typeof crypto !== 'undefined') ? crypto : (self.crypto || window.crypto || {});
  const _rnd = (typeof _crypto.getRandomValues === 'function')
    ? () => {
        const b = new Uint8Array(16);
        _crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant 10
        const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      }
    : () => `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const g = (typeof globalThis !== 'undefined') ? globalThis : self;
  if (typeof g.crypto === 'undefined') g.crypto = _crypto;
  g.crypto.randomUUID = _rnd;
}

const sankey = new ApexSankey(chartEl, {
  width: '100%',
  height: 560,
  nodeWidth: 24,
  // Small spacing: the chart's viewBox starts at -spacing on the Y axis, so
  // large spacing adds empty space above the chart content. Keep it tight.
  spacing: 20,
  theme: 'dark',
  // Override the dark theme's canvasStyle: drop the 1px border and make the
  // canvas background transparent so the page background shows through.
  canvasStyle: 'border: none; background: transparent; box-sizing: border-box;',
  // Turn off the library's built-in top-right toolbar (export/zoom buttons)
  // so we can place our own Download button at the bottom of the chart.
  enableToolbar: false,
  enableExport: false,
  edgeGap: 2,
  tooltipTemplate: ({ source, target, value }) => `
    <div style="padding:6px 10px;font-size:12px;line-height:1.5">
      <strong>${source.title}</strong> → <strong>${target.title}</strong>
      <div style="opacity:.7;font-weight:bold;font-size:2em">${fmt(value)} ${fmtW(weightEl.value)}</div>
    </div>`,
  nodeTooltipTemplate: ({ node, value }) => `
    <div style="padding:6px 10px;font-size:12px;line-height:1.5">
      <strong>${node.title}</strong>
      <div style="opacity:.7;font-weight:bold;font-size:2em">flow: ${fmt(value)} ${fmtW(weightEl.value)}</div>
    </div>`,
  onNodeClick: (node) => {
    console.log('isolated node:', node.id, node.title);
    // Clicking an api_base node isolates just the flows that reach it.
    const isBase = rawRows.some((r) =>
      cleanBase(r.api_base) === node.id || cleanBase(r.api_base) === node.title);
    // Clicking an api_key (client) node isolates just the flows from that key.
    const isKey = rawRows.some((r) => r.api_key === node.id);

    if (isBase) {
      // Clicking an api_base while already in detail mode exits detail mode.
      if (selectedKey !== null || selectedBase !== null) {
        selectedKey = null;
        selectedBase = null;
      } else {
        selectedBase = node.id || node.title;
      }
      applyWeight();
    } else if (isKey) {
      // Clicking an api_key while already in detail mode exits detail mode.
      if (selectedKey !== null || selectedBase !== null) {
        selectedKey = null;
        selectedBase = null;
      } else {
        selectedKey = node.id;
      }
      applyWeight();
    } else if (selectedKey !== null || selectedBase !== null) {
      // Clicking an unrelated node clears the filter.
      selectedBase = null;
      selectedKey = null;
      applyWeight();
    }
  },
});

// Hide the diagonal "APEXCHARTS" license watermark. The free ApexSankey build
// has no ECDSA signing keys configured, so setLicense() can never validate and
// the watermark would always show. Remove its element directly instead.
// (The watermark manager only re-paints on a license-status change, which
// never happens at runtime, so removing once after create is enough.)
const wm = chartEl.querySelector('[data-apexcharts-watermark]');
if (wm) wm.remove();

// ---------------------------------------------------------------------------
// Zoom slider: resize the chart container to the selected percentage
// (50–100%). The SVG viewBox rescales the chart proportionally, so the
// whole chart (container + content) grows/shrinks together.
// ---------------------------------------------------------------------------
const zoomEl = document.getElementById('zoom');
const zoomValueEl = document.getElementById('zoomValue');
// Natural (unzoomed) size of the chart container, captured on first use.
let baseChartW = null;
let baseChartH = null;

// Capture the chart's natural (100%) base size once, from the SVG before any
// zoom is applied, so zoom percentages stay stable and resize fitting is correct.
function ensureBaseSize() {
  if (baseChartW !== null) return;
  const svg = chartEl.querySelector('svg');
  baseChartW = svg ? svg.clientWidth : chartEl.clientWidth;
  baseChartH = svg ? svg.clientHeight : chartEl.clientHeight;
}

// Apply a zoom factor (0.3 – 1) to the chart container; the SVG auto-fits it.
function applyZoom(pct) {
  ensureBaseSize();
  pct = Math.max(0.3, Math.min(1, pct));
  chartEl.style.width = (baseChartW * pct) + 'px';
  chartEl.style.height = (baseChartH * pct) + 'px';
  chartEl.style.margin = '-40px auto';
  zoomValueEl.textContent = `${Math.round(pct * 100)}%`;
}

// Recalculate the zoom so the chart is fully visible in the vertical dimension
// of the current viewport: fit the chart to the space below its content top.
function fitChartVertically() {
  ensureBaseSize();
  const wrap = chartEl.parentElement;
  const cs = getComputedStyle(wrap);
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const wrapTop = wrap.getBoundingClientRect().top;
  // Reserve the download bar (below the chart) so it stays on-screen.
  let below = 0;
  const dl = wrap.querySelector('.download-bar');
  if (dl) {
    const r = dl.getBoundingClientRect();
    if (r.bottom > wrapTop) below = r.height || 0;
  }
  const availH = window.innerHeight - (wrapTop + padTop) - padBottom - below;
  const pct = Math.max(0.3, Math.min(1, availH / baseChartH));
  applyZoom(pct);
  zoomEl.value = Math.round(pct * 100);
}

// Zoom slider.
zoomEl.addEventListener('input', () => {
  applyZoom(Number(zoomEl.value) / 100);
});

// Keep the chart fully visible vertically on page load and window resize.
let fitTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { ensureBaseSize(); fitChartVertically(); }, 150);
});

// Download button below the chart: export the current chart as an SVG file.
// graphRef is the rendered graph (set in applyWeight) exposing exportToSvg().
// ---------------------------------------------------------------------------
let graphRef = null;
const downloadBtn = document.getElementById('download');
const detailModeBtn = document.getElementById('detailMode');
// Show/hide the "Detail Mode On" button in the chart-wrap's lower-right
// corner based on whether an api_base or api_key is currently isolated.
const updateDetailButton = () => {
  const on = selectedKey !== null || selectedBase !== null;
  detailModeBtn.hidden = !on;
};
detailModeBtn.addEventListener('click', () => {
  // Leaving detail mode returns to the normal full-view chart.
  selectedKey = null;
  selectedBase = null;
  applyWeight();
  updateDetailButton();
  warningsEl.innerHTML = '';
});
downloadBtn.addEventListener('click', () => {
  if (!graphRef || typeof graphRef.exportToSvg !== 'function') return;
  graphRef.exportToSvg();
});

/** Human-readable label for the active time window. */
function windowLabel() {
  const p = rangeEl.value;
  switch (p) {
    case '1h':  return 'last 1 hour';
    case '24h': return 'last 24 hours';
    case '7d':  return 'last 7 days';
    case '30d': return 'last 30 days';
    default:    return 'last 24 hours';
  }
}

/** Resolve the ISO window from the active range preset. */
function currentWindow() {
  const end = new Date();
  const preset = rangeEl.value;
  let start;
  switch (preset) {
    case '1h':  start = new Date(Date.now() - 3600_000); break;
    case '6h':  start = new Date(Date.now() - 6 * 3600_000); break;
    case '12h': start = new Date(Date.now() - 12 * 3600_000); break;
    case '24h': start = new Date(Date.now() - 24 * 3600_000); break;
    case '7d':  start = new Date(Date.now() - 7 * 86400_000); break;
    case '30d': start = new Date(Date.now() - 30 * 86400_000); break;
    default:    start = new Date(Date.now() - 24 * 3600_000);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

// ---------------------------------------------------------------------------
// Fetch + render
// ---------------------------------------------------------------------------
let paints = 0;
// Raw data cache (fetched once; weight is aggregated client-side)
let rawRows = [];
let keyLabels = {};
// The api_base node currently clicked: when set, buildGraph filters the rows
// so only the flows that lead to this api_base are shown.
let selectedBase = null;
// The api_key (client) node currently clicked: when set, buildGraph filters
// the rows so only the flows from this api_key are shown.
let selectedKey = null;

// Loading overlay over the chart: show while fetching, hide when done.
// showLoading() forces a layout flush so the overlay paints even if data
// arrives synchronously; hideLoading() defers to the next frame so the
// overlay is guaranteed to be visible at least once.
const loadingEl = document.getElementById('loading');
const showLoading = () => {
  if (!loadingEl) return;
  loadingEl.style.display = 'flex';
  loadingEl.getBoundingClientRect(); // flush layout so it actually paints
};
const hideLoading = () => {
  if (!loadingEl) return;
  requestAnimationFrame(() => {
    loadingEl.style.display = 'none';
  });
};

// Orange progress bar (top row, between zoom-bar and records-info): shown
// only while data is loading, filled by the pagination progress streamed
// from /api/sankey.
const loadProgressEl = document.getElementById('loadProgress');
const loadProgressFill = document.getElementById('loadProgressFill');
function showLoadProgress() {
  if (!loadProgressEl) return;
  loadProgressEl.hidden = false;
  loadProgressFill.style.width = '0%';
}
function hideLoadProgress() {
  if (!loadProgressEl) return;
  loadProgressEl.hidden = true;
}
function setLoadProgress(page, total) {
  if (!loadProgressFill) return;
  const pct = total > 0 ? Math.min(100, (page / total) * 100) : 100;
  loadProgressFill.style.width = pct + '%';
}

// Console progress log with a timestamp, e.g. `[12:34:56.789] message`.
function logProgress(msg) {
  const now = new Date();
  const t = now.toTimeString().slice(0, 8) + '.' +
    String(now.getMilliseconds()).padStart(3, '0');
  console.log(`[${t}] ${msg}`);
}

// Top-right corner info: time range of the loaded records + actual count.
const recordsInfoEl = document.getElementById('recordsInfo');
function updateRecordsInfo(windowData, meta, rowsLength) {
  if (!recordsInfoEl) return;
  const start = windowData && windowData.start;
  const end = windowData && windowData.end;
  const fmt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleString();
  };
  const count = meta && meta.totalRequests != null
    ? meta.totalRequests
    : rowsLength;
  recordsInfoEl.innerHTML =
    `${fmt(start)} → ${fmt(end)} · ${count} records`;
}

async function load() {
  const { start, end } = currentWindow();
  showLoading();
  showLoadProgress();
  logProgress('load: fetching spend logs');

  const resp = await fetch(`/api/sankey?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if (!resp.ok) {
    let msg = `Error: ${resp.status}`;
    try { const e = await resp.json(); msg = `Error: ${e.error || resp.status}`; } catch {}
    warningsEl.innerHTML = msg;
    hideLoadProgress();
    return;
  }

  // Read the newline-delimited JSON stream: progress lines, then a data line.
  let data = null;
  const reader = resp.body ? resp.body.getReader() : null;
  if (reader) {
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj && obj.progress) setLoadProgress(obj.progress.page, obj.progress.total);
        else if (obj && obj.data) data = obj.data;
      }
    }
  } else {
    data = await resp.json();
  }
  if (!data) { warningsEl.innerHTML = 'Error: empty response'; hideLoadProgress(); return; }

  logProgress('load: fetched ' + ((data && data.rows) ? data.rows.length : 0) + ' records');

  // Cache the raw rows; weight aggregation happens client-side
  rawRows = data.rows || [];
  keyLabels = data.keyLabels || {};

  // Update the top-right records info: time range + actual record count.
  updateRecordsInfo(data.window, data.meta, rawRows.length);

  // If we are in detail mode but the new timeframe has no rows matching the
  // isolated api_base/api_key, exit detail mode and show the full chart again.
  if ((selectedKey !== null || selectedBase !== null) &&
      rawRows.length > 0 &&
      !rawRows.some((r) => {
        if (selectedKey && r.api_key !== selectedKey) return false;
        if (selectedBase && cleanBase(r.api_base) !== selectedBase) return false;
        return true;
      })) {
    selectedKey = null;
    selectedBase = null;
  }

  applyWeight();
  hideLoading();
  hideLoadProgress();
  logProgress('load: chart rendered');
}

// Trim whitespace and strip any trailing '/' from an api_base URL so that
// e.g. 'http://host/' and 'http://host' aggregate into the same node.
function cleanBase(u) {
  if (!u) return '';
  return String(u).trim().replace(/\/+$/, '');
}

/** Build Sankey nodes/edges from raw rows using the selected weight. */
function buildGraph(rows, weight) {
  const weightOf = r =>
    weight === 'tokens' ? (r.total_tokens || 0)
    : weight === 'prompt_tokens' ? (r.prompt_tokens || 0)
    : weight === 'completion_tokens' ? (r.completion_tokens || 0)
    : weight === 'spend' ? (r.spend || 0)
    : 1;

  // When an api_base or api_key node is clicked, only include rows that match,
  // so the weights reflect just the flows relevant to that node.
  const sourceRows = (selectedKey || selectedBase)
    ? rows.filter((r) => {
        if (selectedKey && r.api_key !== selectedKey) return false;
        if (selectedBase && cleanBase(r.api_base) !== selectedBase) return false;
        return true;
      })
    : rows;

  const nodes = [], edges = [], nodeIds = new Set(), edgeMap = new Map();
  for (const row of sourceRows) {
    const clientId = row.api_key || 'unknown-key';
    const clientTitle = keyLabels[clientId]?.title || `key:${clientId.slice(0, 8)}`;
    const modelId = row.model_group || row.model || 'unknown-model';
    // Normalize api_base: trim whitespace and strip any trailing '/' so that
  // e.g. 'http://host/' and 'http://host' aggregate into the same node.
  const baseId = cleanBase(row.api_base) || 'unknown-base';

    if (!nodeIds.has(clientId)) { nodeIds.add(clientId); nodes.push({ id: clientId, title: clientTitle }); }
    if (!nodeIds.has(modelId)) { nodeIds.add(modelId); nodes.push({ id: modelId, title: modelId }); }
    if (!nodeIds.has(baseId)) { nodeIds.add(baseId); nodes.push({ id: baseId, title: baseId }); }

    const addEdge = (src, tgt, type) => {
      const k = `${src}→${tgt}`;
      if (!edgeMap.has(k)) edgeMap.set(k, { source: src, target: tgt, type, value: 0 });
      edgeMap.get(k).value += weightOf(row);
    };
    addEdge(clientId, modelId, 'request');
    addEdge(modelId, baseId, 'route');
  }
  return { nodes, edges: [...edgeMap.values()] };
}

/** Re-aggregate the cached rows with the selected weight — no network call. */
function applyWeight() {
  const weight = weightEl.value;
  const graph = buildGraph(rawRows, weight);

  if (paints === 0) {
    // Capture the rendered graph so the Download button can call exportToSvg().
    graphRef = sankey.render(graph);
    // Fit the chart into the viewport vertically once the first chart renders,
    // so the whole chart is visible on page load.
    setTimeout(fitChartVertically, 50);
  }
  else sankey.update(graph);
  paints++;

  updateDetailButton();
  warningsEl.innerHTML = '';
  return graph;
}
// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
refreshBtn.addEventListener('click', load);
weightEl.addEventListener('change', () => { applyWeight(); saveSettings(); });
rangeEl.addEventListener('change', () => { load(); saveSettings(); });

// ---------------------------------------------------------------------------
// Auto-refresh
// ---------------------------------------------------------------------------
let autoTimer = null;
function applyAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (autoCheck.checked) {
    const ms = Number(autoInterval.value);
    autoTimer = setInterval(() => load(), ms);
    console.log(`auto-refresh enabled: every ${ms / 60000} min`);
  } else {
    console.log('auto-refresh disabled');
  }
}
autoCheck.addEventListener('change', () => { applyAutoRefresh(); saveSettings(); });
autoInterval.addEventListener('change', () => { applyAutoRefresh(); saveSettings(); });

// Restore previously saved settings before the first load, so a reload keeps
// the timeframe, edge weight, and auto-refresh choices the user last used.
loadSettings();
load();
