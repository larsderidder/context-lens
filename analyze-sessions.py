#!/usr/bin/env python3
"""Analyze Context Lens session data and produce summary statistics."""

import json
import glob
import os
import sys

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

def categorize_block(role, block_type):
    if block_type == "thinking":
        return "thinking"
    if block_type == "tool_use":
        return "tool_calls"
    if block_type == "tool_result":
        return "tool_results"
    if role == "user" and block_type == "text":
        return "user_text"
    if role == "assistant" and block_type == "text":
        return "assistant_text"
    return "other"

def analyze_session(filepath):
    """Analyze the last request in a session (represents full context)."""
    last_line = None
    num_requests = 0
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if line:
                last_line = line
                num_requests += 1

    if not last_line:
        return None

    data = json.loads(last_line)
    ci = data.get("contextInfo", {})

    model = ci.get("model", "unknown")
    total = ci.get("totalTokens", 0)
    system_tokens = ci.get("systemTokens", 0)
    tools_tokens = ci.get("toolsTokens", 0)
    messages_tokens = ci.get("messagesTokens", 0)

    # Break down message tokens by type
    categories = {
        "thinking": 0,
        "tool_calls": 0,
        "tool_results": 0,
        "user_text": 0,
        "assistant_text": 0,
        "other": 0,
    }

    # We need to estimate per-block tokens from the messages
    # Context Lens stores per-message tokens but not always per-block
    # We'll use a heuristic: distribute message tokens across blocks by content length
    msgs = ci.get("messages", [])
    
    total_categorized = 0
    for msg in msgs:
        role = msg.get("role", "")
        msg_tokens = msg.get("tokens", 0)
        blocks = msg.get("contentBlocks") or []
        
        if not blocks:
            # No block breakdown; categorize by role
            if role == "user":
                # Could be tool_result or user text; check content
                content = msg.get("content", "")
                if "tool_result" in str(content):
                    categories["tool_results"] += msg_tokens
                else:
                    categories["user_text"] += msg_tokens
            elif role == "assistant":
                categories["assistant_text"] += msg_tokens
            total_categorized += msg_tokens
            continue

        # Estimate token distribution across blocks by text length
        block_lengths = []
        for b in blocks:
            text = b.get("text", "") or ""
            # tool_use and tool_result might have other fields
            if b.get("type") == "tool_use":
                inp = json.dumps(b.get("input", {})) if b.get("input") else ""
                text = b.get("name", "") + inp
            if b.get("type") == "tool_result":
                content = b.get("content", "")
                if isinstance(content, list):
                    text = json.dumps(content)
                elif isinstance(content, str):
                    text = content
            block_lengths.append(len(text))

        total_len = sum(block_lengths) or 1
        for b, blen in zip(blocks, block_lengths):
            cat = categorize_block(role, b.get("type", "text"))
            estimated_tokens = int(msg_tokens * blen / total_len)
            categories[cat] += estimated_tokens
            total_categorized += estimated_tokens

    # Check for system injections (user messages that look like system)
    # Usually the first user message with multiple text blocks is system-injected context

    return {
        "file": os.path.basename(filepath),
        "model": model,
        "requests": num_requests,
        "total_tokens": total,
        "system_tokens": system_tokens,
        "tools_tokens": tools_tokens,
        "messages_tokens": messages_tokens,
        **categories,
    }

def fmt_pct(val, total):
    if total == 0:
        return "0%"
    pct = val / total * 100
    if pct < 1 and val > 0:
        return "<1%"
    return f"{pct:.0f}%"

def print_session(s):
    total = s["total_tokens"]
    print(f"\n### {s['file']}")
    print(f"Model: {s['model']} | Requests: {s['requests']} | Total: {total:,} tokens")
    print(f"{'Category':<20} {'Tokens':>10} {'%':>6}")
    print(f"{'-'*38}")
    
    rows = [
        ("System prompt", s["system_tokens"]),
        ("Tool definitions", s["tools_tokens"]),
        ("Tool results", s["tool_results"]),
        ("Tool calls", s["tool_calls"]),
        ("Thinking", s["thinking"]),
        ("Assistant text", s["assistant_text"]),
        ("User text", s["user_text"]),
        ("Other", s["other"]),
    ]
    
    for label, val in sorted(rows, key=lambda x: -x[1]):
        if val > 0:
            print(f"{label:<20} {val:>10,} {fmt_pct(val, total):>6}")

def print_aggregate(sessions):
    print("\n" + "=" * 50)
    print("AGGREGATE ACROSS ALL SESSIONS")
    print("=" * 50)
    
    # Only sessions with >5000 tokens (skip tiny haiku classifier calls)
    big = [s for s in sessions if s["total_tokens"] > 5000]
    small = [s for s in sessions if s["total_tokens"] <= 5000]
    
    print(f"\nSessions analyzed: {len(big)} (skipped {len(small)} tiny sessions <5K tokens)")
    
    if not big:
        print("No sessions to analyze.")
        return

    # Averages
    totals = {
        "system_tokens": 0, "tools_tokens": 0, "tool_results": 0,
        "tool_calls": 0, "thinking": 0, "assistant_text": 0,
        "user_text": 0, "other": 0, "total_tokens": 0,
    }
    
    for s in big:
        for k in totals:
            totals[k] += s[k]

    grand = totals["total_tokens"]
    print(f"Combined tokens: {grand:,}")
    print(f"\n{'Category':<20} {'Total':>10} {'Avg %':>8}")
    print(f"{'-'*40}")
    
    rows = [
        ("System prompt", totals["system_tokens"]),
        ("Tool definitions", totals["tools_tokens"]),
        ("Tool results", totals["tool_results"]),
        ("Tool calls", totals["tool_calls"]),
        ("Thinking", totals["thinking"]),
        ("Assistant text", totals["assistant_text"]),
        ("User text", totals["user_text"]),
    ]
    
    for label, val in sorted(rows, key=lambda x: -x[1]):
        if val > 0:
            print(f"{label:<20} {val:>10,} {fmt_pct(val, grand):>8}")

    # Per-session ranges
    print(f"\n{'Metric':<25} {'Min':>8} {'Max':>8} {'Median':>8}")
    print(f"{'-'*51}")
    
    for label, key in [("Total tokens", "total_tokens"), ("Tool results %", None), ("Thinking %", None), ("User text %", None)]:
        if key:
            vals = sorted([s[key] for s in big])
        elif "Tool results" in label:
            vals = sorted([s["tool_results"] / s["total_tokens"] * 100 for s in big if s["total_tokens"] > 0])
        elif "Thinking" in label:
            vals = sorted([s["thinking"] / s["total_tokens"] * 100 for s in big if s["total_tokens"] > 0])
        elif "User text" in label:
            vals = sorted([s["user_text"] / s["total_tokens"] * 100 for s in big if s["total_tokens"] > 0])
        
        mid = vals[len(vals)//2]
        if key == "total_tokens":
            print(f"{label:<25} {vals[0]:>7,} {vals[-1]:>7,} {mid:>7,}")
        else:
            print(f"{label:<25} {vals[0]:>7.1f}% {vals[-1]:>7.1f}% {mid:>7.1f}%")

def main():
    pattern = os.path.join(DATA_DIR, "claude-*.jsonl")
    files = sorted(glob.glob(pattern))
    
    if not files:
        print(f"No session files found in {DATA_DIR}")
        sys.exit(1)
    
    print(f"Found {len(files)} session files")
    
    sessions = []
    for f in files:
        try:
            result = analyze_session(f)
            if result:
                sessions.append(result)
        except Exception as e:
            print(f"Error processing {f}: {e}", file=sys.stderr)
    
    # Print individual sessions (sorted by total tokens)
    for s in sorted(sessions, key=lambda x: -x["total_tokens"]):
        print_session(s)
    
    print_aggregate(sessions)

if __name__ == "__main__":
    main()
