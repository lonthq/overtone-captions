# Prices used for the cost figures

Pay-as-you-go list prices in USD, retrieved on **2026-10-17**, without discounts, commitments or taxes.
Machine-readable copy: [prices.json](prices.json).

| Item | Price | Meter (Azure Retail Prices API) | Unit used by the benchmark |
|---|---:|---|---|
| gpt-transcribe (Azure OpenAI, Global) | $0.27 per audio hour | `Azure OpenAI Media` / `gpt-transcribe Gl Unit`, effective 2026-08-01 | $0.0045 per audio minute |
| Azure AI Speech fast transcription (standard) | $0.36 per audio hour | `Azure Speech` / `Fast Transcription Speech To Text`, effective 2024-11-01 | $0.006 per audio minute |
| ElevenLabs Scribe v2 (`scribe_v2`, batch) | $0.22 per audio hour, keyterms +$0.05 per audio hour | none (ElevenLabs API pricing page) | $0.0037 per audio minute (list); see the header rate below |
| gpt-6.1-sol input (Global Standard, short context) | $2.00 per 1M tokens | `Azure OpenAI GPT6` / `6.1-sol ShortCo Inp Std Gl` | per token, from the API's `usage` |
| gpt-6.1-sol cached input | $0.10 per 1M tokens | `6.1-sol ShortCo Cd Inp Std Gl` | per token |
| gpt-6.1-sol cache write | $2.50 per 1M tokens | `6.1-sol ShortCo Cd Wr Std Gl` | per token (`prompt_tokens_details.cache_write_tokens`) |
| gpt-6.1-sol output (includes reasoning tokens) | $10.00 per 1M tokens | `6.1-sol ShortCo Opt Std Gl` | per token |

## Sources

- **Azure Retail Prices API** (public, no sign-in), the source of record. Same prices in `eastus` and `westeurope`:
  - `https://prices.azure.com/api/retail/prices?$filter=armRegionName eq 'westeurope' and contains(meterName,'gpt-transcribe')`
  - `https://prices.azure.com/api/retail/prices?$filter=armRegionName eq 'westeurope' and contains(meterName,'Fast Transcription')`
  - `https://prices.azure.com/api/retail/prices?$filter=armRegionName eq 'westeurope' and contains(meterName,'6.1-sol ShortCo')`
- **Azure pricing pages** (they load prices with JavaScript, so the API wins):
  <https://azure.microsoft.com/en-us/pricing/details/azure-openai/>,
  <https://azure.microsoft.com/en-us/pricing/details/speech/>
- **Cross-check:** OpenAI lists gpt-transcribe at $0.0045 per minute,
  <https://developers.openai.com/api/docs/models/gpt-transcribe>.
- **ElevenLabs:** <https://elevenlabs.io/pricing/api> (Scribe v2 $0.22 per hour, keyterm prompting $0.05 per hour,
  pay-as-you-go). The API also reports each request's cost in the `fiat-cost-before-overages` response header. On
  2026-10-17 it said about $0.35 per audio hour (about $0.0058 per audio minute) without keyterms (with or without
  diarization) and $0.42–0.44 with a short glossary as keyterms, above the list price. Use
  the header (your plan's rate) to compare costs. [RESULTS.md](RESULTS.md) says which rate each figure uses; the
  caption benchmark ([captions/RESULTS.md](captions/RESULTS.md)) uses the list price.

## How the cost is computed

- **Audio:** duration × per-minute price. gpt-transcribe reports `usage: {type: "duration"}` in seconds, so it bills
  by audio time; Azure Speech fast transcription bills per audio hour. A chunk Overtone retries is billed again;
  `score.mjs` counts each clip's audio once, so retries are added by hand.
- **LLM:** real token counts, not estimates. [lib/meter.mjs](lib/meter.mjs) is preloaded into the CLI with
  `node --import` and records the `usage` object of every chat completion (never headers, keys or bodies).
  - Prompt tokens split into cache writes ($2.50/M), cached reads ($0.10/M) and the rest ($2.00/M).
  - Completion tokens, including hidden reasoning tokens, at $10.00/M.
  - The meter also records each request's and response's characters, for a ÷4 token estimate when a provider
    returns no `usage`. Every completed request returned `usage`, so the estimate was not used. Requests that
    failed with a network error and were retried are not counted.
- **[Cost breakdown](RESULTS.md#cost-breakdown-2026-10-19)** (2026-10-19, both setups): the same prices, the seconds
  gpt-transcribe reported as billed (rounded up to whole seconds per request, so a 5.5-second snippet bills 6), the
  duration Azure Speech reported, the length of the WAV sent to ElevenLabs (Scribe at $0.22 plus keyterms at $0.05
  per audio hour, as every request carried the glossary), and the token usage of every LLM request.
- **Not included:** storage, network egress, support plans.
  - Azure **Data Zone** deployments cost about 10–20% more than Global (for example gpt-transcribe Data Zone is
    $0.297/h, gpt-6.1-sol Data Zone input $2.40/M and output $12.00/M in West Europe).
  - Azure Speech fast transcription has a **promo** meter at $0.10 per audio hour, effective 2026-09-01
    (`promoUsdPerAudioHour` in prices.json). Where it applies, the Azure part of the cost is 72% lower. The tables
    use the standard $0.36.
