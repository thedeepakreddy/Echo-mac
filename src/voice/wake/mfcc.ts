/**
 * Mel-frequency cepstral coefficients, streamed.
 *
 * The built-in template spotter compares what the microphone hears against
 * stored examples of the name. Raw samples are useless for that — the same
 * word from two mouths shares almost nothing sample-for-sample — so both sides
 * are reduced to MFCCs: a 12-number sketch of the spectral shape every 10 ms,
 * which is what speech recognisers compared before neural networks and which
 * still lines up well across speakers for a single short word.
 *
 * 16 kHz mono in. 25 ms Hamming windows every 10 ms, 512-point FFT, 26 mel
 * bands from 80 Hz to 7.6 kHz, log energy, DCT-II keeping c1..c12 (c0 is
 * loudness, which we deliberately do not match on). Each frame carries its
 * log energy as a 13th value, used only to decide which frames are speech
 * when normalising — never in the distance.
 */

export const SAMPLE_RATE = 16000;
export const WINDOW = 400; // 25 ms
export const HOP = 160; // 10 ms
export const FFT_N = 512;
export const N_MEL = 26;
export const N_CEPS = 12;
/** Values per frame: the cepstra plus the log energy. */
export const FRAME_DIMS = N_CEPS + 1;
/** Frames quieter than this far below the loudest frame are silence for normalisation (≈20 dB). */
const ACTIVE_BELOW_PEAK = 4.6;
const PRE_EMPHASIS = 0.97;
const F_MIN = 80;
const F_MAX = 7600;

const hamming = new Float32Array(WINDOW);
for (let i = 0; i < WINDOW; i++) hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));

const hzToMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number) => 700 * (10 ** (m / 2595) - 1);

/** Triangular mel filterbank over the FFT bins, built once. */
const filters: Array<{ start: number; weights: Float32Array }> = (() => {
  const bins = FFT_N / 2 + 1;
  const lo = hzToMel(F_MIN);
  const hi = hzToMel(F_MAX);
  const points = Array.from({ length: N_MEL + 2 }, (_, i) =>
    Math.floor(((FFT_N + 1) * melToHz(lo + ((hi - lo) * i) / (N_MEL + 1))) / SAMPLE_RATE)
  );
  const out: Array<{ start: number; weights: Float32Array }> = [];
  for (let m = 1; m <= N_MEL; m++) {
    const a = points[m - 1];
    const b = points[m];
    const c = Math.min(points[m + 1], bins - 1);
    const weights = new Float32Array(Math.max(1, c - a + 1));
    for (let k = a; k <= c; k++) {
      let w = 0;
      if (k < b) w = b === a ? 1 : (k - a) / (b - a);
      else w = c === b ? 1 : (c - k) / (c - b);
      weights[k - a] = Math.max(0, w);
    }
    out.push({ start: a, weights });
  }
  return out;
})();

/** DCT-II basis for the cepstrum, built once. */
const dct: Float32Array[] = (() => {
  const rows: Float32Array[] = [];
  for (let c = 1; c <= N_CEPS; c++) {
    const row = new Float32Array(N_MEL);
    for (let m = 0; m < N_MEL; m++) row[m] = Math.cos((Math.PI * c * (m + 0.5)) / N_MEL);
    rows.push(row);
  }
  return rows;
})();

// In-place iterative radix-2 FFT on interleaved-free real/imag arrays.
const cosTable = new Float32Array(FFT_N / 2);
const sinTable = new Float32Array(FFT_N / 2);
for (let i = 0; i < FFT_N / 2; i++) {
  cosTable[i] = Math.cos((2 * Math.PI * i) / FFT_N);
  sinTable[i] = Math.sin((2 * Math.PI * i) / FFT_N);
}
const bitrev = new Uint16Array(FFT_N);
{
  const bits = Math.log2(FFT_N);
  for (let i = 0; i < FFT_N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    bitrev[i] = r;
  }
}

function fft(re: Float32Array, im: Float32Array) {
  for (let i = 0; i < FFT_N; i++) {
    const j = bitrev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= FFT_N; size *= 2) {
    const half = size / 2;
    const step = FFT_N / size;
    for (let start = 0; start < FFT_N; start += size) {
      for (let k = 0; k < half; k++) {
        const idx = k * step;
        const wr = cosTable[idx];
        const wi = -sinTable[idx];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

const re = new Float32Array(FFT_N);
const im = new Float32Array(FFT_N);
const power = new Float32Array(FFT_N / 2 + 1);
const melE = new Float32Array(N_MEL);

/** MFCC vector (c1..c12, logE) for one 400-sample window starting at `offset`. */
export function mfccFrame(samples: Float32Array, offset: number, out = new Float32Array(FRAME_DIMS)): Float32Array {
  re.fill(0);
  im.fill(0);
  let prev = offset > 0 ? samples[offset - 1] : 0;
  for (let i = 0; i < WINDOW; i++) {
    const x = samples[offset + i] ?? 0;
    re[i] = (x - PRE_EMPHASIS * prev) * hamming[i];
    prev = x;
  }
  fft(re, im);
  let total = 0;
  for (let k = 0; k <= FFT_N / 2; k++) {
    power[k] = re[k] * re[k] + im[k] * im[k];
    total += power[k];
  }
  out[N_CEPS] = Math.log(total + 1e-6);
  for (let m = 0; m < N_MEL; m++) {
    const f = filters[m];
    let e = 0;
    for (let i = 0; i < f.weights.length; i++) e += power[f.start + i] * f.weights[i];
    melE[m] = Math.log(e + 1e-6);
  }
  for (let c = 0; c < N_CEPS; c++) {
    let v = 0;
    const row = dct[c];
    for (let m = 0; m < N_MEL; m++) v += melE[m] * row[m];
    out[c] = v;
  }
  return out;
}

/** All MFCC frames of a clip (Float32 samples in -1..1 or int16 range — scale is irrelevant to c1..c12 up to the log). */
export function mfccFrames(samples: Float32Array): Float32Array[] {
  const frames: Float32Array[] = [];
  for (let off = 0; off + WINDOW <= samples.length; off += HOP) frames.push(mfccFrame(samples, off));
  return frames;
}

/**
 * Cepstral mean normalisation — removes the microphone's colour — computed
 * over the SPEECH frames only. A mean taken over a window that is mostly
 * silence describes the silence, and subtracting it from the word leaves a
 * word that matches nothing; this was exactly why the streaming spotter
 * scored every clip the same while the offline calibration looked fine.
 */
export function cmn(frames: Float32Array[]): Float32Array[] {
  if (!frames.length) return frames;
  let peak = -Infinity;
  for (const f of frames) if (f[N_CEPS] > peak) peak = f[N_CEPS];
  const active = frames.filter((f) => f[N_CEPS] >= peak - ACTIVE_BELOW_PEAK);
  const basis = active.length >= 5 ? active : frames;
  const mean = new Float32Array(N_CEPS);
  for (const f of basis) for (let c = 0; c < N_CEPS; c++) mean[c] += f[c];
  for (let c = 0; c < N_CEPS; c++) mean[c] /= basis.length;
  return frames.map((f) => {
    const o = new Float32Array(FRAME_DIMS);
    for (let c = 0; c < N_CEPS; c++) o[c] = f[c] - mean[c];
    o[N_CEPS] = f[N_CEPS];
    return o;
  });
}

export function int16ToFloat(frame: Int16Array): Float32Array {
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = frame[i] / 32768;
  return out;
}

/**
 * Streaming MFCC: feed 512-sample frames, get 10 ms cepstral frames out as
 * they become computable. Keeps the tail of the previous audio so windows
 * straddle frame boundaries correctly.
 */
export class MfccStream {
  private buf = new Float32Array(0);

  push(frame: Int16Array): Float32Array[] {
    const joined = new Float32Array(this.buf.length + frame.length);
    joined.set(this.buf, 0);
    for (let i = 0; i < frame.length; i++) joined[this.buf.length + i] = frame[i] / 32768;
    const out: Float32Array[] = [];
    let off = 0;
    for (; off + WINDOW <= joined.length; off += HOP) out.push(mfccFrame(joined, off));
    this.buf = joined.subarray(off);
    return out;
  }

  reset(): void {
    this.buf = new Float32Array(0);
  }
}

/**
 * Open-begin, fixed-end dynamic time warping: how well does `template` match
 * the END of `stream`, starting anywhere? This is the keyword-spotting form:
 * the word we are looking for has just finished, and we do not know when it
 * began. Returns the per-frame cost (lower is better), normalised by the
 * warping path length so long and short templates are comparable.
 */
export function dtwEndAligned(template: Float32Array[], stream: Float32Array[]): number {
  const n = template.length;
  const m = stream.length;
  if (!n || !m) return Infinity;
  // Sakoe-Chiba band: the word can stretch by ~40 %, no more.
  const band = Math.max(4, Math.round(n * 0.4));
  let prev = new Float32Array(m + 1).fill(0); // open begin: row 0 costs nothing anywhere
  let prevLen = new Float32Array(m + 1).fill(0);
  let cur = new Float32Array(m + 1);
  let curLen = new Float32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    curLen.fill(0);
    const t = template[i - 1];
    // Expected position of template frame i near the end of the stream.
    const center = m - (n - i);
    const jLo = Math.max(1, center - band);
    const jHi = Math.min(m, center + band);
    for (let j = jLo; j <= jHi; j++) {
      const s = stream[j - 1];
      let d = 0;
      for (let c = 0; c < N_CEPS; c++) {
        const x = t[c] - s[c];
        d += x * x;
      }
      d = Math.sqrt(d);
      // Best predecessor: diagonal, up, left.
      let best = prev[j - 1];
      let len = prevLen[j - 1];
      if (prev[j] < best) { best = prev[j]; len = prevLen[j]; }
      if (cur[j - 1] < best) { best = cur[j - 1]; len = curLen[j - 1]; }
      if (best === Infinity) continue;
      cur[j] = best + d;
      curLen[j] = len + 1;
    }
    [prev, cur] = [cur, prev];
    [prevLen, curLen] = [curLen, prevLen];
  }
  const total = prev[m];
  const len = prevLen[m];
  return total === Infinity || !len ? Infinity : total / len;
}
