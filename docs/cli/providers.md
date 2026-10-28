# Provider details

How the CLI calls each provider, Azure setup, and local mode. Roles, environment variables and default models:
[CLI reference](reference.md#providers-and-environment-variables). Retries, timeouts and refusals, which apply to
every provider: [How the pipeline works](pipeline.md#retries-and-timeouts). Adding a provider:
[Add a provider](../contributing/providers.md).

## OpenAI and OpenAI-compatible servers

- `OPENAI_BASE_URL` points `openai` (text and llm) at another server that speaks the OpenAI API, such as LM Studio
  (`http://localhost:1234/v1`) or vLLM. `OPENAI_API_KEY` is still required (any value for a local server). For
  Ollama, use the `ollama` provider.
- `OPENAI_RESPONSE_FORMAT=json_object` is for servers that reject `response_format: { type: 'json_schema' }`: the
  CLI asks for `{ type: 'json_object' }` and puts the schema in the system prompt.
- Reasoning effort is sent as `reasoning_effort`, except to a custom `OPENAI_BASE_URL`. A model that rejects it
  (such as `gpt-4.1`) gets its requests without it, with one log line.

### OpenAI timing

`--timing openai` takes word times from `whisper-1` (`verbose_json` with word timestamps) and speakers from
`gpt-4o-transcribe-diarize` (phrase segments with a speaker), since gpt-transcribe and gpt-4o-transcribe return no
word times. Both requests run in parallel on the 16 kHz WAV. Each word gets the speaker of the segment it overlaps
most.

- The model part is `<words model>[+<diarize model>]`. `openai:words` is `whisper-1` alone: one request, every word
  `S1`, half the cost.
- `--text openai:whisper-1 --timing same` takes text and word times from one call, without speakers.
- whisper-1 gets the language and the glossary (as a `Glossary: …` prompt, cut to its 224-token limit). The diarize
  model takes no prompt.
- A WAV over 24 MB or 1400 s is cut at silences. To keep speaker ids across pieces, each piece after the first gets
  up to 4 known speakers from earlier pieces (those who spoke longest, with a turn of at least 2 s), each with a
  2–10 s reference clip. A fifth speaker, or one the model does not recognize, gets a new id.

## Azure OpenAI

With Azure OpenAI and Azure Speech you need no OpenAI or Anthropic account:

```bash
cp .env.example .env      # fill in the AZURE_OPENAI_* and AZURE_SPEECH_* lines
overtone transcribe video.mp4 \
  --text "azure-openai:<transcribe-deployment>" --llm "azure-openai:<chat-deployment>" \
  --context "What the video is about"
```

The deployment names are the ones you chose in Azure. Keep the quotes: the shell reads a bare `<` as a redirection.
The same selection in `overtone.config.json` (keys stay in `.env`):

```json
{
  "text": "azure-openai:<transcribe-deployment>",
  "llm": "azure-openai:<chat-deployment>",
  "context": "What the video is about"
}
```

- The chat deployment must support Chat Completions with strict `json_schema` structured outputs, or every LLM step
  fails.
- The transcription deployment should be a `gpt-transcribe` / `gpt-4o-transcribe` model.
- API paths: with `AZURE_OPENAI_API_VERSION` set, both roles use the classic deployments API
  (`<endpoint>/openai/deployments/<deployment>/…?api-version=…`). Unset, the llm role uses the v1 API
  (`<endpoint>/openai/v1/`) and transcription the classic path with `api-version=2025-04-01-preview`, because the v1
  path answers 404 DeploymentNotFound for transcription deployments.
- `AZURE_OPENAI_TRANSCRIBE_MODEL` names the model behind the text deployment (e.g. `gpt-transcribe`); the CLI never
  guesses it from the deployment name. It matters only with `AZURE_OPENAI_TRANSCRIBE_KEYWORDS`.
- `AZURE_OPENAI_TRANSCRIBE_KEYWORDS=1` with `AZURE_OPENAI_TRANSCRIBE_MODEL=gpt-transcribe` also sends `languages`
  and `keywords` (the glossary), which Azure's spec does not list. By default the glossary goes in the `prompt` and
  the language as `language`.
- `gpt-6.1-sol` on Azure rejects the effort `minimal`.

## Azure Speech

One Fast Transcription request per file with the WAV; diarization per file, up to 10 speakers. The glossary is sent
as a phrase list.

- `AZURE_SPEECH_ENDPOINT` replaces the default host `https://<region>.api.cognitive.microsoft.com`, e.g. with a
  custom domain.
- `AZURE_SPEECH_PROFANITY`: `none` (default, words as spoken), `masked` or `removed`. Azure's own default masks
  with asterisks, which leaves nothing to match in the alignment.

## Azure MAI-Transcribe

MAI-Transcribe-2 uses the same Fast Transcription endpoint as Azure Speech (`enhancedMode`): one request per file
with the 16 kHz WAV, word timestamps, diarization and the verbatim style (fillers and false starts as spoken).

- No free-text prompt: the context and style settings do not reach it. The glossary goes as a phrase list.
- A forced language goes as one `locales` code when MAI lists it (60 languages). Otherwise, and with several
  candidates, none is sent and the model detects it.
- MAI reports confidence 0 for every phrase; the CLI leaves it out.

### MAI-Transcribe-2 on Azure

Provider `azure-mai`: text, word times and speakers in one call. It runs on an Azure AI Foundry resource, with no
model to deploy. Azure credits may not cover it; check your credit terms first.

1. In the Azure portal, create a **Microsoft Foundry** resource
   ([create](https://portal.azure.com/#create/Microsoft.CognitiveServicesAIFoundry)) in a region that serves
   MAI-Transcribe: `centralindia`, `eastus`, `northeurope`, `southeastasia`, `westus` or `westus2` (Microsoft's
   [region list](https://learn.microsoft.com/azure/ai-services/speech-service/regions?tabs=llmspeech) as of
   2026-10-26). `swedencentral` also worked, though the list leaves it out. An Azure OpenAI resource whose endpoint
   ends in `.cognitiveservices.azure.com` is a Foundry resource and works too.
2. Under **Keys and Endpoint**, copy a key and the endpoint into `.env`:

   ```bash
   AZURE_MAI_KEY=<key>
   AZURE_MAI_ENDPOINT=https://<name>.cognitiveservices.azure.com
   ```

   Or set `AZURE_MAI_REGION=<region>` for the host `https://<region>.api.cognitive.microsoft.com`.
3. Run it:

   ```bash
   overtone transcribe video.mp4 --timing azure-mai                       # as the timing provider
   overtone transcribe video.mp4 --text azure-mai --timing same \
     --llm "azure-openai:<chat-deployment>"                               # Azure only: MAI plus your chat deployment
   ```

A region without MAI-Transcribe (such as a `westeurope` Speech resource) answers HTTP 400 "Enhanced mode with model
is currently not supported yet". Comparison with the other engines: [bench/RESULTS.md](../../bench/RESULTS.md).

## ElevenLabs Scribe

One request per file to `POST /v1/speech-to-text` (`scribe_v2`) with the 16 kHz WAV: diarization on (up to 32
speakers), word timestamps, audio events (laughter, applause) off. Scribe takes up to 10 hours, so speaker ids hold
for the whole file. The text and timing roles share one cached request.

- No free-text prompt: the context and style settings do not reach it.
- The glossary goes as `keyterms`: at most 1000 terms of up to 5 words and 49 characters, without `< > { } [ ] \`.
  Other terms are left out with a warning. Keyterms add a surcharge.
- The language goes as an ISO 639-3 code (`nl` → `nld`). A language Scribe does not list is left out with a
  warning; with several candidates none is sent. Scribe's codes are mapped back (`eng` → `en`).
- `ELEVENLABS_BASE_URL` selects another host, e.g. `https://api.eu.residency.elevenlabs.io` for EU data residency.

A timed-out Scribe request is never sent again: ElevenLabs finishes and bills a request even after the client stops
waiting. HTTP and network errors are retried like other providers'. When no answer has come after 0.2 s per audio
second (at least 60 s), the CLI keeps waiting and also polls the workspace's transcript list every 15 s for the
finished transcript (a new one with the same audio length), taking whichever comes first. It gives up after 1 s per
audio second, at least 10 minutes (`ELEVENLABS_TIMEOUT_SECONDS` sets another limit).

An implausible answer is requested once more with a warning (billed again). Implausible means a mean word
confidence (exp(logprob)) below 0.5 with at least 5 words, or words longer than 10 s covering more than 25% of the
audio. A second such answer fails the stage when Scribe is the text or timing provider. As the second hearing or for
a snippet, it counts as no words heard and the run goes on. Healthy answers in the benchmark had a mean confidence
of 0.958–0.999 and no word longer than 1.6 s
([`src/providers/elevenlabs.ts`](../../packages/cli/src/providers/elevenlabs.ts)).

## Anthropic

Reasoning effort is sent as `output_config.effort` (without a hint: `medium`). The shared prompt prefix gets a
`cache_control` mark. `ANTHROPIC_BASE_URL` points at another server for the Messages API, such as a gateway.

## whisper.cpp

```
whisper-cli -m <model> -f <audio.wav> -l <language|auto> -oj -ojf -np [--prompt …] [-tdrz]
```

Runs on the whole 16 kHz WAV (no chunking) and writes to a temporary file. Words and times come from the token
timestamps of `--output-json-full`. The prompt is the end of the usual text prompt (context, glossary, style), cut
to 600 characters, since whisper keeps at most 224 tokens.

| Variable | Meaning |
|---|---|
| `WHISPER_CPP_BIN` | The `whisper-cli` binary (default: `whisper-cli` on `PATH`) |
| `WHISPER_CPP_MODEL` | A folder with `ggml-<model>.bin` files (default `~/.cache/whisper.cpp`), or one model file |
| `WHISPER_CPP_TDRZ` | Pass `-tdrz` (speaker turns) with a custom tdrz model file; automatic for `*tdrz*` model names |
| `WHISPER_CPP_THREADS` | CPU threads (`-t`, default 4) |
| `WHISPER_CPP_ARGS` | Extra arguments, space-separated, e.g. `-ng` (no GPU) or `--vad -vm <vad-model>` |

whisper.cpp does not diarize: every word is `S1`. A tdrz model marks speaker turns (English only) as alternating
`S1`/`S2`.

## Ollama

Native chat API (`POST http://localhost:11434/api/chat`), streamed, with the JSON schema as `format` (constrained
decoding). The native API lets the CLI set the context size per request. Ollama's own default of 4K tokens on
machines with under 24 GB of VRAM is already full with the editor's prompts for a 2-minute interview.

| Variable | Meaning |
|---|---|
| `OLLAMA_BASE_URL` | The server (default `http://localhost:11434`) |
| `OLLAMA_API_KEY` | Only for Ollama's cloud (`https://ollama.com`) |
| `OLLAMA_NUM_CTX` | Context window per call (default 16384). More needs more memory: `qwen3:8b` takes about 6.9 GB at 16K, 5.6 GB at 4K |
| `OLLAMA_MAX_TOKENS` | Longest answer per call (default 8192) |
| `OLLAMA_THINK` | `false`, `true`, `low`, `medium`, `high` or `default` (the model decides). Unset: off, except for steps with effort `high` |
| `OLLAMA_RESPONSE_FORMAT` | `json_schema` (default) or `json_object` (`format: "json"` plus the schema in the prompt) |

An answer that hits the context or token limit stops the run with a hint to raise it. The OpenAI-compatible route
also works (`--llm openai:qwen3:8b`, `OPENAI_BASE_URL=http://localhost:11434/v1`, any `OPENAI_API_KEY`), but then
the server's context size applies.

## Local mode

`--local` uses whisper.cpp for the words and their times in one call and Ollama for the editor:
`--text whisper-cpp:large-v3-turbo --timing same --llm ollama:qwen3:8b`. Install steps:
[CLI README](../../packages/cli/README.md#local-mode-free-and-offline).

- Explicit flags win: `--local --llm anthropic` keeps whisper.cpp with Claude as editor. With `--local --text openai`
  or `--text-file`, whisper.cpp times the text. A provider you name this way, or an `OLLAMA_BASE_URL` on another
  machine, receives the audio or transcript.
- `"local": true` in the config file sets the same providers for every role the file does not name. The file's
  `text`, `timing` or `llm` win over it; the `--local` flag wins over those.
- No automatic cloud second hearing: `--timing-second-opinion auto` becomes none. One named with the flag is used.
  With the `--local` flag, a cloud provider named only by the config file's `timingSecondOpinion` is turned off with
  a warning; with `"local": true` in the same file, it is used.
- English runs download the [CMU Pronouncing Dictionary](languages.md#cmu-pronouncing-dictionary) once.
- A missing binary, model or Ollama model stops the run before any work, with the command that fixes it.
- A small local editor proposes many wrong edits, and a run with one prints a warning ([The editor](pipeline.md#the-editor)).

Other whisper.cpp models go in the same folder as `ggml-<name>.bin` and are selected by name:

| Model | Notes |
|---|---|
| `whisper-cpp:large-v3-turbo` | Default, 1.5 GiB |
| `whisper-cpp:base` | 142 MiB: fast, less accurate |
| `whisper-cpp:small` | 466 MiB |
| `whisper-cpp:base.en` | English only, more accurate for English |
| `whisper-cpp:small.en-tdrz` | 465 MiB, English, speaker turns. From `https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin` |

Measured on an Apple-silicon Mac (2026-10-17):

| | 18 s sample clip | 2.4-minute NASA interview |
|---|---|---|
| whisper `large-v3-turbo` | 15–21 s | 16 s |
| `qwen3:8b`, four editing passes, thinking off | 36–101 s | 16 minutes (Ollama's 4K default context) |
| `qwen3:8b`, thinking on | 473 s | – |

- Words: `large-v3-turbo` heard the sample correctly ("in the app", the price, and "DriveCover" with the glossary).
  `base` heard "in the air" and wrote "drive cover".
- Editor: with thinking off, `qwen3:8b` proposed many wrong edits, and styling marked articles as numbers. With
  thinking on, it proposed no edits on the sample.
