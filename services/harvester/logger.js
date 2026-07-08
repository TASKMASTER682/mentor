const COLORS = {
  reset:  '\x1b[0m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  dim:    '\x1b[2m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, msg) {
  const ts = COLORS.dim + timestamp() + COLORS.reset;
  console.log(`${ts} ${level} ${msg}`);
}

const logger = {
  info:  (m) => log(COLORS.cyan   + '[INFO   ]' + COLORS.reset, m),
  warn:  (m) => log(COLORS.yellow  + '[WARN   ]' + COLORS.reset, m),
  error: (m) => log(COLORS.red     + '[ERROR  ]' + COLORS.reset, m),
  success: (m) => log(COLORS.green + '[SUCCESS]' + COLORS.reset, m),

  article(action, title, url) {
    log('info', `${action.padEnd(10)} \u2502 ${(title || '').slice(0, 60)} \u2502 ${url}`);
  },

  debug(m) {
    if (process.env.DEBUG) log(COLORS.dim + '[DEBUG  ]' + COLORS.reset, m);
  },

  divider() {
    const line = '\u2500'.repeat(80);
    console.log(COLORS.dim + line + COLORS.reset);
  },

  summary(obj) {
    this.divider();
    console.log('\uD83D\uDCCA HARVEST SUMMARY');
    for (const [k, v] of Object.entries(obj)) {
      console.log(`  ${k.padEnd(22)}: ${v}`);
    }
    this.divider();
  },
};

export default logger;
