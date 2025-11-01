// stake.mjs — Stake XAUM via staking_manager::stake_xaum
// Deps: npm i @mysten/sui dotenv

// [PERHATIAN]: Jika ada baris 'import 'dotenv/config';' di sini, harap hapus atau komentari.

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const FULLNODE = process.env.SUI_FULLNODE || getFullnodeUrl('testnet');
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const GAS_BUDGET = process.env.GAS_BUDGET ? Number(process.env.GAS_BUDGET) : undefined;
const GAS_PRICE  = process.env.GAS_PRICE  ? Number(process.env.GAS_PRICE)  : undefined;

// staking params
const STAKE_MANAGER_ID = (process.env.STAKE_MANAGER_ID || '').trim(); // shared object
const XAUM_COIN_TYPE   = (process.env.XAUM_COIN_TYPE   || '').trim(); // e.g. 0x...::coin_xaum::COIN_XAUM
const STAKE_AMOUNT     = process.env.STAKE_AMOUNT ? Number(process.env.STAKE_AMOUNT) : 1; // in XAUM
const STAKE_AMOUNT_RAW = process.env.STAKE_AMOUNT_RAW ? BigInt(process.env.STAKE_AMOUNT_RAW) : null;

// [MODIFIKASI 1]: Gabungkan PRIVATE_KEY dari auto.mjs
const SUI_PK_RAW     = process.env.PRIVATE_KEY || process.env.SUI_PRIVATE_KEY || '';
const SUI_KEY_SCHEME = String(process.env.SUI_KEY_SCHEME || 'ed25519').toLowerCase();

const log = {
  info:  (...a) => console.log('[info]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

function parsePrivKey(raw) {
  // [MODIFIKASI 2]: Pesan error yang lebih jelas
  if (!raw) throw new Error('PRIVATE_KEY atau SUI_PRIVATE_KEY kosong di environment.');
  
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

function fmtAmount(raw, decimals = 9) {
  try { return (Number(raw) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: decimals }); }
  catch { return String(raw); }
}

const sui = new SuiClient({ url: FULLNODE });

async function resolveDecimals(coinType) {
  if (!coinType) return 9;
  const meta = await sui.getCoinMetadata({ coinType }).catch(() => null);
  return meta?.decimals ?? 9;
}

async function getOneOwnedCoinOfType(owner, coinType) {
  const res = await sui.getCoins({ owner, coinType, limit: 50 }).catch(() => null);
  if (!res?.data?.length) return null;
  // sort by balance desc — gunakan comparator yang mengembalikan number (-1/0/1), bukan BigInt
  const sorted = [...res.data].sort((a, b) => {
    const A = BigInt(a.balance), B = BigInt(b.balance);
    if (A === B) return 0;
    return A < B ? 1 : -1; // desc
  });
  return sorted[0];
}

async function ensureSharedObjectExists(objectId) {
  const r = await sui.multiGetObjects({
    ids: [objectId],
    options: { showOwner: true, showType: true },
  });
  const o = r?.[0];
  if (!o?.data) throw new Error(`Shared object NOT FOUND: ${objectId}`);
  return o;
}

// === kompat helper: sign + execute di berbagai versi SDK ===
async function execTxCompat({ sui, kp, tx, options }) {
  if (typeof sui.signAndExecuteTransaction === 'function') {
    return await sui.signAndExecuteTransaction({
      signer: kp,
      transaction: tx,
      options,
      requestType: 'WaitForLocalExecution',
    });
  }
  const bytes = await tx.build({ client: sui });

  if (typeof kp.signTransactionBlock === 'function') {
    const { signature } = await kp.signTransactionBlock(bytes);
    return await sui.executeTransactionBlock({
      transactionBlock: bytes,
      signature,
      options,
      requestType: 'WaitForLocalExecution',
    });
  }
  if (typeof kp.signTransaction === 'function') {
    const { signature } = await kp.signTransaction(bytes);
    return await sui.executeTransactionBlock({
      transactionBlock: bytes,
      signature,
      options,
      requestType: 'WaitForLocalExecution',
    });
  }
  if (typeof kp.signData === 'function') {
    const { signature } = await kp.signData(bytes);
    return await sui.executeTransactionBlock({
      transactionBlock: bytes,
      signature,
      options,
      requestType: 'WaitForLocalExecution',
    });
  }
  throw new Error('Tidak ditemukan metode penandatanganan yang kompatibel pada keypair/SuiClient.');
}

(async () => {
  // Cek SUI_PK_RAW di sini sebelum parsing untuk menampilkan error yang lebih baik jika kosong
  if (!SUI_PK_RAW) {
        throw new Error('FATAL: PRIVATE_KEY tidak ditemukan di environment. Skrip ini harus dijalankan oleh auto.mjs.');
    }
    
  const { kp } = parsePrivKey(SUI_PK_RAW);
  const address = kp.getPublicKey().toSuiAddress();

  if (!STAKE_MANAGER_ID) throw new Error('STAKE_MANAGER_ID kosong di .env');
  if (!XAUM_COIN_TYPE)   throw new Error('XAUM_COIN_TYPE kosong di .env');

  const dec = await resolveDecimals(XAUM_COIN_TYPE);
  const amountRaw = STAKE_AMOUNT_RAW ?? BigInt(Math.round((STAKE_AMOUNT || 1) * 10 ** dec));

  log.info('== STAKE XAUM ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Address  :', address);
  log.info('Manager  :', STAKE_MANAGER_ID);
  log.info('XAUM     :', XAUM_COIN_TYPE, 'dec=', dec);
  log.info('Amount   :', amountRaw.toString(), `(~ ${fmtAmount(amountRaw.toString(), dec)} XAUM)`);

  // cek manager exists
  const mgr = await ensureSharedObjectExists(STAKE_MANAGER_ID);
  const ownerStr = mgr?.data?.owner?.Shared
    ? `Shared(initial_shared_version=${mgr.data.owner.Shared.initial_shared_version})`
    : JSON.stringify(mgr?.data?.owner);
  log.info('manager object exists:', STAKE_MANAGER_ID);
  log.info('  owner :', ownerStr);

  // ambil coin untuk stake
  const src = await getOneOwnedCoinOfType(address, XAUM_COIN_TYPE);
  if (!src) throw new Error('Tidak ada XAUM coin di wallet.');
  const bal = BigInt(src.balance);
  if (bal < amountRaw) throw new Error(`Saldo XAUM kurang. Punya ${fmtAmount(bal, dec)} butuh ${fmtAmount(amountRaw, dec)}.`);

  // build tx
  const tx = new Transaction();
  tx.setSender(address);
  if (Number.isFinite(GAS_BUDGET)) tx.setGasBudget(GAS_BUDGET);
  if (Number.isFinite(GAS_PRICE))  tx.setGasPrice(GAS_PRICE);

  // siapkan coin input dengan jumlah tepat
  let coinForStake;
  if (bal === amountRaw) {
    coinForStake = tx.object(src.coinObjectId);
  } else {
    const [splitCoin] = tx.splitCoins(tx.object(src.coinObjectId), [tx.pure.u64(amountRaw.toString())]);
    coinForStake = splitCoin;
  }

  // call stake_xaum(manager_shared, Coin<XAUM>)
  tx.moveCall({
    target: `${process.env.STAKING_PACKAGE || '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a'}::staking_manager::stake_xaum`,
    arguments: [
      tx.object(STAKE_MANAGER_ID),
      coinForStake,
    ],
  });

  // dry run (debug)
  const dryBytes = await tx.build({ client: sui });
  const dry = await sui.dryRunTransactionBlock({ transactionBlock: dryBytes }).catch(() => null);
  log.info('[stake] dryRun status:', dry?.effects?.status?.status, dry?.effects?.status?.error || '');

  // execute (kompat)
  const options = { showEffects: true, showEvents: true, showBalanceChanges: true, showObjectChanges: true };
  const exec = await execTxCompat({ sui, kp, tx, options });

  const digest = exec.digest ?? exec.transactionDigest;
  const effSt  = exec.effects?.status?.status;
  const effErr = exec.effects?.status?.error;
  log.info('[stake] execute digest:', digest);
  log.info('[stake] execute status:', effSt, effErr || '');

  const events = exec.events || [];
  if (events.length) {
    log.info('[stake] events:');
    for (const ev of events) log.info('  -', ev.type, ev.parsedJson ? JSON.stringify(ev.parsedJson) : '');
  } else {
    log.info('[stake] events: (none)');
  }
})().catch(e => {
  log.error('FATAL:', e.message);
  process.exit(1);
});
