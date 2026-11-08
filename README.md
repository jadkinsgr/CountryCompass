# MoveMap

A practice project that recreates a "find where to live" county explorer. It shows an interactive map of all 3,142 US counties with about 40 filters for cost of living, demographics, crime, weather, laws, the economy, health and natural hazards. The data is real and comes from public sources.

Vanilla HTML/CSS/JS with [D3](https://d3js.org) and [us-atlas](https://github.com/topojson/us-atlas) county shapes. There is no build step.

**Live site:** https://jadkinsgr.github.io/MoveMap/

## Run it locally

```bash
python -m http.server 8000
# open http://localhost:8000
```

The page loads `data/counties.json` with `fetch`, so opening `index.html` straight from disk won't work. You need a local server.

## Deployment

GitHub Pages serves the site straight from the root of the `main` branch (Settings → Pages → *Deploy from a branch* → `main` / `/ (root)`), the same setup as ProjectPortfolio. There is no build step: push to `main` and Pages republishes in a minute or two. `.nojekyll` tells Pages to serve the files as-is. All paths are relative, so the site works under the `/MoveMap/` subpath.

After rebuilding the data, commit the updated `data/counties.json`. The site reads that file directly.

## Features

- **Filters:** dual-handle range sliders that step through the data's percentiles, so skewed metrics like population density stay usable. A histogram on each slider shows where the counties that pass your *other* filters fall.
- **Rent / Buy toggle:** switches between median rent and median home value.
- **Category filters:** chips for coastline, cannabis, abortion and concealed carry.
- **Hazards:** "Avoid" toggles that exclude counties FEMA rates Relatively High or Very High.
- **Live counter:** shows how many counties match.
- **Color by:** shades the matching counties by any metric.
- **County profiles:** hover for a tooltip; click for a detail panel that shows every metric and marks the filters the county fails.
- **Favorites:** ♥ any county (saved in localStorage) and use "Favorites only".
- **Results list:** searchable and sorted; click a row to zoom to that county.
- **Shareable URLs:** filters, color and selected county are kept in the query string.
- **CSV export:** downloads the matching counties.
- **Layout and theme:** light/dark theme, and a slide-in filter drawer on phones.

## Project layout

```
index.html              page shell
css/styles.css          layout, theme tokens, controls
js/config.js            filter + metric definitions (drives sidebar, tooltip, detail, CSV)
js/data.js              loads geometry + data, joins on FIPS
js/filters.js           sidebar controls, percentile domains, match logic
js/map.js               D3 map, zoom, selection, favorites layer
js/app.js               state, matching loop, tooltip, panels, URL, CSV
data/counties.json      generated county data (columnar: fields[] + counties{fips: [...]})
data/state_policies.csv hand-maintained state-level values
scripts/build_data.py   rebuilds data/counties.json from the sources below
```

### Adding a metric

1. Emit a new key in `scripts/build_data.py` and rebuild.
2. Add an entry to `FILTERS` in `js/config.js` with `id` set to that key.

The sidebar, tooltip, detail panel, color-by menu and CSV export all pick it up automatically.

## Rebuilding the data

```bash
pip install -r scripts/requirements.txt
python scripts/build_data.py            # downloads into scripts/.cache (about 600 MB of ACS tables the first time)
python scripts/build_data.py --refresh  # ignore the cache
```

The script prints a coverage report for each metric. No API keys are needed: it uses the Census Bureau's bulk table files instead of the keyed Census API.

| Metrics | Source |
|---|---|
| Rent, home value, age, education, household size, foreign-born, veterans, commute, employment, unemployment, poverty, income, homeownership, vacant units, population | Census ACS 5-year detailed tables (table-based summary file) |
| Land area (for density), county names | Census Gazetteer 2020 |
| Obesity, uninsured, smoking, excessive drinking, alcohol-impaired driving deaths, exercise access, school test scores | County Health Rankings 2024 |
| Violent crime | County Health Rankings 2022 (FBI UCR) |
| Employer establishments | Census County Business Patterns |
| Summer and winter highs, precipitation (1991–2020 normals) | NOAA nClimDiv county data |
| Earthquake, hurricane, tornado, wildfire and drought risk | FEMA National Risk Index |
| Coastline | Census coastline counties list (2016) |
| Tax burden, cigarette tax, cannabis, abortion, gun carry | `data/state_policies.csv` (hand-maintained) |

### Caveats

- **State policy values** (`state_policies.csv`) were entered by hand. Tax burden is approximately the Tax Foundation's state + local figure. Laws change often, especially abortion, so check them before relying on them.
- **Connecticut:** the map geometry (2017) uses CT's 8 old counties, while newer Census, FEMA and County Health Rankings data use its 9 planning regions. Each old county borrows rates from the region that holds most of its population, and absolute counts (population, density, vacant units, establishments) are left blank. **Valdez-Cordova, AK** (split in 2019) is handled the same way. The detail panel flags these counties.
- **Not yet available:** humidity, sunshine, a mountains flag, "near a major airport" and the per-type crime breakdown. None of these has a free, keyless county-level source wired up yet.
- **Missing data:** while a filter is set, counties with no data for that metric are excluded. The `?` help icon on a filter shows its coverage.
