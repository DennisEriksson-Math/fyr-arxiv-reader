import katex from "katex";

export type MathTextToken =
  | { kind: "text"; text: string }
  | { kind: "math"; text: string; source: string; display: boolean };

// These limits bound work for untrusted public abstracts or model responses.
const MAX_EXPRESSION_LENGTH = 8_192;
const MAX_RENDERED_EXPRESSIONS = 128;
const DISPLAY_ENVIRONMENTS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*", "displaymath",
]);

/** Escape prose and fallbacks. Only KaTeX-generated markup may bypass this. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function closingDelimiter(text: string, start: number, close: string): number {
  let depth = 0;
  const limit = Math.min(text.length, start + MAX_EXPRESSION_LENGTH + close.length);
  for (let index = start; index < limit; index++) {
    // A delimiter inside a TeX group or comment does not close the expression.
    if (depth === 0 && text.startsWith(close, index)) {
      if (close === "$") {
        if (text[index + 1] === "$") { index++; continue; }
        // Avoid interpreting ordinary prices such as "$5 and $10" as math.
        if (/\s/.test(text[index - 1] ?? "") || /\d/.test(text[index + 1] ?? "")) return -1;
      }
      return index;
    }
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === "%") {
      const newline = text.indexOf("\n", index + 1);
      if (newline < 0 || newline >= limit) return -1;
      index = newline;
    } else if (text[index] === "{") depth++;
    else if (text[index] === "}") depth = Math.max(0, depth - 1);
  }
  return -1;
}

function closingEnvironment(text: string, start: number, environment: string): number {
  const begin = `\\begin{${environment}}`, end = `\\end{${environment}}`;
  let depth = 1;
  const limit = Math.min(text.length, start + MAX_EXPRESSION_LENGTH);
  for (let index = start + begin.length; index < limit; index++) {
    if (text.startsWith(begin, index)) { depth++; index += begin.length - 1; }
    else if (text.startsWith(end, index)) {
      if (--depth === 0) return index + end.length;
      index += end.length - 1;
    } else if (text[index] === "\\") index++;
    else if (text[index] === "%") {
      const newline = text.indexOf("\n", index + 1);
      if (newline < 0 || newline >= limit) return -1;
      index = newline;
    }
  }
  return -1;
}

/** Split mixed prose/TeX without treating text as HTML or changing its spacing. */
export function tokenizeMathText(text: string): MathTextToken[] {
  const tokens: MathTextToken[] = [];
  let prose = "";
  const flush = () => {
    if (prose) { tokens.push({ kind: "text", text: prose }); prose = ""; }
  };
  for (let index = 0; index < text.length;) {
    if (text.startsWith("\\$", index)) { prose += "$"; index += 2; continue; }
    // Do not mistake the second backslash of an escaped backslash for a command.
    if (text.startsWith("\\\\", index)) { prose += "\\\\"; index += 2; continue; }

    const environment = text[index] === "\\"
      ? /^\\begin\{([a-z]+\*?)\}/.exec(text.slice(index, index + 32))?.[1]
      : undefined;
    if (environment && DISPLAY_ENVIRONMENTS.has(environment)) {
      const end = closingEnvironment(text, index, environment);
      if (end >= 0) {
        flush();
        const source = text.slice(index, end);
        // KaTeX accepts equation/align/gather directly; displaymath is a wrapper.
        const math = environment === "displaymath"
          ? source.slice("\\begin{displaymath}".length, -"\\end{displaymath}".length)
          : source;
        tokens.push({ kind: "math", text: math, source, display: true });
        index = end;
        continue;
      }
    }

    let open = "", close = "", display = false;
    if (text.startsWith("$$", index)) { open = close = "$$"; display = true; }
    else if (text[index] === "$" && text[index + 1] && !/\s/.test(text[index + 1])) open = close = "$";
    else if (text.startsWith("\\(", index)) { open = "\\("; close = "\\)"; }
    else if (text.startsWith("\\[", index)) { open = "\\["; close = "\\]"; display = true; }
    if (open) {
      const start = index + open.length;
      const end = closingDelimiter(text, start, close);
      if (end > start && text.slice(start, end).trim()) {
        flush();
        tokens.push({ kind: "math", text: text.slice(start, end), source: text.slice(index, end + close.length), display });
        index = end + close.length;
        continue;
      }
      // An unmatched opening marker remains readable, including both dollars.
      prose += open;
      index += open.length;
      continue;
    }
    prose += text[index++];
  }
  flush();
  return tokens;
}

/**
 * Safe HTML for one field. Prose/fallbacks are escaped; math markup comes only
 * from KaTeX with untrusted commands disabled. Macro state never crosses fields.
 */
export function renderMathText(text: string): string {
  const macros = Object.create(null);
  let rendered = 0;
  return tokenizeMathText(text).map((token) => {
    if (token.kind === "text") return escapeHtml(token.text);
    const className = token.display ? "math-display" : "math-inline";
    if (token.text.length <= MAX_EXPRESSION_LENGTH && rendered++ < MAX_RENDERED_EXPRESSIONS) {
      try {
        const html = katex.renderToString(token.text, {
          displayMode: token.display,
          output: "htmlAndMathml",
          throwOnError: true,
          trust: false,
          strict: "ignore",
          maxExpand: 1_000,
          maxSize: 12,
          macros,
        });
        return `<span class="${className}">${html}</span>`;
      } catch {
        // Unsupported or malformed TeX remains original, selectable source.
      }
    }
    return `<span class="${className} math-fallback">${escapeHtml(token.source)}</span>`;
  }).join("");
}
