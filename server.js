const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
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
    client.release();
    console.log('Aiven PostgreSQL Connected & users table ready');
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
    res.status(500).json({ error: 'የሰርቨር ወይም የዳታቤዝ ስህተት አጋጥሟል።' });
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`EthioInvest backend running on port ${PORT}`);
  initDB();
});
