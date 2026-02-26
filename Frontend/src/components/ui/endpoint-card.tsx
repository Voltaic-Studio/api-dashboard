'use client';

import { useState } from 'react';

interface CapabilityData {
  title: string;
  description: string;
  logo_url?: string | null;
}

interface EndpointCardProps {
  endpoint: {
    name: string;
    description: string;
    endpointCount?: number;
    doc_url?: string | null;
    logo_url?: string | null;
  };
  fallbackDocUrl?: string | null;
}

function getCapabilityIconName(name: string): string {
  const label = name.toLowerCase();
  if (/(payment|billing|invoice|checkout|charge|payout)/.test(label)) return 'credit-card';
  if (/(webhook|event|callback)/.test(label)) return 'webhook';
  if (/(connect|integration|platform|plugin|sdk)/.test(label)) return 'plug';
  if (/(flight|airline|airport)/.test(label)) return 'plane';
  if (/(hotel|stay|booking|accommodation)/.test(label)) return 'hotel';
  if (/(search|lookup|query|discovery)/.test(label)) return 'search';
  if (/(security|auth|compliance|fraud|risk)/.test(label)) return 'shield-check';
  if (/(shipping|delivery|logistics|parcel|freight)/.test(label)) return 'truck';
  if (/(report|document|file|statement)/.test(label)) return 'file-text';
  if (/(map|location|geocod|place|direction|route)/.test(label)) return 'map-pin';
  if (/(storage|bucket|blob|upload|download)/.test(label)) return 'hard-drive';
  if (/(compute|instance|vm|server|lambda|function)/.test(label)) return 'cpu';
  if (/(database|sql|dynamo|table|query)/.test(label)) return 'database';
  if (/(message|queue|notification|push|sms|email|chat)/.test(label)) return 'message-square';
  if (/(machine.?learn|ml|ai|model|predict|vision|vertex)/.test(label)) return 'brain';
  if (/(analytic|metric|monitor|log|observ|insight)/.test(label)) return 'bar-chart-2';
  if (/(video|stream|media|audio|image|photo)/.test(label)) return 'play-circle';
  if (/(user|identity|account|profile|customer)/.test(label)) return 'user';
  if (/(subscription|recurring|plan|pricing)/.test(label)) return 'repeat';
  if (/(dns|domain|network|cdn|load.?balanc)/.test(label)) return 'network';
  return 'globe';
}

export function EndpointCard({ endpoint, fallbackDocUrl }: EndpointCardProps) {
  const href = endpoint.doc_url ?? fallbackDocUrl ?? '#';
  const hasLogo = !!endpoint.logo_url;
  const [logoError, setLogoError] = useState(false);

  const iconName = getCapabilityIconName(endpoint.name);
  const iconSrc = `https://api.iconify.design/lucide:${iconName}.svg?color=%23ff9500`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="border border-[var(--foreground)]/20 rounded-[14px] py-[25px] px-[25px] flex flex-col items-center justify-center gap-[12px] min-h-[136px] transition-colors hover:border-[#FF9500]/40 group"
    >
      <div className="w-12 h-12 rounded-full bg-[#FF9500]/10 flex items-center justify-center overflow-hidden">
        {hasLogo && !logoError ? (
          <img
            src={endpoint.logo_url!}
            alt=""
            width={32}
            height={32}
            className="w-8 h-8 rounded-full object-cover"
            onError={() => setLogoError(true)}
          />
        ) : (
          <img src={iconSrc} alt="" width={24} height={24} className="w-6 h-6" />
        )}
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
