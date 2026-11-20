// sovereignty/public/sw.js — Service Worker ของ Sovereign mesh node
//
// กลยุทธ์ (ตามหลัก "ไม่พึ่งพาส่วนกลาง"):
//   • Cache-First + Network Fallback สำหรับหน้า/ไฟล์สถิตทั้งหมด
//   • Precache ครบ 3 หน้าเครื่องมือตั้งแต่ติดตั้ง — ออฟไลน์ได้ทันทีหลังเข้าครั้งแรก
//   • API ที่ต้องการค่าสด (/health /peers /messages /send + ทุก non-GET) ไม่ cache
//   • Cache versioning: เปลี่ยน VERSION → ลบแคชชุดเก่าอัตโนมัติตอน activate

const VERSION = 'v5';
const CACHE_NAME = 'sovereign-pwa-' + VERSION;

// PAGES จาก server.js คือแหล่งข้อมูลเดียวกัน — อย่าลืมเพิ่มหน้าใหม่ให้ตรงกันทั้งสองที่
const PRECACHE = [
  '/',
  '/nfc',
  '/ble',
  '/shop',
  '/manifest.json',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  // vendor โพสต์-ควอนตัม (ML-DSA-44 + SLH-DSA-128f) — ขายออฟไลน์ต้องลงชื่อสอง/สามชั้นได้แม้เน็ต/โหนดตาย
  // รายการตรงกับ VENDOR_FILES ใน server.js
  '/pq-vendor/@noble/post-quantum/ml-dsa.js',
  '/pq-vendor/@noble/post-quantum/slh-dsa.js',
  '/pq-vendor/@noble/post-quantum/_crystals.js',
  '/pq-vendor/@noble/post-quantum/utils.js',
  '/pq-vendor/@noble/curves/utils.js',
  '/pq-vendor/@noble/curves/abstract/fft.js',
  '/pq-vendor/@noble/curves/abstract/modular.js',
  '/pq-vendor/@noble/hashes/sha2.js',
  '/pq-vendor/@noble/hashes/hmac.js',
  '/pq-vendor/@noble/hashes/_md.js',
  '/pq-vendor/@noble/hashes/sha3.js',
  '/pq-vendor/@noble/hashes/_u64.js',
  '/pq-vendor/@noble/hashes/utils.js',
];

// API สดของ mesh node — ห้าม cache เด็ดขาด (ค่าต้องปัจจุบันเสมอ)
// /receipts (GET) = บัญชีกลางของขาย — ต้องอ่านสดเสมอ ไม่งั้นการทบทวนบัญชีเห็นของเก่า
const NEVER = new Set(['/health', '/peers', '/messages', '/send', '/receipts']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('sovereign-pwa-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // ทุก method ที่ไม่ใช่ GET (เช่น POST /send) — network ล้วน ห้าม cache
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin ปล่อยผ่าน
  if (NEVER.has(url.pathname)) return;             // API สด — ไป network ตรง

  event.respondWith((async () => {
    const cached = await caches.match(req.url);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      // ออฟไลน์ + ไม่มีแคชเฉพาะ URL นี้: navigation → กลับไปหน้าหลักจากแคช; ที่เหลือ → 503
      if (req.mode === 'navigate') {
        const home = await caches.match('/');
        if (home) return home;
      }
      return new Response('offline — ไม่มีแคชสำหรับรายการนี้', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
