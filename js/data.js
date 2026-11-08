// Loads the county geometry (us-atlas, pre-projected to Albers USA) and the
// generated metrics file, and joins them on the 5-digit FIPS code.

const TOPO_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-albers-10m.json";
const DATA_URL = "data/counties.json";

export async function loadData() {
  const [topo, payload] = await Promise.all([getJSON(TOPO_URL), getJSON(DATA_URL)]);

  const { fields, counties: rows } = payload;
  const byFips = new Map();
  for (const [fips, row] of Object.entries(rows)) {
    const rec = { fips };
    fields.forEach((f, i) => {
      if (row[i] !== null && row[i] !== undefined) rec[f] = row[i];
    });
    byFips.set(fips, rec);
  }

  const counties = topojson.feature(topo, topo.objects.counties).features;
  const states = topojson.mesh(topo, topo.objects.states, (a, b) => a !== b);
  const nation = topojson.mesh(topo, topo.objects.nation);
  const stateNames = new Map(
    topo.objects.states.geometries.map((g) => [g.id, g.properties.name])
  );

  // Every county on the map gets a record, even if the data file lacks it.
  for (const f of counties) {
    if (!byFips.has(f.id)) {
      byFips.set(f.id, { fips: f.id, name: f.properties.name, state: stateNames.get(f.id.slice(0, 2)) ?? "" });
    }
  }

  const records = counties.map((f) => byFips.get(f.id));
  return { topo, counties, states, nation, records, byFips, meta: { generated: payload.generated, sources: payload.sources } };
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.json();
}
