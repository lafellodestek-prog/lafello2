// Uygulamayi bu bilgisayarda calistirir ve Cloudflare'in ucretsiz tuneliyle internete acar.
// Gecici https adresi ekrana ve adres.txt dosyasina yazilir. Kapatmak icin pencereyi kapat ya da Ctrl+C.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || '3000';
const candidates = [
  process.env.CLOUDFLARED,
  path.join(dir, 'araclar', 'cloudflared.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
].filter(Boolean);
const cloudflared = candidates.find((p) => existsSync(p));

if (!cloudflared) {
  console.error('cloudflared bulunamadi. Bakilan yerler:');
  for (const p of candidates) console.error(`  ${p}`);
  process.exit(1);
}

// Eski pencere yeni kapandiysa kapinin bosalmasi birkac saniye surebilir; 15 saniyeye kadar bekle.
function portFree() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(Number(PORT));
  });
}
for (let i = 0; !(await portFree()); i++) {
  if (i === 0) console.log('Eski Lafello kapanıyor, birkaç saniye bekleniyor...');
  if (i >= 15) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
  cwd: dir,
  stdio: 'inherit',
  env: { ...process.env, PORT },
});
const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { cwd: dir });

let url = null;
function onTunnelOutput(buf) {
  const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m || url) return;
  url = m[0];
  writeFileSync(path.join(dir, 'adres.txt'), `${url}\n`);
  console.log('\n==============================================');
  console.log('  Lafello internette acik. Telefondan su adrese gir:');
  console.log(`  ${url}`);
  console.log('  Bu pencere acik kaldigi surece calisir.');
  console.log('==============================================\n');
}
tunnel.stdout.on('data', onTunnelOutput);
tunnel.stderr.on('data', onTunnelOutput);

function stop(code = 0) {
  server.kill();
  tunnel.kill();
  process.exit(code);
}
process.on('SIGINT', () => stop());
server.on('exit', (code) => {
  console.error(`Sunucu durdu (kod ${code}).`);
  stop(1);
});
tunnel.on('exit', (code) => {
  console.error(`Tunel kapandi (kod ${code}).`);
  stop(1);
});
