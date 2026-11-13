# Seed API

Everything the web UI does goes through this HTTP API, so any program can drive Seed the same way. There are two ways in:

- **OpenAI-compatible endpoint** (`/v1/chat/completions`): point any OpenAI client at Seed and talk to the agent as if it were a model.
- **REST + event stream** (`/api/...`): full control over conversations, approvals, settings and extensions.

The server listens on `http://127.0.0.1:7333` by default (`seed --port`, `--host`).

## Authentication

Every request needs the access token. It is printed when Seed starts and by `seed url`, and it is stored in `~/.seed/config.json` (`server.token`).

```
Authorization: Bearer <token>
```

The web UI signs in once with the token and then uses a session cookie that only works from the app's own pages (when the browser withholds the cookie, as it does for a page embedded in another site's frame, the UI sends the token itself instead). Requests that carry the bearer token may come from any origin (CORS is open for them). A missing or wrong token gives `401`.

Errors are JSON: `{ "error": { "message": "...", "kind": "..." } }` with a matching HTTP status.

## OpenAI-compatible endpoint

```bash
curl http://127.0.0.1:7333/v1/chat/completions \
  -H "Authorization: Bearer $SEED_TOKEN" -H "Content-Type: application/json" \
  -d '{"model": "seed", "stream": true, "messages": [{"role": "user", "content": "What does this project do?"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:7333/v1", api_key=SEED_TOKEN)
reply = client.chat.completions.create(model="seed", messages=[{"role": "user", "content": "List the TODOs in this repo"}])
print(reply.choices[0].message.content)
```

- `model`: `"seed"` uses the default model; `"<provider>/<model>"` picks one of the connected models. `GET /v1/models` lists them.
- The agent runs with all its tools on the machine where Seed runs. The completion is the agent's final answer; with `stream: true`, text arrives as `delta.content`, and thinking plus a line per tool call arrive as `delta.reasoning_content`.
- **Approvals.** An OpenAI client cannot answer approval prompts, so by default every action that would ask the user (commands, file changes, network) is refused and the agent can only read the workspace. To let it act, send the header `x-seed-approval: auto-edit` (file edits in the workspace) or `x-seed-approval: full` (everything).
- **State.** By default each request is independent: the conversation is rebuilt from the `messages` you send and is not saved. To continue a saved conversation, send `x-seed-conversation: <id>`; then only the last user message is used.
- Other headers: `x-seed-cwd: <dir>` (workspace for a new conversation), `x-seed-tools: reasoning | content | none` (where tool activity is shown; default `reasoning`). The same options can be sent in the body as `"harness": { "approval", "conversation_id", "cwd", "show_tools" }`.
- The response carries `x-seed-conversation` with the conversation id.

## Chat in one call

`POST /api/chat` creates a conversation when needed, sends the message and waits for the agent to finish.

```bash
curl http://127.0.0.1:7333/api/chat -H "Authorization: Bearer $SEED_TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "Run the tests and summarize the failures", "approval": "full"}'
```

Body:

| Field | Meaning |
| --- | --- |
| `message` (or `content`) | Text, or blocks: `[{ "type": "text", "text": "..." }, { "type": "image", "mediaType": "image/png", "data": "<base64>" }]` |
| `conversationId` | Continue this conversation instead of starting a new one |
| `cwd` | Workspace directory for a new conversation (default: where Seed was started) |
| `model` | `"<provider>/<model>"` for this run |
| `approval` | `ask`, `auto-edit` or `full` for this run |
| `interactive` | `false`: refuse actions that would need approval instead of waiting for an answer |
| `system` | Extra instructions for a new conversation |
| `stream` | `true`: respond with Server-Sent Events (below) instead of waiting |

Response: `{ conversationId, status, text, messages, error? }`. `status` is `completed`, `cancelled` or `error`; `text` is the agent's answer; `messages` are the messages this run added.

With `"stream": true` the response is an event stream: every event of the run as `data: {json}`, then a final `{ "type": "done", conversationId, status, text, messages }`. Closing the connection cancels the run.

In `ask` mode an interactive run waits at each `approval.requested` event until you answer it (see Approvals).

## Conversations

| Method and path | Purpose |
| --- | --- |
| `GET /api/conversations?limit=&offset=&q=` | List, newest first: `{ total, conversations: [{ id, title, createdAt, updatedAt, cwd, model, messageCount, running }] }` |
| `POST /api/conversations` | Create. Body: `{ cwd?, model?, approval?, title?, system? }` |
| `GET /api/conversations/:id` | The conversation with all messages, plus `run` (state of a run in progress, or `null`) and `seq` (see Events). Add `?full=1` for the system prompt and the tool set id. |
| `PATCH /api/conversations/:id` | Change `title`, `model`, `approval` (`null` = default) or `cwd` |
| `DELETE /api/conversations/:id` | Delete |
| `POST /api/conversations/:id/messages` | Send a message. Body as for `/api/chat` (`content` or `message`, `model`, `approval`, `interactive`). Returns `202 { runId }` at once; add `"wait": true` to wait for the result, or `"stream": true` for the event stream. `409` if a run is already in progress. |
| `POST /api/conversations/:id/cancel` | Stop the run |
| `POST /api/conversations/:id/approvals/:approvalId` | Answer an approval request. Body: `{ "decision": "allow" \| "allow_always" \| "deny" }` |
| `POST /api/conversations/:id/compact` | Summarize earlier messages now |

A message is `{ id, role, content: [blocks], createdAt, meta? }` with `role` `user`, `assistant` or `notice` (a note from the app to the user; never sent to the model). Blocks:

```json
{ "type": "text", "text": "..." }
{ "type": "thinking", "text": "..." }
{ "type": "tool_use", "id": "...", "name": "shell", "input": { "command": "ls" } }
{ "type": "tool_result", "tool_use_id": "...", "content": "...", "is_error": false }
{ "type": "image", "mediaType": "image/png", "data": "<base64>" }
```

### Approval modes

| Mode | Behaviour |
| --- | --- |
| `ask` (default) | Reading inside the workspace is free. Commands, file changes, network requests and app changes wait for approval. A few read-only commands (`ls`, `cat`, `git status`, ...) on workspace paths run without asking. |
| `auto-edit` | As `ask`, but file edits inside the workspace run without asking. |
| `full` | Nothing asks. |

Approval categories: `read` (outside the workspace), `write`, `write_outside`, `extension`, `exec`, `network`, `app`. `allow_always` grants the category for the rest of that conversation.

## Events

`GET /api/events` is a Server-Sent Events stream of everything that happens. Each `data:` line is one JSON event with a `type`, a growing `seq`, a timestamp `at`, and `conversationId` when it concerns a conversation. Add `?conversation=<id>` to receive only one conversation's events.

```bash
curl -N http://127.0.0.1:7333/api/events -H "Authorization: Bearer $SEED_TOKEN"
```

To show a conversation without gaps: open the stream, then `GET /api/conversations/:id`, then apply only events whose `seq` is greater than the `seq` in that response.

| Type | Fields | Meaning |
| --- | --- | --- |
| `hello` | `seq`, `version`, `generation` | First event on every connection |
| `run.started` | `runId` | The agent started working on a message |
| `message.added` | `message` | A user message, tool results or a notice was added |
| `message.started` | `model` | The model started a reply |
| `delta` | `kind` (`text` \| `thinking`), `text` | Streamed output |
| `tool_use.started`, `tool_use.progress` | `toolUseId`, `name`, `bytes` | The model is writing a tool call |
| `message.reset` | | Discard what was streamed for the reply in progress (a retry) |
| `message.completed` | `message`, `usage`, `contextTokens` | The assistant message is final |
| `approval.requested` | `approval: { id, toolUseId, name, category, title, detail, preview, input }` | Waiting for a decision |
| `approval.resolved` | `approvalId`, `toolUseId`, `decision` | |
| `tool.started` | `toolUseId`, `name`, `input` | A tool is running |
| `tool.output` | `toolUseId`, `text` | Live output of the tool |
| `tool.completed` | `toolUseId`, `name`, `result`, `ms` | |
| `run.retry`, `run.notice` | `attempt`, `message` | The model API failed and is being retried; other progress notes |
| `compaction.started`, `compaction.completed` | `compacted` | Earlier messages are being summarized |
| `run.completed` | `runId`, `status`, `error?` | `completed`, `cancelled` or `error` |
| `conversation.created`, `conversation.updated`, `conversation.deleted` | `conversation` | |
| `config.changed` | `config` | |
| `extensions.changed`, `extensions.error` | `generation` / `name`, `message` | |
| `ext.<extension>.<type>` | `data` | Sent by an extension |

## Settings, providers and models

| Method and path | Purpose |
| --- | --- |
| `GET /api/info` | Version, workspace, data folder, extensions folder, whether a model is connected |
| `GET /api/config` | Settings without secrets: `{ providers, model, approval, agent, extensions, server }` |
| `PATCH /api/config` | Merge a JSON patch into the settings; `null` deletes a key. Examples: `{ "model": "deepseek/deepseek-chat" }`, `{ "approval": "auto-edit" }`, `{ "agent": { "instructions": "Always answer in Chinese." } }` |
| `GET /api/providers/presets` | The provider presets of the connect card |
| `POST /api/providers/test` | Check an API without saving: `{ type, baseURL?, apiKey?, model? }` → `{ ok, models, suggested }` |
| `POST /api/providers` | Connect a model API: `{ id, type: "openai" \| "anthropic", baseURL?, apiKey?, model?, name?, setDefault? }`. The API is tested first. |
| `DELETE /api/providers/:id` | Remove a provider |
| `GET /api/models?provider=` | Models of the connected providers: `{ current, providers: [{ id, name, type, models: [{ id, ref, name }], error? }] }` |
| `GET /api/tools` | The agent's tools with their parameter schemas |
| `GET /api/resolve-dir?path=` | Resolve and check a directory |

A provider entry in the settings:

```json
{
  "type": "openai",
  "name": "DeepSeek",
  "baseURL": "https://api.deepseek.com",
  "apiKey": "sk-...",
  "params": { "max_tokens": 8192 },
  "contextWindow": 128000,
  "modelOptions": { "deepseek-reasoner": { "params": { "max_tokens": 32000 } } }
}
```

- `type: "openai"` is any API that speaks OpenAI's Chat Completions protocol. `params` is merged into every request body, so provider-specific switches (`temperature`, `reasoning_effort`, `thinking`, ...) go there. `reasoningEcho` (`auto`, `always`, `never`) controls whether earlier `reasoning_content` is sent back.
- `type: "anthropic"` is the Anthropic Messages API. `params` understands `effort` (`low` … `max`), `maxTokens` and `fallbacks` (`false` turns off the automatic fallback model for declined requests).
- `apiKey` may be `"$ENV_NAME"` to read the key from an environment variable. API keys are never returned by the API.
- `contextWindow` and `compactAt` (tokens) control when a long conversation is summarized.

## Extensions

| Method and path | Purpose |
| --- | --- |
| `GET /api/extensions` | `{ generation, dir, safeMode, extensions: [{ name, description, enabled, server, client, tools, routes, runtimeErrors }] }` |
| `POST /api/extensions/reload` | Reload all extensions |
| `PATCH /api/extensions/:name` | `{ "enabled": true \| false }` |
| `DELETE /api/extensions/:name` | Delete the extension's folder |
| `GET /api/extensions/:name/storage` | All stored values of an extension |
| `GET`, `PUT`, `DELETE /api/extensions/:name/storage/:key` | One value; `PUT` body `{ "value": ... }` |
| `ANY /ext/:name/...` | Routes that the extension itself added |

## Calling the API from inside Seed

The agent uses the same API through its `seed_api` tool (`{ "method": "GET", "path": "/api/config" }`). Requests made that way cannot change the approval mode or the server settings, cannot answer approval prompts, and cannot act on the conversation the agent is running in. A message the agent sends to another conversation runs with the agent's own approval mode and cannot ask the user.
