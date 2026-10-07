const preload = '--require=' + JSON.stringify(__filename);
if (!(process.env.NODE_OPTIONS || '').includes(__filename)) process.env.NODE_OPTIONS = ((process.env.NODE_OPTIONS || '') + ' ' + preload).trim();
const fixtures = require('./fixtures.cjs');
const store = require('../../lib/store');
const init = store.Store.prototype.init;
store.Store.prototype.seedAudience = fixtures.seedAudience;
store.Store.prototype.init = function() { const first = !this.b; init.call(this); if (first && !this.getAudience().length && this.getMeta('test_fixture_initialized') !== '1') { fixtures.seedAudience.call(this); this.setMeta('test_fixture_initialized', '1'); } };
const connectors = require('../../lib/storeConnector');
connectors.MockConnector = fixtures.MockConnector;
const create = connectors.createConnector;
connectors.createConnector = spec => spec?.type === 'mock' ? new fixtures.MockConnector(spec) : create(spec);
connectors.buildConnectors = config => {
 const specs = [...(config?.shopify?.shopDomain && config.shopify.accessToken ? [{type:'shopify', ...config.shopify}] : []), ...(config?.stores || [])];
 const all = specs.map(connectors.createConnector);
 return all.length > 1 ? new connectors.MultiStoreConnector(all) : all[0] || null;
};
const config = require('../../lib/config');
const load = config.load;
config.load = () => {
 // Explicitly empty credentials continue exercising unconfigured-provider errors.
 const raw = require('node:fs').existsSync(config.CONFIG_FILE) ? JSON.parse(require('node:fs').readFileSync(config.CONFIG_FILE,'utf8')) : {};
 const cfg = load();
 if (raw.stores) cfg.stores = raw.stores;
 if (!Object.hasOwn(raw,'espKey')) cfg.espKey = 'isolated-test-key';
 if (!Object.hasOwn(raw,'espFrom')) cfg.espFrom = 'sender@example.com';
 if (!Object.hasOwn(raw,'espApiUrl')) cfg.espApiUrl = 'https://isolated-esp.test/emails';
 cfg.shopCartUrl ||= 'https://shop.test/cart';
 return cfg;
};
const fetch = global.fetch;
global.fetch = async (url, options) => {
 if (String(url).startsWith('https://isolated-esp.test/')) {
  const body = JSON.parse(options.body);
  return Response.json(Array.isArray(body) ? body.map((_,i)=>({id:'isolated-'+i})) : {id:'isolated-0'});
 }
 return fetch(url,options);
};
