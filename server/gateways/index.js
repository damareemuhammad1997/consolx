/* Payment gateways. Each one: { key, name, configured(), instructions(invoice, settings) } and, for online
   gateways, createPayment(invoice) -> { redirectUrl } plus a webhook route that calls billing.markPaid(id, ref, key).
   'manual' is the only one live: the invoice shows the bank details and the administrator marks it paid.
   To add PayPal: implement createPayment with the Orders API (server-side capture), set PAYPAL_CLIENT_ID /
   PAYPAL_CLIENT_SECRET on the service, and register its webhook; nothing else in billing changes. */
const manual = {
  key: 'manual',
  name: 'Bank transfer (manual)',
  online: false,
  configured: () => true,
  instructions: (inv, s) => s.payment_instructions || '',
};
const paypal = {
  key: 'paypal',
  name: 'PayPal',
  online: true,
  configured: () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
  instructions: () => 'Pay online with PayPal (coming soon).',
  createPayment: async () => { throw Object.assign(new Error('PayPal is not connected yet.'), { status: 501 }); },
};
const all = [manual, paypal];
module.exports = { list: () => all.map(g => ({ key: g.key, name: g.name, online: g.online, configured: g.configured() })), get: k => all.find(g => g.key === k) || null };
