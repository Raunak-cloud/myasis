'use client';
import { useEffect } from 'react';
import { trackPage } from '../../dashboard/src/analytics';
import { captureRedditClickId, initRedditPixel, trackRedditEvent } from '../../dashboard/src/redditPixel';
import { initMetaPixel, trackMetaEvent } from '../../dashboard/src/metaPixel';

export function PublicTracking({ page }: { page: string }) {
  useEffect(() => {
    trackPage(page);
    if (page !== 'landing') return;
    captureRedditClickId();
    initMetaPixel();
    initRedditPixel();
    const params = new URLSearchParams(location.search);
    const signup = params.get('rdt_signup');
    if (signup) {
      trackRedditEvent('SignUp', { conversionId: signup });
      trackMetaEvent('CompleteRegistration', {}, signup);
      params.delete('rdt_signup');
      history.replaceState({}, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    }
  }, [page]);
  return null;
}
