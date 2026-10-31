import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AttentionPanel, type AttentionItem } from '../src/components/AttentionPanel';

const initial: AttentionItem[] = [{ jobId: 'fixture-job', title: 'Fixture role', company: 'Fixture employer', kind: 'question', reason: 'Required facts', url: 'https://example.test', at: '2026-10-30T00:00:00Z', questions: [
  { question: 'Tell us more', prompt: 'What is your notice period?' },
  { question: 'Tell us more', prompt: 'Why do you want this role?', kind: 'textarea' },
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
