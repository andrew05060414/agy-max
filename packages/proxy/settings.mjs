export const PROXY_DEFAULTS = Object.freeze({
  proxyEnabled: false,
  proxyUrl: '',
  proxyBypass: 'localhost,127.0.0.1,::1,[::1]',
  proxyForceHttp1: false
});

export const PROXY_KEYS = Object.freeze(Object.keys(PROXY_DEFAULTS));
