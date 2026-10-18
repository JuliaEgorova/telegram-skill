# tg — Telegram skill for Claude Code

Lets Claude Code read and search Telegram with **your own account**: find channels on a topic, read them for a period, search messages across Telegram or inside one chat, collect the links from posts, list your chats and group members. Sending a message is supported too, but the skill tells Claude to send only after you approve the exact text and recipient.


## Install

> **Beta.** Every command is covered by offline tests against a fake Telegram, and connecting to Telegram's servers is checked; logging in with a cloud password (two-step verification) and paging through more than 100 global search results have not been tried on a live account yet. Issues and reports are welcome.

1. Install [Bun](https://bun.sh) if you don't have it:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
2. Put the skill where Claude Code looks for skills and install its one dependency:
   ```bash
   git clone https://github.com/JuliaEgorova/telegram-skill ~/.claude/skills/tg
   cd ~/.claude/skills/tg && bun install
   ```
3. Get `api_id` and `api_hash` at https://my.telegram.org → **API development tools** (the login code arrives in your Telegram app, not by SMS). If the form says "ERROR" when you create the app, turn off VPN or ad blockers or try another browser — it's a known issue of that page.
4. Log in **in your own terminal** (not through the Claude chat, where commands and codes are visible):
   ```bash
   cd ~/.claude/skills/tg
   bun scripts/tg.ts setup <api_id> <api_hash> <phone, e.g. +447700900000>
   bun scripts/tg.ts login            # Telegram sends a code to your app
   bun scripts/tg.ts login <code>     # add --password <cloud password> if you use one
   ```
Then just ask Claude about Telegram.

## Privacy

- On macOS the keys and the login session are kept in the **Keychain** (encrypted). On other systems they are files in `~/.config/tg-skill/` readable only by you. Nothing secret is ever stored in this folder, so the repository is safe to share.
- The session is the key to your account: whoever has it can read and write as you. `tg logout` ends it on Telegram's side and deletes everything stored. You can also end it in Telegram → Settings → Devices.
- Everything runs on your computer and talks to Telegram directly; nothing goes to third-party servers.

## If something doesn't work

| What you see | What to do |
|---|---|
| `bun: command not found` | Install Bun (step 1) and open a new terminal |
| `Cannot find package 'telegram'` | Run `bun install` in the skill folder |
| "ERROR" on my.telegram.org when creating the app | Disable VPN / ad blockers, try another browser |
| `This account has a cloud password` | `tg login <code> --password <your cloud password>` |
| `PHONE_CODE_EXPIRED` | Run `tg login` again for a fresh code and enter it within a few minutes |
| `Telegram asked to wait …s` / `FLOOD_WAIT` | You made too many requests; wait and try again later |
| `CHANNEL_PRIVATE` | The chat is private and you are not a member |

## Commands

```
tg me
tg chats [--max N] [--match text]
tg read <chat> [--max N] [--since YYYY-MM-DD]
tg search <query> [--max N] [--since YYYY-MM-DD]
tg search <query> --in <chat> [--max N]
tg find-channels <query> [--max N]
tg members <chat> [--max N]
tg send <chat> <text>
tg logout
```

Output is NDJSON (one JSON object per line).

## Tests

```bash
bun test
```

The tests run every command against a fake Telegram client, so they need no account and no network.

## License

MIT
