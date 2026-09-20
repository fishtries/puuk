#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Puuk UX Lite Search - BM25 search engine for UI/UX style guides (music-player scoped)
Usage: python search.py "<query>" [--domain <domain>] [--stack <stack>] [--max-results 3]

Domains: style, color, product, ux, typography, gsap, react, web
Stacks: react
"""

import argparse
import json as json_module
import sys
import io
from core import CSV_CONFIG, AVAILABLE_STACKS, MAX_RESULTS, UNTRUNCATED_COLS, search, search_stack

# Force UTF-8 for stdout/stderr to handle emojis on Windows (cp1252 default)
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
if sys.stderr.encoding and sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

TRUNCATE_AT = 300


def format_output(result, full=False):
    """Format results for Claude consumption (token-optimized)"""
    if "error" in result:
        return f"Error: {result['error']}"

    output = []
    if result.get("stack"):
        output.append("## Puuk UX Lite Stack Guidelines")
        output.append(f"**Stack:** {result['stack']} | **Query:** {result['query']}")
    else:
        output.append("## Puuk UX Lite Search Results")
        domain_note = result['domain']
        if result.get("auto_detected"):
            domain_note += " (auto-detected"
            if result.get("runner_up_domain"):
                domain_note += f", runner-up: {result['runner_up_domain']}"
            domain_note += ")"
        output.append(f"**Domain:** {domain_note} | **Query:** {result['query']}")
    output.append(f"**Source:** {result['file']} | **Found:** {result['count']} results\n")

    if result['count'] == 0:
        redirect = result.get("redirect")
        if redirect:
            output.append(
                "This legacy style label is now modeled in the "
                f"`{redirect['domain']}` domain as `{redirect['id']}`. "
                "Search that domain instead of treating a page composition as a visual style."
            )
            return "\n".join(output)
        output.append(
            "No matches. This is not a match with an empty value -- the query "
            "did not hit the database. Retry with broader/different keywords "
            "before falling back to general defaults, and say explicitly that "
            "no database match was found if you do fall back."
        )
        suggestions = result.get("suggestions") or []
        if suggestions:
            output.append(f"**Closest known terms:** {', '.join(suggestions)}")
        return "\n".join(output)

    for i, row in enumerate(result['results'], 1):
        output.append(f"### Result {i}")
        for key, value in row.items():
            value_str = str(value)
            if not full and key not in UNTRUNCATED_COLS and len(value_str) > TRUNCATE_AT:
                value_str = value_str[:TRUNCATE_AT] + "..."
            output.append(f"- **{key}:** {value_str}")
        output.append("")

    return "\n".join(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Puuk UX Lite Search")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--domain", "-d", choices=list(CSV_CONFIG.keys()), help="Search domain")
    parser.add_argument("--stack", "-s", choices=AVAILABLE_STACKS, help=f"Stack-specific search. Available: {', '.join(AVAILABLE_STACKS)}")
    parser.add_argument("--max-results", "-n", type=int, choices=range(1, 21), default=MAX_RESULTS,
                        metavar="1-20", help="Max results (default: 3)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--full", action="store_true", help="Do not truncate long field values in text output")

    args = parser.parse_args()

    # Stack search
    if args.stack:
        result = search_stack(args.query, args.stack, args.max_results)
        if args.json:
            print(json_module.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(format_output(result, full=args.full))
    # Domain search
    else:
        result = search(args.query, args.domain, args.max_results)
        if args.json:
            print(json_module.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(format_output(result, full=args.full))
