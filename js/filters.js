// Sidebar: builds every control from config.js and reports changes upward.
// Range sliders move through *percentile steps* of the data rather than raw
// values, so skewed metrics (density, population) stay usable end to end.

import { FILTERS, GROUPS, FORMATS, AVOID_THRESHOLD } from "./config.js";

export const HIST_BINS = 24;
const QUANTILE_STEPS = 200;

/** Per range filter: sorted unique percentile values used as slider steps. */
export function buildDomains(records) {
  const domains = {};
  for (const f of FILTERS) {
    if (f.type !== "range") continue;
    const vals = records.map((r) => r[f.id]).filter((v) => typeof v === "number").sort((a, b) => a - b);
    const steps = [];
    for (let i = 0; i <= QUANTILE_STEPS; i++) {
      const q = d3.quantileSorted(vals, i / QUANTILE_STEPS);
      // round so labels and shared URLs stay clean (831, not 830.6000000000001)
      const v = Math.abs(q) >= 100 ? Math.round(q) : +q.toPrecision(3);
      if (steps.length === 0 || v > steps[steps.length - 1]) steps.push(v);
    }
    domains[f.id] = { steps, coverage: vals.length };
  }
  return domains;
}

/** Fractional slider position (0..1) of a value within a domain. */
export function positionOf(domain, v) {
  const s = domain.steps;
  if (v <= s[0]) return 0;
  if (v >= s[s.length - 1]) return 1;
  const i = d3.bisectRight(s, v) - 1;
  const frac = (v - s[i]) / (s[i + 1] - s[i] || 1);
  return (i + frac) / (s.length - 1);
}

export function isActive(f, state, domains) {
  if (f.mode && f.mode !== state.mode) return false;
  if (f.type === "range") {
    const r = state.ranges[f.id];
    return !!r && (r[0] > 0 || r[1] < domains[f.id].steps.length - 1);
  }
  if (f.type === "chips") {
    const s = state.chips[f.id];
    return !!s && s.size > 0 && s.size < f.options.length;
  }
  if (f.type === "avoid") return state.avoid.has(f.id);
  return false;
}

/** Does a record pass a single (active) filter? */
export function passes(f, rec, state, domains) {
  const v = rec[f.id];
  if (f.type === "range") {
    if (typeof v !== "number") return false;
    const [lo, hi] = state.ranges[f.id];
    const s = domains[f.id].steps;
    return v >= s[lo] && v <= s[hi];
  }
  if (f.type === "chips") return v !== undefined && state.chips[f.id].has(v);
  if (f.type === "avoid") return !(v >= AVOID_THRESHOLD);
  return true;
}

// ---------------------------------------------------------------------------

export function createFilterPanel(container, { domains, state, total, onChange }) {
  const els = {}; // per-filter DOM handles
  const groupEls = {};

  for (const g of GROUPS) {
    const filters = FILTERS.filter((f) => f.group === g.id);
    const section = h("section", { class: "group", "data-open": String(g.id === "cost") });
    const head = h("button", { class: "group-head", "aria-expanded": String(g.id === "cost") }, [
      h("span", { class: "group-icon", "aria-hidden": "true" }, g.icon),
      h("span", {}, g.label),
      h("span", { class: "pill group-badge" }),
      chevron(),
    ]);
    head.addEventListener("click", () => {
      const open = section.dataset.open !== "true";
      section.dataset.open = String(open);
      head.setAttribute("aria-expanded", String(open));
    });
    const body = h("div", { class: "group-body" });

    if (g.id === "cost") body.append(modeToggle(state, onChange));

    if (g.id === "hazards") {
      const list = h("div", { class: "avoid-list" });
      for (const f of filters) {
        const cb = h("input", { type: "checkbox" });
        cb.addEventListener("change", () => {
          cb.checked ? state.avoid.add(f.id) : state.avoid.delete(f.id);
          onChange();
        });
        list.append(h("label", { class: "avoid" }, [cb, h("span", {}, "Avoid " + f.label.toLowerCase())]));
        els[f.id] = { cb };
      }
      list.append(h("p", { class: "avoid-hint" }, "Excludes counties FEMA's National Risk Index rates Relatively High or Very High."));
      body.append(list);
    } else {
      for (const f of filters) {
        const el = f.type === "range" ? rangeFilter(f, domains[f.id], total, state, onChange) : chipFilter(f, state, onChange);
        els[f.id] = el;
        body.append(el.root);
      }
    }
    if (g.note) body.append(h("p", { class: "group-note" }, g.note));

    section.append(head, body);
    container.append(section);
    groupEls[g.id] = { section, badge: head.querySelector(".group-badge") };
  }

  function refresh(hists) {
    const activeByGroup = {};
    for (const f of FILTERS) {
      const el = els[f.id];
      const active = isActive(f, state, domains);
      if (active) activeByGroup[f.group] = (activeByGroup[f.group] || 0) + 1;

      if (f.type === "range") {
        el.root.hidden = !!f.mode && f.mode !== state.mode;
        el.sync(active, hists?.[f.id]);
      } else if (f.type === "chips") {
        el.sync(active);
      } else if (f.type === "avoid") {
        el.cb.checked = state.avoid.has(f.id);
      }
    }
    for (const g of GROUPS) groupEls[g.id].badge.textContent = activeByGroup[g.id] || "";
    container.querySelectorAll(".segmented button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
  }

  return { refresh };
}

function modeToggle(state, onChange) {
  const wrap = h("div", { class: "segmented", role: "group", "aria-label": "Rent or buy" });
  for (const [mode, label] of [["rent", "Rent"], ["buy", "Buy"]]) {
    const b = h("button", { type: "button", "data-mode": mode, "aria-pressed": String(state.mode === mode) }, label);
    b.addEventListener("click", () => { state.mode = mode; onChange(); });
    wrap.append(b);
  }
  return wrap;
}

function rangeFilter(f, domain, total, state, onChange) {
  const last = domain.steps.length - 1;
  if (!state.ranges[f.id]) state.ranges[f.id] = [0, last];
  const fmt = (v) => FORMATS[f.fmt](v) + (f.unit && !f.unit.startsWith(" grades") ? f.unit : "");

  const helpText = [f.help, domain.coverage < total * 0.99 ? `Data available for ${domain.coverage.toLocaleString()} of ${total.toLocaleString()} counties; counties without data are excluded while this filter is set.` : ""]
    .filter(Boolean).join(" ");

  const valueEl = h("span", { class: "filter-value" });
  const clear = h("button", { class: "filter-clear", type: "button", "aria-label": `Clear ${f.label}` }, "✕");
  const lo = h("input", { type: "range", min: 0, max: last, step: 1, "aria-label": `${f.label} minimum` });
  const hi = h("input", { type: "range", min: 0, max: last, step: 1, "aria-label": `${f.label} maximum` });
  const fill = h("div", { class: "range-fill" });
  const hist = h("div", { class: "hist", "aria-hidden": "true" }, Array.from({ length: HIST_BINS }, () => h("span")));

  const root = h("div", { class: "filter", "data-id": f.id }, [
    h("div", { class: "filter-head" }, [
      h("span", { class: "filter-label" }, [f.label, helpText ? h("span", { class: "help", title: helpText }, "?") : ""]),
      h("span", {}, [valueEl, clear]),
    ]),
    hist,
    h("div", { class: "range" }, [h("div", { class: "range-track" }, fill), lo, hi]),
  ]);

  const onInput = (which) => () => {
    let a = +lo.value, b = +hi.value;
    if (a > b) { if (which === "lo") a = b; else b = a; }
    state.ranges[f.id] = [a, b];
    onChange();
  };
  lo.addEventListener("input", onInput("lo"));
  hi.addEventListener("input", onInput("hi"));
  clear.addEventListener("click", () => { state.ranges[f.id] = [0, last]; onChange(); });

  function sync(active, bins) {
    const [a, b] = state.ranges[f.id];
    lo.value = a; hi.value = b;
    // keep the lower thumb grabbable when both sit at the right end
    lo.style.zIndex = a >= last - 1 ? 3 : 2;
    fill.style.left = (a / last) * 100 + "%";
    fill.style.right = (100 - (b / last) * 100) + "%";
    root.classList.toggle("active", active);
    const s = domain.steps;
    valueEl.textContent = !active ? `${fmt(s[0])} – ${fmt(s[last])}`
      : a === 0 ? `≤ ${fmt(s[b])}`
      : b === last ? `≥ ${fmt(s[a])}`
      : `${fmt(s[a])} – ${fmt(s[b])}`;
    if (bins) {
      const max = Math.max(1, ...bins);
      const loBin = Math.floor((a / last) * HIST_BINS);
      const hiBin = Math.ceil((b / last) * HIST_BINS) - 1;
      hist.childNodes.forEach((span, i) => {
        span.style.height = (bins[i] / max) * 100 + "%";
        span.classList.toggle("in", i >= loBin && i <= hiBin);
      });
    }
  }
  return { root, sync };
}

function chipFilter(f, state, onChange) {
  if (!state.chips[f.id]) state.chips[f.id] = new Set();
  const set = () => state.chips[f.id];
  const valueEl = h("span", { class: "filter-value" });
  const clear = h("button", { class: "filter-clear", type: "button", "aria-label": `Clear ${f.label}` }, "✕");
  const chips = f.options.map((opt) => {
    const b = h("button", { class: "chip", type: "button", "aria-pressed": "false" }, f.optionLabels?.[opt] ?? opt);
    b.addEventListener("click", () => {
      set().has(opt) ? set().delete(opt) : set().add(opt);
      onChange();
    });
    return [opt, b];
  });
  clear.addEventListener("click", () => { set().clear(); onChange(); });

  const root = h("div", { class: "filter", "data-id": f.id }, [
    h("div", { class: "filter-head" }, [h("span", { class: "filter-label" }, f.label), h("span", {}, [valueEl, clear])]),
    h("div", { class: "chips" }, chips.map(([, b]) => b)),
  ]);

  function sync(active) {
    chips.forEach(([opt, b]) => b.setAttribute("aria-pressed", String(set().has(opt))));
    root.classList.toggle("active", active);
    valueEl.textContent = active ? `${set().size} selected` : "Any";
  }
  return { root, sync };
}

// --- tiny DOM helpers -------------------------------------------------------

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of [].concat(children)) if (c !== "" && c != null) el.append(c);
  return el;
}

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "chev");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<path d="m6 9 6 6 6-6"/>';
  return svg;
}
