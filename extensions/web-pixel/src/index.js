export default {
  async runtime({ analytics, settings }) {
    const host = settings.apiHost;
    const shop = analytics.shop?.permanentDomain;

    const forward = (name, payload = {}) => {
      const ts = Date.now();
      const ev = {
        event: name,
        ts,
        event_id: `${payload.event_id || ts}-${Math.random()}`,
        shop_domain: shop,
        payload,
      };
      fetch(`${host}/collect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ev),
        keepalive: true,
      });
    };

    analytics.subscribe('checkout_started', (e) => forward('checkout_started', e?.data));
    analytics.subscribe('purchase', (e) => forward('purchase', e?.data));
  },
};
