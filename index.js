// Mtaani MD v2 – WhatsApp bot with web admin panel (Baileys, pairing-code login)
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, Browsers, jidNormalizedUser
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const http = require("http");
const crypto = require("crypto");
const { execFile } = require("child_process");

/* ================= SETTINGS ================= */
const CONFIG = {
  botName: "Mtaani MD",
  prefix: ".",
  owners: (process.env.OWNER_NUMBER || "").split(",").map(s => s.replace(/\D/g, "")).filter(Boolean),
  delayMs: 10000, jitterMs: 3000, maxQueue: 200,
  reactEmoji: "💚", maxVideoMB: 60, greetingCooldownMin: 60
};
const PORT = process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || crypto.randomBytes(5).toString("hex");
const SESSION_DIR = "session", BACKUP_DIR = "backup", SETTINGS_FILE = "settings.json";
const TMP = path.join(__dirname, "tmp");
[TMP, BACKUP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

let settings = { autoView: true, autoReact: false, autoGreet: true, mode: "public", delaySec: 10 };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) }; } catch (e) {}
CONFIG.delayMs = settings.delaySec * 1000;
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

/* ================= STATE + HELPERS ================= */
let sock = null, connState = "idle", pairing = null, me = null;
const startedAt = Date.now(), logs = [], stats = { commands: {}, statusViews: 0 };
const log = (...a) => { const l = new Date().toISOString().slice(11, 19) + "  " + a.join(" "); console.log(l); logs.push(l); if (logs.length > 80) logs.shift(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = () => Math.max(2000, CONFIG.delayMs + Math.floor((Math.random() * 2 - 1) * CONFIG.jitterMs));
const pick = a => a[Math.floor(Math.random() * a.length)];

// One job at a time, each after its own delay: keeps the bot slow and steady.
const queue = []; let running = false;
function enqueue(fn) {
  if (queue.length >= CONFIG.maxQueue) return;
  queue.push(async () => { await sleep(wait()); await fn(); });
  if (!running) drain();
}
async function drain() {
  running = true;
  while (queue.length) { const job = queue.shift(); try { await job(); } catch (e) { log("Job failed:", e.message); } }
  running = false;
}

const textOf = m => { const x = m.message || {}; return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption || ""; };
const numberOf = m => (m.key.participant || m.key.remoteJid || "").split("@")[0].split(":")[0];

function fetchMedia(url, audio) {
  return new Promise((resolve, reject) => {
    const stamp = "dl_" + Date.now(), limit = CONFIG.maxVideoMB + "M";
    const args = audio
      ? ["--no-playlist", "--max-filesize", limit, "-x", "--audio-format", "mp3"]
      : ["--no-playlist", "--max-filesize", limit, "-f", `best[ext=mp4][filesize<${limit}]/best[filesize<${limit}]/best`];
    execFile("yt-dlp", [...args, "-o", path.join(TMP, stamp + ".%(ext)s"), "--", url], { timeout: 180000 }, err => {
      if (err) return reject(err);
      const f = fs.readdirSync(TMP).find(x => x.startsWith(stamp + "."));
      f ? resolve(path.join(TMP, f)) : reject(new Error("No file produced"));
    });
  });
}

/* ===== Session ID: export / restore / backup (this is the account login, keep it secret) ===== */
function exportSession() {
  const f = path.join(SESSION_DIR, "creds.json");
  if (!fs.existsSync(f)) return null;
  return "MTAANI-MD~" + zlib.gzipSync(fs.readFileSync(f)).toString("base64");
}
function importSession(id) {
  if (!id.startsWith("MTAANI-MD~")) throw new Error("That is not a valid session ID.");
  const creds = zlib.gunzipSync(Buffer.from(id.slice(10), "base64")).toString();
  JSON.parse(creds);
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, "creds.json"), creds);
}
function backupSession() { const id = exportSession(); if (id) fs.writeFileSync(path.join(BACKUP_DIR, "session-id.txt"), id); }
setInterval(backupSession, 30 * 60 * 1000);
if (process.env.SESSION_ID && !fs.existsSync(path.join(SESSION_DIR, "creds.json"))) {
  try { importSession(process.env.SESSION_ID.trim()); log("Session restored from SESSION_ID."); } catch (e) { log("SESSION_ID invalid:", e.message); }
}

/* ================= COMMANDS ================= */
const JOKES = ["Why did the phone go to school? To get smarter.", "Kwa nini kuku alivuka barabara? Ili afike upande wa pili.", "I told my wife she was drawing her eyebrows too high. She looked surprised.", "Why don't programmers like nature? Too many bugs."];
const QUOTES = ["Haba na haba hujaza kibaba.", "Mwenye subira hula mbivu.", "The best time to start was yesterday. The next best time is now.", "Small steps every day beat big plans never started.", "Fall seven times, stand up eight."];
const BALL = ["Yes.", "No.", "Maybe.", "Definitely.", "Ask again later.", "Very unlikely.", "Without a doubt."];
const TRUTH = ["What is the last lie you told?", "Who was your first crush?", "What is your biggest fear?", "What is one habit you want to quit?"];
const DARE = ["Send a voice note singing your favourite song.", "Change your status to something funny for an hour.", "Text someone you have not spoken to in a year.", "Do 10 push-ups and tell us."];
const fmtUp = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return `${d}d ${h}h ${m}m`; };

const commands = {
  menu: { cat: "General", desc: "show this list", run: c => c.reply(menuText()) },
  ping: { cat: "General", desc: "check the bot is alive", run: c => c.reply(`${CONFIG.botName} is alive.`) },
  alive: { cat: "General", desc: "bot status", run: c => c.reply(`${CONFIG.botName} is online.\nUptime: ${fmtUp((Date.now() - startedAt) / 1000)}\nMode: ${settings.mode}`) },
  runtime: { cat: "General", desc: "how long the bot has been running", run: c => c.reply("Uptime: " + fmtUp((Date.now() - startedAt) / 1000)) },
  time: { cat: "General", desc: "current server time", run: c => c.reply(new Date().toUTCString()) },
  owner: { cat: "General", desc: "show the bot owner", run: c => c.reply("Owner: wa.me/" + (CONFIG.owners[0] || me || "")) },
  id: { cat: "General", desc: "show this chat's ID", run: c => c.reply(c.jid) },

  flip: { cat: "Fun", desc: "flip a coin", run: c => c.reply(pick(["Heads", "Tails"])) },
  roll: { cat: "Fun", desc: "roll a dice", run: c => c.reply("You rolled: " + (1 + Math.floor(Math.random() * 6))) },
  "8ball": { cat: "Fun", usage: "<question>", desc: "ask the magic 8 ball", run: c => c.args.length ? c.reply(pick(BALL)) : c.reply("Ask a question first.") },
  joke: { cat: "Fun", desc: "random joke", run: c => c.reply(pick(JOKES)) },
  quote: { cat: "Fun", desc: "random quote", run: c => c.reply(pick(QUOTES)) },
  truth: { cat: "Fun", desc: "truth question", run: c => c.reply(pick(TRUTH)) },
  dare: { cat: "Fun", desc: "dare challenge", run: c => c.reply(pick(DARE)) },
  rate: { cat: "Fun", usage: "<anything>", desc: "rate something out of 10", run: c => c.reply(c.args.length ? `I rate "${c.args.join(" ")}" ${1 + Math.floor(Math.random() * 10)}/10` : "Rate what?") },

  calc: { cat: "Tools", usage: "<2+2*5>", desc: "calculator", run: c => {
    const e = c.args.join(" ").replace(/,/g, "");
    if (!e || !/^[\d+\-*/().%\s^]+$/.test(e)) return c.reply("Use numbers and + - * / ( ) ^ only.");
    let v; try { v = Function('"use strict";return (' + e.replace(/\^/g, "**") + ")")(); } catch (x) { return c.reply("Invalid expression."); }
    return c.reply(Number.isFinite(v) ? `${e} = ${v}` : "Invalid expression.");
  } },
  say: { cat: "Tools", usage: "<text>", desc: "bot repeats your text", run: c => c.args.length ? c.reply(c.args.join(" ")) : c.reply("Say what?") },
  reverse: { cat: "Tools", usage: "<text>", desc: "reverse text", run: c => c.reply([...c.args.join(" ")].reverse().join("") || "Send some text.") },
  upper: { cat: "Tools", usage: "<text>", desc: "UPPERCASE text", run: c => c.reply(c.args.join(" ").toUpperCase() || "Send some text.") },
  lower: { cat: "Tools", usage: "<text>", desc: "lowercase text", run: c => c.reply(c.args.join(" ").toLowerCase() || "Send some text.") },
  count: { cat: "Tools", usage: "<text>", desc: "count words and letters", run: c => { const t = c.args.join(" "); return c.reply(`Words: ${t.split(/\s+/).filter(Boolean).length}\nCharacters: ${t.length}`); } },

  dl: { cat: "Download", usage: "<link>", desc: "download a video from a link", run: c => sendMedia(c, false) },
  audio: { cat: "Download", usage: "<link>", desc: "download audio (mp3) from a link", run: c => sendMedia(c, true) },

  groupinfo: { cat: "Group", desc: "group details", run: async c => {
    if (!c.isGroup) return c.reply("Use this in a group.");
    const g = await c.sock.groupMetadata(c.jid);
    return c.reply(`*${g.subject}*\nMembers: ${g.participants.length}\nAdmins: ${g.participants.filter(p => p.admin).length}\nCreated: ${new Date(g.creation * 1000).toDateString()}`);
  } },
  tagall: { cat: "Group", usage: "[message]", desc: "mention everyone (admins)", run: async c => {
    if (!c.isGroup) return c.reply("Use this in a group.");
    const g = await c.sock.groupMetadata(c.jid);
    const sender = c.m.key.participant || "";
    const isAdmin = g.participants.some(p => p.admin && p.id === sender);
    if (!isAdmin && !c.isOwner) return c.reply("Only group admins can use this.");
    const ids = g.participants.map(p => p.id);
    return c.sock.sendMessage(c.jid, { text: (c.args.join(" ") || "Attention everyone!") + "\n\n" + ids.map(i => "@" + i.split("@")[0]).join(" "), mentions: ids }, { quoted: c.m });
  } },

  autoview: { cat: "Owner", usage: "on/off", owner: true, desc: "auto view statuses", run: c => toggle(c, "autoView") },
  autoreact: { cat: "Owner", usage: "on/off", owner: true, desc: "auto react to statuses", run: c => toggle(c, "autoReact") },
  autogreet: { cat: "Owner", usage: "on/off", owner: true, desc: "auto greeting", run: c => toggle(c, "autoGreet") },
  mode: { cat: "Owner", usage: "public/self", owner: true, desc: "who can use the bot", run: c => {
    const v = (c.args[0] || "").toLowerCase();
    if (!["public", "self"].includes(v)) return c.reply(`Use ${CONFIG.prefix}mode public or ${CONFIG.prefix}mode self`);
    settings.mode = v; saveSettings(); return c.reply("Mode is now " + v.toUpperCase() + ".");
  } },
  settings: { cat: "Owner", owner: true, desc: "show current settings", run: c => c.reply(`autoview: ${settings.autoView}\nautoreact: ${settings.autoReact}\nautogreet: ${settings.autoGreet}\nmode: ${settings.mode}\ndelay: ${settings.delaySec}s`) }
};

function toggle(c, key) {
  const v = (c.args[0] || "").toLowerCase();
  if (!["on", "off"].includes(v)) return c.reply(`Use ${CONFIG.prefix}${c.cmd} on or ${CONFIG.prefix}${c.cmd} off`);
  settings[key] = v === "on"; saveSettings(); return c.reply(`${c.cmd} is now ${v.toUpperCase()}.`);
}
async function sendMedia(c, audio) {
  const url = c.args[0] || "";
  if (!/^https?:\/\/\S+$/i.test(url)) return c.reply(`Send a link, e.g. ${CONFIG.prefix}${c.cmd} https://...`);
  await c.reply("Downloading, please wait…");
  let file;
  try { file = await fetchMedia(url, audio); }
  catch (e) { return c.reply(`Could not download that (it may be private, too big, or not supported). Max size is ${CONFIG.maxVideoMB}MB.`); }
  try {
    await c.sock.sendMessage(c.jid, audio ? { audio: { url: file }, mimetype: "audio/mpeg" } : { video: { url: file }, caption: "Downloaded by " + CONFIG.botName }, { quoted: c.m });
  } finally { fs.unlink(file, () => {}); }
}
function menuText() {
  const g = {};
  for (const [n, c] of Object.entries(commands)) (g[c.cat] = g[c.cat] || []).push(`${CONFIG.prefix}${n}${c.usage ? " " + c.usage : ""} : ${c.desc}`);
  return `*${CONFIG.botName}*\n\n` + Object.entries(g).map(([k, l]) => `*${k}*\n${l.join("\n")}`).join("\n\n") + "\n\nReplies come after a short delay.";
}

/* ================= WHATSAPP CONNECTION ================= */
const greeted = new Map();

async function start(number) {
  if (sock) { try { sock.ev.removeAllListeners(); sock.end(undefined); } catch (e) {} sock = null; }
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const s = makeWASocket({
    version, auth: state, logger: pino({ level: "silent" }), browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false
  });
  sock = s;

  if (!s.authState.creds.registered) {
    if (!number) { connState = "needs-pairing"; return; }
    connState = "pairing"; await sleep(3000);
    const code = await s.requestPairingCode(number);
    pairing = code.match(/.{1,4}/g).join("-");
    log("Pairing code ready:", pairing);
  }

  s.ev.on("creds.update", saveCreds);
  s.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (s !== sock) return;
    if (connection === "open") {
      connState = "online"; pairing = null; me = jidNormalizedUser(s.user.id).split("@")[0];
      log(`${CONFIG.botName} is online as +${me}`); setTimeout(backupSession, 5000);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        connState = "logged-out"; log("Logged out or banned by WhatsApp. Use Recovery in the panel.");
      } else { connState = "reconnecting"; log("Connection closed, reconnecting…"); setTimeout(() => start().catch(e => log("Restart failed:", e.message)), 3000); }
    }
  });

  s.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" || s !== sock) return;
    for (const m of messages) {
      if (!m.message) continue;
      const jid = m.key.remoteJid;

      if (jid === "status@broadcast") {
        if (m.key.fromMe || !settings.autoView) continue;
        enqueue(async () => {
          await s.readMessages([m.key]); stats.statusViews++;
          if (settings.autoReact) {
            await sleep(2000 + Math.random() * 3000);
            await s.sendMessage("status@broadcast", { react: { text: CONFIG.reactEmoji, key: m.key } }, { statusJidList: [m.key.participant, jidNormalizedUser(s.user.id)] });
          }
        });
        continue;
      }

      const text = textOf(m).trim();
      const isOwner = !!m.key.fromMe || CONFIG.owners.includes(numberOf(m)) || numberOf(m) === me;
      const isGroup = jid.endsWith("@g.us");
      const reply = t => s.sendMessage(jid, { text: t }, { quoted: m });

      if (text.startsWith(CONFIG.prefix)) {
        const [cmdRaw, ...args] = text.slice(CONFIG.prefix.length).split(/\s+/);
        const cmd = cmdRaw.toLowerCase(), def = commands[cmd];
        if (settings.mode === "self" && !isOwner) continue;
        try { await s.sendPresenceUpdate("composing", jid); } catch (e) {}
        enqueue(async () => {
          if (!def) return reply(`Unknown command. Type ${CONFIG.prefix}menu`);
          if (def.owner && !isOwner) return reply("Only the owner can use this command.");
          stats.commands[cmd] = (stats.commands[cmd] || 0) + 1;
          try { await def.run({ sock: s, m, jid, args, cmd, reply, isOwner, isGroup }); }
          catch (e) { log(`.${cmd} failed:`, e.message); await reply("Something went wrong with that command."); }
        });
        continue;
      }

      if (settings.autoGreet && settings.mode === "public" && !m.key.fromMe && !isGroup && /^(hi|hello|hey|mambo|niaje|sasa|habari)\b/i.test(text)) {
        if (Date.now() - (greeted.get(jid) || 0) > CONFIG.greetingCooldownMin * 60000) {
          greeted.set(jid, Date.now());
          try { await s.sendPresenceUpdate("composing", jid); } catch (e) {}
          enqueue(() => reply(`Poa! Mimi ni ${CONFIG.botName}. Andika ${CONFIG.prefix}menu kuona ninachoweza kufanya.`));
        }
      }
    }
  });
}

/* ================= WEB PANEL ================= */
const tokens = new Map(), fails = new Map();
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const cookies = h => Object.fromEntries((h || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }));
const authed = req => (tokens.get(cookies(req.headers.cookie).tk) || 0) > Date.now();
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => {
  let b = ""; req.on("data", d => { b += d; if (b.length > 100000) { no(new Error("Too large")); req.destroy(); } });
  req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
});

http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, "panel.html")));
    }
    if (url === "/api/login" && req.method === "POST") {
      const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: 0 };
      if (f.n >= 5 && Date.now() - f.t < 600000) return send(res, 429, { error: "Too many attempts. Try again in 10 minutes." });
      const { password } = await readBody(req);
      if (crypto.timingSafeEqual(sha(password || ""), sha(PANEL_PASSWORD))) {
        const tk = crypto.randomBytes(24).toString("hex"); tokens.set(tk, Date.now() + 12 * 3600000); fails.delete(ip);
        return send(res, 200, { ok: true }, { "Set-Cookie": `tk=${tk}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
      }
      fails.set(ip, { n: f.n + 1, t: Date.now() });
      return send(res, 401, { error: "Wrong password." });
    }
    if (!authed(req)) return send(res, 401, { error: "Not signed in." });

    if (url === "/api/state") return send(res, 200, {
      connState, pairing, me, settings, uptime: Math.floor((Date.now() - startedAt) / 1000),
      stats, logs, queue: queue.length, hasSession: !!exportSession(), botName: CONFIG.botName,
      commands: Object.entries(commands).map(([n, c]) => ({ name: n, cat: c.cat, usage: c.usage || "", desc: c.desc })), prefix: CONFIG.prefix
    });
    if (url === "/api/session") { const id = exportSession(); return id ? send(res, 200, { id }) : send(res, 404, { error: "No linked account yet." }); }
    if (req.method !== "POST") return send(res, 404, { error: "Not found." });
    const body = await readBody(req);

    if (url === "/api/pair") {
      const num = String(body.number || "").replace(/\D/g, "");
      if (!/^\d{8,15}$/.test(num)) return send(res, 400, { error: "Enter the full international number, digits only (e.g. 2547XXXXXXXX)." });
      if (connState === "online") return send(res, 400, { error: "A number is already linked. Unlink it first." });
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      pairing = null; await start(num);
      return send(res, 200, { pairing });
    }
    if (url === "/api/settings") {
      for (const k of ["autoView", "autoReact", "autoGreet"]) if (typeof body[k] === "boolean") settings[k] = body[k];
      if (["public", "self"].includes(body.mode)) settings.mode = body.mode;
      if (Number.isFinite(body.delaySec)) { settings.delaySec = Math.min(60, Math.max(5, Math.round(body.delaySec))); CONFIG.delayMs = settings.delaySec * 1000; }
      saveSettings(); return send(res, 200, { settings });
    }
    if (url === "/api/restore") { importSession(String(body.id || "").trim()); pairing = null; await start(); return send(res, 200, { ok: true }); }
    if (url === "/api/restart") { await start(); return send(res, 200, { ok: true }); }
    if (url === "/api/unlink") {
      try { await sock?.logout(); } catch (e) {}
      try { sock?.ev.removeAllListeners(); } catch (e) {}
      sock = null; me = null; pairing = null; connState = "needs-pairing";
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "Not found." });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => {
  console.log(`\n${CONFIG.botName} panel: http://localhost:${PORT}`);
  console.log(process.env.PANEL_PASSWORD ? "Panel password: from PANEL_PASSWORD" : `Panel password (set PANEL_PASSWORD to choose your own): ${PANEL_PASSWORD}`);
});

start().catch(e => log("Start failed:", e.message));
