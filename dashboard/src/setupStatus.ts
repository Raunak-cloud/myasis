import { useEffect, useState } from 'react';

interface SetupCheck {
  id: string;
  label: string;
  done: boolean;
  hint: string;
  fix: 'details' | 'documents' | 'looking' | 'where' | 'external';
  required: boolean;
}

export interface SetupStatus {
  checks: SetupCheck[];
  ready: boolean;
  done: number;
  total: number;
}

export function useSetupStatus(): SetupStatus | null {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  useEffect(() => {
    const load = () => fetch('/api/setup/status').then((response) => response.json()).then(setStatus).catch(() => {});
    load();
    const id = setInterval(load, 6000);
    window.addEventListener('setup-status-changed', load);
    return () => {
      clearInterval(id);
      window.removeEventListener('setup-status-changed', load);
    };
  }, []);
  return status;
}
