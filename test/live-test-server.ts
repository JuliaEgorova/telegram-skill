#!/usr/bin/env bun
// End-to-end check against Telegram's TEST network: no real account, nothing visible to anyone.
// Note (Oct 2026): the test network sent codes but rejected the documented fixed code (22222) on DCs 1–3,
// so this script currently stops after "login: code requested".
// Test numbers are 99966<dc><4 digits>; their login code is the dc digit five times (dc 2 → 22222).
//
//   TG_API_ID=… TG_API_HASH=… bun test/live-test-server.ts
// (or keep the keys in the macOS Keychain as "tg-skill-api-id" / "tg-skill-api-hash" and run without them)
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "scripts", "tg.ts");
const home = mkdtempSync(join(tmpdir(), "tg-skill-test-"));
const phone = `99966${2}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
// Files in a temp folder, so the throwaway session never touches the Keychain.
const env = { ...process.env, TG_TEST_SERVER: "1", TG_SKILL_FILES: "1", TG_SKILL_HOME: home, TG_PHONE: phone };

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

function tg(...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const rows = r.stdout.toString().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  return { code: r.exitCode, rows, err: r.stderr.toString().trim() };
}

async function main() {
  console.log(`Test network, throwaway account ${phone}\n`);

  let r = tg("login");
  check("login: code requested", r.code === 0, r.err);
  if (r.code !== 0) return;
  r = tg("login", "22222", "--name", "Skill Test");
  check("login: signed in / registered", r.code === 0 && /Logged in/.test(r.err), r.err);
  if (r.code !== 0) return;

  r = tg("me");
  check("me", r.code === 0 && r.rows[0]?.phone?.endsWith(phone.slice(-4)), JSON.stringify(r.rows[0]));

  // A public channel with a few posts, created straight through gramjs with the same session.
  const keys = { apiId: Number(process.env.TG_API_ID ?? sec("tg-skill-api-id")), apiHash: process.env.TG_API_HASH ?? sec("tg-skill-api-hash") ?? "" };
  const client = new TelegramClient(new StringSession(readFileSync(join(home, "session.txt"), "utf8").trim()), keys.apiId, keys.apiHash, { testServers: true });
  client.setLogLevel("error" as any);
  await client.connect();
  const username = `tgskill_${Date.now().toString(36)}`;
  let channel: any;
  try {
    const created: any = await client.invoke(new Api.channels.CreateChannel({ title: "Skill test channel", about: "skill test", broadcast: true }));
    channel = created.chats[0];
    await client.invoke(new Api.channels.UpdateUsername({ channel, username }));
    await client.sendMessage(channel, { message: "Old post about the weather" });
    await client.sendMessage(channel, { message: "New meeting on Friday at 19:00. Read more", formattingEntities: [
      new Api.MessageEntityTextUrl({ offset: 32, length: 9, url: "https://example.com/item/1" })] });
    await client.sendMessage(channel, { message: "See https://example.com/item/2 too" });
    check("setup: test channel with 3 posts", true, "@" + username);
  } catch (e: any) {
    check("setup: test channel", false, e.message);
  }

  if (channel) {
    r = tg("read", "@" + username, "--max", "5");
    check("read @channel", r.code === 0 && r.rows.length === 3, `${r.rows.length} posts ${r.err}`);
    const post = r.rows.find((m: any) => m.text?.includes("Friday"));
    check("hidden link under a word", post?.links?.[0] === "https://example.com/item/1", JSON.stringify(post?.links));
    check("post link", post?.url === `https://t.me/${username}/${post?.id}`, post?.url);
    const plain = r.rows.find((m: any) => m.text?.startsWith("See"));
    check("visible link", plain?.links?.[0] === "https://example.com/item/2", JSON.stringify(plain?.links));

    r = tg("read", `https://t.me/${username}`, "--since", new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    check("read --since (t.me link)", r.code === 0 && r.rows.length === 3, `${r.rows.length} ${r.err}`);

    r = tg("read", `-100${channel.id}`, "--max", "1");
    check("read by numeric id", r.code === 0 && r.rows.length === 1, r.err);

    r = tg("search", "Friday", "--in", "@" + username);
    check("search inside a chat", r.code === 0 && r.rows.length === 1 && r.rows[0].text.includes("Friday"), r.err);

    r = tg("members", "@" + username);
    check("members (as channel admin)", r.code === 0 && r.rows.length >= 1, `${r.rows.length} ${r.err}`);

    r = tg("chats", "--match", "skill test");
    check("chats --match", r.code === 0 && r.rows.some((c: any) => c.username === username && c.type === "channel"), r.err);
  }

  r = tg("send", "me", "Skill check https://example.com/saved");
  check("send to Saved Messages", r.code === 0 && r.rows[0]?.sent === true, r.err);
  r = tg("read", "me", "--max", "1");
  check("read Saved Messages", r.code === 0 && r.rows[0]?.text?.startsWith("Skill check") && r.rows[0]?.links?.[0] === "https://example.com/saved", r.err);

  // The test network has few public chats, so these only have to answer without errors.
  r = tg("search", "Skill check", "--max", "20");
  check("global search runs", r.code === 0, `${r.rows.length} hits ${r.err}`);
  r = tg("find-channels", "telegram", "--max", "5");
  check("find-channels runs", r.code === 0, `${r.rows.length} found ${r.err}`);
  r = tg("read", "@this_chat_does_not_exist_123456");
  check("unknown chat gives a clear error", r.code !== 0 && r.err.length > 0, r.err.slice(0, 80));

  if (channel) {
    try { await client.invoke(new Api.channels.DeleteChannel({ channel })); check("cleanup: test channel deleted", true); }
    catch (e: any) { check("cleanup: test channel deleted", false, e.message); }
  }
  try { await client.invoke(new Api.account.DeleteAccount({ reason: "skill test" })); check("cleanup: test account deleted", true); }
  catch (e: any) { check("cleanup: test account deleted", false, e.message); }
  await client.disconnect();
}

function sec(service: string) {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"], { stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}

try { await main(); }
catch (e: any) { check("unexpected error", false, e.message); }
finally { rmSync(home, { recursive: true, force: true }); }
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
