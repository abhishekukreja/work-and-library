(() => {
  const STORAGE_KEY = "ak-work-items";
  const CATEGORIES_KEY = "ak-work-categories";
  const CATEGORY_ORDER_KEY = "ak-work-category-order";
  const UPDATED_AT_KEY = "ak-work-updated-at";
  const URGENCY_ORDER = { Urgent: 0, Pending: 1, Pipeline: 2 };
  const GIST_ID = "68a30415ea2c24f7bb8c0dc13fd4f7e5";
  const NTFY_TOPIC = "ak-desk-abhishekukreja-9f2c4b71e8a04d6c";
  const NTFY_URL = `https://ntfy.sh/${NTFY_TOPIC}`;
  const GIST_RAW = `https://gist.githubusercontent.com/abhishekukreja/${GIST_ID}/raw/desk.json`;

  const deskListeners = [];
  const subscribeDesk = (fn) => {
    deskListeners.push(fn);
  };
  const emitDesk = () => {
    deskListeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* page section not ready */
      }
    });
  };

  let applyingRemote = false;
  let pushTimer = 0;
  let lastPushedAt = 0;

  const readJson = (raw, fallback) => {
    try {
      const parsed = raw ? JSON.parse(raw) : fallback;
      return parsed;
    } catch {
      return fallback;
    }
  };

  const loadItems = () => {
    const parsed = readJson(localStorage.getItem(STORAGE_KEY), []);
    return Array.isArray(parsed) ? parsed : [];
  };

  const loadCustomCategories = () => {
    const parsed = readJson(localStorage.getItem(CATEGORIES_KEY), []);
    return Array.isArray(parsed) ? parsed.filter((name) => String(name).trim()) : [];
  };

  const loadCategoryOrder = () => {
    const parsed = readJson(localStorage.getItem(CATEGORY_ORDER_KEY), null);
    return Array.isArray(parsed) ? parsed.filter((name) => String(name).trim()) : null;
  };

  const loadUpdatedAt = () => Number(localStorage.getItem(UPDATED_AT_KEY)) || 0;

  const parseDesk = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (!Array.isArray(value.items)) return null;
    return {
      items: value.items,
      categoryOrder: Array.isArray(value.categoryOrder) ? value.categoryOrder : [],
      updatedAt: Number(value.updatedAt) || 0,
    };
  };

  const localDesk = () => ({
    items: loadItems(),
    categoryOrder: loadCategoryOrder() || [],
    updatedAt: loadUpdatedAt(),
  });

  const applyDesk = (desk) => {
    const next = parseDesk(desk);
    if (!next) return;
    applyingRemote = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.items));
    localStorage.setItem(CATEGORY_ORDER_KEY, JSON.stringify(next.categoryOrder));
    localStorage.setItem(UPDATED_AT_KEY, String(next.updatedAt));
    applyingRemote = false;
    emitDesk();
  };

  const touchDesk = () => {
    if (applyingRemote) return;
    localStorage.setItem(UPDATED_AT_KEY, String(Date.now()));
    window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(pushDesk, 350);
  };

  const saveItems = (items) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    touchDesk();
  };

  const saveCategoryOrder = (categories) => {
    localStorage.setItem(CATEGORY_ORDER_KEY, JSON.stringify(categories));
    touchDesk();
  };

  const parseNtfyPayload = (raw) => {
    if (!raw) return null;
    try {
      const row = JSON.parse(raw);
      const message = typeof row.message === "string" ? row.message : raw;
      return parseDesk(JSON.parse(message));
    } catch {
      return parseDesk(readJson(raw, null));
    }
  };

  const hasDeskData = (desk) =>
    Boolean(desk && (desk.updatedAt || desk.items.length || desk.categoryOrder.length));

  const newestDesk = (...candidates) =>
    candidates
      .map(parseDesk)
      .filter(hasDeskData)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;

  const fetchGistDesk = async () => {
    try {
      const res = await fetch(`https://api.github.com/gists/${GIST_ID}?t=${Date.now()}`, {
        cache: "no-store",
        headers: { Accept: "application/vnd.github+json" },
      });
      if (res.ok) {
        const data = await res.json();
        const desk = parseDesk(JSON.parse(data.files?.["desk.json"]?.content || "null"));
        if (hasDeskData(desk)) return desk;
      }
    } catch {
      /* try raw next */
    }
    const res = await fetch(`${GIST_RAW}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return parseDesk(await res.json());
  };

  const fetchPagesDesk = async () => {
    const res = await fetch(`desk.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return parseDesk(await res.json());
  };

  const fetchNtfyDesk = async () => {
    const res = await fetch(`${NTFY_URL}/json?poll=1&since=all`, { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    let latest = null;
    text.split("\n").forEach((line) => {
      const desk = parseNtfyPayload(line);
      if (!desk) return;
      if (!latest || desk.updatedAt >= latest.updatedAt) latest = desk;
    });
    return latest;
  };

  const pushDesk = async () => {
    const desk = localDesk();
    if (!desk.updatedAt || desk.updatedAt === lastPushedAt) return;
    lastPushedAt = desk.updatedAt;
    const body = JSON.stringify(desk);
    try {
      await fetch(NTFY_URL, {
        method: "POST",
        headers: { Title: "desk", Priority: "min" },
        body,
      });
    } catch {
      lastPushedAt = 0;
    }
  };

  const mergeDesk = (a, b) => {
    const byId = new Map();
    [...(a?.items || []), ...(b?.items || [])].forEach((item) => {
      if (item?.id) byId.set(item.id, item);
    });
    const order = a?.categoryOrder?.length ? a.categoryOrder : b?.categoryOrder || [];
    return {
      items: [...byId.values()],
      categoryOrder: order,
      updatedAt: Date.now(),
    };
  };

  const pullDesk = async () => {
    const local = localDesk();
    const remote = newestDesk(
      ...(await Promise.all([
        fetchGistDesk().catch(() => null),
        fetchNtfyDesk().catch(() => null),
        fetchPagesDesk().catch(() => null),
      ]))
    );

    const hasLocal = Boolean(local.items.length || local.categoryOrder.length);
    if (!remote) {
      if (hasLocal) {
        if (!local.updatedAt) localStorage.setItem(UPDATED_AT_KEY, String(Date.now()));
        await pushDesk();
      }
      return;
    }

    if (!local.updatedAt && hasLocal) {
      const merged = mergeDesk(local, remote);
      lastPushedAt = 0;
      applyDesk(merged);
      await pushDesk();
      return;
    }

    if (local.updatedAt > remote.updatedAt) {
      await pushDesk();
      return;
    }

    if (remote.updatedAt > local.updatedAt) {
      lastPushedAt = remote.updatedAt;
      applyDesk(remote);
    }
  };

  const startDeskSync = () => {
    pullDesk();
    window.setInterval(pullDesk, 8000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pullDesk();
    });
    window.addEventListener("focus", pullDesk);

    try {
      const stream = new EventSource(`${NTFY_URL}/sse`);
      stream.addEventListener("message", (event) => {
        const desk = parseNtfyPayload(event.data);
        if (!desk || desk.updatedAt <= loadUpdatedAt()) return;
        lastPushedAt = desk.updatedAt;
        applyDesk(desk);
      });
    } catch {
      /* polling still runs */
    }
  };

  const patchItem = (id, patch) => {
    saveItems(
      loadItems().map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const deleteItem = (id) => {
    saveItems(loadItems().filter((item) => item.id !== id));
  };

  const makeTaskActions = (item, { onDone, onRemove }) => {
    const wrap = document.createElement("span");
    wrap.className = "task-actions";

    const done = document.createElement("button");
    done.type = "button";
    done.className = "task-link";
    done.textContent = "done";
    done.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onDone();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "task-link";
    remove.textContent = "remove";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove();
    });

    wrap.append(done, remove);
    return wrap;
  };

  const enableScrollHints = (el) => {
    if (!el || el.dataset.scrollHint === "1") return;
    el.dataset.scrollHint = "1";
    let timer = 0;
    el.addEventListener("scroll", () => {
      el.classList.add("is-scrolling");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        el.classList.remove("is-scrolling");
      }, 450);
    });
  };

  const formatDate = (value) => {
    if (!value) return "—";
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  const todayISO = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const toISODate = (year, monthIndex, day) => {
    const month = String(monthIndex + 1).padStart(2, "0");
    const date = String(day).padStart(2, "0");
    return `${year}-${month}-${date}`;
  };

  const parseISODate = (value) => {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return {
      year: Number(match[1]),
      monthIndex: Number(match[2]) - 1,
      day: Number(match[3]),
    };
  };

  const monthLabel = (year, monthIndex) =>
    new Date(year, monthIndex, 1).toLocaleDateString("en-GB", {
      month: "long",
      year: "numeric",
    });

  const calendarEl = document.getElementById("date-calendar");
  const calendarLabel = document.getElementById("date-calendar-label");
  const calendarGrid = document.getElementById("date-calendar-grid");
  let calendarTarget = null;
  let viewYear = new Date().getFullYear();
  let viewMonth = new Date().getMonth();

  const setDateControlValue = (control, value) => {
    if (!control) return;
    control.dataset.value = value || "";
    control.value = value || "";
    const label = control.querySelector("[data-date-label]");
    if (label) {
      label.textContent = value ? formatDate(value) : "Pick a date";
    }
  };

  const getDateControlValue = (control) =>
    control?.dataset.value || control?.value || "";

  const isCalendarOpen = () =>
    Boolean(
      calendarEl &&
        (calendarEl.matches(":popover-open") || calendarEl.dataset.open === "1")
    );

  const closeCalendar = () => {
    if (!calendarEl) return;
    if (typeof calendarEl.hidePopover === "function") {
      try {
        if (calendarEl.matches(":popover-open")) calendarEl.hidePopover();
      } catch {
        /* already closed */
      }
    }
    calendarEl.hidden = true;
    calendarEl.dataset.open = "0";
    calendarTarget = null;
  };

  const showCalendarLayer = () => {
    calendarEl.hidden = false;
    calendarEl.dataset.open = "1";
    const host = document.querySelector("dialog[open]") || document.body;
    if (calendarEl.parentElement !== host) {
      host.appendChild(calendarEl);
    }
  };

  const placeCalendar = (anchor) => {
    if (!calendarEl || !anchor) return;
    showCalendarLayer();
    const rect = anchor.getBoundingClientRect();
    const width = calendarEl.offsetWidth || 16.5 * 16;
    const height = calendarEl.offsetHeight || 18 * 16;
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + width > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - width - 12);
    }
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 8);
    }
    calendarEl.style.position = "fixed";
    calendarEl.style.left = `${left}px`;
    calendarEl.style.top = `${top}px`;
  };

  const chooseCalendarDate = (iso) => {
    if (!calendarTarget) return;
    const control = calendarTarget;
    setDateControlValue(control, iso);
    control.dispatchEvent(new Event("change", { bubbles: true }));
    closeCalendar();
  };

  const renderCalendarGrid = () => {
    if (!calendarGrid || !calendarLabel) return;
    calendarLabel.textContent = monthLabel(viewYear, viewMonth);

    const firstDay = new Date(viewYear, viewMonth, 1);
    const startOffset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const selected = getDateControlValue(calendarTarget);
    const today = todayISO();

    const nodes = [];
    for (let i = 0; i < startOffset; i += 1) {
      const blank = document.createElement("span");
      blank.className = "date-calendar__blank";
      nodes.push(blank);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = toISODate(viewYear, viewMonth, day);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "date-calendar__day";
      button.textContent = String(day);
      if (iso === today) button.classList.add("is-today");
      if (iso === selected) button.classList.add("is-selected");
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        chooseCalendarDate(iso);
      });
      nodes.push(button);
    }

    calendarGrid.replaceChildren(...nodes);
  };

  const openCalendarFor = (control) => {
    if (!calendarEl || !control) return;
    calendarTarget = control;
    const now = new Date();
    // Always open on the current year and month.
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
    renderCalendarGrid();
    placeCalendar(control);
  };

  if (calendarEl) {
    calendarEl.querySelector("[data-cal-prev]")?.addEventListener("click", () => {
      viewMonth -= 1;
      if (viewMonth < 0) {
        viewMonth = 11;
        viewYear -= 1;
      }
      renderCalendarGrid();
    });
    calendarEl.querySelector("[data-cal-next]")?.addEventListener("click", () => {
      viewMonth += 1;
      if (viewMonth > 11) {
        viewMonth = 0;
        viewYear += 1;
      }
      renderCalendarGrid();
    });
    calendarEl.querySelector("[data-cal-today]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const now = new Date();
      viewYear = now.getFullYear();
      viewMonth = now.getMonth();
      chooseCalendarDate(todayISO());
    });
    calendarEl.querySelector("[data-cal-clear]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      chooseCalendarDate("");
    });

    calendarEl.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    document.addEventListener("pointerdown", (event) => {
      if (!isCalendarOpen()) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.includes(calendarEl) || calendarEl.contains(event.target)) return;
      if (calendarTarget && (path.includes(calendarTarget) || calendarTarget.contains(event.target))) return;
      closeCalendar();
    });
  }

  const bindDateInput = (control, { preferToday = false } = {}) => {
    if (!control) return;

    if (preferToday && !getDateControlValue(control)) {
      setDateControlValue(control, todayISO());
    } else {
      setDateControlValue(control, getDateControlValue(control));
    }

    if (control.dataset.dateBound === "1") return;
    control.dataset.dateBound = "1";

    control.addEventListener("click", (event) => {
      event.preventDefault();
      openCalendarFor(control);
    });
  };

  const createDateTrigger = (value = "", { preferToday = false } = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "date-trigger work-row__date";
    button.name = "due";
    button.innerHTML = `<span data-date-label>Pick a date</span>`;
    const initial = value || (preferToday ? todayISO() : "");
    setDateControlValue(button, initial);
    bindDateInput(button, { preferToday: false });
    return button;
  };

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const normalize = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/['’]/g, "'");

  const sortTasks = (items) =>
    [...items].sort((a, b) => {
      const doneDiff = Number(Boolean(a.done)) - Number(Boolean(b.done));
      if (doneDiff !== 0) return doneDiff;
      const aDate = a.due || "9999-12-31";
      const bDate = b.due || "9999-12-31";
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return (URGENCY_ORDER[a.urgency] ?? 99) - (URGENCY_ORDER[b.urgency] ?? 99);
    });

  const openDialog = (dialog) => {
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  };

  const closeDialog = (dialog) => {
    closeCalendar();
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  const makeReadRow = (item, { onOpen, onChanged } = {}) => {
    const row = document.createElement("div");
    row.className = `work-row work-row--read work-row--${String(item.urgency || "pending").toLowerCase()}${item.done ? " is-done" : ""}`;
    row.dataset.workId = item.id;
    row.innerHTML = `
      <span class="work-row__title">${escapeHtml(item.name)}</span>
      <span class="work-row__status">${escapeHtml(item.urgency || "—")}</span>
      <span class="work-row__date">${escapeHtml(formatDate(item.due))}</span>
      <span class="work-row__remark">${escapeHtml(item.remark || "—")}</span>
    `;
    row.append(
      makeTaskActions(item, {
        onDone: () => {
          patchItem(item.id, { done: !item.done });
          onChanged?.();
        },
        onRemove: () => {
          deleteItem(item.id);
          onChanged?.();
        },
      })
    );
    row.addEventListener("click", (event) => {
      if (event.target.closest(".task-actions")) return;
      onOpen?.();
    });
    return row;
  };

  const makeEditableRow = (item, category, onChange, { showCategory = false } = {}) => {
    const row = document.createElement("div");
    const urgency = item?.urgency || "Pending";
    const isNew = !item?.id;
    row.className = `work-row work-row--edit work-row--${urgency.toLowerCase()}${isNew ? " work-row--new" : ""}`;
    if (item?.id) row.dataset.workId = item.id;

    row.innerHTML = `
      <input class="work-row__title" type="text" name="name" placeholder="Work title" value="${escapeHtml(item?.name || "")}" />
      ${
        showCategory
          ? `<input class="work-row__cat" type="text" name="category" list="home-work-categories" placeholder="Category" value="${escapeHtml(item?.category || category || "")}" autocomplete="off" />`
          : ""
      }
      <select class="work-row__status" name="urgency" aria-label="How soon">
        <option value="Urgent"${urgency === "Urgent" ? " selected" : ""}>Urgent</option>
        <option value="Pending"${urgency === "Pending" ? " selected" : ""}>Pending</option>
        <option value="Pipeline"${urgency === "Pipeline" ? " selected" : ""}>Pipeline</option>
      </select>
      <input class="work-row__remark" type="text" name="remark" placeholder="Remark" value="${escapeHtml(item?.remark || "")}" />
    `;

    const dateTrigger = createDateTrigger(item?.due || "", { preferToday: isNew });
    row.insertBefore(dateTrigger, row.querySelector('[name="remark"]'));

    const readValues = () => ({
      name: row.querySelector('[name="name"]').value.trim(),
      urgency: row.querySelector('[name="urgency"]').value,
      due: getDateControlValue(row.querySelector('[name="due"]')),
      remark: row.querySelector('[name="remark"]').value.trim(),
      category:
        row.querySelector('[name="category"]')?.value.trim() || category,
    });

    const syncTone = () => {
      row.classList.remove("work-row--urgent", "work-row--pending", "work-row--pipeline");
      row.classList.add(`work-row--${readValues().urgency.toLowerCase()}`);
    };

    row.querySelector('[name="urgency"]').addEventListener("change", syncTone);

    const commit = () => {
      const values = readValues();
      if (!values.name) return;
      onChange(values, item?.id || null, row);
    };

    row.querySelectorAll("input, select").forEach((field) => {
      field.addEventListener("change", commit);
      if (field.tagName === "INPUT") {
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        });
      }
    });
    dateTrigger.addEventListener("change", commit);

    queueMicrotask(() => {
      const nameField = row.querySelector('[name="name"]');
      if (nameField) nameField.focus();
    });

    return row;
  };

  const makeAddPlaceholder = (onActivate) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "work-row work-row--new work-row--add";
    row.innerHTML = `
      <span class="work-row__title work-row__hint">Add new work</span>
      <span></span>
      <span></span>
      <span></span>
    `;
    row.addEventListener("click", onActivate);
    return row;
  };

  /* ——— Home ——— */

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const home = document.querySelector(".home-split");

  if (home && !reduce) {
    home.querySelectorAll(".home-panel").forEach((panel) => {
      panel.addEventListener("pointermove", (event) => {
        const rect = panel.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width - 0.5) * 8;
        const y = ((event.clientY - rect.top) / rect.height - 0.5) * 8;
        const veil = panel.querySelector(".home-panel__veil");
        if (veil) {
          veil.style.transform = `scale(1.08) translate(${x}px, ${y}px)`;
        }
      });

      panel.addEventListener("pointerleave", () => {
        const veil = panel.querySelector(".home-panel__veil");
        if (veil) veil.style.transform = "";
      });
    });
  }

  const urgentList = document.getElementById("home-urgent-list");
  const todoList = document.getElementById("home-todo-list");
  const urgentEmpty = document.getElementById("home-urgent-empty");
  const todoEmpty = document.getElementById("home-todo-empty");
  const homeCategoryList = document.getElementById("home-work-categories");
  let homeEditingId = null;

  const syncHomeCategoryList = () => {
    if (!homeCategoryList) return;
    const seen = new Set();
    const names = [];
    [...(loadCategoryOrder() || []), ...loadItems().map((item) => item.category)].forEach(
      (name) => {
        const label = String(name || "").trim();
        const key = normalize(label);
        if (!key || seen.has(key)) return;
        seen.add(key);
        names.push(label);
      }
    );
    homeCategoryList.replaceChildren(
      ...names.map((name) => {
        const option = document.createElement("option");
        option.value = name;
        return option;
      })
    );
  };

  const renderHomeLists = () => {
    if (!urgentList || !todoList) return;
    syncHomeCategoryList();

    const renderHomeListItem = (item) => {
      const li = document.createElement("li");
      const editing = homeEditingId === item.id;
      li.className = `home-todo__item${item.done ? " is-done" : ""}${editing ? " is-editing" : ""}`;

      if (editing) {
        const editor = makeEditableRow(
          item,
          item.category,
          (values, id) => {
            if (!id) return;
            const itemsNow = loadItems();
            const index = itemsNow.findIndex((entry) => entry.id === id);
            if (index < 0) return;
            itemsNow[index] = { ...itemsNow[index], ...values };
            saveItems(itemsNow);
          },
          { showCategory: true }
        );
        editor.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            homeEditingId = null;
            renderHomeLists();
          }
        });
        li.append(editor);
        return li;
      }

      li.innerHTML = `
        <span class="work-check" aria-hidden="true"></span>
        <span class="home-todo__name">${escapeHtml(item.name)}</span>
        <span class="home-todo__cat">${escapeHtml(item.category)}</span>
      `;
      li.append(
        makeTaskActions(item, {
          onDone: () => {
            patchItem(item.id, { done: !item.done });
            renderHomeLists();
          },
          onRemove: () => {
            if (homeEditingId === item.id) homeEditingId = null;
            deleteItem(item.id);
            renderHomeLists();
          },
        })
      );
      li.addEventListener("click", (event) => {
        if (event.target.closest(".task-actions")) return;
        homeEditingId = item.id;
        renderHomeLists();
      });
      return li;
    };

    const items = sortTasks(loadItems());
    const urgentItems = items.filter((item) => item.urgency === "Urgent");
    const todoItems = items.filter(
      (item) => item.urgency === "Pending" || item.urgency === "Pipeline"
    );

    urgentList.replaceChildren(...urgentItems.map(renderHomeListItem));
    todoList.replaceChildren(...todoItems.map(renderHomeListItem));

    if (urgentEmpty) urgentEmpty.hidden = urgentItems.length > 0;
    if (todoEmpty) todoEmpty.hidden = todoItems.length > 0;
  };

  document.addEventListener("pointerdown", (event) => {
    if (!homeEditingId || !urgentList) return;
    if (event.target.closest(".home-todo__item")) return;
    if (event.target.closest(".date-calendar")) return;
    homeEditingId = null;
    renderHomeLists();
  });

  renderHomeLists();
  subscribeDesk(() => {
    if (homeEditingId) return;
    renderHomeLists();
  });
  enableScrollHints(document.querySelector(".home-todo"));
  startDeskSync();

  /* ——— Work page ——— */

  const DEFAULT_CATEGORIES = [
    "Amity",
    "Conflictorium",
    "Scholarly Publication",
    "ST Films",
    "Our World",
    "Fonder Village",
    "Vaufe Bag",
    "Style Me App",
    "Rajan’s Reading and Writing",
  ];
  const grid = document.getElementById("work-grid");
  const workDialog = document.getElementById("work-dialog");
  const form = document.getElementById("work-form");
  const plusButton = document.querySelector("[data-open-work-form]");
  const categoryDialog = document.getElementById("category-dialog");
  const categoryTitle = document.getElementById("category-dialog-title");
  const categoryWorks = document.getElementById("category-works");
  const categoryNameDialog = document.getElementById("category-name-dialog");
  const categoryNameForm = document.getElementById("category-name-form");
  const categoryDatalist = document.getElementById("work-categories");

  if (!grid || !workDialog || !form || !plusButton) return;

  let activeCategory = "";

  const getAllCategories = () => {
    const savedOrder = loadCategoryOrder();
    const legacyCustom = loadCustomCategories();
    const seed = savedOrder?.length
      ? savedOrder
      : [...DEFAULT_CATEGORIES, ...legacyCustom];

    const seen = new Set();
    const ordered = [];
    seed.forEach((name) => {
      const key = normalize(name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      ordered.push(String(name).trim());
    });

    if (!savedOrder?.length) {
      DEFAULT_CATEGORIES.forEach((name) => {
        const key = normalize(name);
        if (seen.has(key)) return;
        seen.add(key);
        ordered.push(name);
      });
    }

    return ordered;
  };

  const syncCategoryDatalist = () => {
    if (!categoryDatalist) return;
    categoryDatalist.replaceChildren(
      ...getAllCategories().map((name) => {
        const option = document.createElement("option");
        option.value = name;
        return option;
      })
    );
  };

  const persistOrderFromGrid = () => {
    const order = [...grid.querySelectorAll(".work-tile[data-category]")].map(
      (tile) => tile.dataset.category
    );
    saveCategoryOrder(order);
  };

  const renameCategory = (oldName, newName) => {
    const next = String(newName || "").trim();
    if (!next) {
      renderCategoryGrid();
      return;
    }
    if (normalize(next) === normalize(oldName)) {
      renderCategoryGrid();
      return;
    }

    const categories = getAllCategories();
    const duplicate = categories.some(
      (category) =>
        normalize(category) === normalize(next) &&
        normalize(category) !== normalize(oldName)
    );
    if (duplicate) {
      renderCategoryGrid();
      return;
    }

    saveCategoryOrder(
      categories.map((category) =>
        normalize(category) === normalize(oldName) ? next : category
      )
    );

    saveItems(
      loadItems().map((item) =>
        normalize(item.category) === normalize(oldName)
          ? { ...item, category: next }
          : item
      )
    );

    if (normalize(activeCategory) === normalize(oldName)) {
      activeCategory = next;
    }

    renderCategoryGrid();
  };

  const beginCategoryTitleEdit = (tile, currentName) => {
    tile.draggable = false;
    tile.dataset.editing = "1";
    tile.classList.add("is-editing");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "work-tile__edit";
    input.value = currentName;
    input.setAttribute("aria-label", "Edit category name");
    tile.replaceChildren(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (shouldSave) => {
      if (finished) return;
      finished = true;
      if (shouldSave) renameCategory(currentName, input.value);
      else renderCategoryGrid();
    };

    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  };

  const findCategoryTile = (name) =>
    [...grid.querySelectorAll(".work-tile[data-category]")].find(
      (node) => node.dataset.category === name
    );

  const enableCategoryDrag = (tile) => {
    tile.draggable = true;

    tile.addEventListener("dragstart", (event) => {
      tile.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", tile.dataset.category || "");
      grid.dataset.dragging = tile.dataset.category || "";
      grid.dataset.didReorder = "0";
    });

    tile.addEventListener("dragend", () => {
      tile.classList.remove("is-dragging");
      grid.querySelectorAll(".work-tile--drag-over").forEach((node) => {
        node.classList.remove("work-tile--drag-over");
      });
      if (grid.dataset.didReorder === "1") {
        tile.dataset.suppressClick = "1";
        persistOrderFromGrid();
      }
      delete grid.dataset.dragging;
      delete grid.dataset.didReorder;
    });

    tile.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const draggingName = grid.dataset.dragging;
      if (!draggingName || draggingName === tile.dataset.category) return;
      tile.classList.add("work-tile--drag-over");
    });

    tile.addEventListener("dragleave", () => {
      tile.classList.remove("work-tile--drag-over");
    });

    tile.addEventListener("drop", (event) => {
      event.preventDefault();
      tile.classList.remove("work-tile--drag-over");
      const draggingTile = findCategoryTile(grid.dataset.dragging);
      if (!draggingTile || draggingTile === tile) return;

      const tiles = [...grid.querySelectorAll(".work-tile[data-category]")];
      const fromIndex = tiles.indexOf(draggingTile);
      const toIndex = tiles.indexOf(tile);
      if (fromIndex < 0 || toIndex < 0) return;

      if (fromIndex < toIndex) tile.after(draggingTile);
      else tile.before(draggingTile);

      grid.dataset.didReorder = "1";
    });
  };

  const renderCategoryGrid = () => {
    const categories = getAllCategories();
    const tiles = categories.map((name, index) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "work-tile";
      tile.dataset.category = name;
      tile.style.setProperty("--i", String(index));
      tile.innerHTML = `<h3>${escapeHtml(name)}</h3>`;
      enableCategoryDrag(tile);

      let clickTimer = null;
      tile.addEventListener("click", () => {
        if (tile.dataset.editing === "1") return;
        if (tile.dataset.suppressClick === "1") {
          delete tile.dataset.suppressClick;
          return;
        }
        clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => openCategory(name), 250);
      });
      tile.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(clickTimer);
        beginCategoryTitleEdit(tile, name);
      });
      return tile;
    });

    const emptyTile = document.createElement("button");
    emptyTile.type = "button";
    emptyTile.className = "work-tile work-tile--empty";
    emptyTile.style.setProperty("--i", String(categories.length));
    emptyTile.setAttribute("aria-label", "Add new category");
    emptyTile.innerHTML = `<h3 class="work-tile__hint">Add new work</h3>`;
    emptyTile.addEventListener("dragover", (event) => {
      event.preventDefault();
      const draggingTile = findCategoryTile(grid.dataset.dragging);
      if (!draggingTile) return;
      emptyTile.before(draggingTile);
      grid.dataset.didReorder = "1";
    });
    emptyTile.addEventListener("drop", (event) => {
      event.preventDefault();
      grid.dataset.didReorder = "1";
    });
    emptyTile.addEventListener("click", () => {
      categoryNameForm?.reset();
      openDialog(categoryNameDialog);
      const field = categoryNameForm?.elements.namedItem("categoryName");
      if (field && "focus" in field) field.focus();
    });

    grid.replaceChildren(...tiles, emptyTile);
    syncCategoryDatalist();
  };

  const openForm = (presetCategory = "") => {
    form.reset();
    syncCategoryDatalist();
    if (presetCategory) {
      const categoryField = form.elements.namedItem("category");
      if (categoryField) categoryField.value = presetCategory;
    }
    const dueField = form.querySelector('[name="due"]');
    if (dueField) {
      setDateControlValue(dueField, todayISO());
      bindDateInput(dueField, { preferToday: true });
    }
    openDialog(workDialog);
    const nameField = form.elements.namedItem("name");
    if (nameField && "focus" in nameField) nameField.focus();
  };

  const closeForm = () => {
    closeDialog(workDialog);
    form.reset();
  };

  const openCategory = (category) => {
    if (!categoryDialog || !categoryWorks || !categoryTitle) return;
    activeCategory = category;
    categoryTitle.textContent = category;
    renderCategoryWorks(category);
    openDialog(categoryDialog);
  };

  const renderCategoryWorks = (category, editingId = null, draftingNew = false) => {
    const items = sortTasks(
      loadItems().filter((item) => normalize(item.category) === normalize(category))
    );

    const handleRowChange = (values, id) => {
      const itemsNow = loadItems();

      if (id) {
        const index = itemsNow.findIndex((entry) => entry.id === id);
        if (index < 0) return;
        itemsNow[index] = { ...itemsNow[index], ...values };
        saveItems(itemsNow);
        renderCategoryWorks(category);
        return;
      }

      if (!values.name) return;
      itemsNow.push({
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        done: false,
        ...values,
      });
      saveItems(itemsNow);
      renderCategoryWorks(category);
    };

    const rows = items.map((item) => {
      if (editingId && item.id === editingId) {
        return makeEditableRow(item, category, handleRowChange);
      }

      const row = makeReadRow(item, {
        onOpen: () => renderCategoryWorks(category, item.id, false),
        onChanged: () => renderCategoryWorks(category, editingId, draftingNew),
      });
      return row;
    });

    if (draftingNew) {
      rows.push(makeEditableRow(null, category, handleRowChange));
    } else {
      rows.push(
        makeAddPlaceholder(() => {
          renderCategoryWorks(category, null, true);
        })
      );
    }

    categoryWorks.replaceChildren(...rows);
    enableScrollHints(categoryWorks);
  };

  plusButton.addEventListener("click", () => openForm());
  form.querySelector("[data-close-work-form]")?.addEventListener("click", closeForm);
  workDialog.addEventListener("click", (event) => {
    if (event.target === workDialog) closeForm();
  });

  categoryDialog
    ?.querySelector("[data-close-category]")
    ?.addEventListener("click", () => closeDialog(categoryDialog));
  categoryDialog?.addEventListener("click", (event) => {
    if (event.target === categoryDialog) closeDialog(categoryDialog);
  });

  categoryNameForm
    ?.querySelector("[data-close-category-name]")
    ?.addEventListener("click", () => {
      closeDialog(categoryNameDialog);
      categoryNameForm.reset();
    });
  categoryNameDialog?.addEventListener("click", (event) => {
    if (event.target === categoryNameDialog) {
      closeDialog(categoryNameDialog);
      categoryNameForm?.reset();
    }
  });

  categoryNameForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(categoryNameForm);
    const name = String(data.get("categoryName") || "").trim();
    if (!name) return;

    const existing = getAllCategories();
    if (existing.some((category) => normalize(category) === normalize(name))) {
      closeDialog(categoryNameDialog);
      categoryNameForm.reset();
      openCategory(existing.find((category) => normalize(category) === normalize(name)));
      return;
    }

    saveCategoryOrder([...existing, name]);
    closeDialog(categoryNameDialog);
    categoryNameForm.reset();
    renderCategoryGrid();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const category = String(data.get("category") || "").trim();
    const items = loadItems();
    items.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      name: String(data.get("name") || "").trim(),
      category,
      urgency: String(data.get("urgency") || "Pending"),
      due: getDateControlValue(form.querySelector('[name="due"]')),
      remark: String(data.get("remark") || "").trim(),
      done: false,
    });
    saveItems(items);

    if (category && !getAllCategories().some((name) => normalize(name) === normalize(category))) {
      saveCategoryOrder([...getAllCategories(), category]);
      renderCategoryGrid();
    }

    closeForm();
  });

  renderCategoryGrid();
  subscribeDesk(() => {
    renderCategoryGrid();
    if (activeCategory) renderCategoryWorks(activeCategory);
  });
  pullDesk();
})();
