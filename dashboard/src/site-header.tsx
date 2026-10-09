import { createRoot, hydrateRoot } from 'react-dom/client';
import { SiteHeader } from './components/SiteHeader';

const root = document.getElementById('site-header-root');
if (root) {
  const active = root.dataset.active === 'guide' ? 'guide' : 'blog';
  const header = <SiteHeader active={active} />;
  if (root.hasChildNodes()) hydrateRoot(root, header);
  else createRoot(root).render(header);
}
