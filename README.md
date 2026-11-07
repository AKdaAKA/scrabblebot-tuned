# ScrabbleBot — tuned bot

Drop-in for `bot-starter/`. Same connection flow and env vars as the starter; new brain.

## Install

```bash
git clone https://github.com/clockworklabs/scrabblebot
cd scrabblebot/bot-starter
npm install && npm run generate          # needs the spacetime CLI, same as the starter

# copy this package over the starter
cp -r <this-folder>/src/engine src/
cp <this-folder>/src/index.ts src/index.ts
cp -r <this-folder>/sim .

BOT_NAME=<name> BOT_TOKEN=<token from /team> npm start     # first run
BOT_NAME=<name> npm start                                    # later runs (token saved)
BOT_NAME=<name> TOURNAMENT_ID=<id> npm start                 # tournament
QUIET=1 BOT_NAME=<name> npm start                            # only log match results
```

The bot exits on disconnect (exit 2). Run it under a restart loop so it never sits out a match:
`while true; do BOT_NAME=<name> npm start; sleep 2; done`

`npm run build` (tsc) only works if you add `"allowImportingTsExtensions": true, "noEmit": true` to
tsconfig. `npm start` (tsx) doesn't need it.

## How it plays

Rules taken from `spacetimedb/src/game.ts`, which differ from the docs in places:

- **Unbid tiles are used up, not returned to the bag.** A 6-bot match is always 98 − 30 = 68
  auctions. `matchState.bagTotal` is the exact number of auctions left.
- **Leftover coins count for nothing.** Score only grows from words. Coins are only bidding power.
- **The final auction's letter can't be used.** The match ends in the same transaction, so the
  real deadline is when the last auction opens (`bagTotal == 0`).

The strategy:

1. **Rack value.** A beam search splits the rack into words, maximising
   `Σ reward(words played now) + α · Σ (face + glue)` over held tiles. α shrinks as the bag empties
   (≈2.5 early → 0 at the end). Held tiles are worth close to 3× face early, because they can still
   go into 7+ letter words. At the end only real words count.
2. **Bids.** A letter's value is `value(rack + letter) − value(rack)`. The bid is that value × κ coins
   per point, where κ rises when we hold more coins than the remaining auctions need. The bid is
   capped at the richest rival's balance + 1. With fewer than 3 usable auctions left it bids
   everything on any useful letter. It bids 0 on the final letter. In first-price matches it bids
   just above recent clearing prices for letters of similar value.
3. **Plays.** It plays a word only when that beats holding the tiles. In practice that means long
   (usually 7+) words mid-game, and the full best split as soon as the final auction opens.

## Local simulator (`sim/`)

It copies the module's rules: deal, Vickrey/first-price, sim bot strategies ±2 jitter, sims playing
their longest 3+ letter word on each win, and the unusable last letter.

```bash
node sim/bench.ts 40          # vs sims / starter / hoarders / mixed (Node ≥ 22.18, or: npx tsx sim/bench.ts)
node sim/roundrobin.ts 50 1   # parameter sets at the same table
node sim/tune.ts 14 14 1 '<json params>'   # self-play random search from a starting point
node sim/check.ts             # tuned benchmark + worst-case decision latency
```

Parameters live in `src/engine/params.ts`.
