# Configuration and commands

[Back to the README](../README.md)

## Files and data

Everything piroboros stores lives under `PIROBOROS_HOME` (default `~/.piroboros`): the chat database, `auth.json`, `settings.json`, `models.json`, the memory stores, the optional vault clone, your `skills` folder and `skills-trust.json`. Copy `settings.json.example` and `models.json.example` from this repository as a starting point; the examples use placeholder hosts.

`PIROBOROS_HOME/instructions.md` is an optional file of your own standing instructions. It is read again for every request, so an edit applies at the next turn and `/reload` is not needed. The text goes to the main model as an `instructions` section and is also appended to the compactor's system prompt, so the compactor follows it too. A line meant only for replies should say so, for example "Do not apply this to compaction lines."

## Custom providers (`models.json`)

`models.json` adds providers that speak one of three wire formats: `openai-completions`, `openai-responses` or `anthropic-messages`. Each model needs `id`, `api`, `baseUrl`, `contextWindow` and `maxTokens`. See `models.json.example`.

- OpenAI formats take a base URL that ends in `/v1`. The Anthropic format takes the host root, because the client adds `/v1/messages` itself; a base URL ending in `/v1` is rejected.
- A provider id must not contain `/`, and must not be the id of a built-in provider.
- A model needs `contextWindow` minus `maxTokens` of at least 24,000 to load. The main model needs `contextWindow` minus `maxTokens` minus 2,000 to be at least 72,000, otherwise it is listed as disabled in the main-model picker.
- The API key comes from the variable `<ID>_API_KEY`: the id is upper-cased and every character outside A-Z and 0-9 becomes an underscore, so `my-llm.v2` reads `MY_LLM_V2_API_KEY`. A key stored through setup or `/login` takes precedence over the variable.
- A UTF-8 BOM at the start of the file is accepted.
- Two optional keys control reasoning. `thinkingLevelMap` maps piroboros thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to the value the provider accepts, or to `null` for a level the model does not support; it needs `"reasoning": true`. `compat` is passed to pi-ai unchanged and covers provider differences such as `supportsReasoningEffort` or `thinkingFormat`. Some models reason by default even when no level is sent, so mapping `off` to the provider's lowest value is how you cap them. For example, a model that accepts only `low` and `high`:

  ```json
  "reasoning": true,
  "compat": { "supportsReasoningEffort": true },
  "thinkingLevelMap": { "off": "low", "minimal": "low", "low": "low", "medium": "low", "high": "high", "xhigh": "high", "max": "high" }
  ```
- An invalid file does not stop startup. piroboros starts without custom providers and shows the error, which names the field. `/reload` re-reads `models.json` and `settings.json` and keeps the previous configuration if either is invalid.

## Command line

- `npm start` opens the chat. If no main model is set it runs setup first. To type `piroboros` in any terminal instead, run `npm link` once in this folder; `npm unlink -g piroboros` removes it. While the chat is open the window title reads `piroboros - <folder>`, the folder it was started in.
- `npm run setup` runs the guided setup. It needs the same exclusive access as the chat, so it exits with code 3 while the chat is open. If a config file was edited outside piroboros, setup shows the change and asks whether to accept it before it starts, the same as starting the chat does; answering no exits with code 5.
- `--print <message>` sends one message and prints the answer. `--model provider/model` uses another model for that run only, with `--print` and for the interactive start; an unknown model exits 2 and does not open setup. Exit codes: 2 when no main model is set, 4 when login is required, 5 when the config files were changed outside piroboros.
- `--backup <file>` writes a copy of the chat database.

## Chat commands

`/model`, `/reload`, `/login`, `/settings`, `/status`, `/conclave`, `/akashic`, `/thinking-steps` and `/skills` are available in the chat, and so is one command for each skill you have installed (see [Skills](tools.md#skills)).

`/login` signs in from the chat. `/login` alone lists the providers, with `[ready]` on the ones that already resolve, and the two web search keys. `/login <provider>` goes straight to one, and `/login web-tinyfish` or `/login web-exa` stores a search key. A provider that offers both an OAuth and an API key method asks which one you want, and a provider that is already signed in asks before it signs in again. What you type is masked in a box that replaces the chat, the credential goes to `auth.json`, and error text is scrubbed before it is shown. The sign-in address is shown on screen and opened with the platform's default handler. Esc cancels, and closing piroboros during a sign-in stops its local callback server. The next turn uses the new credential without a restart.

`/settings` changes `settings.json` from the chat. `/settings` lists 24 keys and the 8 Conclave members with their current values (a default is marked as such), and the list filters as you type. `/settings conclave.members.vaelia` lists that member's four keys, and `/settings <key>`, for example `/settings web.maxFetches`, goes straight to a key; an unknown key gets a hint. The editor depends on the key: a choice for words and on/off, a number box that starts at the current value and refuses a value outside the allowed range, the setup model pick for model keys (it signs in when the provider needs it), and for lists such as `guard.deny` a menu of the entries, where picking an entry removes it and "Add an entry" adds one. Every key can be reset to its default, which removes it from the file. The editor says when a change applies: at the next turn, right away, at the next Conclave run or at the next start. `cacheRetention` applies at the next turn: `"short"` keeps the prompt cache for about 5 minutes, and `"long"` keeps it for an hour and costs more per cache write.

A change to a security-relevant key shows the old and the new value and asks before it is saved. Those keys are `main`, `compactor.model`, `compactor.allowThirdParty`, `conclave.defaultModel`, the model of each Conclave member, `shellEnvAllow`, `shellTimeoutMs`, `guard.deny` and the `web` keys. `/model` asks the same way when it changes the main model, and asks nothing when the model is already the main one. A compactor model on a host that is not loopback also asks whether third-party use is allowed, as setup does, and setting `web.search.provider` with no stored key offers to enter the key. Every write goes through the same checked path as `/thinking-steps global`: if `settings.json` was edited outside piroboros, the write is refused until `/reload`. When piroboros was started with `--model`, `/settings` says so and explains that a change to `main` applies when it starts without the flag.

`/reload` shows the changed security-relevant settings (hosts, `allowThirdParty`, `shellEnvAllow`, `guard.deny`, the `web` keys) and asks before it accepts files that were edited outside piroboros. `/status` shows the messages saved, the summary view size and the cache use of recent responses. The compactor asks its model for lines of at most 400 bytes; 512 bytes stays the hard limit, and a line still over it after five tries is cut at a clause boundary. A provider reply of HTTP 429 or 503 counts as busy: the compactor waits longer and does not count it as an error, up to 20 times per node, and `/status` shows the retries made while the provider was busy. Until a compactor is configured, long messages show as "not summarized yet" lines and each request carries a window of at most 128 KB of the view.
