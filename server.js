const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const db = {
  users: {},
  deposits: [],
  withdrawals: [],
  referrals: [],
  announcements: []
};

app.get("/", (req, res) => {
  res.json({ ok: true, service: "EthioInvest Backend" });
});

// Register (prevents duplicate phone numbers)
app.post("/api/register", (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "Phone and password are required" });
  }
  if (db.users[phone]) {
    return res.status(409).json({ error: "Already registered" });
  }
  db.users[phone] = {
    phone,
    password,
    balance: 0,
    invested: 0,
    refBonus: 0,
    history: [],
    seenAnnouncementIds: []
  };
  return res.status(201).json({ ok: true, user: { phone, balance: 0 } });
});

// Login
app.post("/api/login", (req, res) => {
  const { phone, password } = req.body;
  const user = db.users[phone];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Invalid phone or password" });
  }
  return res.json({ ok: true, user });
});

// Reset password
app.post("/api/reset-password", (req, res) => {
  const { phone, newPassword } = req.body;
  const user = db.users[phone];
  if (!user) {
    return res.status(404).json({ error: "Phone not found" });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: "Password too short" });
  }
  user.password = newPassword;
  return res.json({ ok: true });
});

// Submit deposit (stays pending until Admin approves)
app.post("/api/deposits", (req, res) => {
  const { phone, method, amount, screenshotName, screenshotDataUrl } = req.body;
  const user = db.users[phone];
  const amt = Number(amount);

  if (!user || !method || isNaN(amt) || amt <= 0 || !screenshotDataUrl) {
    return res.status(400).json({ error: "Invalid deposit data or missing screenshot" });
  }

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const item = {
    id: "dep_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    username: phone,
    method,
    amount: amt,
    screenshotName: screenshotName || "receipt.png",
    screenshotDataUrl,
    status: "pending",
    appliedToBalance: false,
    time
  };

  db.deposits.unshift(item);
  user.history.unshift({
    title: `Deposit Pending Admin (${method}) • ${item.screenshotName}`,
    amount: amt,
    type: "plus",
    time
  });

  return res.status(201).json({ ok: true, item, user });
});

// Admin approve or reject deposit
app.post("/api/admin/deposits/:id/decide", (req, res) => {
  const { action } = req.body;
  const item = db.deposits.find(d => d.id === req.params.id);
  if (!item || !db.users[item.username]) {
    return res.status(404).json({ error: "Deposit not found" });
  }

  const user = db.users[item.username];
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const amt = Number(item.amount || 0);

  if (action === "approve") {
    if (!item.appliedToBalance) {
      user.balance = Number(user.balance || 0) + amt;
      user.history.unshift({
        title: `Admin Approved Deposit (${item.method})`,
        amount: amt,
        type: "plus",
        time
      });
      item.appliedToBalance = true;
    }
    item.status = "approved";
  } else if (action === "reject") {
    if (item.appliedToBalance) {
      user.balance = Math.max(0, Number(user.balance || 0) - amt);
      user.history.unshift({
        title: `Admin Rejected Deposit (${item.method})`,
        amount: amt,
        type: "minus",
        time
      });
      item.appliedToBalance = false;
    }
    item.status = "rejected";
  }

  return res.json({ ok: true, item, user });
});

// Delete deposit
app.delete("/api/admin/deposits/:id", (req, res) => {
  db.deposits = db.deposits.filter(d => d.id !== req.params.id);
  return res.json({ ok: true });
});

// Submit withdrawal (5% fee, Net Pay; refunded if Admin rejects)
app.post("/api/withdrawals", (req, res) => {
  const { phone, method, account, amount } = req.body;
  const user = db.users[phone];
  const amt = Number(amount);

  if (!user || !account || isNaN(amt) || amt <= 0 || amt > user.balance) {
    return res.status(400).json({ error: "Invalid withdrawal or insufficient balance" });
  }

  const fee = amt * 0.05;
  const netPay = amt - fee;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  user.balance = Number(user.balance || 0) - amt;
  user.history.unshift({
    title: `Withdraw Pending Admin (${method}: ${account}) | Net = ${netPay.toFixed(2)}`,
    amount: amt,
    type: "minus",
    time
  });

  const item = {
    id: "with_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    username: phone,
    method,
    account,
    amount: amt,
    fee,
    netPay,
    status: "pending",
    deductedFromBalance: true,
    time
  };

  db.withdrawals.unshift(item);
  return res.status(201).json({ ok: true, item, user });
});

// Admin approve or reject withdrawal
app.post("/api/admin/withdrawals/:id/decide", (req, res) => {
  const { action } = req.body;
  const item = db.withdrawals.find(w => w.id === req.params.id);
  if (!item || !db.users[item.username]) {
    return res.status(404).json({ error: "Withdrawal not found" });
  }

  const user = db.users[item.username];
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const amt = Number(item.amount || 0);

  if (action === "approve") {
    item.status = "approved";
    user.history.unshift({
      title: `Admin Approved Withdraw (${item.method}) | Net Pay = ${Number(item.netPay).toFixed(2)} ETB`,
      amount: amt,
      type: "minus",
      time
    });
  } else if (action === "reject") {
    if (item.deductedFromBalance) {
      user.balance = Number(user.balance || 0) + amt;
      item.deductedFromBalance = false;
    }
    item.status = "rejected";
    user.history.unshift({
      title: `Admin Rejected Withdraw (Refunded ${item.method})`,
      amount: amt,
      type: "plus",
      time
    });
  }

  return res.json({ ok: true, item, user });
});

// Delete withdrawal
app.delete("/api/admin/withdrawals/:id", (req, res) => {
  db.withdrawals = db.withdrawals.filter(w => w.id !== req.params.id);
  return res.json({ ok: true });
});

// Referral bonus request
app.post("/api/referrals", (req, res) => {
  const { phone, refLink } = req.body;
  const user = db.users[phone];
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const bonus = 100;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const item = {
    id: "ref_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    username: phone,
    amount: bonus,
    refLink: refLink || `https://ethioinvest.app/?ref=${encodeURIComponent(phone)}`,
    status: "pending",
    appliedToBalance: false,
    time
  };

  db.referrals.unshift(item);
  user.history.unshift({
    title: "Referral Request (+100 ETB) - Pending Admin",
    amount: bonus,
    type: "plus",
    time
  });

  return res.status(201).json({ ok: true, item, user });
});

// Admin approve or reject referral
app.post("/api/admin/referrals/:id/decide", (req, res) => {
  const { action } = req.body;
  const item = db.referrals.find(r => r.id === req.params.id);
  if (!item || !db.users[item.username]) {
    return res.status(404).json({ error: "Referral not found" });
  }

  const user = db.users[item.username];
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const bonus = Number(item.amount || 100);

  if (action === "approve") {
    if (!item.appliedToBalance) {
      user.balance = Number(user.balance || 0) + bonus;
      user.refBonus = Number(user.refBonus || 0) + bonus;
      user.history.unshift({
        title: "Admin Approved Referral Bonus",
        amount: bonus,
        type: "plus",
        time
      });
      item.appliedToBalance = true;
    }
    item.status = "approved";
  } else if (action === "reject") {
    if (item.appliedToBalance) {
      user.balance = Math.max(0, Number(user.balance || 0) - bonus);
      user.refBonus = Math.max(0, Number(user.refBonus || 0) - bonus);
      user.history.unshift({
        title: "Admin Rejected Referral Bonus",
        amount: bonus,
        type: "minus",
        time
      });
      item.appliedToBalance = false;
    }
    item.status = "rejected";
  }

  return res.json({ ok: true, item, user });
});

// Delete referral
app.delete("/api/admin/referrals/:id", (req, res) => {
  db.referrals = db.referrals.filter(r => r.id !== req.params.id);
  return res.json({ ok: true });
});

// Manual balance adjustment by Admin
app.post("/api/admin/users/:phone/balance", (req, res) => {
  const { amount, mode } = req.body;
  const user = db.users[req.params.phone];
  const val = Number(amount);
  if (!user || isNaN(val) || val <= 0) {
    return res.status(400).json({ error: "Invalid balance adjustment" });
  }

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (mode === "add") {
    user.balance = Number(user.balance || 0) + val;
    user.history.unshift({ title: "Admin Added Balance", amount: val, type: "plus", time });
  } else {
    user.balance = Math.max(0, Number(user.balance || 0) - val);
    user.history.unshift({ title: "Admin Deducted Balance", amount: val, type: "minus", time });
  }

  return res.json({ ok: true, user });
});

// Announcements
app.post("/api/admin/announcements", (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }
  const ann = {
    id: "ann_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    message,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  };
  db.announcements.unshift(ann);
  return res.status(201).json({ ok: true, ann });
});

// Full state for Admin
app.get("/api/admin/state", (req, res) => {
  res.json({
    users: db.users,
    requests: {
      deposits: db.deposits,
      withdrawals: db.withdrawals,
      referrals: db.referrals
    },
    announcements: db.announcements
  });
});

// User data & announcements
app.get("/api/user/:phone", (req, res) => {
  const user = db.users[req.params.phone];
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  return res.json({ ok: true, user, announcements: db.announcements });
});

app.listen(PORT, () => {
  console.log(`EthioInvest backend running on port ${PORT}`);
});

