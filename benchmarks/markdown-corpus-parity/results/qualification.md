# ANX versus strong Markdown corpus qualification (markdown-corpus-parity-v1)

Status: **PASS** (10/10 gates)

Generated: 2026-10-15T16:03:11.443Z

## Result

| Arm | Discovery document recall@12 | Discovery evidence recall@12 | Cross-document recall@12 | Cross-document evidence recall@12 | Relationship recall@12 | Citation resolution | Median query ms | Mean payload characters |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| anx-native-corpus | 100.0% | 69.8% | 100.0% | 44.4% | 50.0% | 100.0% | 27.194 | 12039 |
| markdown-strong-corpus | 100.0% | 67.7% | 100.0% | 44.4% | 50.0% | 100.0% | 30.655 | 11363 |

This stage qualifies the comparison machinery; it does not declare a winner. Both arms use the same canonical text and lexical ranker. The Markdown arm includes metadata, declared relationships, and resolvable file/line citations, making it a strong baseline rather than a strawman.

## Scale probe

- anx-native-corpus: 240 logical documents, 79520 evidence units, 30 queries, median 27.353 ms, p95 30.114 ms.
- markdown-strong-corpus: 240 logical documents, 80420 evidence units, 30 queries, median 31.074 ms, p95 33.816 ms.

Archived copies test current-release filtering and scan cost only; they do not add content diversity.

## Gates

- PASS — real-corpus-loaded: Both arms contain all 12 public documents.
- PASS — discovery-contract-complete: 24/24 frozen discovery tasks loaded.
- PASS — cross-document-contract-complete: 6/6 cross-document tasks loaded.
- PASS — source-packages-byte-identical: Every source ANX package hash is unchanged after both indexes and all searches.
- PASS — citations-resolve-anx: All returned ANX citations resolve to indexed evidence.
- PASS — citations-resolve-markdown: All returned Markdown file/line citations resolve to indexed evidence.
- PASS — typed-relationship-traversal: 4 declared relationships traverse outbound from the source and inbound to the target in both arms.
- PASS — deterministic-search-replay: Repeated searches produce byte-identical ranked evidence after timing fields are removed.
- PASS — scaled-probe-complete: Both arms completed 30 queries over 240 logical document records.
- PASS — no-superiority-assumption: Qualification gates transport integrity; comparative performance remains an observed result.

## Claim boundary

PASS qualifies a deterministic 12-real-document corpus transport and a 240-logical-document scale probe. It does not prove ANX superiority, semantic or vector retrieval quality, enterprise production latency, or access-control behavior. Live model answer quality is a separate stage.
