// AES-GCM encrypt/decrypt for the stored Spotify refresh token, using the
// Worker's global WebCrypto (`crypto.subtle`) — no extra dependency.
//
// Scheme (must match scripts/spotify-crypto.mjs byte-for-byte — that script
// is the only other thing that ever encrypts a token, when
// `npm run spotify:connect` first stores it):
//   - Key: 32 raw bytes (AES-256), given to us base64-encoded as the
//     TOKEN_KEY secret.
//   - Ciphertext format: `${base64(iv)}.${base64(ciphertext+authTag)}`,
//     where `iv` is 12 random bytes and `ciphertext+authTag` is exactly
//     what `crypto.subtle.encrypt("AES-GCM", ...)` returns (WebCrypto
//     appends the 128-bit auth tag to the ciphertext itself).
// If this format ever changes, update both files together — existing
// stored tokens would otherwise fail to decrypt.

const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyB64);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(keyB64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(keyB64: string, payload: string): Promise<string> {
  const [ivB64, ciphertextB64] = payload.split(".");
  if (!ivB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted token payload");
  }
  const key = await importKey(keyB64);
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(ciphertextB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
