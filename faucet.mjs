#!/usr/bin/env node
// run.mjs — Mint USDC & XAUM (fullnode direct) + MODE(dryrun/execute) + CLAIM_MODE
// Deps: npm i @mysten/sui dotenv

// [MODIFIKASI 1] Dihapus/komentar agar tidak menimpa PRIVATE_KEY dari auto.mjs
// import 'dotenv/config'; 

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

/* ============================== ENV & LOG =================================== */

const FULLNODE     = process.env.SUI_FULLNODE || getFullnodeUrl('testnet');
const MODE         = (process.env.MODE || 'execute').toLowerCase();    // 'execute' | 'dryrun'
const CLAIM_MODE   = (process.env.CLAIM_MODE || 'usdc').toLowerCase(); // 'usdc' | 'xaum' | 'both' | 'alternate'
const GAS_BUDGET   = process.env.GAS_BUDGET ? Number(process.env.GAS_BUDGET) : null;
const GAS_PRICE    = process.env.GAS_PRICE  ? Number(process.env.GAS_PRICE)  : null;
const CLAIM_DELAY  = Number(process.env.CLAIM_DELAY_MS || '3000');     // delay antar-claim (ms), default 3s

// [MODIFIKASI 2] Tambahkan 'process.env.PRIVATE_KEY' agar kompatibel dengan auto.mjs
const SUI_PK_RAW     = (process.env.SUI_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
const SUI_KEY_SCHEME = String(process.env.SUI_KEY_SCHEME || 'ed25519').toLowerCase();
const LOG_LEVEL      = String(process.env.LOG_LEVEL || 'info').toLowerCase();

const log = {
  info:  (...a) => console.log('[info]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* ============================== KEYPAIR ===================================== */

function parsePrivKey(raw) {
  if (!raw) throw new Error('SUI_PRIVATE_KEY atau PRIVATE_KEY kosong di environment.');
  if (raw.startsWith('suiprivkey') || raw.startsWith('ed25519:') || raw.startsWith('secp256k1:')) {
    const { schema, secretKey } = decodeSuiPrivateKey(raw);
    const s = String(schema).toLowerCase();
    if (s === 'ed25519')   return { kp: Ed25519Keypair.fromSecretKey(secretKey),  scheme: 'ed25519' };
    if (s === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(secretKey), scheme: 'secp256k1' };
    throw new Error(`Skema kunci tidak didukung: ${schema}`);
  }
  let bytes;
  if (raw.startsWith('0x')) bytes = Buffer.from(raw.slice(2), 'hex');
  else                      bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 33) bytes = bytes.subarray(1);
  if (bytes.length !== 32) throw new Error(`Seed harus 32 byte, dapat ${bytes.length} byte`);
  if (SUI_KEY_SCHEME === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(bytes), scheme: 'secp256k1' };
  return { kp: Ed25519Keypair.fromSeed(bytes), scheme: 'ed25519' };
}

function fmtAmount(raw, decimals = 6) {
  try { return (Number(raw) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: decimals }); }
  catch { return String(raw); }
}

/* =============================== CLIENT ===================================== */

const sui = new SuiClient({ url: FULLNODE });

/* =================== Discovery & Preflight Helpers ========================== */
// ... (Tidak ada perubahan dari Baris 69 hingga 333) ...
function coinTypeFromEnvOrGuess({ pkg, module, coinType }) {
  if (coinType && coinType.includes('::')) return coinType;
  const struct = module.toUpperCase(); // ex: usdc -> USDC
  return `${pkg}::${module}::${struct}`;
}
async function queryObjectsCompat({ filter, options, cursor = null, limit = 50 }) {
  const params = [{ filter, options, cursor, limit }];
  const transport = (sui.client?.request ? sui.client : sui.transport);
  return await transport.request('suix_queryObjects', params);
}
async function getObjectBrief(objectId) {
  try {
    const res = await sui.getObject({
      id: objectId,
      options: { showOwner: true, showType: true, showContent: false },
    });
    return res;
  } catch {
    return null;
  }
}
function describeOwner(owner) {
  if (!owner) return 'unknown';
  if (typeof owner === 'string') return owner;
  if (owner.Shared) return `Shared(initial_shared_version=${owner.Shared.initial_shared_version})`;
  if (owner.AddressOwner) return `AddressOwner(${owner.AddressOwner})`;
  if (owner.ObjectOwner) return `ObjectOwner(${owner.ObjectOwner})`;
  if (owner.Immutable) return 'Immutable';
  return JSON.stringify(owner);
}
async function assertTreasuryObject({ label, objectId, mustBeShared }) {
  const obj = await getObjectBrief(objectId);
  if (!obj || obj.error) {
    throw new Error(`[${label}] Treasury/Cap object NOT FOUND on ${FULLNODE}:\n  ${objectId}\n  → Periksa jaringan (.env SUI_FULLNODE) & ID.`);
  }
  const { owner, type, objectId: idEcho } = obj.data ?? {};
  log.info(`[${label}] treasury object exists: ${idEcho}`);
  log.info(`[${label}]   type  : ${type || '(unknown)'}`);
  log.info(`[${label}]   owner : ${describeOwner(owner)}`);
  const isShared = !!owner?.Shared;
  if (mustBeShared && !isShared) {
    throw new Error(`[${label}] Treasury/Cap BUKAN Shared (kemungkinan admin-only).`);
  }
  return { isShared, type, id: idEcho };
}
async function discoverTreasuryForCoinType(coinType, { pkg, module }) {
  const options = { showOwner: true, showType: true };
  const tryFind = async (StructType) => {
    const res = await queryObjectsCompat({ filter: { StructType }, options }).catch(() => null);
    const list = res?.data || [];
    if (!list.length) return null;
    const shared = list.find(o => o.data?.owner?.Shared);
    return shared ? shared.data : list[0].data;
  };
  const customTreasuryType = `${pkg}::${module}::Treasury`;
  let found = await tryFind(customTreasuryType);
  if (found) return { id: found.objectId, type: customTreasuryType, owner: found.owner };
  const caps = [
    `0x2::coin::TreasuryCap<${coinType}>`,
    `0x2::coin::MintCap<${coinType}>`,
    `0x2::coin::Supply<${coinType}>`,
  ];
  for (const ty of caps) {
    const hit = await tryFind(ty);
    if (hit) return { id: hit.objectId, type: ty, owner: hit.owner };
  }
  return null;
}

/* ================================ CORE ====================================== */
async function resolveDecimals(coinType) {
  if (!coinType) return 6;
  const meta = await sui.getCoinMetadata({ coinType }).catch(() => null);
  return meta?.decimals ?? 9;
}
async function showBalance(owner, coinType, decimals, label) {
  if (!coinType) { log.warn(`[${label}] COIN_TYPE kosong; skip cek saldo`); return; }
  const bal = await sui.getBalance({ owner, coinType }).catch(() => null);
  if (!bal) { log.warn(`[${label}] gagal getBalance`); return; }
  log.info(`[${label}] totalBalance: ${bal.totalBalance} (~ ${fmtAmount(bal.totalBalance, decimals)} ${label})`);
}
function buildMintTx({ pkg, module, func, treasury, recipient, amountRaw, sender }) {
  const tx = new Transaction();
  tx.setSender(sender);
  if (GAS_BUDGET) tx.setGasBudget(GAS_BUDGET);
  if (GAS_PRICE)  tx.setGasPrice(GAS_PRICE);
  tx.moveCall({
    target: `${pkg}::${module}::${func}`,
    arguments: [
      tx.object(treasury),                 // shared object Treasury
      tx.pure.u64(amountRaw.toString()),   // u64 amount
      tx.pure.address(recipient),          // recipient
    ],
  });
  return tx;
}
function extractMintedCoinTypeFromObjectChanges(objectChanges) {
  const oc = objectChanges || [];
  const created = oc.find(x => x.type === 'created' && String(x.objectType || '').includes('::coin::Coin<'));
  if (!created) return null;
  const m = created.objectType.match(/0x[0-9a-f]+::[A-Za-z0-9_]+::[A-Za-z0-9_:<>]+/i);
  return m ? m[0] : null;
}
function getCoinCfg(label) {
  const upper = label.toUpperCase(); // USDC | XAUM
  const cfg = {
    label,
    pkg:       (process.env[`${upper}_PKG_ID`]        || '').trim(),
    module:    (process.env[`${upper}_MODULE`]        || '').trim(),
    func:      (process.env[`${upper}_FUNCTION`]      || 'mint').trim(),
    treas:     (process.env[`${upper}_TREASURY_ID`]   || '').trim(),
    coinType:  (process.env[`${upper}_COIN_TYPE`]     || '').trim(),
    mustShared:Boolean(Number(process.env[`${upper}_TREASURY_MUST_BE_SHARED`] || '1')), // enforce shared by default
  };
  if (!cfg.pkg)    throw new Error(`[${label}] PKG_ID belum diisi`);
  if (!cfg.module) throw new Error(`[${label}] MODULE belum diisi`);
  cfg.coinType = coinTypeFromEnvOrGuess(cfg);
  return cfg;
}
async function computeAmountRaw(label, coinType, envAmountKey, envAmountRawKey) {
  const amountEnv = process.env[envAmountKey];
  const rawEnv    = process.env[envAmountRawKey];
  const decimals  = await resolveDecimals(coinType);
  if (rawEnv) return { amountRaw: BigInt(rawEnv), decimals };
  const num = amountEnv ? Number(amountEnv) : (label === 'usdc' ? 10 : 1); // default: USDC=10, XAUM=1
  const raw = BigInt(Math.round(num * 10 ** decimals));
  return { amountRaw: raw, decimals };
}

/* ========================== GAS HANDLING (fresh) ============================ */
async function pickFreshGas({ owner, minBalance = 1_000_000 }) {
  const res = await sui.getCoins({ owner, coinType: '0x2::sui::SUI', limit: 50 });
  const coins = res.data || [];
  if (!coins.length) throw new Error('Tidak ada SUI untuk gas.');
  coins.sort((a,b) => Number(b.balance) - Number(a.balance));
  const best = coins.find(c => Number(c.balance) >= minBalance) || coins[0];
  const o = await sui.getObject({ id: best.coinObjectId, options: { showContent: false, showOwner: false, showType: false } });
  const v = o?.data?.version || best.version;
  const d = o?.data?.digest  || best.digest;
  return { objectId: best.coinObjectId, version: Number(v), digest: d };
}

/* ========================== Execute Compat (SDK all) ======================== */
async function signAndExecuteCompat({ tx, txBytes, signer }) {
  if (typeof sui.signAndExecuteTransactionBlock === 'function') {
    return await sui.signAndExecuteTransactionBlock({
      signer,
      transactionBlock: tx,
      requestType: 'WaitForLocalExecution',
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
        showBalanceChanges: true,
      },
    });
  }
  if (typeof sui.signAndExecuteTransaction === 'function') {
    return await sui.signAndExecuteTransaction({
      signer,
      transaction: tx,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
        showBalanceChanges: true,
      },
    });
  }
  // fallback raw (requires signer.signTransactionBlock on very old kits)
  let bytes = txBytes;
  if (!bytes) bytes = await tx.build({ client: sui });
  if (typeof signer.signTransactionBlock === 'function') {
    const sigObj = await signer.signTransactionBlock({ transactionBlock: bytes });
    const signature = sigObj.signature || sigObj;
    const b64 = Buffer.from(bytes).toString('base64');
    const params = [
      b64,
      [signature],
      {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
        showBalanceChanges: true,
      },
      'WaitForLocalExecution',
    ];
    const transport = (sui.client?.request ? sui.client : sui.transport);
    return await transport.request('sui_executeTransactionBlock', params);
  }
  throw new Error('SDK terlalu lama: tidak ada signAndExecuteTransaction{Block}, dan keypair tidak punya signTransactionBlock(). Upgrade @mysten/sui disarankan.');
}
async function execWithGasRetry({ label, tx, txBytes, signer, address }) {
  try {
    return await signAndExecuteCompat({ tx, txBytes, signer });
  } catch (e) {
    const msg = String(e?.message || e);
    const isGasVersionErr =
      msg.includes('not available for consumption') ||
      msg.includes('Object version mismatch') ||
      msg.includes('GasObjectNotOwnedObject') ||
      msg.includes('Gas is not available');
    if (!isGasVersionErr) throw e;
    log.warn(`[${label}] gas coin versi lama → retry dengan gas terbaru`);
    const gas = await pickFreshGas({ owner: address, minBalance: GAS_BUDGET || 1_000_000 });
    tx.setGasPayment([{ objectId: gas.objectId, version: gas.version, digest: gas.digest }]);
    const bytes = await tx.build({ client: sui });
    return await signAndExecuteCompat({ tx, txBytes: bytes, signer });
G }
}

/* ================================ RUN ONE =================================== */
async function runOneCoin({ label, cfg, address, kp }) { // [MODIFIKASI] Tambah 'kp'
  // Pastikan package ada
  try {
    const pkgObj = await sui.getObject({ id: cfg.pkg, options: { showType: true } });
    if (pkgObj.error) throw new Error(pkgObj.error.code || 'not found');
  } catch {
    throw new Error(`[${label}] PKG_ID tidak ditemukan di ${FULLNODE} → ${cfg.pkg}.`);
  }
  const { amountRaw, decimals } = await computeAmountRaw(
    label,
    cfg.coinType,
    `${label.toUpperCase()}_AMOUNT`,
    `${label.toUpperCase()}_AMOUNT_RAW`
  );
  log.info(`\n== ${label.toUpperCase()} ==`);
  log.info(`[${label}] Package  :`, cfg.pkg);
  log.info(`[${label}] Module   :`, cfg.module, 'Func:', cfg.func);
  log.info(`[${label}] Treasury :`, cfg.treas || '(auto-discover)');
  log.info(`[${label}] Type     :`, cfg.coinType, 'dec:', decimals);
  log.info(`[${label}] Amount   :`, amountRaw.toString(), `(~ ${fmtAmount(amountRaw.toString(), decimals)} ${label.toUpperCase()})`);
s  // Treasury preflight / discovery
  let treInfo = null;
  if (cfg.treas) {
    try {
      treInfo = await assertTreasuryObject({ label, objectId: cfg.treas, mustBeShared: cfg.mustShared });
    } catch (e) {
      log.warn(`[${label}] Treasury dari .env tidak valid: ${e.message}`);
    }
  }
  if (!treInfo) {
    log.info(`[${label}] mencoba auto-discover Treasury untuk ${cfg.coinType}…`);
    const found = await discoverTreasuryForCoinType(cfg.coinType, { pkg: cfg.pkg, module: cfg.module });
    if (!found) {
      throw new Error(`[${label}] gagal menemukan Treasury/TreasuryCap untuk ${cfg.coinType} di network ini (${FULLNODE}).`);
    }
    log.info(`[${label}] ditemukan kandidat treasury: ${found.id}`);
    log.info(`[${label}]   type  : ${found.type}`);
    log.info(`[${label}]   owner : ${describeOwner(found.owner)}`);
  m   if (cfg.mustShared && !found.owner?.Shared) {
      throw new Error(`[${label}] ditemukan cap/treasury tapi BUKAN Shared (admin-only).`);
    }
    cfg.treas = found.id;
    log.warn(`[${label}] → SET di .env: ${label.toUpperCase()}_TREASURY_ID=${found.id}`);
    treInfo = await assertTreasuryObject({ label, objectId: cfg.treas, mustBeShared: cfg.mustShared });
  }
  if (!treInfo.isShared) {
    throw new Error(`[${label}] Treasury/Cap bukan Shared → kemungkinan mint hanya untuk admin. Cari faucet/cap shared.`);
  }
  await showBalance(address, cfg.coinType, decimals, label.toUpperCase());
  // Build TX
  const tx = buildMintTx({
    pkg: cfg.pkg, module: cfg.module, func: cfg.func,
    treasury: cfg.treas, recipient: address, amountRaw, sender: address,
  });
  // Set GAS payment fresh sebelum build
  const gas = await pickFreshGas({ owner: address, minBalance: GAS_BUDGET || 1_000_000 });
  tx.setGasOwner(address);
  tx.setGasPayment([{ objectId: gas.objectId, version: gas.version, digest: gas.digest }]);
  // Build & DRYRUN
  let txBytes;
  try {
    txBytes = await tx.build({ client: sui });
  } catch (e) {
    throw new Error(`[${label}] build() gagal: ${e?.message || e}`);
A }
  let dry;
  try {
    dry = await sui.dryRunTransactionBlock({ transactionBlock: txBytes });
  } catch (e) {
    throw new Error(`[${label}] dryRun gagal: ${e?.message || e}`);
  }
  const st  = dry.effects?.status?.status;
  const err = dry.effects?.status?.error;
  log.info(`[${label}] dryRun status:`, st, err || '');
  if (dry?.events?.length) {
    log.info(`[${label}] dryRun events:`, dry.events.map(e => e.type).join(', '));
  }
  if (dry?.objectChanges?.length) {
    const inferred = extractMintedCoinTypeFromObjectChanges(dry.objectChanges);
    if (inferred && cfg.coinType && inferred !== `0x2::coin::Coin<${cfg.coinType}>`) {
      log.warn(`[${label}] coin type dryRun ≠ env, inferred = ${inferred}`);
    }
  }
  if (MODE === 'dryrun') {
    log.info(`[${label}] [MODE=dryrun] stop di sini.`);
A   return;
  }
  if (st !== 'success') throw new Error(`[${label}] dryRun fail: ${err || st}`);
  // EXECUTE — compat + retry gas version
  const exec = await execWithGasRetry({ label, tx, txBytes, signer: kp, address }); // [MODIFIKASI] 'kp' dilewatkan
  const digest = exec.digest ?? exec.transactionDigest;
  // Effects mungkin kosong, refetch
  let effects = exec.effects;
  if (!effects) {
    const opt = { showEffects: true, showEvents: true, showObjectChanges: true, showBalanceChanges: true };
    try {
      const txb = await sui.getTransactionBlock({ digest, options: opt });
      effects = txb.effects;
      exec.events = txb.events;
      exec.objectChanges = txb.objectChanges;
      exec.balanceChanges = txb.balanceChanges;
    } catch { /* ignore */ }
  }
  const effSt  = effects?.status?.status;
  const effErr = effects?.status?.error;
  log.info(`[${label}] execute digest:`, digest);
  log.info(`[${label}] execute status:`, effSt, effErr || '');
  if (effSt !== 'success') throw new Error(`[${label}] EXECUTE FAILED: ${effErr || 'unknown error'}`);
source_   const events = exec.events || [];
  if (events.length) {
    log.info(`[${label}] events:`);
    for (const ev of events) log.info('  -', ev.type, ev.parsedJson ? JSON.stringify(ev.parsedJson) : '');
  } else {
    log.info(`[${label}] events: (none)`);
  }
  let delta = 0n;
  const bchg = exec.balanceChanges || [];
  if (bchg.length) {
    delta = bchg
      .filter(x => x.owner?.AddressOwner?.toLowerCase?.() === address.toLowerCase())
      .reduce((acc, x) => acc + (x.coinType === cfg.coinType ? BigInt(x.amount) : 0n), 0n);
    log.info(`[${label}] balanceChanges delta:`, delta.toString());
  }
  await showBalance(address, cfg.coinType, decimals, label.toUpperCase());
  return exec;
}

/* =================================== MAIN =================================== */

// [MODIFIKASI 3] Pindahkan key parsing ke dalam 'run' agar error tertangkap
// const { kp, scheme } = parsePrivKey(SUI_PK_RAW);
// const address = kp.getPublicKey().toSuiAddress();
// log.info('== Faucet Direct (fullnode only) ==');
// log.info('Fullnode :', FULLNODE);
// log.info('Key type :', scheme);
// log.info('Address  :', address);
// log.info('Mode     :', MODE);
// log.info('Claim    :', CLAIM_MODE);

const run = async () => {
  // [MODIFIKASI 3] Logika key parsing dan log awal dipindah ke sini
  const { kp, scheme } = parsePrivKey(SUI_PK_RAW);
  const address = kp.getPublicKey().toSuiAddress();

  log.info('== Faucet Direct (fullnode only) ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Key type :', scheme);
  log.info('Address  :', address);
  log.info('Mode     :', MODE);
  log.info('Claim    :', CLAIM_MODE);

  const usdcCfg = (() => { try { return getCoinCfg('usdc'); } catch { return null; } })();
  const xaumCfg = (() => { try { return getCoinCfg('xaum'); } catch { return null; } })();

  if (CLAIM_MODE === 'usdc') {
    if (!usdcCfg) throw new Error('[usdc] config tidak lengkap');
    await runOneCoin({ label: 'usdc', cfg: usdcCfg, address, kp }); // Kirim 'kp'
    return;
  }
  if (CLAIM_MODE === 'xaum') {
    if (!xaumCfg) throw new Error('[xaum] config tidak lengkap');
    await runOneCoin({ label: 'xaum', cfg: xaumCfg, address, kp }); // Kirim 'kp'
    return;
  }
  if (CLAIM_MODE === 'both') {
    if (!usdcCfg || !xaumCfg) throw new Error('[both] butuh kedua config USDC & XAUM lengkap');

    await runOneCoin({ label: 'usdc', cfg: usdcCfg, address, kp }); // Kirim 'kp'

    // Delay antar-claim (env atau default 3s)
    if (CLAIM_DELAY > 0) {
      log.info(`[delay] menunggu ${CLAIM_DELAY} ms sebelum claim XAUM...`);
      await sleep(CLAIM_DELAY);
    }

    await runOneCoin({ label: 'xaum', cfg: xaumCfg, address, kp }); // Kirim 'kp'
    return;
  }
  if (CLAIM_MODE === 'alternate') {
    if (!usdcCfg || !xaumCfg) throw new Error('[alternate] butuh kedua config USDC & XAUM lengkap');
    const pick = (new Date().getMinutes() % 2 === 0) ? 'usdc' : 'xaum';
    const cfg  = pick === 'usdc' ? usdcCfg : xaumCfg;
    await runOneCoin({ label: pick, cfg: cfg, address, kp }); // Kirim 'kp'
    return;
  }
  throw new Error(`CLAIM_MODE tidak dikenal: ${CLAIM_MODE}`);
};

run().catch(e => {
  log.error('FATAL:', e.message);
  process.exit(1);
});
