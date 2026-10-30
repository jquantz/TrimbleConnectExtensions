// mock.js — LOCAL DEMO ONLY. Fakes the Trimble Connect 3D viewer + property set service
// so the panel can be tried (and tested) outside Connect: open index.html?mock directly.

const MODEL_ID = "mock-model-v1";

function makeObjects() {
  const objs = [];
  let id = 1;
  const guid = (n) => {
    const h = (n * 2654435761 >>> 0).toString(16).padStart(8, "0");
    return `${h}-0000-4${String(n).padStart(3, "0")}-8000-${(n * 97).toString(16).padStart(12, "0")}`;
  };
  const xs = [0, 6, 12, 18], ys = [0, 5, 10], H = 4;
  for (let lvl = 0; lvl < 2; lvl++) {
    const z = lvl * H, L = lvl + 1;
    let c = 1, b = 1, p = 1;
    for (const y of ys) for (const x of xs) {
      objs.push({ id: id++, kind: "COLUMN", mark: `C${L}${String(c++).padStart(2, "0")}`, name: "GLULAM COLUMN 300x300", box: [x - .15, y - .15, z, x + .15, y + .15, z + H - .8] });
    }
    for (const y of ys) for (let i = 0; i < 3; i++) {
      objs.push({ id: id++, kind: "BEAM", mark: `B${L}${String(b++).padStart(2, "0")}`, name: "GLULAM BEAM 265x608", box: [xs[i], y - .13, z + H - .8, xs[i + 1], y + .13, z + H - .2] });
    }
    for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) {
      objs.push({ id: id++, kind: "PANEL", mark: `P${L}${String(p++).padStart(2, "0")}`, name: "CLT 5-PLY 175", box: [xs[i] + .02, ys[j] + .02, z + H - .2, xs[i + 1] - .02, ys[j + 1] - .02, z + H] });
    }
  }
  // two pieces deliberately share a mark (identical assemblies) to exercise ambiguity
  objs.find((o) => o.mark === "B205").mark = "B204";
  objs.forEach((o) => (o.guid = guid(o.id)));
  return objs;
}

export function createMock(host) {
  const objs = makeObjects();
  const byId = new Map(objs.map((o) => [o.id, o]));
  const state = new Map(objs.map((o) => [o.id, { visible: true, color: null }]));
  let selection = new Set();
  let emit = () => {};

  /* ---------------- drawing ---------------- */
  const iso = ([x, y, z]) => [(x - y) * 0.866, (x + y) * 0.5 - z];
  const base = { COLUMN: "#c9a46b", BEAM: "#b98d52", PANEL: "#e2cfa6" };
  host.innerHTML = `<div class="mv-title">Demo model (mock viewer) — click to select · Ctrl/Shift-click to add</div><svg></svg>`;
  const svg = host.querySelector("svg");
  const pts = objs.flatMap((o) => { const [a, b, c, d, e, f] = o.box; return [iso([a, b, c]), iso([d, e, f]), iso([a, e, f]), iso([d, b, c])]; });
  const minX = Math.min(...pts.map((p) => p[0])) - 2, maxX = Math.max(...pts.map((p) => p[0])) + 2;
  const minY = Math.min(...pts.map((p) => p[1])) - 3, maxY = Math.max(...pts.map((p) => p[1])) + 2;
  svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  const sorted = [...objs].sort((a, b) => (a.box[0] + a.box[3] + a.box[1] + a.box[4] + a.box[2] + a.box[5]) - (b.box[0] + b.box[3] + b.box[1] + b.box[4] + b.box[2] + b.box[5]));

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
    return `rgb(${c.join(",")})`;
  }
  function draw() {
    svg.innerHTML = sorted.map((o) => {
      const st = state.get(o.id);
      if (!st.visible) return "";
      const [x0, y0, z0, x1, y1, z1] = o.box;
      const P = (x, y, z) => iso([x, y, z]).map((v) => v.toFixed(3)).join(",");
      let fill = base[o.kind], op = 1;
      if (st.color) { fill = `#${[st.color.r, st.color.g, st.color.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`; op = (st.color.a ?? 255) / 255; }
      const sel = selection.has(o.id);
      const stroke = sel ? "#0063a3" : "rgba(60,40,20,.55)";
      const sw = sel ? 0.09 : 0.025;
      const faces = [
        [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 1.0],
        [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], 0.8],
        [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], 0.65],
      ];
      return `<g data-id="${o.id}" style="cursor:pointer" fill-opacity="${op}">${faces.map((f) =>
        `<polygon points="${f.slice(0, 4).map((p) => P(...p)).join(" ")}" fill="${shade(fill.startsWith("#") ? fill : "#999999", f[4])}" stroke="${stroke}" stroke-width="${sw}"/>`).join("")}</g>`;
    }).join("");
  }
  svg.addEventListener("click", (e) => {
    const g = e.target.closest("g[data-id]");
    const id = g ? Number(g.dataset.id) : null;
    if (e.ctrlKey || e.metaKey || e.shiftKey) { if (id) selection.has(id) ? selection.delete(id) : selection.add(id); }
    else selection = new Set(id ? [id] : []);
    draw();
    emit("viewer.onSelectionChanged", { data: currentSelection() });
  });
  const currentSelection = () => (selection.size ? [{ modelId: MODEL_ID, objectRuntimeIds: [...selection] }] : []);
  draw();

  const idsOf = (selector) => {
    if (!selector || !selector.modelObjectIds) return objs.map((o) => o.id);
    return selector.modelObjectIds.flatMap((m) => m.objectRuntimeIds || objs.map((o) => o.id));
  };

  /* ---------------- fake property set service ---------------- */
  const psets = new Map(); // link|lib|def -> pset
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = new URL(url, location.href);
    if (!/pset-api|org-api/.test(u.host)) return realFetch(url, opts);
    await new Promise((r) => setTimeout(r, 120));
    const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    const p = decodeURIComponent(u.pathname);
    if (p.endsWith("/nodes/PSetLibs/links")) return json(["frn:lib:mt-lib-1"]);
    if (/\/libs\/[^/]+$/.test(p)) return json({ id: "mt-lib-1", name: "Metropolitan Timber" });
    if (/\/defs$/.test(p)) return json({ items: [{ id: "def-seq", name: "Construction Sequence" }] });
    if (/\/defs\/[^/]+$/.test(p)) return json({ id: "def-seq", name: "Construction Sequence", schema: { type: "object", properties: {
      SequenceID: { type: "string" }, SequenceNo: { type: "integer" }, Phase: { type: "string" }, PlannedDate: { type: "string" } } } });
    if (/\/psets$/.test(p)) return json({ items: [...psets.values()] });
    if (p.endsWith("/psets/changeset")) {
      const body = JSON.parse(opts.body);
      for (const it of body.items) {
        const k = `${it.link}|${it.libId}|${it.defId}`;
        const prev = psets.get(k);
        psets.set(k, { link: it.link, libId: it.libId, defId: it.defId, v: (prev ? prev.v : 0) + 1, props: { ...(prev ? prev.props : {}), ...it.props } });
      }
      window.__mockPsets = psets;
      return json({ status: "Done", itemCount: body.items.length, errorCount: 0, items: [] });
    }
    return json({ message: "not mocked" }, 404);
  };

  /* ---------------- fake Workspace API ---------------- */
  const api = {
    project: { getProject: async () => ({ id: "demo-project", name: "Demo — 2-storey mass timber frame", location: "northAmerica" }) },
    extension: { requestPermission: async () => "mock-token", setStatusMessage: async () => true },
    viewer: {
      getModels: async () => [{ id: MODEL_ID, versionId: MODEL_ID, name: "Demo_Timber_Frame.ifc", state: "loaded", type: "file", isLatestVersion: true }],
      getSelection: async () => currentSelection(),
      setSelection: async (selector, mode) => {
        const ids = idsOf(selector);
        if (mode === "set") selection = new Set(ids);
        else if (mode === "add") ids.forEach((i) => selection.add(i));
        else ids.forEach((i) => selection.delete(i));
        draw();
        emit("viewer.onSelectionChanged", { data: currentSelection(), origin: { isSelf: true } });
      },
      getObjects: async () => [{ modelId: MODEL_ID, objects: objs.map((o) => ({ id: o.id })) }],
      getObjectProperties: async (_m, ids) => ids.map((id) => {
        const o = byId.get(id);
        return { id, class: o.kind === "PANEL" ? "IfcSlab" : o.kind === "BEAM" ? "IfcBeam" : "IfcColumn", product: { name: o.name },
          properties: [
            { name: "Tekla Assembly", properties: [{ name: "Assembly/Cast unit Mark", value: o.mark, type: 5 }] },
            { name: "Tekla Common", properties: [{ name: "Name", value: o.name, type: 5 }, { name: "Phase", value: 1, type: 6 }] },
          ] };
      }),
      convertToObjectIds: async (_m, ids) => ids.map((id) => { const o = byId.get(id); if (!o) throw new Error("no id"); return o.guid; }),
      convertToObjectRuntimeIds: async (_m, guids) => guids.map((g) => { const o = objs.find((x) => x.guid.toLowerCase() === String(g).toLowerCase()); return o ? o.id : undefined; }),
      setObjectState: async (selector, st) => {
        for (const id of idsOf(selector)) {
          const s = state.get(id); if (!s) continue;
          if (st.visible !== undefined) s.visible = st.visible === "reset" ? true : st.visible;
          if (st.color !== undefined) s.color = st.color === "reset" ? null : typeof st.color === "string" ? hexObj(st.color) : st.color;
        }
        draw();
      },
      setCamera: async () => {},
    },
  };
  function hexObj(h) { const n = parseInt(h.replace("#", "").slice(0, 6), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 }; }

  window.__mock = { objs, state, select: (ids, add) => { if (!add) selection = new Set(); ids.forEach((i) => selection.add(i)); draw(); emit("viewer.onSelectionChanged", { data: currentSelection() }); } };

  return { connect: async (onEvent) => { emit = onEvent; return api; } };
}
