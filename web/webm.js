// Minimal WebM (Matroska) writer for WebCodecs output: one video track
// (VP8/VP9) and an optional Opus audio track. Builds the whole file at the
// end, with Duration and Cues so players can seek. No dependencies.

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  MuxingApp: 0x4d80, WritingApp: 0x5741, Tracks: 0x1654ae6b, TrackEntry: 0xae,
  TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagLacing: 0x9c, CodecID: 0x86,
  CodecPrivate: 0x63a2, CodecDelay: 0x56aa, SeekPreRoll: 0x56bb, Video: 0xe0, PixelWidth: 0xb0,
  PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f, Cues: 0x1c53bb6b,
  CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7,
  CueClusterPosition: 0xf1, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
};

const te = new TextEncoder();

// A node is { parts: Uint8Array[], size }. Large frame payloads are never copied.
function node(parts) {
  let size = 0;
  for (const p of parts) size += p.size ?? p.length;
  return { parts, size };
}
function idBytes(id) {
  const out = [];
  while (id > 0) { out.unshift(id & 0xff); id = Math.floor(id / 256); }
  return Uint8Array.from(out);
}
function vint(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const b = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
      b[0] |= 1 << (8 - len);
      return b;
    }
  }
  throw new Error('element too large');
}
function uint(n, width = 0) {
  const out = [];
  while (n > 0) { out.unshift(n % 256); n = Math.floor(n / 256); }
  while (out.length < Math.max(width, 1)) out.unshift(0);
  return Uint8Array.from(out);
}
function el(id, ...children) {
  const body = node(children);
  return node([idBytes(id), vint(body.size), body]);
}
const U = (id, n, width) => el(id, uint(n, width));
const S = (id, s) => el(id, te.encode(s));
function F(id, x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x);
  return el(id, b);
}
function flatten(n, out) {
  for (const p of n.parts) {
    if (p instanceof Uint8Array) out.push(p);
    else flatten(p, out);
  }
  return out;
}

function opusHead(channels, preSkip, sampleRate) {
  const b = new Uint8Array(19);
  b.set(te.encode('OpusHead'), 0);
  const v = new DataView(b.buffer);
  b[8] = 1; b[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, sampleRate, true);
  v.setInt16(16, 0, true); b[18] = 0;
  return b;
}

export class WebMWriter {
  /**
   * @param {{width:number,height:number,codec:'V_VP9'|'V_VP8',
   *          audio?:{sampleRate:number,channels:number,description?:ArrayBuffer}}} o
   */
  constructor(o) {
    this.o = o;
    this.blocks = []; // {track, ms, key, data}
  }
  addVideo(chunk) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.blocks.push({ track: 1, ms: Math.round(chunk.timestamp / 1000), key: chunk.type === 'key', data });
  }
  addAudio(chunk, meta) {
    if (meta?.decoderConfig?.description && this.o.audio && !this.o.audio.description) {
      this.o.audio.description = meta.decoderConfig.description;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.blocks.push({ track: 2, ms: Math.round(chunk.timestamp / 1000), key: true, data });
  }

  finalize(durationMs) {
    const { width, height, codec, audio } = this.o;
    const hasAudio = !!audio && this.blocks.some((b) => b.track === 2);
    const header = el(ID.EBML,
      U(ID.EBMLVersion, 1), U(ID.EBMLReadVersion, 1), U(ID.EBMLMaxIDLength, 4),
      U(ID.EBMLMaxSizeLength, 8), S(ID.DocType, 'webm'), U(ID.DocTypeVersion, 4),
      U(ID.DocTypeReadVersion, 2));
    const info = el(ID.Info, U(ID.TimecodeScale, 1e6), F(ID.Duration, durationMs),
      S(ID.MuxingApp, 'Reefhue'), S(ID.WritingApp, 'Reefhue'));
    const tracks = [el(ID.TrackEntry,
      U(ID.TrackNumber, 1), U(ID.TrackUID, 1), U(ID.TrackType, 1), U(ID.FlagLacing, 0),
      S(ID.CodecID, codec), el(ID.Video, U(ID.PixelWidth, width), U(ID.PixelHeight, height)))];
    if (hasAudio) {
      const preSkip = 312;
      let priv = audio.description ? new Uint8Array(audio.description) : null;
      if (!priv || priv.length < 19) priv = opusHead(audio.channels, preSkip, audio.sampleRate);
      const realSkip = new DataView(priv.buffer, priv.byteOffset).getUint16(10, true);
      tracks.push(el(ID.TrackEntry,
        U(ID.TrackNumber, 2), U(ID.TrackUID, 2), U(ID.TrackType, 2), U(ID.FlagLacing, 0),
        S(ID.CodecID, 'A_OPUS'), el(ID.CodecPrivate, priv),
        U(ID.CodecDelay, Math.round((realSkip / 48000) * 1e9)), U(ID.SeekPreRoll, 80e6),
        el(ID.Audio, F(ID.SamplingFrequency, audio.sampleRate), U(ID.Channels, audio.channels))));
    }
    const tracksEl = el(ID.Tracks, ...tracks);

    // Interleave by time; video before audio at equal timestamps.
    const blocks = this.blocks
      .filter((b) => b.track === 1 || hasAudio)
      .sort((a, b) => a.ms - b.ms || a.track - b.track);

    // Group into clusters: start a new one at each video key frame (if the
    // current cluster is >= 1 s old) or when relative time would overflow int16.
    const clusters = [];
    let cur = null;
    for (const b of blocks) {
      const tooOld = cur && b.ms - cur.ms > 30000;
      const keyBreak = cur && b.track === 1 && b.key && b.ms - cur.ms >= 1000;
      if (!cur || tooOld || keyBreak) {
        cur = { ms: b.ms, items: [], cue: b.track === 1 && b.key };
        clusters.push(cur);
      }
      cur.items.push(b);
    }
    const clusterNodes = clusters.map((c) => {
      const items = c.items.map((b) => {
        const head = new Uint8Array(4);
        head[0] = 0x80 | b.track;
        new DataView(head.buffer).setInt16(1, b.ms - c.ms);
        head[3] = b.key ? 0x80 : 0;
        return el(ID.SimpleBlock, head, b.data);
      });
      return el(ID.Cluster, U(ID.Timecode, c.ms), ...items);
    });

    // Cues with fixed-width positions so their size doesn't depend on offsets.
    const cueClusters = clusters.map((c, i) => ({ c, i })).filter(({ c }) => c.cue);
    const makeCues = (positions) => el(ID.Cues, ...cueClusters.map(({ c, i }) =>
      el(ID.CuePoint, U(ID.CueTime, c.ms),
        el(ID.CueTrackPositions, U(ID.CueTrack, 1), U(ID.CueClusterPosition, positions[i], 8)))));
    const zeros = clusters.map(() => 0);
    const cuesSize = makeCues(zeros).size;
    const positions = [];
    let off = info.size + tracksEl.size + cuesSize;
    for (const cn of clusterNodes) { positions.push(off); off += cn.size; }
    const cues = makeCues(positions);

    const segment = el(ID.Segment, info, tracksEl, cues, ...clusterNodes);
    return new Blob(flatten(node([header, segment]), []), { type: 'video/webm' });
  }
}

/** Pick a VP9 or VP8 config the browser can encode. */
export async function pickVideoCodec(width, height, fps) {
  if (typeof VideoEncoder === 'undefined') return null;
  const bitrate = Math.round(Math.min(40e6, Math.max(2e6, width * height * fps * 0.14)));
  for (const [codec, id] of [['vp09.00.10.08', 'V_VP9'], ['vp8', 'V_VP8']]) {
    // constant bitrate first, as for MP4 (some encoders undershoot badly otherwise)
    for (const bitrateMode of ['constant', 'variable']) {
      const config = { codec, width, height, bitrate, bitrateMode, framerate: fps, latencyMode: 'quality' };
      try {
        const r = await VideoEncoder.isConfigSupported(config);
        if (r.supported) return { config, matroska: id };
      } catch { /* try next */ }
    }
  }
  return null;
}

/**
 * Decode the soundtrack of a media file and re-encode it to Opus.
 * Resolves to null when there is no decodable audio or no AudioEncoder.
 */
export async function encodeAudioTrack(file, maxSeconds, writer) {
  if (typeof AudioEncoder === 'undefined') return null;
  let buf;
  try {
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    return null; // silent clip or unsupported container
  }
  const channels = Math.min(2, buf.numberOfChannels);
  const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate: 128000 };
  try {
    if (!(await AudioEncoder.isConfigSupported(config)).supported) return null;
  } catch { return null; }
  writer.o.audio = { sampleRate: 48000, channels };
  const enc = new AudioEncoder({ output: (c, m) => writer.addAudio(c, m), error: (e) => console.warn(e) });
  enc.configure(config);
  const total = Math.min(buf.length, Math.floor(maxSeconds * 48000));
  const step = 4800;
  for (let s = 0; s < total; s += step) {
    const n = Math.min(step, total - s);
    const planar = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) planar.set(buf.getChannelData(c).subarray(s, s + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n,
      numberOfChannels: channels, timestamp: Math.round((s / 48000) * 1e6), data: planar });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  return true;
}
