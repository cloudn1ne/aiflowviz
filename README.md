# LiteLLM → Routing Sankey Dashboard

A dashboard that answers: **which LiteLLM clients requested which virtual keys /
models, and to which `api_base` were their requests routed** — with line
thickness ∝ request count (or tokens / spend), and a **slider** to choose the
timeframe considered.

Built with the **ApexSankey skill** (`apexsankey` npm package, v1.12) and
LiteLLM's **spend-logs REST API**.

---

## 1. How the data is retrieved (LiteLLM REST API)

The dashboard queries LiteLLM's native REST API — no DB access needed. The
key endpoint is the **spend logs** API:

### `GET /spend/logs/v2`

Returns one row **per request**, with exactly the fields this chart needs:

| Field | Role in the Sankey |
|---|---|
| `api_key` | **Client / virtual key** — the *hashed* key that made the call (source node) |
| `model_group` | **Model the client requested** (middle node) |
| `api_base` | **Where LiteLLM actually routed it** (target node) |
| `model`, `custom_llm_provider` | resolved model + provider (extra context) |
| `total_tokens`, `spend` | alternative edge weights |
| `startTime` | used to filter the window |
| `user`, `end_user`, `team_id`, `request_tags`, `status` | enrichment |

Query params (from the LiteLLM source, `spend_management_endpoints.py`):

```http
GET {LITELLM_URL}/spend/logs/v2
   ?start_date={ISO}&end_date={ISO}   # time window  ← driven by the slider
   &page_size=1000
Authorization: Bearer {ADMIN_KEY}
```

> **Why `model_group`?** LiteLLM lets clients request a model *alias* (e.g.
> `gpt-4`) and then routes it to a specific deployment. `model_group` is the
> alias the client asked for; `api_base` is the actual backend it hit — so the
> two middle→target hops show the routing decision.

### `GET /key/info?key={hash}` — resolve hashed key → client

The spend-log `api_key` is the *hashed* virtual key. Calling `/key/info` per
key maps it back to `key_alias`, `user_id`, `team_id`, `metadata` — so the
chart labels clients by **alias / user** instead of raw hashes.

### Auth

Needs the **admin / master key**, or a key with the `/spend/logs` permission
(route is gated in `spend_management_endpoints.py`). The master key is kept
**server-side** in the backend proxy — it never reaches the browser.

### Timeframe via slider

Every slider change re-issues `/spend/logs/v2` with a new `start_date` /
`end_date`, re-aggregates, and calls `sankey.update()` — the ApexSankey chart
**morphs** to the new window instead of rebuilding.

---

## 2. Architecture

```
Browser (index.html + app.js)
   │  fetch /api/sankey?start=..&end=..&weight=requests
   ▼
server.js  (Express, holds LITELLM_KEY)
   ├─ GET /spend/logs/v2   → raw request rows (windowed)
   ├─ GET /key/info        → hashed api_key → client label
   └─ aggregate → { nodes, edges }  (ApexSankey shape)
   ▼
ApexSankey chart
   nodes: client (key)  →  model requested  →  api_base routed
   edges: weighted by request count (or tokens / spend)
```

## 3. Run it

```bash
npm install

# point the proxy at your LiteLLM instance
export LITELLM_URL=http://localhost:4000
export LITELLM_KEY=sk-admin-key-with-spend-logs-permission

npm start          # dashboard on http://localhost:5173
```

Open `http://localhost:5173` — the chart renders, and the **timeframe slider**
(top right) refetches + morphs the Sankey for the new window.

## 4. Slider semantics

- **Window slider** (`1–60 days`) — how far back `start_date` goes.
- **Timeframe preset** (`1h / 24h / 7d / 30d`) — refines the *end* point.
- **Edge weight** (`requests / tokens / spend`) — what makes a band thicker.

## 5. Files

| File | Purpose |
|---|---|
| `server.js` | LiteLLM REST proxy + Sankey aggregator |
| `app.js` | Chart driving + slider → `sankey.update()` |
| `index.html` | Dashboard shell (slider, chart, stats) |
| `style.css` | Dark dashboard theme |
# aiflowviz
# aiflowviz
