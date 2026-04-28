export function isLikelyBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}
