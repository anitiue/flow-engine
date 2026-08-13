# Flow Engine

Flow Engine is a full-access Hanako plugin for explicit, serial workflow orders. It stores flow definitions, frozen order snapshots, append-only event logs, project bindings, signatures, gate results, completion records, and archive records under `plugin-data/flow-engine/`.

## Installation

Install the `flow-engine` directory from Hanako Settings > Plugins, or copy it into the configured plugins directory. Flow Engine provides a Pi extension, so full-access plugins must be enabled. Hanako `0.242.0` or newer is required.

On the first `flow_list` call, the packaged `flows/example.yaml` is copied into the plugin data flow library. It is a generic example and is not tied to a project.

## Quick Start

1. Call `flow_bind` with an absolute `project_path` and a `flow_id`.
2. Call `flow_start` with the bound `flow_id`, a safe `order_id`, a title, and the project path.
3. Continue normal work. While a running order is bound, the guard automatically injects its status, blocks unsafe subagent dispatches, and attaches the current-step requirements to allowed dispatches.

## Guidance for AI Agents

If you are an agent with access to `flow_*` tools, first call `flow_status` to learn whether the project is bound. If it is not bound, call `flow_bind`. If it is bound but has no order, call `flow_start`. Before dispatching a subagent, call `flow_check`.

## Tools

- `flow_list` — parameters: none; lists installed workflow definitions and step summaries.
- `flow_new` — parameters: `flow_id`, `version`, `name`, `questionnaire`; creates a definition after all nine questionnaire answers are supplied.
- `flow_start` — parameters: `flow_id`, `order_id`, `title`, `project_path`; starts an order and freezes its definition snapshot.
- `flow_check` — parameters: `order_id`, optional `agent_id`; checks the current order gate for an agent.
- `flow_sign` — parameters: `order_id`, `declaration`, `delivery_location`, `acceptance_results`, optional `agent_id`; records a current-step signature.
- `flow_correct` — parameters: `order_id`, `affected_step_id`, `correction`, optional `agent_id`; appends a correction record to an active order.
- `flow_escalate` — parameters: `order_id`, `reason`, optional `agent_id`; appends a blocker escalation to an active order.
- `flow_complete` — parameters: `order_id`, `acceptance_statement`, optional `agent_id`; marks a fully signed order as completed.
- `flow_archive` — parameters: `order_id`, optional `agent_id`; archives a completed order with its manifest and event history.
- `flow_pause` — parameters: `order_id`, `reason`, optional `agent_id`; pauses a running order and removes it from active dispatch safeguards.
- `flow_resume` — parameters: `order_id`, optional `agent_id`; resumes a paused order when its project has no other running order.
- `flow_close` — parameters: `order_id`, `reason`, optional `agent_id`; closes a running or paused order and moves it to the archive.
- `flow_bind` — parameters: `project_path`, `flow_id`; binds a project path to a flow definition.
- `flow_unbind` — parameters: `project_path`; removes a project-to-flow binding when it has no running order.
- `flow_status` — parameters: `project_path`; shows a project's bound flow and bound-order status.

`flow_new` requires all nine `questionnaire` fields: `purpose`, `steps`, `agents`, `deliverables`, `acceptance`, `correction_policy`, `completion_criteria`, `report`, and `retention_days`. The `steps`, `agents`, `deliverables`, and `acceptance` arrays must have matching lengths. Every step requires an id, name, agent, deliverable, and at least one acceptance item. `report` requires `to`, `content`, and `format`.

## Gate Codes

- `0` — allowed.
- `10` — blocked because a prerequisite step is unsigned.
- `11` — blocked because the agent is not responsible for the current step.
- `12` — blocked because the order is completed or archived.
- `13` — blocked because the order is missing or damaged.
- `14` — blocked because the current step is already signed.

## Pause, Resume, and Close (v2.1)

Only one running order per project participates in guard injection and dispatch blocking. Paused orders are retained with their reason, timestamp, and actor, but do not participate in active safeguards.

To temporarily prioritize another order, pause the current order with `flow_pause`, complete and archive the temporary order, then explicitly call `flow_resume` on the paused order. `flow_resume` rejects the request while another order for that project is running. Use `flow_close` to permanently close a running or paused order; a reason is required, the order is archived as `closed`, and it cannot be resumed.

The guard has three states: it injects the active order status for a running order; it emits a lightweight notice when only paused orders exist; and it prompts for order creation when no order exists. Paused orders do not trigger automatic injection or dispatch blocking.

## Data Retention

Order and flow ids accept only letters, numbers, `_`, and `-`; they are never used directly as path fragments. Project paths are normalized with Node's Windows-aware `path.resolve`. Events are appended to `events.jsonl` with an ISO timestamp and agent identity. `definition.yaml` uses JSON-format YAML, a safe YAML subset that does not deserialize arbitrary tags or objects.

Archived records are cleaned after 180 days using `archived_at`. Unreadable records are preserved. Order data, bindings, flow definitions, and archives are all stored below `plugin-data/flow-engine/`.

## Testing

The `tests/` directory contains standalone Node verification scripts. From the plugin root, run:

```powershell
Get-ChildItem -Recurse -Include *.js,*.mjs | ForEach-Object { node --check $_.FullName }
node tests/audit_test.mjs
node tests/repair_verify.mjs
node tests/pause_resume_verify.mjs
node tests/guard_mock_test.mjs
node tests/archfix_verify.mjs
```

`audit_test.mjs` exercises the full order lifecycle and reports 16 checks. The remaining scripts cover repaired invariants, pause/resume/close behavior, guard behavior, and archive binding repair. The guard extension should also be tested in a real Hanako session after installation, including the host's context and tool-call event fields, the context message return shape, the block return shape, and the subagent dispatch tool arguments.
