// Rule-based reader for a pasted RFP email (or text message / call notes).
// Produces a draft of lead, client, project and scope fields, each with a confidence level,
// for review before anything is saved. Keyword lists live in config.json → email_parser.

const STATES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };
const ABBRS = new Set(Object.values(STATES));
// Fallback when a town is named without a state. Add more under email_parser.known_cities.
const KNOWN_CITIES = {
  pensacola: "FL", "pensacola beach": "FL", navarre: "FL", milton: "FL", pace: "FL", "gulf breeze": "FL", cantonment: "FL", molino: "FL", century: "FL",
  "perdido key": "FL", destin: "FL", "fort walton beach": "FL", "mary esther": "FL", niceville: "FL", valparaiso: "FL", shalimar: "FL", crestview: "FL",
  baker: "FL", freeport: "FL", "defuniak springs": "FL", "santa rosa beach": "FL", "miramar beach": "FL", "panama city": "FL", "panama city beach": "FL",
  "lynn haven": "FL", tallahassee: "FL", mobile: "AL", "gulf shores": "AL", "orange beach": "AL", foley: "AL", fairhope: "AL", daphne: "AL",
  "spanish fort": "AL", robertsdale: "AL", "bay minette": "AL", atmore: "AL", biloxi: "MS", gulfport: "MS", "ocean springs": "MS",
};
const FREE_MAIL = /(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|comcast|att|bellsouth|cox|protonmail)\.(com|net)$/i;
const SUFFIX = "St|Street|Rd|Road|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Hwy|Highway|Pkwy|Parkway|Cir|Circle|Pl|Place|Trl|Trail|Ter|Terrace|Loop|Pike|Cove|Sq|Square|Row|Pass|Point|Pt|Path";
const STREET_RE = new RegExp(`\\b\\d{1,6}\\s+(?:(?:US|U\\.S\\.|SR|CR|State Road|County Road|Hwy|Highway|Route|Rte)\\s*\\d{1,4}[A-Z]?\\b|(?:[NSEW]\\.?\\s+)?(?:[A-Z0-9][\\w.'-]*\\s+){0,5}(?:${SUFFIX})\\b\\.?(?:\\s+\\d{1,4}[A-Z]?\\b(?=\\s*(?:,|$|\\n)))?)(?:\\s+(?:Unit|Ste|Suite|#)\\s*[\\w-]+)?`, "g");
const CITY_ST_RE = /\b([A-Z][a-zA-Z.]+(?:[ \t][A-Z][a-zA-Z.]+){0,2}),?[ \t]+([A-Z]{2})\.?[ \t]*(\d{5})?(?:-\d{4})?\b/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SIGNOFF_RE = /^\s*(thanks|thank you|thanks again|many thanks|regards|best regards|kind regards|warm regards|best|sincerely|respectfully|cheers|v\/r|talk soon|appreciate it)\b[\s,!.]*\S{0,0}.*$/i;
const TITLE_RE = /\b(president|vice president|vp|owner|principal|partner|director|manager|pm|project manager|superintendent|estimator|architect|aia|engineer|p\.e\.?|coordinator|developer|administrator|ceo|coo|cfo|founder|associate|designer|pastor|facilities)\b/i;
const COMPANY_RE = /\b(llc|l\.l\.c\.|inc\.?|incorporated|corp\.?|corporation|co\.|company|construction|constructors|builders|building|contractors?|contracting|architects?|architecture|design|group|development|developers|properties|homes|engineering|consultants?|partners|enterprises|services|church|ministries|county|city of|school|district|authority|associates|signs?|signarama|roofing|steel|improvements?|remodeling|renovations?|restoration|solutions|industries|holdings|realty|management|investments|ventures|commission|department|hospital|medical|university|college)\b/i;
const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, a: 1, an: 1, single: 1 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const hasPhone = (s) => new RegExp(PHONE_RE.source).test(s);
const hasEmail = (s) => new RegExp(EMAIL_RE.source).test(s);
const hasStreet = (s) => new RegExp(STREET_RE.source).test(s);
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const iso = (d) => d.toLocaleDateString("en-CA");
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

function parseDate(str, ref) {
  const s = str.toLowerCase().trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    let y = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : ref.getFullYear();
    let d = new Date(y, Number(m[1]) - 1, Number(m[2]), 12);
    if (!m[3] && d < ref) d.setFullYear(y + 1);
    return isNaN(d) ? null : iso(d);
  }
  m = s.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3));
    let d = new Date(m[3] ? Number(m[3]) : ref.getFullYear(), mo, Number(m[2]), 12);
    if (!m[3] && d < ref) d.setFullYear(d.getFullYear() + 1);
    return iso(d);
  }
  m = s.match(/^(?:next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (m) {
    const d = new Date(ref); d.setHours(12);
    const target = WEEKDAYS.indexOf(m[1]);
    let add = (target - d.getDay() + 7) % 7 || 7;
    if (/^next/.test(s) && add < 7) add += 7;
    d.setDate(d.getDate() + add);
    return iso(d);
  }
  if (/^tomorrow/.test(s)) { const d = new Date(ref); d.setDate(d.getDate() + 1); return iso(d); }
  if (/^end of (the )?week/.test(s)) return parseDate("friday", ref);
  if (/^end of (the )?month/.test(s)) return iso(new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 12));
  return null;
}

function splitHeaders(text) {
  // Pull From/Sent/Date/Subject lines (Outlook, Gmail and forwarded formats) out of the body.
  const headers = [];
  const bodyLines = [];
  let cur = null, block = 0;
  for (const line of text.split("\n")) {
    const h = line.match(/^\s*\**(From|Sent|Date|To|Cc|Subject)\**\s*:\s*(.*)$/i);
    if (h) {
      const k = h[1].toLowerCase();
      if (k === "from" || !cur) {
        if (bodyLines.some((l) => l.trim() && l !== "\n@@SPLIT@@\n")) { bodyLines.push("\n@@SPLIT@@\n"); block++; }
        cur = { block }; headers.push(cur);
      }
      if (!(k in cur)) cur[k] = h[2].trim();
      continue;
    }
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(line) || /^on .+ wrote:$/i.test(line.trim())) {
      cur = null;
      if (bodyLines.some((l) => l.trim() && l !== "\n@@SPLIT@@\n")) { bodyLines.push("\n@@SPLIT@@\n"); block++; }
      continue;
    }
    bodyLines.push(line);
  }
  return { headers, body: bodyLines.join("\n") };
}

function parseEmail(rawText, cfg, { now = new Date() } = {}) {
  const P = cfg.email_parser || {};
  const ignoreDomains = (P.ignore_domains || []).map((d) => d.toLowerCase());
  const ignorePhones = new Set((P.ignore_phones || []).map(digits));
  const cities = { ...KNOWN_CITIES, ...Object.fromEntries(Object.entries(P.known_cities || {}).map(([k, v]) => [k.toLowerCase(), v])) };
  const conf = {}, notes = [];
  const set = (obj, k, v, c, why) => { if (v !== undefined && v !== null && v !== "") { obj[k] = v; conf[k] = c; if (why) notes.push(`${k}: ${why}`); } };

  const text = String(rawText || "").replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n").map((l) => l.replace(/^\s*>+\s?/, "")).join("\n");
  const { headers, body: fullBody } = splitHeaders(text);
  // Use the newest message that isn't from TNSE (a reply chain or forward from Jacob).
  const isOurs = (s) => ignoreDomains.some((d) => String(s || "").toLowerCase().includes(d));
  const hdr = headers.find((h) => h.from && !isOurs(h.from)) || headers[0] || {};
  const subject = (headers.find((h) => h.subject) || {}).subject || "";
  const sentDate = hdr.sent || hdr.date ? new Date(String(hdr.sent || hdr.date).replace(/ at /i, " ")) : null;
  const ref = sentDate && !isNaN(sentDate) ? sentDate : now;

  // Choose the message block: first block whose text isn't empty and isn't just ours.
  const blocks = fullBody.split("@@SPLIT@@").map((b) => b.trim());
  const body = (hdr.block !== undefined && blocks[hdr.block]) || blocks.find((b) => b && !isOurs(b.slice(-400))) || blocks.find(Boolean) || "";
  const lines = body.split("\n").map((l) => l.trim());

  // Signature = lines after the sign-off (or the trailing contact block).
  let so = lines.findIndex((l) => SIGNOFF_RE.test(l) && l.length < 40);
  let sig = [], main = lines;
  if (so >= 0) {
    sig = lines.slice(so + 1).filter(Boolean).filter((l) => !/confidential|intended recipient|disclaimer|sent from my/i.test(l)).slice(0, 9);
    main = lines.slice(0, so);
  } else {
    // No sign-off: treat a trailing block of short contact-ish lines as the signature.
    const nonEmpty = lines.filter(Boolean);
    let k = nonEmpty.length;
    while (k > 0 && nonEmpty.length - k < 6 && nonEmpty[k - 1].length < 60) k--;
    const tail = nonEmpty.slice(k);
    if (k > 0 && tail.some((l) => hasPhone(l) || hasEmail(l))) { sig = tail; main = nonEmpty.slice(0, k); }
  }
  const mainText = main.join("\n");
  const sigText = sig.join("\n");
  const lc = `${subject}\n${mainText}`.toLowerCase();

  const lead = { source: headers.length ? "email" : (text.length < 400 ? "text" : "email") };
  const client = {};
  const project = {};

  // ── Contact name / email
  const fm = String(hdr.from || "").match(/^"?([^"<]*?)"?\s*<([^>]+)>/) || String(hdr.from || "").match(/^()\s*([^\s]+@[^\s]+)$/);
  if (fm && fm[1] && !fm[1].includes("@")) {
    let name = clean(fm[1]);
    if (/,/.test(name)) { const [last, first] = name.split(",").map(clean); name = `${first} ${last}`; } // "Hill, Sam"
    set(lead, "contact_name", name, "high", "From header");
  }
  const emails = [...`${hdr.from || ""}\n${sigText}\n${mainText}`.matchAll(EMAIL_RE)].map((m) => m[0].replace(/[.,;]+$/, "")).filter((e) => !isOurs(e));
  if (fm && fm[2] && !isOurs(fm[2])) set(lead, "email", fm[2].trim(), "high", "From header");
  else if (emails[0]) set(lead, "email", emails[0], sig.join(" ").includes(emails[0]) ? "high" : "med");

  if (!lead.contact_name) {
    const intro = mainText.match(/\b(?:my name is|this is|i am|i'm)\s+([A-Z][a-z]+(?:\s[A-Z][a-z'-]+){0,2})/);
    const sigName = sig.find((l) => /^[A-Z][a-zA-Z.'-]+(?:\s[A-Z][a-zA-Z.'-]+){1,3}(?:,\s*[A-Z.]{2,6})?$/.test(l) && !COMPANY_RE.test(l) && !TITLE_RE.test(l));
    if (sigName) set(lead, "contact_name", sigName.replace(/,\s*[A-Z.]{2,6}$/, ""), "med", "signature");
    else if (intro) set(lead, "contact_name", intro[1], "med", "introduction");
  }

  // ── Phone (signature first; prefer cell / mobile)
  const phoneLines = [...sig, ...main];
  let best = null;
  for (const l of phoneLines) {
    for (const m of l.matchAll(PHONE_RE)) {
      const d = m[1] + m[2] + m[3];
      if (ignorePhones.has(d)) continue;
      const before = l.slice(Math.max(0, m.index - 10), m.index);
      const score = (/\b(c|m|cell|mobile)\b\s*[:.]?\s*$/i.test(before) ? 2 : 1) + (sig.includes(l) ? 1 : 0);
      if (!best || score > best.score) best = { v: `${m[1]}-${m[2]}-${m[3]}`, score, inSig: sig.includes(l) };
    }
  }
  if (best) set(lead, "phone", best.v, best.inSig ? "high" : "med");

  // ── Title / company
  const nameKey = String(lead.contact_name || "").split(" ").pop().toLowerCase();
  const titleLine = sig.find((l) => TITLE_RE.test(l) && !(nameKey && l.toLowerCase().includes(nameKey)) && !hasEmail(l) && !hasPhone(l) && l.length < 60);
  if (titleLine) {
    const parts = titleLine.split(/\s*[|,–-]\s*/);
    const t = parts.find((p) => TITLE_RE.test(p)) || titleLine;
    set(client, "title", clean(t), "med", "signature");
    const co = parts.find((p) => p !== t && COMPANY_RE.test(p));
    if (co) set(lead, "company", clean(co), "med", "signature");
  }
  const domainBase = lead.email && !FREE_MAIL.test(lead.email.split("@")[1]) ? lead.email.split("@")[1].split(".").slice(-2, -1)[0].toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  if (!lead.company && domainBase) {
    const dl = sig.find((l) => { const n = l.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(llc|inc|corp|co)$/, ""); if (n.length < 4) return false; let k = 0; while (k < n.length && n[k] === domainBase[k]) k++; return k >= Math.min(8, n.length, domainBase.length) || domainBase.startsWith(n) || n.startsWith(domainBase); });
    if (dl) set(lead, "company", clean(dl), "high", "signature line matches email domain");
  }
  if (!lead.company) {
    const coLine = sig.find((l) => COMPANY_RE.test(l) && l !== titleLine && !hasEmail(l) && !hasPhone(l) && !hasStreet(l) && l !== lead.contact_name && l.length < 70);
    const said = mainText.match(/(?:\bwith|\bfrom|\bat|\bfor|\bof|\bw\/)\s+((?:[A-Z][\w&'.-]*\s?){1,5}(?:LLC|Inc\.?|Construction|Builders|Contractors|Architects?|Group|Company|Development|Church|Homes|Properties|Signs?))\b/);
    if (coLine) set(lead, "company", clean(coLine.replace(TITLE_RE, "").replace(/^[|,\s-]+|[|,\s-]+$/g, "")) || clean(coLine), "med", "signature");
    else if (said) set(lead, "company", clean(said[1]), "med", "mentioned in body");
    else if (lead.email && !FREE_MAIL.test(lead.email.split("@")[1])) {
      const base = lead.email.split("@")[1].split(".").slice(-2, -1)[0];
      set(lead, "company", titleCase(base.replace(/[-_]/g, " ")), "low", "guessed from email domain");
    }
  }

  // ── Addresses: signature → client mailing address; body / labelled lines → project site
  const findCitySt = (s) => {
    for (const m of s.matchAll(CITY_ST_RE)) if (ABBRS.has(m[2])) return { city: m[1].replace(/^(?:in|at|near)\s+/i, ""), state: m[2], zip: m[3] || "" };
    const named = s.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2}),?\s+(Alabama|Florida|Georgia|Mississippi|Louisiana|Arkansas|Arizona|Kentucky|North Carolina|Wisconsin|Tennessee|Texas|South Carolina)\b/);
    if (named) return { city: named[1], state: STATES[named[2].toLowerCase()], zip: "" };
    return null;
  };
  const sigStreet = sigText.match(STREET_RE);
  if (sigStreet) set(client, "address", clean(sigStreet[0]), "med", "signature");
  const sigCity = findCitySt(sigText);
  if (sigCity) { set(client, "city", sigCity.city, "med"); set(client, "state", sigCity.state, "med"); set(client, "zip", sigCity.zip, "med"); }

  const label = mainText.match(/^\s*(?:project\s+)?(?:address|location|site|site address|property|property address|job address|jobsite)\s*[:\-]\s*(.+)$/im);
  const siteSrc = label ? label[1] : mainText;
  const street = siteSrc.match(STREET_RE);
  if (street) set(project, "address", clean(street[0]), label ? "high" : "med", label ? "labelled line" : "street address in body");
  let cs = null;
  if (street) { const after = siteSrc.slice(siteSrc.indexOf(street[0]) + street[0].length, siteSrc.indexOf(street[0]) + street[0].length + 60); cs = findCitySt(after.replace(/^\s*,\s*/, "")); }
  if (!cs) cs = findCitySt(label ? label[1] : `${subject}\n${mainText}`);
  if (!cs) {
    const hay = `${subject} ${mainText}`.toLowerCase();
    const hit = Object.keys(cities).sort((a, b) => b.length - a.length).find((c) => new RegExp(`\\b${c}\\b`).test(hay));
    if (hit) cs = { city: titleCase(hit), state: cities[hit], zip: "", guessed: true };
  }
  if (cs) {
    set(project, "city", cs.city, cs.guessed ? "low" : "med", cs.guessed ? "town name matched known-cities list" : undefined);
    set(project, "state", cs.state, cs.guessed ? "low" : "med");
  } else {
    const sn = Object.keys(STATES).find((n) => new RegExp(`\\b${n}\\b`, "i").test(lc));
    if (sn) set(project, "state", STATES[sn], "low", "state named in text");
  }

  // ── Size / value
  let sf = 0;
  for (const m of mainText.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\s*(?:sf|s\.f\.|sq\.?\s?ft\.?|square\s+f(?:ee|oo)t)\b/gi)) {
    const v = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
    if (v > sf) sf = v;
  }
  if (sf) set(project, "sf", Math.round(sf), "high", "stated SF");
  else {
    const dm = mainText.match(/\b(\d{2,4})\s*(?:'|ft|feet|’)?\s*(?:x|×|by)\s*(\d{2,4})\s*(?:'|ft|feet|’)?/i);
    if (dm && Number(dm[1]) * Number(dm[2]) >= 200) set(project, "sf", Number(dm[1]) * Number(dm[2]), "med", `from ${dm[1]} × ${dm[2]} dimensions`);
  }
  const val = mainText.match(/(?:budget|construction (?:cost|value|budget)|project (?:cost|value|budget)|estimated (?:cost|value))[^$\n]{0,30}\$\s?([\d,.]+)\s*(k|m|mm|million|mil)?\b|\$\s?([\d,.]+)\s*(k|m|mm|million|mil)?\s+(?:budget|construction|project)/i);
  if (val) {
    const n = Number((val[1] || val[3]).replace(/,/g, ""));
    const mult = (val[2] || val[4] || "").toLowerCase();
    const v = n * (mult.startsWith("m") ? 1e6 : mult === "k" ? 1e3 : 1);
    if (v >= 10000) set(project, "construction_value", Math.round(v), "med", "budget mentioned");
  }

  // ── Due date
  const due = mainText.match(/\b(?:due|by|no later than|nlt|deadline(?: is)?|before|needed by|need (?:it|this|the proposal|a proposal|pricing|a quote) by|submit(?:ted)? by|proposals? (?:are )?due(?: on| by)?)\s+((?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|end of (?:the )?(?:week|month)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (due) { const d = parseDate(due[1], ref); if (d) set(lead, "response_due", d, "med", `"${clean(due[0])}"`); }
  if (sentDate && !isNaN(sentDate)) set(lead, "received", iso(sentDate), "high", "Sent header");

  // ── Project type (keyword score; subject counts double)
  const typeKw = P.type_keywords || {};
  const scores = Object.entries(typeKw).map(([t, kws]) => {
    let s = 0;
    for (const k of kws) {
      const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      s += (String(subject).match(re) || []).length * 2 + (mainText.match(re) || []).length;
    }
    return { t, s };
  }).filter((x) => x.s > 0 && cfg.project_types.some((p) => p.name === x.t)).sort((a, b) => b.s - a.s);
  if (scores.length) set(project, "project_type", scores[0].t, scores.length > 1 && scores[1].s >= scores[0].s * 0.8 ? "low" : "med",
    `keywords (${scores.slice(0, 3).map((x) => `${x.t} ${x.s}`).join(", ")})`);
  else set(project, "project_type", "Other", "low", "no type keywords found");

  // ── Schedule
  const has = (arr) => (arr || []).find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lc));
  const rush = has(P.rush_keywords), exp = has(P.expedite_keywords);
  set(project, "expedite", rush ? "Rush" : exp ? "Expedited" : "Standard", "med", rush || exp ? `"${rush || exp}"` : undefined);

  // ── Project name
  const nameLabel = mainText.match(/^\s*(?:project|project name|job|job name|re)\s*[:\-]\s*(.+)$/im);
  let subj = clean(subject);
  for (let i = 0; i < 4; i++) subj = subj.replace(/^(re|fw|fwd|rfp|rfq|rfi|request for (?:proposal|quote|pricing)|proposal request|quote request|pricing request|structural engineering(?: services)?|engineering)\s*[:\-–]\s*/i, "").trim();
  const generic = !subj || subj.length < 5 || /^(question|hello|hi|proposal|quote|pricing|request|project|new project|engineering|structural)\b\W*$/i.test(subj);
  const addressNamed = ["Structural Assessment", "Engineering Letter", "Repair Design", "Retaining Wall"].includes(project.project_type);
  if (/^[^A-Z]*$/.test(subj)) subj = titleCase(subj).replace(/\b(For|Of|And|At|The|To|In|On)\b/g, (w) => w.toLowerCase());
  if (nameLabel) set(lead, "project_name", clean(nameLabel[1]).slice(0, 90), "high", "labelled line");
  else if (addressNamed && project.address) set(lead, "project_name", `${project.address} ${project.project_type === "Engineering Letter" ? "Engineering Letter" : project.project_type}`, "med", "address + service (TNSE naming)");
  else if (!generic) set(lead, "project_name", subj.slice(0, 90), "med", "email subject");
  else {
    const where = project.address || project.city || "";
    const what = project.project_type && project.project_type !== "Other" ? project.project_type.split(" / ")[0] : "Structural Services";
    set(lead, "project_name", clean(`${where} ${what}`) || "New RFP", "low", "built from address and type");
  }

  // ── Description: body text without the greeting, trimmed at a sentence boundary
  const greeting = (l) => /^(hi|hello|hey|good (morning|afternoon|evening|day)|dear|greetings|jacob|mr\.?|mrs\.?|ms\.?)\b.{0,40}[,!:]?$/i.test(l) || (l.length <= 25 && /[,!:]$/.test(l));
  const bodyText = main.filter((l) => l && !greeting(l)).join(" ");
  let desc = clean(bodyText).replace(/^(?:hi |hey |hello )?(?:jacob|mr\.? sumrall)\s*[,:\-–]\s*/i, "");
  desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  if (desc.length > 700) { const cut = desc.slice(0, 700); desc = cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, 400)) || cut; }
  lead.description = desc; conf.description = "med";
  lead.raw_message = String(rawText || "").trim();
  if (project.address || project.city) lead.location = [project.address, project.city].filter(Boolean).join(", ");
  if (project.state) lead.state = project.state;

  // ── Scope suggestions
  const scope = suggestScope({ cfg, lc, type: project.project_type, P });

  // Client mirrors the lead contact
  Object.assign(client, { company: lead.company, contact_name: lead.contact_name, phone: lead.phone, email: lead.email, ...client });
  const who = `${lead.company || ""} ${lead.email || ""} ${client.title || ""}`.toLowerCase();
  client.client_type = /\.gov\b|county|city of|town of|state of|district|authority|commission|department/.test(who) ? "Government"
    : /architect|aia|design group/.test(who) ? "Architect"
    : /construct|builders|contract|general contractor|superintendent|estimator|roofing|steel|improvement|remodel/.test(who) ? "Contractor"
    : /develop|properties|realty|investments|holdings/.test(who) ? "Developer"
    : /engineer/.test(who) && !/county/.test(who) ? "Engineer" : "Owner";

  const missing = ["contact_name", "email", "phone"].filter((k) => !lead[k]).concat(["address", "state", "sf"].filter((k) => !project[k] && !(k === "sf" && !(cfg.project_types.find((t) => t.name === project.project_type) || {}).area_methods)));
  return { lead, client, project, scope, confidence: conf, notes, missing };
}

function countBefore(lc, words) {
  const re = new RegExp(`\\b(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a|an|single)\\s+(?:\\w+\\s+){0,2}(?:${words})`, "i");
  const m = lc.match(re);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : NUMWORDS[m[1].toLowerCase()] || null;
}

function suggestScope({ cfg, lc, type, P }) {
  const catalog = new Set(cfg.deliverable_types.map((d) => d.type));
  const kw = P.deliverable_keywords || {};
  const found = new Map();
  const add = (t, extra = {}, why = "") => { if (catalog.has(t) && !found.has(t)) found.set(t, { type: t, ...extra, why }); };
  for (const [t, words] of Object.entries(kw)) {
    const hit = words.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lc));
    if (!hit) continue;
    if (t === "Special Inspection") add(t, { qty: countBefore(lc, "(?:special\\s+)?inspections?") || 1 }, `"${hit}"`);
    else if (t === "Site Visit / Field Observation") add(t, { qty: countBefore(lc, "site visits?|visits?|trips?|observations?") || 1 }, `"${hit}"`);
    else add(t, {}, `"${hit}"`);
  }
  // Generic words like "design" or "report" over-trigger; tie them to the project type.
  const defaults = {
    "Structural Assessment": [["Assessment Report"], ["Site Visit / Field Observation", { qty: 1 }]],
    "Engineering Letter": [["Engineering Letter"]],
    "Third-Party / Plan Review": [["Engineering Letter", { hours: 6, description: "Plan review comment letter" }]],
    "Repair Design": [["Structural Drawings"], ["Structural Calculations"], ["Site Visit / Field Observation", { qty: 1 }]],
    "Retaining Wall": [["Structural Drawings"], ["Structural Calculations"]],
    "Sign / Pole Foundation": [["Structural Drawings"], ["Structural Calculations"]],
  };
  const building = ["New Building Design", "PEMB Foundation / Building", "Addition / Renovation", "CFS Delegated Design", "Public Safety / Assembly"];
  if (["Structural Assessment", "Engineering Letter", "Third-Party / Plan Review"].includes(type)) {
    for (const t of ["Structural Drawings", "Structural Calculations", "Drafting"]) found.delete(t); // "review the drawings" ≠ produce drawings
  } else if (found.has("Assessment Report") && /report/.test(found.get("Assessment Report").why) && !/assessment|evaluat/.test(lc)) found.delete("Assessment Report");
  for (const [t, extra] of defaults[type] || []) add(t, extra || {}, "default for project type");
  if (building.includes(type)) { add("Structural Drawings", {}, "default for project type"); add("Structural Calculations", {}, "default for project type"); }
  if (found.has("Structural Drawings")) add("Drafting", {}, "drawings → drafting");
  if (!found.size) add("Structural Calculations", {}, "fallback");
  const order = cfg.deliverable_types.map((d) => d.type);
  return [...found.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

module.exports = { parseEmail };
