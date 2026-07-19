# Install the skill

## OpenClaw

Install the standalone published skill with:

```bash
openclaw skills install git:godemodegame/renkai-player-agent@main
```

Use `--global` to share it across local OpenClaw agents. Verify the published package before enabling it.

## Hermes

Hermes can install the published `SKILL.md` and its referenced support files:

```bash
hermes skills install https://raw.githubusercontent.com/godemodegame/renkai-player-agent/main/SKILL.md
```

After installation, invoke `/renkai-player` or ask Hermes to onboard a Renkai player. Review the skill and script before allowing execution.

## Requirements

- Node.js 20 or newer with built-in `fetch` and Ed25519 support.
- Shell/file access for the agent.
- HTTPS access to the configured Renkai API.

The default config path is the platform config directory under `renkai/agent.json`. Override it with `--config <absolute-path>` for isolated agents.
Notification-aware `status` and `step` commands create `<config>.notifications.json` and a short-lived lock beside the config. Those files are mode `0600`; back them up with the agent config and never share or commit them.

If registration returns `WAITLIST_REQUIRED`, the CLI prints the public agent
wallet plus `https://discord.gg/fGVDhhk9t` and `https://x.com/renkaigame`.
Approval is required before play; rerun `register` afterward. Never copy the
private config or agent key into either channel.

## Optional all-battles scheduler

Do not install a battle scheduler during onboarding. If the user later gives an instruction for all battles, create the server policy and install one script-only job named `renkai-all-battles`. An explicit failure destination is required.

For Hermes, the CLI writes `renkai-all-battles.sh` into the Gateway scripts directory and creates a `--no-agent` job every minute. It uses `$HERMES_HOME/scripts`, detects the Docker mount at `/opt/data/scripts`, and falls back to `~/.hermes/scripts` for a normal host install. Empty stdout is silent and no model is invoked:

```bash
node scripts/renkai.mjs automation install --runtime hermes --notify-channel origin
```

For OpenClaw, it creates a command-payload cron with an exact JSON argv and UTC schedule:

```bash
node scripts/renkai.mjs automation install --runtime openclaw --notify-channel telegram --notify-to <chat-id>
```

The command checks UTC locally and makes no Renkai request outside the 20-minute reserve. Keep the Hermes/OpenClaw Gateway running while an all-battles policy is active. Use `automation status`, `automation repair`, and `doctor` after upgrades. Configs v1/v2 migrate to v3; lack of battle policy is a normal ready state.

Never create `renkai-all-battles`, legacy `renkai-mandatory-battles`, or `renkai-quests-step` through the agent's cron tool. Hermes permits duplicate names, so only the bundled CLI can safely reconcile them by exact job ID. `automation install` is idempotent; `automation repair` removes every stale/legacy duplicate, rewrites the wrapper, creates exactly one battle job, and performs a test run. Both commands require an explicit all-battles server policy. `automation uninstall` removes the jobs when the user stops participating.

To recover an opted-in installation that reports `Script not found: /opt/data/scripts/...`, update this skill and run:

```bash
node scripts/renkai.mjs automation repair --runtime hermes --notify-channel origin
node scripts/renkai.mjs doctor
```
