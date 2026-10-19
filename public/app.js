const dateElement = document.querySelector("#currentDate");
const pageTitle = document.querySelector("#pageTitle");
const welcomeTitle = document.querySelector("#welcomeTitle");
const messageElement = document.querySelector("#appMessage");
const searchInput = document.querySelector("#salesSearch");
const salesRows = [...document.querySelectorAll("#salesTableBody tr")];
const salesCount = document.querySelector("#salesCount");
const emptySearch = document.querySelector("#emptySearch");

if (dateElement) {
  dateElement.textContent = new Intl.DateTimeFormat("en-PK", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date());
}

let messageTimeout;

function showMessage(message) {
  if (!messageElement) return;

  messageElement.textContent = message;
  messageElement.hidden = false;

  clearTimeout(messageTimeout);
  messageTimeout = setTimeout(() => {
    messageElement.hidden = true;
  }, 4500);
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;

    document.querySelectorAll("[data-view]").forEach((item) => {
      const isActive = item === button;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-current", isActive ? "page" : "false");
    });

    if (pageTitle) pageTitle.textContent = view;
    if (welcomeTitle) {
      welcomeTitle.textContent =
        view === "Dashboard" ? "Good day, welcome back." : view;
    }

    if (view === "Dashboard") {
      showMessage("You are viewing the ModernPOS dashboard.");
    } else {
      showMessage(
        `${view} is planned for a future lesson. No business data has been changed.`
      );
    }
  });
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    showMessage(
      `${action}: this feature will be implemented in a future lesson. No records were changed.`
    );
  });
});

if (searchInput) {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    let visibleCount = 0;

    salesRows.forEach((row) => {
      const searchableText = `${row.textContent} ${row.dataset.search || ""}`
        .toLowerCase();
      const matches = searchableText.includes(query);

      row.hidden = !matches;
      if (matches) visibleCount += 1;
    });

    if (salesCount) {
      salesCount.textContent =
        `Showing ${visibleCount} of ${salesRows.length} sample transactions`;
    }

    if (emptySearch) emptySearch.hidden = visibleCount !== 0;
  });
}
