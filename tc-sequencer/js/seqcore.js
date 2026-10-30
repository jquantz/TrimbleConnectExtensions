// seqcore.js — pure sequencing logic (no Trimble API calls). Unit-tested in /tests.
// Metropolitan Timber — Construction Sequencer for Trimble Connect

/* ----------------------------- GUID helpers ----------------------------- */

const IFC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
const IFC_RE = /^[0-9A-Za-z_$]{22}$/;
const HEX32_RE = /^[0-9a-fA-F]{32}$/;

/** 22-char IFC GlobalId -> lowercase 8-4-4-4-12 UUID */
export function ifcToUuid(g) {
  let n = 0n;
  for (const ch of g) {
    const v = IFC_CHARS.indexOf(ch);
    if (v < 0) throw new Error("Invalid IFC GUID: " + g);
    n = n * 64n + BigInt(v);
  }
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID (any case, with/without dashes/braces) -> 22-char IFC GlobalId */
export function uuidToIfc(u) {
  const hex = u.replace(/[{}-]/g, "");
  if (!HEX32_RE.test(hex)) throw new Error("Invalid UUID: " + u);
  let n = BigInt("0x" + hex);
  let out = "";
  for (let i = 0; i < 22; i++) {
    out = IFC_CHARS[Number(n % 64n)] + out;
    n = n / 64n;
  }
  return out;
}

/**
 * Canonical key for any GUID spelling: lowercase dashed UUID.
 * Accepts IFC 22-char, UUID with/without dashes, braces, Tekla "ID" prefix.
 * Returns the trimmed input lowercased if it is not recognisable as a GUID.
 */
export function guidKey(raw) {
  if (raw === undefined || raw === null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  if (IFC_RE.test(s) && !HEX32_RE.test(s)) {
    try { return ifcToUuid(s); } catch { /* fall through */ }
  }
  s = s.replace(/^\{|\}$/g, "");
  if (/^ID[0-9a-fA-F]{8}-/.test(s)) s = s.slice(2);
  const hex = s.replace(/-/g, "");
  if (HEX32_RE.test(hex)) {
    const h = hex.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return s.toLowerCase();
}

/** All the spellings worth trying when asking the viewer to resolve a GUID. */
export function guidVariants(raw) {
  const out = new Set();
  const s = String(raw || "").trim();
  if (!s) return [];
  out.add(s);
  const key = guidKey(s);
  if (/^[0-9a-f]{8}-/.test(key)) {
    out.add(key);
    out.add(key.toUpperCase());
    try { out.add(uuidToIfc(key)); } catch { /* ignore */ }
  }
  return [...out];
}

/* ------------------------------ Sorting -------------------------------- */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const naturalCompare = (a, b) => collator.compare(String(a ?? ""), String(b ?? ""));

/* --------------------------- ID templates ------------------------------ */

/**
 * Format a sequence ID from a template.
 *   {phase}  -> phase text          {n} -> step number
 *   {n:3}    -> zero-padded to 3      e.g. "{phase}-{n:3}" -> "P1-007"
 */
export function formatSeqId(template, { phase = "", n = 0 } = {}) {
  return String(template || "{phase}-{n:3}")
    .replace(/\{phase\}/gi, phase)
    .replace(/\{n(?::(\d+))?\}/gi, (_, w) => String(n).padStart(w ? Number(w) : 0, "0"));
}

/* ------------------------------- CSV ----------------------------------- */

export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ",";
}

/** RFC-4180-ish CSV parser. Returns { headers, rows: [{header: value}] } */
export function parseCsv(text, delimiter) {
  text = String(text).replace(/^﻿/, "");
  const d = delimiter || detectDelimiter(text);
  const records = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === d) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) records.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) records.push(row);
  if (!records.length) return { headers: [], rows: [], delimiter: d };
  const headers = records[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows = records.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
  return { headers, rows, delimiter: d };
}

export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\r\n");
}

/** Guess which CSV columns hold GUID / Mark / SequenceID / Order / Phase / Date. */
export function guessColumns(headers) {
  const find = (...res) => {
    for (const re of res) {
      const h = headers.find((x) => re.test(x.trim()));
      if (h) return h;
    }
    return "";
  };
  const seq = find(/^seq(uence)?[ _.-]?id$/i, /^sequence$/i, /^seq$/i, /sequence[ _.-]?(code|name|ref)/i, /^erection[ _.-]?seq/i, /^seq/i);
  const order = find(/^(step|order|sort|install[ _.-]?order|erection[ _.-]?order|seq(uence)?[ _.-]?(no|num|number|#))$/i, /order/i, /^step/i);
  return {
    guid: find(/^(ifc[ _.-]?)?guid$/i, /globalid/i, /guid/i, /^uuid$/i),
    mark: find(/^(piece[ _.-]?)?mark$/i, /assembly.?(pos|mark)/i, /cast.?unit.?mark/i, /mark/i, /^tag$/i, /^piece/i),
    seqId: seq,
    order: order && order !== seq ? order : "",
    phase: find(/^phase$/i, /phase/i, /^stage$/i, /^zone$/i, /^area$/i),
    date: find(/^(planned[ _.-]?)?(date|start)$/i, /date/i, /start/i),
  };
}

const toNum = (v) => {
  if (v === undefined || v === null || v === "") return NaN;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Normalise CSV rows into schedule records using a column mapping.
 * Rows without a SequenceID or without any identifier are reported as skipped.
 */
export function buildSchedule(rows, map) {
  const records = [], skipped = [];
  rows.forEach((r, i) => {
    const rec = {
      line: i + 2, // 1-based + header
      guid: map.guid ? r[map.guid] || "" : "",
      mark: map.mark ? r[map.mark] || "" : "",
      seqId: map.seqId ? r[map.seqId] || "" : "",
      order: map.order ? toNum(r[map.order]) : NaN,
      phase: map.phase ? r[map.phase] || "" : "",
      date: map.date ? r[map.date] || "" : "",
    };
    if (!rec.seqId) skipped.push({ ...rec, reason: "No sequence ID" });
    else if (!rec.guid && !rec.mark) skipped.push({ ...rec, reason: "No GUID or Mark" });
    else records.push(rec);
  });
  return { records, skipped };
}

/* ----------------------------- Sequences ------------------------------- */

/**
 * Group items into ordered animation steps.
 * Items sharing a sequence ID form one step (e.g. a multi-piece lift).
 * Step order: smallest numeric `order` within the step, then natural sort of the ID.
 */
export function buildSteps(items) {
  const byId = new Map();
  for (const it of items) {
    if (!it.seqId) continue;
    let s = byId.get(it.seqId);
    if (!s) byId.set(it.seqId, (s = { seqId: it.seqId, phase: it.phase || "", order: Infinity, date: it.date || "", items: [] }));
    s.items.push(it);
    if (Number.isFinite(it.order) && it.order < s.order) s.order = it.order;
    if (!s.phase && it.phase) s.phase = it.phase;
    if (!s.date && it.date) s.date = it.date;
  }
  return [...byId.values()].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return naturalCompare(a.seqId, b.seqId);
  });
}

/** Renumber click-recorded items to a gap-free 1..N using the ID template. */
export function renumber(items, template, phase) {
  const steps = buildSteps(items);
  steps.forEach((s, idx) => {
    const n = idx + 1;
    for (const it of s.items) {
      it.order = n;
      if (it.source === "click") {
        it.seqId = formatSeqId(template, { phase: it.phase || phase, n });
        it.dirty = true;
      }
    }
  });
  return steps.length;
}

/* ------------------------- Property extraction ------------------------- */

/**
 * Pull a value from viewer ObjectProperties using candidate paths.
 * Path "Set.Prop" matches property set + property name; "Prop" matches any set.
 */
export function findProperty(objProps, paths) {
  const sets = (objProps && objProps.properties) || [];
  for (const raw of paths) {
    const p = raw.trim();
    if (!p) continue;
    const dot = p.indexOf(".");
    const setName = dot > 0 ? p.slice(0, dot).toLowerCase() : null;
    const propName = (dot > 0 ? p.slice(dot + 1) : p).toLowerCase();
    for (const s of sets) {
      if (setName && String(s.name || "").toLowerCase() !== setName) continue;
      for (const pr of s.properties || []) {
        if (String(pr.name || "").toLowerCase() === propName && pr.value !== undefined && pr.value !== null && String(pr.value).trim() !== "") {
          return String(pr.value).trim();
        }
      }
    }
    // dotted path where the set name itself contains a dot — fall back to prop-only
    if (setName) {
      for (const s of sets) {
        const full = `${s.name}.`.toLowerCase();
        if (!p.toLowerCase().startsWith(full)) continue;
        const rest = p.slice(full.length).toLowerCase();
        const pr = (s.properties || []).find((x) => String(x.name || "").toLowerCase() === rest);
        if (pr && String(pr.value ?? "").trim() !== "") return String(pr.value).trim();
      }
    }
  }
  return "";
}

/** Flatten ObjectProperties to ["Set.Prop", value] pairs, for the property picker. */
export function listProperties(objProps) {
  const out = [];
  for (const s of (objProps && objProps.properties) || []) {
    for (const p of s.properties || []) out.push([`${s.name}.${p.name}`, p.value]);
  }
  return out;
}

/* ------------------------- CSV <-> sequence match ---------------------- */

/**
 * Match schedule records to known objects.
 * @param records  from buildSchedule
 * @param objects  [{ key (guidKey), mark }]  — every object we can resolve
 * @returns { assignments: [{objKey, rec}], unmatched: [rec], ambiguous: [{rec, count}] }
 * GUID wins over Mark. A Mark that hits several objects assigns all of them and is reported.
 */
export function matchSchedule(records, objects) {
  const byGuid = new Map();
  const byMark = new Map();
  for (const o of objects) {
    if (o.key) byGuid.set(o.key, o);
    if (o.mark) {
      const m = o.mark.trim().toLowerCase();
      if (!byMark.has(m)) byMark.set(m, []);
      byMark.get(m).push(o);
    }
  }
  const assignments = [], unmatched = [], ambiguous = [];
  const claimed = new Set();
  // Pass 1: GUIDs (exact, highest priority)
  const pending = [];
  for (const rec of records) {
    const k = rec.guid ? guidKey(rec.guid) : "";
    const o = k && byGuid.get(k);
    if (o) { assignments.push({ objKey: o.key, rec }); claimed.add(o.key); }
    else pending.push(rec);
  }
  // Pass 2: Marks (skip objects already claimed by a GUID row)
  for (const rec of pending) {
    const list = rec.mark ? (byMark.get(rec.mark.trim().toLowerCase()) || []).filter((o) => !claimed.has(o.key)) : [];
    if (!list.length) { unmatched.push(rec); continue; }
    if (list.length > 1) ambiguous.push({ rec, count: list.length });
    for (const o of list) assignments.push({ objKey: o.key, rec });
  }
  return { assignments, unmatched, ambiguous };
}

/* --------------------------- Pset link format -------------------------- */

export const DEFAULT_LINK_TEMPLATE = "frn:entity:{guid}";

export function fillLink(template, ctx) {
  return String(template || DEFAULT_LINK_TEMPLATE).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] !== undefined ? ctx[k] : m));
}

/**
 * Infer the link template from an existing pset link (e.g. one created by
 * applying the property set manually in Trimble Connect) and the object it belongs to.
 */
export function inferLinkTemplate(link, ctx) {
  let t = String(link);
  const swaps = [];
  if (ctx.guid) {
    swaps.push([ctx.guid, "{guid}"]);
    const key = guidKey(ctx.guid);
    if (/^[0-9a-f]{8}-/.test(key)) {
      swaps.push([key, "{guidLower}"], [key.toUpperCase(), "{guidUpper}"], [uuidToIfc(key), "{guid22}"]);
    }
  }
  for (const k of ["versionId", "modelId", "projectId"]) if (ctx[k]) swaps.push([ctx[k], `{${k}}`]);
  let hit = false;
  for (const [needle, token] of swaps) {
    if (!needle) continue;
    for (const form of [needle, encodeURIComponent(needle)]) {
      if (t.includes(form)) { t = t.split(form).join(token); if (token.startsWith("{guid")) hit = true; }
    }
  }
  return hit ? t : null;
}

/** Context object used to fill link templates for a given item. */
export function linkContext(item, projectId) {
  const key = guidKey(item.guid);
  const isUuid = /^[0-9a-f]{8}-/.test(key);
  return {
    guid: item.guid,
    guidLower: isUuid ? key : String(item.guid).toLowerCase(),
    guidUpper: isUuid ? key.toUpperCase() : String(item.guid).toUpperCase(),
    guid22: isUuid ? uuidToIfc(key) : item.guid,
    modelId: item.modelId || "",
    versionId: item.versionId || item.modelId || "",
    projectId: projectId || "",
  };
}

/* ---------------------------- Colour ramp ------------------------------ */

export function hexToRgba(hex, a = 255) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a };
}

export const PHASE_COLORS = ["#2E7D9A", "#7A9E3A", "#8E5BA8", "#C4862B", "#3F6FB5", "#A84E5B", "#4C9A7F", "#7B6A58"];
