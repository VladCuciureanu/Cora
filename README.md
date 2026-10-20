# Cora

A wearable-to-GitHub bridge that turns your contribution graph into a real-time electrocardiogram. Each heartbeat from your Apple Watch becomes a commit — a permanent, tamper-evident record of your alive-ness. The streak ends when you die.

## How It Works

1. **Apple Watch** sends heart rate data via an iOS Shortcut to Cora's local HTTP server
2. **Cora** buffers beats, detects events (spikes, drops, reconnects), and commits them to a GitHub repo
3. **Your contribution graph** lights up with your actual heartbeat

Commits look like:

```
♥ 72bpm @ 2026-03-22T14:30:00Z        # baseline (every 5 min)
⚡ 142bpm spike @ 2026-03-22T15:02:00Z  # event (immediate)
```

Each commit creates a `beats/{timestamp}.beat` file with BPM, R-R intervals, and metadata.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) 24+ (see `.nvmrc`) and `git` 2.31+ on your `PATH`
- A GitHub account and personal access token
- An Apple Watch + iPhone (for real data) or use `cora mock` for simulation

### Install

```sh
# Clone, build, and link the `cora` command globally
git clone https://github.com/VladCuciureanu/Cora.git
cd Cora
npm install
npm run build
npm link

# Or run straight from source without installing
npm start -- --help
```

### Initialize

```sh
cora init
```

Walks you through GitHub PAT, repo URL, and port configuration. Generates an API key and displays a QR code for the iOS Shortcut.

## Usage

```sh
cora start             # Start listening for heartbeats
cora stop              # Graceful shutdown, flush pending beats
cora status            # Check if running, current BPM
cora stats             # Lifetime stats: total commits, streak, avg BPM
cora replay            # Replay queued beats from offline periods
```

### Mock Mode

Simulate a realistic heart rate without a wearable:

```sh
cora mock              # Real-time simulation
cora mock 1440         # Fast-forward: 1 day per minute
cora mock --from 2025-01-01 --to 2025-06-01  # Backfill past dates
```

The simulator models circadian rhythm, sleep cycles, random activity bursts, post-lunch dips, and wake/wind-down transitions.

## Architecture

```
Apple Watch → iOS Shortcut → POST /beat → BeatBuffer → GitEngine → GitHub
                                              ↓
                                        OfflineQueue (on failure)
```

| Module    | Role                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| `server/` | HTTP server with API key auth (`POST /beat`, `GET /health`)                   |
| `beats/`  | Ring buffer, event detection (±20% BPM threshold)                             |
| `git/`    | Clone, commit with original timestamps, batched push, pull-rebase on conflict |
| `queue/`  | Persist undelivered beats to `queue.jsonl`, replay on reconnect               |
| `mock/`   | Circadian heart rate simulator                                                |
| `config/` | Config at `~/.config/cora/`                                                   |

## Development

```sh
npm run dev            # Watch mode (node --watch)
npm test               # Run tests (node:test)
npm run typecheck      # Type-check with tsc
npm run build          # Emit dist/ for the `cora` bin
```
