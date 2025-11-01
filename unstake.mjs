// unstake.mjs — Unstake via staking_manager::unstake (robust: retry + aggregate + merge/split)
// Deps: npm i @mysten/sui dotenv
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const FULLNODE = process.env.SUI_FULLNODE || getFullnodeUrl('testnet');
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const GAS_BUDGET = process.env.GAS_BUDGET ? Number(process.env.GAS_BUDGET) : undefined;
const GAS_PRICE  = process.env.GAS_PRICE  ? Number(process.env.GAS_PRICE)  : undefined;

// staking params
const STAKE_MANAGER_ID = (process.env.STAKE_MANAGER_ID || '').trim(); // shared object id
const GR_COIN_TYPE = (process.env.GR_COIN_TYPE || '').trim(); // e.g. 0x...::gr::GR
const GY_COIN_TYPE = (process.env.GY_COIN_TYPE || '').trim(); // e.g. 0x...::gy::GY
const UNSTAKE_PERCENT = process.env.UNSTAKE_PERCENT ? Number(process.env.UNSTAKE_PERCENT) : 50;

// robustness params
const FIND_RETRIES = process.env.UNSTAKE_FIND_RETRIES ? Number(process.env.UNSTAKE_FIND_RETRIES) : 6;
const FIND_DELAY_MS = process.env.UNSTAKE_FIND_DELAY_MS ? Number(process.env.UNSTAKE_FIND_DELAY_MS) : 1500;

const SUI_PK_RAW     = process.env.SUI_PRIVATE_KEY || '';
const SUI_KEY_SCHEME = String(process.env.SUI_KEY_SCHEME || 'ed25519').toLowerCase();

const log = {
  info:  (...a) => console.log('[info]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function parsePrivKey(raw) {
  if (!raw) throw new Error('SUI_PRIVATE_KEY kosong di .env');
  if (raw.startsWith('suiprivkey') || raw.startsWith('ed25519:') || raw.startsWith('secp256k1:')) {
    const { schema, secretKey } = decodeSuiPrivateKey(raw);
    const s = String(schema).toLowerCase();
    if (s === 'ed25519')   return { kp: Ed25519Keypair.fromSecretKey(secretKey),  scheme: 'ed25519' };
    if (s === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(secretKey), scheme: 'secp256k1' };
    throw new Error(`Skema kunci tidak didukung: ${schema}`);
  }
  let bytes;
  if (raw.startsWith('0x')) bytes = Buffer.from(raw.slice(2), 'hex');
  else                      bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 33) bytes = bytes.subarray(1);
  if (bytes.length !== 32) throw new Error(`Seed harus 32 byte, dapat ${bytes.length} byte`);
  if (SUI_KEY_SCHEME === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(bytes), scheme: 'secp256k1' };
  return { kp: Ed25519Keypair.fromSeed(bytes), scheme: 'ed25519' };
}

const sui = new SuiClient({ url: FULLNODE });

async function ensureSharedObjectExists(objectId) {
  const r = await sui.multiGetObjects({
    ids: [objectId],
    options: { showOwner: true, showType: true },
  });
  const o = r?.[0];
  if (!o?.data) throw new Error(`Shared object NOT FOUND: ${objectId}`);
  return o;
}

async function listCoins(owner, coinType) {
  const out = [];
  let cursor = null;
  do {
    const r = await sui.getCoins({ owner, coinType, cursor, limit: 50 }).catch(() => null);
    if (!r) break;
    out.push(...(r.data || []));
    cursor = r.nextCursor;
  } while (cursor && out.length < 500);
  return out;
}

function sumBigInt(coins) {
  return coins.reduce((acc, c) => acc + BigInt(c.balance), 0n);
}

// retry sampai GR & GY terdeteksi/sum > 0
async function findGrGyWithRetry(owner) {
  for (let i = 0; i < FIND_RETRIES; i++) {
    const gr = await listCoins(owner, GR_COIN_TYPE);
    const gy = await listCoins(owner, GY_COIN_TYPE);
    const grSum = sumBigInt(gr);
    const gySum = sumBigInt(gy);
    log.info(`[scan ${i+1}/${FIND_RETRIES}] GR coins=${gr.length} sum=${grSum} | GY coins=${gy.length} sum=${gySum}`);
    if (grSum > 0n && gySum > 0n) return { gr, gy, grSum, gySum };
    await sleep(FIND_DELAY_MS);
  }
  throw new Error('Tidak menemukan coin GR/GY untuk di-unstake setelah retry.');
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
  if (!STAKE_MANAGER_ID) throw new Error('STAKE_MANAGER_ID kosong di .env');
  if (!GR_COIN_TYPE || !GY_COIN_TYPE) throw new Error('GR_COIN_TYPE / GY_COIN_TYPE kosong di .env');

  const { kp } = parsePrivKey(SUI_PK_RAW);
  const address = kp.getPublicKey().toSuiAddress();

  log.info('== UNSTAKE ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Address  :', address);
  log.info('Manager  :', STAKE_MANAGER_ID);
  log.info('GR type  :', GR_COIN_TYPE);
  log.info('GY type  :', GY_COIN_TYPE);
  log.info('Percent  :', `${UNSTAKE_PERCENT}%`);

  // cek manager exists
  const mgr = await ensureSharedObjectExists(STAKE_MANAGER_ID);
  const ownerStr = mgr?.data?.owner?.Shared
    ? `Shared(initial_shared_version=${mgr.data.owner.Shared.initial_shared_version})`
    : JSON.stringify(mgr?.data?.owner);
  log.info('manager object exists:', STAKE_MANAGER_ID);
  log.info('  owner :', ownerStr);

  // cari GR/GY dengan retry (habis stake)
  const { gr, gy, grSum, gySum } = await findGrGyWithRetry(address);

  // burn = pct × min(totalGR, totalGY)
  let pct = Math.max(1, Math.min(100, Number.isFinite(UNSTAKE_PERCENT) ? UNSTAKE_PERCENT : 50));
  const minTotal = grSum < gySum ? grSum : gySum;
  let burn = (minTotal * BigInt(pct)) / 100n;
  if (burn === 0n) throw new Error('Perhitungan burn jadi 0 — cek saldo GR/GY.');

  // pilih primary coin id utk merge
  const grPrimary = gr[0].coinObjectId;
  const gyPrimary = gy[0].coinObjectId;
  const grOthers = gr.slice(1).map(c => c.coinObjectId);
  const gyOthers = gy.slice(1).map(c => c.coinObjectId);

  log.info('Totals   : GR=', grSum.toString(), ' GY=', gySum.toString());
  log.info('Primary  : GR=', grPrimary, ' GY=', gyPrimary);
  if (grOthers.length) log.info('Merge GR:', grOthers.length, 'coin(s)');
  if (gyOthers.length) log.info('Merge GY:', gyOthers.length, 'coin(s)');
  log.info('Burn amt :', burn.toString());

  const tx = new Transaction();
  tx.setSender(address);
  if (Number.isFinite(GAS_BUDGET)) tx.setGasBudget(GAS_BUDGET);
  if (Number.isFinite(GAS_PRICE))  tx.setGasPrice(GAS_PRICE);

  // merge agar nominal ada di satu objek, lalu split amount burn
  if (grOthers.length) tx.mergeCoins(tx.object(grPrimary), grOthers.map(id => tx.object(id)));
  if (gyOthers.length) tx.mergeCoins(tx.object(gyPrimary), gyOthers.map(id => tx.object(id)));

  const [grForBurn] = burn === grSum
    ? [tx.object(grPrimary)]
    : tx.splitCoins(tx.object(grPrimary), [tx.pure.u64(burn.toString())]);

  const [gyForBurn] = burn === gySum
    ? [tx.object(gyPrimary)]
    : tx.splitCoins(tx.object(gyPrimary), [tx.pure.u64(burn.toString())]);

  // call staking_manager::unstake(manager_shared, Coin<GR>, Coin<GY>)
  tx.moveCall({
    target: `${process.env.STAKING_PACKAGE || '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a'}::staking_manager::unstake`,
    arguments: [
      tx.object(STAKE_MANAGER_ID),
      grForBurn,
      gyForBurn,
    ],
  });

  // dry run (debug)
  const dryBytes = await tx.build({ client: sui });
  const dry = await sui.dryRunTransactionBlock({ transactionBlock: dryBytes }).catch(() => null);
  log.info('[unstake] dryRun status:', dry?.effects?.status?.status, dry?.effects?.status?.error || '');

  const options = { showEffects: true, showEvents: true, showBalanceChanges: true, showObjectChanges: true };
  const exec = await execTxCompat({ sui, kp, tx, options });

  const digest = exec.digest ?? exec.transactionDigest;
  const effSt  = exec.effects?.status?.status;
  const effErr = exec.effects?.status?.error;
  log.info('[unstake] execute digest:', digest);
  log.info('[unstake] execute status:', effSt, effErr || '');

  const events = exec.events || [];
  if (events.length) {
    log.info('[unstake] events:');
    for (const ev of events) log.info('  -', ev.type, ev.parsedJson ? JSON.stringify(ev.parsedJson) : '');
  } else {
    log.info('[unstake] events: (none)');
  }
})().catch(e => {
  log.error('FATAL:', e.message);
  process.exit(1);
});
