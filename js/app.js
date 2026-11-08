import { FILTERS, GROUPS, filterById, formatValue } from "./config.js";
import { loadData } from "./data.js";
import { buildDomains, createFilterPanel, isActive, passes, positionOf, HIST_BINS, h } from "./filters.js";
import { createMap } from "./map.js";

const $ = (id) => document.getElementById(id);
// Data Lab ramp: deep green -> brand green (#1ed760) -> lime (#C4F135); low values recede into the dark map.
const RAMP_DARK = ["#0f3a24", "#145a33", "#187d43", "#1ba653", "#1ed760", "#7fe67a", "#c4f135"];
const RAMP_LIGHT = ["#e3f7e9", "#bdeccb", "#8ddca5", "#52c77a", "#1ea851", "#13823d", "#0a5a29"];
const ramp = () => (document.documentElement.dataset.theme === "light" ? RAMP_LIGHT : RAMP_DARK);
const RESULTS_LIMIT = 300;
const TOOLTIP_KEYS = { rent: ["rent", "hh_income", "summer_high", "winter_high"], buy: ["home_value", "hh_income", "summer_high", "winter_high"] };

const state = {
  mode: "rent",
  ranges: {},
  chips: {},
  avoid: new Set(),
  favOnly: false,
  colorBy: "",
  selected: null,
};

let data, domains, panel, map;
let matches = new Set();
let favorites = loadFavorites();

init().catch((err) => {
  console.error(err);
  const el = $("loading");
  el.classList.add("error");
  el.innerHTML = `<p><strong>Couldn't load the map.</strong><br>${err.message}</p><p>Serve the folder over HTTP (e.g. <code>python -m http.server</code>) and make sure <code>data/counties.json</code> exists.</p>`;
});

async function init() {
  initTheme();
  data = await loadData();
  domains = buildDomains(data.records);
  $("total-count").textContent = data.records.length.toLocaleString();

  panel = createFilterPanel($("filters"), { domains, state, total: data.records.length, onChange: scheduleUpdate });
  readURL();

  map = createMap($("map"), data, { onHover: showTooltip, onClick: selectCounty });
  map.setFavorites(favorites);

  buildColorBy();
  wireUI();
  update();
  if (state.selected) selectCounty(state.selected, { zoom: true });
  $("loading").hidden = true;
}

// ---------------------------------------------------------------- matching

let pending = false;
function scheduleUpdate() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; update(); });
}

function update() {
  const active = FILTERS.filter((f) => isActive(f, state, domains));
  const rangeFilters = FILTERS.filter((f) => f.type === "range" && (!f.mode || f.mode === state.mode));
  const hists = Object.fromEntries(rangeFilters.map((f) => [f.id, new Array(HIST_BINS).fill(0)]));

  matches = new Set();
  for (const rec of data.records) {
    if (state.favOnly && !favorites.has(rec.fips)) continue;
    let failed = null, failCount = 0;
    for (const f of active) {
      if (!passes(f, rec, state, domains)) { failed = f.id; if (++failCount > 1) break; }
    }
    if (failCount === 0) matches.add(rec.fips);
    // histogram for filter X counts counties that pass every *other* filter
    if (failCount <= 1) {
      for (const f of rangeFilters) {
        if (failCount === 1 && failed !== f.id) continue;
        const v = rec[f.id];
        if (typeof v !== "number") continue;
        const bin = Math.min(HIST_BINS - 1, Math.floor(positionOf(domains[f.id], v) * HIST_BINS));
        hists[f.id][bin]++;
      }
    }
  }

  panel.refresh(hists);
  map.update(matches, colorScale());
  renderLegend();

  const n = matches.size.toLocaleString();
  $("match-count").textContent = n;
  $("match-count-mobile").textContent = n;
  $("reset-btn").disabled = active.length === 0 && !state.favOnly;
  $("fav-only").checked = state.favOnly;
  $("fav-count").textContent = favorites.size;

  if (!$("results").hidden) renderResults();
  if (state.selected && !$("detail").hidden) renderDetail(state.selected);
  writeURL();
}

// ---------------------------------------------------------------- color by

function buildColorBy() {
  const sel = $("color-by");
  for (const g of GROUPS) {
    const opts = FILTERS.filter((f) => f.group === g.id && f.type === "range");
    if (!opts.length) continue;
    const og = h("optgroup", { label: g.label });
    for (const f of opts) og.append(h("option", { value: f.id }, f.label));
    sel.append(og);
  }
  sel.value = state.colorBy;
  sel.addEventListener("change", () => { state.colorBy = sel.value; update(); });
}

let scaleCache = {};
function colorScale() {
  if (!state.colorBy) return null;
  const id = state.colorBy;
  if (!scaleCache[id]) {
    const vals = data.records.map((r) => r[id]).filter((v) => typeof v === "number");
    scaleCache[id] = d3.scaleQuantile().domain(vals);
  }
  const scale = scaleCache[id].range(ramp());
  return (rec) => (typeof rec[id] === "number" ? scale(rec[id]) : null);
}

function renderLegend() {
  const el = $("legend");
  el.hidden = false;
  if (!state.colorBy) {
    el.innerHTML = `<div class="legend-keys" style="margin:0">
      <span><i style="background:var(--match)"></i>Matches</span>
      <span><i style="background:var(--nomatch)"></i>Filtered out</span></div>`;
    return;
  }
  const f = filterById[state.colorBy];
  const q = scaleCache[f.id].quantiles();
  const fmt = (v) => formatValue(f, v);
  const vals = data.records.map((r) => r[f.id]).filter((v) => typeof v === "number");
  el.innerHTML = `<div class="legend-title">${f.label}</div>
    <div class="legend-bar">${ramp().map((c) => `<span style="background:${c}"></span>`).join("")}</div>
    <div class="legend-ticks"><span>${fmt(d3.min(vals))}</span><span>${fmt(q[Math.floor(q.length / 2)])}</span><span>${fmt(d3.max(vals))}</span></div>
    <div class="legend-keys"><span><i style="background:var(--nomatch)"></i>Filtered out</span><span><i style="background:var(--nodata)"></i>No data</span></div>`;
}

// ---------------------------------------------------------------- tooltip

function showTooltip(event, fips) {
  const tt = $("tooltip");
  if (!fips || event.pointerType === "touch" || matchMedia("(hover: none)").matches) { tt.hidden = true; return; }
  const rec = data.byFips.get(fips);
  const keys = [...TOOLTIP_KEYS[state.mode]];
  if (state.colorBy && !keys.includes(state.colorBy)) keys.unshift(state.colorBy);
  const isMatch = matches.has(fips);
  tt.innerHTML = `
    <div class="tt-title">${esc(rec.name)}</div>
    <div class="tt-sub">${esc(rec.state)} <span class="tt-status ${isMatch ? "yes" : ""}">${isMatch ? "Match" : "Filtered out"}</span>${favorites.has(fips) ? ' <span style="color:var(--fav)">♥</span>' : ""}</div>
    <dl class="tt-grid">${keys.map((k) => `<dt>${filterById[k].label}</dt><dd>${formatValue(filterById[k], rec[k])}</dd>`).join("")}</dl>
    <div class="tt-hint">Click for full profile</div>`;
  tt.hidden = false;
  const pad = 14, r = tt.getBoundingClientRect();
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + r.width > innerWidth - 8) x = event.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = event.clientY - r.height - pad;
  tt.style.left = x + "px";
  tt.style.top = y + "px";
}

// ---------------------------------------------------------------- detail panel

function selectCounty(fips, { zoom = false } = {}) {
  if (!fips || !data.byFips.has(fips)) {
    state.selected = null;
    $("detail").hidden = true;
    map.select(null);
    writeURL();
    return;
  }
  state.selected = fips;
  map.select(fips);
  if (zoom) map.zoomTo(fips);
  $("tooltip").hidden = true;
  renderDetail(fips);
  $("detail").hidden = false;
  writeURL();
}

function renderDetail(fips) {
  const rec = data.byFips.get(fips);
  const el = $("detail");
  const isMatch = matches.has(fips);
  const isFav = favorites.has(fips);
  const failing = new Set(FILTERS.filter((f) => isActive(f, state, domains) && !passes(f, rec, state, domains)).map((f) => f.id));

  const sections = GROUPS.map((g) => {
    const rows = FILTERS.filter((f) => f.group === g.id && !(f.mode && f.mode !== state.mode))
      .map((f) => `<dt>${f.label}</dt><dd class="${failing.has(f.id) ? "fail" : ""}" ${failing.has(f.id) ? 'title="Outside your filter"' : ""}>${formatValue(f, rec[f.id])}</dd>`)
      .join("");
    return `<h3>${g.label}</h3><dl>${rows}</dl>`;
  }).join("");

  el.innerHTML = `
    <div class="detail-head">
      <div class="panel-head" style="padding:0">
        <h2>${esc(rec.name)}</h2>
        <button class="icon-btn" id="detail-close" aria-label="Close details">✕</button>
      </div>
      <div class="sub">${esc(rec.state)}${typeof rec.pop === "number" ? ` · ${rec.pop.toLocaleString()} people` : ""}
        <span class="tt-status ${isMatch ? "yes" : ""}">${isMatch ? "Matches your filters" : `Fails ${failing.size} filter${failing.size === 1 ? "" : "s"}`}</span></div>
      <div class="detail-actions">
        <button class="btn fav-btn" id="fav-btn" aria-pressed="${isFav}">${isFav ? "♥ Favorited" : "♡ Favorite"}</button>
        <button class="btn" id="zoom-county">Zoom to county</button>
      </div>
    </div>
    <div class="detail-body">${sections}
      ${rec.approx ? '<p class="detail-note">Boundaries changed after the source data was published, so some values are borrowed from the matching Connecticut planning region / Alaska census area.</p>' : ""}
      <p class="detail-note">FIPS ${fips}. Sources: ${Object.values(data.meta.sources).map(esc).join("; ")}.</p>
    </div>`;
  $("detail-close").onclick = () => selectCounty(null);
  $("zoom-county").onclick = () => map.zoomTo(fips);
  $("fav-btn").onclick = () => toggleFavorite(fips);
}

// ---------------------------------------------------------------- favorites

function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem("compass:favorites") || "[]")); }
  catch { return new Set(); }
}
function toggleFavorite(fips) {
  favorites.has(fips) ? favorites.delete(fips) : favorites.add(fips);
  try { localStorage.setItem("compass:favorites", JSON.stringify([...favorites])); } catch { /* storage unavailable */ }
  map.setFavorites(favorites);
  update();
}

// ---------------------------------------------------------------- results list

function renderResults() {
  const q = $("results-search").value.trim().toLowerCase();
  const key = state.colorBy || (state.mode === "buy" ? "home_value" : "rent");
  const f = filterById[key];
  let list = [...matches].map((id) => data.byFips.get(id));
  if (q) list = list.filter((r) => `${r.name} ${r.state}`.toLowerCase().includes(q));
  list.sort(state.colorBy
    ? (a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity)
    : (a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));

  const ol = $("results-list");
  ol.replaceChildren(...list.slice(0, RESULTS_LIMIT).map((r) => {
    const b = h("button", { type: "button" }, [
      h("span", {}, [h("div", { class: "r-name" }, (favorites.has(r.fips) ? "♥ " : "") + r.name), h("div", { class: "r-state" }, r.state)]),
      h("span", { class: "r-val" }, formatValue(f, r[key])),
    ]);
    b.addEventListener("click", () => selectCounty(r.fips, { zoom: true }));
    return h("li", {}, b);
  }));
  $("results-more").textContent = list.length > RESULTS_LIMIT
    ? `Showing ${RESULTS_LIMIT} of ${list.length.toLocaleString()} — narrow your filters or search.`
    : list.length === 0 ? "No counties match." : "";
}

// ---------------------------------------------------------------- CSV

function downloadCSV() {
  const cols = FILTERS.map((f) => f.id);
  const rows = [["fips", "county", "state", ...cols]];
  const sorted = [...matches].map((id) => data.byFips.get(id)).sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  for (const r of sorted) rows.push([r.fips, r.name, r.state, ...cols.map((c) => r[c] ?? "")]);
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = h("a", { href: url, download: `counties-${matches.size}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// ---------------------------------------------------------------- URL state

function writeURL() {
  const p = new URLSearchParams();
  if (state.mode !== "rent") p.set("mode", state.mode);
  for (const f of FILTERS) {
    if (!isActive(f, state, domains)) continue;
    if (f.type === "range") {
      const s = domains[f.id].steps, [a, b] = state.ranges[f.id];
      p.set(f.id, `${a > 0 ? s[a] : ""}~${b < s.length - 1 ? s[b] : ""}`);
    } else if (f.type === "chips") p.set(f.id, [...state.chips[f.id]].join("|"));
  }
  if (state.avoid.size) p.set("avoid", [...state.avoid].map((id) => id.replace("hz_", "")).join(","));
  if (state.favOnly) p.set("fav", "1");
  if (state.colorBy) p.set("color", state.colorBy);
  if (state.selected) p.set("county", state.selected);
  const qs = p.toString().replace(/%7E/g, "~").replace(/%7C/g, "|").replace(/%2C/g, ",");
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function readURL() {
  const p = new URLSearchParams(location.search);
  if (p.get("mode") === "buy") state.mode = "buy";
  for (const f of FILTERS) {
    const raw = p.get(f.id);
    if (raw == null) continue;
    if (f.type === "range") {
      const s = domains[f.id].steps;
      const [lo, hi] = raw.split("~");
      const a = lo === "" || lo == null ? 0 : Math.max(0, d3.bisectLeft(s, +lo));
      const b = hi === "" || hi == null ? s.length - 1 : Math.min(s.length - 1, d3.bisectRight(s, +hi) - 1);
      if (Number.isFinite(a) && Number.isFinite(b) && a <= b) state.ranges[f.id] = [a, b];
    } else if (f.type === "chips") {
      state.chips[f.id] = new Set(raw.split("|").filter((v) => f.options.includes(v)));
    }
  }
  for (const id of (p.get("avoid") || "").split(",").filter(Boolean)) {
    if (filterById["hz_" + id]) state.avoid.add("hz_" + id);
  }
  state.favOnly = p.get("fav") === "1";
  if (filterById[p.get("color")]?.type === "range") state.colorBy = p.get("color");
  state.selected = p.get("county");
}

// ---------------------------------------------------------------- UI wiring

function wireUI() {
  $("reset-btn").addEventListener("click", () => {
    for (const id of Object.keys(state.ranges)) state.ranges[id] = [0, domains[id].steps.length - 1];
    for (const s of Object.values(state.chips)) s.clear();
    state.avoid.clear();
    state.favOnly = false;
    update();
  });
  $("fav-only").addEventListener("change", (e) => { state.favOnly = e.target.checked; update(); });

  $("share-btn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied to clipboard"); }
    catch { toast("Copy the address bar to share this view"); }
  });
  $("csv-btn").addEventListener("click", downloadCSV);

  const resultsBtn = $("results-btn");
  const setResults = (open) => {
    $("results").hidden = !open;
    resultsBtn.setAttribute("aria-expanded", String(open));
    if (open) renderResults();
  };
  resultsBtn.addEventListener("click", () => setResults($("results").hidden));
  $("results-close").addEventListener("click", () => setResults(false));
  $("results-search").addEventListener("input", renderResults);

  $("zoom-in").addEventListener("click", () => map.zoomBy(1.6));
  $("zoom-out").addEventListener("click", () => map.zoomBy(1 / 1.6));
  $("zoom-reset").addEventListener("click", () => map.resetZoom());

  // mobile drawer
  const sidebar = $("sidebar"), scrim = $("scrim"), openBtn = $("open-filters");
  const setDrawer = (open) => {
    sidebar.classList.toggle("open", open);
    scrim.hidden = !open;
    openBtn.setAttribute("aria-expanded", String(open));
  };
  openBtn.addEventListener("click", () => setDrawer(true));
  $("close-filters").addEventListener("click", () => setDrawer(false));
  scrim.addEventListener("click", () => setDrawer(false));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("detail").hidden) selectCounty(null);
    else if (!$("results").hidden) setResults(false);
    else setDrawer(false);
  });
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("compass:theme"); } catch { /* ignore */ }
  // Data Lab dark is the default; light only when the visitor picks it.
  document.documentElement.dataset.theme = saved === "light" ? "light" : "dark";
  $("theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("compass:theme", next); } catch { /* ignore */ }
    if (data) update(); // re-color the choropleth with the theme's ramp
  });
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
