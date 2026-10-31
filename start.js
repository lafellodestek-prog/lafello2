// Canli sunucunun giris noktasi: once yedegi geri yukler, sonra uygulamayi baslatir,
// ardindan veritabanini her dakika (degisiklik varsa) ve kapanirken yedekler.
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as backup from './backup.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(dir, 'data', 'sahne.db');
mkdirSync(path.dirname(dbPath), { recursive: true });

if (backup.enabled) {
  // Eski bir calismadan kalan dosyalar yedekle karismasin.
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  await backup.restore(dbPath);
} else {
  console.log('Yedekleme kapali (SUPABASE_URL / SUPABASE_SERVICE_KEY yok).');
}

const db = await import('./db.js');
await import('./server.js');

if (backup.enabled) {
  const snap = path.join(os.tmpdir(), 'lafello-snapshot.db');
  let lastChanges = -1;
  let busy = false;

  async function save(force = false) {
    if (busy) return;
    const changes = db.totalChanges();
    if (!force && changes === lastChanges) return;
    busy = true;
    try {
      db.snapshot(snap);
      await backup.upload(snap);
      lastChanges = changes;
    } catch (e) {
      console.error('Yedekleme hatasi:', e.message);
    } finally {
      busy = false;
    }
  }

  setInterval(save, 60 * 1000);

  // Render sunucuyu durdururken (uyutma ya da yeni surum) once son hali yedekle.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
      console.log('Kapaniyor, son yedek aliniyor...');
      busy = false;
      await save(true);
      process.exit(0);
    });
  }
}
