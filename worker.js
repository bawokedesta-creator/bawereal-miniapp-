const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

let announcementsStore = [];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function extractAmount(body = {}) {
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
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      const cleaned = String(val).replace(/[^0-9.]/g, "");
      const num = Number(cleaned);
      if (!Number.isNaN(num) && num > 0) return num;
    }
  }
  return null;
}

function extractPaymentAccount(body = {}) {
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
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      return String(val).trim();
    }
  }
  return "Telebirr / Bank";
}

function getDbConnectionString(env) {
  if (env && env.HYPERDRIVE && env.HYPERDRIVE.connectionString) {
    return env.HYPERDRIVE.connectionString;
  }
  const raw = (env && env.DATABASE_URL) || "";
  return raw
    .replace(/([?&])sslmode=[^&]*(&|$)/i, (match, p1, p2) => (p2 ? p1 : ""))
    .replace(/[?&]$/, "");
}

async function withPgClient(env, fn) {
  const connStr = getDbConnectionString(env);
  if (!connStr) {
    throw new Error("DATABASE_URL or HYPERDRIVE binding is not configured on Worker.");
  }
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: connStr,
    ssl: env && env.HYPERDRIVE ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    let body = {};
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        body = await request.json().catch(() => ({}));
      } else {
        const text = await request.text().catch(() => "");
        if (text) {
          try {
            body = JSON.parse(text);
          } catch (_) {
            const params = new URLSearchParams(text);
            body = Object.fromEntries(params.entries());
          }
        }
      }
    }

    try {
      if (method === "GET" && pathname === "/") {
        return jsonResponse({
          status: "ok",
          service: "EthioInvest Cloudflare Worker API",
        });
      }

      if (method === "GET" && pathname === "/api/health") {
        const res = await withPgClient(env, (db) => db.query("SELECT NOW() AS server_time"));
        return jsonResponse({
          status: "ok",
          database: "Aiven PostgreSQL Connected",
          server_time: res.rows[0].server_time,
        });
      }

      if (method === "GET" && pathname === "/api/users") {
        const res = await withPgClient(env, (db) =>
          db.query("SELECT id, full_name, phone, balance, created_at FROM users ORDER BY id DESC")
        );
        return jsonResponse({
          success: true,
          count: res.rows.length,
          users: res.rows,
        });
      }

      const userMatch = pathname.match(/^\/api\/user\/([^/]+)$/);
      if (method === "GET" && userMatch) {
        const phone = decodeURIComponent(userMatch[1] || "").trim();
        const data = await withPgClient(env, async (db) => {
          const uRes = await db.query(
            "SELECT id, full_name, phone, balance, created_at FROM users WHERE phone = $1",
            [phone]
          );
          const aRes = await db.query(
            `SELECT id, phone, section, title, amount, tx_type, status, created_label, created_at
             FROM user_activities
             WHERE phone = $1
             ORDER BY id DESC
             LIMIT 100`,
            [phone]
          );
          return { uRow: uRes.rows[0], activities: aRes.rows };
        });

        const uRow = data.uRow || { phone, full_name: phone, balance: 0 };
        const history = data.activities.map((r) => ({
          id: r.id,
          section: r.section,
          title: r.title,
          amount: Number(r.amount || 0),
          type:
            r.status === "approved"
              ? r.section === "deposit"
                ? "plus"
                : "minus"
              : r.status || "pending",
          status: r.status || "pending",
          time: r.created_label || new Date(r.created_at).toLocaleString(),
        }));

        return jsonResponse({
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
      }

      if (method === "POST" && pathname === "/api/register") {
        const fullName = String(body.fullName || body.full_name || "").trim();
        const phone = String(body.phone || body.phoneNumber || "").trim();
        const password = String(body.password || "");

        if (!fullName || !phone || !password) {
          return jsonResponse(
            { error: "ሙሉ ስም፣ ስልክ ቁጥር እና ፓስወርድ ያስፈልጋሉ።" },
            400
          );
        }

        const inserted = await withPgClient(env, async (db) => {
          const existing = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
          if (existing.rows.length > 0) {
            return { conflict: true };
          }
          const r = await db.query(
            `INSERT INTO users (full_name, phone, password)
             VALUES ($1, $2, $3)
             RETURNING id, full_name, phone, balance, created_at`,
            [fullName, phone, password]
          );
          return { user: r.rows[0] };
        });

        if (inserted.conflict) {
          return jsonResponse({ error: "ይህ ስልክ ቁጥር ቀደም ብሎ ተመዝግቧል።" }, 409);
        }

        return jsonResponse(
          {
            success: true,
            message: "አካውንት በተሳካ ሁኔታ ተፈጥሯል።",
            user: inserted.user,
          },
          201
        );
      }

      if (method === "POST" && pathname === "/api/login") {
        const phone = String(body.phone || body.phoneNumber || "").trim();
        const password = String(body.password || "");

        if (!phone || !password) {
          return jsonResponse({ error: "ስልክ ቁጥር እና ፓስወርድ ያስፈልጋሉ።" }, 400);
        }

        const res = await withPgClient(env, (db) =>
          db.query(
            "SELECT id, full_name, phone, balance, created_at FROM users WHERE phone = $1 AND password = $2",
            [phone, password]
          )
        );

        if (res.rows.length === 0) {
          return jsonResponse({ error: "ስልክ ቁጥር ወይም ፓስወርድ የተሳሳተ ነው።" }, 401);
        }

        const row = res.rows[0];
        return jsonResponse({
          success: true,
          message: "በተሳካ ሁኔታ ገብተዋል።",
          user: {
            id: row.id,
            fullName: row.full_name,
            phone: row.phone,
            balance: Number(row.balance || 0),
            created_at: row.created_at,
          },
        });
      }

      if (method === "POST" && pathname === "/api/activities") {
        const phone = String(body.phone || "").trim();
        const section = String(body.section || "general").trim().toLowerCase();
        const title = String(body.title || "Activity").trim();
        const rawAmt = body.amount;
        const amount =
          rawAmt !== undefined && rawAmt !== null && rawAmt !== "" && !Number.isNaN(Number(rawAmt))
            ? Number(rawAmt)
            : null;
        const status = String(body.status || "pending").trim().toLowerCase();
        const txType = String(
          body.type ||
            body.tx_type ||
            (status === "approved" ? (section === "deposit" ? "plus" : "minus") : status)
        ).trim();
        const timeLabel = String(body.time || new Date().toLocaleString()).trim();

        if (!phone || !title) {
          return jsonResponse({ error: "phone and title are required" }, 400);
        }

        const inserted = await withPgClient(env, (db) =>
          db.query(
            `INSERT INTO user_activities (phone, section, title, amount, tx_type, status, created_label)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, phone, section, title, amount, tx_type, status, created_label, created_at`,
            [phone, section, title, amount, txType, status, timeLabel]
          )
        );

        return jsonResponse({ success: true, activity: inserted.rows[0] }, 201);
      }

      const actMatch = pathname.match(/^\/api\/activities\/([^/]+)$/);
      if (method === "GET" && actMatch) {
        const phone = decodeURIComponent(actMatch[1] || "").trim();
        if (!phone) return jsonResponse({ error: "phone is required" }, 400);

        const res = await withPgClient(env, (db) =>
          db.query(
            `SELECT id, phone, section, title, amount, tx_type, status, created_label, created_at
             FROM user_activities
             WHERE phone = $1
             ORDER BY id DESC
             LIMIT 100`,
            [phone]
          )
        );
        return jsonResponse({ success: true, activities: res.rows });
      }

      if (method === "GET" && pathname === "/api/admin/state") {
        const state = await withPgClient(env, async (db) => {
          const uRes = await db.query(
            "SELECT id, full_name, phone, balance, created_at FROM users ORDER BY id DESC"
          );
          const aRes = await db.query(
            `SELECT id, phone, section, title, amount, tx_type, status, created_label, created_at
             FROM user_activities
             ORDER BY id DESC
             LIMIT 200`
          );
          return { users: uRes.rows, activities: aRes.rows };
        });

        const usersMap = {};
        state.users.forEach((u) => {
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

        state.activities.forEach((row) => {
          const sec = String(row.section || "").toLowerCase();
          const status = String(row.status || "pending").toLowerCase();
          const amt = Number(row.amount || 0);
          const time = row.created_label || new Date(row.created_at).toLocaleString();

          if (usersMap[row.phone]) {
            usersMap[row.phone].history.push({
              id: row.id,
              section: sec,
              title: row.title,
              amount: amt,
              status,
              type: status === "approved" ? (sec === "deposit" ? "plus" : "minus") : status,
              time,
            });
            if (status === "approved" && (sec === "investment" || sec === "package")) {
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

          if (sec === "deposit") {
            item.method = row.title;
            deposits.push(item);
          } else if (sec === "withdrawal") {
            item.method = row.title;
            item.fee = amt * 0.05;
            item.netPay = amt - amt * 0.05;
            withdrawals.push(item);
          } else if (sec === "investment" || sec === "package") {
            item.pkgName = row.title;
            packages.push(item);
          } else if (sec === "referral") {
            referrals.push(item);
          }
        });

        return jsonResponse({
          success: true,
          users: usersMap,
          requests: { deposits, withdrawals, packages, referrals },
          announcements: announcementsStore,
        });
      }

      const decideMatch = pathname.match(
        /^\/api\/admin\/(deposits|withdrawals|packages|referrals)\/([^/]+)\/decide$/
      );
      if (method === "POST" && (decideMatch || pathname === "/api/admin/approve")) {
        const forcedKind = decideMatch
          ? decideMatch[1] === "packages"
            ? "investment"
            : decideMatch[1].replace(/s$/, "")
          : null;
        const id = decideMatch ? decideMatch[2] : body.id;
        const action = String(body.action || "").trim().toLowerCase();

        if (!id || !["approve", "reject"].includes(action)) {
          return jsonResponse({ error: "Valid id and action (approve/reject) are required" }, 400);
        }

        const updated = await withPgClient(env, async (db) => {
          const actRes = await db.query(
            "SELECT id, phone, section, title, amount, status FROM user_activities WHERE id = $1",
            [id]
          );
          if (actRes.rows.length === 0) return { notFound: true };

          const act = actRes.rows[0];
          const sec = String(forcedKind || act.section || "deposit").toLowerCase();
          const phone = String(act.phone || "").trim();
          const amt = Number(act.amount || 0);
          const prevStatus = String(act.status || "pending").toLowerCase();

          if (action === "approve" && prevStatus !== "approved" && phone && amt > 0) {
            if (sec === "deposit") {
              await db.query(
                "UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE phone = $2",
                [amt, phone]
              );
            } else if (sec === "withdrawal" || sec === "investment" || sec === "package") {
              await db.query(
                "UPDATE users SET balance = GREATEST(0, COALESCE(balance, 0) - $1) WHERE phone = $2",
                [amt, phone]
              );
            }
          }

          const nextStatus = action === "approve" ? "approved" : "rejected";
          const nextTxType =
            nextStatus === "approved" ? (sec === "deposit" ? "plus" : "minus") : "rejected";

          const r = await db.query(
            `UPDATE user_activities
             SET status = $1, tx_type = $2
             WHERE id = $3
             RETURNING id, phone, section, title, amount, tx_type, status, created_label, created_at`,
            [nextStatus, nextTxType, id]
          );
          return { activity: r.rows[0] };
        });

        if (updated.notFound) return jsonResponse({ error: "Activity not found" }, 404);
        return jsonResponse({ success: true, activity: updated.activity });
      }

      const balMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/balance$/);
      if (method === "POST" && balMatch) {
        const phone = decodeURIComponent(balMatch[1] || "").trim();
        const amt = Number(body.amount || 0);
        const mode = String(body.mode || "add").toLowerCase();
        if (!phone || Number.isNaN(amt) || amt <= 0) {
          return jsonResponse({ error: "Invalid phone or amount" }, 400);
        }

        const r = await withPgClient(env, (db) => {
          const sql =
            mode === "sub"
              ? "UPDATE users SET balance = GREATEST(0, COALESCE(balance, 0) - $1) WHERE phone = $2 RETURNING id, full_name, phone, balance"
              : "UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE phone = $2 RETURNING id, full_name, phone, balance";
          return db.query(sql, [amt, phone]);
        });
        return jsonResponse({ success: true, user: r.rows[0] });
      }

      const delUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (method === "DELETE" && delUserMatch) {
        const phone = decodeURIComponent(delUserMatch[1] || "").trim();
        await withPgClient(env, async (db) => {
          await db.query("DELETE FROM user_activities WHERE phone = $1", [phone]);
          await db.query("DELETE FROM users WHERE phone = $1", [phone]);
        });
        return jsonResponse({ success: true });
      }

      const delAdminMatch = pathname.match(/^\/api\/admin\/([^/]+)\/([^/]+)$/);
      if (method === "DELETE" && delAdminMatch) {
        const id = delAdminMatch[2];
        await withPgClient(env, (db) => db.query("DELETE FROM user_activities WHERE id = $1", [id]));
        return jsonResponse({ success: true });
      }

      if (method === "POST" && pathname === "/api/admin/announcements") {
        const msg = String(body.message || "").trim();
        if (!msg) return jsonResponse({ error: "Message is required" }, 400);
        const item = {
          id: "ANN-" + Date.now(),
          message: msg,
          time: new Date().toLocaleString(),
        };
        announcementsStore.unshift(item);
        return jsonResponse({ success: true, announcement: item }, 201);
      }

      if (
        method === "POST" &&
        ["/api/deposits", "/api/deposit", "/deposit"].includes(pathname)
      ) {
        const paymentAccount = extractPaymentAccount(body);
        const amount = extractAmount(body);
        const phone = String(body.phone || body.phoneNumber || "").trim() || null;
        const userId = body.userId || body.user_id || null;
        const receiptImage =
          body.receiptImage ||
          body.receipt_image ||
          body.screenshot ||
          body.image ||
          body.screenshotDataUrl ||
          null;

        if (!amount) {
          return jsonResponse({ error: "እባክዎ ትክክለኛ የገንዘብ መጠን ያስገቡ።" }, 400);
        }

        const inserted = await withPgClient(env, (db) =>
          db.query(
            `INSERT INTO deposits (user_id, phone, payment_account, amount, receipt_image, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')
             RETURNING id, user_id, phone, payment_account, amount, status, created_at`,
            [userId, phone, paymentAccount, amount, receiptImage]
          )
        );

        return jsonResponse(
          {
            success: true,
            message: "Deposit pending",
            deposit: inserted.rows[0],
          },
          201
        );
      }

      if (method === "GET" && pathname === "/api/deposits") {
        const res = await withPgClient(env, (db) =>
          db.query(
            "SELECT id, user_id, phone, payment_account, amount, status, created_at FROM deposits ORDER BY id DESC"
          )
        );
        return jsonResponse({
          success: true,
          count: res.rows.length,
          deposits: res.rows,
        });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || "Worker error" }, 500);
    }
  },
};
