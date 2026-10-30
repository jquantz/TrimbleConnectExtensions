// h264.js — makes encoder output safe for strict MP4 players (Windows Media Player, QuickTime).
// Browsers differ: Chrome returns length-prefixed NAL units plus an avcC record; Firefox may return
// Annex B (start-code) data and no avcC. Strict players need: 4-byte length-prefixed samples and a
// complete avcC (SPS + PPS) in the file header. This module normalises both cases to that.

const NAL_SPS = 7, NAL_PPS = 8, NAL_AUD = 9;

export function isAnnexB(u8) {
  return u8.length > 3 && u8[0] === 0 && u8[1] === 0 && (u8[2] === 1 || (u8[2] === 0 && u8[3] === 1));
}

/** Split Annex B byte stream into NAL units (without start codes). */
export function splitAnnexB(u8) {
  const nals = [];
  let i = 0, start = -1;
  while (i + 2 < u8.length) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && u8[end - 1] === 0) end--; // trailing zero of a 4-byte start code
        nals.push(u8.subarray(start, end));
      }
      i += 3; start = i;
    } else i++;
  }
  if (start >= 0 && start < u8.length) nals.push(u8.subarray(start));
  return nals.filter((n) => n.length);
}

/**
 * True when the buffer is a clean sequence of length-prefixed NAL units that ends exactly at the
 * buffer end. Needed because a 256–511 byte NAL's 4-byte length (00 00 01 xx) looks like a start code.
 */
export function looksLengthPrefixed(u8, lengthSize = 4) {
  let i = 0, count = 0;
  while (i < u8.length) {
    if (i + lengthSize > u8.length) return false;
    let len = 0;
    for (let k = 0; k < lengthSize; k++) len = len * 256 + u8[i + k];
    i += lengthSize;
    if (len <= 0 || i + len > u8.length || (u8[i] & 0x80)) return false; // forbidden_zero_bit must be 0
    i += len; count++;
  }
  return count > 0;
}

/** Split length-prefixed NAL units. */
export function splitLengthPrefixed(u8, lengthSize = 4) {
  const nals = [];
  let i = 0;
  while (i + lengthSize <= u8.length) {
    let len = 0;
    for (let k = 0; k < lengthSize; k++) len = len * 256 + u8[i + k];
    i += lengthSize;
    if (len <= 0 || i + len > u8.length) break;
    nals.push(u8.subarray(i, i + len));
    i += len;
  }
  return nals;
}

/** Parse an AVCDecoderConfigurationRecord. Returns null if it isn't a usable one. */
export function parseAvcC(desc) {
  if (!desc) return null;
  const u8 = desc instanceof Uint8Array ? desc : ArrayBuffer.isView(desc) ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength) : new Uint8Array(desc);
  if (u8.length < 7 || u8[0] !== 1) return null;
  const lengthSize = (u8[4] & 3) + 1;
  let p = 5;
  const sps = [], pps = [];
  const nSps = u8[p++] & 0x1f;
  for (let k = 0; k < nSps && p + 2 <= u8.length; k++) { const l = (u8[p] << 8) | u8[p + 1]; p += 2; sps.push(u8.slice(p, p + l)); p += l; }
  const nPps = p < u8.length ? u8[p++] : 0;
  for (let k = 0; k < nPps && p + 2 <= u8.length; k++) { const l = (u8[p] << 8) | u8[p + 1]; p += 2; pps.push(u8.slice(p, p + l)); p += l; }
  if (!sps.length || !pps.length) return null;
  return { lengthSize, sps, pps };
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Build an AVCDecoderConfigurationRecord with 4-byte NAL lengths. */
export function buildAvcC(spsList, ppsList) {
  const sps = spsList[0];
  const out = [1, sps[1], sps[2], sps[3], 0xff /* 6 reserved bits + lengthSizeMinusOne=3 */, 0xe0 | spsList.length];
  for (const s of spsList) out.push(s.length >> 8, s.length & 0xff, ...s);
  out.push(ppsList.length);
  for (const p of ppsList) out.push(p.length >> 8, p.length & 0xff, ...p);
  if (HIGH_PROFILES.has(sps[1])) out.push(0xfc | 1, 0xf8, 0xf8, 0); // 4:2:0, 8-bit, no SPS ext
  return new Uint8Array(out);
}

function lengthPrefix(nals) {
  const total = nals.reduce((a, n) => a + 4 + n.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const n of nals) {
    out[p] = (n.length >>> 24) & 0xff; out[p + 1] = (n.length >>> 16) & 0xff; out[p + 2] = (n.length >>> 8) & 0xff; out[p + 3] = n.length & 0xff;
    out.set(n, p + 4); p += 4 + n.length;
  }
  return out;
}

/**
 * Feed every encoded chunk through process(). It returns
 *   { data }               4-byte length-prefixed sample, SPS/PPS/AUD removed
 *   { data, description }  on the first chunk: a complete avcC for the MP4 header
 */
export class AvcNormalizer {
  constructor() { this.sps = null; this.pps = null; this.lengthSize = 4; this.described = false; }

  process(bytes, metaDescription) {
    const given = parseAvcC(metaDescription);
    if (given) {
      this.lengthSize = given.lengthSize;
      if (!this.sps) { this.sps = given.sps; this.pps = given.pps; }
    }
    const nals = looksLengthPrefixed(bytes, this.lengthSize) ? splitLengthPrefixed(bytes, this.lengthSize)
      : isAnnexB(bytes) ? splitAnnexB(bytes)
      : splitLengthPrefixed(bytes, this.lengthSize);
    const keep = [];
    for (const n of nals) {
      const type = n[0] & 0x1f;
      if (type === NAL_SPS) { if (!this.described) this.sps = [n.slice()]; }
      else if (type === NAL_PPS) { if (!this.described) this.pps = [n.slice()]; }
      else if (type !== NAL_AUD) keep.push(n);
    }
    const res = { data: lengthPrefix(keep) };
    if (!this.described) {
      if (!this.sps || !this.pps) throw new Error("The video encoder did not provide H.264 stream headers (SPS/PPS).");
      res.description = buildAvcC(this.sps, this.pps);
      this.described = true;
    }
    return res;
  }
}

/**
 * Decode timestamps for frames that arrive in decode order but carry presentation timestamps
 * (B-frames make PTS jump back and forth). Returns DTS values that only ever increase and are
 * never later than their frame's PTS — what MP4 (ctts) needs. With no B-frames, DTS === PTS.
 *   DTS[i] = sortedPTS[i] - delay,  delay = max(0, max_i(sortedPTS[i] - PTS[i]))
 */
export function decodeTimeline(pts) {
  const sorted = [...pts].sort((a, b) => a - b);
  let delay = 0;
  pts.forEach((p, i) => { if (sorted[i] - p > delay) delay = sorted[i] - p; });
  return { dts: sorted.map((s) => s - delay), delay };
}
