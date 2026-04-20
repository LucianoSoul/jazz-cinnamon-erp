self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "NOVO PEDIDO",
    options: {
      body: "Abra o painel para ver os detalhes.",
      data: {
        url: "/painel_erp.html",
      },
    },
  };

  try {
    if (event.data) payload = event.data.json();
  } catch (error) {
    payload.options.body = event.data ? event.data.text() : payload.options.body;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "NOVO PEDIDO", payload.options || {})
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = data.url || "/painel_erp.html";

  event.waitUntil((async () => {
    const url = new URL(targetUrl, self.location.origin).href;
    const clientsList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    for (const client of clientsList) {
      if (!client.url.startsWith(self.location.origin)) continue;

      if ("navigate" in client) {
        await client.navigate(url);
      } else if (data.pedidoId) {
        client.postMessage({ type: "OPEN_PEDIDO", pedidoId: data.pedidoId });
      }

      if ("focus" in client) await client.focus();
      return;
    }

    await self.clients.openWindow(url);
  })());
});
