// pset.js — minimal client for the Trimble Connect Property Set (PSet) and Organizer services.
// Endpoints mirror the official trimble-connect-sdk (pset.js / organizer.js).

const REGION_HOSTS = {
  "us-east-1": "us-east-1", "eu-west-1": "eu-west-1", "eu-west-2": "eu-west-2",
  "ap-southeast-1": "ap-southeast-1", "ap-southeast-2": "ap-southeast-2",
};

/** Map a Connect project `location` to a service region. */
export function regionFromLocation(loc) {
  const l = String(loc || "").toLowerCase();
  if (REGION_HOSTS[l]) return l;
  if (l.includes("north") || l === "us" || l.includes("america")) return "us-east-1";
  if (l.includes("australia") || l === "ap-au") return "ap-southeast-2";
  if (l.includes("asia") || l === "ap") return "ap-southeast-1";
  if (l.includes("europe") || l === "eu") return "eu-west-1";
  return "us-east-1";
}

export class PSetClient {
  constructor({ region, getToken, refreshToken }) {
    this.setRegion(region);
    this.getToken = getToken;
    this.refreshToken = refreshToken;
  }

  setRegion(region) {
    this.region = REGION_HOSTS[region] || "us-east-1";
    this.psetBase = `https://pset-api.${this.region}.connect.trimble.com/v1/`;
    this.orgBase = `https://org-api.${this.region}.connect.trimble.com/v1/`;
  }

  async req(base, path, method = "GET", body, retried = false) {
    const token = await this.getToken();
    const url = path.startsWith("http") ? path : path.startsWith("/") ? new URL(base).origin + path : base + path;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried && this.refreshToken) {
      await this.refreshToken();
      return this.req(base, path, method, body, true);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error || data.code)) || res.statusText;
      const err = new Error(`${method} ${path.split("?")[0]} → ${res.status} ${msg}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  async pagedAll(base, path, limit = 100000) {
    const items = [];
    let next = path;
    while (next && items.length < limit) {
      const page = await this.req(base, next);
      if (Array.isArray(page)) { items.push(...page); break; }
      items.push(...((page && page.items) || []));
      next = page && page.next;
    }
    return items;
  }

  /* ---- discovery: libraries linked to the project ---- */
  async listProjectLibraryIds(projectId) {
    const forest = encodeURIComponent(`project:${projectId}:data`);
    const data = await this.req(this.orgBase, `forests/${forest}/trees/ProjectContext/nodes/PSetLibs/links`);
    const links = Array.isArray(data) ? data : (data && (data.items || data.links)) || [];
    return links
      .map((l) => (typeof l === "string" ? l : l.link || ""))
      .filter((l) => l.startsWith("frn:lib:"))
      .map((l) => decodeURIComponent(l.slice("frn:lib:".length)));
  }

  getLibrary(libId) { return this.req(this.psetBase, `libs/${encodeURIComponent(libId)}`); }
  listDefinitions(libId) { return this.pagedAll(this.psetBase, `libs/${encodeURIComponent(libId)}/defs`); }
  getDefinition(libId, defId) { return this.req(this.psetBase, `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(defId)}`); }

  /** All pset instances of a definition (used to read sequences back + detect link format). */
  listPSetsByDefinition(libId, defId, limit) {
    return this.pagedAll(this.psetBase, `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(defId)}/psets?top=500`, limit);
  }

  /** Write one pset instance (PATCH merges props). */
  updatePSet(link, libId, defId, props) {
    return this.req(this.psetBase, `psets/${encodeURIComponent(link)}/${encodeURIComponent(libId)}/${encodeURIComponent(defId)}`, "PATCH", { props });
  }

  /** Bulk write. Service runs ≤500 items synchronously, so we chunk at 500. */
  async changeset(items, onProgress) {
    const results = { ok: 0, failed: [] };
    for (let i = 0; i < items.length; i += 500) {
      const part = items.slice(i, i + 500);
      const res = await this.req(this.psetBase, "psets/changeset", "POST", { items: part });
      results.ok += (res && res.itemCount) || 0;
      if (res && res.errors) results.failed.push(...res.errors);
      if (res && res.status === "Failed") throw new Error(res.message || "Changeset failed");
      onProgress && onProgress(Math.min(i + 500, items.length), items.length);
    }
    return results;
  }
}

/**
 * Pull the property keys out of a definition schema (JSON-schema style),
 * with a human label when one exists in the schema or i18n tables.
 */
export function schemaFields(def) {
  const schema = (def && def.schema) || {};
  const props = schema.props || schema.properties || {};
  const i18n = (def && def.i18n) || {};
  const labelFromI18n = (key) => {
    for (const lang of Object.values(i18n)) {
      if (lang && typeof lang === "object") {
        if (typeof lang[key] === "string") return lang[key];
        const nested = lang.props || lang.properties;
        if (nested && typeof nested[key] === "string") return nested[key];
      }
    }
    return "";
  };
  return Object.entries(props).map(([key, p]) => ({
    key,
    type: (p && p.type) || "string",
    label: (p && (p.title || p.name || p.description)) || labelFromI18n(key) || key,
  }));
}

/** Guess which schema fields hold SequenceID / order / phase / date. */
export function guessFieldMap(fields) {
  const find = (...res) => {
    for (const re of res) {
      const f = fields.find((x) => re.test(x.label) || re.test(x.key));
      if (f) return f.key;
    }
    return "";
  };
  return {
    seqId: find(/^seq(uence)?[ _]?id$/i, /sequence/i, /^seq/i),
    order: find(/^(step|order|seq(uence)?[ _]?(no|num|number))$/i, /order|step/i),
    phase: find(/^phase$/i, /phase|stage/i),
    date: find(/date|start/i),
  };
}

/** Build the props object for one item, coercing to the schema field type. */
export function buildProps(item, fieldMap, fields) {
  const typeOf = (k) => (fields.find((f) => f.key === k) || {}).type;
  const coerce = (k, v) => {
    const t = typeOf(k);
    if (t === "integer") return Number.isFinite(v) ? Math.round(v) : parseInt(v, 10);
    if (t === "number") return Number(v);
    return v === undefined || v === null ? "" : String(v);
  };
  const props = {};
  if (fieldMap.seqId) props[fieldMap.seqId] = coerce(fieldMap.seqId, item.seqId);
  if (fieldMap.order && Number.isFinite(item.order)) props[fieldMap.order] = coerce(fieldMap.order, item.order);
  if (fieldMap.phase && item.phase) props[fieldMap.phase] = coerce(fieldMap.phase, item.phase);
  if (fieldMap.date && item.date) props[fieldMap.date] = coerce(fieldMap.date, item.date);
  return props;
}
