// Render'in ucretsiz planinda disk kalici degil; sunucu her uyuyup uyandiginda dosyalar silinir.
// Bu yuzden veritabani dosyasi Supabase Storage'a yedeklenir ve acilista oradan geri yuklenir.
// SUPABASE_URL ve SUPABASE_SERVICE_KEY yoksa (ornegin kendi bilgisayarinda) hicbir sey yapmaz.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.BACKUP_BUCKET || 'lafello-backup';
const OBJECT = 'lafello.db';

export const enabled = !!(BASE && KEY);

// Eski tip anahtar (service_role, "eyJ..." ile baslar) hem apikey hem Authorization basliginda gider;
// yeni tip gizli anahtar ("sb_secret_...") yalniz apikey basliginda gonderilir.
const headers = (extra = {}) => ({ apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}), ...extra });

async function ensureBucket() {
  const res = await fetch(`${BASE}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  // Zaten varsa Supabase hata dondurur; bu beklenen bir durum.
  if (!res.ok && res.status !== 400 && res.status !== 409) throw new Error(`Yedek kovasi olusturulamadi: ${res.status}`);
}

// Acilista son yedegi indirir. Yedek yoksa (ilk calistirma) bos veritabaniyla baslanir.
export async function restore(dbPath) {
  if (!enabled) return false;
  await ensureBucket();
  const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${OBJECT}`, { headers: headers() });
  if (res.status === 400 || res.status === 404) {
    console.log('Yedek bulunamadi, yeni veritabaniyla baslaniyor.');
    return false;
  }
  if (!res.ok) throw new Error(`Yedek indirilemedi: ${res.status}`);
  writeFileSync(dbPath, Buffer.from(await res.arrayBuffer()));
  console.log('Veritabani yedekten geri yuklendi.');
  return true;
}

export async function upload(filePath) {
  if (!enabled || !existsSync(filePath)) return;
  const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${OBJECT}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }),
    body: readFileSync(filePath),
  });
  if (!res.ok) throw new Error(`Yedek yuklenemedi: ${res.status} ${await res.text()}`);
}
