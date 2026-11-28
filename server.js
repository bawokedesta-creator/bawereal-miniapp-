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
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_activities (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        section TEXT DEFAULT 'general',
        title TEXT NOT NULL,
        amount NUMERIC(12, 2),
        tx_type TEXT DEFAULT 'pending',
        status TEXT DEFAULT 'pending',
        created_label TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      ALTER TABLE user_activities ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'
    `);
    client.release();
    console.log('Aiven PostgreSQL Connected & tables ready');
  } catch (err) {
    console.error('Aiven PostgreSQL connection error:', err.message);
  }
}

function extractAmount(body) {
  const candidates = [
    body.amount,
    body.depositAmount,
    body.deposit_amount,
    body.amt,
    body.money,
    body.etb,
    body.value,
    body.cost,
  ];
  for (const val of candidates) {
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      const cleaned = String(val).replace(/[^0-9.]/g, '');
      const num = Number(cleaned);
      if (!Number.isNaN(num) && num > 0) {
        return num;
      }
    }
  }
  return null;
}

function extractPaymentAccount(body) {
  const candidates = [
    body.paymentAccount,
    body.payment_account,
    body.account,
    body.paymentMethod,
    body.payment_method,
    body.method,
    body.channel,
    body.provider,
    body.bank,
  ];
  for (const val of candidates) {
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return String(val).trim();
    }
  }
  return 'Telebirr / Bank';
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

    const row = result.rows[0];
    res.json({
      success: true,
      message: 'በተሳካ ሁኔታ ገብተዋል።',
      user: {
        id: row.id,
        fullName: row.full_name,
        phone: row.phone,
        balance: Number(row.balance || 0),
        created_at: row.created_at,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'የሰርቨር ስህተት አጋጥሟል።' });
  }
});

app.post('/api/activities', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    const section = String(req.body.section || 'general').trim();
    const title = String(req.body.title || 'Activity').trim();
    const rawAmt = req.body.amount;
    const amount =
      rawAmt !== undefined && rawAmt !== null && rawAmt !== '' && !Number.isNaN(Number(rawAmt))
        ? Number(rawAmt)
        : null;
    const status = String(req.body.status || 'pending').trim().toLowerCase();
    const txType = String(
      req.body.type ||
        req.body.tx_type ||
        (status === 'approved'
          ? section === 'deposit'
            ? 'plus'
            : 'minus'
          : 'pending')
    ).trim();
    const timeLabel = String(req.body.time || new Date().toLocaleString()).trim();

    if (!phone || !title) {
      return res.status(400).json({ error: 'phone and title are required' });
    }

    const inserted = await pool.query(
      `INSERT INTO user_activities (phone, section, title, amount, tx_type, status, created_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, phone, section, title, amount, tx_type, status, created_label, created_at`,
      [phone, section, title, amount, txType, status, timeLabel]
    );

    res.status(201).json({ success: true, activity: inserted.rows[0] });
  } catch (err) {
    console.error('Save activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/activities/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone || '').trim();
    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }
    const result = await pool.query(
      `SELECT id, phone, section, title, amount, tx_type, status, created_label, created_at
       FROM user_activities
       WHERE phone = $1
       ORDER BY id DESC
       LIMIT 100`,
      [phone]
    );
    res.json({ success: true, activities: result.rows });
  } catch (err) {
    console.error('Get activities error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve', async (req, res) => {
  try {
    const activityId = req.body.id;
    if (!activityId) {
      return res.status(400).json({ error: 'activity id is required' });
    }

    const actRes = await pool.query(
      `SELECT id, phone, section, title, amount, status
       FROM user_activities
       WHERE id = $1`,
      [activityId]
    );

    if (actRes.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const act = actRes.rows[0];
    const targetPhone = String(req.body.phone || act.phone || '').trim();
    const targetSection = String(req.body.section || act.section || 'deposit').trim().toLowerCase();
    const amt = Number(act.amount || 0);

    if (act.status !== 'approved' && targetPhone && amt > 0) {
      if (targetSection === 'deposit') {
        await pool.query(
          `UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE phone = $2`,
          [amt, targetPhone]
        );
      } else if (targetSection === 'withdrawal' || targetSection === 'investment' || targetSection === 'package') {
        await pool.query(
          `UPDATE users SET balance = GREATEST(0, COALESCE(balance, 0) - $1) WHERE phone = $2`,
          [amt, targetPhone]
        );
      }
    }

    const approvedSign = targetSection === 'deposit' ? 'plus' : 'minus';
    const updatedAct = await pool.query(
      `UPDATE user_activities
       SET status = 'approved', tx_type = $1
       WHERE id = $2
       RETURNING id, phone, section, title, amount, tx_type, status, created_label, created_at`,
      [approvedSign, activityId]
    );

    let updatedUser = null;
    if (targetPhone) {
      const uRes = await pool.query(
        'SELECT id, full_name, phone, balance, created_at FROM users WHERE phone = $1',
        [targetPhone]
      );
      if (uRes.rows.length > 0) {
        const u = uRes.rows[0];
        updatedUser = {
          id: u.id,
          fullName: u.full_name,
          phone: u.phone,
          balance: Number(u.balance || 0),
          created_at: u.created_at,
        };
      }
    }

    res.json({
      success: true,
      activity: updatedAct.rows[0],
      user: updatedUser,
    });
  } catch (err) {
    console.error('Approve activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject', async (req, res) => {
  try {
    const activityId = req.body.id;
    if (!activityId) {
      return res.status(400).json({ error: 'activity id is required' });
    }

    const updatedAct = await pool.query(
      `UPDATE user_activities
       SET status = 'rejected', tx_type = 'rejected'
       WHERE id = $1
       RETURNING id, phone, section, title, amount, tx_type, status, created_label, created_at`,
      [activityId]
    );

    if (updatedAct.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    res.json({ success: true, activity: updatedAct.rows[0] });
  } catch (err) {
    console.error('Reject activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function handleDeposit(req, res) {
  try {
    const body = req.body || {};
    const paymentAccount = extractPaymentAccount(body);
    const amount = extractAmount(body);
    const phone = (body.phone || body.phoneNumber || '').trim() || null;
    const userId = body.userId || body.user_id || null;
    const receiptImage =
      body.receiptImage ||
      body.receipt_image ||
      body.screenshot ||
      body.image ||
      body.screenshotDataUrl ||
      null;

    if (!amount) {
      return res.status(400).json({ error: 'እባክዎ ትክክለኛ የገንዘብ መጠን ያስገቡ።' });
    }

    const inserted = await pool.query(
      `INSERT INTO deposits (user_id, phone, payment_account, amount, receipt_image, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, user_id, phone, payment_account, amount, status, created_at`,
      [userId, phone, paymentAccount, amount, receiptImage]
    );

    res.status(201).json({
      success: true,
      message: 'Deposit pending',
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
