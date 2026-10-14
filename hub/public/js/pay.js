/* Razorpay checkout for the shareable invoice page. */
(function () {
  'use strict';

  var btn = document.getElementById('pay-online');
  if (!btn) return;
  var csrf = document.querySelector('meta[name=csrf-token]').getAttribute('content');
  var status = document.getElementById('pay-status');

  function say(msg, isError) {
    if (!status) return;
    status.textContent = msg;
    status.className = 'small ' + (isError ? 'down' : 'muted');
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load the payment window. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }

  btn.addEventListener('click', function () {
    btn.disabled = true;
    say('Opening secure payment…');
    Promise.all([loadCheckout(), post(btn.getAttribute('data-order-url'))])
      .then(function (res) {
        var order = res[1];
        if (!order.ok) throw new Error(order.error || 'Could not start the payment.');
        var rzp = new window.Razorpay({
          key: order.key,
          amount: order.amount,
          currency: order.currency,
          name: order.name,
          description: order.description,
          order_id: order.order_id,
          prefill: order.prefill,
          theme: { color: '#007af5' },
          handler: function (resp) {
            say('Confirming your payment…');
            post(btn.getAttribute('data-verify-url'), resp).then(function (v) {
              if (v.ok) window.location.href = v.redirect;
              else { say(v.error, true); btn.disabled = false; }
            }, function () { say('Payment received — confirmation is delayed. Refresh in a minute.', true); });
          },
          modal: { ondismiss: function () { btn.disabled = false; say(''); } },
        });
        rzp.on('payment.failed', function (r) {
          say((r && r.error && r.error.description) || 'Payment failed. Please try again.', true);
          btn.disabled = false;
        });
        rzp.open();
      })
      .catch(function (err) { say(err.message, true); btn.disabled = false; });
  });
})();
