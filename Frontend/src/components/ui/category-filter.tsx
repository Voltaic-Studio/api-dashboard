'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X } from 'lucide-react';

export const API_CATEGORIES = [
  'AI & Machine Learning',
  'Analytics',
  'Authentication',
  'Automation',
  'Blockchain & Crypto',
  'Business & Finance',
  'Cloud & Infrastructure',
  'Communication',
  'CRM & Sales',
  'Data & Databases',
  'DevOps & CI/CD',
  'E-commerce',
  'Education',
  'Email',
  'Entertainment & Media',
  'File Storage',
  'Food & Drink',
  'Gaming',
  'Geolocation & Maps',
  'Government & Open Data',
  'Health & Fitness',
  'HR & Recruiting',
  'IoT & Hardware',
  'Legal & Compliance',
  'Logistics & Shipping',
  'Marketing & Ads',
  'Music & Audio',
  'News & Content',
  'Payments',
  'Productivity',
  'Real Estate',
  'Science & Research',
  'Search',
  'Security',
  'SMS & Messaging',
  'Social Media',
  'Sports',
  'Testing & Monitoring',
  'Translation & Language',
  'Travel & Transportation',
  'Video & Streaming',
  'Weather',
] as const;

export type ApiCategory = (typeof API_CATEGORIES)[number];

const CATEGORY_KEYWORDS: Record<ApiCategory, string[]> = {
  'AI & Machine Learning': ['ai', 'machine learning', 'ml', 'nlp', 'gpt', 'llm', 'openai', 'anthropic', 'hugging', 'deepl', 'vision', 'tensorflow', 'cognitive', 'neural', 'predict', 'classify', 'sentiment', 'generative', 'copilot', 'cohere', 'replicate', 'stability'],
  'Analytics': ['analytics', 'metrics', 'tracking', 'insights', 'statistics', 'dashboard', 'mixpanel', 'amplitude', 'segment', 'plausible', 'posthog', 'heap'],
  'Authentication': ['auth', 'oauth', 'identity', 'login', 'sso', 'jwt', 'saml', 'okta', 'auth0', 'clerk', 'firebase auth', 'keycloak', 'passkey'],
  'Automation': ['automat', 'workflow', 'zapier', 'integromat', 'make.com', 'n8n', 'ifttt', 'trigger', 'pipeline', 'orchestrat'],
  'Blockchain & Crypto': ['blockchain', 'crypto', 'bitcoin', 'ethereum', 'web3', 'nft', 'defi', 'wallet', 'token', 'solana', 'polygon', 'alchemy', 'moralis', 'chain'],
  'Business & Finance': ['finance', 'banking', 'stock', 'trading', 'investment', 'accounting', 'invoice', 'tax', 'plaid', 'yodlee', 'quickbooks', 'xero', 'fintech', 'exchange rate', 'currency'],
  'Cloud & Infrastructure': ['cloud', 'aws', 'azure', 'gcp', 'server', 'kubernetes', 'docker', 'hosting', 'cdn', 'dns', 'ssl', 'compute', 'lambda', 'vercel', 'netlify', 'heroku', 'digital ocean', 'vultr'],
  'Communication': ['communication', 'chat', 'voice', 'call', 'video call', 'voip', 'webrtc', 'twilio', 'vonage', 'agora', 'daily', 'livekit', 'intercom'],
  'CRM & Sales': ['crm', 'sales', 'lead', 'customer', 'hubspot', 'salesforce', 'pipedrive', 'close', 'deal', 'contact management', 'freshsales'],
  'Data & Databases': ['database', 'sql', 'nosql', 'mongodb', 'postgres', 'redis', 'supabase', 'fauna', 'planetscale', 'neo4j', 'elastic', 'data warehouse', 'snowflake', 'bigquery'],
  'DevOps & CI/CD': ['devops', 'ci/cd', 'deploy', 'jenkins', 'github actions', 'gitlab', 'circleci', 'terraform', 'ansible', 'monitoring', 'logging', 'observability', 'datadog', 'sentry', 'grafana', 'pagerduty'],
  'E-commerce': ['ecommerce', 'e-commerce', 'shop', 'store', 'cart', 'product', 'shopify', 'stripe', 'woocommerce', 'magento', 'bigcommerce', 'inventory', 'catalog', 'order'],
  'Education': ['education', 'learning', 'course', 'school', 'university', 'student', 'teach', 'lms', 'quiz', 'tutor', 'academic'],
  'Email': ['email', 'mail', 'smtp', 'inbox', 'sendgrid', 'mailgun', 'mailchimp', 'postmark', 'resend', 'ses', 'newsletter', 'transactional'],
  'Entertainment & Media': ['entertainment', 'media', 'movie', 'tv', 'imdb', 'tmdb', 'comic', 'anime', 'manga', 'podcast', 'radio', 'meme'],
  'File Storage': ['file', 'storage', 'upload', 'download', 's3', 'blob', 'drive', 'dropbox', 'box', 'cloudinary', 'uploadthing', 'backblaze'],
  'Food & Drink': ['food', 'recipe', 'restaurant', 'meal', 'nutrition', 'drink', 'beer', 'wine', 'cocktail', 'grocery', 'delivery', 'menu'],
  'Gaming': ['game', 'gaming', 'steam', 'xbox', 'playstation', 'twitch', 'discord', 'esport', 'leaderboard', 'achievement', 'riot', 'epic'],
  'Geolocation & Maps': ['geo', 'map', 'location', 'gps', 'geocod', 'mapbox', 'google maps', 'here', 'tomtom', 'openstreetmap', 'latitude', 'longitude', 'place', 'address', 'routing', 'directions'],
  'Government & Open Data': ['government', 'gov', 'open data', 'census', 'public', 'regulation', 'parliament', 'legislation', 'foia', 'transparency'],
  'Health & Fitness': ['health', 'medical', 'fitness', 'workout', 'exercise', 'hospital', 'pharma', 'drug', 'diagnosis', 'fhir', 'hl7', 'patient', 'wearable', 'fitbit'],
  'HR & Recruiting': ['hr', 'recruit', 'hiring', 'job', 'resume', 'payroll', 'employee', 'talent', 'greenhouse', 'lever', 'workday', 'bamboo', 'gusto', 'deel'],
  'IoT & Hardware': ['iot', 'hardware', 'sensor', 'device', 'arduino', 'raspberry', 'smart home', 'mqtt', 'embedded', 'firmware', 'zigbee'],
  'Legal & Compliance': ['legal', 'compliance', 'gdpr', 'privacy', 'terms', 'contract', 'signature', 'docusign', 'notary', 'kyc', 'aml', 'audit'],
  'Logistics & Shipping': ['logistics', 'shipping', 'delivery', 'tracking', 'freight', 'warehouse', 'fulfillment', 'fedex', 'ups', 'dhl', 'shippo', 'easypost', 'postage', 'parcel'],
  'Marketing & Ads': ['marketing', 'advertising', 'ads', 'seo', 'campaign', 'affiliate', 'google ads', 'facebook ads', 'conversion', 'landing page', 'ab test', 'retarget'],
  'Music & Audio': ['music', 'audio', 'spotify', 'soundcloud', 'song', 'playlist', 'lyrics', 'podcast', 'speech', 'voice', 'text-to-speech', 'transcription'],
  'News & Content': ['news', 'article', 'blog', 'content', 'rss', 'feed', 'headline', 'press', 'media', 'publish', 'cms', 'wordpress', 'contentful', 'sanity', 'strapi'],
  'Payments': ['payment', 'pay', 'billing', 'subscription', 'checkout', 'stripe', 'paypal', 'braintree', 'adyen', 'square', 'mollie', 'razorpay', 'invoice', 'charge'],
  'Productivity': ['productivity', 'task', 'project', 'todo', 'calendar', 'schedule', 'notion', 'trello', 'asana', 'jira', 'slack', 'teams', 'collaboration', 'workspace'],
  'Real Estate': ['real estate', 'property', 'housing', 'rent', 'mortgage', 'listing', 'zillow', 'mls', 'realtor', 'apartment'],
  'Science & Research': ['science', 'research', 'nasa', 'space', 'chemistry', 'physics', 'biology', 'genome', 'protein', 'arxiv', 'pubmed', 'scholarly'],
  'Search': ['search', 'find', 'index', 'elastic', 'algolia', 'meilisearch', 'typesense', 'solr', 'query', 'lookup', 'discovery'],
  'Security': ['security', 'firewall', 'threat', 'vulnerability', 'malware', 'virus', 'scan', 'penetration', 'encryption', 'ssl', 'certificate', 'waf', 'crowdstrike'],
  'SMS & Messaging': ['sms', 'messaging', 'text message', 'whatsapp', 'telegram', 'twilio', 'vonage', 'messagebird', 'bandwidth', 'sinch', 'push notification'],
  'Social Media': ['social', 'twitter', 'facebook', 'instagram', 'linkedin', 'tiktok', 'reddit', 'youtube', 'pinterest', 'mastodon', 'bluesky', 'threads', 'x.com'],
  'Sports': ['sport', 'football', 'soccer', 'basketball', 'baseball', 'nfl', 'nba', 'mlb', 'fifa', 'espn', 'score', 'league', 'team', 'player', 'fixture'],
  'Testing & Monitoring': ['test', 'monitor', 'uptime', 'load test', 'performance', 'synthetic', 'pingdom', 'statuspage', 'checkly', 'playwright', 'selenium', 'cypress', 'postman'],
  'Translation & Language': ['translat', 'language', 'locali', 'i18n', 'deepl', 'google translate', 'detect language', 'dictionary', 'thesaurus', 'spell check'],
  'Travel & Transportation': ['travel', 'flight', 'hotel', 'booking', 'airline', 'airport', 'transit', 'train', 'bus', 'uber', 'lyft', 'amadeus', 'skyscanner', 'tripadvisor', 'expedia'],
  'Video & Streaming': ['video', 'stream', 'youtube', 'vimeo', 'mux', 'cloudflare stream', 'wistia', 'loom', 'webinar', 'live stream', 'encoding', 'transcode'],
  'Weather': ['weather', 'forecast', 'temperature', 'climate', 'wind', 'rain', 'snow', 'humidity', 'storm', 'openweather', 'accuweather'],
};

export function matchesCategories(brand: { title: string; description: string | null; id: string }, categories: ApiCategory[]): boolean {
  if (categories.length === 0) return true;
  const text = `${brand.title} ${brand.description ?? ''} ${brand.id}`.toLowerCase();
  return categories.some(cat => {
    const keywords = CATEGORY_KEYWORDS[cat];
    return keywords.some(kw => text.includes(kw));
  });
}

interface CategoryFilterProps {
  selected: ApiCategory[];
  onChange: (categories: ApiCategory[]) => void;
}

export function CategoryFilter({ selected, onChange }: CategoryFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function toggle(cat: ApiCategory) {
    onChange(
      selected.includes(cat)
        ? selected.filter(c => c !== cat)
        : [...selected, cat]
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="h-12 px-8 bg-[var(--muted)] rounded-2xl flex items-center justify-center gap-2.5 text-[var(--foreground)]/60 text-sm font-medium tracking-[-0.2px] hover:text-[var(--foreground)]/80 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="16" y2="12" /><line x1="4" y1="18" x2="12" y2="18" />
        </svg>
        Categories
        {selected.length > 0 && (
          <span className="bg-[var(--accent)] text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">
            {selected.length}
          </span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-72 max-h-80 overflow-y-auto p-3 bg-[var(--background)] rounded-xl border border-[var(--border)] shadow-xl z-50">
          {selected.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-[var(--foreground)]/50 hover:text-[var(--foreground)] mb-2 pb-2 border-b border-[var(--border)] transition-colors"
            >
              <X className="w-3 h-3" />
              Clear all
            </button>
          )}
          <div className="flex flex-wrap gap-1.5">
            {API_CATEGORIES.map(cat => {
              const active = selected.includes(cat);
              return (
                <button
                  key={cat}
                  onClick={() => toggle(cat)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    active
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--muted)] text-[var(--foreground)]/70 hover:bg-[var(--muted)]/80 hover:text-[var(--foreground)]'
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
