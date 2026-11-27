# makefun-png-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/kangrisuk-id/makefun-png-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/kangrisuk-id/makefun-png-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG encoder that rewrites 1280x720 RGBA screenshots as small as it can: per-image colour-type reduction (palette, grey, grey+alpha, RGB, RGBA, with tRNS), per-row filter selection over all five PNG filters plus the min-sum heuristic, and zlib level 9 with the better of two strategies, keeping the smallest encoding. Pure Node builtins, deterministic, about 18 seconds for a set of 8 on one CPU. Practice set: 700,920 of 1,000,000 (house baseline fixed-paeth: 420,399).

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6xwwxtxr&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
