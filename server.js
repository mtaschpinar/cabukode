const express = require('express');
const multer  = require('multer');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const Datastore = require('nedb');
const path = require('path');
const fs   = require('fs');

const app  = express();
const PORT = process.env.PORT || 8091;

// Türkçe karakterleri düzelterek URL-uyumlu slug oluştur
function toSlug(text) {
  return text
    .toLowerCase()
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
}

// Benzersiz slug üret (çakışma varsa sayı ekle)
async function generateSlug(base) {
  return new Promise((resolve) => {
    const trySlug = (s, n) => {
      const candidate = n ? `${s}${n}` : s;
      db.salons.findOne({ slug: candidate }, (err, doc) => {
        if (!doc) resolve(candidate);
        else trySlug(s, (n || 1) + 1);
      });
    };
    trySlug(base, 0);
  });
}

// ── Veritabanları ────────────────────────────────────────────────────────────
const db = {};
db.salons      = new Datastore({ filename: path.join(__dirname, 'data/salons.db'),      autoload: true });
db.visits      = new Datastore({ filename: path.join(__dirname, 'data/visits.db'),      autoload: true });
db.reviews     = new Datastore({ filename: path.join(__dirname, 'data/reviews.db'),     autoload: true });
db.ads         = new Datastore({ filename: path.join(__dirname, 'data/ads.db'),         autoload: true });
db.staff       = new Datastore({ filename: path.join(__dirname, 'data/staff.db'),       autoload: true });
db.basvurular  = new Datastore({ filename: path.join(__dirname, 'data/basvurular.db'),  autoload: true });
db.mesajlar    = new Datastore({ filename: path.join(__dirname, 'data/mesajlar.db'),    autoload: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'public/uploads'), { recursive: true });

// ── Middleware ─────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Logo yükleme
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/uploads')),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// ── ADMIN API ──────────────────────────────────────────────────

// Tüm salonları listele
app.get('/api/salons', (req, res) => {
  db.salons.find({}).sort({ createdAt: -1 }).exec((err, docs) => {
    res.json(docs);
  });
});

// Salon detayı
app.get('/api/salons/:slug', (req, res) => {
  db.salons.findOne({ slug: req.params.slug }, (err, doc) => {
    if (!doc) return res.status(404).json({ error: 'Salon bulunamadı' });
    res.json(doc);
  });
});

// Salon ekle
app.post('/api/salons', upload.fields([{name:'logo',maxCount:1},{name:'cover',maxCount:1}]), async (req, res) => {
  try {
    const { name, ownerName, bank, iban, phone, address, services, customSlug,
            bio, whatsapp, mapsUrl, instagram, facebook, tiktok, website,
            calisma, kampanyalar, menu } = req.body;
    // Özel slug varsa onu kullan, yoksa salon adından otomatik oluştur
    const slugBase = customSlug ? toSlug(customSlug) : toSlug(ownerName || name);
    const slug = await generateSlug(slugBase || uuidv4().split('-')[0]);
    const logoUrl  = req.files?.logo?.[0]  ? '/uploads/' + req.files.logo[0].filename  : null;
    const coverUrl = req.files?.cover?.[0] ? '/uploads/' + req.files.cover[0].filename : null;

    // Hizmetleri parse et
    let parsedServices = [];
    try { parsedServices = JSON.parse(services || '[]'); } catch(e) {}
    let parsedCalisma = {};
    try { parsedCalisma = JSON.parse(calisma || '{}'); } catch(e) {}
    let parsedKampanyalar = [];
    try { parsedKampanyalar = JSON.parse(kampanyalar || '[]'); } catch(e) {}
    let parsedMenu = [];
    try { parsedMenu = JSON.parse(menu || '[]'); } catch(e) {}

    const salon = {
      _id: uuidv4(),
      slug,
      name,
      ownerName,
      bank,
      iban: iban.replace(/\s/g, ''),
      phone: phone || '',
      address: address || '',
      bio: (bio || '').trim(),
      whatsapp: (whatsapp || '').replace(/\s/g, ''),
      mapsUrl: (mapsUrl || '').trim(),
      instagram: (instagram || '').trim(),
      facebook: (facebook || '').trim(),
      tiktok: (tiktok || '').trim(),
      website: (website || '').trim(),
      calisma: parsedCalisma,
      kampanyalar: parsedKampanyalar,
      menu: parsedMenu,
      services: parsedServices,
      logoUrl,
      coverUrl: coverUrl || null,
      createdAt: new Date(),
      active: true,
    };

    db.salons.insert(salon, async (err, doc) => {
      if (err) return res.status(500).json({ error: err.message });

      // QR kod oluştur
      const baseUrl = req.protocol + '://' + req.get('host');
      const pageUrl = `${baseUrl}/salon/${slug}`;
      const qrPath  = path.join(__dirname, 'public/uploads', `qr_${slug}.png`);
      await QRCode.toFile(qrPath, pageUrl, {
        width: 400, margin: 2,
        color: { dark: '#0f0f1a', light: '#ffffff' },
        errorCorrectionLevel: 'H',
      });

      res.json({ ...doc, qrUrl: `/uploads/qr_${slug}.png`, pageUrl });
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Salon güncelle
app.put('/api/salons/:slug', upload.fields([{name:'logo',maxCount:1},{name:'cover',maxCount:1}]), (req, res) => {
  const { name, ownerName, bank, iban, phone, address, services,
          bio, whatsapp, mapsUrl, instagram, facebook, tiktok, website,
          calisma, kampanyalar, menu } = req.body;
  let update = { name, ownerName, bank, phone, address,
    bio: (bio || '').trim(),
    whatsapp: (whatsapp || '').replace(/\s/g, ''),
    mapsUrl: (mapsUrl || '').trim(),
    instagram: (instagram || '').trim(),
    facebook: (facebook || '').trim(),
    tiktok: (tiktok || '').trim(),
    website: (website || '').trim(),
  };
  if (iban) update.iban = iban.replace(/\s/g, '');
  if (req.files?.logo?.[0])  update.logoUrl  = '/uploads/' + req.files.logo[0].filename;
  if (req.files?.cover?.[0]) update.coverUrl = '/uploads/' + req.files.cover[0].filename;
  try { update.services    = JSON.parse(services    || '[]'); } catch(e) {}
  try { update.calisma     = JSON.parse(calisma     || '{}'); } catch(e) {}
  try { update.kampanyalar = JSON.parse(kampanyalar || '[]'); } catch(e) {}
  try { update.menu        = JSON.parse(menu        || '[]'); } catch(e) {}

  db.salons.update({ slug: req.params.slug }, { $set: update }, {}, (err, n) => {
    if (err) return res.status(500).json({ error: err.message });
    db.salons.findOne({ slug: req.params.slug }, (err, doc) => res.json(doc));
  });
});

// Salon sil
app.delete('/api/salons/:slug', (req, res) => {
  db.salons.remove({ slug: req.params.slug }, {}, (err) => {
    res.json({ ok: true });
  });
});

// QR yeniden oluştur
app.post('/api/salons/:slug/qr', async (req, res) => {
  const baseUrl = req.protocol + '://' + req.get('host');
  const pageUrl = `${baseUrl}/salon/${req.params.slug}`;
  const qrPath  = path.join(__dirname, 'public/uploads', `qr_${req.params.slug}.png`);
  await QRCode.toFile(qrPath, pageUrl, {
    width: 400, margin: 2,
    color: { dark: '#0f0f1a', light: '#ffffff' },
    errorCorrectionLevel: 'H',
  });
  res.json({ qrUrl: `/uploads/qr_${req.params.slug}.png`, pageUrl });
});

// ── ZİYARET / İSTATİSTİK API ──────────────────────────────────

// Ziyaret kaydet (müşteri sayfayı açınca)
app.post('/api/visit/:slug', (req, res) => {
  const visit = {
    slug: req.params.slug,
    ts: new Date(),
    ua: req.headers['user-agent'] || '',
    ip: req.ip,
  };
  db.visits.insert(visit, (err, doc) => res.json({ ok: true }));
});

// İstatistikler
app.get('/api/stats/:slug', (req, res) => {
  const slug = req.params.slug;
  db.visits.find({ slug }, (err, docs) => {
    const total = docs.length;
    const now   = new Date();
    const today = docs.filter(d => {
      const t = new Date(d.ts);
      return t.getDate() === now.getDate() &&
             t.getMonth() === now.getMonth() &&
             t.getFullYear() === now.getFullYear();
    });

    // Saatlik dağılım (son 24 saat)
    const hourly = Array(24).fill(0);
    today.forEach(d => {
      const h = new Date(d.ts).getHours();
      hourly[h]++;
    });

    // Son 30 ziyaret
    const recent = docs
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 30)
      .map(d => ({ ts: d.ts }));

    res.json({ total, todayTotal: today.length, hourly, recent });
  });
});

// ── REKLAM API ───────────────────────────────────────────────────────────────────────────────────────

// Tüm reklamları getir
app.get('/api/ads', (req, res) => {
  db.ads.find({}).sort({ createdAt: -1 }).exec((err, docs) => res.json(docs));
});

// Aktif reklamları getir (salon sayfası için)
app.get('/api/ads/active', (req, res) => {
  db.ads.find({ active: true }).exec((err, docs) => res.json(docs));
});

// Reklam ekle
app.post('/api/ads', upload.single('image'), (req, res) => {
  const { title, subtitle, link, type, bgColor } = req.body;
  const imageUrl = req.file ? '/uploads/' + req.file.filename : null;
  const ad = {
    _id: uuidv4(),
    title: (title || '').trim(),
    subtitle: (subtitle || '').trim(),
    link: (link || '').trim(),
    type: type || 'banner',   // 'banner' | 'popup' | 'inline'
    bgColor: bgColor || '#0ea5e9',
    imageUrl,
    active: true,
    createdAt: new Date(),
    clicks: 0,
    views: 0,
  };
  db.ads.insert(ad, (err, doc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(doc);
  });
});

// Reklam güncelle
app.put('/api/ads/:id', upload.single('image'), (req, res) => {
  const { title, subtitle, link, type, bgColor, active } = req.body;
  const update = { title, subtitle, link, type, bgColor };
  if (active !== undefined) update.active = active === 'true' || active === true;
  if (req.file) update.imageUrl = '/uploads/' + req.file.filename;
  db.ads.update({ _id: req.params.id }, { $set: update }, {}, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// Reklam sil
app.delete('/api/ads/:id', (req, res) => {
  db.ads.remove({ _id: req.params.id }, {}, (err) => res.json({ ok: true }));
});

// Reklam tıklama sayısı artır
app.post('/api/ads/:id/click', (req, res) => {
  db.ads.update({ _id: req.params.id }, { $inc: { clicks: 1 } }, {}, () => res.json({ ok: true }));
});

// Reklam gösterim sayısı artır
app.post('/api/ads/:id/view', (req, res) => {
  db.ads.update({ _id: req.params.id }, { $inc: { views: 1 } }, {}, () => res.json({ ok: true }));
});

// ── ÇALIŞAN API ─────────────────────────────────────────────────────────────────────────────────────

// Salona ait çalışanları getir
app.get('/api/staff/:slug', (req, res) => {
  db.staff.find({ salonSlug: req.params.slug }).sort({ createdAt: 1 }).exec((err, docs) => {
    res.json(docs);
  });
});

// Çalışan ekle
app.post('/api/staff/:slug', upload.single('photo'), (req, res) => {
  const { name, title, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'İsim zorunlu' });
  const photoUrl = req.file ? '/uploads/' + req.file.filename : null;
  const member = {
    _id: uuidv4(),
    salonSlug: req.params.slug,
    name: name.trim(),
    title: (title || '').trim(),
    phone: (phone || '').replace(/\s/g, ''),
    photoUrl,
    createdAt: new Date(),
  };
  db.staff.insert(member, (err, doc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(doc);
  });
});

// Çalışan sil
app.delete('/api/staff/:id', (req, res) => {
  db.staff.remove({ _id: req.params.id }, {}, (err) => res.json({ ok: true }));
});

// ── YORUM API ───────────────────────────────────────────────────────────────────────────────────────

// Yorum gönder
app.post('/api/reviews/:slug', (req, res) => {
  const { rating, comment, name } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Geçersiz puan' });
  const review = {
    slug: req.params.slug,
    rating: parseInt(rating),
    comment: (comment || '').trim().slice(0, 300),
    name: (name || 'Anonim').trim().slice(0, 40),
    ts: new Date(),
  };
  db.reviews.insert(review, (err, doc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, review: doc });
  });
});

// Yorumları getir
app.get('/api/reviews/:slug', (req, res) => {
  db.reviews.find({ slug: req.params.slug }).sort({ ts: -1 }).exec((err, docs) => {
    const total = docs.length;
    const avg   = total ? (docs.reduce((s, d) => s + d.rating, 0) / total).toFixed(1) : null;
    res.json({ avg: avg ? parseFloat(avg) : null, total, reviews: docs.slice(0, 20) });
  });
});

// Yorum sil (admin)
app.delete('/api/reviews/:id', (req, res) => {
  db.reviews.remove({ _id: req.params.id }, {}, (err) => res.json({ ok: true }));
});

// ── MÜŞTERİ MESAJ API ─────────────────────────────────────────────────────────────────────────────────────

// Mesaj gönder
app.post('/api/mesaj/:slug', (req, res) => {
  const { ad, telefon, mesaj } = req.body;
  if (!ad || !mesaj) return res.status(400).json({ error: 'Ad ve mesaj zorunludur.' });
  const doc = {
    _id: uuidv4(),
    slug: req.params.slug,
    ad: (ad || '').trim().slice(0, 60),
    telefon: (telefon || '').trim().slice(0, 20),
    mesaj: (mesaj || '').trim().slice(0, 500),
    okundu: false,
    ts: new Date(),
  };
  db.mesajlar.insert(doc, (err, newDoc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// İşletmenin mesajlarını getir (admin)
app.get('/api/mesajlar/:slug', (req, res) => {
  db.mesajlar.find({ slug: req.params.slug }).sort({ ts: -1 }).exec((err, docs) => res.json(docs));
});

// Mesaj okundu işaretle
app.put('/api/mesaj/:id/okundu', (req, res) => {
  db.mesajlar.update({ _id: req.params.id }, { $set: { okundu: true } }, {}, () => res.json({ ok: true }));
});

// Mesaj sil
app.delete('/api/mesaj/:id', (req, res) => {
  db.mesajlar.remove({ _id: req.params.id }, {}, () => res.json({ ok: true }));
});

// Tüm mesajları listele (admin genel bakış)
app.get('/api/mesajlar', (req, res) => {
  db.mesajlar.find({}).sort({ ts: -1 }).limit(200).exec((err, docs) => res.json(docs));
});

// ── BAŞVURU API ─────────────────────────────────────────────────────────────

// Yeni başvuru gönder (herkese açık)
app.post('/api/basvuru', (req, res) => {
  const { isletmeAdi, isletmeTuru, sahipAdi, telefon, adres, hizmetler, iban, banka, slug } = req.body;
  if (!isletmeAdi || !sahipAdi || !telefon) {
    return res.status(400).json({ error: 'İşletme adı, yetkili adı ve telefon zorunludur.' });
  }
  const basvuru = {
    _id: uuidv4(),
    isletmeAdi: (isletmeAdi || '').trim(),
    isletmeTuru: (isletmeTuru || '').trim(),
    sahipAdi: (sahipAdi || '').trim(),
    telefon: (telefon || '').trim(),
    adres: (adres || '').trim(),
    hizmetler: (hizmetler || '').trim(),
    iban: (iban || '').replace(/\s/g, ''),
    banka: (banka || '').trim(),
    slug: (slug || '').trim(),
    durum: 'bekliyor',   // 'bekliyor' | 'onaylandi' | 'reddedildi'
    createdAt: new Date(),
    notlar: '',
  };
  db.basvurular.insert(basvuru, (err, doc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, id: doc._id });
  });
});

// Tüm başvuruları listele (admin)
app.get('/api/basvurular', (req, res) => {
  db.basvurular.find({}).sort({ createdAt: -1 }).exec((err, docs) => res.json(docs));
});

// Başvuru onayla → salona dönüştür
app.post('/api/basvurular/:id/onayla', async (req, res) => {
  db.basvurular.findOne({ _id: req.params.id }, async (err, doc) => {
    if (!doc) return res.status(404).json({ error: 'Başvuru bulunamadı' });
    if (doc.durum === 'onaylandi') return res.status(400).json({ error: 'Zaten onaylandı' });

    // Slug oluştur
    const slugBase = doc.slug ? toSlug(doc.slug) : toSlug(doc.sahipAdi || doc.isletmeAdi);
    const slug = await generateSlug(slugBase || uuidv4().split('-')[0]);

    const salon = {
      _id: uuidv4(),
      slug,
      name: doc.isletmeAdi,
      ownerName: doc.sahipAdi,
      bank: doc.banka || '',
      iban: doc.iban || '',
      phone: doc.telefon,
      address: doc.adres || '',
      services: doc.hizmetler ? doc.hizmetler.split(',').map(s => ({ name: s.trim(), price: '' })).filter(s => s.name) : [],
      logoUrl: null,
      coverUrl: null,
      createdAt: new Date(),
      active: true,
    };

    db.salons.insert(salon, async (err2, newSalon) => {
      if (err2) return res.status(500).json({ error: err2.message });

      // QR kod oluştur
      try {
        const baseUrl = req.protocol + '://' + req.get('host');
        const pageUrl = `${baseUrl}/${slug}`;
        const qrPath  = path.join(__dirname, 'public/uploads', `qr_${slug}.png`);
        await QRCode.toFile(qrPath, pageUrl, { width: 400, margin: 2, errorCorrectionLevel: 'H' });
      } catch(e) { /* QR hatası kritik değil */ }

      // Başvuruyu güncelle
      db.basvurular.update({ _id: req.params.id }, { $set: { durum: 'onaylandi', salonSlug: slug, onayTarihi: new Date() } }, {}, () => {
        res.json({ ok: true, slug, salon: newSalon });
      });
    });
  });
});

// Başvuru reddet
app.post('/api/basvurular/:id/reddet', (req, res) => {
  const { notlar } = req.body;
  db.basvurular.update(
    { _id: req.params.id },
    { $set: { durum: 'reddedildi', notlar: notlar || '', redTarihi: new Date() } },
    {},
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

// Başvuru sil
app.delete('/api/basvurular/:id', (req, res) => {
  db.basvurular.remove({ _id: req.params.id }, {}, (err) => res.json({ ok: true }));
});

// ── SAYFA ROTALARI ─────────────────────────────────────────────

// Salon müşteri sayfası - eski /salon/:slug yolu (geriye dönük uyumluluk)
app.get('/salon/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/salon.html'));
});

// Salon müşteri sayfası - yeni kısa yol /:slug
app.get('/:slug', (req, res, next) => {
  const reserved = ['admin', 'api', 'uploads', 'favicon.ico'];
  if (reserved.includes(req.params.slug)) return next();
  // Slug uzunluğu kontrolü - çok kısa veya çok uzunsa atla
  if (req.params.slug.length < 2 || req.params.slug.length > 60) return next();
  // Salon var ya da yok, salon.html'i gönder (sayfa kendi içinde API'den kontrol eder)
  res.sendFile(path.join(__dirname, 'public/salon.html'));
});

// Admin paneli
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Ana sayfa → tanıtım sitesi
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Çabuk sunucusu çalışıyor: http://localhost:${PORT}`);
});
