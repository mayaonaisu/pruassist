import { bytesToBase64, base64ToBytes } from "../base64";

// A voiceprint on the wire and in the store: a 192-float unit vector encoded as base64 of its
// little-endian bytes (768 bytes → ~1 KB of base64). Endianness is pinned via DataView (not the
// platform's native order) so a profile stored on one machine decodes correctly on any other.

export const PROFILE_DIMS = 192;

export function encodeProfile(v: Float32Array): string {
  if (v.length !== PROFILE_DIMS) throw new Error(`Expected ${PROFILE_DIMS} dims, got ${v.length}`);
  const buf = new ArrayBuffer(v.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i], true); // little-endian
  return bytesToBase64(new Uint8Array(buf));
}

export function decodeProfile(s: string): Float32Array {
  const bytes = base64ToBytes(s);
  if (bytes.length !== PROFILE_DIMS * 4) throw new Error(`Bad profile length: ${bytes.length} bytes`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const v = new Float32Array(PROFILE_DIMS);
  for (let i = 0; i < PROFILE_DIMS; i++) v[i] = dv.getFloat32(i * 4, true);
  for (let i = 0; i < PROFILE_DIMS; i++) {
    if (!Number.isFinite(v[i])) throw new Error("Profile contains non-finite values");
  }
  return v;
}
