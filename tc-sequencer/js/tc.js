// tc.js — thin wrapper around the Trimble Connect Workspace API (3D Viewer).
import { guidKey, guidVariants, findProperty } from "./seqcore.js?v=1.3.1";

const CDN_URLS = [
  "https://components.connect.trimble.com/trimble-connect-workspace-api/index.js",
  "https://cdn.jsdelivr.net/npm/trimble-connect-workspace-api@0.3.38/dist/iife/trimbleconnect.workspace.api.js",
];

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

async function getWorkspaceLib() {
  const pick = () => window.WorkspaceAPI || window.TrimbleConnectWorkspace;
  if (pick()) return pick();
  for (const url of CDN_URLS) {
    try { await loadScript(url); if (pick()) return pick(); } catch { /* try next */ }
  }
  throw new Error("Could not load the Trimble Connect Workspace API script.");
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

export class Viewer {
  constructor() {
    this.api = null;
    this.handlers = {};
    this.tokenWaiters = [];
    this.accessToken = null;
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
  emit(evt, data, args) { (this.handlers[evt] || []).forEach((f) => { try { f(data, args); } catch (e) { console.error(e); } }); }

  async connect({ mockApi } = {}) {
    const onEvent = (event, args) => {
      const data = args && "data" in args ? args.data : args;
      if (event === "extension.accessToken") {
        this.accessToken = data;
        this.tokenWaiters.splice(0).forEach((w) => w(data));
      }
      this.emit(event, data, args || {});
    };
    if (mockApi) {
      this.api = await mockApi.connect(onEvent);
    } else {
      const lib = await getWorkspaceLib();
      this.api = await lib.connect(window.parent, onEvent, 30000);
    }
    return this.api;
  }

  /* ---------- project / auth ---------- */

  async getProject() {
    const p = this.api.project;
    return (p.getProject ? p.getProject() : p.getCurrentProject());
  }

  /** Ask Connect for the user's access token (user approves once). */
  async getAccessToken() {
    if (this.accessToken && this.accessToken !== "pending") return this.accessToken;
    const waiter = new Promise((res, rej) => {
      this.tokenWaiters.push(res);
      setTimeout(() => rej(new Error("Timed out waiting for access token approval.")), 120000);
    });
    const r = await this.api.extension.requestPermission("accesstoken");
    if (r && r !== "pending" && r !== "denied") { this.accessToken = r; return r; }
    if (r === "denied") throw new Error("Access token permission was denied.");
    return waiter;
  }

  status(msg) { try { this.api.extension.setStatusMessage(msg); } catch { /* optional */ } }

  /* ---------- models / selection ---------- */

  async getLoadedModels() {
    const models = await this.api.viewer.getModels("loaded");
    return models || [];
  }

  async getSelection() { return (await this.api.viewer.getSelection()) || []; }

  async setSelection(byModel, mode = "set") {
    const modelObjectIds = Object.entries(byModel).map(([modelId, ids]) => ({ modelId, objectRuntimeIds: ids }));
    await this.api.viewer.setSelection({ modelObjectIds }, mode);
  }

  /**
   * Describe runtime objects: external GUID + mark + display name.
   * @returns [{ modelId, runtimeId, guid, key, mark, name }]
   */
  async describe(modelId, runtimeIds, markPaths, namePaths = []) {
    const out = [];
    for (const ids of chunk(runtimeIds, 200)) {
      const [guids, props] = await Promise.all([
        this.safeConvertToGuids(modelId, ids),
        this.api.viewer.getObjectProperties(modelId, ids).catch(() => []),
      ]);
      const propById = new Map((props || []).map((p) => [p.id, p]));
      ids.forEach((rid, i) => {
        const p = propById.get(rid) || {};
        const guid = guids[i] || "";
        out.push({
          modelId, runtimeId: rid, guid, key: guidKey(guid),
          mark: findProperty(p, markPaths),
          name: findProperty(p, namePaths) || (p.product && p.product.name) || p.class || "",
          props: p,
        });
      });
    }
    return out;
  }

  /** convertToObjectIds throws if any id has no external id — split and retry. */
  async safeConvertToGuids(modelId, ids) {
    try { return await this.api.viewer.convertToObjectIds(modelId, ids); }
    catch (e) {
      if (ids.length === 1) return [""];
      const mid = Math.ceil(ids.length / 2);
      const [a, b] = await Promise.all([this.safeConvertToGuids(modelId, ids.slice(0, mid)), this.safeConvertToGuids(modelId, ids.slice(mid))]);
      return a.concat(b);
    }
  }

  /**
   * Resolve GUIDs (any spelling) to runtime ids across loaded models.
   * @returns Map<guidKey, {modelId, runtimeId, guid}>
   */
  async resolveGuids(rawGuids, models) {
    const found = new Map();
    const todo = new Map(); // key -> raw
    for (const g of rawGuids) { const k = guidKey(g); if (k && !todo.has(k)) todo.set(k, g); }
    for (const m of models) {
      const remaining = [...todo.entries()].filter(([k]) => !found.has(k));
      if (!remaining.length) break;
      // Try each spelling variant in batches
      const variantRows = [];
      for (const [k, raw] of remaining) for (const v of guidVariants(raw)) variantRows.push([k, v]);
      for (const part of chunk(variantRows, 1000)) {
        const pending = part.filter(([k]) => !found.has(k));
        if (!pending.length) continue;
        let rids = [];
        try { rids = await this.api.viewer.convertToObjectRuntimeIds(m.id, pending.map((r) => r[1])); } catch { rids = []; }
        pending.forEach(([k, v], i) => {
          const rid = rids[i];
          if (rid !== undefined && rid !== null && !found.has(k)) found.set(k, { modelId: m.id, runtimeId: rid, guid: v });
        });
      }
    }
    return found;
  }

  /** Every object runtime id in the loaded models: [{modelId, ids:[]}] */
  async getAllObjectIds() {
    const res = await this.api.viewer.getObjects();
    return (res || []).map((mo) => ({ modelId: mo.modelId, ids: (mo.objects || []).map((o) => o.id) }));
  }

  /* ---------- visual state ---------- */

  async setState(byModel, state) {
    const entries = Object.entries(byModel).filter(([, ids]) => ids.length);
    if (!entries.length) return;
    // keep messages a manageable size
    for (const [modelId, ids] of entries) {
      for (const part of chunk(ids, 5000)) {
        await this.api.viewer.setObjectState({ modelObjectIds: [{ modelId, objectRuntimeIds: part }] }, state);
      }
    }
  }

  async setAll(state) { await this.api.viewer.setObjectState(undefined, state); }

  async snapshot() { return this.api.viewer.getSnapshot(); }

  async resetAll() { await this.api.viewer.setObjectState(undefined, { visible: "reset", color: "reset" }); }

  async zoomTo(byModel) {
    const modelObjectIds = Object.entries(byModel).map(([modelId, ids]) => ({ modelId, objectRuntimeIds: ids }));
    try { await this.api.viewer.setCamera({ modelObjectIds }, { animationTime: 400 }); } catch { /* optional */ }
  }
}

/** Group items -> { modelId: [runtimeIds] } */
export function groupByModel(items) {
  const out = {};
  for (const it of items) {
    if (it.runtimeId === undefined || it.runtimeId === null || !it.modelId) continue;
    (out[it.modelId] ||= []).push(it.runtimeId);
  }
  return out;
}
