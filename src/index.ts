// ScrabbleBot — tuned bot. Drop-in replacement for bot-starter/src/index.ts.
//
//   BOT_NAME=<name> BOT_TOKEN=<token from /team> npm start     (first run)
//   BOT_NAME=<name> npm start                                    (token saved to .token-<name>)
//   BOT_NAME=<name> TOURNAMENT_ID=<id> npm start                 (register for a tournament)
//
// What it does differently from the starter:
//  * values each letter by how much it raises the best split of the rack into
//    words (with a decaying bonus for held tiles), bids that in coins via Vickrey
//  * knows exactly how many auctions are left (matchState.bagTotal) — coins are
//    worthless at the end, so it spends them down; the last letter is worthless,
//    so it doesn't bid on it
//  * holds tiles for 7+ letter words (3×), and when the final auction opens it
//    plays the best full split of the rack in one burst

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { WordIndex, letterIndex, rackToString } from "./engine/words.ts";
import { Brain } from "./engine/strategy.ts";
import { TUNED_PARAMS } from "./engine/params.ts";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const QUIET = process.env.QUIET === "1";
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

const log = (...a: unknown[]) => { if (!QUIET) console.log(`[${BOT_NAME}]`, ...a); };
const warn = (...a: unknown[]) => console.warn(`[${BOT_NAME}]`, ...a);

function loadToken(): string | undefined {
  try { return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined; } catch { return undefined; }
}
function saveToken(tok: string) { fs.writeFileSync(TOKEN_PATH, tok); }

// ---------- Dictionary + brain ----------

const here = path.dirname(new URL(import.meta.url).pathname);
const dictCandidates = [
  path.join(here, "..", "..", "spacetimedb", "wordlist.txt"),
  path.join(here, "..", "wordlist.txt"),
];
const dictPath = dictCandidates.find((p) => fs.existsSync(p));
if (!dictPath) {
  console.error("wordlist.txt not found (looked in ../spacetimedb and the bot folder)");
  process.exit(1);
}
const t0 = Date.now();
const IDX = new WordIndex(fs.readFileSync(dictPath, "utf8").split("\n"));
const BRAIN = new Brain(IDX, TUNED_PARAMS);
log(`dictionary: ${IDX.words.length} words in ${Date.now() - t0}ms`);

// ---------- State ----------

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidAuctions = new Set<string>();
const finalDone = new Set<string>(); // matches whose final burst we've sent
// Letters committed to words we've submitted but the server hasn't confirmed yet.
const inflight = new Map<string, Uint8Array>();
const paidByMatch = new Map<string, { letter: string; paid: number }[]>();

function serverRack(conn: DbConnection, matchId: bigint): Uint8Array {
  const r = new Uint8Array(26);
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    const k = letterIndex(h.letter);
    if (k >= 0 && k < 26) r[k] = Math.min(255, r[k]! + h.count);
  }
  return r;
}

/** Our rack minus letters already promised to submitted words. */
function workingRack(conn: DbConnection, matchId: bigint): Uint8Array {
  const r = serverRack(conn, matchId);
  const f = inflight.get(String(matchId));
  if (f) for (let k = 0; k < 26; k++) r[k] = Math.max(0, r[k]! - f[k]!);
  return r;
}

function participants(conn: DbConnection, matchId: bigint) {
  return Array.from(conn.db.matchParticipant.iter()).filter((p) => p.matchId === matchId);
}

function myRunningMatches(conn: DbConnection): bigint[] {
  if (myBotId === null) return [];
  const out: bigint[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    if (conn.db.matchState.id.find(p.matchId)?.status.tag === "Running") out.push(p.matchId);
  }
  return out;
}

function logFailure(what: string) {
  return (err: unknown) => warn(`${what} failed: ${err instanceof Error ? err.message : err}`);
}

// ---------- Actions ----------

function submitWords(conn: DbConnection, matchId: bigint, words: string[]) {
  const key = String(matchId);
  for (const word of words) {
    const used = new Uint8Array(26);
    for (const c of word) used[letterIndex(c)]!++;
    const f = inflight.get(key) ?? new Uint8Array(26);
    for (let k = 0; k < 26; k++) f[k]! += used[k]!;
    inflight.set(key, f);
    const release = () => {
      const g = inflight.get(key);
      if (g) for (let k = 0; k < 26; k++) g[k] = Math.max(0, g[k]! - used[k]!);
    };
    log(`match ${matchId}: play ${word}`);
    conn.reducers
      .submitWord({ matchId, word })
      .then(release, (e: unknown) => { release(); logFailure(`play ${word}`)(e); });
  }
}

/** Play whatever the plan says to play now in one match. */
function playNow(conn: DbConnection, matchId: bigint) {
  const m = conn.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return;
  const final = m.bagTotal === 0;
  const rack = workingRack(conn, matchId);
  const words = BRAIN.choosePlays({ rack, bagTotal: m.bagTotal, final });
  if (words.length) submitWords(conn, matchId, words);
  if (final) finalDone.add(String(matchId));
}

function handleAuction(conn: DbConnection, a: { id: bigint; matchId: bigint; letter: string }) {
  if (myBotId === null) return;
  const key = `${a.matchId}:${a.id}`;
  if (bidAuctions.has(key)) return;
  const m = conn.db.matchState.id.find(a.matchId);
  if (!m || m.status.tag !== "Running") return;
  const ps = participants(conn, a.matchId);
  const me = ps.find((p) => p.botId === myBotId);
  if (!me) return;
  bidAuctions.add(key);
  const started = Date.now();

  // 1) Play first — on the final auction this is the whole game.
  playNow(conn, a.matchId);
  if (m.bagTotal === 0) {
    log(`match ${a.matchId}: final auction, burst sent in ${Date.now() - started}ms`);
    return;
  }

  // 2) Bid.
  let maxOpp = 0;
  for (const p of ps) if (p.botId !== myBotId) maxOpp = Math.max(maxOpp, Number(p.balance));
  const amount = BRAIN.decideBid({
    letter: a.letter,
    balance: Number(me.balance),
    rack: workingRack(conn, a.matchId),
    bagTotal: m.bagTotal,
    firstPrice: m.auctionType.tag === "FirstPrice",
    maxOppBalance: maxOpp,
    recentPaid: paidByMatch.get(String(a.matchId)) ?? [],
  });
  const ms = Date.now() - started;
  if (amount > 0) {
    conn.reducers
      .submitBid({ auctionId: a.id, amount: BigInt(amount) })
      .catch(logFailure(`bid on auction ${a.id}`));
  }
  log(
    `match ${a.matchId} [${m.bagTotal} left] '${a.letter}' bid ${amount} ` +
      `(bal ${me.balance}, rack ${rackToString(workingRack(conn, a.matchId))}, ${ms}ms)`,
  );
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  if (myRunningMatches(conn).length > 0) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find((l) => l.status.tag === "Open");
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some((lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId);
  if (alreadyIn) return;
  log("joining lobby");
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

// ---------- Wiring ----------

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function bootstrap(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() => log(`registered for tournament ${TOURNAMENT_ID}`))
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) if (a.status.tag === "Open") handleAuction(conn, a);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  log(`connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (!BOT_NONCE) {
          console.error(`[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE.`);
          process.exit(1);
        }
        conn.reducers.claimCredential({ code: BOT_NONCE }).catch(logFailure("claiming the credential"));
        setTimeout(() => {
          myBotId = resolveMyBotId(conn);
          if (myBotId === null) {
            console.error(`[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`);
            process.exit(1);
          }
          bootstrap(conn);
        }, 1000);
        return;
      }
      log(`acting as bot '${conn.db.bot.id.find(myBotId)?.name ?? "?"}' (id ${myBotId})`);
      bootstrap(conn);
    })
    .subscribeToAllTables();

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") handleAuction(conn, a);
  });

  // A letter won at a close lands in the same transaction that opens the next
  // auction, so handleAuction already sees it. This catches anything else
  // (restarts, out-of-order delivery) — mostly matters on the final auction.
  let pending = false;
  const onRack = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      for (const id of myRunningMatches(conn)) {
        const m = conn.db.matchState.id.find(id);
        if (m && m.bagTotal === 0) playNow(conn, id);
      }
    });
  };
  conn.db.myRack.onInsert(onRack);
  conn.db.myRack.onUpdate(onRack);

  conn.db.botCredential.onInsert(() => { if (myBotId === null) myBotId = resolveMyBotId(conn); });

  conn.db.auctionResult.onInsert((_ctx, r) => {
    const key = String(r.matchId);
    const list = paidByMatch.get(key) ?? [];
    if (r.winnerBotId !== undefined && r.winnerBotId !== null && r.winnerBotId !== myBotId) {
      list.push({ letter: r.letter, paid: Number(r.paid) });
    }
    paidByMatch.set(key, list);
  });

  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const mine = participants(conn, neu.id);
      const me = mine.find((p) => p.botId === myBotId);
      if (!me) return;
      const place = mine.filter((p) => p.score > me.score).length + 1;
      console.log(`[${BOT_NAME}] match ${neu.id} ended: score ${me.score}, place ${place}/${mine.length}`);
      inflight.delete(String(neu.id));
      paidByMatch.delete(String(neu.id));
      joinLobby(conn);
    }
  });
}

function main() {
  log(`connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => console.error("connect error:", err.message))
    .onDisconnect(() => {
      console.log("disconnected — exiting so a supervisor can restart");
      process.exit(2);
    })
    .build();
}

main();
