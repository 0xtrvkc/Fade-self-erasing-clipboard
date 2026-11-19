'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../crypto.js');

const PASS = 'correct horse battery staple';
let vault;
test.before(async () => { vault = await C.createVault(PASS); });

test('the stored key record holds no usable private key material', () => {
  const r = vault.record;
  assert.equal(r.v, 1);
  assert.deepEqual(Object.keys(r).sort(), ['pass', 'pub', 'rec', 'v']);
  assert.equal(r.pass.iter, C.PBKDF2_ITERATIONS);
  assert.equal(C.unb64(r.pass.salt).length, 16);
  assert.match(vault.recoveryCode, /^([A-Z0-9]{4}-){12}[A-Z0-9]{4}$/);
});

test('recovery codes round-trip and tolerate spacing, case and look-alike letters', () => {
  const bytes = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 255);
  const code = C.formatRecoveryCode(bytes);
  assert.deepEqual(C.parseRecoveryCode(code), bytes);
  assert.deepEqual(C.parseRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), bytes);
  assert.deepEqual(C.parseRecoveryCode(code.replace(/0/g, 'O').replace(/1/g, 'l')), bytes);
  assert.throws(() => C.parseRecoveryCode(code.slice(4)));
});

test('items kept while locked open only with the unlocked private key', async () => {
  const { epk, key } = await C.newItemKey(vault.publicKey, 'clip-1');
  const meta = { type: 'text', content: 'bank PIN 4321', title: 'Bank' };
  const sealed = await C.sealMeta(key, 'clip-1', meta);
  assert.equal(JSON.stringify(sealed).includes('4321'), false);

  const unlocked = await C.unlockWithPassphrase(vault.record, PASS);
  const reopened = await C.openItemKey(unlocked.privateKey, epk, 'clip-1');
  assert.deepEqual(await C.openMeta(reopened, 'clip-1', sealed.iv, sealed.ct), meta);
});

test('a wrong passphrase is rejected', async () => {
  await assert.rejects(C.unlockWithPassphrase(vault.record, 'wrong passphrase!!'), /not correct/);
});

test('ciphertext is bound to its item and part', async () => {
  const { epk, key } = await C.newItemKey(vault.publicKey, 'clip-2');
  const sealed = await C.sealMeta(key, 'clip-2', { type: 'text', content: 'x' });
  await assert.rejects(C.openMeta(key, 'clip-3', sealed.iv, sealed.ct), /could not be decrypted/);
  // The same epk used under another id derives a different key.
  const { privateKey } = await C.unlockWithPassphrase(vault.record, PASS);
  const other = await C.openItemKey(privateKey, epk, 'clip-3');
  await assert.rejects(C.openMeta(other, 'clip-3', sealed.iv, sealed.ct));

  const bytes = new Uint8Array(512000).map((_, i) => i & 255);
  const part = await C.encryptPart(key, 'clip-2', '0', bytes);
  assert.ok(part.length <= 700000, 'an encrypted 512 KB chunk fits the database rule');
  assert.deepEqual(await C.decryptPart(key, 'clip-2', '0', part), bytes);
  await assert.rejects(C.decryptPart(key, 'clip-2', '1', part));
  const tampered = C.b64(C.unb64(part).map((b, i) => i === 40 ? b ^ 1 : b));
  await assert.rejects(C.decryptPart(key, 'clip-2', '0', tampered));
});

test('the recovery key resets the passphrase without changing item keys', async () => {
  const { epk, key } = await C.newItemKey(vault.publicKey, 'clip-4');
  const sealed = await C.sealMeta(key, 'clip-4', { type: 'link', content: 'https://example.com' });
  await assert.rejects(C.recoverWithCode(vault.record, C.formatRecoveryCode(new Uint8Array(32)), 'new passphrase here'), /does not match/);
  const recovered = await C.recoverWithCode(vault.record, vault.recoveryCode, 'a brand new passphrase');
  const record = { ...vault.record, pass: recovered.pass };
  await assert.rejects(C.unlockWithPassphrase(record, PASS));
  const { privateKey } = await C.unlockWithPassphrase(record, 'a brand new passphrase');
  const reopened = await C.openItemKey(privateKey, epk, 'clip-4');
  assert.equal((await C.openMeta(reopened, 'clip-4', sealed.iv, sealed.ct)).content, 'https://example.com');
});

test('passphrase change needs the current passphrase and enforces a minimum length', async () => {
  await assert.rejects(C.changePassphrase(vault.record, 'nope nope nope', 'another passphrase'), /not correct/);
  await assert.rejects(C.changePassphrase(vault.record, PASS, 'short'), /at least/);
  const pass = await C.changePassphrase(vault.record, PASS, 'another passphrase');
  await C.unlockWithPassphrase({ ...vault.record, pass }, 'another passphrase');
  await assert.rejects(C.createVault('short'), /at least/);
});
