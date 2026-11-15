# Architecture

[中文](ARCHITECTURE.md) · **English**

This document explains how the parts of Seed work together, and why a few key designs are the way they are.

## Overview

```
Browser (web/)  ──HTTP + SSE──────────┐
Other programs (REST / OpenAI-compatible) ─┤
                                      ▼
                                src/server/        HTTP, auth, REST API, event stream
                                      │
                                src/app.js         wiring: config, storage, tools, extensions, runs
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                  ▼
              src/agent/        src/extensions/     src/providers/
              agent loop        extension host      model API adapters
                    │
              src/tools/        built-in tools
```

One process, one port. The interface is just one client of the API: whatever the interface can do, another program can do through the same endpoints, and the AI itself goes through them too, with the `seed_api` tool.

## The path of one message

1. A client sends `POST /api/conversations/:id/messages`. The server writes the user message into the conversation, starts a **run**, and returns at once.
2. The loop in `src/agent/agent.js` sends the conversation to the model and broadcasts the increments (`delta`) on the event bus as they arrive.
3. When the model wants to call a tool, the arguments are first checked against the JSON Schema, then the call goes through the approval policy (`src/agent/permissions.js`). If the policy says to ask, the server broadcasts `approval.requested` and waits. Otherwise the tool runs, its result is appended as the next message, and the loop goes back to step 2.
4. When the model calls no more tools, the run ends and `run.completed` is broadcast.

Every event carries a globally increasing `seq`. A client first connects to the event stream, then fetches a snapshot of the conversation (which also has a `seq`), and applies only events with a larger one. This way a page reload or a client that joins midway neither loses nor repeats anything.

A conversation has one run at a time. Cancelling travels through an `AbortController` to the model request and to the command that is running (its whole process group is ended).

## One message format

Conversations are stored in a format that belongs to no provider (see `src/agent/messages.js`): messages have one of three roles, `user`, `assistant` or `notice`, and their content is a list of blocks (`text`, `thinking`, `tool_use`, `tool_result`, `image`). A `notice` is a hint from the app to the user and is never sent to the model.

Each adapter converts in both directions:

- `providers/openai.js`: the Chat Completions protocol. It handles the differences between providers, such as tool-call chunks without an `index`, whether `reasoning_content` has to be sent back (it switches automatically on an error and remembers), and the different spellings of the usage fields.
- `providers/anthropic.js`: the official SDK. Besides the common format, an assistant message keeps the content array exactly as the API returned it (`meta.raw`), and sends it back unchanged the next time.

A conversation can change models midway: whichever provider a request goes to, the history is converted to that provider's format, and thinking produced by another provider is not sent.

## Why the system prompt and the tool list are frozen

When a conversation is created, its system prompt and tool definitions are fixed and stored with it. Every later request repeats them byte for byte, and history is only ever appended to, never rewritten. There are two reasons:

1. **Caching.** Every provider's prompt cache matches by prefix: change one byte of the prefix, and everything after it is invalid. A fixed prefix means most of the input of a long task is billed at the cached price.
2. **Claude's thinking blocks.** Newer Claude models check which conversation a thinking block belongs to: if the system prompt, the set of tools or an earlier message has been changed, the thinking blocks replayed after it are no longer valid. An append-only history meets this requirement by construction.

This raises a question: what if the AI gives itself a new tool in the middle of a conversation? The answer is `ext_call`, a forwarding tool that is in the tool list from the start and can call any tool registered later, by name. A new conversation simply includes the new tool as an ordinary one.

If the history does not match after all (for example an old conversation continued after an upgrade of the app), then on the official API Seed asks the API to drop the invalid thinking blocks instead of failing, removes them locally, and later requests are back to normal.

## Summarizing the context

After each model response, Seed records how many tokens the request used. Once that passes the budget (by default 75% of the context length, at most 200,000), it has the model write a summary before the next request. From then on, requests start from the summary plus the messages after it, and what came before the summary is no longer sent. The full record stays in the conversation file, and the interface shows it as before.

The summary request reuses the conversation's own system prompt, tools and history, so it hits the cache. If the conversation has grown so long that even the summary request does not fit, Seed summarizes a shortened plain-text transcript instead.

## Approval policy

`permissions.js` is a pure function: given the mode, a description of the tool call and the grants already made in this conversation, it answers "allow" or "ask". A tool declares what it is with `kind` (`read`, `write`, `exec`, `network`, `app`), and file tools also give the path. Paths are judged by their real location (symbolic links are resolved) and fall into three cases: inside the working folder, outside it, and the extensions folder.

The extensions folder is a category of its own because extension code runs with full access in the server process and in the page. If it counted as an ordinary file change, `auto-edit` mode would amount to allowing arbitrary code execution.

When the AI calls the API through `seed_api`, it carries the identity "from the agent": it cannot change the approval mode or the server settings, cannot answer approvals for the user, and cannot act on the conversation it is in. Conversations it starts inherit its own approval mode, and anything in them that would need asking is refused.

## Extensions

An extension is a folder under `~/.seed/extensions/<name>/`. It can have a `server.js` (runs in the server process) and a `client.js` (runs in the page); each exports an `activate` function.

- **Scope.** The object that `activate` receives (`ctx` on the server, `seed` in the page) belongs to that extension alone. Everything registered through it (tools, routes, hooks, interface mounts, commands, timers) is recorded under the extension's name and undone when it is reloaded or disabled. So a hot reload leaves no duplicates behind.
- **Fresh code.** Every reload increases a generation number. The server imports `server.js?g=<generation>`, and a module resolution hook passes that parameter on to the files it imports by relative path. The page loads from `/extensions/<generation>/<name>/`, so relative imports land on the new path by themselves. Neither side ever gets a cached old module.
- **Errors come back.** This is what makes "let the AI add features itself" work. When activation fails on the server, the error is recorded with file and line. Interface code first gets a syntax check on the server (a browser reports syntax errors without a position). Once a page has loaded, it reports the result of each extension, and errors thrown later are attributed to the right extension from their call stack. The `reload_extensions` tool collects all of this into one report for the model.
- **Isolation.** One failing extension does not affect the others; an error thrown in a hook is recorded and skipped. If the interface is broken, safe mode opens it without extensions.

## Security model

- By default the server listens on the loopback address only. Every endpoint needs the access token: programs send `Authorization: Bearer`, and the page uses the HttpOnly, SameSite=Strict session cookie it gets when signing in. A request with the cookie must also come from Seed's own page (checked with `Sec-Fetch-Site` or `Origin`), because cookies do not distinguish ports, and a web page on another port of the same machine must not be able to use it.
- Only token requests are granted CORS; cookie requests are not.
- When the page is embedded in a frame of another site (IDEs and cloud "preview" panes work this way), the browser neither stores nor sends the cookie. The page then keeps the token in the current tab and sends it in the `Authorization` header of every request. This is also why the event stream is read with `fetch` rather than `EventSource`.
- Extension interface files are loaded with `<script>` and `<link>`, which cannot carry request headers, so their address contains a key derived from the token (`/extensions/<generation>~<key>/…`). The page gets this address from a manifest endpoint that needs authentication.
- The config file has mode 600; the API never returns keys; the file tools refuse to read or write the config file.
- Model output, tool results and web content are all treated as untrusted data: the system prompt states that they are not instructions, and the interface renders with DOM nodes, not HTML strings.
- There is no OS-level sandbox, and the README says so.

## Data

```
~/.seed/
  config.json            settings, providers, the access token
  conversations/         one JSON file per conversation, plus a list index
  toolsets/              snapshots of tool definitions by content hash, shared by conversations
  extensions/            extensions
  extension-data/        key-value storage of each extension
```

The location can be changed with the `SEED_HOME` environment variable or `--home`.
