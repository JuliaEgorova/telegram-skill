// Commands run against a fake Telegram client: no account, no network.
// The fake mimics the parts of gramjs the commands use (iterMessages, invoke, getEntity, ...).
import { describe, expect, test } from "bun:test";
import { commands, parseArgs, linksOf, postLink, chatRef, message, withFloodWait } from "../scripts/commands";

const day = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const news = { className: "Channel", id: 1111111111, title: "Book Club News", username: "bookclub_news", broadcast: true, participantsCount: 1200 };
const privateGroup = { className: "Channel", id: 2222222222, title: "Hiking group", broadcast: false };
const me = { className: "User", id: 42, firstName: "Alex", lastName: "Example", username: "alex", phone: "10000000000" };

// Newest first, as Telegram returns them.
const posts = [
  { id: 103, date: day("2025-01-12T10:00:00Z"), message: "New meeting on Friday at 19:00. Read more", sender: me,
    entities: [{ className: "MessageEntityTextUrl", offset: 32, length: 9, url: "https://example.com/meeting/1" }] },
  { id: 102, date: day("2025-01-05T10:00:00Z"), message: "See https://t.me/bookclub_news/90 and the photo", media: { className: "MessageMediaPhoto" },
    entities: [{ className: "MessageEntityUrl", offset: 4, length: 29 }],
    replyMarkup: { rows: [{ buttons: [{ url: "https://wa.me/10000000000" }, { text: "no url" }] }] } },
  { id: 101, date: day("2024-12-28T10:00:00Z"), message: "Old post", replyTo: { replyToMsgId: 100 } },
];

function fakeClient(over: Record<string, any> = {}) {
  const calls: any[] = [];
  const client = {
    calls,
    async getMe() { return me; },
    async getEntity(ref: any) {
      calls.push(["getEntity", ref]);
      if (ref === "bookclub_news" || ref === -1001111111111) return news;
      if (ref === "me") return me;
      throw new Error(`Cannot find any entity corresponding to "${ref}"`);
    },
    async getInputEntity(e: any) { return { className: "InputPeerChannel", channelId: e.id }; },
    async *iterMessages(chat: any, opts: any) {
      calls.push(["iterMessages", chat.username ?? chat.id, opts]);
      let list = posts;
      if (opts.search) list = list.filter(p => p.message.toLowerCase().includes(opts.search.toLowerCase()));
      for (const p of list.slice(0, opts.limit)) yield p;
    },
    async *iterDialogs() {
      yield { title: news.title, entity: news, unreadCount: 3, message: posts[0] };
      yield { title: "Sam", entity: { className: "User", id: 7, firstName: "Sam" }, unreadCount: 0 };
      yield { title: privateGroup.title, entity: privateGroup, unreadCount: 0 };
    },
    async *iterParticipants(_chat: any, opts: any) {
      for (const u of [me, { className: "User", id: 9, firstName: "Bot", bot: true }].slice(0, opts.limit)) yield u;
    },
    async sendMessage(chat: any, opts: any) { calls.push(["sendMessage", chat.username, opts.message]); return { id: 555 }; },
    async invoke(req: any) { calls.push(["invoke", req.className, req]); throw new Error(`unexpected ${req.className}`); },
    ...over,
  };
  return client;
}

async function run(argv: string[], client: any) {
  const rows: any[] = [];
  const a = parseArgs(argv);
  await commands[a.pos[0]](client, a, r => rows.push(r));
  return rows;
}

describe("arguments", () => {
  test("flags with values, bare flags and positional words", () => {
    const a = parseArgs(["search", "book", "club", "--max", "5", "--since", "2025-01-01", "--dry"]);
    expect(a.pos).toEqual(["search", "book", "club"]);
    expect(a.max).toBe(5);
    expect(a.since).toBe(day("2025-01-01"));
    expect(a.flags.dry).toBe("true");
  });
  test("bad --max and --since are explained instead of silently ignored", () => {
    expect(() => parseArgs(["read", "x", "--max", "abc"])).toThrow("--max");
    expect(() => parseArgs(["read", "x", "--max", "0"])).toThrow("--max");
    expect(() => parseArgs(["read", "x", "--since", "yesterday"])).toThrow("--since");
  });
  test("chat references: @name, t.me links, numeric ids, me", () => {
    expect(chatRef("@bookclub_news")).toBe("bookclub_news");
    expect(chatRef("https://t.me/bookclub_news/103")).toBe("bookclub_news");
    expect(chatRef("t.me/bookclub_news")).toBe("bookclub_news");
    expect(chatRef("-1001111111111")).toBe(-1001111111111);
    expect(chatRef("me")).toBe("me");
  });
});

describe("message formatting", () => {
  test("collects visible, hidden and button links without duplicates", () => {
    expect(linksOf(posts[0])).toEqual(["https://example.com/meeting/1"]);
    expect(linksOf(posts[1])).toEqual(["https://t.me/bookclub_news/90", "https://wa.me/10000000000"]);
    expect(linksOf({ message: "x", entities: [{ url: "https://a" }, { url: "https://a" }, { url: "tg://user?id=1" }] })).toEqual(["https://a"]);
  });
  test("post links for public and private channels; none for people", () => {
    expect(postLink(news, 7)).toBe("https://t.me/bookclub_news/7");
    expect(postLink(privateGroup, 7)).toBe("https://t.me/c/2222222222/7");
    expect(postLink(me, 7)).toBeUndefined();
  });
  test("a message keeps chat, author, date, reply and media type", () => {
    expect(message(posts[1], news)).toMatchObject({
      chat: "Book Club News", chatId: "-1001111111111", id: 102, date: "2025-01-05T10:00:00.000Z",
      url: "https://t.me/bookclub_news/102", media: "Photo",
    });
    expect(message(posts[0], news).from).toBe("Alex Example");
    expect(message(posts[2]).replyTo).toBe(100);
  });
});

describe("commands", () => {
  test("me", async () => {
    expect(await run(["me"], fakeClient())).toEqual([{ id: "42", name: "Alex Example", username: "alex", phone: "10000000000" }]);
  });

  test("chats: types, filter by name and --max", async () => {
    const all = await run(["chats"], fakeClient());
    expect(all.map(c => [c.title, c.type, c.id])).toEqual([
      ["Book Club News", "channel", "-1001111111111"], ["Sam", "user", "7"], ["Hiking group", "group", "-1002222222222"]]);
    expect((await run(["chats", "--match", "book"], fakeClient())).map(c => c.title)).toEqual(["Book Club News"]);
    expect(await run(["chats", "--max", "1"], fakeClient())).toHaveLength(1);
  });

  test("read: last N messages", async () => {
    const rows = await run(["read", "@bookclub_news", "--max", "2"], fakeClient());
    expect(rows.map(r => r.id)).toEqual([103, 102]);
  });

  test("read --since stops at the date and is not cut by the default --max", async () => {
    const c = fakeClient();
    const rows = await run(["read", "https://t.me/bookclub_news", "--since", "2025-01-01"], c);
    expect(rows.map(r => r.id)).toEqual([103, 102]);
    expect(c.calls.find(x => x[0] === "iterMessages")[2].limit).toBeGreaterThanOrEqual(5000);
  });

  test("read by numeric id reaches Telegram as a number", async () => {
    const c = fakeClient();
    await run(["read", "-1001111111111", "--max", "1"], c);
    expect(c.calls[0]).toEqual(["getEntity", -1001111111111]);
  });

  test("read: unknown chat is an error, not an empty result", async () => {
    await expect(run(["read", "@nope"], fakeClient())).rejects.toThrow("nope");
  });

  test("search inside one chat", async () => {
    const rows = await run(["search", "friday", "--in", "@bookclub_news"], fakeClient());
    expect(rows.map(r => r.id)).toEqual([103]);
  });

  test("global search walks pages with the right offsets and stops at --max", async () => {
    const page = (ids: number[], cls: string, nextRate?: number) => ({
      className: cls, nextRate, chats: [news], users: [],
      messages: ids.map(id => ({ id, date: day("2025-01-10T00:00:00Z") - id, message: `post ${id}`, peerId: { channelId: news.id } })),
    });
    const pages = [page([1, 2, 3], "messages.MessagesSlice", 777), page([4, 5], "messages.MessagesSlice", 888), page([6], "messages.Messages")];
    const c = fakeClient({ async invoke(req: any) { c.calls.push(["invoke", req.className, req]); return pages.shift(); } });
    const rows = await run(["search", "book", "--max", "4", "--since", "2025-01-01"], c);
    expect(rows.map(r => r.id)).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ chat: "Book Club News", url: "https://t.me/bookclub_news/1" });
    const reqs = c.calls.filter(x => x[0] === "invoke").map(x => x[2]);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ q: "book", minDate: day("2025-01-01"), offsetId: 0, limit: 4 });
    expect(reqs[1]).toMatchObject({ offsetRate: 777, offsetId: 3, limit: 1 });
    expect(reqs[1].offsetPeer).toMatchObject({ channelId: news.id });
  });

  test("global search stops when Telegram says there are no more pages", async () => {
    let n = 0;
    const c = fakeClient({ async invoke() { n++; return { className: "messages.Messages", chats: [], users: [], messages: [{ id: 1, date: 0, message: "a", peerId: {} }] }; } });
    expect(await run(["search", "x", "--max", "100"], c)).toHaveLength(1);
    expect(n).toBe(1);
  });

  test("find-channels lists public channels with links", async () => {
    const c = fakeClient({ async invoke(req: any) { expect(req.className).toBe("contacts.Search"); return { chats: [news, privateGroup] }; } });
    const rows = await run(["find-channels", "book", "club"], c);
    expect(rows).toEqual([
      { id: "-1001111111111", title: "Book Club News", username: "bookclub_news", url: "https://t.me/bookclub_news", type: "channel", members: 1200 },
      { id: "-1002222222222", title: "Hiking group", username: undefined, url: undefined, type: "group", members: undefined },
    ]);
  });

  test("members", async () => {
    const rows = await run(["members", "@bookclub_news"], fakeClient());
    expect(rows).toEqual([{ id: "42", name: "Alex Example", username: "alex", bot: undefined }, { id: "9", name: "Bot", username: undefined, bot: true }]);
  });

  test("send joins the words and reports the new message", async () => {
    const c = fakeClient();
    const rows = await run(["send", "@bookclub_news", "Hello,", "is", "the", "meeting", "on?"], c);
    expect(c.calls.find(x => x[0] === "sendMessage")).toEqual(["sendMessage", "bookclub_news", "Hello, is the meeting on?"]);
    expect(rows[0]).toEqual({ sent: true, chat: "Book Club News", id: 555, url: "https://t.me/bookclub_news/555" });
  });

  test("commands without required words explain their usage", async () => {
    for (const cmd of ["read", "search", "find-channels", "members", "send"]) {
      await expect(run([cmd], fakeClient())).rejects.toThrow("Usage");
    }
    await expect(run(["send", "@bookclub_news"], fakeClient())).rejects.toThrow("Usage");
  });
});

describe("rate limits", () => {
  test("waits once on FLOOD_WAIT and retries", async () => {
    let tries = 0; const slept: number[] = [];
    const r = await withFloodWait(async () => { if (++tries === 1) throw new Error("FLOOD_WAIT_3"); return "ok"; }, async ms => { slept.push(ms); });
    expect([r, tries, slept]).toEqual(["ok", 2, [4000]]);
  });
  test("long waits and other errors are passed on", async () => {
    await expect(withFloodWait(async () => { throw new Error("FLOOD_WAIT_9999"); }, async () => {})).rejects.toThrow("9999");
    await expect(withFloodWait(async () => { throw new Error("CHANNEL_PRIVATE"); }, async () => {})).rejects.toThrow("CHANNEL_PRIVATE");
  });
});
