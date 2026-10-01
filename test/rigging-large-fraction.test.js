// 吊挂布景载荷核算「多件分数分担叠加」显示回归测试：
// 1. 同一左吊点连接 140 个间距各异（质数厘米）的右吊点，每件 1 kg、重心距右吊点 1 cm
//    且同时生效：累计载荷的精确分数分母是 140 个质数的乘积（数百位），此前把巨大
//    分子 / 分母 Number() 转浮点再相除得到 Infinity / Infinity = NaN，kg 字段在
//    JSON 中变为 null、页面显示 NaN。修复后峰值、超额区间峰值、超额量与逐件分担的
//    kg 均为有限的两位小数值，且与精确分数 num/den 一致；
// 2. 页面 fmtLoad 对巨大分数同样给出可读展示（不出现 NaN / Infinity）；
// 3. 分数精确口径不变：累计恰好等于额定载荷不报超额；半开时段 [起, 止) 同秒结束
//    先于开始（t 秒结束与 t 秒开始不叠加）。
//
// 运行：node --test（Node >= 18），使用独立临时 DATA_DIR，不污染仓库内 data/。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rigging-frac-'));
process.env.DATA_DIR = TMP_DIR;

const routes = require('../src/routes');
const express = require('express');

let server;

function request(method, urlPath, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          if (raw) {
            try {
              json = JSON.parse(raw);
            } catch {
              /* 204 无响应体 */
            }
          }
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

test.after(() => {
  server.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** 前 n 个质数 */
function firstPrimes(n) {
  const ps = [];
  let c = 2;
  while (ps.length < n) {
    let isP = true;
    for (const p of ps) {
      if (p * p > c) break;
      if (c % p === 0) {
        isP = false;
        break;
      }
    }
    if (isP) ps.push(c);
    c++;
  }
  return ps;
}

function gcdBig(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** 测试内独立实现的精确分数加法（BigInt，自动约分），用于交叉核对响应的 num/den */
function addFracStrings([an, ad], [bn, bd]) {
  const n = an * bd + bn * ad;
  const d = ad * bd;
  const g = gcdBig(n, d);
  return [n / g, d / g];
}

/** 与服务端同一口径：kg = round(n/d × 100) / 100，BigInt 求值（载荷非负，截断即向下取整） */
function kgFromStrings(frac) {
  const n = BigInt(frac.num);
  const d = BigInt(frac.den);
  return Number((2n * n * 100n + d) / (2n * d)) / 100;
}

/** 递归校验响应中所有 { num, den, kg } 载荷对象：kg 为有限数值且与精确分数一致 */
function assertFracJson(frac, label) {
  assert.strictEqual(typeof frac.num, 'string', `${label}: num 应为字符串`);
  assert.strictEqual(typeof frac.den, 'string', `${label}: den 应为字符串`);
  assert.strictEqual(typeof frac.kg, 'number', `${label}: kg 应为数值（不得为 null）`);
  assert.ok(Number.isFinite(frac.kg), `${label}: kg 必须为有限数值，实际 ${frac.kg}`);
  assert.strictEqual(frac.kg, kgFromStrings(frac), `${label}: kg 须由精确分数舍入得到`);
}

const PRIMES = firstPrimes(140);

test('140 个质数间距吊挂件同时生效：kg 有限且与精确分数一致', async () => {
  // 左吊点（额定 2 kg）+ 140 个右吊点（横坐标为前 140 个质数，额定足够大不超额）
  const left = await request('POST', '/api/rigPoints', { name: '横梁左端', x: 0, ratedLoad: 2 });
  assert.strictEqual(left.status, 201);
  const rightIds = [];
  for (let i = 0; i < PRIMES.length; i++) {
    const r = await request('POST', '/api/rigPoints', {
      name: `右吊点 ${i + 1}`,
      x: PRIMES[i],
      ratedLoad: 1000000,
    });
    assert.strictEqual(r.status, 201);
    rightIds.push(r.json.id);
  }
  // 每件 1 kg、重心距右吊点 1 cm（左分担 = 1/p，右分担 = (p-1)/p）、同时生效 [0,100)
  for (let i = 0; i < PRIMES.length; i++) {
    const r = await request('POST', '/api/rigItems', {
      name: `吊挂件 ${i + 1}`,
      weight: 1,
      cogX: PRIMES[i] - 1,
      leftPointId: left.json.id,
      rightPointId: rightIds[i],
      start: 0,
      end: 100,
    });
    assert.strictEqual(r.status, 201);
  }

  const res = await request('GET', '/api/rigging');
  assert.strictEqual(res.status, 200);
  // 临时数据目录首次加载会写入内置示例数据，总数 = 示例 + 本用例新增
  const seed = require('../seed/sample-data.json');
  assert.strictEqual(res.json.summary.points, seed.rigPoints.length + 141);
  assert.strictEqual(res.json.summary.items, seed.rigItems.length + 140);
  // 汇总计数与明细一致
  assert.strictEqual(res.json.summary.points, res.json.points.length);
  assert.strictEqual(
    res.json.summary.overloadedPoints,
    res.json.points.filter((p) => p.overloaded).length
  );

  // 响应中全部载荷对象：kg 有限且与 num/den 精确一致
  for (const p of res.json.points) {
    assertFracJson(p.peak, `吊点 ${p.name} 峰值`);
    for (const iv of p.intervals) {
      assertFracJson(iv.peakLoad, `吊点 ${p.name} 区间峰值`);
      assertFracJson(iv.excess, `吊点 ${p.name} 超额量`);
    }
  }
  for (const it of res.json.items) {
    assertFracJson(it.leftShare, `吊挂件 ${it.name} 左分担`);
    assertFracJson(it.rightShare, `吊挂件 ${it.name} 右分担`);
  }

  const row = res.json.points.find((p) => p.id === left.json.id);
  // 分母为 140 个质数的乘积（数百位，远超浮点范围）：确认测试确实处于大分数情形
  assert.ok(row.peak.den.length > 309, `分母应达数百位，实际 ${row.peak.den.length} 位`);

  // 精确分数交叉核对：左吊点峰值 = Σ 1/p（测试内独立 BigInt 求和）
  let sum = [0n, 1n];
  for (const p of PRIMES) sum = addFracStrings(sum, [1n, BigInt(p)]);
  assert.strictEqual(row.peak.num, sum[0].toString(), '峰值分子须为精确分数');
  assert.strictEqual(row.peak.den, sum[1].toString(), '峰值分母须为精确分数');

  // 超额判定仍为分数严格大于：2.17 > 2 → 超额，区间 [0,100) 一条
  assert.strictEqual(row.overloaded, true);
  assert.strictEqual(row.intervals.length, 1);
  assert.strictEqual(row.intervals[0].start, 0);
  assert.strictEqual(row.intervals[0].end, 100);
  assert.strictEqual(row.intervals[0].durationSeconds, 100);
  // 区间峰值 = 总峰值；超额量 = 峰值 − 额定 2（分数精确相等）
  assert.strictEqual(row.intervals[0].peakLoad.num, row.peak.num);
  assert.strictEqual(row.intervals[0].peakLoad.den, row.peak.den);
  const excessAsSum = addFracStrings(sum, [-2n, 1n]);
  assert.strictEqual(row.intervals[0].excess.num, excessAsSum[0].toString());
  assert.strictEqual(row.intervals[0].excess.den, excessAsSum[1].toString());

  // kg 为可读两位小数：峰值 ≈ 2.17、超额量 ≈ 0.17（具体值由精确分数舍入，非浮点直除）
  assert.strictEqual(row.peak.kg, kgFromStrings(row.peak));
  assert.strictEqual(row.intervals[0].excess.kg, kgFromStrings(row.intervals[0].excess));

  // 逐件分担：左分担 1/p、右分担 (p-1)/p，kg 均有限
  for (let i = 0; i < PRIMES.length; i++) {
    const it = res.json.items.find((x) => x.name === `吊挂件 ${i + 1}`);
    assert.strictEqual(it.leftShare.num, '1');
    assert.strictEqual(it.leftShare.den, String(PRIMES[i]));
    assert.strictEqual(it.rightShare.num, String(PRIMES[i] - 1));
    assert.strictEqual(it.rightShare.den, String(PRIMES[i]));
  }
});

test('页面 fmtLoad 对巨大分数给出可读展示（不出现 NaN / Infinity）', async () => {
  const res = await request('GET', '/api/rigging');
  const row = res.json.points.find((p) => p.name === '横梁左端');
  assert.ok(row, '上一用例的大分数吊点应仍存在');

  // 从 public/app.js 提取 fmtLoad 源码独立执行，直接覆盖页面显示路径
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const m = appJs.match(/function fmtLoad\(f\) \{[\s\S]*?\n\}/);
  assert.ok(m, '应能从 public/app.js 提取 fmtLoad');
  const fmtLoad = new Function(`${m[0]}; return fmtLoad;`)();

  for (const [label, frac] of [
    ['峰值', row.peak],
    ['区间峰值', row.intervals[0].peakLoad],
    ['超额量', row.intervals[0].excess],
  ]) {
    const text = fmtLoad(frac);
    assert.ok(!/NaN|Infinity/.test(text), `${label} 显示不得含 NaN / Infinity：${text}`);
    // 非有限小数：两位小数 + 省略号 + 精确分数（保持既有展示结构）
    assert.ok(/^\d+\.\d+…（=\d+\/\d+）$/.test(text), `${label} 显示格式不符：${text}`);
    assert.ok(text.startsWith(`${frac.kg}…（=`), `${label} 应以 kg 的两位小数开头：${text}`);
  }

  // 常规情形保持原样：整数直接显示；恰好两位小数不附分数；无限小数附精确分数
  assert.strictEqual(fmtLoad({ num: '2', den: '1', kg: 2 }), '2');
  assert.strictEqual(fmtLoad({ num: '5', den: '2', kg: 2.5 }), '2.5');
  assert.strictEqual(fmtLoad({ num: '1', den: '3', kg: 0.33 }), '0.33…（=1/3）');
  assert.strictEqual(fmtLoad({ num: '1475', den: '3', kg: 491.67 }), '491.67…（=1475/3）');
});

test('分数精确口径不变：恰好等于额定载荷不报超额，半开时段同秒不叠加', async () => {
  // 恰好相等：三件各向右吊点分担 1/3（1 kg、间距 3 cm、重心距左 1 cm），累计恰为额定 1
  const l1 = await request('POST', '/api/rigPoints', { name: '临界左', x: 5000, ratedLoad: 1000000 });
  const r1 = await request('POST', '/api/rigPoints', { name: '临界右', x: 5003, ratedLoad: 1 });
  assert.strictEqual(l1.status, 201);
  assert.strictEqual(r1.status, 201);
  for (let i = 0; i < 3; i++) {
    const r = await request('POST', '/api/rigItems', {
      name: `临界件 ${i + 1}`,
      weight: 1,
      cogX: 5001,
      leftPointId: l1.json.id,
      rightPointId: r1.json.id,
      start: 0,
      end: 300,
    });
    assert.strictEqual(r.status, 201);
  }

  // 半开时段：两件各分担 3/4（1 kg、间距 4 cm、重心距左 3 cm），一件 [0,50) 另一件 [50,100)，
  // 若同秒叠加则峰值 1.5 > 额定 1 会误判超额；正确口径下峰值恒为 0.75
  const l2 = await request('POST', '/api/rigPoints', { name: '半开左', x: 6000, ratedLoad: 1000000 });
  const r2 = await request('POST', '/api/rigPoints', { name: '半开右', x: 6004, ratedLoad: 1 });
  for (const [i, [start, end]] of [
    [1, [0, 50]],
    [2, [50, 100]],
  ]) {
    const r = await request('POST', '/api/rigItems', {
      name: `半开件 ${i}`,
      weight: 1,
      cogX: 6003,
      leftPointId: l2.json.id,
      rightPointId: r2.json.id,
      start,
      end,
    });
    assert.strictEqual(r.status, 201);
  }

  const res = await request('GET', '/api/rigging');
  const exact = res.json.points.find((p) => p.id === r1.json.id);
  assert.strictEqual(exact.peak.num, '1', '三件 1/3 累计应恰好为 1');
  assert.strictEqual(exact.peak.den, '1');
  assert.strictEqual(exact.peak.kg, 1);
  assert.strictEqual(exact.overloaded, false, '恰好等于额定载荷不报超额');
  assert.deepStrictEqual(exact.intervals, []);

  const halfOpen = res.json.points.find((p) => p.id === r2.json.id);
  assert.strictEqual(halfOpen.peak.num, '3');
  assert.strictEqual(halfOpen.peak.den, '4');
  assert.strictEqual(halfOpen.peak.kg, 0.75);
  assert.strictEqual(halfOpen.overloaded, false, '同秒结束先于开始，t=50 不叠加');
  assert.deepStrictEqual(halfOpen.intervals, []);
});
