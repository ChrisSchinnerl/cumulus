// TC39 Uint8Array hex methods (Stage 3, supported in modern browsers).
// Drop this file once `lib.es*.d.ts` ships them.

interface Uint8Array {
  toHex(): string
}

interface Uint8ArrayConstructor {
  fromHex(hex: string): Uint8Array
}
