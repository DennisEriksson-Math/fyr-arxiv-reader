export type PaperChange = "new" | "revised" | "late-window";

export interface Paper {
  id: string;
  base_id: string;
  title: string;
  abstract: string;
  authors: string[];
  published: string;
  updated: string;
  categories: string[];
  change?: PaperChange;
}

export interface Profile {
  broad: string[];
  sharp: string[];
  authors: string[];
  negative: string[];
  exclude_ids: string[];
  context: string;
  weights: Record<string, number>;
}

export interface RankedPaper extends Paper {
  score: number;
  matched: string[];
  author_match: boolean;
  semantic?: string;
}

export interface Coverage {
  complete: boolean;
  pages: number;
  entries: number;
  eligible: number;
  window_start: string;
  lookback_start: string;
  oldest_updated: string | null;
  hit_limit: boolean;
  warning: string | null;
}
