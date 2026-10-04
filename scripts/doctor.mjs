#!/usr/bin/env node
/**
 * Environment check.
 *
 *   node scripts/doctor.mjs            # 报告环境状态
 *   node scripts/doctor.mjs --strict   # 任一引擎不可用则退出码非 0（适合 CI）
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { detectAll, engineSummaries } from '../src/engines/index.js';
import { DATA_DIR, ROOT, execCapture, which } from '../src/util.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const red = (s) => c(31, s);
const cyan = (s) => c(36, s);

const strict = process.argv.includes('--strict');
const problems = [];

console.log(`\n${bold('TestBench 环境自检')}\n${dim(`项目目录 ${ROOT}`)}\n`);

/* ------------------------------------------------------------------- node */
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeOk = nodeMajor >= 18;
console.log(`${nodeOk ? green('✓') : red('✗')} Node.js           ${process.versions.node}${nodeOk ? '' : '  (需要 >= 18)'}`);
if (!nodeOk) problems.push('Node.js 版本过低，请升级到 18 或更高版本');

/* --------------------------------------------------------------- data dir */
let dataOk = true;
try {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const probe = path.join(DATA_DIR, '.doctor-probe');
  await fsp.writeFile(probe, 'ok');
  await fsp.rm(probe, { force: true });
} catch (err) {
  dataOk = false;
  problems.push(`数据目录不可写：${DATA_DIR}（${err.message}）`);
}
console.log(`${dataOk ? green('✓') : red('✗')} 数据目录可写      ${dim(DATA_DIR)}`);

/* ------------------------------------------------------------------- java */
const javaBin = await which('java');
if (javaBin) {
  const jv = await execCapture(javaBin, ['-version'], { timeoutMs: 15000 });
  const line = (jv.stderr + jv.stdout).split('\n')[0];
  const version = /"([^"]+)"/.exec(line)?.[1] ?? line;
  console.log(`${green('✓')} Java              ${version}`);
} else {
  console.log(`${yellow('!')} Java              未找到（JMeter 需要 JDK 8+）`);
}

/* ---------------------------------------------------------------- engines */
console.log(`\n${bold('测试引擎')}\n`);
const detection = new Map((await detectAll({ force: true })).map((d) => [d.id, d]));
const engines = engineSummaries();

for (const engine of engines) {
  const d = detection.get(engine.id) ?? {};
  if (d.available) {
    console.log(`${green('✓')} ${engine.name.padEnd(16)} ${d.version ?? ''}`);
    console.log(`  ${dim(d.binary ?? '')}`);
  } else {
    console.log(`${yellow('○')} ${engine.name.padEnd(16)} 不可用 → 将以演示模式运行`);
    console.log(`  ${dim(`安装：${engine.install?.cmd ?? '-'}`)}`);
    problems.push(`${engine.name} 未安装（安装命令：${engine.install?.cmd ?? '-'}）`);
  }
}

const ready = engines.filter((e) => detection.get(e.id)?.available).length;
console.log(
  `\n${bold('汇总')}  ${ready}/${engines.length} 个引擎就绪` +
    (ready === engines.length ? green('  全部可用') : yellow('  部分为演示模式')),
);

if (problems.length) {
  console.log(`\n${bold('待处理项')}`);
  for (const p of problems) console.log(`  • ${p}`);
  console.log(`\n${dim('提示：运行 ./install.sh 可自动安装缺失的工具链（macOS / Linux）。')}`);
}

console.log(`\n启动服务：${cyan('npm start')}    ${dim('（监听地址可用 HOST / PORT 环境变量覆盖）')}\n`);

process.exit(strict && problems.length ? 1 : 0);
