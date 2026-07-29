# What the first live ingests taught us

Six live runs against real adverts, 2026-07-28, on `claude-sonnet-5` at `effort: high` with the shipped bounds (3 searches, 8 fetches, 5000 content tokens per fetch). Prices are Sonnet 5 introductory rates – $2/MTok input, $10/MTok output, $10 per 1000 searches – which expire 2026-08-31, after which every figure below rises by half.

Until these runs, everything about cost and latency in this repo was an estimate written before the pipeline had ever met the API. All of it was wrong, and wrong in the same direction.

## The runs

| # | Source                       | Time   | Input tok | Output tok | Cost   | Outcome |
| - | ---------------------------- | -----: | --------: | ---------: | -----: | ------- |
| 1 | UCD, explainable AI          |  ~240s |         – |          – |      – | Record, validated |
| 2 | jobbnorge 305607             |  >30m  |         – |          – |      – | Timed out, billed 3× |
| 3 | jobbnorge 305607             |  3758s |         – |          – |      – | Connection terminated after 62 min |
| 4 | jobbnorge 305607             |   436s |   325,314 |     14,820 |      – | Completed, first attempt |
| 5 | Google Form (Saarland)       |   135s |   134,994 |     11,604 | $0.416 | Record, validated, 13/16 found |
| 6 | KU Leuven job page           |  1101s |   461,438 |     15,089 | $1.104 | **"Could not read anything"** |
| 7 | LinkedIn post (UKP)          |   305s |   804,811 |     20,425 | $1.844 | Record, validated, 14/16 found |
| 8 | TU Darmstadt research intern |     0s |         0 |          0 | $0.000 | **Out of API credit** |

Runs 1–4 predate the instrumented harness, so their token splits weren't captured. Runs 5–8 are exact.

## 1. Cost is 4–17× what the docs claim, and the "cap" is not a cap

`docs/setup.md` says ingest costs "roughly $0.11 per opportunity, bounded near $0.31 by the content cap." Measured: **$0.42 to $1.84 per ingest**, mean $1.68 per *successful* record once failures are counted. The four-URL batch cost $3.36 and produced two records.

The reasoning behind $0.31 was that `max_content_tokens: 5000` bounds each fetch, so 8 fetches bounds the input. That bounds the *fetched page content* and nothing else. What actually dominates is the server-side tool loop: each iteration re-sends the whole accumulated conversation, so input grows with the square of the number of iterations, not linearly with pages fetched. The LinkedIn run consumed 804,811 input tokens from 5 fetches – 160,000 tokens per fetch against a 5,000-token cap.

**Nothing in the current design bounds cost.** `max_content_tokens` bounds one axis of a two-axis problem.

## 2. Prompt caching is not happening at all

Every call across every run reported `cache_read_input_tokens: 0` and `cache_creation_input_tokens: 0`. Every input token was billed at the full 1× base rate; none at the 0.1× cache-read rate.

This is the single largest available saving and it is currently entirely unrealised. The request has a large stable prefix – the system prompt, the tool definitions, the output schema – which is exactly the shape prompt caching exists for, and the resume loop re-sends that prefix on every iteration. A `cache_control` breakpoint on the last system block would make every iteration after the first read its prefix at a tenth of the price.

Two caveats before assuming it is free money: the minimum cacheable prefix on Sonnet 5 is 1024 tokens (the prompt likely clears this, but it should be measured), and it is unverified whether the server-side tool loop's internal iterations can read a caller-set breakpoint at all. Measure `cache_read_input_tokens` after the change rather than assuming.

## 3. 804,811 tokens is uncomfortably close to a hard wall

The context window is 1M tokens. The LinkedIn run reached 80% of it in a single ingest. A slightly heavier page has nowhere to go: the request fails outright rather than degrading.

This reframes the timeout work from earlier today. Streaming removed the 10-minute client cliff, but the real constraint was never the clock – it is that a hard page drives the loop until it runs out of context. The 62-minute jobbnorge run and the 18-minute KU Leuven failure are the same phenomenon at different points on the curve.

## 4. The expensive failure is the worst outcome, and it is not rare

KU Leuven ran 18 minutes, consumed 461,438 input tokens, cost $1.10, and returned `could not read anything from that page`. The page is not hard to reach – plain `curl` gets HTTP 200 and 48 KB in 1.6 seconds. Whatever the model's `web_fetch` receives is not what curl receives.

`readEverything` correctly refuses to present an empty record as a finished opportunity, which is the right call. But it makes that call *after* the money is spent. Half of this batch failed, and the failures cost as much as the successes.

## 5. What worked, worked well

Both successful records are genuinely good. The Google Form – a JS-heavy page with no server-rendered advert – produced 13 of 16 fields with evidence, correct institution, correct supervisor, and passed deterministic validation. The LinkedIn post produced 14 of 16, and notably resolved *through* the post to the underlying TU Darmstadt UKP position, extracting the institution, lab, funding, and eligibility from the destination rather than the social-media wrapper.

The extraction quality is not the problem. The economics around it are.

## 6. Both records have no deadline, so neither would ever remind

Both successes came back `deadline: not_applicable` → `deadline_at: null`. That is correct – both are rolling, open-ended calls – and the domain model handles it exactly as designed.

But it is worth stating plainly: an opportunity with no deadline is tracked, listed, and counted, and then silently never acts. For a system whose stated purpose is "reminds the user before a deadline falls due", a corpus with many rolling calls means the reminder path may fire far less often than expected. Worth watching once real records accumulate.

## 7. `retrieved_at` is fiction

Every evidence item in the UCD run was stamped `2026-07-18T04:33:00Z`. The fetch happened on 2026-07-28. The model is inventing the timestamp rather than reporting when its tool actually retrieved the page.

`retrieved_at` is part of the evidence contract and is meant to indicate how stale a claim is. Right now it is decorative and cannot be trusted for that purpose.

## 8. CLI ingests are invisible to the digest

`recordUsage` is wired into `src/app.cjs`, not into `tools/ingest-url.cjs`. Every run above is absent from `usage_event`; the table still reads zero. The weekly digest is the designed spend signal, and the entire shakedown is invisible to it.

Related: `usageOf` in `src/core/ingest-response.cjs` sums `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` into one number. Those bill at 1×, 0.1× and 1.25×. Any cost figure derived from the stored value cannot distinguish a $1.84 ingest from a $0.18 one, which is precisely the distinction that matters once caching is enabled.

## What follows

Ordered by value, not effort.

1. **Add prompt caching and measure `cache_read_input_tokens`.** Largest single saving available; the current figure is zero.
2. **Bound the whole ingest, not each fetch.** A token budget or wall-clock ceiling that aborts and reports, so no single advert can cost $1.84 or run 18 minutes. The `task_budget` parameter exists for exactly this and is supported on Sonnet 5.
3. **Fail cheap on unreadable pages.** Detect early that fetches are returning nothing and stop, rather than burning the full loop before `readEverything` refuses the result.
4. **Split the three token classes** in `usageOf`, `usage_event`, and `approximateSpend`, and log usage from the CLI path too.
5. **Correct the cost claim in `docs/setup.md`** before it informs a spend limit.
6. **Re-tune `effort` and `MAX_FETCHES` against measurements** rather than intuition, now that there is a baseline to compare against.

## The thing that stopped the run

Run 8 returned `credit balance is too low` in 0 seconds. Six live ingests exhausted the account's credit. That is itself a finding: at $0.42–$1.84 each, a modest balance covers very few adverts, and the Telegram round trip – still the largest untested part of the system – has not been exercised even once.
