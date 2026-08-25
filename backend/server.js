import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Frontend (HTML arayüzü) dosyalarını doğrudan sun
app.use(express.static(path.join(__dirname, '../frontend')));

// ============================================
// VERİTABANI BAŞLATMA (OTOMATİK ONARIMLI)
// ============================================
const dbPath = path.join(__dirname, 'database.sqlite');

// Eğer dosya boş (0 byte) ise veya bozulmuşsa sıfırla
try {
  if (fs.existsSync(dbPath)) {
    const stats = fs.statSync(dbPath);
    if (stats.size === 0) {
      fs.unlinkSync(dbPath);
      console.log('⚠️ Boş veritabanı temizlendi, yeniden oluşturuluyor...');
    }
  }
} catch (e) {
  console.log('DB kontrolü:', e.message);
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ DB Bağlantı Hatası:', err.message);
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
// CANLI ALTIN FİYATLARI
// ============================================
let latestPrices = {};

const mapping = {
  'gramaltin': { name: 'Gram Altın', key: 'GRA' },
  'hasaltin': { name: 'Has Altın', key: 'HAS' },
  'ons': { name: 'Altın ONS', key: 'ONS' },
  'ceyrek': { name: 'Çeyrek Altın', key: 'CEYREKALTIN' },
  'yeniceyrek': { name: 'Yeni Çeyrek Altın', key: 'CEYREKALTIN' },
  'eskiceyrek': { name: 'Eski Çeyrek Altın', key: 'CEYREKALTIN' },
  'yarim': { name: 'Yarım Altın', key: 'YARIMALTIN' },
  'yeniyarim': { name: 'Yeni Yarım Altın', key: 'YARIMALTIN' },
  'eskiyarim': { name: 'Eski Yarım Altın', key: 'YARIMALTIN' },
  'tek': { name: 'Tam Altın', key: 'TAMALTIN' },
  'yenitam': { name: 'Yeni Tam Altın', key: 'TAMALTIN' },
  'eskitam': { name: 'Eski Tam Altın', key: 'TAMALTIN' },
  'ata': { name: 'Ata Altını', key: 'ATAALTIN' },
  'yeniata': { name: 'Yeni Ata', key: 'ATAALTIN' },
  'eskiata': { name: 'Eski Ata', key: 'ATAALTIN' },
  'yeniata5': { name: "Yeni 5'li Ata", key: 'BESLIALTIN' },
  'eskiata5': { name: "Eski 5'li Ata", key: 'BESLIALTIN' },
  'ata5li': { name: "5'li Ata", key: 'BESLIALTIN' },
  'yenigremse': { name: 'Yeni Gremse', key: 'GREMSEALTIN' },
  'eskigremse': { name: 'Eski Gremse', key: 'GREMSEALTIN' },
  'gremese': { name: 'Gremse', key: 'GREMSEALTIN' },
  '14ayar': { name: '14 Ayar', key: '14AYARALTIN' },
  '22ayar': { name: '22 Ayar', key: 'YIA' },
  'gumustl': { name: 'Gümüş (TL)', key: 'GUMUS' }
};

function fetchLivePrices() {
  https.get('https://finans.truncgil.com/v4/today.json', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const prices = {};
        for (const [id, item] of Object.entries(mapping)) {
          const raw = json[item.key];
          if (raw) {
            const buy = typeof raw.Alış === 'string' ? parseFloat(raw.Alış.replace(/\./g, '').replace(',', '.')) : (parseFloat(raw.Buying) || parseFloat(raw.Alış) || 0);
            const sell = typeof raw.Satış === 'string' ? parseFloat(raw.Satış.replace(/\./g, '').replace(',', '.')) : (parseFloat(raw.Selling) || parseFloat(raw.Satış) || 0);
            const change = raw.Değişim || raw.Change || '%0,00';
            prices[id] = { name: item.name, buy, sell, change };
          }
        }
        if (Object.keys(prices).length > 0) {
          latestPrices = prices;
        }
      } catch (e) {
        console.error('Fiyat parse hatası:', e.message);
      }
    });
  }).on('error', (err) => {
    console.error('Fiyat bağlantı hatası:', err.message);
  });
}

fetchLivePrices();
setInterval(fetchLivePrices, 5000);

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
  console.log(`🚀 Sunucu ${PORT} portunda aktif!`);
});
