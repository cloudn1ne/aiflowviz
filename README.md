# LiteLLM → Routing Sankey Dashboard

A dashboard that answers: **which LiteLLM clients requested which virtual keys /
models, and to which `api_base` were their requests routed** — with line
thickness ∝ request count (or tokens / spend), and a **slider** to choose the
timeframe considered.

Built with the **ApexSankey skill** (`apexsankey` npm package, v1.12) and
LiteLLM's **spend-logs REST API**.

---

## 1. How the data is fetched (LiteLLM spend-logs API)

The backend queries `GET /spend/logs/v2`, which is **paginated** (newest-first)
and filtered to the selected timeframe (`start_date` → `end_date`).

### Pagination progress on the Unix console

Each `/api/sankey` request logs its pagination progress to the console:

```
spend logs: page 1 loaded (N rows)
spend logs: total pages: 5
spend logs: loading page 2/5 ...
spend logs: loading page 3/5 ...
spend logs: reached window start, stopping at page 3
```

### Early-stop pagination

Because `/spend/logs/v2` is ordered newest-first, once the fetched pages have
reached a record whose `startTime` is **older than the selected timeframe's
start**, the rest of the window is already covered. The loop stops there
instead of pulling every remaining page:

```js
if (!Number.isNaN(windowStart.getTime()) &&
    rows.some((r) => new Date(r.startTime).getTime() < windowStart.getTime())) {
  console.log('spend logs: reached window start, stopping at page ' + p);
  break;
}
```

If page 1 alone already covers the whole window, no further pages are fetched
at all (`page 1 already covers the window start — no more pages needed`).

### Displayed time window reflects actual loaded data

The dashboard's "range" (top-right) shows the **actual timestamps present in
the loaded log data** — the oldest and newest record's `startTime` — rather
than the raw slider selection. This matches exactly what the chart shows, even
when pagination stopped early or no records exist back to the slider's start.

---

## 2. Loading progress bar (orange, top row)

While data is loading, an **orange progress bar** appears in the top row of the
panel — between the zoom slider (top-left) and the records-info (top-right) —
filled in real time as the server paginates:

- The server streams the response as **newline-delimited JSON** (NDJSON):
  one `{"progress":{"page":1,"total":N}}` line per fetched page, then a final
  `{"data":{...}}` line with the aggregated result.
- The browser reads the stream incrementally (`getReader` + `TextDecoder`),
  updates the bar via `setLoadProgress(page, total)`, and hides it once the
  data line arrives.
- `.load-progress` → absolute, `top: 8px`, centered (`left: 50%`), slim 8px
  rounded track — styled like the zoom slider.
- `.load-progress-fill` → orange (`#f97316`), `width` 0→100% with a smooth
  transition.

---

## 3. Top-of-panel controls & layout

The **zoom slider** (top-left) and **time range** (top-right) are pinned to the
top edge of the chart panel, vertically aligned, so they sit in a single row:

- `.zoom-bar` → absolute, `top: 8px; left: 16px`
- `.records-info` → absolute, `top: 8px; right: 16px`

### Chart fits the viewport vertically

On page load and window resize the zoom factor is recalculated so the whole
chart is visible in the vertical dimension:

- `ensureBaseSize()` captures the chart's **natural (100%)** base size once,
  from the unzoomed SVG, so zoom percentages stay stable.
- `fitChartVertically()` measures the vertical space below the chart's content
  top down to the bottom of the window (reserving the download bar), derives
  the zoom factor, applies it, and syncs the slider/label.

### Chart margin

The chart container uses `margin: -40px auto` (instead of `0 auto`). The
negative top margin pulls the chart up into the panel's top padding, which
removes the vertical scrollbar and tightens the layout.

---

## 4. Click an api_base or api_key to isolate its flows

Clicking an **api_base node** in the Sankey chart isolates just the flows that
reach that base; clicking an **api_key (client) node** isolates just the flows
originating from that key:

- `onNodeClick` detects api_base clicks (`selectedBase`) and api_key clicks
  (`selectedKey`).
- `buildGraph` then filters the rows to only those whose api_base / api_key
  match, so the nodes and edge weights reflect **only** the flows relevant to
  that node.
- Clicking an unrelated node (or clicking the node again) clears the filter and
  restores the full view.
- A **"Detail Mode On"** button appears in the lower-right corner of the chart
  panel while detail mode is active; clicking it returns to the normal full
  view.
- If a new timeframe is selected and the fetched data contains **no rows**
  matching the isolated api_base / api_key, detail mode is exited
  automatically and the full chart is shown instead.

---

## 5. Settings are remembered (localStorage)

The dashboard persists its controls in the browser's `localStorage` under the
key `sankeyDashboard.settings`:

| Setting | Control | Stored field |
|---|---|---|
| Timeframe | `#range` select | `range` |
| Edge weight | `#weight` select | `weight` |
| Auto-refresh on/off | `#autoCheck` checkbox | `auto` |
| Refresh interval | `#autoInterval` select | `autoInterval` |

- `saveSettings()` writes the current values whenever any control changes.
- `loadSettings()` restores the saved values **before the first `load()`** on
  page reload, so the same settings (timeframe, edge weight, auto-refresh
  toggle, and interval) are retained.
- Invalid/unknown saved values are ignored (only applied if a matching
  `<option>` exists).

---

## 6. Auth

Needs the **admin / master key**, or a key with the `/spend/logs` permission
(route gated in `spend_management_endpoints.py`). The master key is kept
**server-side** in the Express proxy — it never reaches the browser.

---

## 7. Run it

```bash
npm install

# point the proxy at your LiteLLM instance
export LITELLM_BASE=http://localhost:4000
export LITELLM_MASTER_KEY=sk-admin-key-with-spend-logs-permission

npm start          # dashboard on http://localhost:5173
```

Environment can also be provided via a `.env` file in the project root (see
`.env.example`); real shell env vars always win over `.env` values.

Open `http://localhost:5173` — the chart renders, and the **timeframe slider**
(top-left) refetches the spend-logs for the new window.

## 8. Optional: title + logo

| Env var | Default | Purpose |
|---|---|---|
| `TITLE` | `LiteLLM → Routing Sankey` | Page header title |
| `LOGO_FILE` | *(empty)* | Filename in this folder (e.g. `logo.png`) served at `/logo.png` and shown top-left |
| `PORT` | `5173` | Dashboard port |

## 9. Files

| File | Purpose |
|---|---|
| `server.js` | Express proxy: paginated spend-log fetch, console progress, NDJSON streaming, early-stop at window start, actual-data time range, logo/title injection |
| `app.js` | Chart driving + slider → refetch, vertical-fit zoom, `-40px` margin, localStorage persistence, streaming progress bar, api_base click isolation |
| `index.html` | Dashboard shell (top-aligned controls row, progress bar) |
| `style.css` | Dark theme, top-aligned control row, orange progress bar |
