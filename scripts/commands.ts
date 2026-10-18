// What each tg command does, given a connected Telegram client.
// Kept apart from the CLI (credentials, login, process) so it can run against a fake client in tests.
import { Api } from "telegram";

export interface Args { pos: string[]; flags: Record<string, string>; max: number; since: number }
export type Out = (o: unknown) => void;
export type Command = (client: any, args: Args, out: Out) => Promise<void>;

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      flags[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? "true" : argv[++i];
    } else pos.push(argv[i]);
  }
  const max = Number(flags.max ?? 50);
  if (!Number.isInteger(max) || max < 1) throw new Error(`--max must be a positive number, got "${flags.max}"`);
  let since = 0;
  if (flags.since) {
    since = Math.floor(Date.parse(flags.since) / 1000);
    if (!Number.isFinite(since)) throw new Error(`--since must be a date like 2025-01-01, got "${flags.since}"`);
  }
  return { pos, flags, max, since };
}

// ── formatting ──────────────────────────────────────────────────────────────

export function title(entity: any): string {
  if (!entity) return "";
  return entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "";
}

export function peerId(entity: any): string {
  if (entity.className === "Channel") return `-100${entity.id}`;
  if (entity.className === "Chat") return `-${entity.id}`;
  return String(entity.id);
}

// Every link in a post: visible URLs, links hidden under words ("подробнее") and inline buttons.
export function linksOf(m: any): string[] {
  const text: string = m.message ?? "";
  const urls: string[] = [];
  for (const e of m.entities ?? []) {
    if (e.url?.startsWith("http")) urls.push(e.url);
    else if (e.className === "MessageEntityUrl") {
      const u = text.substr(e.offset, e.length);
      if (/^https?:\/\//.test(u)) urls.push(u);
    }
  }
  for (const row of m.replyMarkup?.rows ?? []) for (const b of row.buttons ?? []) if (b.url) urls.push(b.url);
  return [...new Set(urls)];
}

// Only channels and supergroups have message links; private chats and small groups don't.
export function postLink(chat: any, id: number): string | undefined {
  if (chat?.className !== "Channel") return undefined;
  return chat.username ? `https://t.me/${chat.username}/${id}` : `https://t.me/c/${chat.id}/${id}`;
}

export function message(m: any, chat?: any) {
  return {
    chat: title(chat) || undefined,
    chatId: chat ? peerId(chat) : undefined,
    id: m.id,
    date: new Date(m.date * 1000).toISOString(),
    from: title(m.sender) || undefined,
    text: m.message ?? "",
    links: linksOf(m),
    url: postLink(chat, m.id),
    replyTo: m.replyTo?.replyToMsgId,
    media: m.media ? String(m.media.className).replace(/^MessageMedia/, "") : undefined,
  };
}

// "@name", "t.me/name/123", "https://t.me/name", numeric id ("-1001234567890") or "me".
// Numeric ids must reach gramjs as numbers: a numeric string is looked up as a username and fails.
export function chatRef(ref: string): string | number {
  const clean = ref.trim().replace(/^https?:\/\//, "").replace(/^t\.me\//, "").replace(/^@/, "").split("/")[0];
  return /^-?\d+$/.test(clean) ? Number(clean) : clean;
}

// Telegram asks clients to wait when they go too fast; honour it once instead of failing.
export async function withFloodWait<T>(fn: () => Promise<T>, sleep = (ms: number) => Bun.sleep(ms)): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    const wait = Number(/FLOOD_WAIT_(\d+)|wait of (\d+)/.exec(String(e.message))?.slice(1).find(Boolean));
    if (!wait || wait > 300) throw e;
    console.error(`Telegram asked to wait ${wait}s…`);
    await sleep((wait + 1) * 1000);
    return fn();
  }
}

// ── commands ────────────────────────────────────────────────────────────────

const me: Command = async (client, _a, out) => {
  const u: any = await client.getMe();
  out({ id: String(u.id), name: title(u), username: u.username, phone: u.phone });
};

const chats: Command = async (client, { flags, max }, out) => {
  const match = flags.match?.toLowerCase();
  let n = 0;
  for await (const d of client.iterDialogs({})) {
    const e: any = d.entity;
    if (match && !(d.title ?? "").toLowerCase().includes(match)) continue;
    out({
      id: peerId(e), title: d.title, username: e?.username,
      type: e?.className === "Channel" ? (e.broadcast ? "channel" : "group") : e?.className === "Chat" ? "group" : "user",
      unread: d.unreadCount, members: e?.participantsCount, last: d.message?.message?.slice(0, 120),
    });
    if (++n >= max) break;
  }
};

const read: Command = async (client, { pos, max, since }, out) => {
  if (!pos[1]) throw new Error("Usage: tg read <chat> [--max N] [--since YYYY-MM-DD]");
  const chat = await client.getEntity(chatRef(pos[1]));
  let n = 0;
  // With --since the limit is a safety net, not the goal: read back until the date.
  for await (const m of client.iterMessages(chat, { limit: since ? Math.max(max, 5000) : max })) {
    if (since && m.date < since) break;
    out(message(m, chat));
    if (!since && ++n >= max) break;
  }
};

const search: Command = async (client, { pos, flags, max, since }, out) => {
  const query = pos.slice(1).join(" ");
  if (!query) throw new Error("Usage: tg search <query> [--in <chat>] [--max N] [--since YYYY-MM-DD]");
  if (flags.in) {
    const chat = await client.getEntity(chatRef(flags.in));
    for await (const m of client.iterMessages(chat, { search: query, limit: max })) {
      if (since && m.date < since) break;
      out(message(m, chat));
    }
    return;
  }
  // Global search pages by (rate, peer, id); Telegram caps each page at 100.
  let offsetRate = 0, offsetPeer: any = new Api.InputPeerEmpty(), offsetId = 0, n = 0;
  while (n < max) {
    const r: any = await withFloodWait(() => client.invoke(new Api.messages.SearchGlobal({
      q: query, filter: new Api.InputMessagesFilterEmpty(), minDate: since, maxDate: 0,
      offsetRate, offsetPeer, offsetId, limit: Math.min(100, max - n),
    })));
    const msgs = r.messages ?? [];
    if (!msgs.length) break;
    const byId = new Map<string, any>();
    for (const c of [...(r.chats ?? []), ...(r.users ?? [])]) byId.set(String(c.id), c);
    const chatOf = (m: any) => byId.get(String(m.peerId?.channelId ?? m.peerId?.chatId ?? m.peerId?.userId));
    for (const m of msgs) {
      if (n >= max) break;
      out(message(m, chatOf(m)));
      n++;
    }
    // Only a slice result has more pages; a full "messages.Messages" answer is everything there is.
    if (r.className !== "messages.MessagesSlice") break;
    const last = msgs[msgs.length - 1];
    offsetRate = r.nextRate ?? last.date;
    offsetId = last.id;
    const lastChat = chatOf(last);
    offsetPeer = lastChat ? await client.getInputEntity(lastChat) : new Api.InputPeerEmpty();
  }
};

const findChannels: Command = async (client, { pos, max }, out) => {
  const query = pos.slice(1).join(" ");
  if (!query) throw new Error("Usage: tg find-channels <query> [--max N]");
  const r: any = await withFloodWait(() => client.invoke(new Api.contacts.Search({ q: query, limit: Math.min(max, 100) })));
  for (const c of (r.chats ?? []).slice(0, max)) {
    out({ id: peerId(c), title: c.title, username: c.username, url: c.username ? `https://t.me/${c.username}` : undefined,
      type: c.broadcast ? "channel" : "group", members: c.participantsCount });
  }
};

const members: Command = async (client, { pos, max }, out) => {
  if (!pos[1]) throw new Error("Usage: tg members <chat> [--max N]");
  const chat = await client.getEntity(chatRef(pos[1]));
  for await (const u of client.iterParticipants(chat, { limit: max })) {
    const x: any = u;
    out({ id: String(x.id), name: title(x), username: x.username, bot: x.bot || undefined });
  }
};

const send: Command = async (client, { pos }, out) => {
  const [, ref, ...words] = pos;
  if (!ref || !words.length) throw new Error("Usage: tg send <chat> <text>");
  const chat = await client.getEntity(chatRef(ref));
  const m: any = await client.sendMessage(chat, { message: words.join(" ") });
  out({ sent: true, chat: title(chat), id: m.id, url: postLink(chat, m.id) });
};

export const commands: Record<string, Command> = {
  me, chats, read, search, "find-channels": findChannels, members, send,
};
