'use client';

interface EndpointCardProps {
  endpoint: {
    name: string;
    description: string;
    endpointCount: number;
    doc_url?: string | null;
  };
  fallbackDocUrl?: string | null;
}

function getCapabilityIconName(name: string): string {
  const label = name.toLowerCase();
  if (/(payment|billing|invoice|checkout|charge|payout)/.test(label)) return 'credit-card';
  if (/(webhook|event|callback)/.test(label)) return 'webhook';
  if (/(connect|integration|platform|plugin|sdk)/.test(label)) return 'plug';
  if (/(flight|airline|airport)/.test(label)) return 'plane';
  if (/(hotel|stay|booking)/.test(label)) return 'hotel';
  if (/(search|lookup|query|discovery)/.test(label)) return 'search';
  if (/(security|auth|compliance|fraud|risk)/.test(label)) return 'shield-check';
  if (/(shipping|delivery|logistics|parcel|freight)/.test(label)) return 'truck';
  if (/(report|document|file|statement)/.test(label)) return 'file-text';
  return 'globe';
}

export function EndpointCard({ endpoint, fallbackDocUrl }: EndpointCardProps) {
  const href = endpoint.doc_url ?? fallbackDocUrl ?? '#';
  const iconName = getCapabilityIconName(endpoint.name);
  const iconSrc = `https://api.iconify.design/lucide:${iconName}.svg?color=%23ff9500`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="border border-[var(--foreground)]/20 rounded-[14px] py-[25px] px-[25px] flex flex-col items-center justify-center gap-[12px] min-h-[136px] transition-colors hover:border-[#FF9500]/40 group"
    >
      <div className="w-12 h-12 rounded-full bg-[#FF9500]/10 flex items-center justify-center">
        <img src={iconSrc} alt="" width={24} height={24} className="w-6 h-6" />
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <span className="text-xs leading-[18px] text-[var(--foreground)] font-normal">
          {endpoint.name}
        </span>
        <span className="text-[10px] leading-[16.25px] text-[var(--foreground)]/60">
          {endpoint.description}
        </span>
      </div>
    </a>
  );
}
