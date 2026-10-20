# Cora

Cora commits your heart rate to a GitHub repo, so your contribution graph becomes an electrocardiogram. The streak ends when you die.

A phone (for example an iOS Shortcut reading Apple Watch data) posts heart-rate samples to Cora's local HTTP server. Cora commits a baseline every five minutes and an extra commit for each spike, drop or reconnect, each backdated to the sample's own time:

```
♥ 72bpm @ 2026-03-22T14:30:00.000Z
⚡ 142bpm spike @ 2026-03-22T15:02:00.000Z
```

No watch? `cora mock` simulates a plausible heart, including sleep, a post-lunch dip and the occasional run.

## Requirements

- Node.js 26+ (see `.nvmrc`)
- git 2.31+ on your `PATH`
- A GitHub repo to hold the beats and a personal access token with `repo` scope

## Install

```sh
git clone https://github.com/VladCuciureanu/Cora.git
cd Cora
npm install
npm run build
npm link        # puts `cora` on your PATH

npm start -- --help   # or run from source without linking
```

## Usage

```sh
cora init     # prompt for PAT, repo URL and port; generate an API key; print a setup QR code
cora start    # clone the repo, replay queued beats, start the server
cora stop     # SIGTERM the running instance; it flushes and pushes before exiting
cora status   # whether it is running, its port, and the latest BPM
cora stats    # total commits, first/last beat, current daily streak, average BPM
cora replay   # commit beats queued while commits were failing
```

`cora --help` (`-h`) and `cora --version` (`-v`) do what you expect. Missing config or an unknown command exits with status 1.

### Mock heart

```sh
cora mock                                     # real time
cora mock 60                                  # one simulated hour per minute (same as --speed 60)
cora mock --from 2025-01-01 --to 2025-06-01   # backfill a date range via git fast-import
```

Live speed is capped at 100x (one 5 s sample every 50 ms of real time), whatever larger value you pass. `--to` only applies with `--from` and defaults to now. A backfill resumes after the newest beat already in the repo, and live mode first fills any gap since that beat. `--speed` has no effect on a backfill.

### Sending beats

```
POST http://<host>:<port>/beat
Authorization: Bearer <apiKey>
Content-Type: application/json

{"timestamp": "2026-03-22T14:30:00Z", "bpm": 72, "rr_intervals": [830]}
```

`timestamp` and `bpm` are required. Responses: `200 {"status":"ok"}`, `200 {"status":"duplicate"}` for a timestamp already seen, `400` for bad JSON or missing fields, `401` for a wrong key. `rr_intervals` is accepted but not stored.

`GET /health` needs no key and returns `{"status":"alive","bpm":<latest or null>}`. The server listens on all interfaces (`0.0.0.0`).

### What gets committed

| Commit   | File                             | Contents                                       |
| -------- | -------------------------------- | ---------------------------------------------- |
| Baseline | `beats/<timestamp>.beat`         | `avg_bpm`, `min_bpm`, `max_bpm`, `beat_count`  |
| Event    | `beats/<timestamp>.<kind>.beat`  | `bpm`, `kind` (`spike`, `drop`, `reconnect`)   |

Colons in the timestamp become `-` in filenames. A spike or drop is a reading at least `eventThresholdPercent` away from the average of the last 30 readings; a reconnect is a sample arriving more than 60 s after the previous one. Commits are pushed every 10 s, with a `pull --rebase` and retry if the push is rejected. Commits that fail go to `queue.jsonl` and are retried by `cora start` or `cora replay`.

### Files and config

Everything lives in `~/.config/cora/` (`$HOME`, else `%USERPROFILE%`): `config.json`, the clone in `repo/`, `queue.jsonl` and `cora.pid`. `cora init` writes `config.json` with owner-only permissions:

| Key                     | Default       | Meaning                                      |
| ----------------------- | ------------- | -------------------------------------------- |
| `githubPat`             |               | Token used for clone, pull and push          |
| `repoUrl`               |               | Repo to commit beats to                      |
| `apiKey`                | set by `init` | Bearer token for `POST /beat`                |
| `port`                  | `7331`        | HTTP server port                             |
| `commitIntervalMs`      | `300000`      | Time between baseline commits                |
| `eventThresholdPercent` | `20`          | Deviation (%) that counts as a spike or drop |

The token is sent as an HTTP header per git command and is never written to `.git/config`.

## Development

```sh
npm run dev         # node --watch src/main.ts
npm test            # node:test, test/**/*_test.ts
npm run typecheck   # tsc
npm run build       # tsc -p tsconfig.build.json -> dist/
```
