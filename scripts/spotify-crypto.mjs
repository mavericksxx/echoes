#!/usr/bin/env node
// AES-GCM encrypt/decrypt for the stored Spotify refresh token, using
// Node's global WebCrypto (`crypto.subtle`) — same API the Worker uses.
//
// Scheme (must match worker/crypto.ts byte-for-byte — this is the only
// other thing that ever touches an encrypted token):
//   - Key: 32 raw bytes (AES-256), given to us base64-encoded (the value
//     you set with `wrangler secret put TOKEN_KEY`).
//   - Ciphertext format: `${base64(iv)}.${base64(ciphertext+authTag)}`,
//     where `iv` is 12 random bytes and `ciphertext+authTag` is exactly
//     what `crypto.subtle.encrypt("AES-GCM", ...)` returns.
// If this format ever changes, update both files together.
"use strict";

const IV_BYTES = 12;

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function importKey(keyB64, usages) {
  const raw = fromBase64(keyB64);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, usages);
}

export async function encryptToken(keyB64, plaintext) {
  const key = await importKey(keyB64, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(keyB64, payload) {
  const [ivB64, ciphertextB64] = payload.split(".");
  if (!ivB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted token payload");
  }
  const key = await importKey(keyB64, ["decrypt"]);
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(ciphertextB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
