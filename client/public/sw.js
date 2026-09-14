self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;

  try {
    data = event.data.json();
  } catch {
    data = {
      title: "Our Little Corner ❤️",
      body: "You have a new message",
      url: "/"
    };
  }

  const title =
    data.title ||
    "Our Little Corner ❤️";

  const options = {
    body:
      data.body ||
      "You have a new message",

    icon:
      data.icon ||
      "/favicon.ico",

    badge:
      "/favicon.ico",

    data: {
      url:
        data.url ||
        "/"
    }
  };

  event.waitUntil(
    self.registration.showNotification(
      title,
      options
    )
  );
});


self.addEventListener(
  "notificationclick",
  (event) => {

    event.notification.close();

    const url =
      event.notification.data?.url ||
      "/";

    event.waitUntil(
      clients
        .matchAll({
          type: "window",
          includeUncontrolled: true
        })
        .then((clientList) => {

          for (const client of clientList) {

            if ("focus" in client) {

              client.focus();

              return client.navigate(
                url
              );

            }

          }

          if (clients.openWindow) {
            return clients.openWindow(
              url
            );
          }

        })
    );

  }
);
