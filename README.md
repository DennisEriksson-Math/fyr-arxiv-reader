# Fyr · arXiv reader

A small, personal mathematics reading desk, adapted from Fyr.

**[Open the reader](https://denniseriksson-math.github.io/fyr-arxiv-reader/)**

## Start reading

1. Use **Add papers** or **Add folder**, at any time, to import more of your work. New suggestions are merged with your existing profile for review; your kept/removed papers, exclusions and custom context stay in place. Import papers, notes, or a folder of your work. PDF, text, Markdown, LaTeX, BibTeX, and HTML are supported.
2. Review the suggested keywords and authors. Add broad areas, specific questions, full author names, and exclusions. You can also enter everything manually.
3. Refresh the papers, then **Keep** or **Remove** each suggestion. Removed papers can be restored. Export your profile as JSON and your reading list as Markdown.

Suggestions from your documents use local text extraction and phrase heuristics. They are a starting point to edit, not an automatic understanding of your research. Author suggestions may include you and your coauthors. Image-only PDFs need OCR elsewhere first. Imports are limited to 50 supported documents, 15 MB per file, and the first 50 pages of each PDF.

Titles, abstracts and AI notes render standard LaTeX math locally with bundled KaTeX. Unsupported custom commands remain readable as source. Each paper has **Why this paper?**, with the matched keyword or author, a supporting public-paper passage, and the filename and extracted passage that supplied the interest when available. For profiles created before source tracking was added, re-add the files to attach this evidence.

No account is required. Imported files are read in your browser and are not uploaded. Short source passages are retained locally with your interests and included in profile exports. Your interests, kept/removed papers, and recent scan history use browser storage; export before changing devices or clearing browser data. Sharing the app's URL does not share your profile.

## How papers are selected

The public feed scans **all mathematics** on arXiv, ordered by the most recent update. It includes a seven-day reading window and a separate four-day grace band, with new submissions and revisions labelled separately. These dates are based on arXiv publication/update timestamps, not exact announcement dates.

Matching happens locally. Followed authors come first. Specific phrases carry more weight than broad interests, and title matches count more than abstract matches. Keeping a paper adds a small, capped boost to its matching phrases. Removed papers stay hidden until restored. Explicit phrase and paper-ID exclusions take precedence over all matches.

The coverage panel reports whether the scan reached the full window. The scanner stops after 8,000 entries and marks a feed partial if the limit or an upstream error prevents complete coverage. An empty or failed initial fetch preserves an existing cache.

## Optional AI

The reader works without a model. **A second perspective → Set up AI analysis** lets you connect an OpenAI API key or a local CLI/LLM bridge. **Check connection** tests access without requesting inference; **Find connections with AI** explicitly starts the analysis.

Model requests contain the reviewed interests/research context and public arXiv metadata. Imported filenames and source excerpts are excluded. Keys and bridge tokens stay in tab memory, not browser storage or this repository. OpenAI API requests use `store: false` and your API credit; provider policies still apply. A Claude CLI request uses your configured Claude account. A local server uses its configured model and routing.

AI notes explain possible connections to your named interests. They are based on abstracts, not proof verification or a full-paper review. Keyword and author evidence stays visible, and notes can only attach to papers in the supplied feed.

## Connect a CLI or local model

Clone this repository and install dependencies once:

```sh
git clone https://github.com/DennisEriksson-Math/fyr-arxiv-reader.git
cd fyr-arxiv-reader
npm ci
```

For **Claude CLI**, first install/authenticate Claude Code normally, then run:

```sh
npm run local -- --provider claude
```

For **LM Studio**, start its local OpenAI-compatible server and load a model:

```sh
npm run local -- --provider local-llm
```

If several models are available, specify `--model MODEL_ID`. For **Ollama**:

```sh
npm run local -- --provider local-llm --base-url http://127.0.0.1:11434/v1 --model YOUR_MODEL
```

Select **5 papers** for a lighter run on a local model; the full keyword feed remains available. Increase the model server’s context length if it rejects a request as too long.

The terminal prints a local app address and a temporary session token. Open the local app, choose **Local CLI / LLM bridge**, paste the token, and click **Check connection**. The bridge also allows connections from the public reader page; if your browser blocks that page's access to localhost, use the local app address. Profiles are stored separately for each browser origin: export your profile from the hosted page and import it locally when switching.

The bridge binds only to loopback, checks the exact browser origin and session token, and accepts a fixed response request rather than arbitrary commands. Claude runs with its built-in tools and MCP servers disabled, an isolated temporary working directory, and no session persistence. The installed CLI's managed policies still apply. Codex CLI is not enabled because this bridge cannot currently guarantee that all its file/command tools are off.

For a protected local model server, set `FYR_LOCAL_LLM_API_KEY` in the launcher's environment. Local-server URLs must be loopback addresses. If that server itself forwards requests to a cloud provider, its own routing settings determine where model input goes.

The local app uses the checked-out public feed. Refresh it before a reading session with:

```sh
python3 scripts/fetch_arxiv.py --output public/data/arxiv.json
npm run local -- --provider claude
```

## Run locally

Use Node.js 24 or newer and Python 3.12 or newer.

```sh
npm ci
npm test
python3 -B -m unittest discover -s tests -p 'test_*.py'
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
