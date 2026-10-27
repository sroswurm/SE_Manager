// Proposal PDF (PDFKit). Letter size, TNSE letterhead, numbered sections, signature block.
const PDFDocument = require("pdfkit");

const NAVY = "#1F3A5F", GREY = "#5A6472", RULE = "#C9D1DB", SHADE = "#EEF2F6";
const money = (v) => `$${Math.round(Number(v) || 0).toLocaleString("en-US")}`;
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };

function buildProposalPdf({ cfg, project, client, lead, fee, milestones, rev, date }) {
  return new Promise((resolve, reject) => {
    const M = 54; // 0.75"
    const doc = new PDFDocument({ size: "LETTER", margins: { top: M, bottom: M + 14, left: M, right: M }, bufferPages: true,
      info: { Title: `${project.project_no} ${project.name} — Proposal R${rev}`, Author: cfg.firm.name } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 2 * M;
    const firm = cfg.firm;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

    // ── Letterhead
    doc.font("Helvetica-Bold").fontSize(16).fillColor(NAVY).text(firm.name.toUpperCase(), M, M, { characterSpacing: 0.5 });
    doc.font("Helvetica").fontSize(8.5).fillColor(GREY)
      .text(`${firm.address1}  ·  ${firm.address2}  ·  ${firm.phone}  ·  ${firm.email}  ·  ${firm.web}`)
      .text(firm.coa);
    doc.moveTo(M, doc.y + 6).lineTo(M + W, doc.y + 6).lineWidth(1.5).strokeColor(NAVY).stroke();
    doc.y += 18;

    // ── Title + meta
    const topY = doc.y;
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text("Proposal for Structural Engineering Services", M, topY, { width: W * 0.6 });
    const meta = [["Date", fmtDate(date)], ["Proposal No.", `${project.project_no}-R${rev}`], ["Valid Through", fmtDate(addDays(date, cfg.proposal.validity_days || 30))]];
    let my = topY;
    for (const [k, v] of meta) {
      doc.font("Helvetica").fontSize(8.5).fillColor(GREY).text(k, M + W * 0.62, my, { width: W * 0.15 });
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#111").text(v, M + W * 0.77, my, { width: W * 0.23, align: "right" });
      my += 13;
    }
    doc.y = Math.max(doc.y, my) + 12;

    // ── Addressee + Re
    const toLines = [client.contact_name, client.title, client.company, client.address,
      [client.city, client.state].filter(Boolean).join(", ") + (client.zip ? ` ${client.zip}` : ""),
      [client.email, client.phone].filter(Boolean).join("  ·  ")].filter((s) => s && String(s).trim());
    doc.font("Helvetica").fontSize(10).fillColor("#111");
    for (const l of toLines) doc.text(l, M);
    doc.moveDown(0.8);
    const site = [project.address, [project.city, project.state].filter(Boolean).join(", ")].filter(Boolean).join(", ");
    doc.font("Helvetica-Bold").text("Re:  ", M, doc.y, { continued: true }).font("Helvetica").text(`${project.name}${site ? ` — ${site}` : ""}  (TNSE Project ${project.project_no})`);
    doc.moveDown(0.8);
    doc.text(`Dear ${client.contact_name ? client.contact_name.split(" ")[0] : "Sir or Madam"},`).moveDown(0.5);
    doc.text(cfg.proposal.intro, { align: "justify" });

    // ── Section helpers
    let sec = 0;
    const heading = (t) => {
      ensure(40);
      doc.moveDown(1);
      const y = doc.y;
      doc.rect(M, y, W, 17).fill(SHADE);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY).text(`${++sec}.  ${t.toUpperCase()}`, M + 6, y + 4.5, { characterSpacing: 0.4 });
      doc.y = y + 24; doc.x = M;
      doc.font("Helvetica").fontSize(10).fillColor("#111");
    };
    const bullets = (items, numbered = false) => {
      items.forEach((it, i) => {
        ensure(16);
        const y = doc.y;
        doc.font("Helvetica").fontSize(10).fillColor("#111").text(numbered ? `${i + 1}.` : "•", M + 6, y, { width: 16 });
        doc.text(it, M + 24, y, { width: W - 24, align: "left" });
        doc.moveDown(0.25);
      });
      doc.x = M;
    };
    const table = (cols, rows, { totalRow } = {}) => {
      const pad = 5;
      const drawRow = (cells, { bold = false, fill } = {}) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
        const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c ?? ""), { width: cols[i].w - 2 * pad }))) + 2 * pad;
        if (doc.y + h > bottom()) { doc.addPage(); drawHeader(); doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5); }
        const y = doc.y;
        if (fill) doc.rect(M, y, W, h).fill(fill);
        let x = M;
        cells.forEach((c, i) => {
          doc.fillColor(fill === NAVY ? "#FFF" : "#111").text(String(c ?? ""), x + pad, y + pad, { width: cols[i].w - 2 * pad, align: cols[i].align || "left" });
          x += cols[i].w;
        });
        doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.y = y + h;
      };
      const drawHeader = () => drawRow(cols.map((c) => c.label), { bold: true, fill: NAVY });
      ensure(60);
      drawHeader();
      rows.forEach((r, i) => drawRow(r, { fill: i % 2 ? "#FAFBFC" : undefined }));
      if (totalRow) drawRow(totalRow, { bold: true, fill: SHADE });
      doc.x = M; doc.font("Helvetica").fontSize(10).fillColor("#111"); doc.moveDown(0.4);
    };
    const colsW = (fracs) => fracs.map((f) => f * W);

    // 1. Project understanding
    heading("Project Understanding");
    doc.text(project.description || `Structural engineering services for ${project.name}.`, { align: "justify" });
    const facts = [project.project_type && `Project type: ${project.project_type}`, Number(project.sf) > 0 && `Approximate area: ${Number(project.sf).toLocaleString()} SF`,
      project.expedite && project.expedite !== "Standard" && `Schedule: ${project.expedite}`].filter(Boolean);
    if (facts.length) { doc.moveDown(0.4); doc.fillColor(GREY).fontSize(9).text(facts.join("   ·   ")); doc.fillColor("#111").fontSize(10); }

    // 2. Scope
    heading("Scope of Services");
    const designItems = fee.design_lines.map((l) => (l.description ? `${l.type}: ${l.description}` : l.type));
    if (designItems.length) { doc.text("TNSE will provide the following design services:"); doc.moveDown(0.3); bullets(designItems, true); }
    if (fee.addon_lines.length) {
      doc.moveDown(0.3).text("The following services will be provided as requested and billed as performed:");
      doc.moveDown(0.3);
      bullets(fee.addon_lines.map((l) => (l.description ? `${l.type}: ${l.description}` : l.type)));
    }

    // 3. Deliverables & schedule
    if (milestones.length) {
      heading("Deliverables & Schedule");
      doc.text(`Submittals will be issued at the following milestones${project.start_date ? `, measured from notice to proceed (anticipated ${fmtDate(project.start_date)})` : ""}:`);
      doc.moveDown(0.4);
      const rows = milestones.map((m) => [`${m.milestone}% ${Number(m.milestone) === 100 ? "Construction Documents" : "Progress Set"}${m.note ? ` — ${m.note}` : ""}`,
        fmtDate(m.target_date), `${Number(m.billing_pct)}%`, money((fee.design_fee * Number(m.billing_pct)) / 100)]);
      table([{ label: "Milestone", w: W * 0.46 }, { label: "Target Date", w: W * 0.22 }, { label: "Billing", w: W * 0.12, align: "right" }, { label: "Amount", w: W * 0.2, align: "right" }], rows,
        { totalRow: ["Design fee", "", `${milestones.reduce((s, m) => s + Number(m.billing_pct), 0)}%`, money(fee.design_fee)] });
      doc.fontSize(8.5).fillColor(GREY).text("Target dates assume timely receipt of required client information and are subject to review-cycle durations outside TNSE's control.").fillColor("#111").fontSize(10);
    }

    // 4. Fee
    heading("Fee");
    const feeRows = [];
    if (fee.design_lines.length && fee.design_lines.some((l) => l.proposal_fee)) {
      for (const l of fee.design_lines) feeRows.push([l.type, "Lump sum", money(l.proposal_fee)]);
    } else if (fee.design_fee) feeRows.push(["Structural design services", "Lump sum", money(fee.design_fee)]);
    for (const l of fee.addon_lines) {
      const basis = l.basis === "each" ? `${l.qty} ${l.unit || "ea"}${Number(l.qty) === 1 ? "" : "s"} @ ${money(l.unit_fee)}`
        : l.basis === "hourly" ? `Est. ${l.hours} hr @ ${money(l.rate)}/hr` : "Lump sum";
      feeRows.push([l.type, basis, money(l.fee)]);
    }
    table([{ label: "Service", w: W * 0.5 }, { label: "Basis", w: W * 0.3 }, { label: "Fee", w: W * 0.2, align: "right" }], feeRows,
      { totalRow: ["Total", "", money(fee.total)] });
    const feeNotes = [];
    if (fee.addon_lines.length) feeNotes.push("Per-unit and hourly items are estimates and will be billed for actual quantities performed.");
    if (fee.expedite !== "Standard") feeNotes.push(`Fee reflects the ${fee.expedite.toLowerCase()} schedule requested.`);
    if (feeNotes.length) doc.fontSize(8.5).fillColor(GREY).text(feeNotes.join(" ")).fillColor("#111").fontSize(10);

    // 5. Additional services / rates
    heading("Additional Services");
    doc.text("Services beyond the scope above will be performed with prior authorization at the following hourly rates:");
    doc.moveDown(0.4);
    const rateLabels = { engineering: "Professional Engineer", eit: "Engineer Intern (EI)", drafting: "Drafting / BIM", admin: "Administrative" };
    table([{ label: "Classification", w: W * 0.7 }, { label: "Rate", w: W * 0.3, align: "right" }],
      Object.entries(cfg.rates).filter(([k, v]) => !k.startsWith("_") && Number(v) > 0).map(([k, v]) => [rateLabels[k] || k, `${money(v)}/hr`]));

    // 6–8. Assumptions, exclusions, terms
    if (project.assumptions.length) { heading("Assumptions"); bullets(project.assumptions); }
    if (project.exclusions.length) { heading("Exclusions"); bullets(project.exclusions); }
    heading("Terms");
    bullets(cfg.proposal.terms);

    // Acceptance
    ensure(190);
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10).fillColor("#111").text("We appreciate the opportunity to work with you. To authorize these services, please sign below and return a copy to TNSE.", M, doc.y, { width: W });
    doc.moveDown(1.2);
    const colW = (W - 30) / 2, y0 = doc.y;
    const sigBlock = (x, title, name, sub) => {
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(NAVY).text(title, x, y0, { width: colW });
      let y = y0 + 34;
      for (const lbl of ["Signature", "Name", "Title", "Date"]) {
        doc.moveTo(x + 55, y + 10).lineTo(x + colW, y + 10).lineWidth(0.6).strokeColor("#888").stroke();
        doc.font("Helvetica").fontSize(8.5).fillColor(GREY).text(lbl, x, y + 2, { width: 52 });
        if (lbl === "Name" && name) doc.font("Helvetica").fontSize(9.5).fillColor("#111").text(name, x + 58, y + 1, { width: colW - 58 });
        if (lbl === "Title" && sub) doc.font("Helvetica").fontSize(9.5).fillColor("#111").text(sub, x + 58, y + 1, { width: colW - 58 });
        y += 26;
      }
    };
    sigBlock(M, `SUBMITTED — ${firm.name}`, firm.signer_name, firm.signer_title);
    sigBlock(M + colW + 30, `ACCEPTED — ${client.company || client.contact_name || "Client"}`, "", "");

    // Footers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // writing in the footer band must not trigger a page break
      const fy = doc.page.height - M + 6;
      doc.moveTo(M, fy - 6).lineTo(M + W, fy - 6).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.font("Helvetica").fontSize(7.5).fillColor(GREY)
        .text(`${firm.short} Proposal ${project.project_no}-R${rev}  ·  ${project.name}`, M, fy, { width: W * 0.75, lineBreak: false })
        .text(`Page ${i + 1} of ${range.count}`, M + W * 0.75, fy, { width: W * 0.25, align: "right", lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { buildProposalPdf };
