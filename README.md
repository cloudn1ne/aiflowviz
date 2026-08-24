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

## 2. Top-of-panel controls

Both the **zoom slider** (top-left) and the **time range** (top-right) are
pinned to the top edge of the chart panel, vertically aligned, so they sit in a
single row above the chart:

- `.zoom-bar` → absolute, `top: 8px; left: 16px`
- `.records-info` → absolute, `top: 8px; right: 16px`

The panel's top padding clears the in-flow chart so it never overlaps them.

---

## 3. Auth

Needs the **admin / master key**, or a key with the `/spend/logs` permission
(route gated in `spend_management_endpoints.py`). The master key is kept
**server-side** in the Express proxy — it never reaches the browser.

---

## 4. Run it

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

## 5. Optional: title + logo

| Env var | Default | Purpose |
|---|---|---|
| `TITLE` | `LiteLLM → Routing Sankey` | Page header title |
| `LOGO_FILE` | *(empty)* | Filename in this folder (e.g. `logo.png`) served at `/logo.png` and shown top-left |
| `PORT` | `5173` | Dashboard port |

## 6. Files

| File | Purpose |
|---|---|
| `server.js` | Express proxy: paginated spend-log fetch, console progress, early-stop at window start, actual-data time range, logo/title injection |
| `app.js` | Chart driving + slider → refetch + zoom/records-info display |
| `index.html` | Dashboard shell (top-aligned zoom bar + records info) |
| `style.css` | Dark theme, top-aligned control row |
