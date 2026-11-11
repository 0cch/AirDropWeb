import crypto from 'crypto';

export const DEFAULT_STUN_URLS = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.qq.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302'
];

function envList(value, fallback = []) {
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function positiveInt(value, fallback, min = 1) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function getTurnConfiguration(env = process.env) {
  return {
    stunUrls: envList(env.STUN_URLS, DEFAULT_STUN_URLS),
    turnUrls: envList(env.TURN_URLS),
    secret: env.TURN_SECRET || '',
    username: env.TURN_USERNAME || '',
    credential: env.TURN_CREDENTIAL || '',
    ttlSeconds: positiveInt(env.TURN_TTL_SECONDS, 3600, 60),
    required: env.TURN_REQUIRED === '1'
  };
}

export function validateTurnConfiguration(config) {
  const warnings = [];
  const errors = [];
  const invalidUrls = config.turnUrls.filter((url) => !/^turns?:/i.test(url));
  if (invalidUrls.length > 0) errors.push(`TURN_URLS 包含无效地址: ${invalidUrls.join(', ')}`);
  if (config.turnUrls.length === 0 && config.secret) warnings.push('已配置 TURN_SECRET，但未配置 TURN_URLS');
  if (config.turnUrls.length > 0 && !config.secret && !(config.username && config.credential)) {
    errors.push('配置 TURN_URLS 时必须提供 TURN_SECRET 或固定用户名/密码');
  }
  if (config.secret && (config.username || config.credential)) {
    warnings.push('同时配置了短期 TURN 密钥和固定凭据，将优先使用短期凭据');
  }
  if (config.required && config.turnUrls.length === 0) errors.push('TURN_REQUIRED=1，但未配置 TURN_URLS');
  return {
    enabled: config.turnUrls.length > 0 && (Boolean(config.secret) || Boolean(config.username && config.credential)),
    errors,
    warnings
  };
}

export function createIceServers(config = getTurnConfiguration(), nowSeconds = Math.floor(Date.now() / 1000)) {
  const servers = [];
  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls });
  if (!config.turnUrls.length) return servers;

  if (config.secret) {
    const username = `${nowSeconds + config.ttlSeconds}:airdropweb`;
    const credential = crypto.createHmac('sha1', config.secret).update(username).digest('base64');
    servers.push({ urls: config.turnUrls, username, credential });
  } else if (config.username && config.credential) {
    servers.push({ urls: config.turnUrls, username: config.username, credential: config.credential });
  }
  return servers;
}