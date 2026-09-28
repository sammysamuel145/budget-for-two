const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const CATS = ["Housing", "Food", "Transport", "Bills", "Fun", "Other"];
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_EXPENSES = 5000;
const MAX_ROOMS = 2000;

let db = { rooms: {} };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
if (!db.rooms) db = { rooms: {} };

function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const normCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function newCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 8; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!has(db.rooms, c)) return c;
  }
}

const hits = { bad: new Map(), make: new Map() };
function tooMany(kind, ip, limit, windowMs) {
  const now = Date.now();
  const list = (hits[kind].get(ip) || []).filter((t) => now - t < windowMs);
  hits[kind].set(ip, list);
  return list.length >= limit;
}
const note = (kind, ip) => hits[kind].get(ip).push(Date.now());

const pageFile = fs.existsSync(path.join(__dirname, "app.html")) ? path.join(__dirname, "app.html") : path.join(__dirname, "public", "index.html");
const page = fs.readFileSync(pageFile);

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(obj === null ? "" : JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10000) { reject(new Error("too big")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'"
    });
    return res.end(page);
  }
  if (url.pathname === "/health") return send(res, 200, { ok: true });
  if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  try {
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      if (tooMany("make", ip, 10, 60 * 60 * 1000)) return send(res, 429, { error: "Too many new budgets. Try later." });
      if (Object.keys(db.rooms).length >= MAX_ROOMS) return send(res, 503, { error: "Server is full" });
      note("make", ip);
      const code = newCode();
      db.rooms[code] = { created: Date.now(), people: { a: { name: "", income: 0 }, b: { name: "", income: 0 } }, expenses: [] };
      save();
      return send(res, 201, { code });
    }

    if (tooMany("bad", ip, 30, 10 * 60 * 1000)) return send(res, 429, { error: "Too many wrong codes. Try again later." });
    const code = normCode(req.headers["x-invite-code"]);
    if (!code || !has(db.rooms, code)) {
      note("bad", ip);
      return send(res, 401, { error: "Invalid invitation code" });
    }
    const room = db.rooms[code];

    if (req.method === "GET" && url.pathname === "/api/data") return send(res, 200, { people: room.people, expenses: room.expenses });

    let m = url.pathname.match(/^\/api\/people\/([ab])$/);
    if (m && req.method === "PUT") {
      const b = await readBody(req);
      const name = typeof b.name === "string" ? b.name.trim().slice(0, 30) : "";
      const income = Number(b.income);
      if (!Number.isFinite(income) || income < 0 || income > 1e13) return send(res, 400, { error: "Bad income" });
      room.people[m[1]] = { name, income };
      save();
      return send(res, 200, room.people[m[1]]);
    }

    if (req.method === "POST" && url.pathname === "/api/expenses") {
      const b = await readBody(req);
      const desc = typeof b.desc === "string" ? b.desc.trim().slice(0, 60) : "";
      const amt = Math.round(Number(b.amt));
      if (!["a", "b"].includes(b.who) || !desc || !CATS.includes(b.cat) || !Number.isFinite(amt) || amt < 1 || amt > 1e12)
        return send(res, 400, { error: "Bad expense" });
      if (room.expenses.length >= MAX_EXPENSES) return send(res, 400, { error: "Expense limit reached" });
      const item = { id: crypto.randomUUID(), who: b.who, desc, amt, cat: b.cat, ts: Date.now() };
      room.expenses.unshift(item);
      save();
      return send(res, 201, item);
    }

    m = url.pathname.match(/^\/api\/expenses\/([\w-]+)$/);
    if (m && req.method === "DELETE") {
      room.expenses = room.expenses.filter((e) => e.id !== m[1]);
      save();
      return send(res, 204, null);
    }
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    return send(res, 400, { error: "Bad request" });
  }
});

server.listen(PORT, () => console.log("Budget for Two running on port " + PORT));
