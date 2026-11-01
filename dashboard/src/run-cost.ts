export interface RunCost {
  currency: 'USD'; totalUsd: number; knownCharges: number;
  incomplete: boolean; estimated: boolean;
}

export function formatRunCost(cost:RunCost|null):string {
  if(!cost)return '—';
  if(!cost.knownCharges)return 'Unavailable';
  const amount=cost.totalUsd>0&&cost.totalUsd<.0001?'<US$0.0001':`US$${cost.totalUsd.toFixed(4)}`;
  return amount+(cost.incomplete?' +':'');
}
export function runCostTitle(cost:RunCost|null):string {
  if(!cost)return 'No cost was recorded for this run.';
  return ['Total recorded run cost in USD.',cost.estimated?'Includes estimated charges.':'',
    cost.incomplete?'Additional or unpriced charges may be missing.':''].filter(Boolean).join(' ');
}
