import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { io } from 'socket.io-client';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Frontend dosyalarını sun
app.use(express.static(path.join(__dirname, '../frontend')));

// ============================================
// VERİTABANI
// ============================================
const dbPath = path.join(__dirname, 'wallet.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ DB Hatası:', err.message);
  else console.log('✅ SQLite veritabanı hazır.');
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
// ALTIN FİYAT HARİTASI
// ============================================
const haremMapping = {
  gramaltin: { name: 'Gram Altın', code: 'ALTIN' },
  hasaltin: { name: 'Has Altın', code: 'HAS' },
  ons: { name: 'Altın ONS', code: 'ONS' },
  yeniceyrek: { name: 'Yeni Çeyrek Altın', code: 'CEYREK_YENI' },
  eskiceyrek: { name: 'Eski Çeyrek Altın', code: 'CEYREK_ESKI' },
  ceyrek: { name: 'Çeyrek Altın', code: 'CEYREK_YENI' },
  yeniyarim: { name: 'Yeni Yarım Altın', code: 'YARIM_YENI' },
  eskiyarim: { name: 'Eski Yarım Altın', code: 'YARIM_ESKI' },
  yarim: { name: 'Yarım Altın', code: 'YARIM_YENI' },
  yenitam: { name: 'Yeni Tam Altın', code: 'TEK_YENI' },
  eskitam: { name: 'Eski Tam Altın', code: 'TEK_ESKI' },
  tek: { name: 'Tam Altın', code: 'TEK_YENI' },
  yeniata: { name: 'Yeni Ata', code: 'ATA_YENI' },
  eskiata: { name: 'Eski Ata', code: 'ATA_ESKI' },
  ata: { name: 'Ata Altını', code: 'ATA_YENI' },
  yeniata5: { name: "Yeni 5'li Ata", code: 'ATA5_YENI' },
  eskiata5: { name: "Eski 5'li Ata", code: 'ATA5_ESKI' },
  ata5li: { name: "5'li Ata", code: 'ATA5_YENI' },
  yenigremse: { name: 'Yeni Gremse', code: 'GREMESE_YENI' },
  eskigremse: { name: 'Eski Gremse', code: 'GREMESE_ESKI' },
  gremese: { name: 'Gremse', code: 'GREMESE_YENI' },
  '14ayar': { name: '14 Ayar', code: 'AYAR14' },
  '22ayar': { name: '22 Ayar', code: 'AYAR22' },
  gumustl: { name: 'Gümüş (TL)', code: 'GUMUSTRY' }
};

let latestPrices = {};
let wsConnected = false;
let lastUpdate = null;

// ============================================
// 1. HAREM ALTIN WEBSOCKET (Ana kaynak)
// ============================================
function connectHaremWebSocket() {
  const socket = io('wss://hrmsocketonly.haremaltin.com', {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 10000
  });

  socket.on('connect', () => {
    console.log('🔗 Harem Altın WebSocket bağlandı');
    wsConnected = true;
  });

  socket.on('price_changed', (res) => {
    if (res && res.data) {
      const prices = {};
      for (const [key, item] of Object.entries(haremMapping)) {
        const row = res.data[item.code];
        if (row) {
          const buy = typeof row.alis === 'string'
            ? parseFloat(row.alis.replace(/\./g, '').replace(',', '.'))
            : (parseFloat(row.alis) || 0);
          const sell = typeof row.satis === 'string'
            ? parseFloat(row.satis.replace(/\./g, '').replace(',', '.'))
            : (parseFloat(row.satis) || 0);

          prices[key] = {
            name: item.name,
            buy,
            sell,
            change: row.degisim || '%0,00'
          };
        }
      }
      if (Object.keys(prices).length > 0) {
        latestPrices = prices;
        lastUpdate = new Date();
        console.log('✅ WebSocket verisi alındı:', Object.keys(prices).length, 'altın');
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('⚠️ WebSocket koptu, REST fallback aktif');
    wsConnected = false;
  });

  socket.on('connect_error', (err) => {
    console.log('❌ WebSocket hata:', err.message);
    wsConnected = false;
  });
}

// ============================================
// 2. HAREM ALTIN REST FALLBACK (WebSocket çalışmazsa)
// ============================================
async function fetchHaremREST() {
  try {
    const res = await axios.get('https://canlipiyasalar.haremaltin.com/', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(res.data);
    const prices = {};

    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 3) {
        const name = $(cells[0]).text().trim();
        const buyText = $(cells[1]).text().trim().replace(/\./g, '').replace(',', '.');
        const sellText = $(cells[2]).text().trim().replace(/\./g, '').replace(',', '.');
        const changeText = $(cells[3]) ? $(cells[3]).text().trim() : '';

        const buy = parseFloat(buyText) || 0;
        const sell = parseFloat(sellText) || 0;

        if (name && name.length > 1 && (buy > 0 || sell > 0)) {
          let key = name.toLowerCase()
            .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
            .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
            .replace(/[^a-z0-9]/g, '');

          prices[key] = { name, buy, sell, change: changeText };
        }
      }
    });

    if (Object.keys(prices).length > 0) {
      latestPrices = prices;
      lastUpdate = new Date();
      console.log('✅ REST verisi alındı:', Object.keys(prices).length, 'altın');
      return true;
    }
    return false;
  } catch (e) {
    console.log('❌ REST hata:', e.message);
    return false;
  }
}

// ============================================
// 3. GRAMVEY FALLBACK (Son çare)
// ============================================
async function fetchGramvey() {
  try {
    const res = await axios.get('https://goldapi.gramvey.com/golds', { timeout: 10000 });
    const data = res.data;
    const mapped = {};

    data.forEach(item => {
      mapped[item.key] = {
        name: item.name,
        buy: parseFloat(item.buyingPrice),
        sell: parseFloat(item.sellingPrice),
        change: item.oneDayChange
      };
    });

    latestPrices = mapped;
    lastUpdate = new Date();
    console.log('✅ Gramvey verisi alındı:', Object.keys(mapped).length, 'altın');
    return true;
  } catch (e) {
    console.log('❌ Gramvey hata:', e.message);
    return false;
  }
}

// ============================================
// ANA VERİ ÇEKME DÖNGÜSÜ
// ============================================
async function updatePrices() {
  // WebSocket bağlıysa veri zaten geliyordur
  if (wsConnected && lastUpdate && (Date.now() - lastUpdate.getTime() < 30000)) {
    return; // Son 30sn içinde veri geldi, atla
  }

  // WebSocket kopuksa veya veri eskiyse REST dene
  console.log('⏳ Veri güncelleniyor...');
  const haremOk = await fetchHaremREST();
  if (!haremOk) {
    await fetchGramvey();
  }
}

// Başlat
connectHaremWebSocket();
// WebSocket yedek olarak her 15sn'de REST kontrolü
setInterval(updatePrices, 15000);

// ============================================
// AUTH
// ============================================
const JWT_SECRET = process.env.JWT_SECRET || 'GIZLI_ANAHTAR_123';

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Giriş yapmalısın' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(403).json({ error: 'Geçersiz token' });
  }
}

// ============================================
// API ROUTES
// ============================================
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-posta ve şifre zorunlu' });

  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
    if (err) return res.status(400).json({ error: 'Bu e-posta zaten kayıtlı' });
    res.json({ id: this.lastID, email });
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, email: user.email });
  });
});

app.post('/api/investments', auth, (req, res) => {
  const { goldType, tradeType, amount, price } = req.body;
  if (!goldType || !tradeType || !amount || !price) {
    return res.status(400).json({ error: 'Tüm alanlar zorunlu' });
  }

  db.run(
    'INSERT INTO investments (user_id, gold_type, trade_type, amount, buy_price) VALUES (?, ?, ?, ?, ?)',
    [req.userId, goldType, tradeType, amount, price],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

app.get('/api/portfolio', auth, (req, res) => {
  db.all('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    let totalInvested = 0;
    let totalCurrent = 0;

    const list = (rows || []).map(inv => {
      const p = latestPrices[inv.gold_type] || { sell: 0 };
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

app.delete('/api/investments/:id', auth, (req, res) => {
  db.run('DELETE FROM investments WHERE id = ? AND user_id = ?', [req.params.id, req.userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.get('/api/prices', (req, res) => {
  res.json({
    prices: latestPrices,
    connected: wsConnected,
    lastUpdate: lastUpdate ? lastUpdate.toISOString() : null,
    source: wsConnected ? 'websocket' : (Object.keys(latestPrices).length > 0 ? 'rest' : 'none')
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    websocket: wsConnected,
    pricesCount: Object.keys(latestPrices).length,
    lastUpdate: lastUpdate ? lastUpdate.toISOString() : null
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
  console.log('⏳ Harem Altın verileri çekiliyor...');
});
