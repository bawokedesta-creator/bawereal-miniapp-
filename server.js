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
