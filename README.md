# token-radar-01-entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/asuquostephen/launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/asuquostephen/launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar — a token launch radar that prices protocols whose token does not exist yet. It reads the competition's sealed DefiLlama snapshot and ranks every pre-token protocol by an implied value derived only from the snapshot's own figures: each protocol's TVL is priced at the median market-cap/TVL multiple the market already pays live protocols in the same category, shaded by its 7-day TVL momentum and by how long it has run with no token. The board covers the whole house watchlist plus every screened pre-token protocol below the $50M floor; protocols whose token already trades are shown separately at the market's own prices, and the big pre-token names the screen turns away (exchange products, wrapped/staked products of trading assets, versioned pools) are listed with their reasons. Every row carries a seven-step farm plan with costs and times, and each protocol's page shows the model's full arithmetic and recomputes it in the page.


## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

The program is a Node 22 `main.ts` at the repository root, standard library only, no network. It writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory, deterministically: the same snapshot in, the same bytes out.

---

<sub>Entered on [make.fun](https://make.fun/?ref=w285dyjk&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
