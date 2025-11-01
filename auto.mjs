#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const log = {
  info:  (...a) => console.log('[info]', ...a),
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  debug: (...a) => { if (LOG_LEVEL.includes('debug')) console.log('[debug]', ...a); },
};

const DEFAULT_PHASES = 'faucet,swap,stake,unstake,deposit,point';
const PHASES_CFG = (process.env.AUTO_PHASES || DEFAULT_PHASES)
  .split(',').map(s => s.trim()).filter(Boolean);

const CMDS = {
  faucet:  process.env.FAUCET_CMD  || 'node faucet.mjs',
  swap:    process.env.SWAP_CMD    || 'node swap.mjs',
  stake:   process.env.STAKE_CMD   || 'node stake.mjs',
  unstake: process.env.UNSTAKE_CMD || 'node unstake.mjs',
  deposit: process.env.DEPOSIT_CMD || 'node deposit.mjs',
  borrow:  process.env.BORROW_CMD  || 'node borrow.mjs',
  repay:   process.env.REPAY_CMD   || 'node repay.mjs',
  point:   process.env.POINT_CMD   || 'node point.mjs',
};

const POINT_CMD = process.env.POINT_CMD || 'node point.mjs';
const DETECT_FROM_POINTS = truthy(process.env.DETECT_FROM_POINTS ?? '1');

const DELAYS = {
  faucet:  num(process.env.DELAY_AFTER_FAUCET_MS, 3000),
  swap:    num(process.env.DELAY_AFTER_SWAP_MS,   2000),
  stake:   num(process.env.DELAY_AFTER_STAKE_MS,  1500),
  unstake: num(process.env.DELAY_AFTER_UNSTAKE_MS,1000),
  deposit: num(process.env.DELAY_AFTER_DEPOSIT_MS,1500),
  borrow:  num(process.env.DELAY_AFTER_BORROW_MS, 1500),
  repay:   num(process.env.DELAY_AFTER_REPAY_MS,  1500),
  point:   num(process.env.DELAY_AFTER_POINT_MS,  0),
};

const GLOBAL_SUCCESS_DELAY_MS = num(process.env.SUCCESS_DELAY_MS_GLOBAL, 5000);
function successDelayFor(ph){
  const envKey = `SUCCESS_DELAY_MS_${ph.toUpperCase()}`;
  return num(process.env[envKey], GLOBAL_SUCCESS_DELAY_MS);
}

const RETRY_GLOBAL_MAX    = int(process.env.RETRY_MAX, 1);
const RETRY_BACKOFF_MS    = int(process.env.RETRY_BACKOFF_MS, 3000);
const RETRY_BACKOFF_MODE  = String(process.env.RETRY_BACKOFF_MODE || 'linear');
const RETRY_BACKOFF_MULT  = num(process.env.RETRY_BACKOFF_MULT, 1.8);

const TIMEOUTS = {
  faucet:  int(process.env.TIMEOUT_FAUCET_MS,  0),
  swap:    int(process.env.TIMEOUT_SWAP_MS,    0),
  stake:   int(process.env.TIMEOUT_STAKE_MS,   0),
  unstake: int(process.env.TIMEOUT_UNSTAKE_MS, 0),
  deposit: int(process.env.TIMEOUT_DEPOSIT_MS, 0),
  borrow:  int(process.env.TIMEOUT_BORROW_MS,  0),
  repay:   int(process.env.TIMEOUT_REPAY_MS,   0),
  point:   int(process.env.TIMEOUT_POINT_MS,   0),
};

const STOP_ON_FAIL = truthy(process.env.STOP_ON_FAIL);

const PER_PHASE_RETRY = {};
for (const ph of Object.keys(CMDS)) {
  const key = `RETRY_PHASE_${ph}`;
  if (process.env[key] !== undefined) PER_PHASE_RETRY[ph] = int(process.env[key], RETRY_GLOBAL_MAX);
}

// ===== Utils =====
function num(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function int(v, d=0){ const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function truthy(v){ return ['1','true','yes','y','on'].includes(String(v||'').toLowerCase()); }
// === [MODIFIKASI KRITIS: Mengakomodasi PRIVATE_KEYS atau SUI_PRIVATE_KEY] ===
function getAllPrivateKeys(){
  // Cek SUI_PRIVATE_KEY jika PRIVATE_KEYS tidak ada (untuk kompatibilitas)
  const keysString = process.env.PRIVATE_KEYS || process.env.SUI_PRIVATE_KEY; 
  if (!keysString) return [];
  return keysString
    .split(',').map(key => key.trim()).filter(Boolean);
}

// === DAILY ENSURE ===
const DAILY_ENSURE_TX = truthy(process.env.DAILY_ENSURE_TX ?? '1');         
const DAILY_MIN_TX    = int(process.env.DAILY_MIN_TX, 1);            
const DAILY_PHASES    = (process.env.DAILY_PHASES || 'faucet,swap,stake,unstake,deposit')         
  .split(',').map(s=>s.trim()).filter(Boolean);
const STATE_FILE      = process.env.DAILY_STATE_FILE || path.join('.cache','auto-daily.json');

function ensureDir(p){ fs.mkdirSync(path.dirname(p), { recursive:true }); }
function todayJakarta(){
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }); 
  return s.slice(0,10); 
}
function loadState(){
  try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; }
}
function saveState(st){ ensureDir(STATE_FILE); fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }
function hasDailyDone(st, day, phase, addr='*'){
  return !!st?.[day]?.[addr]?.[phase];
}
function markDailyDone(st, day, phase, addr='*'){
  st[day] ??= {}; st[day][addr] ??= {}; st[day][addr][phase] = true; return st;
}

// === map badge key → phase ===
function mapKeyToPhase(keyLower){
  if (keyLower.includes('swap')) return 'swap';
  if (keyLower.includes('unstake') || keyLower.includes('redeem')) return 'unstake';
  if (keyLower.includes('stake')) return 'stake';
  if (keyLower.includes('deposit')) return 'deposit';
  if (keyLower.includes('mint')) return 'faucet';
  return null;
}

// === [MODIFIKASI: execCapture menerima envAdd] ===
async function execCapture(cmd, timeoutMs=0, envAdd={}){
  return new Promise((resolve, reject) => {
    const fullEnv = { ...process.env, ...envAdd };
    const p = spawn(cmd, { shell: true, env: fullEnv }); // Gunakan fullEnv
    let out = '', err = '';
    let killedByTimeout = false;
    let to = null;

    if (timeoutMs > 0) {
      to = setTimeout(() => {
        killedByTimeout = true;
        try { p.kill('SIGKILL'); } catch {}
      }, timeoutMs);
    }

    p.stdout.on('data', d => out += String(d));
    p.stderr.on('data', d => err += String(d));

    p.on('error', e => {
      if (to) clearTimeout(to);
      reject(e);
    });
    p.on('exit', code => {
      if (to) clearTimeout(to);
      if (killedByTimeout) return reject(new Error('timeout'));
      if (code === 0) return resolve(out || '');
      resolve(out || err || '');
    });
  });
}

// === [MODIFIKASI: runCmd menerima envAdd] ===
async function runCmd(cmd, timeoutMs=0, envAdd={}){
  return new Promise((resolve, reject) => {
    log.info('$', cmd);
    const fullEnv = { ...process.env, ...envAdd };
    const p = spawn(cmd, { 
        stdio: 'inherit', 
        shell: true,
        env: fullEnv // Gunakan fullEnv
    });

    let killedByTimeout = false;
    let to = null;
    if (timeoutMs > 0) {
      to = setTimeout(() => {
        killedByTimeout = true;
        log.warn(`Phase command timeout after ${timeoutMs}ms, killing...`);
        try { p.kill('SIGKILL'); } catch {}
      }, timeoutMs);
    }

    p.on('error', (err) => {
      if (to) clearTimeout(to);
      reject(err);
    });

    p.on('exit', (code) => {
      if (to) clearTimeout(to);
      if (killedByTimeout) return reject(new Error('timeout'));
      if (code === 0) return resolve();
      reject(new Error(`exit ${code}`));
    });
  });
}

// === [MODIFIKASI: runOneAttempt menerima privateKey] ===
async function runOneAttempt(ph, privateKey){ 
    // Teruskan PRIVATE_KEY sebagai environment variable ke child process
    return runCmd(CMDS[ph], TIMEOUTS[ph] || 0, { PRIVATE_KEY: privateKey }); 
}

// === [MODIFIKASI: runWithRetries menerima privateKey] ===
async function runWithRetries(ph, retryMax, privateKey){
  let attempt = 0;
  let errLast = null;
  let backoff = RETRY_BACKOFF_MS;

  while (attempt < Math.max(1, retryMax)) {
    attempt++;
    try {
      log.debug(`[${ph}] attempt ${attempt}/${Math.max(1, retryMax)}`);
      // Teruskan privateKey
      await runOneAttempt(ph, privateKey);
      return { ok: true, attempts: attempt, error: null };
    } catch (e) {
      errLast = e;
      log.warn(`[${ph}] attempt ${attempt} failed: ${e?.message || e}`);
      if (attempt >= Math.max(1, retryMax)) break;
      if (RETRY_BACKOFF_MODE === 'exponential') {
        await sleep(backoff);
        backoff = Math.ceil(backoff * (RETRY_BACKOFF_MULT > 1 ? RETRY_BACKOFF_MULT : 2));
      } else {
        await sleep(RETRY_BACKOFF_MS);
      }
      log.info(`[${ph}] retrying...`);
    }
  }
  return { ok: false, attempts: attempt, error: errLast };
}

// === [MODIFIKASI: detectTimesFromPoint menerima privateKey] ===
async function detectTimesFromPoint(privateKey){
  // Teruskan privateKey ke execCapture
  const out = await execCapture(POINT_CMD, TIMEOUTS.point || 0, { PRIVATE_KEY: privateKey });
  const lines = out.split(/\r?\n/);

  const timesMap = { faucet:0, swap:0, stake:0, unstake:0, deposit:0 };
  const progMap  = { faucet:0, swap:0, stake:0, unstake:0, deposit:0 };
  const needMap  = { faucet:0, swap:0, stake:0, unstake:0, deposit:0 };

  const re = /•\s+(.*?)\s+\[([^\]]+)\]\s+(\d+)\/(\d+)/i;

  for (const raw of lines) {
    const m = re.exec(raw);
    if (!m) continue;
    const key = m[2];
    const a = Number(m[3]);
    const b = Number(m[4]);
    const phase = mapKeyToPhase(String(key).toLowerCase());
    if (!phase) continue;
    progMap[phase] = Math.max(progMap[phase], a);
    needMap[phase] = Math.max(needMap[phase], b);
  }

  for (const ph of Object.keys(timesMap)) {
    const remaining = Math.max(0, (needMap[ph] || 0) - (progMap[ph] || 0));
    timesMap[ph] = remaining;
  }

  log.info('[detect] from point.mjs → remaining:', JSON.stringify(timesMap));
  return timesMap;
}

// === [MODIFIKASI: runPhase menerima privateKey] ===
async function runPhase(ph, repsTarget, successDelay, retryMax, privateKey){
  if (!CMDS[ph]) {
    log.warn(`skip unknown phase: ${ph}`);
    return { ok: true, tries: 0, repsSuccess: 0, repsTarget: 0, error: null };
  }
  if (repsTarget <= 0) {
    log.info(`=== PHASE: ${ph} — remaining 0 → skip ===`);
    return { ok: true, tries: 0, repsSuccess: 0, repsTarget, error: null };
  }

  log.info(`=== PHASE: ${ph} — target ${repsTarget}× (retry/rep=${Math.max(1, retryMax)}, successDelay=${successDelay}ms) ===`);

  let repsSuccess = 0;
  let repsTried = 0;
  let lastErr = null;

  while (repsSuccess < repsTarget) {
    repsTried++;
    log.info(`[${ph}] repetition ${repsSuccess + 1}/${repsTarget}`);

    // Teruskan privateKey
    const res = await runWithRetries(ph, retryMax, privateKey);
    if (res.ok) {
      repsSuccess++;
      if (repsSuccess < repsTarget && successDelay > 0) {
        log.info(`[${ph}] success. Delay ${successDelay}ms sebelum repetition berikutnya...`);
        await sleep(successDelay);
      }
    } else {
      lastErr = res.error;
      log.error(`[${ph}] repetition gagal setelah ${res.attempts} attempt.`);
      break;
    }
  }

  const phaseOk = repsSuccess === repsTarget;
  return { ok: phaseOk, tries: repsTried, repsSuccess, repsTarget, error: phaseOk ? null : lastErr };
}

// === [MODIFIKASI: Logika Utama dibungkus dengan loop Multi-Akun] ===
(async () => {
  const ALL_KEYS = getAllPrivateKeys();
  if (ALL_KEYS.length === 0) {
    log.error('FATAL: PRIVATE_KEYS not found or empty in .env');
    process.exit(1);
  }
  log.info(`Memulai auto runner untuk ${ALL_KEYS.length} akun...`);
  const ACCOUNT_DELAY_MS = num(process.env.ACCOUNT_DELAY_MS, 10000); // Jeda antar akun

  const allResults = [];
  let globalSuccess = true;

  // === START LOOP MULTI-AKUN ===
  for (let i = 0; i < ALL_KEYS.length; i++) {
    const privateKey = ALL_KEYS[i];
    // Gunakan 12 karakter pertama key sebagai ID unik untuk file state harian
    const ADDR_KEY = privateKey.slice(0, 12); 

    console.log('\n' + '='.repeat(60));
    log.info(`[AKUN ${i + 1}/${ALL_KEYS.length}] Memproses key: ${ADDR_KEY}...`);
    console.log('='.repeat(60));

    // 1) Deteksi remaining dari point.mjs (dengan private key akun saat ini)
    let timesDetected = null;
    if (DETECT_FROM_POINTS) {
      try { 
          // Teruskan privateKey
          timesDetected = await detectTimesFromPoint(privateKey); 
        }
      catch (e) { log.warn('[detect] gagal membaca point.mjs:', e?.message || e); timesDetected = null; }
    }

    // 2) Tentukan target repetitions per phase
    const targetTimes = {};
    const st = DAILY_ENSURE_TX ? loadState() : {};
    const today = todayJakarta();

    for (const ph of PHASES_CFG) {
      let t = 0;
      if (timesDetected && ph in timesDetected) {
        t = timesDetected[ph] || 0;
      } else {
        const envKey = `TIMES_${ph.toUpperCase()}`;
        t = int(process.env[envKey], 1);
      }

      // === DAILY ENSURE: pakai ADDR_KEY
      if (DAILY_ENSURE_TX && DAILY_PHASES.includes(ph) && !hasDailyDone(st, today, ph, ADDR_KEY)) {
        if (t < DAILY_MIN_TX) {
          log.info(`[daily] enforce: ${ph} set to at least ${DAILY_MIN_TX} for ${today}`);
          t = DAILY_MIN_TX;
        }
      }

      targetTimes[ph] = t;
    }

    log.info(`[${ADDR_KEY}] Auto runner — phases:`, PHASES_CFG.join(' -> '));
    log.info(`[${ADDR_KEY}] Target repetitions:`, JSON.stringify(targetTimes));

    const accountResults = [];

    // 3) Run tiap phase sesuai repsTarget
    for (const ph of PHASES_CFG) {
      const retryMax = PER_PHASE_RETRY[ph] ?? RETRY_GLOBAL_MAX;
      const successDelay = successDelayFor(ph);
      const repsTarget = targetTimes[ph] ?? 0;

      // Teruskan privateKey
      const res = await runPhase(ph, repsTarget, successDelay, retryMax, privateKey);
      accountResults.push({ phase: ph, ...res });

      // === DAILY ENSURE: pakai ADDR_KEY
      if (DAILY_ENSURE_TX && res.repsSuccess > 0 && DAILY_PHASES.includes(ph)) {
        markDailyDone(st, today, ph, ADDR_KEY);
        saveState(st);
        log.info(`[daily] marked done: ${ph} @ ${today} for ${ADDR_KEY}`);
      }

      if (!res.ok) {
        globalSuccess = false; // Tandai jika ada kegagalan
        log.warn(`[${ADDR_KEY}] SKIP: Phase "${ph}" failed (${res.repsSuccess}/${res.repsTarget}) → lanjut…`);
        if (STOP_ON_FAIL) {
          log.error(`[${ADDR_KEY}] STOP_ON_FAIL=1 → menghentikan run untuk akun ini.`);
          break; // Hentikan loop phase untuk akun ini
        }
      }

      const d = DELAYS[ph] || 0;
      if (d > 0) {
        log.info(`[${ADDR_KEY}] delay ${d}ms setelah phase ${ph}...`);
        await sleep(d);
      }
    }

    allResults.push({ key: ADDR_KEY, results: accountResults });

    // Jeda antar akun
    if (i < ALL_KEYS.length - 1) {
        log.info(`\n[GLOBAL] Jeda ${ACCOUNT_DELAY_MS}ms sebelum akun berikutnya...`);
        await sleep(ACCOUNT_DELAY_MS);
    }
  }
  // === END LOOP MULTI-AKUN ===

  printGlobalSummary(allResults, globalSuccess);
  process.exit(globalSuccess ? 0 : 1); // Exit 0 jika semua sukses, 1 jika ada kegagalan

})().catch(e => {
  log.error('FATAL:', e.message);
  process.exit(1);
});

// === [MODIFIKASI] Buat fungsi summary global ===
function printGlobalSummary(allResults, globalSuccess){
  console.log('\n====== GLOBAL SUMMARY ======');
  for(const acc of allResults){
    const ok = acc.results.filter(r => r.ok).map(r => `${r.phase} (${r.repsSuccess}/${r.repsTarget})`);
    const fail = acc.results.filter(r => !r.ok).map(r => `${r.phase} (${r.repsSuccess}/${r.repsTarget}${r.error ? `, ${r.error.message || 'error'}`:''})`);
    console.log(`\n[AKUN: ${acc.key}]`);
    console.log('  Sukses :', ok.length ? ok.join(', ') : '-');
    console.log('  Gagal  :', fail.length ? fail.join(', ') : '-');
  }
  console.log('\nSTATUS AKHIR:', globalSuccess ? 'SEMUA SUKSES' : 'ADA KEGAGALAN');
  console.log('============================\n');
}

// Fungsi ini tidak lagi digunakan, digantikan oleh printGlobalSummary
function printSummary(results){
  /* Dibiarkan kosong */
}
