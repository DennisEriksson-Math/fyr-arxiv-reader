import {useMemo,useState} from 'react';
import {ArrowUpRight,Bookmark,ChevronDown,FileText,Sparkles,Users,X} from 'lucide-react';
import {explainRelevance} from '../lib/relevance';
import type {Profile,RankedPaper} from '../lib/types';
import MathText from './MathText';

export type Annotation={id:string;priority:string;summary:string;why:string;possible_use:string;caveat:string};
type Props={paper:RankedPaper;profile:Profile;saved:boolean;onBookmark:()=>void;onRemove:()=>void;removed?:boolean;annotation?:Annotation};
const date=(value:string)=>new Date(value+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'});

export default function PaperCard({paper,profile,saved,onBookmark,onRemove,removed=false,annotation}:Props){
 const [expanded,setExpanded]=useState(false);const [evidenceOpen,setEvidenceOpen]=useState(false);
 const reasons=useMemo(()=>explainRelevance(paper,profile),[paper,profile]);
 const first=reasons[0];
 const category=paper.categories.find(x=>x.startsWith('math.'))||paper.categories[0]||'mathematics';
 return <article className="paper-card">
  <div className="paper-meta"><span className={'badge '+(paper.change==='revised'?'revised':paper.change==='late-window'?'late':'')}>{paper.change==='revised'?'Revised':paper.change==='late-window'?'Late window':'New'}</span><span className="paper-category">{category}</span><span className="divider-dot"/><span>{date(paper.change==='revised'?paper.updated:paper.published)}</span><span className="divider-dot"/><span>{paper.id}</span></div>
  <button className={'bookmark-btn '+(saved?'saved':'')} aria-label={saved?'Remove from reading list':'Save to reading list'} aria-pressed={saved} onClick={onBookmark}><Bookmark size={19} fill={saved?'currentColor':'none'}/></button>
  <h2><a href={'https://arxiv.org/abs/'+encodeURI(paper.id)} target="_blank" rel="noreferrer"><MathText text={paper.title}/></a></h2>
  <p className="paper-authors">{paper.authors.join(', ')}</p>
  <div className={'paper-abstract '+(expanded?'':'collapsed')}><MathText text={paper.abstract}/></div>
  <div className="paper-actions"><div className="paper-decisions"><button className={'keep-button '+(saved?'kept':'')} onClick={onBookmark}><Bookmark size={12} fill={saved?'currentColor':'none'}/>{saved?'Kept':'Keep'}</button><button onClick={onRemove}><X size={12}/>{removed?'Restore':'Remove'}</button></div><button onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>{expanded?'Less abstract':'Read abstract'}<ChevronDown size={12} style={{transform:expanded?'rotate(180deg)':undefined}}/></button><a href={'https://arxiv.org/pdf/'+encodeURI(paper.id)} target="_blank" rel="noreferrer">Open PDF <ArrowUpRight size={13}/></a></div>
  <div className="match-chips">{reasons.filter(r=>r.kind==='author').slice(0,2).map(r=><span className="match-chip" key={r.term}><Users size={10}/>{r.term}</span>)}{reasons.filter(r=>r.kind==='keyword').slice(0,5).map(r=><span className="match-chip" key={r.term}><MathText text={r.term}/></span>)}{paper.semantic&&<span className="match-chip semantic"><Sparkles size={10}/>AI connection</span>}</div>
  <section className="relevance" aria-label="Why this paper relates to your work">
   <h3>Why this paper?</h3>
   {first?<>
    <p>{first.kind==='author'?<>You follow <b>{first.term}</b>, who is an author of this paper.</>:<>Your {first.label.toLowerCase()} <b><MathText text={first.term}/></b> appears in the {first.location}.</>}{first.documents.length>0&&<> This interest comes from <b>{first.documents[0].name}</b>{first.documents.length>1?' and other imported work':''}.</>}</p>
    <details className="relevance-details" onToggle={e=>setEvidenceOpen(e.currentTarget.open)}><summary>Show the connection{reasons.length>1?`s (${reasons.length})`:''}<ChevronDown size={12}/></summary>
     {evidenceOpen&&reasons.slice(0,12).map(reason=><div className="reason" key={reason.kind+reason.term}>
      <div className="reason-heading"><span>{reason.label}</span><b><MathText text={reason.term}/></b></div>
      <div className="evidence-pair"><div><span className="evidence-label">In this paper’s {reason.location}</span><blockquote><MathText text={reason.excerpt}/></blockquote></div><div><span className="evidence-label">From your work</span>{reason.documents.length?reason.documents.map(document=><div className="source-evidence" key={document.name}><p><FileText size={12}/>{document.name}</p><blockquote><MathText text={document.excerpt}/></blockquote><small>Extracted text; formatting simplified.</small></div>):<p className="evidence-empty">From your saved interests. No imported source passage is attached to this entry.</p>}</div></div>
      {reason.boosted&&<p className="feedback-note">You previously kept papers matching this interest, which gives it a small ranking boost.</p>}
     </div>)}
     {reasons.length>12&&<p className="tooltip-note">Showing the first 12 matching interests.</p>}
     <p className="tooltip-note">These are text and author matches. AI analysis can suggest a mathematical connection to investigate.</p>
    </details>
   </>:paper.semantic?<p><MathText text={paper.semantic}/></p>:<p>This paper has no keyword or author match with your current interests. Your saved decision is preserved.</p>}
  </section>
  {annotation&&<div className="ai-note"><h3><Sparkles size={12}/>AI reading note {annotation.priority&&<span>· {annotation.priority}</span>}</h3><p><MathText text={annotation.summary}/></p>{annotation.why&&<p><b>Connection to your interests.</b> <MathText text={annotation.why}/></p>}{annotation.possible_use&&<p><b>Possible use.</b> <MathText text={annotation.possible_use}/></p>}{annotation.caveat&&<p className="caveat"><MathText text={annotation.caveat}/></p>}<p className="caveat">Based on the abstract. Check the paper before relying on this note.</p></div>}
  {paper.semantic&&!annotation&&<p className="caveat semantic-caveat">The AI connection is a suggestion to investigate, not a verified result.</p>}
 </article>;
}
