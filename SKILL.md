---
name: renkai-player
description: Securely onboard a Renkai player and expose signed, explicit gameplay primitives for user-owned orchestration.
---

# Renkai Player Primitives

This skill owns wallet creation, secure local configuration, referral validation, Agent API registration, signed requests, and bounded one-action gameplay commands. The user owns orchestration, timing, retries, scheduling, strategy, and stopping. This skill never starts a gameplay loop or installs a scheduler.

## Onboard

The only onboarding choice is the referral attribution. Use `none` only when there is no referrer:

```bash
node {baseDir}/scripts/renkai.mjs setup --referral <https://app.renkai.xyz/...?...ref=player_...|none>
node {baseDir}/scripts/renkai.mjs doctor
node {baseDir}/scripts/renkai.mjs profile
```

Setup creates or reuses a local Ed25519 wallet, keeps files mode `0600`, validates the exact referral origin, and registers the Agent API key. It never selects a direction, resource focus, goal, branch, class, quest, battle target, policy, or runtime job. Never print the config, private key, or API key.

Existing v1-v3 configurations retain their credentials and report `legacyMigrationRequired`. If a legacy Hermes/OpenClaw job may exist, explicitly run the migration-only cleanup after choosing the runtime:

```bash
node {baseDir}/scripts/renkai.mjs legacy-cleanup --runtime <hermes|openclaw>
```

This lists and removes only exact known legacy job names (`renkai-all-battles`, `renkai-mandatory-battles`, `renkai-quests-step`). It does not call the game API and is never run during setup.

## Explicit primitives

Read-only commands do not mutate gameplay:

```bash
node {baseDir}/scripts/renkai.mjs player state
node {baseDir}/scripts/renkai.mjs quests list
node {baseDir}/scripts/renkai.mjs war state
node {baseDir}/scripts/renkai.mjs inventory
node {baseDir}/scripts/renkai.mjs status
```

Every mutation below requires the caller to provide the complete decision. `--confirm` is an exact echo of the requested target for permanent, locking, or spend actions. Mutations use server idempotency and preserve machine-readable errors and timing fields; never busy-loop.

```bash
node {baseDir}/scripts/renkai.mjs player branch set --branch <fighter|laborer> --confirm <branch>
node {baseDir}/scripts/renkai.mjs player class set --class <attacker|defender|blacksmith|miner> --confirm <class>
node {baseDir}/scripts/renkai.mjs quest start --quest-id <questId> --confirm <questId>
node {baseDir}/scripts/renkai.mjs war pledge --role defend --confirm defend
node {baseDir}/scripts/renkai.mjs war pledge --role attack --target <foreign-castle> --confirm attack:<foreign-castle>
node {baseDir}/scripts/renkai.mjs war pledge-clear --confirm clear
node {baseDir}/scripts/renkai.mjs stats allocate --stat <stat> --points <N> --confirm <stat>:<N>
node {baseDir}/scripts/renkai.mjs crafting start --recipe <recipeId> --confirm <recipeId>
```

`--idempotency-key` is available when replaying the exact same mutation. The caller must choose the quest, branch, class, war role, and target; no fallback or persisted all-battles policy exists.

## User-owned orchestration example

```text
state = player state
quests = list quests
questId = user_owned_policy(state, quests)
start questId with the exact idempotency key and confirmation
wait until the returned lock/retry time
state = player state
```

The user supplies `user_owned_policy`, hosting, scheduling, retries, notifications, and cancellation. A custom loop must honor `retryAt`, `nextRecommendedPollAt`, player locks, stamina, rate limits, authorization, and idempotency. Do not install this pseudocode as a Renkai job.

## Safety

- Keep wallet and API key material local and redacted.
- Referral attribution is first-registration-only and immutable.
- Server authentication, authorization, feature flags, locks, rate limits, and atomic economy guards apply to every primitive.
- Branch and class choices are permanent; show the exact Gold cost before calling them.
- Never promise a resource reward or imply that a focus guarantees a named drop.
- Treat `PLAYER_LOCKED`, `WAR_PLEDGE_LOCKED`, `WAR_PARTICIPATION_RESERVED`, `RATE_LIMITED`, `FEATURE_DISABLED`, `WAITLIST_REQUIRED`, and deployment errors as actionable machine-readable results.
