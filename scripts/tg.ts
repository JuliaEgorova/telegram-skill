#!/usr/bin/env bun
// tg — read and search Telegram from the command line with your own account (MTProto user API).
// Output is NDJSON (one JSON object per line) so it pipes into jq or a script.
//
// Credentials and the login session live in ~/.config/tg-skill/ (override with TG_SKILL_HOME),
// never next to the code, so the repository can be published safely.
import { TelegramClient, Api } from "telegram";
import { commands, parseArgs, title, type Args } from "./commands";
import { StringSession } from "telegram/sessions/index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// TG_TEST_SERVER=1 talks to Telegram's test network (separate accounts, nothing real) and keeps its own session.
const TEST = process.env.TG_TEST_SERVER === "1";
const HOME = process.env.TG_SKILL_HOME ?? join(homedir(), ".config", TEST ? "tg-skill-test" : "tg-skill");
const CONFIG = join(HOME, "config.json");
const SESSION = join(HOME, "session.txt");
const PENDING = join(HOME, "pending-login.json");

const HELP = `tg — Telegram for Claude Code

Login (once):
  tg setup <api-id> <api-hash> <phone>     save credentials from https://my.telegram.org/apps
  tg login                                  send a login code to your Telegram app
  tg login <code> [--password <2fa>]        finish the login with that code
  tg logout                                 end the session and delete keys and session

Read:
  tg me                                     who is logged in
  tg chats [--max N] [--match text]         your chats, channels and groups
  tg read <chat> [--max N] [--since YYYY-MM-DD]   messages, newest first
  tg search <query> [--max N] [--since D]   search messages across all of Telegram you can see
  tg search <query> --in <chat> [--max N]   search inside one chat
  tg find-channels <query> [--max N]        public channels and groups by name
  tg members <chat> [--max N]               members of a group (needs admin rights in big groups)

Write (only after the user confirmed the exact text and recipient):
  tg send <chat> <text>

<chat> is @username, t.me link, numeric id from "tg chats", or "me" for Saved Messages.
Options: --max N (default 50). Output: NDJSON.`;

// ── storage ─────────────────────────────────────────────────────────────────

interface Config { apiId: number; apiHash: string; phone: string }

function save(path: string, text: string) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(path, text);
  chmodSync(path, 0o600);
}

// On macOS secrets go to the Keychain (encrypted, stays out of files and backups of this folder);
// elsewhere, or with TG_SKILL_FILES=1, they are files readable only by the owner.
const USE_KEYCHAIN = process.platform === "darwin" && process.env.TG_SKILL_FILES !== "1";
const KC = TEST ? "tg-skill-test" : "tg-skill";

function keychain(service: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"], { stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || undefined : undefined;
}

// The value goes in through stdin, not the command line, so other processes can't see it.
function keychainSave(service: string, value: string) {
  if (!/^[A-Za-z0-9+/=_.:-]*$/.test(value)) throw new Error("Unexpected characters in a value for the Keychain");
  const r = Bun.spawnSync(["security", "-i"], {
    stdin: new TextEncoder().encode(`add-generic-password -U -a "${process.env.USER ?? "tg"}" -s "${service}" -w "${value}"\n`),
    stdout: "ignore", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`Keychain: ${r.stderr.toString().trim()}`);
}

function keychainDelete(service: string) {
  Bun.spawnSync(["security", "delete-generic-password", "-s", service], { stdout: "ignore", stderr: "ignore" });
}

function loadSession(): string {
  if (USE_KEYCHAIN) { const v = keychain(`${KC}-session`); if (v) return v; }
  return existsSync(SESSION) ? readFileSync(SESSION, "utf8").trim() : "";
}

function saveSession(value: string) {
  if (USE_KEYCHAIN) {
    keychainSave(`${KC}-session`, value);
    if (existsSync(SESSION)) rmSync(SESSION);   // an older file copy would be a second key to the account
  } else save(SESSION, value);
}

// Keys come from, in order: environment (TG_API_ID, TG_API_HASH, TG_PHONE), the Keychain
// (services "tg-skill-api-id", "tg-skill-api-hash"), then the saved config file.
function config(): Config {
  const file: Partial<Config> = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  const apiId = Number(process.env.TG_API_ID ?? keychain(`${KC}-api-id`) ?? file.apiId);
  const apiHash = process.env.TG_API_HASH ?? keychain(`${KC}-api-hash`) ?? file.apiHash;
  const phone = process.env.TG_PHONE ?? file.phone ?? "";
  if (!apiId || !apiHash) fail("Not set up. Run: tg setup <api-id> <api-hash> <phone>");
  return { apiId, apiHash, phone };
}

async function connect(requireLogin = true): Promise<TelegramClient> {
  const c = config();
  const session = loadSession();
  if (requireLogin && !session) fail("Not logged in. Run: tg login");
  const store = new StringSession(session);
  if (TEST && !session) store.setDC(2, "149.154.167.40", 443);
  const client = new TelegramClient(store, c.apiId, c.apiHash, { connectionRetries: 3, testServers: TEST });
  client.setLogLevel("error" as any);
  await client.connect();
  return client;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}


// ── login ───────────────────────────────────────────────────────────────────

async function setup() {
  const [apiId, apiHash, phone] = pos.slice(1);
  if (!apiId || !apiHash || !phone) fail("Usage: tg setup <api-id> <api-hash> <phone>");
  if (!/^\d+$/.test(apiId) || !/^[0-9a-f]{32}$/i.test(apiHash)) fail("api_id is a number and api_hash is 32 letters/digits — check them at https://my.telegram.org/apps");
  if (USE_KEYCHAIN) {
    keychainSave(`${KC}-api-id`, apiId);
    keychainSave(`${KC}-api-hash`, apiHash);
    save(CONFIG, JSON.stringify({ phone }, null, 2));
    console.error("Keys saved to the macOS Keychain. Next: tg login");
  } else {
    save(CONFIG, JSON.stringify({ apiId: Number(apiId), apiHash, phone }, null, 2));
    console.error(`Saved to ${CONFIG}. Next: tg login`);
  }
}

// Ends the session on Telegram's side and removes every stored secret.
async function logout() {
  try {
    if (loadSession()) { const client = await connect(); await client.invoke(new Api.auth.LogOut()); await client.disconnect(); }
  } catch (e: any) { console.error(`Telegram did not confirm the logout (${e.message}); removing local data anyway`); }
  for (const k of ["session", "api-id", "api-hash"]) if (process.platform === "darwin") keychainDelete(`${KC}-${k}`);
  for (const f of [SESSION, CONFIG, PENDING]) if (existsSync(f)) rmSync(f);
  console.error("Logged out; keys and session removed.");
}

async function login() {
  const c = config();
  const code = pos[1];
  if (!c.phone) fail("No phone number. Run: tg setup <api-id> <api-hash> <phone> or set TG_PHONE");
  if (!code) {
    const client = await connect(false);
    const { phoneCodeHash } = await client.sendCode({ apiId: c.apiId, apiHash: c.apiHash }, c.phone);
    saveSession(String(client.session.save()));
    save(PENDING, JSON.stringify({ phoneCodeHash }));
    await client.disconnect();
    console.error("Code sent to your Telegram app. Run: tg login <code>");
    return;
  }
  if (!existsSync(PENDING)) fail("Request a code first: tg login");
  const { phoneCodeHash } = JSON.parse(readFileSync(PENDING, "utf8"));
  const client = await connect(false);
  try {
    const r: any = await client.invoke(new Api.auth.SignIn({ phoneNumber: c.phone, phoneCodeHash, phoneCode: code }));
    // A number that has no account yet (test network) has to be registered first.
    if (r?.className === "auth.AuthorizationSignUpRequired") {
      await client.invoke(new Api.auth.SignUp({ phoneNumber: c.phone, phoneCodeHash, firstName: flags.name ?? "Test", lastName: "" }));
    }
  } catch (e: any) {
    if (!String(e.message).includes("SESSION_PASSWORD_NEEDED")) throw e;
    if (!flags.password) fail("This account has a cloud password. Run: tg login <code> --password <password>");
    await client.signInWithPassword({ apiId: c.apiId, apiHash: c.apiHash },
      { password: async () => flags.password, onError: async (err: any) => { throw err; } });
  }
  saveSession(String(client.session.save()));
  save(PENDING, "{}");
  const me: any = await client.getMe();
  await client.disconnect();
  console.error(`Logged in as ${title(me)}${me.username ? " (@" + me.username + ")" : ""}`);
}

// ── main ────────────────────────────────────────────────────────────────────

let args: Args;
try { args = parseArgs(process.argv.slice(2)); } catch (e: any) { fail(e.message); }
const { pos, flags } = args!;
const out = (o: unknown) => console.log(JSON.stringify(o));
const cmd = pos[0];

try {
  if (!cmd || cmd === "help" || flags.help) console.log(HELP);
  else if (cmd === "setup") await setup();
  else if (cmd === "login") await login();
  else if (cmd === "logout") await logout();
  else if (commands[cmd]) {
    const client = await connect();
    try { await commands[cmd](client, args!, out); } finally { await client.disconnect(); }
  } else fail(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exit(0);
} catch (e: any) {
  fail(`Error: ${e.message ?? e}`);
}
