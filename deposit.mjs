#!/usr/bin/env node
// deposit.mjs — Deposit GR Collateral (percent / amount / ladder)
// Patched: accept SUI_PRIVATE_KEY / PRIVATE_KEY / PRIVATE_KEY_HEX and SUI_FULLNODE / FULLNODE_URL.
// Supports ed25519 & secp256k1, various key encodings, and both new/old Sui SDK execute APIs.

// [WAJIB] Dihapus/komentar agar tidak menimpa PRIVATE_KEY dari auto.mjs
// import 'dotenv/config'; 

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';

// ---------- LOG ----------
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const log = {
  info:  (...a) => console.log('[info]', ...a),
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
};

// ---------- ENV ----------
const FULLNODE =
  process.env.SUI_FULLNODE ||
  process.env.FULLNODE_URL ||
  getFullnodeUrl('testnet');

// Skrip ini sudah benar karena mencari PRIVATE_KEY yang dikirim auto.mjs
const RAW_PK =
  String(process.env.SUI_PRIVATE_KEY || process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_HEX || '').trim();

const SENDER_OVERRIDE = (process.env.SUI_ADDRESS || '').toLowerCase();

const VERSION_ID = process.env.VERSION_ID || '0x13f4679d0ebd6fc721875af14ee380f45cde02f81d690809ac543901d66f6758';
const MARKET_ID  = process.env.MARKET_ID  || '0x166dd68901d2cb47b55c7cfbb7182316f84114f9e12da9251fd4c4f338e37f5d';
const GR_TYPE    = process.env.GR_TYPE    || '0x5504354cf3dcbaf64201989bc734e97c1d89bba5c7f01ff2704c43192cc2717c::coin_gr::COIN_GR';

const GAS_BUDGET = BigInt(process.env.GAS_BUDGET || '100000000');   // 0.1 SUI (dec=9)
const DUST       = BigInt(process.env.DUST || '1000000');           // 0.001
const MIN_DEPOSIT= BigInt(process.env.MIN_DEPOSIT || '1000000000'); // 1.0

const MODE = (process.env.DEPOSIT_MODE || 'percent').toLowerCase(); // 'percent'|'amount'|'ladder'
const PERCENT = Number(process.env.DEPOSIT_PERCENT || '50');        // 1..99
const AMOUNT_ABS = BigInt(process.env.DEPOSIT_AMOUNT || '0');       // if MODE=amount
const LADDER = (process.env.LADDER_AMOUNTS || '10000000000,5000000000,2000000000,1000000000')
  .split(',').map(s => s.trim()).filter(Boolean).map(s => BigInt(s));

const MAX_RETRY = Number(process.env.DEPOSIT_RETRY || '4');
const BACKOFF_MS = Number(process.env.DEPOSIT_BACKOFF_MS || '1500');

// ---------- HELPERS ----------
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Universal key parser (supports suiprivkey:, ed25519:, secp256k1:, 0x-hex, base64)
function parsePrivKey(raw, schemeFromEnv = String(process.env.SUI_KEY_SCHEME || '').toLowerCase()) {
  if (!raw) throw new Error('SUI_PRIVATE_KEY / PRIVATE_KEY kosong.');

  // sui-format or prefixed format
  if (raw.startsWith('suiprivkey') || raw.startsWith('ed25519:') || raw.startsWith('secp256k1:')) {
    const { schema, secretKey } = decodeSuiPrivateKey(raw);
    const s = String(schema).toLowerCase();
    if (s === 'ed25519')   return { kp: Ed25519Keypair.fromSecretKey(secretKey),  scheme: 'ed25519' };
    if (s === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(secretKey), scheme: 'secp256k1' };
    throw new Error(`Skema kunci tidak didukung: ${schema}`);
  }

  // raw hex or base64 seed
  let bytes;
  if (raw.startsWith('0x')) bytes = fromHex(raw);
  else                      bytes = Buffer.from(raw, 'base64');

  // Beberapa export menambahkan 0x00 prefix (33 bytes)
  if (bytes.length === 33) bytes = bytes.subarray(1);
  if (bytes.length !== 32) throw new Error(`Seed harus 32 byte, dapat ${bytes.length} byte`);

  if (schemeFromEnv === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(bytes), scheme: 'secp256k1' };
  return { kp: Ed25519Keypair.fromSeed(bytes), scheme: 'ed25519' };
}

async function getLargestCoinObj(client, owner, coinType) {
  let cursor = null, largest = null;
  do {
    const { data, nextCursor, hasNextPage } = await client.getCoins({ owner, coinType, cursor });
    for (const c of data) if (!largest || BigInt(c.balance) > BigInt(largest.balance)) largest = c;
    cursor = nextCursor;
    if (!hasNextPage) break;
  } while (true);
  return largest;
}

async function getTotalBalance(client, owner, coinType) {
  const r = await client.getBalance({ owner, coinType });
  return BigInt(r.totalBalance || '0');
}

function pickAmount(balance) {
  const maxSpendable = balance > DUST ? (balance - DUST) : balance;
  if (maxSpendable < MIN_DEPOSIT) throw new Error(`Saldo GR terlalu kecil: ${balance} < MIN_DEPOSIT(${MIN_DEPOSIT}).`);
  if (MODE === 'amount') {
    if (AMOUNT_ABS <= 0n) throw new Error('MODE=amount tapi DEPOSIT_AMOUNT tidak valid.');
    let a = AMOUNT_ABS;
    if (a > maxSpendable) a = maxSpendable;
    if (a < MIN_DEPOSIT) throw new Error(`Amount < MIN_DEPOSIT (${a} < ${MIN_DEPOSIT}).`);
    return a;
  }
  if (MODE === 'percent') {
    let pct = Math.max(1, Math.min(99, Math.floor(PERCENT)));
    let a = (maxSpendable * BigInt(pct)) / 100n;
    if (a < MIN_DEPOSIT) a = MIN_DEPOSIT;
    if (a > maxSpendable) a = maxSpendable;
    return a;
  }
  // ladder
  for (const x of LADDER) if (x >= MIN_DEPOSIT && x <= maxSpendable) return x;
  return maxSpendable;
}

async function checkShared(client, id) {
  const o = await client.getObject({ id, options: { showOwner: true }});
  const d = o.data;
  if (!d) throw new Error(`Object ${id} tidak ditemukan.`);
  const owner = d.owner;
  if (!owner || !('Shared' in owner)) log.warn(`[warn] ${id} bukan shared object. owner=`, owner);
  return d.reference?.digest || d.digest;
}

async function execTxCompat(sui, kp, tx) {
  const built = await tx.build({ client: sui, onlyTransactionKind: false });
  // Dry run (opsional tapi informatif)
  const sim = await sui.dryRunTransactionBlock({ transactionBlock: built });
  if (sim.effects?.status?.status !== 'success') {
    log.warn('[warn] dryRun status != success', JSON.stringify(sim.effects?.status || {}));
  } else {
    log.info('[info] dryRun status: success'); // [PERBAIKAN] Menghapus karakter '_'
  }

  const opt = { showEffects: true, showEvents: true, showBalanceChanges: true };
  if (typeof sui.signAndExecuteTransactionBlock === 'function') {
    return await sui.signAndExecuteTransactionBlock({ signer: kp, transactionBlock: tx, options: opt, requestType: 'WaitForLocalExecution' });
  }
  if (typeof sui.signAndExecuteTransaction === 'function') {
    return await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: opt, requestType: 'WaitForLocalExecution' });
  }
  if (typeof kp.signTransactionBlock === 'function' && typeof sui.executeTransactionBlock === 'function') {
    const sig = await kp.signTransactionBlock({ transactionBlock: built });
    return await sui.executeTransactionBlock({ transactionBlock: built, signature: sig.signature, options: opt, requestType: 'WaitForLocalExecution' });
  }
  throw new Error('Tidak menemukan method eksekusi Sui SDK yang cocok');
}

// ---------- MAIN ----------
(async () => {
  // Cek jika RAW_PK kosong (penting)
  if (!RAW_PK) {
    throw new Error('FATAL: PRIVATE_KEY tidak ditemukan di environment. Skrip ini harus dijalankan oleh auto.mjs.');
  }

  const { kp, scheme } = parsePrivKey(RAW_PK);
  const client = new SuiClient({ url: FULLNODE });
  const sender = SENDER_OVERRIDE || kp.getPublicKey().toSuiAddress();

  log.info('== DEPOSIT GR COLLATERAL ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Key type :', scheme);
  log.info('Address  :', sender);
  log.info('Version  :', VERSION_ID);
  log.info('Market   :', MARKET_ID);
  log.info('Type     :', GR_TYPE);
  if (MODE === 'percent') log.info('Mode     : percent =', PERCENT + '%');
  if (MODE === 'amount')  log.info('Mode     : amount  =', AMOUNT_ABS.toString());
  if (MODE === 'ladder')  log.info('Mode     : ladder  =', LADDER.map(x=>x.toString()).join(', '));

  await checkShared(client, VERSION_ID).catch(()=>{});
  await checkShared(client, MARKET_ID).catch(()=>{});

  const total = await getTotalBalance(client, sender, GR_TYPE);
  log.info('GR total :', total.toString());
  if (total <= DUST) throw new Error('Saldo GR kosong/terlalu kecil.');

  let want = pickAmount(total);
  log.info('Target   :', want.toString());

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    log.info(`-- attempt ${attempt}/${MAX_RETRY} amount=${want.toString()}`);

    const biggest = await getLargestCoinObj(client, sender, GR_TYPE);
    if (!biggest) throw new Error('Tidak menemukan coin GR.');
    const bal = BigInt(biggest.balance);
    if (bal <= DUST) throw new Error(`Saldo GR pada object terbesar sangat kecil: ${bal}`);

    let amount = want;
    const spendCap = bal > DUST ? (bal - DUST) : bal;
    if (amount > spendCap) {
      amount = spendCap;
      log.warn('[warn] amount > coinObj balance. pakai amount=', amount.toString());
    }
    if (amount < MIN_DEPOSIT) throw new Error(`Amount efektif < MIN_DEPOSIT (${amount} < ${MIN_DEPOSIT}).`);

    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasBudget(Number(GAS_BUDGET));

    const version = tx.object(VERSION_ID);
    const market  = tx.object(MARKET_ID);
    const grCoin  = tx.object(biggest.coinObjectId); // [PERBAIKAN] Menghapus karakter '_'

    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::open_obligation::open_obligation',
      arguments: [version],
    });

    const [grSplit] = tx.splitCoins(grCoin, [tx.pure.u64(amount)]);

    tx.moveCall({
      target: '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::deposit_collateral::deposit_collateral',
      typeArguments: [GR_TYPE],
      arguments: [version, obligation, market, grSplit],
    });

    tx.transferObjects([obligationKey], tx.pure.address(sender));

    tx.moveCall({ // [PERBAIKAN] Mengubah t_x menjadi tx
      target: '0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::open_obligation::return_obligation',
      arguments: [version, obligation, hotPotato],
    });

    try {
      const res = await execTxCompat(client, kp, tx);

      const status = res.effects?.status?.status;
      const digest = res.digest || res.effects?.transactionDigest;
      log.info('[info] execute digest:', digest);
      log.info('[info] execute status:', status);

      if (status === 'success') {
        const evts = res.events || [];
        if (evts.length) {
         log.info('[info] events:');
          for (const e of evts) log.info('  -', e.type, e.parsedJson || e);
        }
        // Sukses, biarkan skrip berakhir secara normal (exit code 0)
        return; 
      }

      const abort =
        res.effects?.status?.error ||
        res.effects?.abortError ||
        '';
      const msgStr = typeof abort === 'string' ? abort : JSON.stringify(abort);

      if (msgStr.includes('1793')) {
        log.warn('[warn] Market penuh (1793). Turunkan amount & retry…');
        let next = amount / 2n;
        if (next < MIN_DEPOSIT) next = MIN_DEPOSIT;
        want = next;
        await sleep(BACKOFF_MS);
        continue;
      }

      throw new Error(msgStr || 'Tx gagal tanpa detail.');

    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes('1793')) {
        log.warn('[warn] Market penuh (1793). Turunkan amount & retry…');
        let next = amount / 2n;
        if (next < MIN_DEPOSIT) next = MIN_DEPOSIT;
        want = next;
        await sleep(BACKOFF_MS);
        continue;
      }
      log.error('FATAL:', msg);
      // Gagal, keluar dengan kode 1 agar auto.mjs tahu
      process.exit(1);
    }
  }

  log.error(`FATAL: Gagal deposit setelah ${MAX_RETRY} attempt.`);
  // Gagal, keluar dengan kode 1 agar auto.mjs tahu
  process.exit(1);
})().catch(e => {
  log.error('FATAL:', e.message);
  // Gagal, keluar dengan kode 1 agar auto.mjs tahu
  process.exit(1);
});
