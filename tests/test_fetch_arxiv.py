"""Offline tests for the public metadata cache; no live arXiv calls."""
from __future__ import annotations

import contextlib
import http.client
import io
import json
import tempfile
import unittest
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from scripts import fetch_arxiv as feed

NOW = datetime(2026, 10, 27, tzinfo=timezone.utc)


def entry(paper_id="2610.12345v1", published="2026-10-26", updated=None):
    el = ET.Element(f"{{{feed.ATOM}}}entry")
    for tag, value in {
        "id": f"https://arxiv.org/abs/{paper_id}",
        "title": "  Geometry\n  and   arithmetic  ",
        "summary": "An abstract with x < y & geometry.",
        "published": f"{published}T12:00:00Z",
        "updated": f"{updated or published}T12:00:00Z",
    }.items():
        ET.SubElement(el, f"{{{feed.ATOM}}}{tag}").text = value
    author = ET.SubElement(el, f"{{{feed.ATOM}}}author")
    ET.SubElement(author, f"{{{feed.ATOM}}}name").text = "Ada Author"
    ET.SubElement(el, f"{{{feed.ATOM}}}category", term="math.AG")
    return el


def atom(entries, total):
    root = ET.Element(f"{{{feed.ATOM}}}feed")
    ET.SubElement(root, f"{{{feed.NS['o']}}}totalResults").text = str(total)
    root.extend(entries)
    return ET.tostring(root, encoding="utf-8")


class Response(io.BytesIO):
    url = feed.API


class Pages:
    def __init__(self, *pages):
        self.pages = iter(pages)
        self.starts = []

    def page(self, start):
        self.starts.append(start)
        value = next(self.pages)
        if isinstance(value, Exception):
            raise value
        return value


class FetchArxivTests(unittest.TestCase):
    def setUp(self):
        # Any accidentally unmocked request fails immediately, never hits arXiv.
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(feed.urllib.request, "urlopen",
                          side_effect=AssertionError("Live network calls are forbidden in tests")).start()
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    def scan(self, pages, **kwargs):
        return feed.fetch(client=pages, now=NOW, **kwargs)

    def test_modern_and_legacy_ids_and_plain_text(self):
        for raw_id, base_id in [("2610.12345v2", "2610.12345"),
                                ("math/0602355v3", "math/0602355")]:
            with self.subTest(raw_id=raw_id):
                paper = feed.entry_paper(entry(raw_id))
                self.assertEqual(paper["id"], raw_id)
                self.assertEqual(paper["base_id"], base_id)
                self.assertEqual(paper["title"], "Geometry and arithmetic")
                self.assertIn("x < y & geometry", paper["abstract"])
                self.assertEqual(paper["authors"], ["Ada Author"])
                self.assertEqual(paper["categories"], ["math.AG"])

    def test_week_and_grace_classification_including_boundaries(self):
        records = [entry("2610.12341v1", "2026-10-20"),
                   entry("2610.12342v2", "2026-10-01", "2026-10-20"),
                   entry("2610.12343v1", "2026-10-16"),
                   entry("2610.12344v2", "2026-10-01", "2026-10-19")]
        result = self.scan(Pages((records, 4)))
        changes = {p["id"]: p["change"] for p in result["papers"]}
        self.assertEqual(changes, {"2610.12341v1": "new", "2610.12342v2": "revised",
                                   "2610.12343v1": "late-window"})
        self.assertEqual(result["coverage"]["window_start"], "2026-10-20")
        self.assertEqual(result["coverage"]["lookback_start"], "2026-10-16")

    def test_crossing_lookback_boundary_stops_before_another_page(self):
        pages = Pages(([entry(), entry("2609.12345v1", "2026-10-15")], 1000))
        result = self.scan(pages)
        self.assertEqual(pages.starts, [0])
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["oldest_updated"], "2026-10-15")
        self.assertEqual(result["coverage"]["entries"], 2)
        self.assertEqual(result["coverage"]["eligible"], 1)

    def test_exhausting_available_results_is_complete(self):
        result = self.scan(Pages(([entry()], 1)))
        self.assertTrue(result["coverage"]["complete"])
        self.assertFalse(result["coverage"]["hit_limit"])
        self.assertIsNone(result["coverage"]["warning"])
        self.assertTrue(result["fetched_at"].endswith("Z"))

    def test_page_limit_marks_nonempty_scan_partial(self):
        pages = Pages(([entry()], 1000))
        result = self.scan(pages, max_pages=1)
        self.assertFalse(result["coverage"]["complete"])
        self.assertTrue(result["coverage"]["hit_limit"])
        self.assertEqual(result["coverage"]["pages"], 1)
        self.assertIn("scan limit", result["coverage"]["warning"])

    def test_later_page_failure_keeps_papers_with_partial_warning(self):
        pages = Pages(([entry()], 1000), feed.FeedError("temporarily unavailable"))
        result = self.scan(pages)
        self.assertEqual(pages.starts, [0, 200])
        self.assertEqual(len(result["papers"]), 1)
        self.assertFalse(result["coverage"]["complete"])
        self.assertIn("Page 2 failed", result["coverage"]["warning"])

    def test_duplicate_versions_are_not_published_twice(self):
        result = self.scan(Pages(([entry("2610.12345v2"), entry("2610.12345v1")], 2)))
        self.assertEqual([p["id"] for p in result["papers"]], ["2610.12345v2"])
        self.assertEqual(result["coverage"]["eligible"], 1)

    def test_repeated_page_does_not_claim_complete_coverage(self):
        same_page = ([entry()], 1000)
        result = self.scan(Pages(same_page, same_page))
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(len(result["papers"]), 1)
        self.assertIn("repeated a page", result["coverage"]["warning"])

    def test_malformed_entry_marks_otherwise_complete_scan_partial(self):
        malformed = entry("invalid-id")
        result = self.scan(Pages(([entry(), malformed], 2)))
        self.assertEqual(len(result["papers"]), 1)
        self.assertFalse(result["coverage"]["complete"])
        self.assertIn("1 malformed", result["coverage"]["warning"])

    def test_api_error_wrapped_in_atom_is_not_an_empty_success(self):
        error = entry()
        error.find("a:id", feed.NS).text = "http://arxiv.org/api/errors#bad_query"
        with self.assertRaisesRegex(feed.FeedError, "API error"):
            self.scan(Pages(([error], 1)))

    def test_empty_scan_and_initial_failure_preserve_previous_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "arxiv.json"
            path.write_text("last-good-cache", encoding="utf-8")
            for pages in [Pages(([], 0)), Pages(feed.FeedError("offline"))]:
                with self.subTest(pages=pages), mock.patch.object(feed, "FeedClient", return_value=pages):
                    self.assertEqual(feed.main(["--output", str(path)]), 1)
                self.assertEqual(path.read_text(encoding="utf-8"), "last-good-cache")

    def test_atomic_write_failure_keeps_previous_bytes_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "arxiv.json"
            path.write_text("last-good-cache", encoding="utf-8")
            with mock.patch.object(feed.os, "replace", side_effect=OSError("write failed")):
                with self.assertRaises(OSError):
                    feed.atomic_write(path, {"papers": [{"id": "2610.12345v1"}]})
            self.assertEqual(path.read_text(encoding="utf-8"), "last-good-cache")
            self.assertEqual(list(Path(tmp).iterdir()), [path])
            with self.assertRaises(feed.FeedError):
                feed.atomic_write(path, {"papers": []})
            self.assertEqual(path.read_text(encoding="utf-8"), "last-good-cache")

    def test_atomic_write_publishes_valid_json(self):
        result = self.scan(Pages(([entry()], 1)))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "data" / "arxiv.json"
            feed.atomic_write(path, result)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), result)

    def test_https_math_query_and_three_transient_retries(self):
        error = urllib.error.HTTPError(feed.API, 503, "busy", {}, None)
        response = Response(atom([entry()], 1))
        with mock.patch.object(feed.urllib.request, "urlopen",
                               side_effect=[error, error, error, response]) as request, \
                mock.patch.object(feed.time, "sleep") as sleep:
            entries, total = feed.FeedClient().page(200)
        self.assertEqual(request.call_count, 4)
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual((len(entries), total), (1, 1))
        url = urllib.parse.urlsplit(request.call_args.args[0].full_url)
        self.assertEqual(url.scheme, "https")
        self.assertEqual(urllib.parse.parse_qs(url.query), {
            "search_query": ["cat:math.*"], "max_results": ["200"], "start": ["200"],
            "sortBy": ["lastUpdatedDate"], "sortOrder": ["descending"],
        })
        self.assertLessEqual(request.call_args.kwargs["timeout"], 30)

    def test_permanent_http_failure_is_not_retried(self):
        error = urllib.error.HTTPError(feed.API, 404, "missing", {}, None)
        with mock.patch.object(feed.urllib.request, "urlopen", side_effect=error) as request:
            with self.assertRaisesRegex(feed.FeedError, "HTTP 404"):
                feed.FeedClient().page(0)
        self.assertEqual(request.call_count, 1)

    def test_truncated_transport_response_gets_bounded_retries(self):
        with mock.patch.object(feed.urllib.request, "urlopen",
                               side_effect=http.client.IncompleteRead(b"partial")) as request, \
                mock.patch.object(feed.time, "sleep"):
            with self.assertRaisesRegex(feed.FeedError, "after 4 attempts"):
                feed.FeedClient().page(0)
        self.assertEqual(request.call_count, 4)

    def test_empty_page_before_reported_end_is_rejected(self):
        with mock.patch.object(feed.urllib.request, "urlopen", return_value=Response(atom([], 1000))):
            with self.assertRaisesRegex(feed.FeedError, "empty page before"):
                feed.FeedClient().page(0)

    def test_malformed_xml_is_rejected(self):
        with mock.patch.object(feed.urllib.request, "urlopen", return_value=Response(b"<broken>")):
            with self.assertRaisesRegex(feed.FeedError, "malformed XML"):
                feed.FeedClient().page(0)


if __name__ == "__main__":
    unittest.main()
