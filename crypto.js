/* Vault encryption. Runs entirely in the browser with Web Crypto; keys never leave the device.
 *
 * Design
 * - The vault has one ECDH P-256 key pair. The public key is stored in plain form so a clip can be
 *   kept from the clipboard while the vault stays locked. The private key is stored only encrypted:
 *   once under a passphrase key (PBKDF2-SHA256) and once under a random recovery key.
 * - Each vault item gets its own AES-256-GCM key, derived from a fresh ephemeral ECDH key and the
 *   vault public key (ECIES). Only the private key can derive it again.
 * - Every ciphertext is bound to its item id and part name as additional data, so encrypted parts
 *   cannot be swapped between items or positions without failing to decrypt.
 */
(function (root, factory) {
  const api = factory(root.crypto);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FadeVaultCrypto = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (webCrypto) {
  'use strict';
  const subtle = webCrypto.subtle;
  const VERSION = 1;
  const PBKDF2_ITERATIONS = 600000;
  const MIN_PASSPHRASE = 10;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; // 32 symbols, no I, L, O or U.

  function b64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function unb64(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Corrupted vault data.');
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const random = length => webCrypto.getRandomValues(new Uint8Array(length));
  const aad = (...parts) => enc.encode(['fade', 'v' + VERSION, ...parts].join(':'));

  async function aesEncrypt(key, plaintext, additionalData) {
    const iv = random(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext));
    return { iv, ct };
  }
  async function aesDecrypt(key, iv, ct, additionalData) {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, ct));
  }

  async function passphraseKey(passphrase, salt, iterations) {
    const material = await subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function recoveryKey(bytes) {
    const material = await subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: aad('recovery') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function formatRecoveryCode(bytes) {
    // 256 bits as 52 base32 symbols, shown in groups of four.
    let bits = 0, value = 0, out = '';
    for (const byte of bytes) {
      value = ((value << 8) | byte) & 0xffff; bits += 8;
      while (bits >= 5) { out += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits) out += RECOVERY_ALPHABET[(value << (5 - bits)) & 31];
    return out.match(/.{1,4}/g).join('-');
  }
  function parseRecoveryCode(text) {
    const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
    if (clean.length !== 52) throw new Error('A recovery key has 52 characters.');
    let bits = 0, value = 0;
    const out = [];
    for (const char of clean) {
      const index = RECOVERY_ALPHABET.indexOf(char);
      if (index < 0) throw new Error('That recovery key contains an unexpected character.');
      value = ((value << 5) | index) & 0xffff; bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out.slice(0, 32));
  }

  function checkPassphrase(passphrase) {
    if (typeof passphrase !== 'string' || [...passphrase].length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters. A few unrelated words work well.`);
  }
  async function wrapWithPassphrase(pkcs8, passphrase, iterations = PBKDF2_ITERATIONS) {
    checkPassphrase(passphrase);
    const salt = random(16);
    const key = await passphraseKey(passphrase, salt, iterations);
    const { iv, ct } = await aesEncrypt(key, pkcs8, aad('private-key', 'passphrase'));
    return { salt: b64(salt), iter: iterations, iv: b64(iv), ct: b64(ct) };
  }
  async function importPrivate(pkcs8) {
    return subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
  }
  async function importPublicKey(pub) {
    return subtle.importKey('raw', unb64(pub), ECDH, false, []);
  }
  function checkRecord(record) {
    if (!record || record.v !== VERSION || typeof record.pub !== 'string' || !record.pass || !record.rec) throw new Error('Vault key record is missing or from a newer version of Fade.');
  }

  /** Creates the vault key pair. Returns the record to store and the recovery code to show once. */
  async function createVault(passphrase) {
    checkPassphrase(passphrase);
    const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
    const pub = b64(await subtle.exportKey('raw', pair.publicKey));
    const recoveryBytes = random(32);
    const rec = await aesEncrypt(await recoveryKey(recoveryBytes), pkcs8, aad('private-key', 'recovery'));
    const record = { v: VERSION, pub, pass: await wrapWithPassphrase(pkcs8, passphrase), rec: { iv: b64(rec.iv), ct: b64(rec.ct) } };
    const privateKey = await importPrivate(pkcs8);
    pkcs8.fill(0);
    return { record, recoveryCode: formatRecoveryCode(recoveryBytes), privateKey, publicKey: await importPublicKey(pub) };
  }
  async function unlockWithPassphrase(record, passphrase) {
    checkRecord(record);
    const key = await passphraseKey(String(passphrase || ''), unb64(record.pass.salt), record.pass.iter);
    let pkcs8;
    try { pkcs8 = await aesDecrypt(key, unb64(record.pass.iv), unb64(record.pass.ct), aad('private-key', 'passphrase')); }
    catch { throw new Error('That passphrase is not correct.'); }
    const privateKey = await importPrivate(pkcs8);
    pkcs8.fill(0);
    return { privateKey, publicKey: await importPublicKey(record.pub) };
  }
  /** Opens the vault with the recovery code and sets a new passphrase. Returns the new `pass` entry. */
  async function recoverWithCode(record, code, newPassphrase) {
    checkRecord(record);
    checkPassphrase(newPassphrase);
    const key = await recoveryKey(parseRecoveryCode(code));
    let pkcs8;
    try { pkcs8 = await aesDecrypt(key, unb64(record.rec.iv), unb64(record.rec.ct), aad('private-key', 'recovery')); }
    catch { throw new Error('That recovery key does not match this vault.'); }
    const pass = await wrapWithPassphrase(pkcs8, newPassphrase);
    const privateKey = await importPrivate(pkcs8);
    pkcs8.fill(0);
    return { pass, privateKey, publicKey: await importPublicKey(record.pub) };
  }
  /** Re-wraps the private key under a new passphrase after proving the current one. */
  async function changePassphrase(record, current, next) {
    checkRecord(record);
    const key = await passphraseKey(String(current || ''), unb64(record.pass.salt), record.pass.iter);
    let pkcs8;
    try { pkcs8 = await aesDecrypt(key, unb64(record.pass.iv), unb64(record.pass.ct), aad('private-key', 'passphrase')); }
    catch { throw new Error('The current passphrase is not correct.'); }
    const pass = await wrapWithPassphrase(pkcs8, next);
    pkcs8.fill(0);
    return pass;
  }

  async function deriveItemKey(privateKey, peerPublic, epkBytes, itemId) {
    const shared = await subtle.deriveBits({ name: 'ECDH', public: peerPublic }, privateKey, 256);
    const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epkBytes, info: aad('item', itemId) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  /** New item key, usable with only the vault public key. `epk` is stored with the item. */
  async function newItemKey(publicKey, itemId) {
    const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const epkBytes = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    return { epk: b64(epkBytes), key: await deriveItemKey(eph.privateKey, publicKey, epkBytes, itemId) };
  }
  /** Re-derives an existing item's key; requires the unlocked vault private key. */
  async function openItemKey(privateKey, epk, itemId) {
    const epkBytes = unb64(epk);
    const peer = await subtle.importKey('raw', epkBytes, ECDH, false, []);
    return deriveItemKey(privateKey, peer, epkBytes, itemId);
  }

  async function sealMeta(key, itemId, meta) {
    const { iv, ct } = await aesEncrypt(key, enc.encode(JSON.stringify(meta)), aad('meta', itemId));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function openMeta(key, itemId, iv, ct) {
    try { return JSON.parse(dec.decode(await aesDecrypt(key, unb64(iv), unb64(ct), aad('meta', itemId)))); }
    catch { throw new Error('This vault item could not be decrypted.'); }
  }
  async function encryptPart(key, itemId, part, bytes) {
    const { iv, ct } = await aesEncrypt(key, bytes, aad('part', itemId, part));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv); out.set(ct, iv.length);
    return b64(out);
  }
  async function decryptPart(key, itemId, part, text) {
    const bytes = unb64(text);
    if (bytes.length < 28) throw new Error('A vault file part is damaged.');
    try { return await aesDecrypt(key, bytes.subarray(0, 12), bytes.subarray(12), aad('part', itemId, part)); }
    catch { throw new Error('A vault file part could not be decrypted.'); }
  }

  return { VERSION, PBKDF2_ITERATIONS, MIN_PASSPHRASE, b64, unb64, formatRecoveryCode, parseRecoveryCode, checkPassphrase,
    createVault, unlockWithPassphrase, recoverWithCode, changePassphrase, importPublicKey, newItemKey, openItemKey,
    sealMeta, openMeta, encryptPart, decryptPart };
});
