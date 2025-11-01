#!/usr/bin/env node
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

// ===== env =====
const FULLNODE = process.env.SUI_FULLNODE || getFullnodeUrl('testnet');
const MODE     = (process.env.SWAP_MODE || 'execute').toLowerCase();  // execute|dryrun
const LOG_LEVEL= String(process.env.LOG_LEVEL || 'info').toLowerCase();

const USDC_TYPE = process.env.USDC_COIN_TYPE || '';
const VAULT_ID  = process.env.VAULT_ID || '';
const MARKET_ID = process.env.MARKET_ID || '';
const CLOCK_ID  = process.env.CLOCK_ID || '0x6';

const AMOUNT_RAW_ENV = process.env.SWAP_USDC_AMOUNT_RAW;
const AMOUNT_DEC_ENV = process.env.SWAP_USDC_AMOUNT; // desimal USDC
const SWAP_DELAY_MS  = Number(process.env.SWAP_DELAY_MS || 0);

// ===== log =====
const log = {
  info:  (...a) => console.log('[info]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

// ===== key parse =====
function parsePrivKey(raw, schemeFromEnv) {
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
  if (schemeFromEnv === 'secp256k1') return { kp: Secp256k1Keypair.fromSecretKey(bytes), scheme: 'secp256k1' };
  return { kp: Ed25519Keypair.fromSeed(bytes), scheme: 'ed25519' };
}

const { kp, scheme } = parsePrivKey(process.env.SUI_PRIVATE_KEY || '', String(process.env.SUI_KEY_SCHEME || 'ed25519').toLowerCase());
const sui = new SuiClient({ url: FULLNODE });
const address = kp.getPublicKey().toSuiAddress();

// ===== creek helpers (delta poin/badge) =====
const CREEK_API_BASE = process.env.CREEK_API_BASE || 'https://api-test.creek.finance';
async function creekFetch(path) {
  const res = await fetch(`${CREEK_API_BASE}${path}`, {
    headers: {
      accept: '*/*',
      'content-type':'application/json',
      'x-request-id': `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} creek ${path}`);
  return await res.json();
}
async function creekInfo() { return creekFetch(`/api/user/info/${address}`);}
function parseUserInfo(json){ const u=json?.data?.user||{}; return { pts:Number(u.total_points??0) }; }
function parseBadges(json){ return (json?.data?.badges||[]).map(b=>({key:b.badge_key,cur:Number(b.current_count??0),req:Number(b.required_count??0),done:!!b.is_completed,name:b.badge_name})); }
function diffPts(a,b){ if(!a||!b) return null; return (b.pts - a.pts); }
function badgeDelta(before, after, keyLike='swap_usdc_gusd'){ // cari badge swap
  const b = (before||[]).find(x=>x.key.includes(keyLike));
  const a = (after||[]).find(x=>x.key.includes(keyLike));
  if (!a) return null;
  return { name:a.name, cur:a.cur, req:a.req, done:a.done, prev: b?b.cur:0 };
}

// ===== utils =====
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function resolveDecimals(coinType) {
  if (!coinType) return 9;
  const meta = await sui.getCoinMetadata({ coinType }).catch(()=>null);
  return meta?.decimals ?? 9;
}
function fmtAmount(raw, decimals=9){
  try { return (Number(raw)/10**decimals).toLocaleString('en-US',{maximumFractionDigits:decimals}); }
  catch { return String(raw); }
}

async function pickUsableUsdc(amountRaw) {
  // cari coin<USDC> owned yang >= amountRaw
  const coins = await sui.getCoins({ owner: address, coinType: USDC_TYPE });
  const arr = coins.data || [];
  // sort desc balance
  arr.sort((a,b)=> Number(b.balance) - Number(a.balance));
  const enough = arr.find(c => BigInt(c.balance) >= amountRaw);
  if (enough) return enough;
  if (!arr.length) throw new Error('Tidak ada coin USDC');
  // kalau tidak ada yang cukup, gabungkan (merge) semua ke satu, tapi lebih rumit.
  // Sederhana: pakai coin terbesar + akan mint sesuai balance yang tersedia.
  return arr[0];
}

async function execTxWithFallback(tx) {
  // DRY RUN
  const txBytes = await tx.build({ client: sui });
  const dry = await sui.dryRunTransactionBlock({ transactionBlock: txBytes });
  const st  = dry.effects?.status?.status;
  const err = dry.effects?.status?.error;
  log.info('[swap] dryRun status:', st, err || '');
  if (MODE === 'dryrun') return { dryRunOnly: true, dry };

  if (st !== 'success') throw new Error(`dryRun fail: ${err || st}`);

  // EXECUTE + fallback API names
  const opt = { showEffects: true, showEvents: true, showObjectChanges: true, showBalanceChanges: true };
  // Try new API
  if (typeof sui.signAndExecuteTransactionBlock === 'function') {
    return await sui.signAndExecuteTransactionBlock({ signer: kp, transactionBlock: tx, options: opt });
  }
  // Try old API
  if (typeof sui.signAndExecuteTransaction === 'function') {
    return await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: opt });
  }
  // Last resort: build+sign+execute (rare)
  if (typeof kp.signTransactionBlock === 'function' && typeof sui.executeTransactionBlock === 'function') {
    const built = await tx.build({ client: sui });
    const sig   = await kp.signTransactionBlock({ transactionBlock: built });
    return await sui.executeTransactionBlock({ transactionBlock: built, signature: sig.signature, options: opt });
  }
  throw new Error('Tidak menemukan method eksekusi Sui SDK yang cocok');
}

async function run() {
  log.info('== SWAP USDC -> GUSD (vault) ==');
  log.info('Fullnode :', FULLNODE);
  log.info('Key type :', scheme);
  log.info('Address  :', address);
  log.info('Mode     :', MODE);

  if (!USDC_TYPE || !VAULT_ID || !MARKET_ID) {
    throw new Error('USDC_COIN_TYPE / VAULT_ID / MARKET_ID belum di .env');
  }

  const usdcDec = await resolveDecimals(USDC_TYPE);
  const amountRaw = AMOUNT_RAW_ENV ? BigInt(AMOUNT_RAW_ENV)
                   : BigInt(Math.round(Number(AMOUNT_DEC_ENV || 10) * 10**usdcDec));

  log.info('USDC type  :', USDC_TYPE);
  log.info('VAULT      :', VAULT_ID);
  log.info('MARKET     :', MARKET_ID);
  log.info('CLOCK      :', CLOCK_ID);
  log.info('Amount     :', amountRaw.toString(), `(~ ${fmtAmount(amountRaw, usdcDec)} USDC)`);

  // Creek snapshot (sebelum)
  let creekBefore = null, badgesBefore = null;
  try { const info = await creekInfo(); creekBefore = parseUserInfo(info); badgesBefore = parseBadges(info); } catch {}

  const coin = await pickUsableUsdc(amountRaw);
  log.info('USDC input :', coin.coinObjectId, 'bal=', fmtAmount(coin.balance, usdcDec));

  if (SWAP_DELAY_MS) { log.info(`delay ${SWAP_DELAY_MS}ms sebelum tx...`); await sleep(SWAP_DELAY_MS); }

  const buildTx = async () => {
    const tx = new Transaction();
    tx.setSender(address);
    // siapkan coin<USDC> sesuai amount
    let coinArg;
    if (BigInt(coin.balance) === amountRaw) {
      coinArg = tx.object(coin.coinObjectId);
    } else if (BigInt(coin.balance) > amountRaw) {
      const split = tx.splitCoins(tx.object(coin.coinObjectId), [tx.pure.u64(amountRaw.toString())]);
      coinArg = split; // result coin dengan amount pas
    } else {
      throw new Error('Saldo USDC kurang dari amount yang diminta');
    }

    // call: gusd_usdc_vault::mint_gusd(&mut USDCVault, &mut Market, Coin<USDC>, &Clock, &mut TxContext)
    tx.moveCall({
      target: `0x8cee41afab63e559bc236338bfd7c6b2af07c9f28f285fc8246666a7ce9ae97a::gusd_usdc_vault::mint_gusd`,
      arguments: [
        tx.object(VAULT_ID),    // &mut USDCVault (shared)
        tx.object(MARKET_ID),   // &mut Market (shared)
        coinArg,                // Coin<USDC>
        tx.object(CLOCK_ID),    // &Clock (shared)
      ],
    });

    return tx;
  };

  // eksekusi + retry kalau versi objek berubah
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const tx = await buildTx();
      const exec = await execTxWithFallback(tx);
      if (exec?.dryRunOnly) {
        log.info('[swap] [MODE=dryrun] stop di sini.');
        return;
      }
      const digest = exec.digest ?? exec.transactionDigest;
      const effSt  = exec.effects?.status?.status;
      const effErr = exec.effects?.status?.error;
      log.info('[swap] execute digest:', digest);
      log.info('[swap] execute status:', effSt, effErr || '');

      if (exec.events?.length) {
        log.info('[swap] events:');
        for (const ev of exec.events) {
          log.info('  -', ev.type, ev.parsedJson ? JSON.stringify(ev.parsedJson) : '');
        }
      } else log.info('[swap] events: (none)');

      if (exec.balanceChanges?.length) {
        const bc = exec.balanceChanges.filter(x => x.owner?.AddressOwner?.toLowerCase?.() === address.toLowerCase());
        for (const x of bc) log.info('  balanceChange:', x.coinType, x.amount);
      }

      // Creek after
      try {
        const after = await creekInfo();
        const ptsBefore = creekBefore?.pts ?? null;
        const ptsAfter  = parseUserInfo(after).pts;
        const deltaPts  = (ptsBefore!=null) ? (ptsAfter - ptsBefore) : null;
        const bd = badgeDelta(badgesBefore, parseBadges(after), 'swap_usdc_gusd');
        const deltaStr = (deltaPts!=null && deltaPts!==0) ? ` (+${deltaPts} pts)` : '';
        log.info(`[swap] Creek total_points: ${ptsAfter}${deltaStr}`);
        if (bd) {
          const tick = bd.done && bd.cur>bd.prev ? ' ✅ completed' : '';
          log.info(`[swap] Badge ${bd.name}: ${bd.prev} → ${bd.cur}/${bd.req}${tick}`);
        }
      } catch (e) {
        log.warn('[swap] gagal cek Creek after:', e.message);
      }

      if (SWAP_DELAY_MS) { log.info(`delay ${SWAP_DELAY_MS}ms setelah tx...`); await sleep(SWAP_DELAY_MS); }
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (attempt <= 3 && /not available for consumption|object .* current version/i.test(msg)) {
        log.warn(`[swap] retry #${attempt} karena versi objek berubah...`);
        await sleep(800);
        continue;
      }
      throw e;
    }
  }
}

run().catch(e => {
  log.error('FATAL:', e.message);
  process.exit(1);
});
