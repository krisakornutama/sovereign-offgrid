#!/usr/bin/env node
// สร้าง pq-vendor ลง public/pq-vendor/ — closure ของ @noble/post-quantum (ml-dsa เท่านั้น · Q-09)
// ใช้: node vendor-pq.mjs <แฟ้มต้นทาง pq-vendor>
//   แหล่งมาตรฐาน: project-sovereign/pq-vendor (สร้างครั้งแรกด้วย build/q10-vendor.mjs ของ sovereign-pq-identity)
//
// ทำไมต้องแปลง import: แฟ้มต้นฉบับใช้ bare specifier (@noble/hashes/utils.js ฯลฯ)
//   - เบราว์เซอร์: ต้องมี import map ก่อนใช้ได้
//   - node (server.js): ESM ธรรมดาหา node_modules ไม่เจอ = import ล้ม
// แปลงเป็น relative path แฟ้มชุดเดียวใช้ได้ทั้งสองฝั่ง — server ตรวจ ML-DSA ด้วยแฟ้มเดียวกับที่เสิร์ฟให้หน้าร้าน
// (ไม่มี npm dependency ใหม่ — คงกฎ Dockerfile "Zero npm dependencies" ไว้)
import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const srcRoot = process.argv[2];
if (!srcRoot) { console.error('usage: node vendor-pq.mjs <source pq-vendor dir>'); process.exit(1); }
const outRoot = path.join(__dirname, 'public', 'pq-vendor');

// closure ของ ml-dsa.js (กราฟ import ตรวจแล้วด้วยมือ — แต่ละแฟ้มไม่ import อื่นนอกชุดนี้)
// + LICENSE ทุกแพ็กเกจ (MIT — กฎ attribution ของ vendor ในโปรเจกต์นี้)
const FILES = [
  '@noble/post-quantum/ml-dsa.js',
  '@noble/post-quantum/slh-dsa.js',
  '@noble/post-quantum/_crystals.js',
  '@noble/post-quantum/utils.js',
  '@noble/curves/utils.js',
  '@noble/curves/abstract/fft.js',
  '@noble/curves/abstract/modular.js',
  '@noble/hashes/sha2.js',
  '@noble/hashes/hmac.js',
  '@noble/hashes/_md.js',
  '@noble/hashes/sha3.js',
  '@noble/hashes/_u64.js',
  '@noble/hashes/utils.js',
  '@noble/post-quantum/LICENSE',
  '@noble/curves/LICENSE',
  '@noble/hashes/LICENSE',
];

// bare specifier → relative path จากโฟลเดอร์ของแฟ้มนั้น (fft.js/modular.js/แฟ้ม hashes ใช้ relative อยู่แล้ว)
const REWRITE = {
  '@noble/post-quantum/ml-dsa.js': { '@noble/curves/utils.js': '../curves/utils.js', '@noble/hashes/sha3.js': '../hashes/sha3.js' },
  '@noble/post-quantum/slh-dsa.js': {
    '@noble/hashes/hmac.js': '../hashes/hmac.js',
    '@noble/curves/utils.js': '../curves/utils.js',
    '@noble/hashes/sha2.js': '../hashes/sha2.js',
    '@noble/hashes/sha3.js': '../hashes/sha3.js',
    '@noble/hashes/utils.js': '../hashes/utils.js',
  },
  '@noble/post-quantum/_crystals.js': { '@noble/curves/abstract/fft.js': '../curves/abstract/fft.js', '@noble/hashes/sha3.js': '../hashes/sha3.js' },
  '@noble/post-quantum/utils.js': { '@noble/hashes/utils.js': '../hashes/utils.js' },
  '@noble/curves/utils.js': { '@noble/hashes/utils.js': '../hashes/utils.js' },
};

let n = 0;
for (const rel of FILES) {
  const src = path.join(srcRoot, rel);
  const dst = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let text = fs.readFileSync(src, 'utf8');
  const map = REWRITE[rel];
  if (map) for (const [spec, target] of Object.entries(map)) {
    if (!text.includes("'" + spec + "'")) { console.error('vendor-pq: ไม่เจอ import ที่จะแปลง: ' + spec + ' ใน ' + rel); process.exit(1); }
    text = text.replaceAll("'" + spec + "'", "'" + target + "'");
  }
  fs.writeFileSync(dst, text);
  n++;
  console.log('  ' + rel + '  (' + text.length + ' chars)');
}
console.log('vendor-pq: ' + n + ' files -> ' + outRoot);
