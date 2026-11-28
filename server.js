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

let announcementsStore = [];

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

app.get('/api/user/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone || '').trim();
    const uRes = await pool.query(
      'SELECT id, full_name, phone, balance, created_at FROM users WHERE phone = $1',
      [phone]
    );
    const aRes = await pool.query(
      `SELECT id, phone, section, title, amount, tx_type, status, created_label, created_at
       FROM user_activities
       WHERE phone = $1
       ORDER BY id DESC
       LIMIT 100`,
      [phone]
    );
    const uRow = uRes.rows[0] || { phone, full_name: phone, balance: 0 };
    const history = aRes.rows.map((r) => ({
      id: r.id,
      section: r.section,
      title: r.title,
      amount: Number(r.amount || 0),
      type: r.status === 'approved' ? (r.section === 'deposit' ? 'plus' : 'minus') : r.status || 'pending',
      status: r.status || 'pending',
      time: r.created_label || new Date(r.created_at).toLocaleString(),
    }));
    res.json({
      success: true,
      user: {
        id: uRow.id,
        fullName: uRow.full_name,
        phone: uRow.phone,
        balance: Number(uRow.balance || 0),
        history,
      },
      announcements: announcementsStore,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const section = String(req.body.section || 'general').trim().toLowerCase();
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
          : status)
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

app.get('/api/admin/state', async (req, res) => {
  try {
    const uRes = await pool.query(
      'SELECT id, full_name, phone, balance, created_at FROM users ORDER BY id DESC'
    );
    const aRes = await pool.query(
      `SELECT id, phone, section, title, amount, tx_type, status, created_label, created_at
       FROM user_activities
       ORDER BY id DESC
       LIMIT 200`
    );

    const usersMap = {};
    uRes.rows.forEach((u) => {
      usersMap[u.phone] = {
        id: u.id,
        fullName: u.full_name,
        phone: u.phone,
        balance: Number(u.balance || 0),
        invested: 0,
        refBonus: 0,
        history: [],
      };
    });

    const deposits = [];
    const withdrawals = [];
    const packages = [];
    const referrals = [];

    aRes.rows.forEach((row) => {
      const sec = String(row.section || '').toLowerCase();
      const status = String(row.status || 'pending').toLowerCase();
      const amt = Number(row.amount || 0);
      const time = row.created_label || new Date(row.created_at).toLocaleString();

      if (usersMap[row.phone]) {
        usersMap[row.phone].history.push({
          id: row.id,
          section: sec,
          title: row.title,
          amount: amt,
          status,
          type: status === 'approved' ? (sec === 'deposit' ? 'plus' : 'minus') : status,
          time,
        });
        if (status === 'approved' && (sec === 'investment' || sec === 'package')) {
          usersMap[row.phone].invested += amt;
        }
      }

      const item = {
        id: row.id,
        username: row.phone,
        phone: row.phone,
        title: row.title,
        amount: amt,
        status,
        time,
      };

      if (sec === 'deposit') {
        item.method = row.title;
        deposits.push(item);
      } else if (sec === 'withdrawal') {
        item.method = row.title;
        item.fee = amt * 0.05;
        item.netPay = amt - amt * 0.05;
        withdrawals.push(item);
      } else if (sec === 'investment' || sec === 'package') {
        item.pkgName = row.title;
        packages.push(item);
      } else if (sec === 'referral') {
        referrals.push(item);
      }
    });

    res.json({
      success: true,
      users: usersMap,
      requests: {
        deposits,
        withdrawals,
        packages,
        referrals,
      },
      announcements: announcementsStore,
    });
  } catch (err) {
    console.error('Admin state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function handleDecideRequest(req, res, forcedKind = null) {
  try {
    const id = req.params.id || req.body.id;
    const action = String(req.body.action || '').trim().toLowerCase();
    if (!id || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Valid id and action (approve/reject) are required' });
    }

    const actRes = await pool.query(
      `SELECT id, phone, section, title, amount, status
       FROM user_activities
       WHERE id = $1`,
      [id]
    );
    if (actRes.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const act = actRes.rows[0];
    const sec = String(forcedKind || act.section || 'deposit').toLowerCase();
    const phone = String(act.phone || '').trim();
    const amt = Number(act.amount || 0);
    const prevStatus = String(act.status || 'pending').toLowerCase();

    if (action === 'approve' && prevStatus !== 'approved' && phone && amt > 0) {
      if (sec === 'deposit') {
        await pool.query(
          `UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE phone = $2`,
          [amt, phone]
        );
      } else if (sec === 'withdrawal' || sec === 'investment' || sec === 'package') {
        await pool.query(
          `UPDATE users SET balance = GREATEST(0, COALESCE(balance, 0) - $1) WHERE phone = $2`,
          [amt, phone]
        );
      }
    }

    const nextStatus = action === 'approve' ? 'approved' : 'rejected';
    const nextTxType =
      nextStatus === 'approved'
        ? sec === 'deposit'
          ? 'plus'
          : 'minus'
        : 'rejected';

    const updated = await pool.query(
      `UPDATE user_activities
       SET status = $1, tx_type = $2
       WHERE id = $3
       RETURNING id, phone, section, title, amount, tx_type, status, created_label, created_at`,
      [nextStatus, nextTxType, id]
    );

    res.json({ success: true, activity: updated.rows[0] });
  } catch (err) {
    console.error('Decide request error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

app.post('/api/admin/deposits/:id/decide', (req, res) => handleDecideRequest(req, res, 'deposit'));
app.post('/api/admin/withdrawals/:id/decide', (req, res) => handleDecideRequest(req, res, 'withdrawal'));
app.post('/api/admin/packages/:id/decide', (req, res) => handleDecideRequest(req, res, 'investment'));
app.post('/api/admin/referrals/:id/decide', (req, res) => handleDecideRequest(req, res, 'referral'));
app.post('/api/admin/approve', (req, res) => handleDecideRequest(req, res, null));

app.post('/api/admin/users/:phone/balance', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone || '').trim();
    const amt = Number(req.body.amount || 0);
    const mode = String(req.body.mode || 'add').toLowerCase();
    if (!phone || Number.isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Invalid phone or amount' });
    }
    const query =
      mode === 'sub'
        ? 'UPDATE users SET balance = GREATEST(0, COALESCE(balance, 0) - $1) WHERE phone = $2 RETURNING id, full_name, phone, balance'
        : 'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE phone = $2 RETURNING id, full_name, phone, balance';
    const r = await pool.query(query, [amt, phone]);
    res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone || '').trim();
    await pool.query('DELETE FROM user_activities WHERE phone = $1', [phone]);
    await pool.query('DELETE FROM users WHERE phone = $1', [phone]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/:kind/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query('DELETE FROM user_activities WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/announcements', (req, res) => {
  const msg = String(req.body.message || '').trim();
  if (!msg) return res.status(400).json({ error: 'Message is required' });
  const item = {
    id: 'ANN-' + Date.now(),
    message: msg,
    time: new Date().toLocaleString(),
  };
  announcementsStore.unshift(item);
  res.status(201).json({ success: true, announcement: item });
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
