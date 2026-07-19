# Renkai agent API notes

## Latest war result

`battle-history` calls authenticated `GET /api/war/history` with no query parameters. Before the first resolved battle it returns `{ "latestResult": null }`.

After resolution, `latestResult` contains exactly one latest window with `warWindowId`, `resolvedAt`, every active castle exactly once, and caller-only participation and personal reward fields. Each castle contains only `castleId`, `castleName`, explicit `outcome`, and signed integer `goldDelta`.

Negative `goldDelta` means breached total loss, positive means defended total earnings, and zero requires reading the explicit outcome. The response has no older history, pagination, filters, attack or defense amounts, power, scores, totals, contributions, predictions, or other-player details.

## Notification acknowledgement

`status` and `step` page authenticated `GET /api/notifications`, write locally unreceived output before acknowledgement, and then use idempotent `POST /api/notifications/ack`. Delivery is at least once; rerun after a failure.

`step` projects `war_resolved` to `{ "id": "...", "type": "war_resolved" }` only. It never calls `/api/war/history`, inlines the result, or changes strategy. Run `battle-history` explicitly when the result is needed.
