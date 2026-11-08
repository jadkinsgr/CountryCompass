// County map: D3 + pre-projected us-atlas geometry (Albers USA, 975×610).

const W = 975, H = 610;

export function createMap(svgEl, { counties, states, nation, records }, handlers) {
  const svg = d3.select(svgEl).attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "xMidYMid meet");
  const path = d3.geoPath();
  const root = svg.append("g");

  const countyPaths = root.append("g")
    .selectAll("path")
    .data(counties)
    .join("path")
    .attr("class", "county")
    .attr("d", path)
    .on("mousemove", (event, d) => handlers.onHover?.(event, d.id))
    .on("mouseleave", () => handlers.onHover?.(null, null))
    .on("click", (event, d) => { event.stopPropagation(); handlers.onClick?.(d.id); });

  root.append("path").datum(states).attr("class", "states").attr("d", path);
  root.append("path").datum(nation).attr("class", "nation").attr("d", path);
  const favLayer = root.append("g");

  const featureById = new Map(counties.map((f) => [f.id, f]));
  const recById = new Map(records.map((r) => [r.fips, r]));

  // --- zoom ---------------------------------------------------------------
  const zoom = d3.zoom()
    .scaleExtent([1, 16])
    .translateExtent([[-100, -100], [W + 100, H + 100]])
    .on("zoom", (event) => {
      root.attr("transform", event.transform);
      favLayer.selectAll("circle").attr("r", 4 / event.transform.k);
    });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", () => handlers.onClick?.(null));

  function zoomBy(k) { svg.transition().duration(300).call(zoom.scaleBy, k); }
  function resetZoom() { svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); }
  function zoomTo(fips) {
    const f = featureById.get(fips);
    if (!f) return;
    const [[x0, y0], [x1, y1]] = path.bounds(f);
    const k = Math.min(8, 0.4 / Math.max((x1 - x0) / W, (y1 - y0) / H));
    const t = d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    svg.transition().duration(650).call(zoom.transform, t);
  }

  // --- styling ------------------------------------------------------------
  /**
   * @param matches Set of matching FIPS
   * @param colorOf optional (record) => color | null  (null => no data)
   */
  function update(matches, colorOf) {
    countyPaths.each(function (d) {
      const rec = recById.get(d.id);
      const isMatch = matches.has(d.id);
      let fill = null, cls = "county";
      if (!isMatch) cls += " nomatch";
      else if (colorOf) {
        fill = colorOf(rec);
        if (!fill) cls += " nodata";
      } else {
        fill = "var(--match)";
      }
      if (d.id === selectedId) cls += " selected";
      this.setAttribute("class", cls);
      if (fill) this.style.fill = fill; else this.style.removeProperty("fill");
    });
  }

  let selectedId = null;
  function select(fips) {
    selectedId = fips;
    countyPaths.classed("selected", (d) => d.id === fips);
    if (fips) countyPaths.filter((d) => d.id === fips).raise();
  }

  function setFavorites(favs) {
    const k = d3.zoomTransform(svgEl).k;
    favLayer.selectAll("circle")
      .data([...favs].filter((id) => featureById.has(id)), (id) => id)
      .join("circle")
      .attr("class", "fav-dot")
      .attr("r", 4 / k)
      .attr("cx", (id) => path.centroid(featureById.get(id))[0])
      .attr("cy", (id) => path.centroid(featureById.get(id))[1]);
  }

  return { update, select, zoomTo, zoomBy, resetZoom, setFavorites };
}
