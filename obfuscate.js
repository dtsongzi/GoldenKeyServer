// 混淆构建产物里的业务 JS（dist 顶层，不含 node_modules）
// 说明：Express 的路由字符串、参数名都要保持可用，所以不开 renameGlobals / selfDefending
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, 'dist');
const SKIP = [/\.json$/, /node_modules[\\/]/, /\.sql$/];

if (!fs.existsSync(DIST)) {
  console.error('✗ dist 不存在，请先执行 build.sh');
  process.exit(1);
}

const files = fs.readdirSync(DIST).filter((f) => f.endsWith('.js'));
let count = 0;

for (const name of files) {
  const file = path.join(DIST, name);
  if (SKIP.some((p) => p.test(file))) continue;
  const code = fs.readFileSync(file, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, {
    target: 'node',
    compact: true,
    controlFlowFlattening: false, // 避免启动/请求变慢
    deadCodeInjection: false,     // 不额外膨胀体积
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    renameGlobals: false,         // 路由与导出的名字要稳定
    selfDefending: false,
    disableConsoleOutput: false,  // 保留日志，线上排障要用
  });
  fs.writeFileSync(file, result.getObfuscatedCode());
  count++;
}

console.log(`✅ Obfuscated ${count} files in dist/`);
