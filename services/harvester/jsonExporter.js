import fs from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';

const OUTPUT_FILE = path.join(config.output.dir, config.output.file);

export async function saveJson(articles, generationDate) {
  await fs.mkdir(config.output.dir, { recursive: true });

  const payload = {
    generation_date:        generationDate,
    total_harvested_items:  articles.length,
    articles,
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return OUTPUT_FILE;
}

export async function loadJson() {
  try {
    const raw = await fs.readFile(OUTPUT_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getOutputPath() {
  return OUTPUT_FILE;
}
