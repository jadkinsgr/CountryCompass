// Filter and metric definitions. The sidebar, tooltip, detail panel and CSV
// export are all generated from this file — add a metric here and it shows up
// everywhere (as long as scripts/build_data.py emits the same key).

const fmtInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const FORMATS = {
  money: (v) => (v >= 10000 ? "$" + fmtCompact.format(v) : "$" + fmtInt.format(v)),
  money2: (v) => "$" + v.toFixed(2),
  pct: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + "%",
  int: (v) => (v >= 10000 ? fmtCompact.format(v) : fmtInt.format(v)),
  dec1: (v) => v.toFixed(1),
  dec2: (v) => v.toFixed(2),
  signed: (v) => (v > 0 ? "+" : "") + v.toFixed(2),
  temp: (v) => Math.round(v) + "°F",
  min: (v) => v.toFixed(1) + " min",
  inch: (v) => Math.round(v) + " in",
  rate: (v) => v.toFixed(1),
  // vote margin in points: positive = Republican, negative = Democratic
  lean: (v) => (Math.abs(v) < 0.5 ? "Even" : (v > 0 ? "R+" : "D+") + Math.round(Math.abs(v))),
};

export const GROUPS = [
  { id: "cost", label: "Cost of Living", icon: "💲" },
  { id: "demo", label: "Demographics", icon: "👥" },
  { id: "crime", label: "Crime", icon: "🛡️", note: "Per-type breakdown (burglary, robbery…) not yet available." },
  { id: "weather", label: "Terrain & Weather", icon: "⛰️", note: "Humidity, sunshine and mountains not yet available." },
  { id: "laws", label: "Laws & Rights", icon: "⚖️" },
  { id: "politics", label: "Politics", icon: "🗳️" },
  { id: "economy", label: "Economy", icon: "📈" },
  { id: "health", label: "Health", icon: "❤️" },
  { id: "hazards", label: "Natural Hazards", icon: "🌪️" },
];

// type: "range" (dual slider), "chips" (multi-select categories), "avoid" (checkbox)
// mode: only shown when the Rent/Buy toggle matches.
export const FILTERS = [
  // Cost of living
  { id: "rent", group: "cost", type: "range", label: "Median rent", unit: "/mo", fmt: "money", mode: "rent", key: true },
  { id: "home_value", group: "cost", type: "range", label: "Median home value", fmt: "money", mode: "buy", key: true },
  { id: "tax_burden", group: "cost", type: "range", label: "State tax burden", fmt: "pct", help: "State + local taxes as % of income (Tax Foundation)" },
  { id: "commute", group: "cost", type: "range", label: "Avg commute", fmt: "min" },

  // Demographics
  { id: "density", group: "demo", type: "range", label: "Population density", unit: "/sq mi", fmt: "int" },
  { id: "pop", group: "demo", type: "range", label: "Population", fmt: "int" },
  { id: "ba_plus", group: "demo", type: "range", label: "Adults with bachelor's+", fmt: "pct" },
  { id: "median_age", group: "demo", type: "range", label: "Median age", fmt: "dec1" },
  { id: "test_scores", group: "demo", type: "range", label: "School test scores", unit: " grades vs US", fmt: "signed", help: "Avg 3rd-grade reading & math, in grade levels relative to the US average" },
  { id: "hh_size", group: "demo", type: "range", label: "Avg household size", fmt: "dec2" },
  { id: "veterans", group: "demo", type: "range", label: "Veterans", fmt: "pct" },

  // Crime
  { id: "violent_crime", group: "crime", type: "range", label: "Violent crime", unit: " per 1k", fmt: "rate", help: "Violent crimes per 1,000 residents (FBI UCR via County Health Rankings 2022)" },

  // Terrain & weather
  { id: "coast", group: "weather", type: "chips", label: "Coastline", options: ["Ocean", "Great Lakes", "None"], optionLabels: { None: "Inland" } },
  { id: "summer_high", group: "weather", type: "range", label: "Summer high (July)", fmt: "temp", key: true },
  { id: "winter_high", group: "weather", type: "range", label: "Winter high (Jan)", fmt: "temp", key: true },
  { id: "precip", group: "weather", type: "range", label: "Annual precipitation", fmt: "inch" },

  // Laws (state level)
  { id: "cannabis", group: "laws", type: "chips", label: "Cannabis", options: ["Recreational", "Medical", "None"], optionLabels: { None: "Not legal" } },
  { id: "abortion", group: "laws", type: "chips", label: "Abortion", options: ["Legal", "Restricted", "Banned"] },
  { id: "carry", group: "laws", type: "chips", label: "Concealed carry", options: ["Permitless", "Permit required"] },

  // Politics (diverging: colored liberal blue -> conservative red around 0)
  { id: "lean", group: "politics", type: "range", label: "Political lean", fmt: "lean", diverging: true, help: "2024 presidential vote margin (D+ = liberal, R+ = conservative). Alaska uses the statewide result." },

  // Economy
  { id: "hh_income", group: "economy", type: "range", label: "Median household income", fmt: "money", key: true },
  { id: "income_pc", group: "economy", type: "range", label: "Per-capita income", fmt: "money" },
  { id: "employment_rate", group: "economy", type: "range", label: "Employment rate", fmt: "pct" },
  { id: "unemployment", group: "economy", type: "range", label: "Unemployment", fmt: "pct" },
  { id: "poverty", group: "economy", type: "range", label: "Poverty", fmt: "pct" },
  { id: "homeownership", group: "economy", type: "range", label: "Homeownership", fmt: "pct" },
  { id: "establishments", group: "economy", type: "range", label: "Employer establishments", fmt: "int" },
  { id: "vacant_units", group: "economy", type: "range", label: "Vacant housing units", fmt: "int" },

  // Health
  { id: "obesity", group: "health", type: "range", label: "Adult obesity", fmt: "pct" },
  { id: "uninsured", group: "health", type: "range", label: "Uninsured", fmt: "pct" },
  { id: "smoking", group: "health", type: "range", label: "Adult smoking", fmt: "pct" },
  { id: "excessive_drinking", group: "health", type: "range", label: "Excessive drinking", fmt: "pct" },
  { id: "alcohol_driving", group: "health", type: "range", label: "Alcohol-impaired driving deaths", fmt: "pct" },
  { id: "exercise", group: "health", type: "range", label: "Access to exercise", fmt: "pct" },
  { id: "cig_tax", group: "health", type: "range", label: "Cigarette tax", unit: "/pack", fmt: "money2" },

  // Hazards (FEMA NRI rating 1-5; avoid = Relatively High or Very High)
  { id: "hz_earthquake", group: "hazards", type: "avoid", label: "Earthquakes" },
  { id: "hz_hurricane", group: "hazards", type: "avoid", label: "Hurricanes" },
  { id: "hz_tornado", group: "hazards", type: "avoid", label: "Tornadoes" },
  { id: "hz_wildfire", group: "hazards", type: "avoid", label: "Wildfires" },
  { id: "hz_drought", group: "hazards", type: "avoid", label: "Drought" },
];

export const HAZARD_LABELS = ["No rating", "Very low", "Relatively low", "Moderate", "Relatively high", "Very high"];
export const AVOID_THRESHOLD = 4;

export function formatValue(filter, v) {
  if (v === undefined || v === null) return "—";
  if (filter.type === "avoid") return HAZARD_LABELS[v] ?? "—";
  if (filter.type === "chips") return filter.optionLabels?.[v] ?? v;
  return FORMATS[filter.fmt](v) + (filter.unit && !filter.unit.startsWith(" grades") ? filter.unit : "");
}

export const filterById = Object.fromEntries(FILTERS.map((f) => [f.id, f]));
