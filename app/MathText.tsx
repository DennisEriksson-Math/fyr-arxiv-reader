import { memo, useMemo } from "react";
import "katex/dist/katex.min.css";
import { renderMathText } from "../lib/math-text";

export interface MathTextProps {
  text: string;
  className?: string;
}

/** Inline-safe wrapper: usable in paper headings, paragraphs, and annotations. */
const MathText = memo(function MathText({ text, className }: MathTextProps) {
  const html = useMemo(() => renderMathText(text), [text]);
  return (
    <span
      className={className ? `math-text ${className}` : "math-text"}
      // The helper escapes all prose and fallback text. Its only HTML source is
      // KaTeX with trust:false; no author-provided HTML is passed through.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export default MathText;
