#!/usr/bin/env node
// point.mjs

// Skrip ini tidak memiliki import 'dotenv/config', yang mana sudah benar

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const CREEK_API_BASE = process.env.CREEK_API_BASE || 'https://api-test.creek.finance';

const log = {
  info:  (...a) => console.log('[info]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

function addrShort(a) { return a ? `${a.slice(0,10)}…${a.slice(-6)}` : a; }

// === [MODIFIKASI] Menggabungkan sumber PRIVATE KEY ===
function parsePrivKeyToAddress() {
  // Cari PRIVATE_KEY (dari auto.mjs) atau SUI_PRIVATE_KEY
  const raw = process.env.PRIVATE_KEY || process.env.SUI_PRIVATE_KEY || ''; 
  const pref = String(process.env.SUI_KEY_SCHEME || 'ed25519').toLowerCase();
  if (!raw) return null;

  // format: suiprivkey:..., ed25519:..., secp256k1:...
  if (raw.startsWith('suiprivkey') || raw.startsWith('ed25519:') || raw.startsWith('secp256k1:')) {
    const { schema, secretKey } = decodeSuiPrivateKey(raw);
    const s = String(schema).toLowerCase();
    if (s === 'ed25519')   return Ed25519Keypair.fromSecretKey(secretKey).getPublicKey().toSuiAddress();
    if (s === 'secp256k1') return Secp256k1Keypair.fromSecretKey(secretKey).getPublicKey().toSuiAddress();
    throw new Error(`Skema kunci tidak didukung: ${schema}`);
  }

  // format: 0xHEX / base64 seed 32B (atau 33B dgn prefix)
  let bytes;
  if (raw.startsWith('0x')) bytes = Buffer.from(raw.slice(2), 'hex');
  else                      bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 33) bytes = bytes.subarray(1);
  if (bytes.length !== 32) throw new Error(`Seed harus 32 byte, dapat ${bytes.length} byte`);
  if (pref === 'secp256k1') return Secp256k1Keypair.fromSecretKey(bytes).getPublicKey().toSuiAddress();
  return Ed25519Keypair.fromSeed(bytes).getPublicKey().toSuiAddress();
}

async function creekFetch(path) {
  const url = `${CREEK_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      'x-request-id': `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    throw new Error(`HTTP ${res.status} ${url} ${txt ? `— ${txt.slice(0,200)}` : ''}`);
  }
  return await res.json();
}

async function getUserInfo(address) {
  if (!address) throw new Error('Alamat kosong untuk /api/user/info/{address}');
  return creekFetch(`/api/user/info/${address}`);
}
async function getInvitees(address, page=1, pageSize=10) {
  if (!address) throw new Error('Alamat kosong untuk /api/user/invitees/{address}');
  return creekFetch(`/api/user/invitees/${address}?page=${page}&page_size=${pageSize}`);
}

function parseUserInfo(json) {
  const u = json?.data?.user || {};
  return {
    address: u.wallet_address || '',
    totalPoints: Number(u.total_points ?? 0),
    inviteCount: Number(u.invite_count ?? 0),
    inviteesTotal: Number(u.invitees_total_points ?? 0),
    rank: Number(u.rank ?? 0) || null,
  };
}
function parseBadges(json) {
  return (json?.data?.badges || []).map(b => ({
    key: b.badge_key,
    name: b.badge_name,
    cur: Number(b.current_count ?? 0),
    req: Number(b.required_count ?? 0),
    done: !!b.is_completed,
    reward: Number(b.points_reward ?? 0),
  }));
}

async function main() {
  // Prioritas address: argumen > env SUI_ADDRESS > derivasi dari SUI_PRIVATE_KEY / PRIVATE_KEY
  let address = (process.argv[2] || '').trim();
  if (!address) address = (process.env.SUI_ADDRESS || '').trim();
  if (!address) {
    try {
      address = parsePrivKeyToAddress();
    } catch (e) {
      log.warn('Gagal derive address dari PRIVATE_KEY:', e.message);
    }
  }
  if (!address) throw new Error('Tidak menemukan address. Isi PRIVATE_KEY, atau set SUI_ADDRESS / argumen.');

  log.info('== CREEK POINTS ==');
  log.info('Address :', addrShort(address));

  const info = await getUserInfo(address);
  const parsed = parseUserInfo(info);
  const badges = parseBadges(info);

  log.info('Points  :', parsed.totalPoints, parsed.rank ? `(rank ${parsed.rank})` : '');
  log.info('Invites :', parsed.inviteCount, parsed.inviteesTotal ? `(invitees pts ${parsed.inviteesTotal})` : '');

  const top = badges
    .slice()
    .sort((a,b) => (b.done - a.done) || ((b.cur/b.req) - (a.cur/a.req)))
    .slice(0, 6);

  if (top.length) log.info('Badges  :');
  for (const b of top) {
    const bar = `${b.cur}/${b.req}`;
    const tick = b.done ? '✅' : '';
    log.info(`  • ${b.name} [${b.key}] ${bar} ${tick}${b.done ? ` (+${b.reward})` : ''}`);
  }

  // Referral ringkas
  try {
    const inv = await getInvitees(address, 1, 10);
    const rows = (inv?.data?.invitees || []).map((it, i) =>
      `${i+1}. ${addrShort(it.wallet_address)} — pts=${it.total_points}`);
    if (rows.length) {
      log.info('Invitees:');
      for (const r of rows) log.info('  ', r);
    }
  } catch (e) {
    log.debug('skip invitees:', e.message);
  }
}

main().catch(e => {
  log.error('FATAL:', e.message);
  process.exit(1);
});
