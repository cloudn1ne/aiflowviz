/**
 * LiteLLM → ApexSankey backend proxy & aggregator.
 *
 * Architecture:
 *   LiteLLM Proxy (/spend/logs/v2)  ←──  this server  ←──  browser dashboard
 *
 * The browser only talks to this server (avoids CORS and keeps the LiteLLM
 * admin/master key out of the page). This server:
 *   1. Proxies /spend/logs/v2 for the chosen time window.
 *   2. Resolves each hashed api_key to a readable client label via /key/info.
 *   3. Aggregates the raw rows into Sankey nodes + edges.
 *
 * Env vars (also loadable from a .env file in this folder — see .env.example):
 *   LITELLM_BASE       — base URL of the LiteLLM proxy (e.g. http://localhost:4000)
 *   LITELLM_MASTER_KEY — admin / master key, or a key with the /spend/logs permission
 *   PORT               — this dashboard's port (default 5173)
 */
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from this folder (Node 20.6+ native; no dependency needed).
// Real env vars always win over values read from .env.
process.loadEnvFile(path.join(__dirname, '.env'));

const LITELLM_BASE = (process.env.LITELLM_BASE || 'http://localhost:4000').replace(/\/$/, '');
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY || '';
const PORT = Number(process.env.PORT || 5173);
// Dashboard title shown in the page header (configurable via .env)
const TITLE = process.env.TITLE || 'LiteLLM → Routing Sankey';
// Optional logo shown in the top-left corner. Set LOGO_FILE to a filename
// (e.g. logo.png) in this folder; it is served at /<filename>.
const LOGO_FILE = process.env.LOGO_FILE || '';
// Number of spend-log rows fetched per page. Default 1000 if unset.
const LOG_PAGE_SIZE = Number(process.env.LOG_PAGE_SIZE || 1000);

// ---------------------------------------------------------------------------
// LiteLLM REST helpers
// ---------------------------------------------------------------------------

/** Call any LiteLLM endpoint with the admin key. */
async function litellm(path, params = {}) {
  const url = new URL(`${LITELLM_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch {}
    throw new Error(`LiteLLM ${path} -> ${res.status} ${res.statusText} ${detail}`.trim());
  }
  return res.json();
}

/**
 * Convert any ISO 8601 (or Date-parseable) timestamp to LiteLLM's expected
 * `YYYY-MM-DD HH:MM:SS` UTC format. LiteLLM rejects ISO strings with a `Z`
 * suffix (400 "Invalid date format"), so we strip to the second and drop T/Z.
 */
function litellmDate(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toISOString().slice(0, 19).replace('T', ' '); // 'YYYY-MM-DD HH:MM:SS'
}
/** Strip trailing slashes (and surrounding whitespace) from an api_base URL. */
function cleanBase(u) {
  return (u || '').trim().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Data model → Sankey aggregation
// ---------------------------------------------------------------------------

const fmt = (n) => new Intl.NumberFormat('en-US').format(n);

/**
 * Build Sankey nodes/edges from raw spend-log rows.
 *
 * Flow:  client (virtual key)  →  model requested (model_group)  →  api_base routed
 *
 * Edges are weighted by request COUNT by default (thicker line = more requests).
 * Set `weight` to 'tokens', 'prompt_tokens', 'completion_tokens', or 'spend'
 * to weight by usage instead.
 */

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
// Serve index.html with the dashboard title injected from .env
const fs = await import('node:fs');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// Serve the logo file at /<filename> (it lives in this folder, so
// express.static already exposes it) and point the <img> at that route.
const logoTag = LOGO_FILE ? `<img class="logo" src="/${LOGO_FILE}" alt="logo">` : '';
const titledHtml = indexHtml
  .replace(/<title>.*<\/title>/, `<title>${TITLE}</title>`)
  .replace(/<h1>.*<\/h1>/, `${logoTag}<h1>${TITLE}</h1>`);

app.get('/', (_req, res) => res.type('html').send(titledHtml));
app.use(express.static(__dirname));

/**
 * GET /api/sankey?start=<ISO>&end=<ISO>&weight=requests|tokens|spend
 *
 * Returns { sankey, meta, fetchedAt, window:{start,end}, warnings[] }
 */
app.get('/api/sankey', async (req, res) => {
  const warnings = [];
  const { start, end, weight = 'requests' } = req.query;

  if (!LITELLM_MASTER_KEY) {
    warnings.push('LITELLM_MASTER_KEY is not set — set it in the .env file or server env.');
  }

  // 1) Pull raw request logs for the window (ISO dates → LiteLLM expects
  //    start_date/end_date, which accept ISO 8601).
  // Fetch ALL spend logs: /spend/logs/v2 is paginated, so loop through every
  // page and concatenate the `data` arrays. Avoids capping the chart at 1000.
  const PAGE_SIZE = LOG_PAGE_SIZE;
  // Calculated start point of the selected timeframe: once paginated records
  // reach back to this timestamp, we've covered the whole window and can stop.
  const windowStart = new Date(start);

  // Stream pagination progress to the client as newline-delimited JSON,
  // so the page-by-page load can drive an orange progress bar in the UI.
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.flushHeaders();
  const progress = (page, total) => res.write(JSON.stringify({ progress: { page, total } }) + '\n');

  const first = await litellm('/spend/logs/v2', {
    start_date: litellmDate(start),
    end_date: litellmDate(end),
    page: 1, page_size: PAGE_SIZE,
  }).then((r) => r);
  const firstData = (first && first.data) || (Array.isArray(first) ? first : []);
  let rows = Array.isArray(firstData) ? firstData.slice() : [];
  console.log('spend logs: page 1 loaded (' + firstData.length + ' rows)');
  if (Array.isArray(first)) {
    rows = first.slice();
  } else {
    const total = first && first.total_count != null ? first.total_count : rows.length;
    const totalPages = first && first.total_pages != null ? first.total_pages : Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (!Number.isNaN(windowStart.getTime()) &&
      rows.some((r) => new Date(r.startTime).getTime() < windowStart.getTime())) {
    console.log('spend logs: page 1 already covers the window start — no more pages needed');
    progress(1, 1);
  } else {
    console.log('spend logs: total pages: ' + totalPages);
    progress(1, totalPages);
    for (let p = 2; p <= totalPages; p++) {
      console.log('spend logs: loading page ' + p + '/' + totalPages + ' ...');
      progress(p, totalPages);
      const resp = await litellm('/spend/logs/v2', {
        start_date: litellmDate(start),
        end_date: litellmDate(end),
        page: p, page_size: PAGE_SIZE,
      }).then((r) => r);
      const data = Array.isArray(resp) ? resp : ((resp && resp.data) || []);
      if (Array.isArray(data)) rows = rows.concat(data);
      // Stop once we've seen a record older than the window start.
      if (!Number.isNaN(windowStart.getTime()) &&
          rows.some((r) => new Date(r.startTime).getTime() < windowStart.getTime())) {
        console.log('spend logs: reached window start, stopping at page ' + p);
        break;
      }
    }
  }
  }

  // Actual timestamp range present in the loaded log data, so the
  // displayed window reflects what is actually loaded (the oldest/newest
  // record's startTime), not the raw timeframe selection.
  let dataRange = { start, end };
  {
    let minT = Infinity, maxT = -Infinity;
    for (const r of rows) {
      const t = new Date(r.startTime).getTime();
      if (Number.isNaN(t)) continue;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    if (Number.isFinite(minT)) dataRange.start = new Date(minT).toISOString();
    if (Number.isFinite(maxT)) dataRange.end = new Date(maxT).toISOString();
  }

  // 2) Resolve hashed api_key → readable client label. The spend-log api_key
  //    is the *hashed* virtual key, so /key/info maps it back to the key.
  const keyLabels = {};
  const clientIds = [...new Set(rows.map((r) => r.api_key).filter(Boolean))];
  await Promise.all(
    clientIds.map(async (k) => {
      try {
        const info = await litellm(`/key/info`, { key: k });
        // /key/info returns { key: {...}, info: { key_alias, key_name } }
    // — the readable name lives under `info`, not `key`.
    const kd = info.info || info.key || info.data || {};
        keyLabels[k] = {
          title: kd.key_alias || (kd.user_id ? `user:${kd.user_id}` : `key:${k.slice(0, 8)}`),
          user_id: kd.user_id, team_id: kd.team_id,
        };
      } catch {
        keyLabels[k] = { title: `key:${k.slice(0, 8)}` };
      }
    })
  );

  // 3) Aggregate into Sankey.
  res.write(JSON.stringify({
    data: {
      rows,
      keyLabels,
      meta: {
        weight,
        totalRequests: rows.length,
        totalTokens: rows.reduce((s, r) => s + (r.total_tokens || 0), 0),
        keyCount: Object.keys(keyLabels).length,
      },
      window: dataRange,
      fetchedAt: new Date().toISOString(),
      warnings,
    },
  }) + '\n');
  res.end();
});

/** GET /api/health — tells the browser whether LiteLLM is reachable. */
app.get('/api/health', async (req, res) => {
  try {
    await litellm('/health/check');
    res.json({ ok: true, litellm: LITELLM_BASE, hasKey: !!LITELLM_MASTER_KEY });
  } catch (e) {
    res.status(503).json({ ok: false, litellm: LITELLM_BASE, error: e.message });
  }
});

const HOST = '0.0.0.0';

/** First non-internal IPv4 address of this machine (for the remote URL). */
function lanIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

app.listen(PORT, HOST, () => {
  const ip = lanIP();
  console.log('Sankey dashboard  →  http://localhost:' + PORT);
  console.log('Remote (LAN)     →  http://' + ip + ':' + PORT);
  console.log('LiteLLM proxy    →  ' + LITELLM_BASE + '  (key set: ' + !!LITELLM_MASTER_KEY + ')');
});
