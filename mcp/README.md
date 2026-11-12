# The Waterworld dungeon master

An MCP server that makes an AI agent the storyteller of a game of Waterworld. In the story it is the captain's
**first mate**: one of the people of the port the captain starts from, chosen there, who goes where the captain
goes, follows them ashore, runs errands, learns rumours, helps navigate and shares what they know. It plays no one
else itself: each person the captain speaks with is played by a fresh subagent that is told only that person's life
as the game keeps it, where they are, the day, and what they could know of the captain.

It needs no packages: Node 22 or later and this folder.

## Setting it up

```bash
claude mcp add waterworld-dm -- node /path/to/waterworld/mcp/waterworld-dm.mjs
```

Any agent app that runs stdio MCP servers will do. The server's own instructions tell the agent the rest, in this
order:

1. **Sign in with a Caiioo account** (`sign_in`). The agent gives you a link to a page on this computer. There you
   open Caiioo's approval page, approve this program, and type the six-digit code Caiioo shows you. The code goes
   from that page to the server and never through the chat; the agent never sees it, your password or the session.
   Every other tool refuses until an account is signed in.
2. **Choose where the lore is kept** (`lore_open`): a folder on this computer (it is made, with its first pages), or
   another store the agent keeps with its own tools.
3. **Pair with the game**: the agent gives you a six-character code; type it under *Storyteller* in the game's
   Captain panel. The page then speaks to the server over one WebSocket on `127.0.0.1`.
4. **Choose the mate** (`mate_candidates`, `mate_choose`) from the port's people, or take the one the player has
   already signed on in the game.

## Without a storyteller

The mate is in the game whether or not this server is running. A bar at the lower left of the game opens to the
questions that fit the moment (*Where are we?*, *How does she sail?*, *What is this place?*, *What sells here?*,
*What is the talk?*, *Who rules here?*, *How are our stores?*, *Who is that?*), and the mate answers each at once
from what the game and the country's model hold (`js/mate-counsel.js`). In a port whose people the model keeps,
*Who here would sign on as mate?* tells of those who would come and signs one on; from then on the mate has a life
of their own to tell of, and leaves the town's roll for the ship's.

A storyteller that pairs later finds that mate in `situation`, takes them with `mate_choose` (which then only writes
their page), and hears each question and answer as a `counsel` event, so that it keeps to what the mate has said.

## What the agent can do

| Tools | For |
|---|---|
| `sign_in`, `account` | The Caiioo account; what is reported under it; signing out |
| `lore_open`, `lore_read`, `lore_write`, `lore_list`, `lore_search`, `record` | The lore: `player.md`, `mate.md`, `plot.md`, `chronicle.md`, `people/`, `places/` |
| `situation`, `world`, `find`, `inspect`, `chronicle`, `panel` | The game and the country's model: date, ship, purse, realm, treasury, towns, houses, people, annals |
| `mate_candidates`, `mate_choose` | The first mate |
| `nearby`, `character_brief` | Who is about the captain; the brief for a subagent that plays one of them |
| `say`, `narrate`, `events` | Words on the player's screen; what the player has done since last asked |

Prompts: `dungeon_master` (the whole charge) and `play_character` (a brief, as a prompt).

What is under a `## Private` heading in the lore never reaches a character's brief.

## What is reported, and what is not

Under your Caiioo account, to `https://sixcailloux.com/waterworld/api/dm/`: which tools the storyteller used and how
long each took, whether they failed, how many characters went in and out, how much lore is kept (counts only), and
the game's own figures (date, port, realm, the captain's worth, the mate's number and calling).

Never reported: anything said by you, the storyteller or a character, any page of the lore, any brief, any search,
or the name of any file or folder. Every event is rebuilt field by field from a fixed list of numbers, flags and
short words (`dm-telemetry.mjs`), so a sentence has no field to travel in. The `account` tool shows the session's
sum. What cannot be sent waits, cleaned, in `~/.config/waterworld-dm/unsent.json`.

The session Caiioo gives is kept in `~/.config/waterworld-dm/account.json`, readable by you alone. It is sent only
to Caiioo's relay and, as the bearer of each report, to the statistics endpoint, which asks the relay whose it is
and keeps none of it.

## Who may reach it

- The page for the six-digit code is served to `127.0.0.1` only, under a key made for the session.
- The game's socket opens only to the game's own pages (`https://sixcailloux.com`, or one served from this machine)
  with the pairing code. Five wrong codes in a minute and it hears none for the next.
- The game answers only the questions listed in `js/storyteller.js`; the server cannot make the page run anything.

## Settings

| Variable | Default | |
|---|---|---|
| `WATERWORLD_DM_PORT` | `7467` | First of the ten ports tried. The game looks on `7467` to `7476` only. |
| `WATERWORLD_DM_CODE` | random | The five letters of the pairing code |
| `WATERWORLD_DM_ORIGINS` | none | More pages allowed to open the socket, comma-separated origins |
| `WATERWORLD_DM_CONFIG` | `~/.config/waterworld-dm/config.json` | Where the lore's place is remembered |
| `WATERWORLD_DM_ACCOUNT_FILE` | `~/.config/waterworld-dm/account.json` | The Caiioo session |
| `WATERWORLD_DM_SPOOL` | `~/.config/waterworld-dm/unsent.json` | Reports not yet sent |
| `WATERWORLD_DM_RELAY`, `WATERWORLD_DM_STATS` | Caiioo's relay; the endpoint above | For tests: only an address on this machine is accepted |

## Limits

- Caiioo's relay must admit this program as a device-link client (`waterworld`) before anyone can sign in.
- A port without a living model has no people to choose a mate from, and no one to brief: the ship's own mate
  answers there, from the game alone.
- Aboard, the chosen mate is heard through the panel; the deck's own crew is drawn as before.
- The gate is in a program you run yourself: it keeps honest players signed in, and nothing more. What the account
  truly governs is what the servers give.

## Tests

```bash
node --test tests/dungeon-master.test.mjs tests/dungeon-master-server.test.mjs tests/storyteller.test.mjs tests/mate-counsel.test.mjs tests/board-embark.test.mjs
```

`tests/storyteller-gpu.test.mjs` runs the server against the real game at Lisbon in a headless browser.
