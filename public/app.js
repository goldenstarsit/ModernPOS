const dateElement = document.querySelector("#currentDate");
const pageTitle = document.querySelector("#pageTitle");
const welcomeTitle = document.querySelector("#welcomeTitle");
const messageElement = document.querySelector("#appMessage");
const searchInput = document.querySelector("#salesSearch");
const salesRows = [...document.querySelectorAll("#salesTableBody tr")];
const salesCount = document.querySelector("#salesCount");
const emptySearch = document.querySelector("#emptySearch");

const dashboardView = document.querySelector("#dashboardView");
const productsView = document.querySelector("#productsView");
const productSearch = document.querySelector("#productSearch");
const productsState = document.querySelector("#productsState");
const productsTableScroll = document.querySelector("#productsTableScroll");
const productsTableBody = document.querySelector("#productsTableBody");
const productsCount = document.querySelector("#productsCount");

if (dateElement) {
  dateElement.textContent = new Intl.DateTimeFormat("en-PK", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date());
}

let messageTimeout;
let productsController;

function showMessage(message) {
  if (!messageElement) return;

  messageElement.textContent = message;
  messageElement.hidden = false;

  clearTimeout(messageTimeout);
  messageTimeout = setTimeout(() => {
    messageElement.hidden = true;
  }, 4500);
}

function setProductsState(message, isError = false) {
  if (!productsState) return;

  productsState.textContent = message;
  productsState.classList.toggle("products-error", isError);
  productsState.hidden = false;

  if (productsTableScroll) productsTableScroll.hidden = true;
}

function formatRupees(paisa) {
  const amount = Number(paisa);
  if (!Number.isSafeInteger(amount) || amount < 0) return "—";

  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount / 100);
}

function appendCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === "" ? "—" : String(value);
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderProducts(products) {
  productsTableBody.replaceChildren();

  for (const product of products) {
    const row = document.createElement("tr");
    appendCell(row, product.sku);
    appendCell(row, product.name);
    appendCell(row, product.unit);

    appendCell(row, formatRupees(product.cost_price_paisa), "amount");
    appendCell(row, formatRupees(product.sale_price_paisa), "amount");

    const active = product.is_active === true || Number(product.is_active) === 1;
    const statusCell = appendCell(row, active ? "Active" : "Inactive");
    const status = document.createElement("span");
    status.className = `product-status ${active ? "product-active" : "product-inactive"}`;
    status.textContent = active ? "Active" : "Inactive";
    statusCell.replaceChildren(status);

    productsTableBody.append(row);
  }
}

async function loadProducts(query = "") {
  if (!productsState || !productsTableBody || !productsCount) return;

  if (productsController) productsController.abort();
  const controller = new AbortController();
  productsController = controller;

  setProductsState("Loading products...");
  productsCount.textContent = "Loading...";

  const params = new URLSearchParams({ limit: "50", offset: "0" });
  if (query) params.set("q", query);

  try {
    const response = await fetch(`/api/products?${params}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("The server returned an invalid response.");
    }

    if (!response.ok) {
      throw new Error(
        result?.error?.message || `Unable to load products (HTTP ${response.status}).`
      );
    }

    if (!Array.isArray(result.data) || !result.pagination) {
      throw new Error("The server returned an unexpected product list.");
    }

    if (controller.signal.aborted) return;

    renderProducts(result.data);
    productsCount.textContent =
      `Showing ${result.data.length} of ${result.pagination.total} products`;

    if (result.data.length === 0) {
      setProductsState(
        query ? "No products match your search." : "No products found. Add a product in a future step."
      );
      return;
    }

    productsState.hidden = true;
    productsState.classList.remove("products-error");
    productsTableScroll.hidden = false;
  } catch (error) {
    if (error.name === "AbortError") return;

    setProductsState(
      `${error.message || "Unable to load products."} Check the server and try again.`,
      true
    );
    productsCount.textContent = "Product data unavailable.";
  }
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;

    document.querySelectorAll("[data-view]").forEach((item) => {
      const isActive = item === button;
      item.classList.toggle("active", isActive);
      if (isActive) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });

    if (pageTitle) pageTitle.textContent = view;

    const isProducts = view === "Products";
    if (dashboardView) dashboardView.hidden = isProducts;
    if (productsView) productsView.hidden = !isProducts;

    if (isProducts) {
      if (welcomeTitle) welcomeTitle.textContent = "Products";
      loadProducts(productSearch?.value.trim() || "");
      return;
    }

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

    if (action === "Add product") {
      document.querySelector('[data-view="Products"]')?.click();
      showMessage("Product creation will be implemented in a future lesson.");
      return;
    }

    showMessage(
      `${action}: this feature will be implemented in a future lesson. No records were changed.`
    );
  });
});

if (productSearch) {
  productSearch.addEventListener("input", () => {
    if (productsView && !productsView.hidden) {
      loadProducts(productSearch.value.trim());
    }
  });
}

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
