// Usage: node tools/encode-url.js https://your-app.vercel.app
// Prints the obfuscated byte table to paste into the SafeLight_Link ModuleScript (ServerScriptService).
const url = process.argv[2];
if (!url) { console.error('Usage: node tools/encode-url.js https://your-app.vercel.app'); process.exit(1); }
const K = 0x5A;
const bytes = [...Buffer.from(url.replace(/\/+$/, ''), 'utf8')].map((c, i) => c ^ (((i + 1) * 31 + K) % 256));
console.log('local _d = {' + bytes.join(',') + '}');
