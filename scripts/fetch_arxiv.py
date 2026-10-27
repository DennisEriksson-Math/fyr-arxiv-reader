#!/usr/bin/env python3
"""Cache public arXiv mathematics metadata for the static Fyr reader.

Adapted from Fyr's arxiv_feed.py (MIT; see public/FYR-LICENSE.txt).
No profile, credentials, or user data is read or sent. A failed or empty scan
never replaces an existing cache; an incomplete nonempty scan is labelled.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

API = "https://export.arxiv.org/api/query"
ATOM = "http://www.w3.org/2005/Atom"
NS = {"a": ATOM, "o": "http://a9.com/-/spec/opensearch/1.1/"}
PAGE_SIZE = 200
MAX_ENTRIES = 2600
GRACE_DAYS = 4
POLITE_PAUSE = 3.1
RETRIES = 3
REQUEST_TIMEOUT = 30
SCAN_TIMEOUT = 10 * 60
MAX_RESPONSE_BYTES = 8_000_000
TRANSIENT_CODES = {408, 429, 500, 502, 503, 504}
ARXIV_ID = re.compile(r"(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*/\d{7})(?:v[1-9]\d*)?", re.I)


class FeedError(Exception):
    """The remote feed cannot be trusted or retrieved."""


def clean_text(entry: ET.Element, tag: str) -> str:
    return " ".join((entry.findtext(f"a:{tag}", default="", namespaces=NS)).split())


def entry_paper(entry: ET.Element) -> dict:
    raw_id = clean_text(entry, "id")
    parsed = urllib.parse.urlsplit(raw_id)
    if parsed.hostname not in {"arxiv.org", "www.arxiv.org"} or not parsed.path.startswith("/abs/"):
        raise FeedError("arXiv returned an error entry or an unexpected paper identifier")
    paper_id = parsed.path[len("/abs/"):]
    if not ARXIV_ID.fullmatch(paper_id):
        raise FeedError("arXiv returned an invalid paper identifier")
    published, updated = clean_text(entry, "published")[:10], clean_text(entry, "updated")[:10]
    try:
        if date.fromisoformat(published).isoformat() != published or date.fromisoformat(updated).isoformat() != updated:
            raise ValueError("invalid date")
    except ValueError as exc:
        raise FeedError("arXiv returned a paper with invalid dates") from exc
    title = clean_text(entry, "title")
    authors = [clean_text(author, "name") for author in entry.findall("a:author", NS)]
    categories = [c.get("term", "").strip() for c in entry.findall("a:category", NS)]
    if not title or not all(authors) or not authors or updated < published:
        raise FeedError("arXiv returned incomplete paper metadata")
    if not any(c.startswith("math.") for c in categories):
        raise FeedError("arXiv returned an entry outside the mathematics query")
    return {
        "id": paper_id, "base_id": re.sub(r"v\d+$", "", paper_id),
        "title": title, "abstract": clean_text(entry, "summary"),
        "authors": authors, "published": published, "updated": updated,
        "categories": [c for c in categories if c],
    }


def classify(paper: dict, cutoff: str, grace_cutoff: str) -> str | None:
    if paper["published"] >= cutoff:
        return "new"
    if paper["updated"] >= cutoff and paper["updated"] > paper["published"]:
        return "revised"
    if paper["published"] >= grace_cutoff:
        return "late-window"
    return None


class FeedClient:
    def __init__(self) -> None:
        self.next_request = 0.0
        self.deadline = time.monotonic() + SCAN_TIMEOUT

    def page(self, start: int) -> tuple[list[ET.Element], int | None]:
        params = urllib.parse.urlencode({
            "search_query": "cat:math.*", "max_results": PAGE_SIZE,
            "start": start, "sortBy": "lastUpdatedDate", "sortOrder": "descending",
        })
        request = urllib.request.Request(f"{API}?{params}", headers={
            "User-Agent": "Fyr-arXiv-reader/1.0 (public mathematics metadata cache)",
            "Accept": "application/atom+xml, application/xml;q=0.9",
        })
        last_error = "arXiv did not respond"
        for attempt in range(RETRIES + 1):
            wait = max(0.0, self.next_request - time.monotonic())
            if time.monotonic() + wait >= self.deadline:
                raise FeedError("The ten-minute scan time limit was reached")
            if wait:
                time.sleep(wait)
            try:
                remaining = max(0.1, self.deadline - time.monotonic())
                with urllib.request.urlopen(request, timeout=min(REQUEST_TIMEOUT, remaining)) as response:
                    if urllib.parse.urlsplit(response.url).scheme != "https":
                        raise FeedError("arXiv redirected to a non-HTTPS endpoint")
                    chunks, size = [], 0
                    while True:
                        if time.monotonic() >= self.deadline:
                            raise FeedError("The ten-minute scan time limit was reached")
                        chunk = response.read1(65536)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > MAX_RESPONSE_BYTES:
                            raise FeedError("An arXiv page exceeded the response size limit")
                        chunks.append(chunk)
                payload = b"".join(chunks)
                if b"<!DOCTYPE" in payload.upper() or b"<!ENTITY" in payload.upper():
                    raise FeedError("arXiv returned an unexpected XML declaration")
                root = ET.fromstring(payload)
                if root.tag != f"{{{ATOM}}}feed":
                    raise FeedError("arXiv returned a response that is not an Atom feed")
                entries = root.findall("a:entry", NS)
                if len(entries) > PAGE_SIZE:
                    raise FeedError("arXiv returned more entries than requested")
                total_text = root.findtext("o:totalResults", default="", namespaces=NS)
                if not total_text.strip().isdigit():
                    raise FeedError("arXiv returned an Atom feed without a valid result count")
                total = int(total_text)
                if not entries and start < total:
                    raise FeedError("arXiv returned an empty page before the end of its results")
                return entries, total
            except urllib.error.HTTPError as exc:
                last_error = f"HTTP {exc.code}"
                if exc.code not in TRANSIENT_CODES:
                    raise FeedError(f"arXiv request failed ({last_error})") from exc
            except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError, http.client.HTTPException) as exc:
                # Do not log environment proxy URLs or other potentially private details.
                last_error = type(exc).__name__
            except ET.ParseError as exc:
                raise FeedError("arXiv returned malformed XML") from exc
            finally:
                self.next_request = time.monotonic() + POLITE_PAUSE * (attempt + 1)
            if attempt == RETRIES:
                raise FeedError(f"arXiv request failed after {RETRIES + 1} attempts ({last_error})")
        raise FeedError(last_error)


def fetch(days: int = 7, max_pages: int | None = None, *, client=None, now=None) -> dict:
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=days)).date().isoformat()
    grace_cutoff = (now - timedelta(days=days + GRACE_DAYS)).date().isoformat()
    page_limit = min(MAX_ENTRIES // PAGE_SIZE, max_pages or MAX_ENTRIES // PAGE_SIZE)
    coverage = {
        "complete": False, "pages": 0, "entries": 0, "eligible": 0,
        "window_start": cutoff, "lookback_start": grace_cutoff,
        "oldest_updated": None, "hit_limit": False, "warning": None,
    }
    papers, seen, page_signatures = [], set(), set()
    client = client or FeedClient()
    invalid_entries = 0
    for page_index in range(page_limit):
        try:
            entries, total = client.page(page_index * PAGE_SIZE)
            # arXiv API errors may be wrapped in a 200 OK Atom entry.
            if any("/api/errors" in clean_text(entry, "id") for entry in entries):
                raise FeedError("arXiv returned an API error feed")
        except FeedError as exc:
            if not papers:
                raise
            coverage["warning"] = f"Page {page_index + 1} failed: {exc}. Showing a partial scan."
            break
        coverage["pages"] += 1
        coverage["entries"] += len(entries)
        signature = tuple(clean_text(entry, "id") for entry in entries)
        if signature and signature in page_signatures:
            coverage["warning"] = "arXiv repeated a page; coverage is incomplete."
            break
        page_signatures.add(signature)
        dates = []
        for entry in entries:
            try:
                paper = entry_paper(entry)
            except FeedError:
                invalid_entries += 1
                continue
            dates.append(paper["updated"])
            change = classify(paper, cutoff, grace_cutoff)
            if paper["updated"] < grace_cutoff or change is None or paper["base_id"] in seen:
                continue
            seen.add(paper["base_id"])
            papers.append(paper | {"change": change})
        oldest = min(dates) if dates else None
        if oldest:
            coverage["oldest_updated"] = min(coverage["oldest_updated"] or oldest, oldest)
        coverage["eligible"] = len(papers)
        print(f"Page {page_index + 1}: {len(papers)} eligible mathematics papers", file=sys.stderr)
        exhausted = total is not None and page_index * PAGE_SIZE + len(entries) >= total
        crossed = oldest is not None and oldest < grace_cutoff
        if exhausted or crossed or not entries:
            coverage["complete"] = invalid_entries == 0
            break
    else:
        coverage["hit_limit"] = True
        coverage["warning"] = f"The {page_limit * PAGE_SIZE}-entry scan limit was reached before the lookback boundary."
    if invalid_entries:
        coverage["complete"] = False
        detail = f"{invalid_entries} malformed entries were skipped; coverage is incomplete."
        coverage["warning"] = " ".join(filter(None, [coverage["warning"], detail]))
    coverage["eligible"] = len(papers)
    if not papers:
        raise FeedError("No eligible papers were retrieved; the existing cache is unchanged")
    papers.sort(key=lambda p: (p["updated"], p["id"]), reverse=True)
    return {"papers": papers, "coverage": coverage,
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}


def atomic_write(path: Path, payload: dict) -> None:
    """Only publish complete JSON, and retain the previous file if writing fails."""
    if not payload.get("papers"):
        raise FeedError("Refusing to write an empty cache")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("public/data/arxiv.json"))
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--max-pages", type=int, help="Optional smaller scan bound (for testing); maximum 13")
    args = parser.parse_args(argv)
    if not 1 <= args.days <= 31:
        parser.error("--days must be between 1 and 31")
    if args.max_pages is not None and not 1 <= args.max_pages <= MAX_ENTRIES // PAGE_SIZE:
        parser.error("--max-pages must be between 1 and 13")
    try:
        payload = fetch(args.days, args.max_pages)
        atomic_write(args.output, payload)
    except (FeedError, OSError) as exc:
        print(f"Refresh failed; previous cache retained: {exc}", file=sys.stderr)
        return 1
    if not payload["coverage"]["complete"]:
        print(f"WARNING: {payload['coverage']['warning']}", file=sys.stderr)
    print(f"Wrote {len(payload['papers'])} papers to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
