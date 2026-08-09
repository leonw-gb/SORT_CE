// sortz.js - The .sortz session bundle: read and write.
//
// A .sortz is a plain ZIP with a fixed set of members:
//
//   manifest.json   who recorded it, on what, and in which format version
//   session.json    the recording object (events, tabs, SOP steps, ticket)
//   session.webm    the screen capture, byte-for-byte as it was captured
//
// Two deliberate choices:
//
// STORED, not deflated, for the video. VP9 is already compressed; running it
// through deflate costs seconds per hundred megabytes and saves close to
// nothing. The JSON members ARE deflated, because event streams are repetitive
// text and compress by roughly 10x.
//
// The video is EMBEDDED rather than linked. Uploaded videos are deleted from
// the upload server after a retention period, so a bundle that only carried a
// link would quietly decay into a timeline with a dead player. A bundle is the
// durable copy.
//
// Loaded by the offscreen document (writing) and the import window (reading).
// No DOM, no extension APIs, so the upload server can reuse this file verbatim
// when it grows a viewer.

const SORTZ = (() => {
  const FORMAT_VERSION = 1;
  const NAME_MANIFEST = "manifest.json";
  const NAME_SESSION = "session.json";
  const NAME_VIDEO = "session.webm";

  // ---- CRC32 -----------------------------------------------------------------
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }
  // Streamed in chunks: a 300 MB video must never be a single JS array.
  function crc32(u8, seed) {
    const t = crcTable();
    let c = seed === undefined ? 0xffffffff : seed;
    for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return c >>> 0;
  }
  const crcFinish = (c) => (c ^ 0xffffffff) >>> 0;

  // ---- byte helpers ------------------------------------------------------------
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function u16(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
  function u32(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  }
  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function rd16(v, o) { return v[o] | (v[o + 1] << 8); }
  function rd32(v, o) { return (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0; }

  // DOS date/time. Zip predates the epoch we actually care about; the real
  // timestamp lives in the manifest, this is only so tools show something sane.
  function dosTime(d) {
    return u16(((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff);
  }
  function dosDate(d) {
    return u16((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff);
  }

  async function deflateRaw(u8) {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([u8]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function inflateRaw(u8) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // CRC of a Blob without ever holding it whole in memory.
  async function crcOfBlob(blob, onProgress) {
    const reader = blob.stream().getReader();
    let c = 0xffffffff, done = false, seen = 0;
    while (!done) {
      const r = await reader.read();
      done = r.done;
      if (r.value) {
        c = crc32(r.value, c);
        seen += r.value.length;
        if (onProgress) onProgress(seen, blob.size);
      }
    }
    return crcFinish(c);
  }

  // ---- writing -----------------------------------------------------------------
  // Entries are assembled as Blob parts so the video is never copied into a
  // JS buffer. Blob keeps it on disk-backed storage; only headers are in memory.
  async function build({ manifest, session, videoBlob, onProgress }) {
    const now = new Date();
    const parts = [];      // Blob parts, in file order
    const central = [];    // central directory records
    let offset = 0;

    async function addEntry(name, payload, compress) {
      const nameBytes = enc.encode(name);
      const isBlob = payload instanceof Blob;

      let uncompressedSize, compressedSize, crc, body, method;
      if (isBlob) {
        // STORED. Never buffered.
        method = 0;
        uncompressedSize = payload.size;
        compressedSize = payload.size;
        crc = await crcOfBlob(payload, onProgress);
        body = payload;
      } else {
        uncompressedSize = payload.length;
        crc = crcFinish(crc32(payload, undefined));
        if (compress) {
          const def = await deflateRaw(payload);
          // Only keep the deflated form if it actually helped.
          if (def.length < payload.length) { method = 8; body = def; }
          else { method = 0; body = payload; }
        } else { method = 0; body = payload; }
        compressedSize = body.length;
      }

      const local = concat([
        u32(0x04034b50), u16(20), u16(0), u16(method),
        dosTime(now), dosDate(now),
        u32(crc), u32(compressedSize), u32(uncompressedSize),
        u16(nameBytes.length), u16(0), nameBytes
      ]);
      parts.push(local, body);

      central.push(concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(method),
        dosTime(now), dosDate(now),
        u32(crc), u32(compressedSize), u32(uncompressedSize),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset), nameBytes
      ]));
      offset += local.length + compressedSize;
    }

    await addEntry(NAME_MANIFEST, enc.encode(JSON.stringify(manifest, null, 2)), true);
    await addEntry(NAME_SESSION, enc.encode(JSON.stringify(session)), true);
    if (videoBlob && videoBlob.size) await addEntry(NAME_VIDEO, videoBlob, false);

    const cd = concat(central);
    const end = concat([
      u32(0x06054b50), u16(0), u16(0),
      u16(central.length), u16(central.length),
      u32(cd.length), u32(offset), u16(0)
    ]);
    return new Blob([...parts, cd, end], { type: "application/zip" });
  }

  // ---- reading -----------------------------------------------------------------
  // Local headers are walked in order rather than via the central directory:
  // we wrote the file, every header carries real sizes, and there are no data
  // descriptors. Slicing keeps the video as a Blob the whole way through.
  async function parse(file) {
    const HEAD = 30;
    const entries = {};
    let pos = 0;

    while (pos + HEAD <= file.size) {
      const head = new Uint8Array(await file.slice(pos, pos + HEAD).arrayBuffer());
      if (rd32(head, 0) !== 0x04034b50) break;      // reached the central directory

      const method = rd16(head, 8);
      const compressedSize = rd32(head, 18);
      const nameLen = rd16(head, 26);
      const extraLen = rd16(head, 28);

      const nameBytes = new Uint8Array(await file.slice(pos + HEAD, pos + HEAD + nameLen).arrayBuffer());
      const name = dec.decode(nameBytes);

      const dataStart = pos + HEAD + nameLen + extraLen;
      entries[name] = { method, blob: file.slice(dataStart, dataStart + compressedSize) };
      pos = dataStart + compressedSize;
    }

    async function text(name) {
      const e = entries[name];
      if (!e) return null;
      if (e.method === 0) return await e.blob.text();
      if (e.method === 8) return dec.decode(await inflateRaw(new Uint8Array(await e.blob.arrayBuffer())));
      throw new Error(`Unsupported compression in ${name}`);
    }

    const manifestText = await text(NAME_MANIFEST);
    if (!manifestText) throw new Error("Not a SORT session bundle: manifest.json is missing.");

    let manifest;
    try { manifest = JSON.parse(manifestText); }
    catch (e) { throw new Error("The bundle's manifest is damaged and cannot be read."); }

    // Version check before anything else is touched. An unknown future bundle
    // must fail with a sentence the operator can act on, not a stack trace
    // halfway through rendering a half-understood timeline.
    if (typeof manifest.formatVersion !== "number") {
      throw new Error("The bundle does not say which format it uses.");
    }
    if (manifest.formatVersion > FORMAT_VERSION) {
      throw new Error(
        `This bundle uses session format ${manifest.formatVersion}; this copy of SORT reads up to ${FORMAT_VERSION}. Update SORT to open it.`
      );
    }

    const sessionText = await text(NAME_SESSION);
    if (!sessionText) throw new Error("The bundle contains no session data.");
    let session;
    try { session = JSON.parse(sessionText); }
    catch (e) { throw new Error("The bundle's session data is damaged and cannot be read."); }

    const videoEntry = entries[NAME_VIDEO];
    const videoBlob = videoEntry
      ? new Blob([videoEntry.blob], { type: manifest.videoMimeType || "video/webm" })
      : null;

    return { manifest, session, videoBlob };
  }

  // A bundle filename an operator can read at a glance in a Downloads folder,
  // and that sorts chronologically.
  function filenameFor(session, recorder) {
    const d = new Date(session.startTime || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    const who = String(recorder || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const ticket = session.ticket && session.ticket.ref ? `_${session.ticket.ref}` : "";
    return `sort_${stamp}${ticket}_${who || "unknown"}.sortz`;
  }

  return { FORMAT_VERSION, build, parse, filenameFor, NAME_VIDEO };
})();

if (typeof globalThis !== "undefined") globalThis.SORTZ = SORTZ;
