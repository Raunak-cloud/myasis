import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AttentionPanel, type AttentionItem } from '../src/components/AttentionPanel';
import type { QuestionSnapshot } from '../../seek-bot/src/question-snapshot';
import '../src/index.css';

function question(prompt:string,index:string,kind:'text'|'textarea'='text') {
  const snapshot:QuestionSnapshot={version:2,id:`q2_${index.repeat(64)}`,revision:index.repeat(64),source:{origin:'https://employer.example',path:'/apply'},prompt,context:[],help:[],completeness:'complete',controls:[{id:'part0',label:prompt,kind,required:true,multiple:false,choices:[],constraints:{}}]};
  return {question:prompt,snapshot};
}

const initial: AttentionItem[] = [{ jobId: 'fixture-job', title: 'Fixture role', company: 'Fixture employer', kind: 'question', reason: 'Required facts', url: 'https://example.test', at: '2026-10-30T00:00:00Z', questions: [
  question('What is your notice period?','1'),
  question('Why do you want this role?','2','textarea'),
] }];
document.documentElement.dataset.saved = '0';
export function Fixture() {
  const [items, setItems] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const update = (event: Event) => {
      const payload = JSON.parse((event as CustomEvent<string>).detail);
      if ('items' in payload) setItems(payload.items);
      if ('error' in payload) setError(payload.error);
    };
    document.addEventListener('attention-fixture', update);
    return () => document.removeEventListener('attention-fixture', update);
  }, []);
  return <AttentionPanel items={items} loadError={error} onCleared={() => { document.documentElement.dataset.saved = String(Number(document.documentElement.dataset.saved) + 1); }} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
