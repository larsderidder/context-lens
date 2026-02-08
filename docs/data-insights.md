# Context Lens — Data Insights from Real Sessions

## Context Composition at Scale

Analysis of real Claude Code sessions captured through Context Lens proxy.

### Small session (~34K tokens)
| Category | Tokens | % |
|----------|--------|---|
| Tool definitions | 14,556 | 43% |
| Tool results | 10,510 | 31% |
| System prompt | 4,256 | 13% |
| System injections | 918 | 3% |
| Thinking | 343 | 1% |
| Assistant text | 372 | 1% |
| User text | 304 | 1% |

### Medium session (~93K tokens)
| Category | Tokens | % |
|----------|--------|---|
| Tool results | 69,983 | 75% |
| Tool definitions | 14,556 | 16% |
| Thinking | 6,958 | 7% |
| System prompt | 4,265 | 5% |
| Assistant text | 2,034 | 2% |
| System injections | 943 | 1% |
| User text | 344 | <1% |

### Large session (~117K tokens)
| Category | Tokens | % |
|----------|--------|---|
| Tool results | 70,329 | 60% |
| Thinking | 29,431 | 25% |
| Tool definitions | 14,556 | 12% |
| System prompt | 4,265 | 4% |
| Tool calls (outbound) | 2,446 | 2% |
| Assistant text | 2,136 | 2% |
| System injections | 943 | <1% |
| User text | 35 | <1% |

## Key Findings

### 1. Tool results dominate context
Tool results (file contents, command output) grow to 60-75% of total context. This is the #1 consumer. Users have no visibility into this.

### 2. Thinking blocks scale dramatically
- At 34K: 1% (343 tokens)
- At 93K: 7% (6,958 tokens)
- At 117K: 25% (29,431 tokens)

Extended reasoning can consume a quarter of the context window. Users don't know this is happening.

### 3. Tool definitions are constant overhead
14,556 tokens loaded every single turn, regardless of which tools are actually used. In a small session this is 43% of context. Even in a large session it's 12%.

### 4. The actual conversation is <1%
User text never exceeds 1% of context. The "conversation" is between the model and its tools, not between the human and the model.

### 5. System prompt + injections are small but constant
~5,200 tokens combined (system prompt + system-reminder injections). Constant per turn.

### 6. Claude Code runs multiple agents per turn
- Main agent: Opus with full tool definitions (~14.5K tools overhead)
- Classifiers: Haiku with 1-119 token system prompts, near-zero tools
- Subagents are 75% of API calls but only 8% of tokens

### 7. No compaction observed until very late
Session reached 117K/200K (58%) without triggering compaction. Claude Code's threshold appears to be high.

## Growth Pattern

```
Turn   Total     Tool Results   Thinking   User Text
 1     19.8K         0 (0%)      0 (0%)     26 (<1%)
 2     24.0K     4,452 (19%)    122 (<1%)   13 (<1%)
 3     33.5K    14,602 (44%)    264 (1%)    13 (<1%)
 7     54.4K    36,837 (68%)    556 (1%)    26 (<1%)
 8     71.5K    55,494 (78%)    726 (1%)    26 (<1%)
 9     84.9K    69,996 (82%)    866 (1%)    26 (<1%)
10     92.9K    69,983 (75%)  6,958 (7%)   344 (<1%)
13    115.5K    70,118 (61%) 29,431 (25%)   35 (<1%)
18    117.1K    70,329 (60%) 29,431 (25%)   35 (<1%)
```

## Recommendation Patterns (for scoring/audits)

### High impact
- **Large tool result detection:** Single tool result >5% of context → suggest truncation or --stat flags
- **Unused tool definitions:** Tools loaded but never called → suggest disabling
- **Thinking block growth:** Thinking >15% of context → warn about reasoning cost

### Medium impact
- **Duplicate file reads:** Same file read multiple times → suggest caching
- **Tool results domination:** >70% of messages are tool results → suggest summarization
- **Stale context:** Old tool results from early turns still in context → suggest compaction

### Informational
- **Subagent overhead:** Number and cost of classifier/summarizer calls
- **Context growth rate:** Tokens added per turn trending upward
- **Compaction events:** When and how much context was freed

---

*Data collected: 2026-02-08*
*Source: Real Claude Code sessions via Context Lens proxy*
