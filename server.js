const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(__dirname));

const rawConnectionString = process.env.DATABASE_URL || '';
const cleanConnectionString = rawConnectionString
  .replace(/([?&])sslmode=[^&]*(&|$)/i, (match, p1, p2) => (p2 ? p1 : ''))
  .replace(/[?&]$/, '');

const pool = new Pool({
  connectionString: cleanConnectionString,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set in Environment Variables');
    return;
  }
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        balance NUMERIC(12, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        phone TEXT,
        payment_account TEXT NOT NULL,
        amount NUMERIC(12, 2) NOT NULL,
        receipt_image TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    client.release();
    console.log('Aiven PostgreSQL Connected & tables ready');
  } catch (err) {
    console.error('Aiven PostgreSQL connection error:', err.message);
  }
}

app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');
    res.json({
      status: 'ok',
      database: 'Aiven PostgreSQL Connected',
      server_time: result.rows[0].server_time,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      database: 'Disconnected',
      error: err.message,
    });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, phone, balance, created_at FROM users ORDER BY id DESC'
    );
    res.json({
      success: true,
      count: result.rows.length,
      users: result.rows,
    });
  } catch (err) {
    console.error('Get users error:', err.message);
    res.status(500).json({ error: err.message || 'የተጠቃሚዎችን ዝርዝር ማምጣት አልተቻለም።' });
  }
});

app.get('/api/users.html', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, phone, balance, created_at FROM users ORDER BY id DESC'
    );
    const rowsHtml = result.rows
      .map(
        (u) => `
          <tr>
            <td>${u.id}</td>
            <td>${u.full_name}</td>
            <td>${u.phone}</td>
            <td>${u.balance} ETB</td>
            <td>${new Date(u.created_at).toLocaleString()}</td>
          </tr>`
      )
      .join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="am">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>EthioInvest - Registered Users</title>
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; }
          h2 { margin-bottom: 12px; }
          table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
          th, td { padding: 10px 12px; border-bottom: 1px solid #334155; text-align: left; font-size: 14px; }
          th { background: #065f46; color: #ecfdf5; }
        </style>
      </head>
      <body>
        <h2>የተመዘገቡ ተጠቃሚዎች (${result.rows.length})</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Full Name</th>
              <th>Phone</th>
              <th>Balance</th>
              <th>Created At</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="5">እስካሁን የተመዘገበ ተጠቃሚ የለም።</td></tr>'}
          </tbody>
        </table>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const fullName = (req.body.fullName || req.body.full_name || '').trim();
    const phone = (req.body.phone || req.body.phoneNumber || '').trim();
    const password = req.body.password || '';

    if (!fullName || !phone || !password) {
      return res.status(400).json({ error: 'ሙሉ ስም፣ ስልክ ቁጥር እና ፓስወርድ ያስፈልጋሉ።' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'ይህ ስልክ ቁጥር ቀደም ብሎ ተመዝግቧል።' });
    }

    const inserted = await pool.query(
      `INSERT INTO users (full_name, phone, password)
       VALUES ($1, $2, $3)
       RETURNING id, full_name, phone, balance, created_at`,
      [fullName, phone, password]
    );

    res.status(201).json({
      success: true,
      message: 'አካውንት በተሳካ ሁኔታ ተፈጥሯል።',
      user: inserted.rows[0],
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: err.message || 'የሰርቨር ወይም የዳታቤዝ ስህተት አጋጥሟል።' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const phone = (req.body.phone || req.body.phoneNumber || '').trim();
    const password = req.body.password || '';

    if (!phone || !password) {
      return res.status(400).json({ error: 'ስልክ ቁጥር እና ፓስወርድ ያስፈልጋሉ።' });
    }

    const result = await pool.query(
      'SELECT id, full_name, phone, balance, created_at FROM users WHERE phone = $1 AND password = $2',
      [phone, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'ስልክ ቁጥር ወይም ፓስወርድ የተሳሳተ ነው።' });
    }

    res.json({
      success: true,
      message: 'በተሳካ ሁኔታ ገብተዋል።',
      user: result.rows[0],
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'የሰርቨር ስህተት አጋጥሟል።' });
  }
});

async function handleDeposit(req, res) {
  try {
    const paymentAccount = (
      req.body.paymentAccount ||
      req.body.payment_account ||
      req.body.account ||
      ''
    ).trim();
    const amount = Number(req.body.amount);
    const phone = (req.body.phone || req.body.phoneNumber || '').trim() || null;
    const userId = req.body.userId || req.body.user_id || null;
    const receiptImage =
      req.body.receiptImage ||
      req.body.receipt_image ||
      req.body.screenshot ||
      req.body.image ||
      null;

    if (!paymentAccount || !amount || Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'የክፍያ አካውንት እና ትክክለኛ የገንዘብ መጠን ያስፈልጋሉ።' });
    }

    const inserted = await pool.query(
      `INSERT INTO deposits (user_id, phone, payment_account, amount, receipt_image)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, phone, payment_account, amount, status, created_at`,
      [userId, phone, paymentAccount, amount, receiptImage]
    );

    res.status(201).json({
      success: true,
      message: 'የ Deposit ጥያቄ በተሳካ ሁኔታ ተልኳል።',
      deposit: inserted.rows[0],
    });
  } catch (err) {
    console.error('Deposit error:', err.message);
    res.status(500).json({ error: err.message || 'የ Deposit መረጃ ማስቀመጥ አልተቻለም።' });
  }
}

app.post('/api/deposits', handleDeposit);
app.post('/api/deposit', handleDeposit);
app.post('/deposit', handleDeposit);

app.get('/api/deposits', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, user_id, phone, payment_account, amount, status, created_at FROM deposits ORDER BY id DESC'
    );
    res.json({
      success: true,
      count: result.rows.length,
      deposits: result.rows,
    });
  } catch (err) {
    console.error('Get deposits error:', err.message);
    res.status(500).json({ error: err.message || 'የ Deposit ዝርዝር ማምጣት አልተቻለም።' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`EthioInvest backend running on port ${PORT}`);
  initDB();
});
