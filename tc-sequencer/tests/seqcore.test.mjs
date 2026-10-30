import test from "node:test";
import assert from "node:assert/strict";
import {
  ifcToUuid, uuidToIfc, guidKey, guidVariants, formatSeqId, parseCsv, toCsv, guessColumns,
  buildSchedule, buildSteps, renumber, findProperty, matchSchedule, inferLinkTemplate, fillLink, linkContext,
} from "../js/seqcore.js";

test("IFC GUID round-trip", () => {
  const uuid = "0b7a2c54-0000-0123-3134-353238363633";
  const ifc = uuidToIfc(uuid);
  assert.equal(ifc.length, 22);
  assert.equal(ifcToUuid(ifc), uuid);
  // known pair (buildingSMART example)
  assert.equal(ifcToUuid("3DJeUW9VD6Ix2u6WkUKIF3"), ifcToUuid(uuidToIfc(ifcToUuid("3DJeUW9VD6Ix2u6WkUKIF3"))));
});

test("guidKey normalises spellings", () => {
  const u = "0B7A2C54-0000-0123-3134-353238363633";
  const k = "0b7a2c54-0000-0123-3134-353238363633";
  assert.equal(guidKey(u), k);
  assert.equal(guidKey("{" + u + "}"), k);
  assert.equal(guidKey("ID" + u), k);
  assert.equal(guidKey(u.replace(/-/g, "")), k);
  assert.equal(guidKey(uuidToIfc(k)), k);
  assert.ok(guidVariants(u).includes(uuidToIfc(k)));
});

test("formatSeqId", () => {
  assert.equal(formatSeqId("{phase}-{n:3}", { phase: "L2", n: 7 }), "L2-007");
  assert.equal(formatSeqId("SEQ{n}", { n: 12 }), "SEQ12");
});

test("parseCsv handles quotes, semicolons, BOM", () => {
  const t = '﻿Mark;Sequence ID;Note\nB12;L2-001;"has ; semi"\n"C""1";L2-002;\n\n';
  const { headers, rows } = parseCsv(t);
  assert.deepEqual(headers, ["Mark", "Sequence ID", "Note"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Note, "has ; semi");
  assert.equal(rows[1].Mark, 'C"1');
  const back = parseCsv(toCsv(headers, rows));
  assert.deepEqual(back.rows, rows);
});

test("guessColumns", () => {
  const g = guessColumns(["IFC GUID", "Assembly Mark", "Sequence ID", "Install Order", "Phase", "Planned Date"]);
  assert.deepEqual(g, { guid: "IFC GUID", mark: "Assembly Mark", seqId: "Sequence ID", order: "Install Order", phase: "Phase", date: "Planned Date" });
});

test("buildSchedule skips bad rows", () => {
  const { records, skipped } = buildSchedule(
    [{ M: "B1", S: "A-1", O: "3" }, { M: "", S: "A-2", O: "" }, { M: "B3", S: "", O: "" }],
    { mark: "M", seqId: "S", order: "O" });
  assert.equal(records.length, 1);
  assert.equal(records[0].order, 3);
  assert.equal(skipped.length, 2);
});

test("buildSteps groups by ID and orders numerically then naturally", () => {
  const steps = buildSteps([
    { seqId: "P1-010", order: NaN }, { seqId: "P1-2", order: NaN }, { seqId: "X", order: 1 }, { seqId: "P1-2", order: NaN },
  ]);
  assert.deepEqual(steps.map((s) => s.seqId), ["X", "P1-2", "P1-010"]);
  assert.equal(steps[1].items.length, 2);
});

test("renumber closes gaps for click items only", () => {
  const items = [
    { seqId: "P1-001", order: 1, source: "click" },
    { seqId: "P1-005", order: 5, source: "click" },
    { seqId: "CSV-9", order: 7, source: "csv" },
  ];
  renumber(items, "{phase}-{n:3}", "P1");
  assert.deepEqual(items.map((i) => i.seqId), ["P1-001", "P1-002", "CSV-9"]);
  assert.deepEqual(items.map((i) => i.order), [1, 2, 3]);
});

test("findProperty with set-qualified and bare paths", () => {
  const p = { properties: [{ name: "Tekla Assembly", properties: [{ name: "Assembly/Cast unit Mark", value: "B12" }] }, { name: "Other", properties: [{ name: "Tag", value: "T1" }] }] };
  assert.equal(findProperty(p, ["Tekla Assembly.Assembly/Cast unit Mark"]), "B12");
  assert.equal(findProperty(p, ["Nope.Mark", "Tag"]), "T1");
  assert.equal(findProperty(p, ["Missing"]), "");
});

test("matchSchedule: GUID beats Mark, ambiguous marks reported", () => {
  const g1 = "11111111-1111-1111-1111-111111111111";
  const objects = [
    { key: g1, mark: "B1" }, { key: "22222222-2222-2222-2222-222222222222", mark: "B1" }, { key: "33333333-3333-3333-3333-333333333333", mark: "C1" },
  ];
  const recs = [
    { guid: g1.toUpperCase(), mark: "", seqId: "S1" },
    { guid: "", mark: "b1", seqId: "S2" },
    { guid: "", mark: "C1", seqId: "S3" },
    { guid: "", mark: "ZZ", seqId: "S4" },
  ];
  const r = matchSchedule(recs, objects);
  const m = Object.fromEntries(r.assignments.map((a) => [a.objKey, a.rec.seqId]));
  assert.equal(m[g1], "S1");                       // GUID row claimed it
  assert.equal(m["22222222-2222-2222-2222-222222222222"], "S2"); // mark row gets the unclaimed one
  assert.equal(m["33333333-3333-3333-3333-333333333333"], "S3");
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.ambiguous.length, 0);
});

test("link template inference + fill", () => {
  const item = { guid: "0B7A2C54-0000-0123-3134-353238363633", modelId: "ver123" };
  const ctx = linkContext(item, "proj9");
  const link = `frn:tcfile:ver123:entity:${ctx.guid22}`;
  const t = inferLinkTemplate(link, ctx);
  assert.match(t, /^frn:tcfile:\{(modelId|versionId)\}:entity:\{guid22\}$/);
  assert.equal(fillLink(t, ctx), link);
  assert.equal(fillLink("frn:entity:{guid}", ctx), "frn:entity:0B7A2C54-0000-0123-3134-353238363633");
});
