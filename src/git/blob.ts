// Git blob SHA-1, computed locally — ADR-0006 §4.
//
// The whole sync design rests on one fact: git is content-addressed, and `stableStringify` gives a
// byte-identical serialization for a given tree (ADR-0002 §7). So the plugin can compute the SHA
// GitHub *would* assign to a file it is about to write, without uploading anything — which is what
// makes "are we in sync?" one API call and no measurable transfer.
//
// SHA-1 is implemented here rather than taken from `crypto.subtle`, for two reasons: the digest API
// is async and promise-shaped in a place that wants a plain comparison, and the plugin iframe is a
// `null`-origin document where `crypto.subtle` is not reliably present across Figma versions.
// Sixty lines of a fully specified 1995 hash is a cheaper dependency than a capability check.
//
// This is a *content address*, never a security primitive. SHA-1's collision weakness is git's
// problem and git's answer, not ours.

/** UTF-8 bytes, because git's byte length is the encoded length, not the JS string length. */
export function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return bytes;
}

function rotl(value: number, by: number): number {
  return ((value << by) | (value >>> (32 - by))) >>> 0;
}

/** SHA-1 over a byte array, as 40 lowercase hex characters. */
export function sha1(bytes: number[]): string {
  const length = bytes.length;
  const padded = bytes.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);

  // Length in *bits*, as a 64-bit big-endian value. The high word is computed by division rather
  // than by shifting: `length * 8` exceeds 32 bits well before it exceeds a JS safe integer, and
  // `<<`/`>>>` would silently truncate a file larger than 512MB to something else entirely.
  const bits = length * 8;
  const high = Math.floor(bits / 0x100000000);
  const low = bits >>> 0;
  padded.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  padded.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array<number>(80);

  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i += 1) {
      const o = at + i * 4;
      w[i] = ((padded[o] << 24) | (padded[o + 1] << 16) | (padded[o + 2] << 8) | padded[o + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * The SHA git would give this file's content: `sha1("blob " + byteLength + "\0" + content)`.
 *
 * The header is part of the hash — that is what makes a blob SHA a blob SHA rather than a plain
 * content digest, and getting it wrong would produce forty hex characters that never match anything
 * GitHub returns while looking perfectly plausible in a debugger.
 */
export function blobSha(content: string): string {
  const body = utf8Bytes(content);
  const header = utf8Bytes(`blob ${body.length}\u0000`);
  return sha1(header.concat(body));
}
