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

import { moveInSequence } from "../js/seqcore.js";
const mk = () => [1, 2, 3, 4].map((n) => ({ key: "k" + n, seqId: `P1-00${n}`, order: n, phase: "P1", source: "click" }));
const ids = (items) => buildSteps(items).map((s) => s.items.map((i) => i.key).join("+") + "=" + s.seqId);

test("drag: move a step earlier renumbers click IDs", () => {
  const items = mk();
  moveInSequence(items, ["k4"], "k1", "before", "{phase}-{n:3}", "P1");
  assert.deepEqual(ids(items), ["k4=P1-001", "k1=P1-002", "k2=P1-003", "k3=P1-004"]);
  assert.ok(items.every((i) => i.dirty));
});

test("drag: move after / join step", () => {
  const items = mk();
  moveInSequence(items, ["k1"], "k3", "after", "{phase}-{n:3}", "P1");
  assert.deepEqual(ids(items), ["k2=P1-001", "k3=P1-002", "k1=P1-003", "k4=P1-004"]);
  moveInSequence(items, ["k4"], "k2", "join", "{phase}-{n:3}", "P1");
  assert.deepEqual(ids(items), ["k2+k4=P1-001", "k3=P1-002", "k1=P1-003"]);
});

test("drag: split one object out of a click step", () => {
  const items = mk();
  moveInSequence(items, ["k4"], "k2", "join", "{phase}-{n:3}", "P1"); // k2+k4
  moveInSequence(items, ["k4"], "k3", "after", "{phase}-{n:3}", "P1");
  assert.deepEqual(ids(items), ["k1=P1-001", "k2=P1-002", "k3=P1-003", "k4=P1-004"]);
});

test("drag: CSV IDs are kept, split part gets suffix", () => {
  const items = [
    { key: "a", seqId: "L1-COL-01", order: 1, source: "csv" },
    { key: "b", seqId: "L1-COL-01", order: 1, source: "csv" },
    { key: "c", seqId: "L1-BM-01", order: 2, source: "csv" },
  ];
  moveInSequence(items, ["b"], "c", "after", "{phase}-{n:3}", "P1");
  assert.deepEqual(ids(items), ["a=L1-COL-01", "c=L1-BM-01", "b=L1-COL-01-2"]);
  assert.equal(moveInSequence(items, ["a"], "a", "before", "", ""), null);
});

import { AvcNormalizer, splitAnnexB, parseAvcC, buildAvcC, isAnnexB } from "../js/h264.js";
const SPS = new Uint8Array([0x67, 0x4d, 0x00, 0x28, 0xab, 0xcd]);
const PPS = new Uint8Array([0x68, 0xee, 0x3c, 0x80]);
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x01, 0x02]);
const P = new Uint8Array([0x41, 0x9a, 0x02]);
const annexB = (...nals) => new Uint8Array(nals.flatMap((n, i) => [...(i % 2 ? [0, 0, 1] : [0, 0, 0, 1]), ...n]));
const lp = (...nals) => new Uint8Array(nals.flatMap((n) => [0, 0, 0, n.length, ...n]));

test("h264: Annex B without avcC (Firefox) becomes avcC + length-prefixed", () => {
  const n = new AvcNormalizer();
  const aud = new Uint8Array([0x09, 0xf0]);
  const first = n.process(annexB(aud, SPS, PPS, IDR), undefined);
  assert.deepEqual([...first.data], [...lp(IDR)]);
  const rec = parseAvcC(first.description);
  assert.equal(rec.lengthSize, 4);
  assert.deepEqual([...rec.sps[0]], [...SPS]);
  assert.deepEqual([...rec.pps[0]], [...PPS]);
  assert.deepEqual([...first.description.slice(0, 4)], [1, 0x4d, 0x00, 0x28]);
  const second = n.process(annexB(P), undefined);
  assert.equal(second.description, undefined);
  assert.deepEqual([...second.data], [...lp(P)]);
});

test("h264: Chrome-style output passes through with a rebuilt avcC", () => {
  const n = new AvcNormalizer();
  const first = n.process(lp(IDR), buildAvcC([SPS], [PPS]));
  assert.deepEqual([...first.data], [...lp(IDR)]);
  assert.ok(parseAvcC(first.description));
  assert.ok(!isAnnexB(first.data));
});

test("h264: empty avcC and no SPS is an error, not a broken file", () => {
  assert.throws(() => new AvcNormalizer().process(lp(IDR), new Uint8Array(0)), /SPS\/PPS/);
  assert.equal(splitAnnexB(annexB(SPS, PPS)).length, 2);
});

test("h264: a 300-byte NAL's length prefix (00 00 01 2c) is not mistaken for a start code", () => {
  const big = new Uint8Array(300).fill(0x11); big[0] = 0x41;
  const sample = new Uint8Array([0, 0, 1, 44, ...big]);
  const n = new AvcNormalizer();
  n.process(lp(IDR), buildAvcC([SPS], [PPS]));
  const out = n.process(sample, undefined);
  assert.deepEqual([...out.data], [...sample]);
});

import { decodeTimeline } from "../js/h264.js";
test("h264: decode timeline for B-frames is increasing and never after PTS", () => {
  const d = 50000;
  // typical IBBP decode order: I0 P3 B1 B2 P6 B4 B5
  const pts = [0, 3, 1, 2, 6, 4, 5].map((x) => x * d);
  const { dts, delay } = decodeTimeline(pts);
  assert.equal(delay, d); // one frame of reorder delay is enough here
  for (let i = 1; i < dts.length; i++) assert.ok(dts[i] > dts[i - 1]);
  dts.forEach((t, i) => assert.ok(t <= pts[i]));
  // no B-frames: unchanged
  assert.deepEqual(decodeTimeline([0, d, 2 * d]).dts, [0, d, 2 * d]);
});
