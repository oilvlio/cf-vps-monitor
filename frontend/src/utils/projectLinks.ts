export const CF_MONITOR_REPOSITORY = 'kadidalax/cf-vps-monitor';
export const CF_MONITOR_GITHUB_URL = `https://github.com/${CF_MONITOR_REPOSITORY}`;
declare const __AGENT_REPOSITORY__: string;
export const CF_MONITOR_AGENT_REPOSITORY = typeof __AGENT_REPOSITORY__ === 'string'
  ? __AGENT_REPOSITORY__ : 'oilvlio/cf-vps-monitor';
