// app.js — MT_Sequencer panel for the Trimble Connect 3D Viewer.
import {
  guidKey, uuidToIfc, formatSeqId, parseCsv, toCsv, guessColumns, buildSchedule, buildSteps,
  renumber, findProperty, listProperties, matchSchedule, fillLink, inferLinkTemplate, linkContext,
  hexToRgba, PHASE_COLORS, DEFAULT_LINK_TEMPLATE, naturalCompare, moveInSequence,
} from "./seqcore.js?v=1.3.0";
import { Viewer, groupByModel } from "./tc.js?v=1.3.0";
const APP_VERSION = "1.3.0";
import { recordSequence } from "./video.js?v=1.3.0";
import { PSetClient, regionFromLocation, schemaFields, guessFieldMap, buildProps } from "./pset.js?v=1.3.0";

/* ============================== state ============================== */

const DEFAULT_SETTINGS = {
  markPaths: [
    "Tekla Assembly.Assembly/Cast unit Mark",
    "Tekla Common.Assembly/Cast unit Mark",
    "ASSEMBLY_POS",
    "Assembly mark",
    "Identity Data.Mark",
    "Mark",
    "Tag",
    "Reference",
  ],
  namePaths: ["Tekla Common.Name", "Identity Data.Type Name", "Name", "Profile"],
  region: "auto",
  highlight: "#ff7a00",
  phase: "P1",
  template: "{phase}-{n:3}",
  linkTemplate: DEFAULT_LINK_TEMPLATE,
  psLibId: "", psDefId: "", psFieldMap: null,
  play: { speed: 600, future: "hidden", unseq: "ghost", built: "phase", zoom: false },
};

const S = {
  viewer: new Viewer(),
  project: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  items: new Map(),            // guidKey -> item
  ridIndex: new Map(),         // "modelId:rid" -> guidKey
  models: [],
  recording: false,
  holdN: null,
  lastSel: new Set(),
  lastStepKeys: [],
  selectedKeys: new Set(),
  schedule: null,              // { headers, rows, map, records, skipped, byGuid, byMark, match }
  markIndex: null,             // [{key, mark, modelId, runtimeId, guid, name}]
  play: { steps: [], k: -1, playing: false, timer: null, painted: -1 },
  pset: { client: null, libs: [], defs: [], def: null, fields: [] },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ridKey = (modelId, rid) => `${modelId}:${rid}`;

/* ============================== utils ============================== */

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), isErr ? 6000 : 2600);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const seqKey = () => `mt-seq:${S.project ? S.project.id : "none"}`;

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const items = [...S.items.values()].map(({ props, runtimeId, ...rest }) => rest);
    store.set(seqKey(), { v: 1, items, nextN: Number($("#rec-next").value) || 1 });
  }, 300);
}

function download(name, text, type = "text/csv") {
  if (window.TC_SEQ_DEMO) {
    // the demo page's sandbox blocks file downloads: show the text to copy instead
    $("#export-text").value = text.replace(/^\uFEFF/, "");
    $("#export-modal").hidden = false;
    return;
  }
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const SAMPLE_SCHEDULE = `GUID,Mark,SequenceID,Order,Phase,PlannedDate
,C101,L1-COL-01,1,Level 1,2027-03-01
,C102,L1-COL-01,1,Level 1,2027-03-01
,C105,L1-COL-02,2,Level 1,2027-03-01
,C106,L1-COL-02,2,Level 1,2027-03-01
,B101,L1-BM-01,3,Level 1,2027-03-02
,B104,L1-BM-01,3,Level 1,2027-03-02
,P101,L1-CLT-01,4,Level 1,2027-03-03`;

const hl = () => hexToRgba(S.settings.highlight);
const RECORDED = { r: 46, g: 125, b: 154, a: 255 };
const GHOST = { r: 170, g: 178, b: 188, a: 45 };

/* ============================== items ============================== */

function upsertItem(obj, patch) {
  const key = obj.key || `rt:${obj.modelId}:${obj.runtimeId}`;
  let it = S.items.get(key);
  if (!it) {
    it = { key, guid: obj.guid || "", modelId: obj.modelId, runtimeId: obj.runtimeId, mark: obj.mark || "", name: obj.name || "",
      seqId: "", order: NaN, phase: "", date: "", source: "", dirty: false };
    S.items.set(key, it);
  }
  if (obj.modelId) it.modelId = obj.modelId;
  if (obj.runtimeId !== undefined) it.runtimeId = obj.runtimeId;
  if (obj.mark && !it.mark) it.mark = obj.mark;
  if (obj.name && !it.name) it.name = obj.name;
  Object.assign(it, patch);
  if (it.modelId && it.runtimeId !== undefined) S.ridIndex.set(ridKey(it.modelId, it.runtimeId), key);
  return it;
}

function removeItem(key) {
  const it = S.items.get(key);
  if (!it) return;
  S.ridIndex.delete(ridKey(it.modelId, it.runtimeId));
  S.items.delete(key);
}

function maxOrder() {
  let m = 0;
  for (const it of S.items.values()) if (Number.isFinite(it.order) && it.order > m) m = it.order;
  return m;
}

/* ============================== render ============================== */

function refreshStats() {
  const items = [...S.items.values()];
  const steps = buildSteps(items);
  const dirty = items.filter((i) => i.dirty).length;
  $("#stat-objects").textContent = items.length;
  $("#stat-steps").textContent = steps.length;
  $("#stat-unsaved").textContent = dirty;
  $("#chip-unsaved").hidden = !dirty;
  $("#ps-dirty-n").textContent = dirty;
  updatePreview();
}

function updatePreview() {
  const n = S.holdN || Number($("#rec-next").value) || 1;
  $("#rec-preview").value = formatSeqId($("#rec-template").value, { phase: $("#rec-phase").value, n });
}

const LIST_LIMIT = 400;
function renderList() {
  const q = $("#list-filter").value.trim().toLowerCase();
  const steps = buildSteps([...S.items.values()]);
  const rows = [];
  steps.forEach((s, si) => {
    for (const it of s.items) {
      if (q && !`${it.seqId} ${it.mark} ${it.name}`.toLowerCase().includes(q)) continue;
      rows.push([si + 1, it]);
    }
  });
  const tb = $("#seq-table tbody");
  let prevN = 0;
  tb.innerHTML = rows.slice(0, LIST_LIMIT).map(([n, it]) => {
    const first = n !== prevN; prevN = n;
    return `
    <tr data-key="${esc(it.key)}" data-step="${n}" class="${S.selectedKeys.has(it.key) ? "sel " : ""}${n % 2 ? "odd" : "even"}${first ? " step-start" : ""}">
      <td class="grip" data-drag="item" title="Drag to move this object (or all selected rows)">⋮⋮</td>
      <td class="stepno${first ? " handle" : ""}" ${first ? 'data-drag="step" title="Drag to move the whole step"' : ""}>${first ? n : ""}</td>
      <td><input value="${esc(it.seqId)}" data-edit="${esc(it.key)}" /></td>
      <td title="${esc(it.mark)}">${esc(it.mark) || '<span class="muted">—</span>'}</td>
      <td title="${esc(it.name)}">${esc(it.name)}</td>
      <td>${it.dirty ? '<span class="dirty" title="Not yet written to property set">●</span>' : ""}${it.runtimeId === undefined ? ' <span class="src" title="Not found in loaded models">n/a</span>' : ""}</td>
    </tr>`;
  }).join("");
  $("#list-more").textContent = rows.length > LIST_LIMIT ? `Showing first ${LIST_LIMIT} of ${rows.length} — use the filter.` : rows.length ? "" : "No sequenced objects yet.";
  refreshStats();
}

function showInspector(objs, note = "") {
  const card = $("#inspector");
  if (!objs.length) { card.hidden = true; return; }
  const first = objs[0];
  const it = S.items.get(first.key);
  card.hidden = false;
  card.innerHTML = `
    <div class="big-id">${esc(it && it.seqId ? it.seqId : "Not sequenced")}</div>
    <div>${esc(first.mark || "(no mark)")} · ${esc(first.name || "")}${objs.length > 1 ? ` <span class="muted">+${objs.length - 1} more</span>` : ""}</div>
    <div class="muted small">${first.guid ? "GUID " + esc(first.guid) : '<span class="bad">No GUID — cannot be written to a property set</span>'}</div>
    ${note ? `<div>${note}</div>` : ""}`;
}

/* ============================== viewer events ============================== */

async function describe(byModel) {
  const out = [];
  for (const [modelId, ids] of Object.entries(byModel)) {
    out.push(...(await S.viewer.describe(modelId, ids, S.settings.markPaths, S.settings.namePaths)));
  }
  return out;
}

let selBusy = Promise.resolve();
function onSelectionChanged(sel, args) {
  // serialise handling so rapid clicks are recorded in order
  selBusy = selBusy.then(() => handleSelection(sel || [], args)).catch((e) => { console.error(e); toast(e.message, true); });
}

async function handleSelection(sel, args) {
  const cur = new Set();
  const added = {};
  for (const mo of sel) {
    for (const rid of mo.objectRuntimeIds || []) {
      const k = ridKey(mo.modelId, rid);
      cur.add(k);
      if (!S.lastSel.has(k)) (added[mo.modelId] ||= []).push(rid);
    }
  }
  S.lastSel = cur;
  S.selectedKeys = new Set([...cur].map((k) => S.ridIndex.get(k)).filter(Boolean));
  if (args && args.origin && args.origin.isSelf) { renderList(); return; }
  if (!Object.keys(added).length) { renderList(); return; }

  const objs = await describe(added);
  if (S.recording) await recordObjects(objs);
  else if ($("#auto-assign").checked && S.schedule && S.schedule.records) await autoAssign(objs);
  else showInspector(objs);
  if (!$("#prop-picker").hidden) showPropPicker(objs[0]);
  renderList();
}

/* ============================== phase 1: record ============================== */

async function recordObjects(objs) {
  const reseq = $("#rec-reseq").checked;
  const fresh = [], already = [];
  for (const o of objs) {
    const ex = S.items.get(o.key || `rt:${o.modelId}:${o.runtimeId}`);
    (ex && ex.seqId && !reseq ? already : fresh).push(o);
  }
  if (!fresh.length) {
    const ex = S.items.get(already[0].key);
    showInspector(already, `<span class="warn">Already sequenced as ${esc(ex.seqId)} — tick "Re-sequence" to move it.</span>`);
    return;
  }
  const hold = $("#rec-hold").checked;
  const n = hold && S.holdN ? S.holdN : Number($("#rec-next").value) || maxOrder() + 1;
  const phase = $("#rec-phase").value.trim();
  const seqId = formatSeqId($("#rec-template").value, { phase, n });
  for (const o of fresh) upsertItem(o, { seqId, order: n, phase, source: "click", dirty: true });

  if (hold) { S.holdN = n; $("#rec-nextstep").disabled = false; }
  else $("#rec-next").value = n + 1;

  // visual: previous latest -> recorded colour, this step -> highlight
  const prev = S.lastStepKeys.map((k) => S.items.get(k)).filter(Boolean).filter((i) => i.order !== n);
  await S.viewer.setState(groupByModel(prev), { color: RECORDED, visible: true });
  const now = [...S.items.values()].filter((i) => i.order === n);
  await S.viewer.setState(groupByModel(now), { color: hl(), visible: true });
  S.lastStepKeys = now.map((i) => i.key);

  const noGuid = fresh.filter((o) => !o.guid).length;
  showInspector(fresh, `<span class="ok">✓ Assigned step ${n}</span>${already.length ? ` <span class="muted">(${already.length} already sequenced, skipped)</span>` : ""}${noGuid ? ` <span class="bad">${noGuid} without GUID</span>` : ""}`);
  S.viewer.status(`Recorded ${seqId}`);
  persist();
}

async function toggleRecording() {
  S.recording = !S.recording;
  const b = $("#rec-toggle");
  b.textContent = S.recording ? "■ Stop recording" : "● Start recording";
  b.classList.toggle("recording", S.recording);
  stopPlay();
  if (S.recording) {
    if (!Number($("#rec-next").value) || Number($("#rec-next").value) <= maxOrder()) $("#rec-next").value = maxOrder() + 1;
    await S.viewer.resetAll();
    await S.viewer.setState(groupByModel([...S.items.values()]), { color: RECORDED });
    toast("Recording — click objects in erection order");
  } else {
    S.holdN = null; $("#rec-nextstep").disabled = true;
    await S.viewer.resetAll();
    toast("Recording stopped");
  }
  updatePreview();
}

function nextHeldStep() {
  if (S.holdN) $("#rec-next").value = S.holdN + 1;
  S.holdN = null;
  $("#rec-nextstep").disabled = true;
  updatePreview();
  toast("Next clicks start a new step");
}

async function undoLastStep() {
  const clickItems = [...S.items.values()].filter((i) => i.source === "click" && Number.isFinite(i.order));
  if (!clickItems.length) return toast("Nothing to undo");
  const last = Math.max(...clickItems.map((i) => i.order));
  const gone = clickItems.filter((i) => i.order === last);
  await S.viewer.setState(groupByModel(gone), { color: "reset" });
  gone.forEach((i) => removeItem(i.key));
  $("#rec-next").value = last;
  if (S.holdN === last) S.holdN = null;
  toast(`Removed step ${last} (${gone.length} object${gone.length > 1 ? "s" : ""})`);
  persist(); renderList();
}

async function removeSelected() {
  const keys = [...S.selectedKeys];
  if (!keys.length) return toast("Select objects in the 3D view (or rows in the list) first");
  const gone = keys.map((k) => S.items.get(k)).filter(Boolean);
  await S.viewer.setState(groupByModel(gone), { color: "reset" });
  keys.forEach(removeItem);
  toast(`Removed ${gone.length} object(s) from the sequence`);
  persist(); renderList();
}

function doRenumber() {
  const n = renumber([...S.items.values()], $("#rec-template").value, $("#rec-phase").value.trim());
  $("#rec-next").value = n + 1;
  toast(`Renumbered ${n} steps`);
  persist(); renderList();
}

async function clearAll() {
  if (!(await askConfirm("Remove every object from the sequence?", "Property sets already written to Trimble Connect are not deleted."))) return;
  S.items.clear(); S.ridIndex.clear(); S.holdN = null;
  $("#rec-next").value = 1;
  await S.viewer.resetAll();
  persist(); renderList();
}

/* ============================== phase 2: CSV schedule ============================== */

function loadCsvText(text, name) {
  const { headers, rows } = parseCsv(text);
  if (!headers.length || !rows.length) return toast("That CSV looks empty", true);
  const guess = guessColumns(headers);
  S.schedule = { headers, rows, name };
  $$("#csv-map select[data-col]").forEach((sel) => {
    const col = sel.dataset.col;
    sel.innerHTML = `<option value="">— none —</option>` + headers.map((h) => `<option ${guess[col] === h ? "selected" : ""}>${esc(h)}</option>`).join("");
  });
  $("#csv-label").innerHTML = `<b>${esc(name)}</b> — ${rows.length} rows · <u>change</u>`;
  $("#csv-map").hidden = false;
  $("#csv-report").hidden = true; $("#csv-apply").hidden = true;
  prepareSchedule();
}

function prepareSchedule() {
  if (!S.schedule) return;
  const map = {};
  $$("#csv-map select[data-col]").forEach((s) => (map[s.dataset.col] = s.value));
  const { records, skipped } = buildSchedule(S.schedule.rows, map);
  const byGuid = new Map(), byMark = new Map();
  for (const r of records) {
    if (r.guid) byGuid.set(guidKey(r.guid), r);
    if (r.mark) { const m = r.mark.toLowerCase(); if (!byMark.has(m)) byMark.set(m, r); }
  }
  Object.assign(S.schedule, { map, records, skipped, byGuid, byMark });
}

function lookupRecord(o) {
  const sc = S.schedule;
  if (!sc || !sc.records) return null;
  if (o.key && sc.byGuid.has(o.key)) return { rec: sc.byGuid.get(o.key), by: "GUID" };
  if (o.mark && sc.byMark.has(o.mark.toLowerCase())) return { rec: sc.byMark.get(o.mark.toLowerCase()), by: "Mark" };
  return null;
}

/** "Select object → assign the correct sequence" */
async function autoAssign(objs) {
  const hits = [], misses = [];
  for (const o of objs) {
    const m = lookupRecord(o);
    if (!m) { misses.push(o); continue; }
    const r = m.rec;
    upsertItem(o, { seqId: r.seqId, order: Number.isFinite(r.order) ? r.order : NaN, phase: r.phase, date: r.date, source: "csv", dirty: true });
    hits.push([o, m]);
  }
  await S.viewer.setState(groupByModel(hits.map(([o]) => o)), { color: hl() });
  const card = $("#auto-card");
  card.hidden = false;
  card.innerHTML = hits.length
    ? `<div class="big-id">${esc(hits[0][1].rec.seqId)}</div>
       <div class="ok">✓ ${hits.length} object(s) assigned from schedule (matched by ${hits[0][1].by}, CSV line ${hits[0][1].rec.line})</div>`
       + (misses.length ? `<div class="bad">${misses.length} not in schedule: ${esc(misses.map((m) => m.mark || m.guid).slice(0, 5).join(", "))}</div>` : "")
    : `<div class="bad">No schedule row for ${esc(objs[0].mark || objs[0].guid || "this object")}</div>`;
  showInspector(objs);
  persist();
}

async function buildMarkIndex(progress) {
  if (S.markIndex) return S.markIndex;
  const all = await S.viewer.getAllObjectIds();
  const total = all.reduce((a, m) => a + m.ids.length, 0);
  const out = [];
  let done = 0;
  for (const m of all) {
    for (let i = 0; i < m.ids.length; i += 500) {
      const part = m.ids.slice(i, i + 500);
      const objs = await S.viewer.describe(m.modelId, part, S.settings.markPaths, S.settings.namePaths);
      for (const o of objs) { delete o.props; if (o.mark || o.key) out.push(o); }
      done += part.length;
      progress && progress(done, total);
    }
  }
  S.markIndex = out;
  return out;
}

async function matchCsv() {
  prepareSchedule();
  const sc = S.schedule;
  if (!sc.map.seqId) return toast("Choose the Sequence ID column", true);
  if (!sc.map.guid && !sc.map.mark) return toast("Choose a GUID and/or Mark column", true);
  const scope = $("input[name=csv-scope]:checked").value;
  const rep = $("#csv-report");
  rep.hidden = false; rep.innerHTML = "Matching…";

  let objects = [...S.items.values()].map((i) => ({ ...i }));
  if (scope === "model") {
    // 1) GUID rows: ask the viewer directly (fast)
    const guidRows = sc.records.filter((r) => r.guid);
    if (guidRows.length) {
      const found = await S.viewer.resolveGuids(guidRows.map((r) => r.guid), S.models);
      for (const [key, f] of found) if (!S.items.has(key)) objects.push({ key, guid: f.guid, modelId: f.modelId, runtimeId: f.runtimeId, mark: "" });
    }
    // 2) Mark rows not resolved by GUID: index marks across the model
    const needMarks = sc.records.some((r) => r.mark && !(r.guid && objects.some((o) => o.key === guidKey(r.guid))));
    if (needMarks) {
      const idx = await buildMarkIndex((d, t) => (rep.innerHTML = `Reading marks from model… ${d} / ${t}`));
      const have = new Set(objects.map((o) => o.key));
      for (const o of idx) if (!have.has(o.key)) objects.push(o);
    }
  }
  const res = matchSchedule(sc.records, objects);
  const objByKey = new Map(objects.map((o) => [o.key, o]));
  let changed = 0, added = 0, same = 0;
  for (const a of res.assignments) {
    const ex = S.items.get(a.objKey);
    if (!ex) added++;
    else if (ex.seqId !== a.rec.seqId) changed++;
    else same++;
  }
  const covered = new Set(res.assignments.map((a) => a.objKey));
  const notInCsv = [...S.items.values()].filter((i) => !covered.has(i.key));
  sc.match = { ...res, objByKey };

  const li = (arr, f) => `<ul>${arr.slice(0, 200).map((x) => `<li>${esc(f(x))}</li>`).join("")}</ul>`;
  rep.innerHTML = `
    <div><b>${res.assignments.length}</b> object assignments from ${sc.records.length} rows</div>
    <div class="ok">${changed} changed · ${added} newly sequenced · ${same} unchanged</div>
    ${res.unmatched.length ? `<details><summary class="bad">${res.unmatched.length} rows matched no object</summary>${li(res.unmatched, (r) => `line ${r.line}: ${r.guid || r.mark} → ${r.seqId}`)}</details>` : ""}
    ${res.ambiguous.length ? `<details><summary class="warn">${res.ambiguous.length} marks hit several objects (all assigned)</summary>${li(res.ambiguous, (a) => `${a.rec.mark} → ${a.count} objects`)}</details>` : ""}
    ${sc.skipped.length ? `<details><summary class="warn">${sc.skipped.length} rows skipped</summary>${li(sc.skipped, (r) => `line ${r.line}: ${r.reason}`)}</details>` : ""}
    ${notInCsv.length ? `<details><summary class="warn">${notInCsv.length} sequenced objects are not in the CSV (kept as-is)</summary>${li(notInCsv, (i) => `${i.seqId} · ${i.mark || i.guid}`)}</details>` : ""}`;
  $("#csv-apply").hidden = !res.assignments.length;
}

function applyCsv() {
  const m = S.schedule && S.schedule.match;
  if (!m) return;
  let n = 0;
  for (const a of m.assignments) {
    const o = m.objByKey.get(a.objKey);
    const r = a.rec;
    const ex = S.items.get(a.objKey);
    const order = Number.isFinite(r.order) ? r.order : NaN;
    if (ex && ex.seqId === r.seqId && (ex.order === order || (isNaN(ex.order) && isNaN(order))) && ex.phase === r.phase && ex.date === r.date) continue;
    upsertItem(o, { seqId: r.seqId, order, phase: r.phase || (ex && ex.phase) || "", date: r.date, source: "csv", dirty: true });
    n++;
  }
  // items without a numeric order sort by ID; give click items their order back if CSV had none
  $("#csv-apply").hidden = true;
  toast(`Applied ${n} sequence changes — review in Play, then Write`);
  persist(); renderList();
}

/* ============================== playback ============================== */

function phaseColors(steps) {
  const phases = [...new Set(steps.map((s) => s.phase || ""))].sort(naturalCompare);
  const map = new Map(phases.map((p, i) => [p, PHASE_COLORS[i % PHASE_COLORS.length]]));
  $("#phase-legend").innerHTML = phases.length > 1 || phases[0]
    ? phases.map((p) => `<span style="--c:${map.get(p)}">${esc(p || "(no phase)")}</span>`).join("")
    : "";
  return map;
}

function preparePlay() {
  const items = [...S.items.values()].filter((i) => i.runtimeId !== undefined);
  const steps = buildSteps(items);
  S.play.steps = steps;
  S.play.colors = phaseColors(steps);
  $("#play-slider").max = Math.max(steps.length, 0);
  if (S.play.k > steps.length) S.play.k = steps.length;
  updatePlayLabel();
}

function updatePlayLabel() {
  const { steps, k } = S.play;
  $("#play-slider").value = Math.max(k, 0);
  if (!steps.length) { $("#play-label").textContent = "—"; $("#play-sub").textContent = "No steps yet — record or load a schedule"; return; }
  if (k <= 0) { $("#play-label").textContent = "Start"; $("#play-sub").textContent = `${steps.length} steps · press ▶`; return; }
  const s = steps[k - 1];
  $("#play-label").textContent = s.seqId;
  $("#play-sub").textContent = `Step ${k} of ${steps.length} · ${s.items.length} object${s.items.length > 1 ? "s" : ""}${s.phase ? " · " + s.phase : ""}${s.date ? " · " + s.date : ""}`;
}

function builtState(step) {
  const mode = $("#play-built").value;
  if (mode === "original") return { visible: true, color: "reset" };
  return { visible: true, color: hexToRgba(S.play.colors.get(step.phase || "") || PHASE_COLORS[0]) };
}

async function paint(k) {
  const { steps } = S.play;
  const v = S.viewer;
  const future = $("#play-future").value === "ghost" ? { visible: true, color: GHOST } : { visible: false };
  const incremental = S.play.painted >= 0 && k === S.play.painted + 1;
  if (incremental) {
    if (k - 1 >= 1) await v.setState(groupByModel(steps[k - 2].items), builtState(steps[k - 2]));
    if (k >= 1) await v.setState(groupByModel(steps[k - 1].items), { visible: true, color: hl() });
  } else {
    const unseq = $("#play-unseq").value;
    await v.resetAll();
    if (unseq === "ghost") await v.setAll({ visible: true, color: GHOST });
    else if (unseq === "hidden") await v.setAll({ visible: false });
    const fut = steps.slice(Math.max(k, 0)).flatMap((s) => s.items);
    await v.setState(groupByModel(fut), future);
    // built steps grouped by state to minimise calls
    const groups = new Map();
    steps.slice(0, Math.max(k - 1, 0)).forEach((s) => {
      const st = builtState(s); const sk = JSON.stringify(st);
      if (!groups.has(sk)) groups.set(sk, { st, items: [] });
      groups.get(sk).items.push(...s.items);
    });
    for (const g of groups.values()) await v.setState(groupByModel(g.items), g.st);
    if (k >= 1) await v.setState(groupByModel(steps[k - 1].items), { visible: true, color: hl() });
  }
  if (k >= 1 && $("#play-zoom").checked) await v.zoomTo(groupByModel(steps[k - 1].items));
  S.play.painted = k;
}

let painting = Promise.resolve();
function goTo(k) {
  const max = S.play.steps.length;
  k = Math.max(0, Math.min(k, max));
  S.play.k = k;
  updatePlayLabel();
  painting = painting.then(() => paint(k)).catch((e) => toast(e.message, true));
  return painting;
}

async function togglePlay() {
  if (S.play.playing) return stopPlay();
  if (S.recording) await toggleRecording();
  preparePlay();
  if (!S.play.steps.length) return toast("No sequenced objects in the loaded models");
  if (S.play.k >= S.play.steps.length) { S.play.k = 0; S.play.painted = -1; }
  S.play.playing = true;
  $("#play-toggle").textContent = "⏸";
  const tick = async () => {
    if (!S.play.playing) return;
    await goTo(Math.max(S.play.k, 0) + 1);
    if (S.play.k >= S.play.steps.length) return stopPlay();
    S.play.timer = setTimeout(tick, Number($("#play-speed").value));
  };
  tick();
}

function stopPlay() {
  S.play.playing = false;
  clearTimeout(S.play.timer);
  $("#play-toggle").textContent = "▶";
}

async function resetView() {
  stopPlay();
  S.play.k = -1; S.play.painted = -1;
  await S.viewer.resetAll();
  updatePlayLabel();
}

/* ============================== video export ============================== */

function downloadBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}

async function exportVideo() {
  if (S.video && S.video.running) return;
  stopPlay();
  if (S.recording) await toggleRecording();
  preparePlay();
  const steps = S.play.steps;
  if (!steps.length) return toast("No sequenced objects in the loaded models", true);

  const [W, H] = $("#vid-res").value.split("x").map(Number);
  const stepSec = Number($("#vid-step").value);
  const withCaption = $("#vid-caption").checked;
  const projectName = (S.project && S.project.name) || "";
  const today = new Date().toISOString().slice(0, 10);
  S.video = { running: true, cancelled: false };
  const ui = (on) => {
    $("#vid-progress").hidden = !on;
    $("#vid-export").disabled = on;
    $$('section[data-tab="play"] .transport .btn, #play-slider').forEach((b) => (b.disabled = on));
  };
  ui(true);
  $("#vid-progress .progress > div").style.width = "0%";
  $("#vid-status").textContent = `Recording ${steps.length} steps…`;
  S.play.painted = -1;
  try {
    const out = await recordSequence({
      size: [W, H], fps: 20, stepSec, introSec: 1, outroSec: 2,
      count: steps.length,
      paint: async (k) => { S.play.k = k; updatePlayLabel(); await paint(k); },
      snapshot: () => S.viewer.snapshot(),
      caption: withCaption ? (k) => {
        const s = steps[k - 1];
        return {
          title: s ? s.seqId : "Start",
          sub: s ? [`${s.items.length} object${s.items.length > 1 ? "s" : ""}`, s.phase, s.date].filter(Boolean).join("  ·  ") : `${steps.length} steps`,
          right: s ? `Step ${k} / ${steps.length}` : "",
          footer: [projectName, today].filter(Boolean).join("  ·  "),
          progress: k / steps.length,
          accent: S.settings.highlight,
        };
      } : null,
      onProgress: (f, k) => {
        $("#vid-progress .progress > div").style.width = `${Math.round(f * 100)}%`;
        $("#vid-status").textContent = `Recording step ${k} of ${steps.length}…`;
      },
      isCancelled: () => S.video.cancelled,
    });
    const name = `${(projectName || "sequence").replace(/[^\w-]+/g, "_")}_build_sequence.${out.ext}`;
    showVideo(out, name);
  } catch (e) {
    if (e.message === "cancelled") toast("Video export cancelled");
    else { console.error(e); toast("Video export failed: " + e.message, true); }
  } finally {
    S.video.running = false;
    ui(false);
  }
}

function showVideo(out, name) {
  const url = URL.createObjectURL(out.blob);
  const v = $("#video-preview");
  if (v.dataset.url) URL.revokeObjectURL(v.dataset.url);
  v.src = url; v.dataset.url = url;
  const mb = (out.blob.size / 1048576).toFixed(1);
  $("#video-info").textContent = `${name} · ${mb} MB${out.ext !== "mp4" ? " · this browser could only make a WebM file" : ""}` +
    (window.TC_SEQ_DEMO ? " · downloads are blocked on the demo page; right-click the video to save it." : " · if Download does nothing, right-click the video and choose Save Video As.");
  $("#video-download").onclick = () => downloadBlob(name, out.blob);
  $("#video-modal").hidden = false;
  if (!window.TC_SEQ_DEMO) downloadBlob(name, out.blob);
}

/* ============================== property sets ============================== */

function psLog(msg, cls = "") {
  const el = $("#ps-log");
  el.innerHTML = `<div class="${cls}">${esc(msg)}</div>` + el.innerHTML;
}

function psProgress(done, total) {
  const bar = $("#ps-progress");
  bar.hidden = done >= total;
  bar.firstElementChild.style.width = `${total ? (100 * done) / total : 0}%`;
}

async function psConnect() {
  try {
    psLog("Requesting access… approve the prompt in Trimble Connect if asked.");
    const region = S.settings.region === "auto" ? regionFromLocation(S.project && S.project.location) : S.settings.region;
    S.pset.client = new PSetClient({
      region,
      getToken: () => S.viewer.getAccessToken(),
      refreshToken: async () => { S.viewer.accessToken = null; await S.viewer.getAccessToken(); },
    });
    const ids = await S.pset.client.listProjectLibraryIds(S.project.id);
    const libs = [];
    for (const id of ids) {
      try { const l = await S.pset.client.getLibrary(id); if (!l.deleted) libs.push(l); } catch (e) { console.warn(e); }
    }
    S.pset.libs = libs;
    if (!libs.length) {
      psLog("No property set libraries found in this project. Create one in Trimble Connect (see README), then reconnect.", "bad");
      return;
    }
    $("#ps-lib").innerHTML = libs.map((l) => `<option value="${esc(l.id)}">${esc(l.name || l.id)}</option>`).join("");
    if (libs.some((l) => l.id === S.settings.psLibId)) $("#ps-lib").value = S.settings.psLibId;
    $("#ps-config").hidden = false;
    psLog(`Connected (${region}). ${libs.length} librar${libs.length > 1 ? "ies" : "y"} found.`, "ok");
    await psLoadDefs();
  } catch (e) {
    console.error(e);
    psLog("Could not connect: " + e.message, "bad");
  }
}

async function psLoadDefs() {
  const libId = $("#ps-lib").value;
  const defs = (await S.pset.client.listDefinitions(libId)).filter((d) => !d.deleted);
  S.pset.defs = defs;
  $("#ps-def").innerHTML = defs.map((d) => `<option value="${esc(d.id)}">${esc(d.name || d.id)}</option>`).join("");
  const pref = defs.find((d) => d.id === S.settings.psDefId) || defs.find((d) => /sequen/i.test(d.name)) || defs[0];
  if (pref) $("#ps-def").value = pref.id;
  await psLoadFields();
}

async function psLoadFields() {
  const libId = $("#ps-lib").value, defId = $("#ps-def").value;
  if (!defId) return;
  const def = await S.pset.client.getDefinition(libId, defId);
  S.pset.def = def;
  S.pset.fields = schemaFields(def);
  const saved = S.settings.psDefId === defId && S.settings.psFieldMap;
  const fm = saved || guessFieldMap(S.pset.fields);
  $$("#ps-config select[data-field]").forEach((sel) => {
    const f = sel.dataset.field;
    sel.innerHTML = `<option value="">— none —</option>` + S.pset.fields.map((x) => `<option value="${esc(x.key)}" ${fm[f] === x.key ? "selected" : ""}>${esc(x.label)} (${esc(x.type)})</option>`).join("");
  });
  if (!S.pset.fields.length) psLog("This property set has no fields — add a text field for the Sequence ID in Connect.", "bad");
  psSaveConfig();
}

function psFieldMap() {
  const m = {};
  $$("#ps-config select[data-field]").forEach((s) => (m[s.dataset.field] = s.value));
  return m;
}

function psSaveConfig() {
  S.settings.psLibId = $("#ps-lib").value;
  S.settings.psDefId = $("#ps-def").value;
  S.settings.psFieldMap = psFieldMap();
  S.settings.linkTemplate = $("#ps-link").value.trim() || DEFAULT_LINK_TEMPLATE;
  store.set("mt-seq-settings", S.settings);
}

async function psWrite(which) {
  psSaveConfig();
  const fm = psFieldMap();
  if (!fm.seqId) return psLog("Choose the field that will hold the Sequence ID.", "bad");
  let items = [...S.items.values()];
  if (which === "dirty") items = items.filter((i) => i.dirty);
  if (which === "selected") items = items.filter((i) => S.selectedKeys.has(i.key));
  const noGuid = items.filter((i) => !i.guid);
  items = items.filter((i) => i.guid);
  if (!items.length) return psLog(noGuid.length ? `${noGuid.length} objects have no GUID and can't be written.` : "Nothing to write.", "bad");

  const { libId, defId } = { libId: S.settings.psLibId, defId: S.settings.psDefId };
  const tpl = S.settings.linkTemplate;
  const pid = S.project && S.project.id;
  const req = items.map((i) => ({ link: fillLink(tpl, linkContext(i, pid)), libId, defId, props: buildProps(i, fm, S.pset.fields) }));
  psLog(`Writing ${req.length} objects…`);
  psProgress(0, req.length);
  try {
    const res = await S.pset.client.changeset(req, psProgress);
    const failedLinks = new Set(res.failed.map((f) => f.item && f.item.link));
    let ok = 0;
    items.forEach((i, idx) => { if (!failedLinks.has(req[idx].link)) { i.dirty = false; ok++; } });
    psLog(`✓ Wrote Sequence ID to ${ok} objects.${res.failed.length ? ` ${res.failed.length} failed: ${res.failed[0].code} ${res.failed[0].message}` : ""}${noGuid.length ? ` ${noGuid.length} skipped (no GUID).` : ""}`, res.failed.length ? "bad" : "ok");
    if (ok) psLog("Select an object and open its Properties panel to see the value (reload the model if it doesn't appear).");
  } catch (e) {
    psLog("Write failed: " + e.message, "bad");
  } finally { psProgress(1, 1); persist(); renderList(); }
}

/** Learn the link format from a pset someone applied manually in Connect. */
async function psDetect() {
  try {
    const psets = await S.pset.client.listPSetsByDefinition(S.settings.psLibId || $("#ps-lib").value, $("#ps-def").value, 200);
    if (!psets.length) return psLog("No objects carry this property set yet. In Connect, select one object → Properties → Add properties → pick this set, give it any value, then press Detect again.", "bad");
    const pid = S.project && S.project.id;
    const items = [...S.items.values()].filter((i) => i.guid);
    for (const p of psets) {
      for (const it of items) {
        const t = inferLinkTemplate(p.link, linkContext(it, pid));
        if (t) return setLink(t, p.link);
      }
    }
    // fall back: pull a GUID-looking token out of the link and resolve it in the viewer
    for (const p of psets.slice(0, 20)) {
      const tokens = String(decodeURIComponent(p.link)).split(/[:/]/).filter((x) => x.length >= 22);
      const found = await S.viewer.resolveGuids(tokens, S.models);
      for (const [, f] of found) {
        const t = inferLinkTemplate(p.link, linkContext({ guid: f.guid, modelId: f.modelId }, pid));
        if (t) return setLink(t, p.link);
      }
    }
    psLog(`Found ${psets.length} tagged objects but couldn't match them to the loaded model. Example link: ${psets[0].link}`, "bad");
  } catch (e) { psLog("Detect failed: " + e.message, "bad"); }
}

function setLink(t, example) {
  $("#ps-link").value = t;
  psSaveConfig();
  psLog(`✓ Link format detected: ${t}  (from ${example})`, "ok");
}

/** Rebuild the sequence from what's stored in the property set (shared state). */
async function psLoad() {
  try {
    const fm = psFieldMap();
    const psets = await S.pset.client.listPSetsByDefinition($("#ps-lib").value, $("#ps-def").value);
    const tpl = S.settings.linkTemplate;
    const re = new RegExp("^" + tpl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{(guid\w*)\\\}/, "(?<g>.+?)").replace(/\\\{\w+\\\}/g, ".*?") + "$");
    const recs = [];
    for (const p of psets) {
      if (p.deleted) continue;
      const m = re.exec(p.link) || re.exec(decodeURIComponent(p.link));
      const props = p.props || {};
      if (!m || !props[fm.seqId]) continue;
      recs.push({ guid: decodeURIComponent(m.groups.g), seqId: String(props[fm.seqId]), order: fm.order ? Number(props[fm.order]) : NaN, phase: fm.phase ? props[fm.phase] || "" : "", date: fm.date ? props[fm.date] || "" : "" });
    }
    const found = await S.viewer.resolveGuids(recs.map((r) => r.guid), S.models);
    let n = 0;
    for (const r of recs) {
      const key = guidKey(r.guid);
      const f = found.get(key);
      upsertItem({ key, guid: f ? f.guid : r.guid, modelId: f && f.modelId, runtimeId: f ? f.runtimeId : undefined }, { seqId: r.seqId, order: r.order, phase: r.phase, date: r.date, source: "pset", dirty: false });
      n++;
    }
    await fillMissingMarks();
    psLog(`✓ Loaded ${n} sequence values (${found.size} found in loaded models).`, "ok");
    persist(); renderList();
  } catch (e) { psLog("Load failed: " + e.message, "bad"); }
}

/* ============================== export ============================== */

function exportCsv() {
  const steps = buildSteps([...S.items.values()]);
  const rows = [];
  steps.forEach((s, si) => s.items.forEach((i) => {
    const k = guidKey(i.guid);
    rows.push({
      GUID: i.guid, IFC_GUID: /^[0-9a-f]{8}-/.test(k) ? uuidToIfc(k) : "", Mark: i.mark, Name: i.name,
      SequenceID: i.seqId, Step: si + 1, Order: Number.isFinite(i.order) ? i.order : "", Phase: i.phase, PlannedDate: i.date,
    });
  }));
  const headers = ["GUID", "IFC_GUID", "Mark", "Name", "SequenceID", "Step", "Order", "Phase", "PlannedDate"];
  const name = `sequence_${(S.project && S.project.name ? S.project.name : "project").replace(/[^\w-]+/g, "_")}.csv`;
  download(name, "﻿" + toCsv(headers, rows));
  toast(`Exported ${rows.length} rows`);
}

/* ============================== settings ============================== */

function loadSettingsUI() {
  const s = S.settings;
  $("#set-mark").value = s.markPaths.join("\n");
  $("#set-name").value = s.namePaths.join("\n");
  $("#set-region").value = s.region;
  $("#set-hl").value = s.highlight;
  $("#rec-phase").value = s.phase;
  $("#rec-template").value = s.template;
  $("#ps-link").value = s.linkTemplate;
  $("#play-speed").value = s.play.speed; $("#play-future").value = s.play.future;
  $("#play-unseq").value = s.play.unseq; $("#play-built").value = s.play.built; $("#play-zoom").checked = s.play.zoom;
}

function saveSettings() {
  const s = S.settings;
  s.markPaths = $("#set-mark").value.split("\n").map((x) => x.trim()).filter(Boolean);
  s.namePaths = $("#set-name").value.split("\n").map((x) => x.trim()).filter(Boolean);
  s.region = $("#set-region").value;
  s.highlight = $("#set-hl").value;
  s.phase = $("#rec-phase").value; s.template = $("#rec-template").value;
  s.play = { speed: Number($("#play-speed").value), future: $("#play-future").value, unseq: $("#play-unseq").value, built: $("#play-built").value, zoom: $("#play-zoom").checked };
  S.markIndex = null;
  store.set("mt-seq-settings", s);
}

async function showPropPicker(obj) {
  const box = $("#prop-picker");
  box.hidden = false;
  if (!obj) {
    const sel = await S.viewer.getSelection();
    const byModel = {};
    for (const mo of sel) if (mo.objectRuntimeIds && mo.objectRuntimeIds.length) { byModel[mo.modelId] = [mo.objectRuntimeIds[0]]; break; }
    if (!Object.keys(byModel).length) { box.innerHTML = "<div>Select one object in the 3D view.</div>"; return; }
    [obj] = await describe(byModel);
  }
  const props = listProperties(obj.props);
  box.innerHTML = props.length
    ? props.map(([p, v]) => `<div data-path="${esc(p)}" title="Click to use as the Mark property"><b>${esc(p)}</b><span>${esc(v)}</span></div>`).join("")
    : "<div>No properties on this object.</div>";
}

/* ============================== re-resolve on load ============================== */

async function resolveRuntimeIds() {
  S.models = await S.viewer.getLoadedModels();
  const items = [...S.items.values()].filter((i) => i.guid);
  if (!items.length || !S.models.length) return;
  S.ridIndex.clear();
  const found = await S.viewer.resolveGuids(items.map((i) => i.guid), S.models);
  for (const it of items) {
    const f = found.get(it.key);
    if (f) { it.modelId = f.modelId; it.runtimeId = f.runtimeId; S.ridIndex.set(ridKey(f.modelId, f.runtimeId), it.key); }
    else it.runtimeId = undefined;
  }
  S.markIndex = null;
  await fillMissingMarks();
  renderList();
}

async function fillMissingMarks() {
  const need = [...S.items.values()].filter((i) => i.runtimeId !== undefined && (!i.mark || !i.name));
  const by = groupByModel(need);
  for (const [modelId, ids] of Object.entries(by)) {
    const objs = await S.viewer.describe(modelId, ids, S.settings.markPaths, S.settings.namePaths);
    for (const o of objs) {
      const it = S.items.get(S.ridIndex.get(ridKey(modelId, o.runtimeId)));
      if (it) { it.mark = it.mark || o.mark; it.name = it.name || o.name; }
    }
  }
}

/* ============================== drag & drop re-ordering ============================== */

function dragKeys(tr, kind) {
  const key = tr.dataset.key;
  const it = S.items.get(key);
  if (!it) return [];
  if (kind === "step") return [...S.items.values()].filter((i) => i.seqId === it.seqId).map((i) => i.key);
  if (S.selectedKeys.has(key) && S.selectedKeys.size > 1) return [...S.selectedKeys].filter((k) => S.items.has(k));
  return [key];
}

function dropZone(tr, clientY) {
  const r = tr.getBoundingClientRect();
  const f = (clientY - r.top) / r.height;
  return f < 0.3 ? "before" : f > 0.7 ? "after" : "join";
}

function clearDropMarks() {
  $$("#seq-table tr.drop-before, #seq-table tr.drop-after, #seq-table tr.drop-join, #seq-table tr.dragging")
    .forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-join", "dragging"));
}

// Pointer-based dragging (mouse, pen and touch). The browser's native drag-and-drop is
// unreliable inside Trimble Connect's extension frame, so rows are moved by hand here.
function finishDrop(keys, targetKey, mode) {
  const res = moveInSequence([...S.items.values()], keys, targetKey, mode, $("#rec-template").value, $("#rec-phase").value.trim());
  if (!res) return;
  const moved = S.items.get(keys[0]);
  $("#rec-next").value = maxOrder() + 1;
  S.holdN = null; $("#rec-nextstep").disabled = true;
  S.play.painted = -1;
  $("#inspector").hidden = true;
  toast(`${keys.length > 1 ? keys.length + " objects" : moved.mark || "Object"} ${mode === "join" ? "joined" : "moved to"} step ${moved.order} (${moved.seqId}) · ${res.changed} updated`);
  persist(); renderList();
  if (S.recording) S.viewer.setState(groupByModel(keys.map((k) => S.items.get(k))), { color: RECORDED });
}

function wireDrag(tb) {
  const wrap = tb.closest(".table-wrap");
  let d = null; // active drag state

  const rowAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const tr = el && el.closest && el.closest("#seq-table tbody tr");
    return tr && tr.dataset.key ? tr : null;
  };
  const markTarget = (tr, zone) => {
    $$("#seq-table tr.drop-before, #seq-table tr.drop-after, #seq-table tr.drop-join").forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-join"));
    if (tr) tr.classList.add("drop-" + zone);
  };
  const autoScroll = () => {
    if (!d || !d.active) return;
    const r = wrap.getBoundingClientRect();
    const edge = 36;
    let dy = 0;
    if (d.y < r.top + edge) dy = -Math.ceil((r.top + edge - d.y) / 4);
    else if (d.y > r.bottom - edge) dy = Math.ceil((d.y - (r.bottom - edge)) / 4);
    if (dy) { wrap.scrollTop += dy; update(); }
    d.raf = requestAnimationFrame(autoScroll);
  };
  const update = () => {
    d.ghost.style.transform = `translate(${d.x + 14}px, ${d.y + 10}px)`;
    const tr = rowAt(d.x, d.y);
    if (!tr || d.keys.includes(tr.dataset.key)) { d.target = null; markTarget(null); return; }
    d.target = tr.dataset.key;
    d.zone = dropZone(tr, d.y);
    markTarget(tr, d.zone);
    d.ghost.lastChild.textContent = d.zone === "join" ? `join step ${tr.dataset.step}` : `${d.zone} step ${tr.dataset.step}`;
  };
  const start = () => {
    d.active = true;
    d.keys.forEach((k) => { const r = tb.querySelector(`tr[data-key="${CSS.escape(k)}"]`); if (r) r.classList.add("dragging"); });
    const first = S.items.get(d.keys[0]);
    const g = document.createElement("div");
    g.className = "drag-ghost";
    g.innerHTML = `<b>${esc(d.kind === "step" ? first.seqId : first.mark || first.seqId)}${d.keys.length > 1 ? ` <span>+${d.keys.length - 1}</span>` : ""}</b><small></small>`;
    document.body.appendChild(g);
    d.ghost = g;
    document.body.classList.add("is-dragging");
    d.raf = requestAnimationFrame(autoScroll);
  };
  const end = (commit) => {
    if (!d) return;
    const done = d;
    d = null;
    cancelAnimationFrame(done.raf);
    if (done.ghost) done.ghost.remove();
    document.body.classList.remove("is-dragging");
    clearDropMarks();
    try { done.handle.releasePointerCapture(done.pointerId); } catch { /* already released */ }
    if (done.active) {
      S.suppressClick = true;
      setTimeout(() => (S.suppressClick = false), 0);
      if (commit && done.target) finishDrop(done.keys, done.target, done.zone);
    }
  };

  tb.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest && e.target.closest("[data-drag]");
    if (!handle || e.button > 0) return;
    const tr = handle.closest("tr");
    const keys = dragKeys(tr, handle.dataset.drag);
    if (!keys.length) return;
    e.preventDefault();
    d = { keys, kind: handle.dataset.drag, handle, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false };
    try { handle.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  });
  tb.addEventListener("pointermove", (e) => {
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.active && Math.hypot(d.x - d.x0, d.y - d.y0) > 4) start();
    if (d.active) { e.preventDefault(); update(); }
  });
  tb.addEventListener("pointerup", (e) => { if (d && e.pointerId === d.pointerId) end(true); });
  tb.addEventListener("pointercancel", () => end(false));
  tb.addEventListener("lostpointercapture", () => { if (d && d.active) end(true); else d = null; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && d) end(false); });
  // stop the browser starting its own text/element drag
  tb.addEventListener("dragstart", (e) => { if (e.target.closest && e.target.closest("[data-drag]")) e.preventDefault(); });
}

/* ============================== confirm dialog ============================== */
// In-panel dialog: browser confirm() is often blocked inside Trimble Connect's iframe.
function askConfirm(title, detail = "") {
  return new Promise((resolve) => {
    const box = $("#confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-detail").textContent = detail;
    box.hidden = false;
    const done = (v) => { box.hidden = true; $("#confirm-ok").onclick = $("#confirm-cancel").onclick = null; resolve(v); };
    $("#confirm-ok").onclick = () => done(true);
    $("#confirm-cancel").onclick = () => done(false);
    $("#confirm-ok").focus();
  });
}

/* ============================== wiring ============================== */

function wire() {
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".tab-body").forEach((s) => (s.hidden = s.dataset.tab !== b.dataset.tab));
    if (b.dataset.tab === "play") preparePlay();
  }));

  // record
  $("#rec-toggle").onclick = toggleRecording;
  $("#rec-nextstep").onclick = nextHeldStep;
  $("#rec-hold").onchange = () => { if (!$("#rec-hold").checked) nextHeldStep(); };
  ["#rec-phase", "#rec-template", "#rec-next"].forEach((s) => $(s).addEventListener("input", () => { updatePreview(); S.settings.phase = $("#rec-phase").value; S.settings.template = $("#rec-template").value; store.set("mt-seq-settings", S.settings); }));
  $("#rec-undo").onclick = undoLastStep;
  $("#rec-remove").onclick = removeSelected;
  $("#rec-renumber").onclick = doRenumber;
  $("#rec-clear").onclick = clearAll;
  $("#list-filter").oninput = renderList;

  const tb = $("#seq-table tbody");
  wireDrag(tb);
  tb.addEventListener("change", (e) => {
    const k = e.target.dataset && e.target.dataset.edit;
    if (!k) return;
    const it = S.items.get(k);
    if (it) { it.seqId = e.target.value.trim(); it.dirty = true; if (it.source === "click") it.source = "edit"; persist(); renderList(); }
  });
  tb.addEventListener("click", async (e) => {
    if (e.target.tagName === "INPUT" || S.suppressClick) return;
    const tr = e.target.closest("tr");
    if (!tr) return;
    if (!tr) return;
    const it = S.items.get(tr.dataset.key);
    if (!it || it.runtimeId === undefined) return;
    // select every object in the same step
    const step = [...S.items.values()].filter((x) => x.seqId === it.seqId && x.runtimeId !== undefined);
    await S.viewer.setSelection(groupByModel(step), "set");
    await S.viewer.zoomTo(groupByModel(step));
  });

  // CSV
  const drop = $("#csv-drop"), file = $("#csv-file");
  const readFile = (f) => { const r = new FileReader(); r.onload = () => loadCsvText(r.result, f.name); r.readAsText(f); };
  file.onchange = () => file.files[0] && readFile(file.files[0]);
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
  $$("#csv-map select[data-col]").forEach((s) => (s.onchange = () => { prepareSchedule(); $("#csv-apply").hidden = true; }));
  $("#csv-match").onclick = () => matchCsv().catch((e) => toast(e.message, true));
  $("#csv-apply").onclick = applyCsv;
  $("#csv-sample").onclick = () => loadCsvText(SAMPLE_SCHEDULE, "schedule_template.csv");
  $("#export-close").onclick = () => ($("#export-modal").hidden = true);
  $("#export-copy").onclick = async () => {
    const ta = $("#export-text");
    try { await navigator.clipboard.writeText(ta.value); toast("Copied"); }
    catch { ta.focus(); ta.select(); toast("Press Ctrl+C to copy"); }
  };
  $("#auto-assign").onchange = () => {
    if ($("#auto-assign").checked) {
      prepareSchedule();
      if (S.recording) toggleRecording();
      toast("Auto-assign on: select objects in the 3D view");
    }
  };

  // play
  $("#play-toggle").onclick = togglePlay;
  $("#play-next").onclick = () => { stopPlay(); preparePlay(); goTo(Math.max(S.play.k, 0) + 1); };
  $("#play-prev").onclick = () => { stopPlay(); preparePlay(); goTo(Math.max(S.play.k - 1, 0)); };
  $("#play-first").onclick = () => { stopPlay(); preparePlay(); S.play.painted = -1; goTo(0); };
  $("#play-last").onclick = () => { stopPlay(); preparePlay(); S.play.painted = -1; goTo(S.play.steps.length); };
  $("#play-slider").oninput = (e) => { stopPlay(); S.play.painted = -1; goTo(Number(e.target.value)); };
  ["#play-future", "#play-unseq", "#play-built"].forEach((s) => ($(s).onchange = () => { saveSettings(); if (S.play.k >= 0) { S.play.painted = -1; goTo(S.play.k); } }));
  ["#play-speed", "#play-zoom"].forEach((s) => ($(s).onchange = saveSettings));
  $("#play-reset").onclick = resetView;
  $("#vid-export").onclick = exportVideo;
  $("#vid-cancel").onclick = () => { if (S.video) S.video.cancelled = true; $("#vid-status").textContent = "Cancelling…"; };
  $("#video-close").onclick = () => { $("#video-modal").hidden = true; $("#video-preview").pause(); };

  // pset
  $("#ps-connect").onclick = psConnect;
  $("#ps-lib").onchange = () => psLoadDefs().catch((e) => psLog(e.message, "bad"));
  $("#ps-def").onchange = () => psLoadFields().catch((e) => psLog(e.message, "bad"));
  $$("#ps-config select[data-field]").forEach((s) => (s.onchange = psSaveConfig));
  $("#ps-link").onchange = psSaveConfig;
  $("#ps-detect").onclick = psDetect;
  $("#ps-write-dirty").onclick = () => psWrite("dirty");
  $("#ps-write-sel").onclick = () => psWrite("selected");
  $("#ps-write-all").onclick = async () => { if (await askConfirm("Rewrite the property set on every sequenced object?")) psWrite("all"); };
  $("#ps-load").onclick = psLoad;
  $("#export-csv").onclick = exportCsv;

  // settings
  $("#set-save").onclick = () => { saveSettings(); toast("Settings saved"); resolveRuntimeIds(); };
  $("#set-pick").onclick = () => showPropPicker().catch((e) => toast(e.message, true));
  $("#prop-picker").addEventListener("click", (e) => {
    const row = e.target.closest("[data-path]");
    if (!row) return;
    const ta = $("#set-mark");
    const lines = ta.value.split("\n").filter((l) => l.trim() && l.trim() !== row.dataset.path);
    ta.value = [row.dataset.path, ...lines].join("\n");
    toast(`"${row.dataset.path}" will be used as the Mark — press Save`);
  });
}

/* ============================== boot ============================== */

async function boot() {
  $("#app-version").textContent = "v" + APP_VERSION;
  wire();
  S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...store.get("mt-seq-settings", {}) };
  loadSettingsUI();

  const params = new URLSearchParams(location.search);
  let mockApi = null;
  if (params.has("mock") || window.TC_SEQ_DEMO || window.parent === window) {
    document.body.classList.add("mock");
    $("#demo-banner").hidden = false;
    $("#csv-sample").hidden = false;
    $("#mock-viewer").hidden = false;
    mockApi = (await import("./mock.js?v=1.3.0")).createMock($("#mock-viewer"));
  }

  try {
    S.viewer.on("viewer.onSelectionChanged", onSelectionChanged);
    S.viewer.on("viewer.onModelStateChanged", () => setTimeout(resolveRuntimeIds, 500));
    await S.viewer.connect({ mockApi });
    $("#conn-dot").className = "dot on";
    S.project = await S.viewer.getProject();
    $("#project-name").textContent = S.project ? S.project.name : "Trimble Connect";

    const saved = store.get(seqKey(), null);
    if (saved && saved.items) {
      for (const it of saved.items) S.items.set(it.key, { ...it, order: it.order === null ? NaN : it.order, runtimeId: undefined });
      $("#rec-next").value = saved.nextN || maxOrder() + 1;
    }
    await resolveRuntimeIds();
    renderList();
    if (S.items.size) toast(`Restored ${S.items.size} sequenced objects`);
  } catch (e) {
    console.error(e);
    $("#conn-dot").className = "dot err";
    $("#project-name").textContent = "Not connected: " + e.message;
  }
  updatePreview();
}

boot();
