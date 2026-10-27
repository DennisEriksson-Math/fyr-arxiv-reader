# Fyr · arXiv reader

A small, personal mathematics reading desk, adapted from Fyr.

**[Open the reader](https://denniseriksson-math.github.io/fyr-arxiv-reader/)**

## Start reading

1. Import papers, notes, or a folder of your work. PDF, text, Markdown, LaTeX, BibTeX, and HTML are supported.
2. Review the suggested keywords and authors. Add broad areas, specific questions, full author names, and exclusions. You can also enter everything manually.
3. Refresh the papers, then **Keep** or **Remove** each suggestion. Removed papers can be restored. Export your profile as JSON and your reading list as Markdown.

Suggestions from your documents use local text extraction and phrase heuristics. They are a starting point to edit, not an automatic understanding of your research. Author suggestions may include you and your coauthors. Image-only PDFs need OCR elsewhere first. Imports are limited to 50 supported documents, 15 MB per file, and the first 50 pages of each PDF.

No account is required. Imported files are read in your browser and are not uploaded. Your interests, kept/removed papers, and recent scan history use browser storage; export before changing devices or clearing browser data. Sharing the app's URL does not share your profile.

## How papers are selected

The public feed scans **all mathematics** on arXiv, ordered by the most recent update. It includes a seven-day reading window and a separate four-day grace band, with new submissions and revisions labelled separately. These dates are based on arXiv publication/update timestamps, not exact announcement dates.

Matching happens locally. Followed authors come first. Specific phrases carry more weight than broad interests, and title matches count more than abstract matches. Keeping a paper adds a small, capped boost to its matching phrases. Removed papers stay hidden until restored. Explicit phrase and paper-ID exclusions take precedence over all matches.

The coverage panel reports whether the scan reached the full window. The scanner stops after 2,600 entries and marks a feed partial if the limit or an upstream error prevents complete coverage. An empty or failed initial fetch preserves an existing cache.

## Optional AI

The reader works without AI or an API key. If enabled, optional OpenAI analysis can suggest a few less obvious connections and add short abstract-based reading notes.

The user supplies their own API key and explicitly starts analysis. This sends the supplied interests/research context and public arXiv metadata to OpenAI and uses the user's API credit. It does not send imported documents. The key stays in tab memory and is never stored in the repository or browser storage. Requests use `store: false`. Model/provider data policies still apply.

AI notes are suggestions, not proof verification or a full-paper review. The deterministic match reasons remain visible, and AI cannot invent links to papers outside the supplied feed. The default model is `gpt-5-mini`; the model field is editable.

## Run locally

Use Node.js 24 or newer and Python 3.12 or newer.

```sh
npm ci
npm test
python3 scripts/fetch_arxiv.py --output public/data/arxiv.json
npm run dev
```

Open the URL printed by Vite, including `/fyr-arxiv-reader/`. The initial arXiv fetch may take a minute or more because requests are deliberately paced.

```sh
npm run build
npm run preview
```

## Hosting and updates

The app is a static GitHub Pages site. No server, database, account system, or secret is needed for its core features.

- **Deploy reader** builds, tests, and publishes changes pushed to `main`.
- **Refresh arXiv mathematics** refreshes the public metadata cache at 18:30 UTC on weekdays. It can also be run manually from Actions. Scheduled jobs may be delayed by GitHub.
- The refresh job commits only public arXiv metadata and calls the deployment workflow directly. Personal profiles and imported work never enter this cache.

For a fork, change `base` in `vite.config.ts` to the repository path, update the source/app links, and select **GitHub Actions** as the Pages build source in repository settings. Run **Refresh arXiv mathematics** once to seed the feed.

## Credits

Adapted from Fyr's arXiv scanning and interest-matching approach. Original Fyr code is covered by the retained [Fyr MIT notice](public/FYR-LICENSE.txt). This reader is MIT licensed. Paper metadata and abstracts come from [arXiv](https://arxiv.org/); this project is not affiliated with arXiv. Rights in paper content remain with their respective holders.
