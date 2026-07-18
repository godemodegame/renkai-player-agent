---
name: renkai-player
description: Onboard and operate a Hermes, OpenClaw, or other shell-capable AI agent as a Renkai player. Use when the user wants to create a local Solana-compatible agent wallet, handle waitlist access, apply a pasted referral link, register an agent API key, choose progression and resources, optionally instruct the agent for the next or all battles, inspect state, or safely take the next game action.
---

# Renkai Player

Use the bundled CLI for keys, signatures, and API calls. Do not recreate its cryptography in prompts or shell snippets.

## Onboard

1. Run `node {baseDir}/scripts/renkai.mjs doctor` to inspect the live API.
2. If the user has not chosen, ask for only these three decisions:
   - direction: `attacker`, `defender`, `blacksmith`, or `miner`;
   - resource focus: one or more resource names, or `common`, `castle`, or `rare`.
   - whose referral: ask the user to paste an `https://app.renkai.xyz` referral link containing `?ref=player_...`; reject every other domain and use `none` only when they explicitly have no referrer.
3. Explain that branch and class choices are permanent. The recorded direction automatically maps to the required branch at level 5 and class at level 15.
4. Run:

```bash
node {baseDir}/scripts/renkai.mjs setup --direction <direction> --resources <comma-separated-focus> --referral <https://app.renkai.xyz/...?...ref=player_...|none>
```

5. If registration reports `WAITLIST_REQUIRED`, show only the printed public agent wallet and tell the user: Renkai requires waitlist access to play. They can request access through [Discord](https://discord.gg/fGVDhhk9t) or [X](https://x.com/renkaigame). After approval, rerun `register`. Never show the config file, private key, or agent API key.
   The CLI extracts `?ref=<player-id>` from the pasted link and sends it only on first account creation. Referral attribution cannot be changed after registration.
6. If registration reports `FEATURE_DISABLED`, stop and ask a Renkai operator to enable `agent_api_enabled`. The locally created wallet remains reusable.
7. If the API reports 404 or lacks the Agent API, stop. State that the current Renkai Worker must be deployed before registration can complete. The locally created wallet remains reusable.
8. Run `doctor`. Onboarding is complete when it reports `setupStatus: ready`. Battle participation is not part of onboarding and defaults to `not_participating`. Do not ask a battle question or install battle automation unless the user later requests participation. When upgrading an older installation with no active all-battles policy, remove legacy jobs with `automation uninstall --runtime <hermes|openclaw>`; do not ask for a battle choice.

## Play

Run one bounded decision at a time:

```bash
node {baseDir}/scripts/renkai.mjs step
```

Use the returned `action` and `retryAt`; do not busy-loop. Without a battle instruction, `step` proceeds with progression and quests normally.

When the user specifies only the next battle, create one pledge and no scheduler:

```bash
node {baseDir}/scripts/renkai.mjs battle-next show
node {baseDir}/scripts/renkai.mjs battle-next set --mode <defend|attack-fixed|attack-cycle> [--target <foreign-castle>]
node {baseDir}/scripts/renkai.mjs battle-next clear
```

When the user explicitly says to use the instruction in all battles, persist the policy, ask which runtime is active and where failures should be delivered, then install the minute scheduler:

```bash
node {baseDir}/scripts/renkai.mjs battle-policy set --mode <defend|attack-fixed|attack-cycle> [--target <foreign-castle>]
node {baseDir}/scripts/renkai.mjs automation install --runtime <hermes|openclaw> --notify-channel <origin|channel> [--notify-to <recipient>]
```

To stop all future participation, clear both the policy and scheduler. A pledge already past lock remains effective for that one battle:

```bash
node {baseDir}/scripts/renkai.mjs battle-policy clear
node {baseDir}/scripts/renkai.mjs automation uninstall --runtime <hermes|openclaw>
```

Inspect or repair an explicitly enabled all-battles scheduler:

```bash
node {baseDir}/scripts/renkai.mjs automation status
node {baseDir}/scripts/renkai.mjs automation repair --runtime <hermes|openclaw> --notify-channel <channel> [--notify-to <recipient>]
```

Use these read-only commands when explaining state:

```bash
node {baseDir}/scripts/renkai.mjs state
node {baseDir}/scripts/renkai.mjs quests
node {baseDir}/scripts/renkai.mjs profile
```

Read [game-rules.md](references/game-rules.md) when choosing or explaining a strategy. Read [installation.md](references/installation.md) only when installing this skill into Hermes or OpenClaw.

## Safety

- Keep the wallet and API key local. Never paste, log, commit, or transmit secrets anywhere except signed requests to the configured Renkai API origin.
- Do not overwrite an existing wallet. `setup` reuses it and only updates the strategy.
- Do not promise a specific resource drop. The chosen focus changes quest preference; rewards remain probabilistic and the starting castle is assigned by the game.
- Do not fund the agent wallet or request mainnet assets. Renkai currently reports devnet and gameplay state is off-chain.
- Do not start a second action while the player is locked or has an active quest.
- Never infer battle participation from class, direction, resources, or prior silence. No instruction means no participation.
- Distinguish “next battle” from “all battles”; never persist or automate a one-battle instruction.
- Do not create cron jobs during onboarding. `automation install|repair|uninstall` owns the optional all-battles scheduler and removes obsolete `renkai-quests-step` jobs.
- Treat `WAR_PARTICIPATION_RESERVED` as an intentional wait until its `retryAt`, not as a reason to bypass the API guard.
