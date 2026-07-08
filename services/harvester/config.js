import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  browser: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || null,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },

  concurrency: {
    pages: 3,
    sources: 2,
  },

  retry: {
    retries: 3,
    minTimeout: 1500,
    maxTimeout: 8000,
    factor: 2,
  },

  timeout: {
    navigation: 30_000,
    selector: 15_000,
  },

  output: {
    dir: path.resolve(__dirname, 'output'),
    file: 'editorials.json',
  },

  sources: {
    vajiram: {
      id: 'vajiram',
      name: 'Vajira Mandravi',
      url: 'https://vajiramandravi.com/current-affairs/daily-editorial-analysis/',
      enabled: true,
    },
    pw: {
      id: 'pw',
      name: 'PW OnlyIAS',
      url: 'https://pwonlyias.com/editorial-analysis/',
      enabled: true,
    },
    legacyias: {
      id: 'legacyias',
      name: 'Legacy IAS (PIB Summary)',
      url: 'https://www.legacyias.com/current-affairs-datewise/daily-pib-summaries/',
      enabled: true,
    },
    greaterkashmir: {
      id: 'greaterkashmir',
      name: 'Greater Kashmir (Opinion)',
      opinionUrl: 'https://www.greaterkashmir.com/opinion',
      enabled: true,
    },
  },

  getHarvestDate: () => new Date().toISOString().split('T')[0],
};

export default config;
