// Fee model. Design fee = average of the enabled methods (hourly scope, $/SF, FL DMS curve,
// historic comparables) × expedite multiplier. Add-ons (inspections, CA, reviews) are priced
// per unit / hourly on top and are not averaged.

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const num = (v) => (v === "" || v === null || v === undefined || isNaN(Number(v)) ? 0 : Number(v));
const roundTo = (v, step) => (step > 0 ? Math.round(v / step) * step : Math.round(v));

function dmsPct(curve, budget) {
  const pts = [...curve].filter((p) => p.budget > 0 && p.pct > 0).sort((a, b) => a.budget - b.budget);
  if (!pts.length || budget <= 0) return NaN;
  if (budget <= pts[0].budget) return pts[0].pct;
  if (budget >= pts[pts.length - 1].budget) return pts[pts.length - 1].pct;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (budget <= b.budget) {
      const t = (Math.log(budget) - Math.log(a.budget)) / (Math.log(b.budget) - Math.log(a.budget));
      return a.pct + t * (b.pct - a.pct);
    }
  }
  return NaN;
}

// Fill defaults for a scope line from the deliverable catalog and compute its fee.
function priceLine(line, cfg) {
  const cat = cfg.deliverable_types.find((d) => d.type === line.type) || {};
  const l = { ...line };
  l.pool = l.pool || cat.pool || "design";
  l.basis = l.basis || cat.basis || "hourly";
  l.rate_key = l.rate_key || cat.rate || "engineering";
  l.rate = num(l.rate) || num(cfg.rates[l.rate_key]);
  l.unit = l.unit || cat.unit || "";
  if (l.basis === "hourly") {
    l.hours = l.hours === undefined || l.hours === "" ? num(cat.hours) : num(l.hours);
    l.qty = ""; l.unit_fee = "";
    l.fee = l.hours * l.rate;
  } else if (l.basis === "each") {
    l.hours = l.hours === undefined || l.hours === "" ? num(cat.hours) : num(l.hours);
    l.qty = num(l.qty) || 1;
    l.unit_fee = num(l.unit_fee) || l.hours * l.rate;
    l.fee = l.qty * l.unit_fee;
  } else { // lump
    l.qty = ""; l.hours = num(l.hours);
    l.unit_fee = num(l.unit_fee) || num(l.fee) || l.hours * l.rate;
    l.fee = l.unit_fee;
  }
  return l;
}

function estimateFee({ project, lines, history, cfg, options = {} }) {
  const fm = cfg.fee_model;
  const ptype = cfg.project_types.find((t) => t.name === project.project_type) || { dms_factor: 1, area_methods: false };
  const priced = lines.map((l) => priceLine(l, cfg));
  const design = priced.filter((l) => l.pool === "design");
  const addons = priced.filter((l) => l.pool === "addon");
  const hourlyFee = design.reduce((s, l) => s + l.fee, 0);
  const designHours = design.reduce((s, l) => s + (l.basis === "hourly" ? l.hours : 0), 0);

  const sf = num(project.sf);
  const valueGiven = num(project.construction_value);
  const value = valueGiven || sf * num(fm.value_per_sf);

  const methods = [];
  methods.push({
    key: "hourly", label: "Hourly (scope build-up)", available: hourlyFee > 0, fee: hourlyFee,
    detail: `${designHours.toFixed(1)} hr across ${design.length} design line(s)`,
  });
  // A $/SF entered for this project overrides the config rate (and opts in project types without area methods).
  const sfRate = num(options.sf_rate) || num(fm.sf_rate);
  methods.push({
    key: "area", label: "Area ($/SF)", available: sf > 0 && (ptype.area_methods || num(options.sf_rate) > 0), fee: sf * sfRate,
    detail: sf > 0 ? `${sf.toLocaleString()} SF × $${sfRate.toFixed(2)}/SF` : "needs SF",
  });
  const pct = dmsPct(fm.dms_curve, value) * num(ptype.dms_factor || 1);
  const share = num(fm.structural_share_pct) / 100;
  const dmsCalc = value > 0 && ptype.area_methods && isFinite(pct);
  const dmsFee = value * (pct / 100) * share;
  methods.push({
    key: "dms", label: "FL DMS fee curve", available: dmsCalc, fee: dmsCalc ? dmsFee : 0,
    detail: value > 0 ? `$${Math.round(value).toLocaleString()}${valueGiven ? "" : " (est. from SF)"} × ${isFinite(pct) ? pct.toFixed(2) : "—"}% × ${(share * 100).toFixed(0)}% structural` : "needs SF or construction value",
  });

  // Historic comparables: same project type; scaled by $/SF when SF is known on both sides.
  const sameType = (history || []).filter((h) => h.project_type === project.project_type && num(h.fee) > 0 && String(h.project_no) !== String(project.project_no));
  let comps = [], histFee = NaN, histDetail;
  const [lo, hi] = fm.historic_sf_band || [0.33, 3];
  if (sf > 0) {
    comps = sameType.filter((h) => num(h.sf) > 0 && num(h.sf) / sf >= lo && num(h.sf) / sf <= hi);
    const psf = median(comps.map((h) => num(h.fee) / num(h.sf)));
    histFee = psf * sf;
    histDetail = `median $${isFinite(psf) ? psf.toFixed(2) : "—"}/SF from ${comps.length} comparable(s)`;
  } else {
    comps = sameType;
    histFee = median(comps.map((h) => num(h.fee)));
    histDetail = `median fee of ${comps.length} same-type project(s)`;
  }
  methods.push({
    key: "historic", label: "Historic comparables", available: comps.length >= num(fm.historic_min_comps || 3) && isFinite(histFee),
    fee: isFinite(histFee) ? histFee : 0,
    detail: comps.length < num(fm.historic_min_comps || 3) ? `${comps.length} comparable(s) — need ${fm.historic_min_comps}` : histDetail,
    comps: comps.map((h) => ({ project_no: h.project_no, name: h.name, sf: h.sf, fee: h.fee })),
  });

  // Fees entered by hand replace the calculated curve / comparables figure.
  for (const [key, opt] of [["dms", "dms_fee"], ["historic", "historic_fee"]]) {
    const m = methods.find((x) => x.key === key), v = num(options[opt]);
    if (v <= 0) continue;
    m.detail = `entered manually${m.available ? ` (calculated: $${Math.round(m.fee).toLocaleString()})` : ""}`;
    Object.assign(m, { available: true, fee: v, manual: true });
  }

  const toggles = options.methods || {};
  for (const m of methods) m.enabled = m.available && (toggles[m.key] !== undefined ? !!toggles[m.key] : true);
  const used = methods.filter((m) => m.enabled);
  const base = used.length ? used.reduce((s, m) => s + m.fee, 0) / used.length : 0;

  const exp = (fm.expedite || {})[project.expedite || "Standard"] || { fee_multiplier: 1 };
  const overridden = num(options.design_override) > 0;
  const designFee = roundTo(overridden ? num(options.design_override) : base * num(exp.fee_multiplier || 1), num(fm.round_to));
  const addonFee = addons.reduce((s, l) => s + l.fee, 0); // itemized on the proposal, so not rounded

  // Allocate the design fee back to the design lines (proportional to their build-up) for the proposal.
  const alloc = design.map((l) => ({ ...l, proposal_fee: hourlyFee > 0 ? roundTo((designFee * l.fee) / hourlyFee, num(fm.round_to)) : 0 }));
  if (alloc.length && hourlyFee > 0) {
    const diff = designFee - alloc.reduce((s, l) => s + l.proposal_fee, 0);
    alloc[alloc.length - 1].proposal_fee += diff; // keep the allocation summing exactly
  }

  const warnings = [];
  const fees = used.map((m) => m.fee).filter((f) => f > 0);
  if (fees.length > 1 && Math.max(...fees) / Math.min(...fees) > 2.5) {
    warnings.push(`Methods disagree by ${(Math.max(...fees) / Math.min(...fees)).toFixed(1)}× — review which ones fit this project before using the average.`);
  }

  return {
    warnings, methods, base: Math.round(base), expedite: project.expedite || "Standard",
    expedite_multiplier: num(exp.fee_multiplier || 1), overridden,
    design_fee: designFee, addon_fee: addonFee, total: designFee + addonFee,
    per_sf: sf > 0 ? (designFee + addonFee) / sf : null,
    pct_of_construction: value > 0 ? ((designFee + addonFee) / value) * 100 : null,
    design_lines: alloc, addon_lines: addons, priced_lines: priced,
  };
}

module.exports = { estimateFee, priceLine, dmsPct, roundTo };
