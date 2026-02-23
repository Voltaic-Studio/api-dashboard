import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

const APIS_GURU_URL = 'https://api.apis.guru/v2/list.json';
const OUTPUT_FILE = path.join(process.cwd(), 'src/data/apis.json');

interface ApiDefinition {
  added: string;
  preferred: string;
  versions: Record<string, {
    info: {
      title: string;
      description: string;
      version: string;
      contact?: {
        email?: string;
        name?: string;
        url?: string;
      };
      'x-logo'?: {
        url: string;
      };
    };
    swaggerUrl: string;
    swaggerYamlUrl: string;
    link: string;
  }>;
}

async function scrape() {
  console.log('🍎 Starting Apple API Market Scraper...');
  
  try {
    console.log(`fetching from ${APIS_GURU_URL}...`);
    const { data } = await axios.get<Record<string, ApiDefinition>>(APIS_GURU_URL);
    
    console.log(`Received ${Object.keys(data).length} APIs. Processing...`);

    const processed = Object.entries(data).map(([key, value]) => {
      const preferredVersion = value.versions[value.preferred];
      if (!preferredVersion) return null;

      return {
        id: key,
        title: preferredVersion.info.title,
        description: preferredVersion.info.description || 'No description available.',
        logo: preferredVersion.info['x-logo']?.url,
        swaggerUrl: preferredVersion.swaggerUrl,
        website: preferredVersion.info.contact?.url || preferredVersion.link,
        updated: value.added,
      };
    }).filter(Boolean);

    await fs.ensureDir(path.dirname(OUTPUT_FILE));
    await fs.writeJson(OUTPUT_FILE, processed, { spaces: 2 });

    console.log(`✅ Successfully saved ${processed.length} APIs to ${OUTPUT_FILE}`);
    
  } catch (error) {
    console.error('❌ Error scraping APIs:', error);
  }
}

scrape();
