import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { io } from 'socket.io-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Frontend (HTML) dosyalarını sun
app.use(express.static(path.join(__dirname, '../frontend')));

// ============================================
// VERİTABANI BAŞLATMA
// ============================================
const dbPath = path.join(__dirname, 'wallet.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ DB Hatası:', err.message);
  } else {
    console.log('✅ SQLite veritabanı hazır.');
  }
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gold_type TEXT NOT NULL,
    trade_type TEXT NOT NULL,
    amount REAL NOT NULL,
    buy_price REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ============================================
// HAREM ALTIN CANLI WEBSOCKET ENTEGRASYONU
// ============================================
let latestPrices = {};

const haremMapping = {
  'gramaltin': { name: 'Gram Altın', code: 'ALTIN' },
  'hasaltin': { name: 'Has Altın', code: 'ALTIN' },
  'ons': { name: 'Altın ONS', code: 'ONS' },
  'yeniceyrek': { name: 'Yeni Çeyrek Altın', code: 'CEYREK_YENI' },
  'eskiceyrek': { name: 'Eski Çeyrek Altın', code: 'CEYREK_ESKI' },
  'ceyrek': { name: 'Çeyrek Altın', code: 'CEYREK_YENI' },
  'yeniyarim': { name: 'Yeni Yarım Altın', code: 'YARIM_YENI' },
  'eskiyarim': { name: 'Eski Yarım Altın', code: 'YARIM_ESKI' },
  'yarim': { name: 'Yarım Altın', code: 'YARIM_YENI' },
  'yenitam': { name: 'Yeni Tam Altın', code: 'TEK_YENI' },
  'eskitam': { name: 'Eski Tam Altın', code: 'TEK_ESKI' },
  'tek': { name: 'Tam Altın', code: 'TEK_YENI' },
  'yeniata': { name: 'Yeni Ata', code: 'ATA_YENI' },
  'eskiata': { name: 'Eski Ata', code: 'ATA_ESKI' },
  'ata': { name: 'Ata Altını', code: 'ATA_YENI' },
  'yeniata5': { name: "Yeni 5'li Ata", code: 'ATA5_YENI' },
  'eskiata5': { name: "Eski 5'li Ata", code: 'ATA5_ESKI' },
  'ata5li': { name: "5'li Ata", code: 'ATA5_YENI' },
  'yenigremse': { name: 'Yeni Gremse', code: 'GREMESE_YENI' },
  'eskigremse': { name: 'Eski Gremse', code: 'GREMESE_ESKI' },
  'gremese': { name: 'Gremse', code: 'GREMESE_YENI' },
  '14ayar': { name: '14 Ayar', code: 'AYAR14' },
  '22ayar': { name: '22 Ayar', code: 'AYAR22' },
  'gumustl': { name: 'Gümüş (TL)', code: 'GUMUSTRY' }
};

// Harem Altın canlı soket bağlantısı
const haremSocket = io('wss://hrmsocketonly.haremaltin.com', {
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});

haremSocket.on('connect', () => {
  console.log('🔗 Harem Altın Canlı Yayınına Bağlanıldı!');
});

haremSocket.on('price_changed', (res) => {
  if (res && res.data) {
    const prices = {};
    for (const [key, item] of Object.entries(haremMapping)) {
      const row = res.data[item.code];
      if (row) {
        const buy = typeof row.alis === 'string' ? parseFloat(row.alis.replace(/\./g, '').replace(',', '.')) : (parseFloat(row.alis) || 0);
        const sell = typeof row.satis === 'string' ? parseFloat(row.satis.replace(/\./g, '').replace(',', '.')) : (parseFloat(row.satis) || 0);
        
        let changeText = '%0,00';
        if (row.dusuk && row.yuksek && buy > 0) {
          const chg = row.dir?.satis_dir === 'down' ? '- ' : '+ ';
          changeText = chg + (row.tarih ? row.tarih.split(' ')[1] : '');
        }
        
        prices[key] = {
          name: item.name,
          buy,
          sell,
          change: changeText
        };
      }
    }
    if (Object.keys(prices).length > 0) {
      latestPrices = prices;
    }
  }
});

haremSocket.on('disconnect', (reason) => {
  console.log('⚠️ Harem Altın bağlantısı koptu, yeniden bağlanılıyor...', reason);
});

// ============================================
// GİRİŞ KONTROLÜ (TOKEN)
// ============================================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Giriş yapmalısın' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'GIZLI_ANAHTAR_123');
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(403).json({ error: 'Geçersiz token' });
  }
}

// KAYIT OL
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-posta ve şifre zorunlu' });
  const hash = bcrypt.hashSync(password, 10);
  
  db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
    if (err) return res.status(400).json({ error: 'Bu e-posta zaten kayıtlı' });
    res.json({ id: this.lastID, email });
  });
});

// GİRİŞ YAP
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    }
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'GIZLI_ANAHTAR_123');
    res.json({ token, email: user.email });
  });
});

// YATIRIM EKLE
app.post('/api/investments', auth, (req, res) => {
  const { goldType, tradeType, amount, price } = req.body;
  
  db.run(
    'INSERT INTO investments (user_id, gold_type, trade_type, amount, buy_price) VALUES (?, ?, ?, ?, ?)',
    [req.userId, goldType, tradeType, amount, price],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

// PORTFÖYÜ GETİR
app.get('/api/portfolio', auth, (req, res) => {
  db.all('SELECT * FROM investments WHERE user_id = ?', [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    let totalInvested = 0;
    let totalCurrent = 0;
    
    const list = (rows || []).map(inv => {
      let key = inv.gold_type.toLowerCase()
        .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
        .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/[^a-z0-9]/g, '');
      
      const p = latestPrices[key] || { sell: 0 };
      const currentPrice = p.sell;
      const invested = inv.amount * inv.buy_price;
      const current = inv.amount * currentPrice;
      
      let pnl, pnlPercent;
      if (inv.trade_type === 'buy') {
        pnl = current - invested;
        pnlPercent = inv.buy_price > 0 ? ((currentPrice - inv.buy_price) / inv.buy_price) * 100 : 0;
      } else {
        pnl = invested - current;
        pnlPercent = inv.buy_price > 0 ? ((inv.buy_price - currentPrice) / inv.buy_price) * 100 : 0;
      }
      
      totalInvested += invested;
      totalCurrent += current;
      
      return { ...inv, currentPrice, invested, current, pnl, pnlPercent };
    });
    
    res.json({
      investments: list,
      summary: { totalInvested, totalCurrent, totalPnL: totalCurrent - totalInvested }
    });
  });
});

// YATIRIM SİL
app.delete('/api/investments/:id', auth, (req, res) => {
  db.run('DELETE FROM investments WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// CANLI FİYATLARI VER
app.get('/api/prices', (req, res) => {
  res.json(latestPrices);
});

// Sayfa yenilendiğinde index.html'e yönlendir
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// SUNUCUYU BAŞLAT
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda Harem Altın canlı yayınıyla aktif!`);
});
