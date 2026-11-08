"""
Build data/counties.json from public, keyless data sources.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/build_data.py            # uses cached downloads in scripts/.cache
    python scripts/build_data.py --refresh  # re-download everything

Every source is keyed on the 5-digit county FIPS code. The map geometry
(us-atlas@3, 2017 vintage) still uses Connecticut's 8 old counties, so any
source that reports CT by planning region is mapped back with CT_REGION_FOR.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / ".cache"
OUT = ROOT / "data" / "counties.json"
POLICIES = ROOT / "data" / "state_policies.csv"

UA = {"User-Agent": "county-explorer-data-build/1.0"}

ACS_BASE = "https://www2.census.gov/programs-surveys/acs/summary_file/{y}/table-based-SF/data/5YRData/acsdt5y{y}-{t}.dat"
GAZ_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_counties_national.zip"
CHR_URL = "https://www.countyhealthrankings.org/sites/default/files/media/document/analytic_data{y}.csv"
CBP_URL = "https://www2.census.gov/programs-surveys/cbp/datasets/{y}/cbp{yy}co.zip"
COAST_URL = "https://www2.census.gov/library/stories/2018/08/coastline-counties-list.xlsx"
CLIMDIV_DIR = "https://www.ncei.noaa.gov/monitoring-content/data/us/climdiv/monthly/current/"
NRI_URL = (
    "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/"
    "National_Risk_Index_Counties/FeatureServer/0/query"
)

# Old CT county -> planning region holding most of its population (approximation).
CT_REGION_FOR = {
    "09001": "09190",  # Fairfield  -> Western Connecticut
    "09003": "09110",  # Hartford   -> Capitol
    "09005": "09160",  # Litchfield -> Northwest Hills
    "09007": "09130",  # Middlesex  -> Lower Connecticut River Valley
    "09009": "09170",  # New Haven  -> South Central Connecticut
    "09011": "09180",  # New London -> Southeastern Connecticut
    "09013": "09110",  # Tolland    -> Capitol
    "09015": "09150",  # Windham    -> Northeastern Connecticut
}
# Alaska: Valdez-Cordova (02261) split in 2019; the map still has 02261.
AK_FALLBACK = {"02261": "02063"}

# NOAA nClimDiv state codes -> FIPS state codes.
NOAA_STATE = {
    "01": "01", "02": "04", "03": "05", "04": "06", "05": "08", "06": "09", "07": "10",
    "08": "12", "09": "13", "10": "16", "11": "17", "12": "18", "13": "19", "14": "20",
    "15": "21", "16": "22", "17": "23", "18": "24", "19": "25", "20": "26", "21": "27",
    "22": "28", "23": "29", "24": "30", "25": "31", "26": "32", "27": "33", "28": "34",
    "29": "35", "30": "36", "31": "37", "32": "38", "33": "39", "34": "40", "35": "41",
    "36": "42", "37": "44", "38": "45", "39": "46", "40": "47", "41": "48", "42": "49",
    "43": "50", "44": "51", "45": "53", "46": "54", "47": "55", "48": "56",
    "49": "15", "50": "02",
}

NRI_RATING = {
    "Very Low": 1, "Relatively Low": 2, "Relatively Moderate": 3,
    "Relatively High": 4, "Very High": 5,
}

# ACS detailed tables and the estimate columns we need from each.
ACS_TABLES = {
    "b01003": ["E001"],                              # total population
    "b01002": ["E001"],                              # median age
    "b25064": ["E001"],                              # median gross rent
    "b25077": ["E001"],                              # median home value
    "b15003": ["E001", "E022", "E023", "E024", "E025"],  # education 25+
    "b25010": ["E001"],                              # avg household size
    "b05002": ["E001", "E013"],                      # nativity: foreign born
    "b21001": ["E001", "E002"],                      # veteran status
    "b08013": ["E001"],                              # aggregate travel time
    "b08303": ["E001"],                              # commuters (not WFH)
    "b23025": ["E001", "E003", "E004", "E005"],      # employment status
    "b17001": ["E001", "E002"],                      # poverty
    "b19301": ["E001"],                              # per capita income
    "b19013": ["E001"],                              # median household income
    "b25003": ["E001", "E002"],                      # tenure
    "b25002": ["E003"],                              # vacant housing units
}


# --------------------------------------------------------------------------- utils

def log(msg: str) -> None:
    print(msg, flush=True)


def fetch(url: str, dest: Path, refresh: bool, **kw) -> Path:
    if dest.exists() and dest.stat().st_size > 0 and not refresh:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            with requests.get(url, headers=UA, stream=True, timeout=120, **kw) as r:
                if r.status_code == 404:
                    break
                r.raise_for_status()
                tmp = dest.with_suffix(dest.suffix + ".part")
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                tmp.replace(dest)
            return dest
        except requests.RequestException as e:
            log(f"  retry {attempt + 1} for {url}: {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed to download {url}")


def num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # ACS uses large negative sentinels (-666666666 etc.); NOAA uses -99.99.
    if f <= -9999 or f == -99.99:
        return None
    return f


def ratio(a, b, scale=100.0):
    if a is None or not b:
        return None
    return a / b * scale


# --------------------------------------------------------------------------- sources

def latest_acs_year() -> int:
    this_year = date.today().year
    for y in range(this_year, this_year - 6, -1):
        url = ACS_BASE.format(y=y, t="b25064")
        try:
            r = requests.head(url, headers=UA, timeout=60, allow_redirects=True)
            if r.status_code == 200 and "html" not in r.headers.get("content-type", ""):
                return y
        except requests.RequestException:
            pass
    raise RuntimeError("no ACS 5-year table-based summary file found")


def load_acs_table(year: int, table: str, cols: list[str], refresh: bool) -> dict:
    """Stream a nationwide ACS table and keep only county rows (cached as small CSV)."""
    cached = CACHE / f"acs{year}_{table}_counties.csv"
    if not cached.exists() or refresh:
        url = ACS_BASE.format(y=year, t=table)
        log(f"  downloading ACS {table} ({year}) ...")
        rows = []
        with requests.get(url, headers=UA, stream=True, timeout=300) as r:
            r.raise_for_status()
            r.encoding = "utf-8"
            lines = r.iter_lines(decode_unicode=True)
            header = next(lines).split("|")
            for line in lines:
                if line and line.startswith("0500000US"):
                    rows.append(line)
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_text("|".join(header) + "\n" + "\n".join(rows), encoding="utf-8")
    out = {}
    with open(cached, encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="|")
        for row in reader:
            fips = row["GEO_ID"][-5:]
            out[fips] = {c: num(row.get(f"{table.upper()}_{c}")) for c in cols}
    return out


def load_acs(refresh: bool) -> tuple[int, dict]:
    year = latest_acs_year()
    log(f"ACS 5-year {year}: {len(ACS_TABLES)} tables")
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {t: ex.submit(load_acs_table, year, t, c, refresh) for t, c in ACS_TABLES.items()}
        tables = {t: f.result() for t, f in futures.items()}

    acs = {}
    for fips in tables["b01003"]:
        g = lambda t, c: tables[t].get(fips, {}).get(c)  # noqa: E731
        ba = [g("b15003", c) for c in ("E022", "E023", "E024", "E025")]
        acs[fips] = {
            "pop": g("b01003", "E001"),
            "median_age": g("b01002", "E001"),
            "rent": g("b25064", "E001"),
            "home_value": g("b25077", "E001"),
            "ba_plus": ratio(sum(x or 0 for x in ba), g("b15003", "E001")),
            "hh_size": g("b25010", "E001"),
            "foreign_born": ratio(g("b05002", "E013"), g("b05002", "E001")),
            "veterans": ratio(g("b21001", "E002"), g("b21001", "E001")),
            "commute": ratio(g("b08013", "E001"), g("b08303", "E001"), 1),
            "employment_rate": ratio(g("b23025", "E004"), g("b23025", "E001")),
            "unemployment": ratio(g("b23025", "E005"), g("b23025", "E003")),
            "poverty": ratio(g("b17001", "E002"), g("b17001", "E001")),
            "income_pc": g("b19301", "E001"),
            "hh_income": g("b19013", "E001"),
            "homeownership": ratio(g("b25003", "E002"), g("b25003", "E001")),
            "vacant_units": g("b25002", "E003"),
        }
    return year, acs


def load_gazetteer(refresh: bool) -> dict:
    p = fetch(GAZ_URL, CACHE / "gaz2020.zip", refresh)
    z = zipfile.ZipFile(p)
    text = z.read(z.namelist()[0]).decode("latin-1")
    out = {}
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    header = [h.strip() for h in next(reader)]
    idx = {h: i for i, h in enumerate(header)}
    for row in reader:
        row = [c.strip() for c in row]
        if len(row) < len(header):
            continue
        out[row[idx["GEOID"]]] = {
            "name": row[idx["NAME"]],
            "state": row[idx["USPS"]],
            "land_sqmi": num(row[idx["ALAND_SQMI"]]),
            "lat": num(row[idx["INTPTLAT"]]),
            "lon": num(row[idx["INTPTLONG"]]),
        }
    log(f"Gazetteer 2020: {len(out)} counties")
    return out


def load_chr(year: int, fields: dict, refresh: bool) -> dict:
    """County Health Rankings analytic CSV; fields maps out_key -> column code."""
    p = fetch(CHR_URL.format(y=year), CACHE / f"chr{year}.csv", refresh)
    with open(p, encoding="latin-1") as f:
        reader = csv.reader(f)
        next(reader)                      # human-readable header
        codes = next(reader)              # machine codes (v011_rawvalue, ...)
        idx = {c: i for i, c in enumerate(codes)}
        missing = [c for c in fields.values() if c not in idx]
        if missing:
            log(f"  CHR {year}: missing columns {missing}")
        out = {}
        us = {}
        for row in reader:
            fips = row[idx["fipscode"]]
            vals = {k: num(row[idx[c]]) if c in idx else None for k, c in fields.items()}
            if fips == "00000":
                us = vals
            elif not fips.endswith("000"):
                out[fips] = vals
    log(f"CHR {year}: {len(out)} counties")
    return out, us


def load_cbp(refresh: bool) -> tuple[int, dict]:
    for y in range(date.today().year - 1, date.today().year - 6, -1):
        url = CBP_URL.format(y=y, yy=str(y)[-2:])
        try:
            p = fetch(url, CACHE / f"cbp{y}.zip", refresh)
        except RuntimeError:
            continue
        z = zipfile.ZipFile(p)
        text = z.read(z.namelist()[0]).decode("latin-1")
        out = {}
        for row in csv.DictReader(io.StringIO(text)):
            if row["naics"].strip('"') == "------":
                out[row["fipstate"] + row["fipscty"]] = {"establishments": num(row["est"])}
        log(f"County Business Patterns {y}: {len(out)} counties")
        return y, out
    raise RuntimeError("no CBP file found")


# Counties whose shoreline touches a Great Lake or its connecting waters
# (St. Marys, St. Clair and Detroit rivers, Lake St. Clair, Niagara and
# St. Lawrence rivers). The Census coastline list covers only ocean/Gulf
# shores, so this set is maintained by hand (it matches NOAA's Great Lakes
# shoreline-county definition).
GREAT_LAKES_FIPS = {
    # Minnesota (Superior)
    "27031", "27075", "27137",
    # Wisconsin (Superior, Michigan)
    "55003", "55007", "55009", "55029", "55031", "55051", "55059", "55061",
    "55071", "55075", "55079", "55083", "55089", "55101", "55117",
    # Illinois / Indiana (Michigan)
    "17031", "17097", "18089", "18091", "18127",
    # Michigan (Superior, Michigan, Huron, St. Clair, Erie)
    "26001", "26003", "26005", "26007", "26009", "26011", "26013", "26017",
    "26019", "26021", "26029", "26031", "26033", "26041", "26047", "26053",
    "26055", "26061", "26063", "26069", "26083", "26089", "26095", "26097",
    "26099", "26101", "26103", "26105", "26109", "26115", "26121", "26127",
    "26131", "26139", "26141", "26147", "26151", "26153", "26157", "26159",
    "26163",
    # Ohio / Pennsylvania (Erie)
    "39007", "39035", "39043", "39085", "39093", "39095", "39123", "39143",
    "42049",
    # New York (Erie, Niagara River, Ontario, St. Lawrence River)
    "36011", "36013", "36029", "36045", "36055", "36063", "36073", "36075",
    "36089", "36117",
}


def load_coast(refresh: bool) -> dict:
    import openpyxl

    p = fetch(COAST_URL, CACHE / "coastline.xlsx", refresh)
    wb = openpyxl.load_workbook(p, read_only=True)
    out = {}
    for row in wb.active.iter_rows(values_only=True):
        if row and row[0] and re.fullmatch(r"\d{5}", str(row[0])):
            out[str(row[0])] = "Ocean"
    for fips in GREAT_LAKES_FIPS:
        out.setdefault(fips, "Great Lakes")
    log(f"Coastline counties: {len(out)} ({len(GREAT_LAKES_FIPS)} Great Lakes)")
    return out


def load_climate(refresh: bool) -> dict:
    """1991-2020 normals: July & January mean daily high (F), annual precipitation (in)."""
    listing = requests.get(CLIMDIV_DIR, headers=UA, timeout=60).text
    names = {}
    for kind in ("tmaxcy", "pcpncy"):
        found = sorted(set(re.findall(rf"climdiv-{kind}-v[\d.]+-\d{{8}}", listing)))
        if not found:
            raise RuntimeError(f"climdiv {kind} file not found")
        names[kind] = found[-1]

    def parse(kind):
        p = fetch(CLIMDIV_DIR + names[kind], CACHE / names[kind], refresh)
        data = {}
        with open(p) as f:
            for line in f:
                st, cty, year = line[0:2], line[2:5], int(line[7:11])
                if not 1991 <= year <= 2020 or st not in NOAA_STATE:
                    continue
                vals = [num(v) for v in line[11:].split()]
                data.setdefault(NOAA_STATE[st] + cty, []).append(vals)
        return data

    tmax, pcpn = parse("tmaxcy"), parse("pcpncy")

    def mean(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None

    out = {}
    for fips in set(tmax) | set(pcpn):
        t = tmax.get(fips, [])
        p = pcpn.get(fips, [])
        annual = [sum(v) for v in p if len(v) == 12 and all(x is not None for x in v)]
        out[fips] = {
            "summer_high": mean([v[6] for v in t if len(v) == 12]),
            "winter_high": mean([v[0] for v in t if len(v) == 12]),
            "precip": mean(annual),
        }
    log(f"NOAA climate normals ({names['tmaxcy']}): {len(out)} counties")
    return out


def load_nri(refresh: bool) -> dict:
    cached = CACHE / "nri_counties.json"
    if not cached.exists() or refresh:
        fields = "STCOFIPS,ERQK_RISKR,HRCN_RISKR,TRND_RISKR,WFIR_RISKR,DRGT_RISKR"
        feats, offset = [], 0
        while True:
            r = requests.get(NRI_URL, headers=UA, timeout=120, params={
                "where": "1=1", "outFields": fields, "returnGeometry": "false",
                "resultOffset": offset, "resultRecordCount": 2000, "f": "json",
                "orderByFields": "STCOFIPS",
            })
            r.raise_for_status()
            batch = [f["attributes"] for f in r.json().get("features", [])]
            feats += batch
            if len(batch) < 2000:
                break
            offset += 2000
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(feats))
    feats = json.loads(cached.read_text())
    key = {"ERQK_RISKR": "hz_earthquake", "HRCN_RISKR": "hz_hurricane",
           "TRND_RISKR": "hz_tornado", "WFIR_RISKR": "hz_wildfire", "DRGT_RISKR": "hz_drought"}
    out = {}
    for a in feats:
        out[a["STCOFIPS"]] = {k: NRI_RATING.get((a.get(src) or "").strip(), 0) for src, k in key.items()}
    log(f"FEMA National Risk Index: {len(out)} counties")
    return out


def load_policies() -> dict:
    out = {}
    with open(POLICIES, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out[row["fips"]] = {
                "tax_burden": num(row["tax_burden"]),
                "cig_tax": num(row["cig_tax"]),
                "cannabis": row["cannabis"],
                "abortion": row["abortion"],
                "carry": row["carry"],
            }
    return out


# --------------------------------------------------------------------------- merge

def lookup(source: dict, fips: str):
    """Find a county in a source, falling back across CT / AK boundary changes."""
    if fips in source:
        return source[fips]
    alt = CT_REGION_FOR.get(fips) or AK_FALLBACK.get(fips)
    return source.get(alt) if alt else None


ROUNDING = {
    "pop": 0, "density": 1, "rent": 0, "home_value": -3, "income_pc": -2, "hh_income": -2,
    "vacant_units": 0, "establishments": 0, "median_age": 1, "hh_size": 2, "commute": 1,
    "test_scores": 2, "precip": 1, "summer_high": 1, "winter_high": 1, "tax_burden": 1,
    "cig_tax": 2, "violent_crime": 2,
}


def rnd(k, v):
    if v is None or isinstance(v, str):
        return v
    d = ROUNDING.get(k, 1)
    v = round(v, d)
    return int(v) if d <= 0 else v


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="ignore cached downloads")
    args = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)

    gaz = load_gazetteer(args.refresh)
    acs_year, acs = load_acs(args.refresh)
    chr_now, chr_us = load_chr(2024, {
        "obesity": "v011_rawvalue", "uninsured": "v085_rawvalue",
        "alcohol_driving": "v134_rawvalue", "excessive_drinking": "v049_rawvalue",
        "smoking": "v009_rawvalue", "exercise": "v132_rawvalue",
        "reading": "v159_rawvalue", "math": "v160_rawvalue",
    }, args.refresh)
    chr_crime, _ = load_chr(2022, {"violent_crime": "v043_rawvalue"}, args.refresh)
    cbp_year, cbp = load_cbp(args.refresh)
    coast = load_coast(args.refresh)
    climate = load_climate(args.refresh)
    nri = load_nri(args.refresh)
    policies = load_policies()

    us_score = None
    if chr_us.get("reading") is not None and chr_us.get("math") is not None:
        us_score = (chr_us["reading"] + chr_us["math"]) / 2

    counties = {}
    for fips, g in sorted(gaz.items()):
        if fips[:2] == "72":  # Puerto Rico: not in most sources or the map
            continue
        rec = {"name": g["name"], "state": g["state"]}
        a = lookup(acs, fips) or {}
        rec.update(a)
        if a.get("pop") and g["land_sqmi"]:
            # CT/AK fallback rows describe a different area; density uses own land area
            rec["density"] = a["pop"] / g["land_sqmi"] if fips in acs else None

        h = lookup(chr_now, fips) or {}
        for k in ("obesity", "uninsured", "alcohol_driving", "excessive_drinking", "smoking", "exercise"):
            rec[k] = h[k] * 100 if h.get(k) is not None else None
        if us_score is not None and h.get("reading") is not None and h.get("math") is not None:
            rec["test_scores"] = (h["reading"] + h["math"]) / 2 - us_score

        c = lookup(chr_crime, fips) or {}
        vc = c.get("violent_crime")
        rec["violent_crime"] = vc / 100 if vc is not None else None  # per 100k -> per 1,000

        rec.update(lookup(cbp, fips) or {})
        rec.update(lookup(climate, fips) or {})
        rec.update(lookup(nri, fips) or {})
        rec["coast"] = coast.get(fips, "None")
        rec.update(policies.get(fips[:2], {}))

        if fips not in acs and fips in {**CT_REGION_FOR, **AK_FALLBACK}:
            # values borrowed from a different area: keep rates, drop absolute counts
            for k in ("pop", "density", "vacant_units", "establishments"):
                rec.pop(k, None)
            rec["approx"] = 1

        counties[fips] = {k: rnd(k, v) for k, v in rec.items() if v is not None}

    # Map still has Valdez-Cordova (02261); borrow rates from its successor area.
    for old, new in AK_FALLBACK.items():
        if old not in counties and new in counties:
            rec = {k: v for k, v in counties[new].items()
                   if k not in ("pop", "density", "vacant_units", "establishments")}
            rec.update(name="Valdez-Cordova Census Area", approx=1)
            counties[old] = rec

    # coverage report
    keys = sorted({k for r in counties.values() for k in r} - {"name", "state"})
    log(f"\n{len(counties)} counties written. Coverage by metric:")
    for k in keys:
        n = sum(1 for r in counties.values() if k in r)
        flag = "" if n / len(counties) > 0.95 else "   <-- low"
        log(f"  {k:20s} {n:5d}  {n / len(counties):6.1%}{flag}")

    payload = {
        "generated": date.today().isoformat(),
        "sources": {
            "acs": f"ACS 5-year {acs_year - 4}-{acs_year} (table-based summary file)",
            "chr": "County Health Rankings 2024 analytic data (violent crime: 2022 release)",
            "cbp": f"County Business Patterns {cbp_year}",
            "climate": "NOAA nClimDiv county normals 1991-2020",
            "hazards": "FEMA National Risk Index",
            "coast": "Census coastline counties list (2016); Great Lakes shoreline counties (NOAA definition)",
            "gazetteer": "Census Gazetteer 2020",
            "policies": "data/state_policies.csv (hand-maintained)",
        },
        # columnar rows keep the file small: counties[fips] = [value per field]
        "fields": ["name", "state"] + keys,
        "counties": {f: [r.get(k) for k in ["name", "state"] + keys] for f, r in counties.items()},
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    log(f"\nWrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
