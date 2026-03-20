const express = require('express');
const multer  = require('multer');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const path = require('path');
const fs   = require('fs');
const app  = express();
const PORT = process.env.PORT || 8091;

// ── PostgreSQL bağlantısı ────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// Türkçe karakterleri düzelterek URL-uyumlu slug oluştur
function toSlug(text) {
  return (text || '').toLowerCase()
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
}

// Benzersiz slug üret
async function generateSlug(base) {
  let candidate = base;
  let n = 1;
  while (true) {
    const { rows } = await pool.query('SELECT id FROM salons WHERE slug=$1', [candidate]);
    if (rows.length === 0) return candidate;
    candidate = `${base}${n++}`;
  }
}

// DB satırını API formatına dönüştür
function rowToSalon(r) {
  if (!r) return null;
  return {
    _id: r.id,
    slug: r.slug,
    name: r.name,
    ownerName: r.owner_name,
    bank: r.bank,
    iban: r.iban,
    phone: r.phone || '',
    address: r.address || '',
    bio: r.bio || '',
    whatsapp: r.whatsapp || '',
    mapsUrl: r.maps_url || '',
    instagram: r.instagram || '',
    facebook: r.facebook || '',
    tiktok: r.tiktok || '',
    website: r.website || '',
    logoUrl: r.logo_url || null,
    coverUrl: r.cover_url || null,
    services: r.services || [],
    servicesActive: r.services_active !== false,
    calisma: r.calisma || {},
    kampanyalar: r.kampanyalar || [],
    menu: r.menu || [],
    menuActive: r.menu_active !== false,
    servicesLabel: r.services_label || 'Hizmetler',
    menuLabel: r.menu_label || 'Menü / Ürünler',
    active: r.active,
    createdAt: r.created_at,
  };
}

// ── Middleware ─────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(express.static(path.join(__dirname, 'public')));
fs.mkdirSync(path.join(__dirname, 'public/uploads'), { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/uploads')),
  filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/\s/g,'_')),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ── SALON API ──────────────────────────────────────────────────────────────

// Tüm salonları listele
app.get('/api/salons', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM salons ORDER BY created_at DESC');
    res.json(rows.map(rowToSalon));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Tek salon getir
app.get('/api/salons/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM salons WHERE slug=$1', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'İşletme bulunamadı' });
    res.json(rowToSalon(rows[0]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Salon ekle
app.post('/api/salons', upload.fields([{name:'logo',maxCount:1},{name:'cover',maxCount:1}]), async (req, res) => {
  try {
    const { name, ownerName, bank, iban, phone, address, services, customSlug,
            bio, whatsapp, mapsUrl, instagram, facebook, tiktok, website,
            calisma, kampanyalar, menu, servicesLabel, menuLabel } = req.body;
    const slugBase = customSlug ? toSlug(customSlug) : toSlug(ownerName || name);
    const slug = await generateSlug(slugBase || uuidv4().split('-')[0]);
    const logoUrl  = req.files?.logo?.[0]  ? '/uploads/' + req.files.logo[0].filename  : null;
    const coverUrl = req.files?.cover?.[0] ? '/uploads/' + req.files.cover[0].filename : null;

    let parsedServices = []; try { parsedServices = JSON.parse(services || '[]'); } catch(e) {}
    let parsedCalisma  = {}; try { parsedCalisma  = JSON.parse(calisma  || '{}'); } catch(e) {}
    let parsedKampanya = []; try { parsedKampanya = JSON.parse(kampanyalar || '[]'); } catch(e) {}
    let parsedMenu     = []; try { parsedMenu     = JSON.parse(menu || '[]'); } catch(e) {}

    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO salons (id,slug,name,owner_name,bank,iban,phone,address,bio,whatsapp,maps_url,
        instagram,facebook,tiktok,website,logo_url,cover_url,services,calisma,kampanyalar,menu,
        services_label,menu_label,active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,true)
      RETURNING *`,
      [id, slug, name, ownerName, bank||'', (iban||'').replace(/\s/g,''), phone||'', address||'',
       (bio||'').trim(), (whatsapp||'').replace(/\s/g,''), (mapsUrl||'').trim(),
       (instagram||'').trim(), (facebook||'').trim(), (tiktok||'').trim(), (website||'').trim(),
       logoUrl, coverUrl,
       JSON.stringify(parsedServices), JSON.stringify(parsedCalisma),
       JSON.stringify(parsedKampanya), JSON.stringify(parsedMenu),
       servicesLabel||'Hizmetler', menuLabel||'Menü / Ürünler']);

    // QR kod oluştur
    try {
      const baseUrl = req.protocol + '://' + req.get('host');
      const qrPath  = path.join(__dirname, 'public/uploads', `qr_${slug}.png`);
      await QRCode.toFile(qrPath, `${baseUrl}/${slug}`, { width: 400, margin: 2, errorCorrectionLevel: 'H' });
    } catch(e) {}

    res.json(rowToSalon(rows[0]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Salon güncelle
app.put('/api/salons/:slug', upload.fields([{name:'logo',maxCount:1},{name:'cover',maxCount:1}]), async (req, res) => {
  try {
    const { name, ownerName, bank, iban, phone, address, services, customSlug,
            bio, whatsapp, mapsUrl, instagram, facebook, tiktok, website,
            calisma, kampanyalar, menu, servicesActive, menuActive, servicesLabel, menuLabel } = req.body;

    let parsedServices = []; try { parsedServices = JSON.parse(services || '[]'); } catch(e) {}
    let parsedCalisma  = {}; try { parsedCalisma  = JSON.parse(calisma  || '{}'); } catch(e) {}
    let parsedKampanya = []; try { parsedKampanya = JSON.parse(kampanyalar || '[]'); } catch(e) {}
    let parsedMenu     = []; try { parsedMenu     = JSON.parse(menu || '[]'); } catch(e) {}

    // Mevcut kaydı al (logo/cover için)
    const existing = await pool.query('SELECT * FROM salons WHERE slug=$1', [req.params.slug]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Bulunamadı' });
    const cur = existing.rows[0];

    const logoUrl  = req.files?.logo?.[0]  ? '/uploads/' + req.files.logo[0].filename  : cur.logo_url;
    const coverUrl = req.files?.cover?.[0] ? '/uploads/' + req.files.cover[0].filename : cur.cover_url;

    // Slug değişimi
    let newSlug = req.params.slug;
    if (customSlug && toSlug(customSlug) !== req.params.slug) {
      newSlug = await generateSlug(toSlug(customSlug));
    }

    const { rows } = await pool.query(`
      UPDATE salons SET
        slug=$1, name=$2, owner_name=$3, bank=$4, iban=$5, phone=$6, address=$7,
        bio=$8, whatsapp=$9, maps_url=$10, instagram=$11, facebook=$12, tiktok=$13, website=$14,
        logo_url=$15, cover_url=$16, services=$17, calisma=$18, kampanyalar=$19, menu=$20,
        services_active=$21, menu_active=$22, services_label=$23, menu_label=$24
      WHERE slug=$25 RETURNING *`,
      [newSlug, name, ownerName, bank||'', (iban||'').replace(/\s/g,''), phone||'', address||'',
       (bio||'').trim(), (whatsapp||'').replace(/\s/g,''), (mapsUrl||'').trim(),
       (instagram||'').trim(), (facebook||'').trim(), (tiktok||'').trim(), (website||'').trim(),
       logoUrl, coverUrl,
       JSON.stringify(parsedServices), JSON.stringify(parsedCalisma),
       JSON.stringify(parsedKampanya), JSON.stringify(parsedMenu),
       servicesActive !== 'false', menuActive !== 'false',
       servicesLabel||'Hizmetler', menuLabel||'Menü / Ürünler',
       req.params.slug]);

    res.json(rowToSalon(rows[0]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Salon sil
app.delete('/api/salons/:slug', async (req, res) => {
  try {
    await pool.query('DELETE FROM salons WHERE slug=$1', [req.params.slug]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Salon aktif/pasif toggle
app.put('/api/salons/:slug/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE salons SET active = NOT active WHERE slug=$1 RETURNING active', [req.params.slug]);
    res.json({ active: rows[0]?.active });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ZİYARET API ────────────────────────────────────────────────────────────
app.post('/api/visit/:slug', async (req, res) => {
  try {
    await pool.query('INSERT INTO visits (slug) VALUES ($1)', [req.params.slug]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.get('/api/stats/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) as total FROM visits WHERE slug=$1', [req.params.slug]);
    const today = new Date(); today.setHours(0,0,0,0);
    const { rows: todayRows } = await pool.query(
      'SELECT COUNT(*) as cnt FROM visits WHERE slug=$1 AND ts >= $2', [req.params.slug, today]);
    res.json({ total: parseInt(rows[0].total), today: parseInt(todayRows[0].cnt) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const { rows: salonRows } = await pool.query('SELECT COUNT(*) as cnt FROM salons WHERE active=true');
    const { rows: visitRows } = await pool.query('SELECT COUNT(*) as cnt FROM visits');
    const today = new Date(); today.setHours(0,0,0,0);
    const { rows: todayRows } = await pool.query('SELECT COUNT(*) as cnt FROM visits WHERE ts >= $1', [today]);
    res.json({
      salons: parseInt(salonRows[0].cnt),
      visits: parseInt(visitRows[0].cnt),
      today:  parseInt(todayRows[0].cnt),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── QR KOD API ─────────────────────────────────────────────────────────────
app.get('/api/qr/:slug', async (req, res) => {
  try {
    const qrPath = path.join(__dirname, 'public/uploads', `qr_${req.params.slug}.png`);
    if (!fs.existsSync(qrPath)) {
      const baseUrl = req.protocol + '://' + req.get('host');
      await QRCode.toFile(qrPath, `${baseUrl}/${req.params.slug}`, { width: 400, margin: 2 });
    }
    res.sendFile(qrPath);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── YORUM API ──────────────────────────────────────────────────────────────
app.post('/api/reviews/:slug', async (req, res) => {
  try {
    const { name, rating, comment } = req.body;
    if (!rating) return res.status(400).json({ error: 'Puan zorunludur.' });
    const id = uuidv4();
    await pool.query(
      'INSERT INTO reviews (id,slug,name,rating,comment,approved) VALUES ($1,$2,$3,$4,$5,false)',
      [id, req.params.slug, (name||'Anonim').slice(0,60), parseInt(rating), (comment||'').slice(0,500)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reviews/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM reviews WHERE slug=$1 AND approved=true ORDER BY ts DESC', [req.params.slug]);
    res.json(rows.map(r => ({ _id: r.id, slug: r.slug, name: r.name, rating: r.rating, comment: r.comment, ts: r.ts })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reviews', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM reviews ORDER BY ts DESC LIMIT 200');
    res.json(rows.map(r => ({ _id: r.id, slug: r.slug, name: r.name, rating: r.rating, comment: r.comment, approved: r.approved, ts: r.ts })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/reviews/:id/approve', async (req, res) => {
  try {
    await pool.query('UPDATE reviews SET approved=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/reviews/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reviews WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ÇALIŞAN (STAFF) API ────────────────────────────────────────────────────
app.post('/api/staff', upload.fields([{name:'photo',maxCount:1}]), async (req, res) => {
  try {
    const { slug, name, title, phone } = req.body;
    const photoUrl = req.files?.photo?.[0] ? '/uploads/' + req.files.photo[0].filename : null;
    const id = uuidv4();
    const { rows } = await pool.query(
      'INSERT INTO staff (id,slug,name,title,phone,photo_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [id, slug, name, title||'', phone||'', photoUrl]);
    res.json({ _id: rows[0].id, ...rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/staff/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff WHERE slug=$1 ORDER BY created_at ASC', [req.params.slug]);
    res.json(rows.map(r => ({ _id: r.id, slug: r.slug, name: r.name, title: r.title, phone: r.phone, photoUrl: r.photo_url })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM staff WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REKLAM API ─────────────────────────────────────────────────────────────
app.get('/api/ads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ads ORDER BY created_at DESC');
    res.json(rows.map(r => ({ _id: r.id, title: r.title, subtitle: r.subtitle, link: r.link, type: r.type, bgColor: r.bg_color, imageUrl: r.image_url, active: r.active })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ads/active', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ads WHERE active=true ORDER BY created_at DESC LIMIT 5');
    res.json(rows.map(r => ({ _id: r.id, title: r.title, subtitle: r.subtitle, link: r.link, type: r.type, bgColor: r.bg_color, imageUrl: r.image_url })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ads', upload.fields([{name:'image',maxCount:1}]), async (req, res) => {
  try {
    const { title, subtitle, link, type, bgColor, active } = req.body;
    const imageUrl = req.files?.image?.[0] ? '/uploads/' + req.files.image[0].filename : null;
    const id = uuidv4();
    const { rows } = await pool.query(
      'INSERT INTO ads (id,title,subtitle,link,type,bg_color,image_url,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [id, title||'', subtitle||'', link||'', type||'banner', bgColor||'#6c63ff', imageUrl, active!=='false']);
    res.json({ _id: rows[0].id, ...rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/ads/:id', upload.fields([{name:'image',maxCount:1}]), async (req, res) => {
  try {
    const { title, subtitle, link, type, bgColor, active } = req.body;
    const cur = await pool.query('SELECT * FROM ads WHERE id=$1', [req.params.id]);
    const imageUrl = req.files?.image?.[0] ? '/uploads/' + req.files.image[0].filename : cur.rows[0]?.image_url;
    const { rows } = await pool.query(
      'UPDATE ads SET title=$1,subtitle=$2,link=$3,type=$4,bg_color=$5,image_url=$6,active=$7 WHERE id=$8 RETURNING *',
      [title||'', subtitle||'', link||'', type||'banner', bgColor||'#6c63ff', imageUrl, active!=='false', req.params.id]);
    res.json({ _id: rows[0].id, title: rows[0].title, subtitle: rows[0].subtitle, link: rows[0].link, bgColor: rows[0].bg_color, active: rows[0].active });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/ads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ads WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MÜŞTERİ MESAJ API ─────────────────────────────────────────────────────
app.post('/api/mesaj/:slug', async (req, res) => {
  try {
    const { ad, telefon, mesaj } = req.body;
    if (!ad || !mesaj) return res.status(400).json({ error: 'Ad ve mesaj zorunludur.' });
    const id = uuidv4();
    await pool.query(
      'INSERT INTO mesajlar (id,slug,ad,telefon,mesaj) VALUES ($1,$2,$3,$4,$5)',
      [id, req.params.slug, (ad||'').slice(0,60), (telefon||'').slice(0,20), (mesaj||'').slice(0,500)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mesajlar/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM mesajlar WHERE slug=$1 ORDER BY ts DESC', [req.params.slug]);
    res.json(rows.map(r => ({ _id: r.id, slug: r.slug, ad: r.ad, telefon: r.telefon, mesaj: r.mesaj, okundu: r.okundu, ts: r.ts })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/mesaj/:id/okundu', async (req, res) => {
  try {
    await pool.query('UPDATE mesajlar SET okundu=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/mesaj/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM mesajlar WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mesajlar', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM mesajlar ORDER BY ts DESC LIMIT 200');
    res.json(rows.map(r => ({ _id: r.id, slug: r.slug, ad: r.ad, telefon: r.telefon, mesaj: r.mesaj, okundu: r.okundu, ts: r.ts })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BAŞVURU API ─────────────────────────────────────────────────────────────
app.post('/api/basvuru', async (req, res) => {
  try {
    const { isletmeAdi, isletmeTuru, sahipAdi, telefon, adres, hizmetler, iban, banka, slug } = req.body;
    if (!isletmeAdi || !sahipAdi || !telefon) {
      return res.status(400).json({ error: 'İşletme adı, yetkili adı ve telefon zorunludur.' });
    }
    const id = uuidv4();
    await pool.query(
      `INSERT INTO basvurular (id,isletme_adi,isletme_turu,sahip_adi,telefon,adres,hizmetler,iban,banka,slug,durum)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'bekliyor')`,
      [id, (isletmeAdi||'').trim(), (isletmeTuru||'').trim(), (sahipAdi||'').trim(),
       (telefon||'').trim(), (adres||'').trim(), (hizmetler||'').trim(),
       (iban||'').replace(/\s/g,''), (banka||'').trim(), (slug||'').trim()]);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/basvurular', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM basvurular ORDER BY ts DESC');
    res.json(rows.map(r => ({
      _id: r.id, isletmeAdi: r.isletme_adi, isletmeTuru: r.isletme_turu,
      sahipAdi: r.sahip_adi, telefon: r.telefon, adres: r.adres,
      hizmetler: r.hizmetler, iban: r.iban, banka: r.banka, slug: r.slug,
      durum: r.durum, redNotu: r.red_notu, ts: r.ts,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Başvuru güncelle (onaylamadan önce düzenleme)
app.put('/api/basvurular/:id', async (req, res) => {
  try {
    const { isletmeAdi, isletmeTuru, sahipAdi, telefon, adres, hizmetler, iban, banka, slug } = req.body;
    await pool.query(
      `UPDATE basvurular SET isletme_adi=$1,isletme_turu=$2,sahip_adi=$3,telefon=$4,
       adres=$5,hizmetler=$6,iban=$7,banka=$8,slug=$9 WHERE id=$10`,
      [(isletmeAdi||'').trim(), (isletmeTuru||'').trim(), (sahipAdi||'').trim(),
       (telefon||'').trim(), (adres||'').trim(), (hizmetler||'').trim(),
       (iban||'').replace(/\s/g,''), (banka||'').trim(), (slug||'').trim(), req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Başvuru onayla → salona dönüştür
app.post('/api/basvurular/:id/onayla', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM basvurular WHERE id=$1', [req.params.id]);
    const doc = rows[0];
    if (!doc) return res.status(404).json({ error: 'Başvuru bulunamadı' });
    if (doc.durum === 'onaylandi') return res.status(400).json({ error: 'Zaten onaylandı' });

    const slugBase = doc.slug ? toSlug(doc.slug) : toSlug(doc.sahip_adi || doc.isletme_adi);
    const slug = await generateSlug(slugBase || uuidv4().split('-')[0]);
    const id = uuidv4();
    const services = doc.hizmetler
      ? doc.hizmetler.split(',').map(s => ({ name: s.trim(), price: '' })).filter(s => s.name)
      : [];

    const { rows: salonRows } = await pool.query(`
      INSERT INTO salons (id,slug,name,owner_name,bank,iban,phone,address,services,active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *`,
      [id, slug, doc.isletme_adi, doc.sahip_adi, doc.banka||'', doc.iban||'',
       doc.telefon||'', doc.adres||'', JSON.stringify(services)]);

    try {
      const baseUrl = req.protocol + '://' + req.get('host');
      const qrPath  = path.join(__dirname, 'public/uploads', `qr_${slug}.png`);
      await QRCode.toFile(qrPath, `${baseUrl}/${slug}`, { width: 400, margin: 2, errorCorrectionLevel: 'H' });
    } catch(e) {}

    await pool.query(
      `UPDATE basvurular SET durum='onaylandi', slug=$1 WHERE id=$2`,
      [slug, req.params.id]);

    res.json({ ok: true, slug, salon: rowToSalon(salonRows[0]) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Başvuru reddet
app.post('/api/basvurular/:id/reddet', async (req, res) => {
  try {
    const { notlar } = req.body;
    await pool.query(
      `UPDATE basvurular SET durum='reddedildi', red_notu=$1 WHERE id=$2`,
      [notlar||'', req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Başvuru sil
app.delete('/api/basvurular/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM basvurular WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SAYFA ROTALARI ─────────────────────────────────────────────
app.get('/salon/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public/salon.html')));

app.get('/:slug', (req, res, next) => {
  const reserved = ['admin', 'api', 'uploads', 'favicon.ico'];
  if (reserved.includes(req.params.slug)) return next();
  if (req.params.slug.length < 2 || req.params.slug.length > 60) return next();
  res.sendFile(path.join(__dirname, 'public/salon.html'));
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

app.listen(PORT, () => console.log(`✅ Çabuk sunucusu çalışıyor: http://localhost:${PORT}`));
