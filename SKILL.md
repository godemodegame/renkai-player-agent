---
name: renkai-player
description: Onboard and operate a Hermes, OpenClaw, or other shell-capable AI agent as a Renkai player. Use when the user wants to create a local Solana-compatible agent wallet, handle waitlist access, apply a pasted referral link, register an agent API key, choose progression, resources, and a mandatory editable battle policy, install battle automation, inspect readiness, or safely take the next game action.
---

# Renkai Player

Use the bundled CLI for keys, signatures, and API calls. Do not recreate its cryptography in prompts or shell snippets.

## Onboard

1. Run `node {baseDir}/scripts/renkai.mjs doctor` to inspect the live API.
2. If the user has not chosen, ask for only these four decisions:
   - direction: `attacker`, `defender`, `blacksmith`, or `miner`;
   - resource focus: one or more resource names, or `common`, `castle`, or `rare`.
   - battle policy: always `defend`, `attack-fixed` with a foreign castle, or `attack-cycle`.
   - whose referral: ask the user to paste an `https://app.renkai.xyz` referral link containing `?ref=player_...`; reject every other domain and use `none` only when they explicitly have no referrer.
3. Explain that branch and class choices are permanent. The recorded direction automatically maps to the required branch at level 5 and class at level 15.
4. Run:

```bash
node {baseDir}/scripts/renkai.mjs setup --direction <direction> --resources <comma-separated-focus> --battle-mode <defend|attack-fixed|attack-cycle> [--battle-target <castle>] --referral <https://app.renkai.xyz/...?...ref=player_...|none>
```

5. If registration reports `WAITLIST_REQUIRED`, show only the printed public agent wallet and tell the user: Renkai requires waitlist access to play. They can request access through [Discord](https://discord.gg/fGVDhhk9t) or [X](https://x.com/renkaigame). After approval, rerun `register`. Never show the config file, private key, or agent API key.
   The CLI extracts `?ref=<player-id>` from the pasted link and sends it only on first account creation. Referral attribution cannot be changed after registration.
6. If registration reports `FEATURE_DISABLED`, stop and ask a Renkai operator to enable `agent_api_enabled`. The locally created wallet remains reusable.
7. If the API reports 404 or lacks the Agent API, stop. State that the current Renkai Worker must be deployed before registration can complete. The locally created wallet remains reusable.
8. Ask whether the runtime is Hermes or OpenClaw and where failure alerts must go. Install the mandatory minute scheduler:

```bash
node {baseDir}/scripts/renkai.mjs automation install --runtime <hermes|openclaw> --notify-channel <origin|channel> [--notify-to <recipient>]
```

9. Run `doctor`. Onboarding is incomplete while it reports `battle_setup_required`. The guarantee requires the selected runtime Gateway/scheduler to remain running.

## Play

Run one bounded decision at a time:

```bash
node {baseDir}/scripts/renkai.mjs step
```

Use the returned `action` and `retryAt`; do not busy-loop. `step` checks the next war before progression or quests. During the 20-minute reserve it installs/updates the pledge and waits until `nextWarAt`. Otherwise it may select the pre-approved branch/class or start one quest.

The user may change the strategy, but may not disable participation:

```bash
node {baseDir}/scripts/renkai.mjs battle-policy show
node {baseDir}/scripts/renkai.mjs battle-policy set --mode defend
node {baseDir}/scripts/renkai.mjs battle-policy set --mode attack-fixed --target <foreign-castle>
node {baseDir}/scripts/renkai.mjs battle-policy set --mode attack-cycle
```

Inspect or repair the scheduler without creating duplicates:

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
- Do not remove or pause `renkai-mandatory-battles`. Policy changes before pledge lock apply to the current window; later changes apply to the next one.
- Treat `WAR_PARTICIPATION_RESERVED` as an intentional wait until its `retryAt`, not as a reason to bypass the API guard.
