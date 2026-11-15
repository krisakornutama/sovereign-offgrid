// sovereignty/server.js
// Sovereign LAN Messenger — device-to-device chat over local network.
// No internet required. No central server. Peers find each other
// through UDP multicast and exchange messages over direct HTTP.
//
// Design goals (per "อธิปไตย" — sovereignty, no central dependency):
//   1. Discovery: peers announce themselves on the LAN via multicast —
//      a router/hotspot is enough, internet is not.
//   2. Transport: messages go peer-to-peer; nothing is relayed through
//      a cloud service.
//   3. Local-first: message history is kept on each device, not in a
//      shared database.
//   4. Optional passphrase encryption for message payloads
//      (AES-256-GCM, key derived via scrypt) — privacy across the wire.
//   5. Receipts ledger for the POS (online or reconciled from offline
//      sales) — every entry must carry an Ed25519 signature over its own
//      payload; the node verifies it before writing to the ledger.

'use strict';

import http from 'http';
import dgram from 'dgram';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import url from 'url';
// ชั้นโพสต์-ควอนตัมของใบเสร็จ (Q-09) — vendor แฟ้มเดียวกับที่เสิร์ฟให้หน้าร้าน (public/pq-vendor)
// import แบบ relative ทั้งกราฟ จึงใช้ได้ทั้ง node (ไม่ต้องมี node_modules) และเบราว์เซอร์ (ไม่ต้องมี import map)
import { ml_dsa44 } from './public/pq-vendor/@noble/post-quantum/ml-dsa.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ── Config ------------------------------------------------------------------
const PORT = Number(process.env.MESH_HTTP_PORT || 4200);
const MULTI_ADDR = process.env.MESH_MULTI_ADDR || '239.255.42.1';
const MULTI_PORT = Number(process.env.MESH_MULTI_PORT || 41235);
const PEER_TTL = 30_000; // a peer is "alive" for 30s after its last announce

const PEER_ID = crypto.randomBytes(8).toString('hex');
const PEER_NAME = process.env.MESH_PEER_NAME || os.hostname() || `sovereign-${PEER_ID.slice(0, 4)}`;

// Optional passphrase — if set, payloads are AES-256-GCM encrypted with
// a scrypt-derived key before going on the wire.
const PASSPHRASE = process.env.MESH_PASSPHRASE || '';

// ── Crypto helpers (optional layer) ------------------------------------------
function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

function encryptPayload(obj, passphrase) {
  if (!passphrase) return JSON.stringify(obj);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const text = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ enc: 1, s: salt.toString('base64'), i: iv.toString('base64'), t: tag.toString('base64'), c: text.toString('base64') });
}

function decryptPayload(raw, passphrase) {
  if (!passphrase || raw == null || typeof raw !== 'object' || raw.enc !== 1) return raw;
  try {
    const salt = Buffer.from(raw.s, 'base64');
    const iv = Buffer.from(raw.i, 'base64');
    const tag = Buffer.from(raw.t, 'base64');
    const ciphertext = Buffer.from(raw.c, 'base64');
    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    return null; // wrong passphrase or corrupted packet — never crash on it
  }
}

// ── Local state ----------------------------------------------------------------
const peers = new Map(); // peerId -> { id, name, host, port, lastSeen }
const messages = [];     // { seq, from, fromName, text, ts }
const MAX_HISTORY = 500;
let seqCounter = 0;

// ── Receipts ledger (sales made by POS pages, online or after offline queue)
// Append-only and deduped by receipt id: re-posting the same receipt is a
// no-op, so a device may retry its sync queue as often as it likes.
// Verification: the signer's public key is INSIDE the receipt payload, so any
// node (or anyone) holding the receipt can re-verify — offline forever.
const RECEIPTS_DIR = path.join(__dirname, 'data');
const RECEIPTS_LOG = path.join(RECEIPTS_DIR, 'receipts.jsonl');
const receipts = new Map(); // id -> { receivedAt, id, verified, payload, signature, source }
const MAX_RECEIPTS = 5000;

function loadReceipts() {
  try {
    const text = fs.readFileSync(RECEIPTS_LOG, 'utf8');
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        const r = JSON.parse(l);
        if (r && r.id) receipts.set(r.id, r);
      } catch { /* skip malformed line — never crash on data */ }
    }
  } catch { /* first boot — no ledger yet */ }
}

function appendReceiptLog(entry) {
  try {
    fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
    fs.appendFileSync(RECEIPTS_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('receipts ledger append failed (service continues):', err.message);
  }
}

function verifyReceiptEd25519(payloadStr, signature, pubJwk) {
  try {
    if (!payloadStr || !signature || !pubJwk || pubJwk.kty !== 'OKP' || pubJwk.crv !== 'Ed25519') return false;
    const pub = crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
    const data = Buffer.from(payloadStr, 'utf8');
    const sig = Buffer.from(signature, 'base64url');
    return crypto.verify(null, data, pub, sig);
  } catch { return false; }
}

// ── ซองใบเสร็จโพสต์-ควอนตัม (Q-09) — รูปตามไลบรารี sovereign-pq-identity (src/receipt.js) ──
// bytes ที่ถูกเซ็น = canonical JSON ของแกน {id, issued_at, payload, alg_profile} (เรียงคีย์ ไม่มีช่องว่าง)
// Ed25519 = node:crypto (pk_b64 เป็น SPKI DER 44 ไบต์) · ML-DSA-44 = vendor ในเครื่อง + context "sovereign-pq-receipt/v1"
// หลักเดิม: ตรวจไม่ผ่านชั้นใดชั้นหนึ่ง = ไม่รับลงบัญชี — ขาดตัวใดตัวหนึ่งก็ไม่รับ
const ALG_PROFILE_PQ = 'sovereign.ed25519+ml_dsa44.v1';
const PQ_CONTEXT = Buffer.from('sovereign-pq-receipt/v1', 'utf8');

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function verifyReceiptEnvelope(e) {
  const fail = (error) => ({ ok: false, error });
  try {
    if (!e || typeof e !== 'object') return fail('envelope malformed');
    if (e.alg_profile !== ALG_PROFILE_PQ) return fail('alg_profile not supported at this node: ' + String(e.alg_profile || ''));
    if (!e.id || !e.issued_at || e.payload === undefined) return fail('envelope core missing');
    const p = e.payload;
    if (!p || p.type !== 'SVR-RECEIPT' || !p.id || !Number.isFinite(p.total) || !Array.isArray(p.items)) return fail('receipt malformed');
    if (p.id !== e.id) return fail('receipt id mismatch');
    const sigs = e.signatures || {};
    const core = Buffer.from(canonicalJson({ id: e.id, issued_at: e.issued_at, payload: p, alg_profile: e.alg_profile }), 'utf8');
    // 1) Ed25519 — กุญแจในซอง (SPKI DER) ต้องเป็นตัวเดียวกับที่ฝังใน payload (ผูกกันสองทาง)
    if (!sigs.ed25519?.pk_b64 || !sigs.ed25519?.sig_b64) return fail('missing ed25519 signature');
    let pub;
    try { pub = crypto.createPublicKey({ key: Buffer.from(sigs.ed25519.pk_b64, 'base64'), format: 'der', type: 'spki' }); }
    catch { return fail('ed25519 public key malformed'); }
    if (!p.pub || p.pub.kty !== 'OKP' || p.pub.crv !== 'Ed25519') return fail('payload pubkey missing');
    if (pub.export({ format: 'jwk' }).x !== p.pub.x) return fail('ed25519 pubkey mismatch with payload');
    if (!crypto.verify(null, core, pub, Buffer.from(sigs.ed25519.sig_b64, 'base64'))) return fail('unverified ed25519 signature');
    // 2) ML-DSA-44 (FIPS 204) — context ต้องตรงกับตอนเซ็น มิฉะนั้นถือว่าไม่ผ่าน
    if (!sigs.ml_dsa44?.pk_b64 || !sigs.ml_dsa44?.sig_b64) return fail('missing ml_dsa44 signature');
    const pk = Buffer.from(sigs.ml_dsa44.pk_b64, 'base64');
    if (pk.length !== ml_dsa44.lengths.publicKey) return fail('ml_dsa44 pk length ' + pk.length + ' != ' + ml_dsa44.lengths.publicKey);
    if (ml_dsa44.verify(Buffer.from(sigs.ml_dsa44.sig_b64, 'base64'), core, pk, { context: PQ_CONTEXT }) !== true) return fail('unverified ml_dsa44 signature');
    return { ok: true };
  } catch { return fail('envelope verification error'); }
}

loadReceipts();

function prunePeers() {
  const now = Date.now();
  for (const [id, p] of peers) {
    if (now - p.lastSeen > PEER_TTL) peers.delete(id);
  }
}

function rememberPeer({ id, name, host, lastSeen }) {
  if (!id || id === PEER_ID) return;
  const existing = peers.get(id);
  peers.set(id, {
    id,
    name: name || existing?.name || 'unknown',
    host: host || existing?.host || '',
    lastSeen: lastSeen || Date.now(),
  });
}

// ── UDP multicast (discovery + broadcast) -------------------------------------
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

function sendAnnounce(type, extra = {}) {
  const payload = encryptPayload(
    { v: 1, type, from: PEER_ID, name: PEER_NAME, ts: Date.now(), ...extra },
    PASSPHRASE
  );
  const buf = Buffer.from(payload, 'utf8');
  udp.send(buf, 0, buf.length, MULTI_PORT, MULTI_ADDR);
}

udp.on('message', (buf, rinfo) => {
  // Parse outer envelope first (may be encrypted)
  let outer;
  try { outer = JSON.parse(buf.toString('utf8')); } catch { return; }
  const inner = decryptPayload(outer, PASSPHRASE);
  if (!inner || inner.v !== 1 || !inner.from) return;
  if (inner.from === PEER_ID) return; // our own echo

  switch (inner.type) {
    case 'announce':
      rememberPeer({ id: inner.from, name: inner.name, host: rinfo.address });
      // answer with our own announce so the other side learns about us too
      if (!peers.has(inner.from)) sendAnnounce('announce');
      break;
    case 'leave':
      peers.delete(inner.from);
      break;
    case 'message': {
      if (!inner.seq) break;
      rememberPeer({ id: inner.from, name: inner.name, host: rinfo.address });
      // Dedupe: same seq must not enter history twice
      if (messages.some(m => m.from === inner.from && m.seq === inner.seq)) break;
      seqCounter += 1;
      messages.push({ seq: inner.seq, from: inner.from, fromName: inner.name, text: String(inner.text ?? '').slice(0, 2000), ts: inner.ts || Date.now() });
      if (messages.length > MAX_HISTORY) messages.splice(0, messages.length - MAX_HISTORY);
      break;
    }
    default:
      break;
  }
});

udp.on('error', (err) => {
  // Rule from the sovereign web: aux service must never take the page down.
  console.error('udp error (ignored, service continues):', err.message);
});

udp.bind(MULTI_PORT, () => {
  try {
    udp.setMulticastTTL(4); // a few hops is enough for a LAN/farm ground
    udp.addMembership(MULTI_ADDR);
  } catch (err) {
    console.error('multicast setup warning:', err.message);
  }
  console.log(`sovereign-mesh: UDP multicast ready on ${MULTI_ADDR}:${MULTI_PORT}`);
  console.log(`sovereign-mesh: peer id=${PEER_ID} name=${PEER_NAME} http=:${PORT}`);
  sendAnnounce('announce');
  // Re-announce every 10s (cheap keepalive; neighbours with old state recover)
  setInterval(() => sendAnnounce('announce'), 10_000).unref?.();
});

// On shutdown tell neighbours we left, so peer lists stay clean.
function gracefulLeave() {
  try { sendAnnounce('leave'); } catch {}
  setTimeout(() => process.exit(0), 120);
}
process.on('SIGINT', gracefulLeave);
process.on('SIGTERM', gracefulLeave);

// ── HTTP server (API + chat UI) -----------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');

// Sovereignty tools — each is a self-contained page (zero external requests).
// Serving them from the mesh node means every device on the LAN reaches them
// at http://<mesh-host>:4200/<path> — no internet, no cdn, no cloud.
const PAGES = new Map([
  ['/', 'lan-messenger.html'],
  ['/nfc', 'nfc-checkin.html'],
  ['/ble', 'ble-sensors.html'],
  ['/shop', 'shop.html'],
]);
const PAGE_CACHE = new Map(); // pathname -> Buffer | null (loaded once at startup)

for (const [route, file] of PAGES) {
  const full = path.join(PUBLIC_DIR, file);
  PAGE_CACHE.set(route, fs.existsSync(full) ? fs.readFileSync(full) : null);
}

// Static assets (PWA shell). Content types are explicit — the browser trusts
// them for Service Worker registration (sw.js must be real JavaScript).
const STATIC_FILES = new Map([
  ['/sw.js', ['sw.js', 'application/javascript; charset=utf-8']],
  ['/manifest.json', ['manifest.json', 'application/json; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/icon-512-maskable.png', ['icon-512-maskable.png', 'image/png']],
]);
const STATIC_CACHE = new Map(); // pathname -> [Buffer, mime]

for (const [route, [file, mime]] of STATIC_FILES) {
  const full = path.join(PUBLIC_DIR, file);
  STATIC_CACHE.set(route, fs.existsSync(full) ? [fs.readFileSync(full), mime] : null);
}

// แฟ้ม vendor โพสต์-ควอนตัม (Q-09) — เสิร์ฟให้หน้า /shop import ตรง URL (allowlist ชัดแจ้งตามสไตล์ของไฟล์นี้)
// เป็นแฟ้มชุดเดียวกับที่ server ใช้ตรวจ ML-DSA ด้านบน — sw.js precache รายการนี้ด้วยเพื่อขายออฟไลน์
const VENDOR_FILES = [
  '/pq-vendor/@noble/post-quantum/ml-dsa.js',
  '/pq-vendor/@noble/post-quantum/_crystals.js',
  '/pq-vendor/@noble/post-quantum/utils.js',
  '/pq-vendor/@noble/curves/utils.js',
  '/pq-vendor/@noble/curves/abstract/fft.js',
  '/pq-vendor/@noble/curves/abstract/modular.js',
  '/pq-vendor/@noble/hashes/sha3.js',
  '/pq-vendor/@noble/hashes/_u64.js',
  '/pq-vendor/@noble/hashes/utils.js',
];
for (const route of VENDOR_FILES) {
  const full = path.join(PUBLIC_DIR, route.slice(1));
  STATIC_CACHE.set(route, fs.existsSync(full) ? [fs.readFileSync(full), 'text/javascript; charset=utf-8'] : null);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    // Sovereign-origin rule: never leak stack details to the network side
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  prunePeers();
  try {
    if (u.pathname === '/health') {
      return json(res, 200, { status: 'ok', peer: { id: PEER_ID, name: PEER_NAME }, peers: peers.size, messages: messages.length, receipts: receipts.size, encrypted: Boolean(PASSPHRASE) });
    }

    if (u.pathname === '/peers' && req.method === 'GET') {
      const now = Date.now();
      const list = [...peers.values()]
        .filter(p => now - p.lastSeen <= PEER_TTL)
        .map(p => ({ id: p.id, name: p.name, host: p.host, ageMs: now - p.lastSeen }));
      return json(res, 200, { self: { id: PEER_ID, name: PEER_NAME }, peers: list });
    }

    if (u.pathname === '/messages' && req.method === 'GET') {
      const since = Number(u.searchParams.get('since') || 0);
      const list = messages.filter(m => m.seq > since).slice(-100);
      return json(res, 200, { cursor: seqCounter, messages: list });
    }

    if (u.pathname === '/send' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'invalid json' }); }
      const text = String(body?.text ?? '').trim().slice(0, 2000);
      if (!text) return json(res, 400, { error: 'text required' });

      const seq = ++seqCounter;
      const entry = { seq, from: PEER_ID, fromName: PEER_NAME, text, ts: Date.now() };
      messages.push(entry);
      if (messages.length > MAX_HISTORY) messages.splice(0, messages.length - MAX_HISTORY);

      // Broadcast to the whole LAN segment — every peer receives it directly.
      sendAnnounce('message', { seq, text, ts: entry.ts });
      return json(res, 200, { ok: true, seq });
    }

    if (u.pathname === '/receipts' && req.method === 'POST') {
      const raw = await readBody(req, 16 * 1024);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'invalid json' }); }

      // ซองโพสต์-ควอนตัม (Q-09): {id, issued_at, payload, alg_profile, signatures{ed25519, ml_dsa44}}
      // ตรวจครบทุกชั้นของโปรไฟล์ก่อนลงบัญชี — ตัวใดขาดหรือไม่ผ่าน = ปฏิเสธทั้งใบ
      if (body?.envelope) {
        const env = body.envelope;
        const v = verifyReceiptEnvelope(env);
        if (!v.ok) return json(res, 400, { error: v.error });
        const id = String(env.id).slice(0, 64);
        if (receipts.has(id)) return json(res, 200, { ok: true, id, duplicate: true });
        const entry = {
          receivedAt: Date.now(), id,
          payload: typeof body.payload === 'string' ? body.payload.slice(0, 16384) : JSON.stringify(env.payload).slice(0, 16384),
          signature: typeof body.signature === 'string' ? body.signature.slice(0, 200) : '',
          envelope: env, verified: 'ed25519+ml_dsa44',
          source: req.socket?.remoteAddress || '',
        };
        receipts.set(id, entry);
        if (receipts.size > MAX_RECEIPTS) {
          const drop = [...receipts.keys()].slice(0, receipts.size - MAX_RECEIPTS);
          for (const k of drop) receipts.delete(k);
        }
        appendReceiptLog(entry);
        return json(res, 200, { ok: true, id, duplicate: false, verified: 'ed25519+ml_dsa44' });
      }

      // แนวเดิม (Ed25519 ชั้นเดียว): สลิปเก่าจาก POS รุ่นก่อน/โหนดเพื่อนที่ยังไม่อัปเดต ยังเข้าได้เต็มสิทธิ์
      const payloadStr = typeof body?.payload === 'string' ? body.payload : '';
      const signature = typeof body?.signature === 'string' ? body.signature : '';
      let receiptObj = null;
      try { receiptObj = JSON.parse(payloadStr); } catch { receiptObj = null; }
      if (!receiptObj || receiptObj.type !== 'SVR-RECEIPT' || !receiptObj.id ||
          !Number.isFinite(receiptObj.total) || !Array.isArray(receiptObj.items)) {
        return json(res, 400, { error: 'receipt malformed' });
      }
      const id = String(receiptObj.id).slice(0, 64);
      // Idempotency: same id already in the ledger → accept quietly (retry-safe)
      if (receipts.has(id)) {
        return json(res, 200, { ok: true, id, duplicate: true });
      }
      if (!verifyReceiptEd25519(payloadStr, signature, receiptObj.pub)) {
        return json(res, 400, { error: 'unverified signature', id: undefined });
      }
      const entry = { receivedAt: Date.now(), id, payload: payloadStr.slice(0, 16384), signature: signature.slice(0, 200), source: req.socket?.remoteAddress || '' };
      receipts.set(id, entry);
      if (receipts.size > MAX_RECEIPTS) {
        const drop = [...receipts.keys()].slice(0, receipts.size - MAX_RECEIPTS);
        for (const k of drop) receipts.delete(k);
      }
      appendReceiptLog(entry);
      return json(res, 200, { ok: true, id, duplicate: false });
    }

    if (u.pathname === '/receipts' && req.method === 'GET') {
      const since = Number(u.searchParams.get('since') || 0);
      const list = [...receipts.values()]
        .filter(r => r.receivedAt > since)
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .slice(-200);
      const cursor = list.length ? list[list.length - 1].receivedAt : since;
      return json(res, 200, { cursor, count: list.length, receipts: list });
    }

    // Bundled sovereignty tool pages (static, cache disabled)
    if (PAGE_CACHE.has(u.pathname)) {
      const page = PAGE_CACHE.get(u.pathname);
      if (page) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(page);
      }
    }

    // PWA static assets (manifest, sw, icons)
    if (STATIC_CACHE.has(u.pathname)) {
      const asset = STATIC_CACHE.get(u.pathname);
      if (asset) {
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
        return res.end(asset[0]);
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err?.status || (err?.message === 'payload too large' ? 413 : 500);
    return json(res, status, { error: status === 500 ? 'internal error' : String(err?.message || 'error') });
  }
});

server.listen(PORT, () => {
  console.log(`sovereign-mesh: HTTP UI at http://localhost:${PORT}/`);
  console.log(`sovereign-mesh: receipts ledger loaded (${receipts.size} entries)`);
});
